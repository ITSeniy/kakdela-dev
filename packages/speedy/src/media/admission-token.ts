import { createHmac } from 'node:crypto'

import { jwtVerify, SignJWT } from 'jose'
import { z } from 'zod'

import { env } from '../env.js'
import type { VoiceTokenIssueArgs } from './types.js'

const ISSUER = 'kakdela-livekit-admission'
const AUDIENCE = 'kakdela-livekit-gateway'
const ticketKey = createHmac('sha256', env.LIVEKIT_API_SECRET)
  .update('kakdela/livekit-admission/v1')
  .digest()
const sfuKey = new TextEncoder().encode(env.LIVEKIT_API_SECRET)
const ClaimSchema = z.object({
  sub: z.string().min(1).max(256),
  name: z.string().max(256).optional(),
  video: z.object({
    roomJoin: z.literal(true),
    room: z.string(),
    canPublish: z.boolean().optional(),
    canSubscribe: z.boolean().optional(),
    canPublishData: z.boolean().optional(),
    canPublishSources: z
      .array(z.enum(['camera', 'microphone', 'screen_share', 'screen_share_audio']))
      .optional(),
  }),
})
const RoomSchema = z
  .string()
  .regex(/^(voice|dm)-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i)

export interface Admission {
  identity: string
  userId: string
  channelId: string
  room: string
  kind: 'voice' | 'dm'
  name: string
  canPublish: boolean
  canSubscribe: boolean
  canPublishData: boolean
  canPublishSources: string[]
}

function parseClaims(payload: unknown): Admission {
  const claims = ClaimSchema.parse(payload)
  // PostgreSQL UUID equality ignores case; SFU room/identity equality does not.
  const room = RoomSchema.parse(claims.video.room).toLowerCase()
  const rawUserId = z.string().uuid().parse(claims.sub.split(':')[0])
  const userId = rawUserId.toLowerCase()
  return {
    identity: userId + claims.sub.slice(rawUserId.length),
    userId,
    room,
    channelId: room.slice(room.indexOf('-') + 1),
    kind: room.startsWith('voice-') ? 'voice' : 'dm',
    name: claims.name ?? '',
    canPublish: claims.video.canPublish !== false,
    canSubscribe: claims.video.canSubscribe !== false,
    canPublishData: claims.video.canPublishData !== false,
    canPublishSources: claims.video.canPublishSources ?? [],
  }
}

/** Public tickets have a domain-separated key, never accepted by the SFU itself. */
export async function issueAdmissionTicket(
  args: VoiceTokenIssueArgs,
  ttlSeconds = 60,
): Promise<string> {
  const room = args.room ?? `voice-${args.channelId}`
  return signAdmission(
    {
      identity: args.deviceId ? `${args.userId}:${args.deviceId}` : args.userId,
      userId: args.userId,
      channelId: args.channelId,
      room,
      kind: room.startsWith('voice-') ? 'voice' : 'dm',
      name: args.displayName,
      canPublish: args.canPublish ?? true,
      canSubscribe: args.canSubscribe ?? true,
      canPublishData: args.canPublishData ?? true,
      canPublishSources: [],
    },
    ttlSeconds,
  )
}

export async function signAdmission(admission: Admission, ttlSeconds: number): Promise<string> {
  return new SignJWT({
    name: admission.name,
    metadata: JSON.stringify({ userId: admission.userId }),
    video: {
      roomJoin: true,
      room: admission.room,
      canPublish: admission.canPublish,
      canSubscribe: admission.canSubscribe,
      canPublishData: admission.canPublishData,
      ...(admission.canPublishSources.length
        ? { canPublishSources: admission.canPublishSources }
        : {}),
    },
  })
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setSubject(admission.identity)
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setIssuedAt()
    .setExpirationTime(Math.floor(Date.now() / 1000) + ttlSeconds)
    .sign(ticketKey)
}

export async function verifySfuToken(token: string): Promise<Admission> {
  // Small SFU/worker clock skew is tolerated; every admission still requires current DB access.
  const { payload } = await jwtVerify(token, sfuKey, {
    algorithms: ['HS256'],
    issuer: env.LIVEKIT_API_KEY,
    requiredClaims: ['exp', 'sub'],
    clockTolerance: 30,
  })
  return parseClaims(payload)
}

/** Legacy/refreshed LiveKit JWTs are only input to the gate, never forwarded upstream. */
export async function verifyAdmissionToken(token: string): Promise<Admission> {
  if (token.length > 16384) throw new Error('invalid admission token')
  try {
    const { payload } = await jwtVerify(token, ticketKey, {
      algorithms: ['HS256'],
      issuer: ISSUER,
      audience: AUDIENCE,
      requiredClaims: ['exp', 'sub'],
    })
    return parseClaims(payload)
  } catch {
    return verifySfuToken(token)
  }
}
