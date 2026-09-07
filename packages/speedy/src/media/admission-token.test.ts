import { randomUUID } from 'node:crypto'

import { jwtVerify, SignJWT } from 'jose'
import { describe, expect, it } from 'vitest'

import { env } from '../env.js'
import { createBootstrapToken } from './admission-sfu.js'
import { issueAdmissionTicket, verifyAdmissionToken, verifySfuToken } from './admission-token.js'

const userId = randomUUID(),
  channelId = randomUUID()
const args = { userId, channelId, displayName: 'Test', deviceId: 'Device-A' }
const sfuKey = new TextEncoder().encode(env.LIVEKIT_API_SECRET)
async function legacy(overrides: Record<string, unknown> = {}, algorithm = 'HS256') {
  return new SignJWT({
    sub: userId,
    iss: env.LIVEKIT_API_KEY,
    exp: Math.floor(Date.now() / 1000) + 600,
    video: { roomJoin: true, room: 'voice-' + channelId },
    ...overrides,
  })
    .setProtectedHeader({ alg: algorithm })
    .sign(sfuKey)
}

describe('gateway ticket trust boundary', () => {
  it('uses a separate issuer, audience and signing key from the SFU and app auth', async () => {
    const ticket = await issueAdmissionTicket(args)
    expect(await verifyAdmissionToken(ticket)).toMatchObject({
      userId,
      channelId,
      identity: userId + ':Device-A',
      canPublish: true,
    })
    await expect(verifySfuToken(ticket)).rejects.toThrow()
    await expect(
      jwtVerify(ticket, new TextEncoder().encode(env.JWT_ACCESS_SECRET)),
    ).rejects.toThrow()
  })
  it('canonicalizes UUID case without changing the device suffix', async () => {
    const ticket = await issueAdmissionTicket({
      ...args,
      userId: userId.toUpperCase(),
      channelId: channelId.toUpperCase(),
    })
    expect(await verifyAdmissionToken(ticket)).toMatchObject({
      userId,
      channelId,
      room: 'voice-' + channelId,
      identity: userId + ':Device-A',
    })
  })
  it('creates a restricted upstream bootstrap token with no usable media grants', async () => {
    const a = await verifyAdmissionToken(await issueAdmissionTicket(args))
    expect(await verifySfuToken(await createBootstrapToken(a))).toMatchObject({
      canPublish: false,
      canSubscribe: false,
      canPublishData: false,
    })
  })
  it('preserves explicit denied permissions', async () => {
    expect(
      await verifyAdmissionToken(
        await issueAdmissionTicket({ ...args, canPublish: false, canPublishData: false }),
      ),
    ).toMatchObject({ canPublish: false, canPublishData: false, canSubscribe: true })
  })
  it('accepts legacy input only after signature and room/user validation', async () => {
    expect(await verifyAdmissionToken(await legacy())).toMatchObject({ userId, channelId })
  })
  it.each([
    { iss: 'foreign-issuer' },
    { sub: 'not-a-uuid' },
    { exp: undefined },
    { exp: Math.floor(Date.now() / 1000) - 120 },
    { nbf: Math.floor(Date.now() / 1000) + 120 },
    { video: { roomJoin: false, room: 'voice-' + channelId } },
    { video: { roomJoin: true, room: 'unrelated-room' } },
    { video: { roomJoin: true, room: 'voice-' + channelId, canPublishSources: ['unknown'] } },
  ])('rejects malformed or unauthorized legacy claims: %j', async (claims) => {
    await expect(verifyAdmissionToken(await legacy(claims))).rejects.toThrow()
  })
  it('rejects alternative algorithms, tampering and excessive size', async () => {
    await expect(verifyAdmissionToken(await legacy({}, 'HS384'))).rejects.toThrow()
    await expect(verifyAdmissionToken((await issueAdmissionTicket(args)) + 'x')).rejects.toThrow()
    await expect(verifyAdmissionToken('x'.repeat(16385))).rejects.toThrow()
  })
  it('does not tolerate expired gateway tickets', async () => {
    await expect(verifyAdmissionToken(await issueAdmissionTicket(args, -1))).rejects.toThrow()
  })
  it('permits bounded SFU clock skew, never unbounded future tokens', async () => {
    expect(
      await verifyAdmissionToken(await legacy({ nbf: Math.floor(Date.now() / 1000) + 20 })),
    ).toMatchObject({ userId })
  })
})
