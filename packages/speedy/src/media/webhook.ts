import { eq } from 'drizzle-orm'
import {
  TrackSource,
  type ParticipantInfo,
  type WebhookEvent,
} from 'livekit-server-sdk'

import type { Message, SystemEvent } from '@kakdela/ginzu/api-types'

import { channels, messages } from '../db/schema.js'
import { db } from '../lib/db.js'
import { redis } from '../lib/redis.js'
import { broadcastToChannel, broadcastToServer } from '../ws/broadcast.js'
import { listDmParticipants, listParticipants, userIdFromIdentity } from './guido.js'

// Имена комнат в guido — `voice-${channelId}`. Если webhook прилетел с
// другим префиксом — это либо чужая комната, либо мы что-то неправильно
// деплоим; в любом случае молча игнорируем (debug-уровень в логах).
const VOICE_ROOM_PREFIX = 'voice-'
// DM-звонки (T-087) живут в `dm-${channelId}`. Они НЕ серверные голос-каналы:
// presence-броадкаст не нужен, но на room_finished пишем call-log в чат.
const DM_ROOM_PREFIX = 'dm-'

const roomUsersKey = (channelId: string) => `voice:channel:${channelId}:users`
const participantsCacheKey = (channelId: string) =>
  `voice:channel:${channelId}:participants-cache`
const modStateKey = (channelId: string) => `voice:channel:${channelId}:mod`
const dedupKey = (eventId: string) => `livekit:webhook:seen:${eventId}`

// 1 час: LiveKit при ретраях обычно укладывается в минуты, час — с запасом.
const DEDUP_TTL_SEC = 60 * 60

export interface WebhookLogger {
  debug: (obj: object, msg?: string) => void
  warn: (obj: object, msg?: string) => void
}

const NOOP_LOG: WebhookLogger = {
  debug: () => {},
  warn: () => {},
}

/**
 * Атомарно регистрирует event.id как обработанный.
 * Возвращает true, если такой id уже встречался (дубликат), иначе false.
 * Пустой `eventId` (на случай старых версий LiveKit без поля) пропускаем
 * без дедупликации.
 */
export async function alreadyProcessed(eventId: string): Promise<boolean> {
  if (!eventId) return false
  const result = await redis.set(dedupKey(eventId), '1', 'EX', DEDUP_TTL_SEC, 'NX')
  return result === null
}

export function parseChannelIdFromRoom(roomName: string | undefined): string | null {
  if (!roomName || !roomName.startsWith(VOICE_ROOM_PREFIX)) return null
  const id = roomName.slice(VOICE_ROOM_PREFIX.length)
  return id.length > 0 ? id : null
}

export function parseDmChannelIdFromRoom(roomName: string | undefined): string | null {
  if (!roomName || !roomName.startsWith(DM_ROOM_PREFIX)) return null
  const id = roomName.slice(DM_ROOM_PREFIX.length)
  return id.length > 0 ? id : null
}

function computeMutedFromTracks(p: ParticipantInfo): boolean {
  // muted = у участника нет ни одной опубликованной микрофонной дорожки,
  // которая была бы не-замьючена. Track-mute toggles вебхуками не приходят,
  // но publish/unpublish — приходят, чего достаточно для индикатора в списке.
  const mics = p.tracks.filter((t) => t.source === TrackSource.MICROPHONE)
  if (mics.length === 0) return true
  return mics.every((t) => t.muted)
}

function computeScreenFromTracks(p: ParticipantInfo): boolean {
  return p.tracks.some(
    (t) =>
      t.source === TrackSource.SCREEN_SHARE ||
      t.source === TrackSource.SCREEN_SHARE_AUDIO,
  )
}

async function lookupServerIdForVoiceChannel(channelId: string): Promise<string | null> {
  const rows = await db
    .select({ serverId: channels.serverId, kind: channels.kind })
    .from(channels)
    .where(eq(channels.id, channelId))
    .limit(1)
  const row = rows[0]
  if (!row) return null
  if (row.kind !== 'voice') return null
  return row.serverId
}

async function invalidateParticipantsCache(channelId: string): Promise<void> {
  await redis.del(participantsCacheKey(channelId))
}

// ───── DM-звонки: call-log в чат на room_finished (T-087) ─────
//
// Состав 1:1-комнаты для самого звонка ведёт LiveKit на клиентах; здесь нам
// нужен лишь итог: кто инициировал, состоялся ли (зашёл второй) и сколько
// длился. Держим это в одном Redis-ключе на канал, на room_finished пишем
// системное сообщение в DM. Неотвеченный звонок не логируем.
const dmCallLogKey = (channelId: string) => `dm:call:${channelId}:log`
const DM_CALL_LOG_TTL_SEC = 60 * 60 * 24

interface DmCallLogMeta {
  initiator: string
  startedAt: number
  answered: boolean
}

async function handleDmRoomEvent(
  event: WebhookEvent,
  channelId: string,
  log: WebhookLogger,
): Promise<void> {
  const key = dmCallLogKey(channelId)
  switch (event.event) {
    case 'participant_joined': {
      const identity = event.participant?.identity
      if (!identity) return
      // identity может быть `userId:deviceId` — мета и сравнения живут
      // в координатах пользователей (authorId в call-log — FK на users).
      const userId = userIdFromIdentity(identity)
      const raw = await redis.get(key)
      if (!raw) {
        const meta: DmCallLogMeta = { initiator: userId, startedAt: Date.now(), answered: false }
        await redis.set(key, JSON.stringify(meta), 'EX', DM_CALL_LOG_TTL_SEC)
        return
      }
      const meta = parseDmCallLog(raw)
      if (meta && !meta.answered && userId !== meta.initiator) {
        meta.answered = true
        await redis.set(key, JSON.stringify(meta), 'EX', DM_CALL_LOG_TTL_SEC)
      }
      return
    }
    case 'participant_left':
    case 'participant_connection_aborted': {
      // `room_finished` LiveKit шлёт только спустя empty_timeout (минуты) —
      // из-за этого call-log появлялся в чате с большой задержкой. Фиксируем
      // звонок сразу, как только комната опустела. Источник истины — LiveKit
      // (numParticipants из вебхука по версиям трактуется по-разному), как и
      // в остальной логике DM-звонков.
      const remaining = await listDmParticipants(channelId)
      if (remaining.length > 0) return
      await finalizeDmCall(channelId, log)
      return
    }
    case 'room_finished': {
      // Подстраховка на случай, если empty-детект по participant_left не
      // сработал (например, аборт без события). Ключ уже мог быть удалён —
      // finalizeDmCall тогда просто no-op.
      await finalizeDmCall(channelId, log)
      return
    }
    default:
      return
  }
}

// Завершает DM-звонок: атомарно забирает meta (del — это же и дедуп против
// двойного лога от participant_left + room_finished) и, если звонок
// состоялся, пишет call-log в чат.
async function finalizeDmCall(channelId: string, log: WebhookLogger): Promise<void> {
  const key = dmCallLogKey(channelId)
  const raw = await redis.get(key)
  await redis.del(key)
  const meta = parseDmCallLog(raw)
  // Логируем только состоявшийся звонок (зашёл второй участник).
  if (!meta || !meta.answered) return
  const durationSec = Math.max(1, Math.round((Date.now() - meta.startedAt) / 1000))
  await postDmCallLog(channelId, meta.initiator, durationSec, log)
}

function parseDmCallLog(raw: string | null | undefined): DmCallLogMeta | null {
  if (!raw) return null
  try {
    const p = JSON.parse(raw) as Partial<DmCallLogMeta>
    if (typeof p.initiator !== 'string' || typeof p.startedAt !== 'number') return null
    return { initiator: p.initiator, startedAt: p.startedAt, answered: p.answered === true }
  } catch {
    return null
  }
}

async function postDmCallLog(
  channelId: string,
  initiator: string,
  durationSec: number,
  log: WebhookLogger,
): Promise<void> {
  // Канал должен быть живым DM (FK + проверка типа).
  const rows = await db
    .select({ kind: channels.kind })
    .from(channels)
    .where(eq(channels.id, channelId))
    .limit(1)
  const ch = rows[0]
  if (!ch || ch.kind !== 'dm') return

  const system: SystemEvent = { kind: 'call', durationSec }
  const inserted = await db
    .insert(messages)
    .values({ channelId, authorId: initiator, content: 'Звонок', system })
    .returning({ id: messages.id, createdAt: messages.createdAt })
  const row = inserted[0]
  if (!row) {
    log.warn({ channelId }, 'dm call-log insert returned no rows')
    return
  }

  const message: Message = {
    id: row.id,
    channelId,
    authorId: initiator,
    content: 'Звонок',
    replyToId: null,
    replyTo: null,
    createdAt: row.createdAt.toISOString(),
    editedAt: null,
    reactions: [],
    attachments: [],
    thread: null,
    pinned: false,
    pinnedAt: null,
    forwarded: null,
    linkPreviews: [],
    system,
  }
  await broadcastToChannel(channelId, { t: 'msg.new', channelId, message })
}

export async function handleWebhookEvent(
  event: WebhookEvent,
  log: WebhookLogger = NOOP_LOG,
): Promise<void> {
  // DM-звонок (`dm-`): отдельная ветка — call-log, без серверного presence.
  const dmChannelId = parseDmChannelIdFromRoom(event.room?.name)
  if (dmChannelId) {
    await handleDmRoomEvent(event, dmChannelId, log)
    return
  }

  const channelId = parseChannelIdFromRoom(event.room?.name)

  switch (event.event) {
    case 'participant_joined': {
      if (!channelId || !event.participant) {
        log.debug({ event: event.event, id: event.id }, 'webhook: missing room or participant')
        return
      }
      const serverId = await lookupServerIdForVoiceChannel(channelId)
      if (!serverId) return
      const userId = userIdFromIdentity(event.participant.identity)
      await redis.sadd(roomUsersKey(channelId), userId)
      await invalidateParticipantsCache(channelId)
      await broadcastToServer(serverId, { t: 'voice.join', channelId, userId })
      // Снапшот участника внутри события устаревает к моменту обработки, а
      // вебхуки не упорядочены: track_published (мик появился) мог обогнать
      // joined — тогда state из снапшота навечно показывал бы «muted» тем,
      // кто вне канала. Читаем живое состояние LiveKit; снапшот — фолбэк.
      const live = (await listParticipants(channelId)).find((p) => p.userId === userId)
      await broadcastToServer(serverId, {
        t: 'voice.state',
        channelId,
        userId,
        muted: live?.isMuted ?? computeMutedFromTracks(event.participant),
        screen: live?.isScreenSharing ?? computeScreenFromTracks(event.participant),
      })
      return
    }

    case 'participant_left':
    case 'participant_connection_aborted': {
      if (!channelId || !event.participant) return
      const serverId = await lookupServerIdForVoiceChannel(channelId)
      if (!serverId) return
      const userId = userIdFromIdentity(event.participant.identity)
      // Вебхуки не упорядочены: при быстром реконнекте left старой сессии
      // может прийти ПОСЛЕ joined новой — слепой srem+voice.leave «выкинул»
      // бы из UI живого участника. Сверяемся с актуальным состоянием LiveKit
      // (тот же паттерн, что в handleDmRoomEvent).
      const current = await listParticipants(channelId)
      if (current.some((p) => p.userId === userId)) {
        await invalidateParticipantsCache(channelId)
        log.debug({ channelId, userId }, 'webhook: stale participant_left ignored (user re-joined)')
        return
      }
      await redis.srem(roomUsersKey(channelId), userId)
      // Серверный mute/deafen не должен пережить выход из канала.
      await redis.hdel(modStateKey(channelId), userId)
      await invalidateParticipantsCache(channelId)
      await broadcastToServer(serverId, { t: 'voice.leave', channelId, userId })
      return
    }

    case 'track_published':
    case 'track_unpublished': {
      if (!channelId || !event.participant) return
      const serverId = await lookupServerIdForVoiceChannel(channelId)
      if (!serverId) return
      const userId = userIdFromIdentity(event.participant.identity)
      await invalidateParticipantsCache(channelId)
      // Как и в participant_joined — не доверяем снапшоту из события,
      // берём живое состояние. Участника уже нет — state вещать не о ком,
      // voice.leave разберётся сам.
      const live = (await listParticipants(channelId)).find((p) => p.userId === userId)
      if (!live) return
      await broadcastToServer(serverId, {
        t: 'voice.state',
        channelId,
        userId,
        muted: live.isMuted,
        screen: live.isScreenSharing,
      })
      return
    }

    case 'room_started':
      // Каждый participant_joined пришлёт свой voice.join — здесь ничего.
      return

    case 'room_finished': {
      if (!channelId) return
      await Promise.all([
        redis.del(roomUsersKey(channelId)),
        redis.del(participantsCacheKey(channelId)),
        redis.del(modStateKey(channelId)),
      ])
      return
    }

    // Recording/streaming/ingress — вне MVP. Явно проигнорировано,
    // чтобы default-ветка ловила только действительно неизвестное.
    case 'egress_started':
    case 'egress_updated':
    case 'egress_ended':
    case 'ingress_started':
    case 'ingress_ended':
      return

    default:
      log.warn({ type: event.event, id: event.id }, 'webhook: unknown event type')
      return
  }
}
