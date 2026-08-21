import { AccessToken, RoomServiceClient, TrackSource } from 'livekit-server-sdk'

import { env } from '../env.js'
import type {
  VoiceParticipant,
  VoiceToken,
  VoiceTokenIssueArgs,
  VoiceTokenMetadata,
} from './types.js'

// 6 часов. Если человек висит в звонке дольше — клиент переподключится
// с новым токеном; нет смысла раздувать TTL.
const TOKEN_TTL_SECONDS = 60 * 60 * 6

/**
 * LiveKit identity участника: чистый `userId` или `userId:deviceId`, когда
 * клиент представился устройством (мульти-девайс, аудит 2026-08 C-2).
 */
export function livekitIdentity(userId: string, deviceId?: string): string {
  return deviceId ? `${userId}:${deviceId}` : userId
}

/** Обратное преобразование: чистый userId из любой identity. */
export function userIdFromIdentity(identity: string): string {
  const i = identity.indexOf(':')
  return i === -1 ? identity : identity.slice(0, i)
}

export function voiceRoomName(channelId: string): string {
  return `voice-${channelId}`
}

// Комната DM-звонка (T-087). Отдельный префикс от серверных голос-каналов:
// webhook игнорит `dm-` (см. media/webhook.ts), а состав 1:1-комнаты UI ведёт
// сам по событиям LiveKit, серверный presence-broadcast здесь не нужен.
export function dmRoomName(channelId: string): string {
  return `dm-${channelId}`
}

// RoomServiceClient работает по HTTP/HTTPS (twirp). В проде клиенты ходят
// через Caddy (wss://<домен>/livekit), а speedy — напрямую по docker-сети:
// LIVEKIT_ADMIN_URL=http://livekit:7880. В dev переменная не нужна —
// конвертируем схему LIVEKIT_URL (ws://localhost:7880 → http://...).
function adminHost(): string {
  return env.LIVEKIT_ADMIN_URL ?? env.LIVEKIT_URL.replace(/^ws(s?):\/\//, 'http$1://')
}

let roomServiceSingleton: RoomServiceClient | null = null
function getRoomService(): RoomServiceClient {
  if (!roomServiceSingleton) {
    roomServiceSingleton = new RoomServiceClient(
      adminHost(),
      env.LIVEKIT_API_KEY,
      env.LIVEKIT_API_SECRET,
    )
  }
  return roomServiceSingleton
}

export async function issueToken(args: VoiceTokenIssueArgs): Promise<VoiceToken> {
  const {
    userId,
    channelId,
    displayName,
    deviceId,
    canPublish = true,
    canSubscribe = true,
    canPublishData = true,
  } = args

  const room = args.room ?? voiceRoomName(channelId)
  const metadata: VoiceTokenMetadata = { userId }

  const at = new AccessToken(env.LIVEKIT_API_KEY, env.LIVEKIT_API_SECRET, {
    identity: livekitIdentity(userId, deviceId),
    name: displayName,
    metadata: JSON.stringify(metadata),
    ttl: TOKEN_TTL_SECONDS,
  })
  at.addGrant({
    roomJoin: true,
    room,
    canPublish,
    canSubscribe,
    canPublishData,
  })

  const token = await at.toJwt()
  return { token, url: env.LIVEKIT_URL, room }
}

export async function revokeUser(args: { userId: string; channelId: string }): Promise<void> {
  const room = voiceRoomName(args.channelId)
  // Identity может быть `userId:deviceId` — кикаем ВСЕ устройства юзера.
  const infos = await listRoomInfos(room)
  for (const p of infos) {
    if (userIdFromIdentity(p.identity) !== args.userId) continue
    try {
      await getRoomService().removeParticipant(room, p.identity)
    } catch { /* уже вышел */ }
  }
}

export async function listParticipants(channelId: string): Promise<VoiceParticipant[]> {
  return listParticipantsForRoom(voiceRoomName(channelId))
}

/** Участники DM-звонка — источник истины для логики «кто инициатор» (T-087). */
export async function listDmParticipants(channelId: string): Promise<VoiceParticipant[]> {
  return listParticipantsForRoom(dmRoomName(channelId))
}

async function listRoomInfos(room: string) {
  try {
    return await getRoomService().listParticipants(room)
  } catch (err) {
    // Пустая/несуществующая комната — это нормальное состояние,
    // не ошибка вызова. LiveKit отдаёт twirp not_found.
    if (isRoomNotFound(err)) return []
    throw err
  }
}

async function listParticipantsForRoom(room: string): Promise<VoiceParticipant[]> {
  const infos = await listRoomInfos(room)

  return infos.map((p) => {
    const isScreenSharing = p.tracks.some(
      (t) =>
        t.source === TrackSource.SCREEN_SHARE ||
        t.source === TrackSource.SCREEN_SHARE_AUDIO,
    )
    const mics = p.tracks.filter((t) => t.source === TrackSource.MICROPHONE)
    const isMuted = mics.length === 0 || mics.every((t) => t.muted)
    const joinedMs =
      p.joinedAtMs > 0n ? Number(p.joinedAtMs) : Number(p.joinedAt) * 1000
    return {
      // identity может быть `userId:deviceId` — наружу отдаём чистый userId
      // (клиентский стор и WS-события живут в координатах пользователей).
      userId: userIdFromIdentity(p.identity),
      displayName: p.name,
      joinedAt: new Date(joinedMs).toISOString(),
      isPublishing: p.isPublisher,
      isScreenSharing,
      isMuted,
    }
  })
}

/**
 * Серверный mute/unmute микрофонных дорожек участника. Не-страшно, если
 * дорожек нет (человек ещё не публиковал мик) — состояние всё равно живёт
 * в Redis, а клиент цели сам не даст включить мик, пока заглушен.
 */
export async function muteParticipantMic(args: {
  channelId: string
  userId: string
  muted: boolean
}): Promise<void> {
  const room = voiceRoomName(args.channelId)
  const svc = getRoomService()
  // Identity может быть `userId:deviceId` — глушим все устройства юзера.
  const infos = await listRoomInfos(room)
  const targets = infos.filter((p) => userIdFromIdentity(p.identity) === args.userId)
  for (const info of targets) {
    for (const t of info.tracks) {
      if (t.source !== TrackSource.MICROPHONE) continue
      try {
        await svc.mutePublishedTrack(room, info.identity, t.sid, args.muted)
      } catch (err) {
        // unmute серверной стороной LiveKit может запрещать — это ок,
        // клиент цели включит мик сам по voice.mod.
        if (args.muted) throw err
      }
    }
  }
}

function isRoomNotFound(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false
  const e = err as { code?: string | number; message?: string; status?: number }
  if (e.code === 'not_found' || e.code === 404 || e.status === 404) return true
  if (typeof e.message === 'string' && /not.?found|no.*room|requested room/i.test(e.message)) {
    return true
  }
  return false
}
