import { RoomServiceClient, TrackSource } from 'livekit-server-sdk'

import { env } from '../env.js'
import { issueAdmissionTicket } from './admission-token.js'
import type {
  VoiceParticipant,
  VoiceToken,
  VoiceTokenIssueArgs,
} from './types.js'

// Short admission TTL reduces exposure of unused tokens. This is NOT revocation:
// self-hosted LiveKit refreshes tokens and does not invalidate them on removal.
const TOKEN_TTL_SECONDS = 60

/**
 * LiveKit identity участника: чистый `userId` или `userId:deviceId`, когда
 * клиент представился устройством (мульти-девайс, аудит 2026-08 C-2).
 */
export function livekitIdentity(userId: string, deviceId?: string): string {
  return deviceId ? `${userId.toLowerCase()}:${deviceId}` : userId.toLowerCase()
}

/** Обратное преобразование: чистый userId из любой identity. */
export function userIdFromIdentity(identity: string): string {
  const i = identity.indexOf(':')
  return (i === -1 ? identity : identity.slice(0, i)).toLowerCase()
}

export function voiceRoomName(channelId: string): string {
  return `voice-${channelId.toLowerCase()}`
}

// Комната DM-звонка (T-087). Отдельный префикс от серверных голос-каналов:
// webhook игнорит `dm-` (см. media/webhook.ts), а состав 1:1-комнаты UI ведёт
// сам по событиям LiveKit, серверный presence-broadcast здесь не нужен.
export function dmRoomName(channelId: string): string {
  return `dm-${channelId.toLowerCase()}`
}

// RoomServiceClient работает по HTTP/HTTPS (twirp). В проде клиенты ходят
// через Caddy (wss://<домен>/livekit), а speedy — напрямую по docker-сети:
// LIVEKIT_ADMIN_URL=http://livekit:7880. В dev fallback — локальный SFU,
// никогда не публичный LIVEKIT_URL: он теперь указывает на admission gateway.
function adminHost(): string {
  return env.LIVEKIT_ADMIN_URL ?? 'http://127.0.0.1:7880'
}

let roomServiceSingleton: RoomServiceClient | null = null
export function getRoomService(): RoomServiceClient {
  if (!roomServiceSingleton) {
    roomServiceSingleton = new RoomServiceClient(
      adminHost(),
      env.LIVEKIT_API_KEY,
      env.LIVEKIT_API_SECRET,
      { requestTimeout: 3 },
    )
  }
  return roomServiceSingleton
}

export async function issueToken(args: VoiceTokenIssueArgs): Promise<VoiceToken> {
  const room = args.room?.toLowerCase() ?? voiceRoomName(args.channelId)
  const token = await issueAdmissionTicket(args, TOKEN_TTL_SECONDS)
  return { token, url: env.LIVEKIT_URL, room }
}

export async function revokeUser(args: { userId: string; channelId: string }): Promise<void> {
  const room = voiceRoomName(args.channelId)
  // Identity может быть `userId:deviceId` — кикаем ВСЕ устройства юзера.
  const infos = await listRoomInfos(room)
  const failures: unknown[] = []
  for (const p of infos) {
    if (userIdFromIdentity(p.identity) !== args.userId.toLowerCase()) continue
    try {
      await getRoomService().removeParticipant(room, p.identity)
    } catch (err) {
      if (!isRoomNotFound(err)) failures.push(err)
    }
  }
  if (failures.length) throw new AggregateError(failures, 'could not revoke all voice devices')
}

/** Used by reconciliation, including rooms whose server/channel was deleted. */
export async function listActiveVoiceChannels(): Promise<string[]> {
  const rooms = await getRoomService().listRooms()
  return rooms.map((room) => /^voice-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i.exec(room.name)?.[1])
    .filter((id): id is string => id !== undefined)
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
  const targets = infos.filter((p) => userIdFromIdentity(p.identity) === args.userId.toLowerCase())
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
  const e = err as { code?: unknown }
  // Only the explicit Twirp error means absence. A proxy/route HTTP 404 could
  // mean a broken admin URL; reporting revocation success would be unsafe.
  return e.code === 'not_found'
}
