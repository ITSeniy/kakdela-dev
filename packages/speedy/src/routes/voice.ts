import { and, eq } from 'drizzle-orm'
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod'
import { z } from 'zod'

import {
  ErrorBodySchema,
  VoiceJoinRequestSchema,
  VoiceJoinResponseSchema,
  VoiceModerateRequestSchema,
  VoiceParticipantsResponseSchema,
  VoicePreviewResponseSchema,
  VoicePreviewUploadRequestSchema,
  VoiceSelfStateRequestSchema,
  type VoiceParticipantPublic,
} from '@kakdela/ginzu/api-types'

import { channels, dmChannels, serverMembers, users } from '../db/schema.js'
import { db } from '../lib/db.js'
import { assertMember, assertPermission, forbidden, notFound } from '../lib/permissions.js'
import { redis } from '../lib/redis.js'
import { dmRoomName, issueToken, listDmParticipants, listParticipants, muteParticipantMic, revokeUser } from '../media/guido.js'
import { broadcastToServer, broadcastToUser } from '../ws/broadcast.js'
import { withUserAccess } from '../ws/access.js'

// Резервный набор «кто сейчас в комнате» — основной источник истины это
// LiveKit (см. T-032 webhook), но мы пишем сюда на join/leave для подстраховки
// на случай, если webhook временно отвалится.
const roomUsersKey = (channelId: string) => `voice:channel:${channelId}:users`

// Кэш ответа GET /participants. Список текстовых каналов в UI рядом с voice
// показывает участников голоса; чтобы не дёргать LiveKit на каждое открытие
// меню — 5 секунд более чем достаточно.
const participantsCacheKey = (channelId: string) =>
  `voice:channel:${channelId}:participants-cache`
const PARTICIPANTS_CACHE_TTL_SEC = 5

// Hover-превью демки: периодический JPEG-кадр от стримера. TTL с запасом
// перекрывает интервал заливки (~15 сек) — стрим кончился → превью само
// исчезло, отдельной очистки не нужно.
const screenPreviewKey = (channelId: string, userId: string) =>
  `voice:channel:${channelId}:screen-preview:${userId}`
const SCREEN_PREVIEW_TTL_SEC = 45

// Серверная модерация (mute/deafen от админа): hash userId → JSON.
// mutedBefore — был ли mute ДО deafen, un-deafen возвращает как было
// (та же логика, что у локальных тумблеров клиента).
const modStateKey = (channelId: string) => `voice:channel:${channelId}:mod`

interface ModState {
  muted: boolean
  deafened: boolean
  mutedBefore: boolean
}

const EMPTY_MOD: ModState = { muted: false, deafened: false, mutedBefore: false }

function parseModState(raw: string | undefined | null): ModState {
  if (!raw) return EMPTY_MOD
  try {
    const parsed = JSON.parse(raw) as Partial<ModState>
    return {
      muted: parsed.muted === true,
      deafened: parsed.deafened === true,
      mutedBefore: parsed.mutedBefore === true,
    }
  } catch {
    return EMPTY_MOD
  }
}

async function getModState(channelId: string, userId: string): Promise<ModState> {
  return parseModState(await redis.hget(modStateKey(channelId), userId))
}

async function setModState(channelId: string, userId: string, state: ModState): Promise<void> {
  if (!state.muted && !state.deafened) {
    await redis.hdel(modStateKey(channelId), userId)
  } else {
    await redis.hset(modStateKey(channelId), userId, JSON.stringify(state))
  }
}

async function fetchAndCacheParticipants(channelId: string): Promise<VoiceParticipantPublic[]> {
  const [raw, modRaw] = await Promise.all([
    listParticipants(channelId),
    redis.hgetall(modStateKey(channelId)),
  ])
  const fresh = raw.map((p): VoiceParticipantPublic => {
    const mod = parseModState(modRaw[p.userId])
    return {
      userId: p.userId,
      displayName: p.displayName,
      isScreenSharing: p.isScreenSharing,
      isMuted: p.isMuted,
      serverMuted: mod.muted,
      serverDeafened: mod.deafened,
    }
  })
  await redis.set(
    participantsCacheKey(channelId),
    JSON.stringify(fresh),
    'EX',
    PARTICIPANTS_CACHE_TTL_SEC,
  )
  return fresh
}

async function getParticipantsCached(channelId: string): Promise<VoiceParticipantPublic[]> {
  const cached = await redis.get(participantsCacheKey(channelId))
  if (cached) {
    try {
      return JSON.parse(cached) as VoiceParticipantPublic[]
    } catch {
      // битый кэш — упадём в перезапрос
    }
  }
  return fetchAndCacheParticipants(channelId)
}

// ───── DM-звонки (T-087) ─────
//
// Личный 1:1 звонок поверх DM-канала: отдельная LiveKit-комната `dm-${id}`.
// Источник истины «кто в звонке» — сам LiveKit (listDmParticipants), а не
// Redis: так нет проблемы залипшего presence от упавшего клиента. Webhook
// `dm-` игнорит, состав в UI ведёт LiveKit на клиенте. Инвайт уходит
// targeted-событием второй стороне; pending-инвайты с таймаутом звонка живут
// в памяти процесса (self-host = один инстанс speedy).
const DM_RING_TIMEOUT_MS = 30_000

interface PendingDmInvite {
  from: string
  to: string
  timer: ReturnType<typeof setTimeout>
}
const dmInvites = new Map<string, PendingDmInvite>()

function clearDmInvite(channelId: string): void {
  const inv = dmInvites.get(channelId)
  if (inv) {
    clearTimeout(inv.timer)
    dmInvites.delete(channelId)
  }
}

/** Возвращает собеседника по DM-каналу, либо null если user не участник. */
async function dmPeerOf(channelId: string, userId: string): Promise<string | null> {
  const rows = await db
    .select({ userAId: dmChannels.userAId, userBId: dmChannels.userBId })
    .from(dmChannels)
    .where(eq(dmChannels.channelId, channelId))
    .limit(1)
  const dm = rows[0]
  if (!dm) return null
  if (dm.userAId === userId) return dm.userBId
  if (dm.userBId === userId) return dm.userAId
  return null
}

// «Позвать в войс»: кулдаун пары зовущий→зовомый, чтобы кнопку нельзя было
// зажать в спам. В памяти процесса (self-host = один инстанс speedy).
const RING_COOLDOWN_MS = 30_000
const lastRingAt = new Map<string, number>()

export const voiceRoutes: FastifyPluginAsyncZod = async (app) => {
  // ───── POST /api/voice/:channelId/ring/:userId ─────
  // Позвать участника сервера в голосовой канал: targeted WS-событие
  // voice.ring с именем/аватаром зовущего (эффективный серверный профиль).
  app.post(
    '/voice/:channelId/ring/:userId',
    {
      preHandler: app.authenticate,
      schema: {
        params: z.object({ channelId: z.string().uuid(), userId: z.string().uuid() }),
        response: {
          204: z.null(),
          400: ErrorBodySchema,
          401: ErrorBodySchema,
          403: ErrorBodySchema,
          404: ErrorBodySchema,
          429: ErrorBodySchema,
        },
      },
    },
    async (req, reply) => {
      const { channelId, userId: targetId } = req.params
      const fromId = req.authUser!.id
      if (targetId === fromId) {
        return reply.code(400).send({
          error: { code: 'self-ring', message: 'cannot ring yourself' },
        })
      }

      const channelRows = await db
        .select({ serverId: channels.serverId, kind: channels.kind, name: channels.name })
        .from(channels)
        .where(eq(channels.id, channelId))
        .limit(1)
      const channel = channelRows[0]
      if (!channel || !channel.serverId) throw notFound('channel-not-found', 'channel not found')
      if (channel.kind !== 'voice') {
        return reply.code(400).send({
          error: { code: 'not-a-voice-channel', message: 'channel is not a voice channel' },
        })
      }

      await assertMember(fromId, channel.serverId)

      const targetRows = await db
        .select({ userId: serverMembers.userId })
        .from(serverMembers)
        .where(and(
          eq(serverMembers.serverId, channel.serverId),
          eq(serverMembers.userId, targetId),
        ))
        .limit(1)
      if (!targetRows[0]) throw notFound('user-not-in-server', 'user is not a member of this server')

      const cdKey = `${fromId}:${targetId}`
      const last = lastRingAt.get(cdKey)
      if (last !== undefined && Date.now() - last < RING_COOLDOWN_MS) {
        return reply.code(429).send({
          error: { code: 'ring-cooldown', message: 'ring already sent, wait a bit' },
        })
      }
      lastRingAt.set(cdKey, Date.now())

      // Эффективный серверный профиль зовущего: ник/аватар сервера поверх глобальных.
      const fromRows = await db
        .select({
          displayName: users.displayName,
          avatarUrl:   users.avatarUrl,
          nickname:    serverMembers.nickname,
          serverAvatar: serverMembers.avatarUrl,
        })
        .from(users)
        .leftJoin(serverMembers, and(
          eq(serverMembers.userId, users.id),
          eq(serverMembers.serverId, channel.serverId),
        ))
        .where(eq(users.id, fromId))
        .limit(1)
      const from = fromRows[0]
      if (!from) throw notFound('user-not-found', 'user not found')

      void broadcastToUser(targetId, {
        t: 'voice.ring',
        channelId,
        channelName: channel.name,
        serverId: channel.serverId,
        fromUserId: fromId,
        fromName: from.nickname ?? from.displayName,
        fromAvatarUrl: from.serverAvatar ?? from.avatarUrl,
      })

      return reply.code(204).send(null)
    },
  )

  // ───── POST /api/voice/:channelId/join ─────
  app.post(
    '/voice/:channelId/join',
    {
      preHandler: app.authenticate,
      schema: {
        params: z.object({ channelId: z.string().uuid() }),
        body: VoiceJoinRequestSchema,
        response: {
          200: VoiceJoinResponseSchema,
          400: ErrorBodySchema,
          401: ErrorBodySchema,
          403: ErrorBodySchema,
          404: ErrorBodySchema,
        },
      },
    },
    async (req, reply) => {
      const { channelId } = req.params
      const userId = req.authUser!.id

      const channelRows = await db
        .select({ serverId: channels.serverId, kind: channels.kind })
        .from(channels)
        .where(eq(channels.id, channelId))
        .limit(1)
      const channel = channelRows[0]
      if (!channel || !channel.serverId) throw notFound('channel-not-found', 'channel not found')
      if (channel.kind !== 'voice') {
        return reply.code(400).send({
          error: { code: 'not-a-voice-channel', message: 'channel is not a voice channel' },
        })
      }

      await assertMember(userId, channel.serverId)

      // Серверный ник (если задан) поверх глобального имени — LiveKit-имя
      // участника должно совпадать с профилем на этом сервере.
      const userRows = await db
        .select({ displayName: users.displayName, nickname: serverMembers.nickname })
        .from(users)
        .leftJoin(serverMembers, and(
          eq(serverMembers.userId, users.id),
          eq(serverMembers.serverId, channel.serverId),
        ))
        .where(eq(users.id, userId))
        .limit(1)
      const user = userRows[0]
      if (!user) throw notFound('user-not-found', 'user not found')

      const token = await issueToken({
        userId,
        channelId,
        displayName: user.nickname ?? user.displayName,
        deviceId: req.body.deviceId,
      })

      await redis.sadd(roomUsersKey(channelId), userId)

      // Snapshot для UI — берём свежий, не из 5-сек кэша. Заодно обновляем
      // кэш, чтобы следующий GET /participants увидел тот же список.
      const participants = await fetchAndCacheParticipants(channelId)

      // Recheck after asynchronous token/cache work; hold membership locks
      // until the response is enqueued, just like WS delivery.
      await withUserAccess([userId], (snapshots) => {
        const access = snapshots.get(userId)
        if (!access?.exists || !access.channels.has(channelId)) throw forbidden()
        void reply.code(200).send({
          token: token.token,
          url: token.url,
          room: token.room,
          participants,
        })
      })
      return reply
    },
  )

  // ───── POST /api/voice/:channelId/leave ─────
  app.post(
    '/voice/:channelId/leave',
    {
      preHandler: app.authenticate,
      schema: {
        params: z.object({ channelId: z.string().uuid() }),
        response: {
          204: z.null(),
          401: ErrorBodySchema,
        },
      },
    },
    async (req, reply) => {
      const { channelId } = req.params
      const userId = req.authUser!.id
      // Реальное удаление из комнаты делает сам LiveKit при disconnect.
      // Этот эндпоинт оптимистично чистит резервный set; webhook T-032
      // приведёт всё к согласованному состоянию.
      await redis.srem(roomUsersKey(channelId), userId)
      return reply.code(204).send(null)
    },
  )

  // ───── GET /api/voice/:channelId/participants ─────
  app.get(
    '/voice/:channelId/participants',
    {
      preHandler: app.authenticate,
      schema: {
        params: z.object({ channelId: z.string().uuid() }),
        response: {
          200: VoiceParticipantsResponseSchema,
          401: ErrorBodySchema,
          403: ErrorBodySchema,
          404: ErrorBodySchema,
        },
      },
    },
    async (req, reply) => {
      const { channelId } = req.params
      const userId = req.authUser!.id

      const channelRows = await db
        .select({ serverId: channels.serverId })
        .from(channels)
        .where(eq(channels.id, channelId))
        .limit(1)
      const channel = channelRows[0]
      if (!channel || !channel.serverId) throw notFound('channel-not-found', 'channel not found')
      await assertMember(userId, channel.serverId)

      const participants = await getParticipantsCached(channelId)
      return reply.code(200).send({ participants })
    },
  )

  // ───── POST /api/voice/:channelId/screen-preview ─────
  //
  // Стример заливает кадр своей демки (hover-превью для тех, кто не в
  // комнате). Принимаем только от реального участника комнаты — иначе любой
  // member мог бы подсунуть «превью» чужому стриму.
  app.post(
    '/voice/:channelId/screen-preview',
    {
      preHandler: app.authenticate,
      schema: {
        params: z.object({ channelId: z.string().uuid() }),
        body: VoicePreviewUploadRequestSchema,
        response: {
          204: z.null(),
          401: ErrorBodySchema,
          403: ErrorBodySchema,
          404: ErrorBodySchema,
        },
      },
    },
    async (req, reply) => {
      const { channelId } = req.params
      const userId = req.authUser!.id

      const channelRows = await db
        .select({ serverId: channels.serverId, kind: channels.kind })
        .from(channels)
        .where(eq(channels.id, channelId))
        .limit(1)
      const channel = channelRows[0]
      if (!channel || !channel.serverId || channel.kind !== 'voice') {
        throw notFound('channel-not-found', 'voice channel not found')
      }
      await assertMember(userId, channel.serverId)

      const inRoom = await redis.sismember(roomUsersKey(channelId), userId)
      if (!inRoom) throw forbidden('not in this voice channel')

      await redis.set(
        screenPreviewKey(channelId, userId),
        req.body.dataBase64,
        'EX',
        SCREEN_PREVIEW_TTL_SEC,
      )
      return reply.code(204).send(null)
    },
  )

  // ───── GET /api/voice/:channelId/screen-preview/:userId ─────
  app.get(
    '/voice/:channelId/screen-preview/:userId',
    {
      preHandler: app.authenticate,
      schema: {
        params: z.object({ channelId: z.string().uuid(), userId: z.string().uuid() }),
        response: {
          200: VoicePreviewResponseSchema,
          401: ErrorBodySchema,
          403: ErrorBodySchema,
          404: ErrorBodySchema,
        },
      },
    },
    async (req, reply) => {
      const { channelId, userId: streamerId } = req.params
      const userId = req.authUser!.id

      const channelRows = await db
        .select({ serverId: channels.serverId })
        .from(channels)
        .where(eq(channels.id, channelId))
        .limit(1)
      const channel = channelRows[0]
      if (!channel || !channel.serverId) throw notFound('channel-not-found', 'channel not found')
      await assertMember(userId, channel.serverId)

      const raw = await redis.get(screenPreviewKey(channelId, streamerId))
      return reply.code(200).send({
        dataUrl: raw ? `data:image/jpeg;base64,${raw}` : null,
      })
    },
  )

  // ───── POST /api/voice/:channelId/state ─────
  //
  // Само-репорт mute-тумблера. LiveKit не присылает вебхуков на mute/unmute
  // уже опубликованного трека, поэтому без этого эндпоинта зрители ВНЕ
  // канала не видят переключение до рефетча. Screen-состояние берём из
  // живого LiveKit — событие voice.state несёт оба поля.
  app.post(
    '/voice/:channelId/state',
    {
      preHandler: app.authenticate,
      schema: {
        params: z.object({ channelId: z.string().uuid() }),
        body: VoiceSelfStateRequestSchema,
        response: {
          204: z.null(),
          401: ErrorBodySchema,
          403: ErrorBodySchema,
          404: ErrorBodySchema,
        },
      },
    },
    async (req, reply) => {
      const { channelId } = req.params
      const userId = req.authUser!.id

      const channelRows = await db
        .select({ serverId: channels.serverId, kind: channels.kind })
        .from(channels)
        .where(eq(channels.id, channelId))
        .limit(1)
      const channel = channelRows[0]
      if (!channel || !channel.serverId || channel.kind !== 'voice') {
        throw notFound('channel-not-found', 'voice channel not found')
      }
      await assertMember(userId, channel.serverId)

      const me = (await listParticipants(channelId)).find((p) => p.userId === userId)
      // Уже не в комнате (гонка с выходом) — молча принимаем, вещать не о ком.
      if (!me) return reply.code(204).send(null)

      await redis.del(participantsCacheKey(channelId))
      await broadcastToServer(channel.serverId, {
        t: 'voice.state',
        channelId,
        userId,
        muted: req.body.muted,
        screen: me.isScreenSharing,
      })
      return reply.code(204).send(null)
    },
  )

  // ───── POST /api/voice/:channelId/moderate ─────
  //
  // Админские действия над участником голосового канала: серверный
  // mute/deafen (deafen включает mute; un-deafen возвращает мик в состояние
  // до deafen), kick и перенос в другой голосовой канал. Слышимость и
  // повторное включение мика enforce'ит клиент цели по voice.mod —
  // для сервера друзей этого достаточно.
  app.post(
    '/voice/:channelId/moderate',
    {
      preHandler: app.authenticate,
      schema: {
        params: z.object({ channelId: z.string().uuid() }),
        body: VoiceModerateRequestSchema,
        response: {
          204: z.null(),
          400: ErrorBodySchema,
          401: ErrorBodySchema,
          403: ErrorBodySchema,
          404: ErrorBodySchema,
        },
      },
    },
    async (req, reply) => {
      const { channelId } = req.params
      const actorId = req.authUser!.id
      const { userId: targetId, action, toChannelId } = req.body

      const channelRows = await db
        .select({ serverId: channels.serverId, kind: channels.kind })
        .from(channels)
        .where(eq(channels.id, channelId))
        .limit(1)
      const channel = channelRows[0]
      if (!channel || !channel.serverId || channel.kind !== 'voice') {
        throw notFound('channel-not-found', 'voice channel not found')
      }
      const serverId = channel.serverId

      await assertPermission(actorId, serverId, 'MUTE_MEMBERS')

      const inRoom = await redis.sismember(roomUsersKey(channelId), targetId)
      if (!inRoom) {
        return reply.code(400).send({
          error: { code: 'not-in-channel', message: 'user is not in this voice channel' },
        })
      }

      const mod = await getModState(channelId, targetId)

      switch (action) {
        case 'mute': {
          const next: ModState = { ...mod, muted: true }
          await setModState(channelId, targetId, next)
          await muteParticipantMic({ channelId, userId: targetId, muted: true })
          await redis.del(participantsCacheKey(channelId))
          await broadcastToServer(serverId, {
            t: 'voice.mod', channelId, userId: targetId, muted: true, deafened: next.deafened,
          })
          break
        }
        case 'unmute': {
          // Снятие мьюта снимает и deafen — зеркало клиентского toggleMute.
          await setModState(channelId, targetId, { muted: false, deafened: false, mutedBefore: false })
          await muteParticipantMic({ channelId, userId: targetId, muted: false })
          await redis.del(participantsCacheKey(channelId))
          await broadcastToServer(serverId, {
            t: 'voice.mod', channelId, userId: targetId, muted: false, deafened: false,
          })
          break
        }
        case 'deafen': {
          const next: ModState = { muted: true, deafened: true, mutedBefore: mod.muted }
          await setModState(channelId, targetId, next)
          await muteParticipantMic({ channelId, userId: targetId, muted: true })
          await redis.del(participantsCacheKey(channelId))
          await broadcastToServer(serverId, {
            t: 'voice.mod', channelId, userId: targetId, muted: true, deafened: true,
          })
          break
        }
        case 'undeafen': {
          const next: ModState = { muted: mod.mutedBefore, deafened: false, mutedBefore: false }
          await setModState(channelId, targetId, next)
          if (!next.muted) {
            await muteParticipantMic({ channelId, userId: targetId, muted: false })
          }
          await redis.del(participantsCacheKey(channelId))
          await broadcastToServer(serverId, {
            t: 'voice.mod', channelId, userId: targetId, muted: next.muted, deafened: false,
          })
          break
        }
        case 'kick': {
          await revokeUser({ userId: targetId, channelId })
          await redis.srem(roomUsersKey(channelId), targetId)
          await redis.hdel(modStateKey(channelId), targetId)
          await redis.del(participantsCacheKey(channelId))
          await broadcastToServer(serverId, { t: 'voice.kicked', channelId, userId: targetId })
          break
        }
        case 'move': {
          if (!toChannelId) {
            return reply.code(400).send({
              error: { code: 'missing-to-channel', message: 'toChannelId is required for move' },
            })
          }
          const targetRows = await db
            .select({ serverId: channels.serverId, kind: channels.kind })
            .from(channels)
            .where(eq(channels.id, toChannelId))
            .limit(1)
          const target = targetRows[0]
          if (!target || target.serverId !== serverId || target.kind !== 'voice') {
            return reply.code(400).send({
              error: { code: 'bad-target-channel', message: 'target must be a voice channel of the same server' },
            })
          }
          // Модерация привязана к каналу — в новом канале человек чист.
          await redis.hdel(modStateKey(channelId), targetId)
          // Сам перенос делает клиент цели: voice.moved → join(toChannelId).
          // LiveKit-овский серверный move потребовал бы поддержки RoomMoved
          // на клиенте; пере-джойн проще и переживает любые версии.
          await broadcastToServer(serverId, {
            t: 'voice.moved', userId: targetId, fromChannelId: channelId, toChannelId,
          })
          break
        }
      }

      return reply.code(204).send(null)
    },
  )

  // ───── POST /api/voice/dm/:channelId/join (T-087) ─────
  //
  // Подключение к DM-звонку. Если в комнате ещё никого — я инициатор: зовём
  // собеседника targeted-инвайтом и ставим 30s-таймер «не ответили». Если
  // кто-то уже здесь (инициатор) — я принимаю: гасим звонок.
  app.post(
    '/voice/dm/:channelId/join',
    {
      preHandler: app.authenticate,
      schema: {
        params: z.object({ channelId: z.string().uuid() }),
        body: VoiceJoinRequestSchema,
        response: {
          200: VoiceJoinResponseSchema,
          401: ErrorBodySchema,
          403: ErrorBodySchema,
          404: ErrorBodySchema,
        },
      },
    },
    async (req, reply) => {
      const { channelId } = req.params
      const userId = req.authUser!.id

      const peerId = await dmPeerOf(channelId, userId)
      if (!peerId) throw forbidden('not a participant of this dm')

      const userRows = await db
        .select({ displayName: users.displayName, avatarUrl: users.avatarUrl })
        .from(users)
        .where(eq(users.id, userId))
        .limit(1)
      const me = userRows[0]
      if (!me) throw notFound('user-not-found', 'user not found')

      const token = await issueToken({
        userId,
        channelId,
        displayName: me.displayName,
        deviceId: req.body.deviceId,
        room: dmRoomName(channelId),
      })

      // Кто уже в комнате (по LiveKit) и есть ли висящий инвайт — определяет,
      // инициатор я или принимающий. Это устойчиво и к гонке «принял раньше,
      // чем у звонящего поднялась медиа» (тогда инвайт ещё висит на меня).
      const present = await listDmParticipants(channelId)
      const othersPresent = present.some((p) => p.userId !== userId)
      const invite = dmInvites.get(channelId)

      if (othersPresent || (invite && invite.to === userId)) {
        // Принимаю звонок (или переподключаюсь) — гасим инвайт/таймаут.
        clearDmInvite(channelId)
        // Ответил на одном устройстве — снимаем ринг на остальных устройствах
        // этого же пользователя: dm.call-invite летел ВСЕМ его соединениям
        // (аудит 2026-08, C-2). Клиентский IncomingCall чистит по channelId.
        if (invite && invite.to === userId && !othersPresent) {
          void broadcastToUser(userId, { t: 'dm.call-cancel', channelId, fromUserId: invite.from })
        }
      } else if (invite && invite.from === userId) {
        // Я уже звоню (повторный/retry join) — продлеваем таймер, не дублируем
        // инвайт.
        clearTimeout(invite.timer)
        invite.timer = setTimeout(() => {
          dmInvites.delete(channelId)
          void broadcastToUser(peerId, { t: 'dm.call-cancel', channelId, fromUserId: userId })
          void broadcastToUser(userId, { t: 'dm.call-cancel', channelId, fromUserId: userId })
        }, DM_RING_TIMEOUT_MS)
      } else {
        // Свежий звонок — я инициатор: зову собеседника и завожу таймаут.
        clearDmInvite(channelId)
        const timer = setTimeout(() => {
          dmInvites.delete(channelId)
          void broadcastToUser(peerId, { t: 'dm.call-cancel', channelId, fromUserId: userId })
          void broadcastToUser(userId, { t: 'dm.call-cancel', channelId, fromUserId: userId })
        }, DM_RING_TIMEOUT_MS)
        dmInvites.set(channelId, { from: userId, to: peerId, timer })
        await broadcastToUser(peerId, {
          t: 'dm.call-invite',
          channelId,
          fromUserId: userId,
          fromName: me.displayName,
          fromAvatarUrl: me.avatarUrl ?? null,
        })
      }

      // Список участников UI пересоберёт из самой LiveKit-комнаты после
      // connect (installVoiceRoom), поэтому snapshot тут пустой.
      return reply.code(200).send({
        token: token.token,
        url: token.url,
        room: token.room,
        participants: [],
      })
    },
  )

  // ───── POST /api/voice/dm/:channelId/leave (T-087) ─────
  app.post(
    '/voice/dm/:channelId/leave',
    {
      preHandler: app.authenticate,
      schema: {
        params: z.object({ channelId: z.string().uuid() }),
        response: {
          204: z.null(),
          401: ErrorBodySchema,
        },
      },
    },
    async (req, reply) => {
      const { channelId } = req.params
      const userId = req.authUser!.id
      // Инициатор положил трубку до ответа — отменяем звонок у собеседника.
      const inv = dmInvites.get(channelId)
      if (inv && inv.from === userId) {
        clearDmInvite(channelId)
        await broadcastToUser(inv.to, { t: 'dm.call-cancel', channelId, fromUserId: userId })
      }
      return reply.code(204).send(null)
    },
  )

  // ───── POST /api/voice/dm/:channelId/decline (T-087) ─────
  app.post(
    '/voice/dm/:channelId/decline',
    {
      preHandler: app.authenticate,
      schema: {
        params: z.object({ channelId: z.string().uuid() }),
        response: {
          204: z.null(),
          401: ErrorBodySchema,
          403: ErrorBodySchema,
          404: ErrorBodySchema,
        },
      },
    },
    async (req, reply) => {
      const { channelId } = req.params
      const userId = req.authUser!.id
      const peerId = await dmPeerOf(channelId, userId)
      if (!peerId) throw forbidden('not a participant of this dm')
      const inv = dmInvites.get(channelId)
      if (inv && inv.to === userId) {
        clearDmInvite(channelId)
        await broadcastToUser(inv.from, { t: 'dm.call-decline', channelId, fromUserId: userId })
      }
      return reply.code(204).send(null)
    },
  )
}
