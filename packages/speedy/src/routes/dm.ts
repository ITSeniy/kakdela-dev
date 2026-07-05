import { and, desc, eq, inArray, isNull, ne, or, sql } from 'drizzle-orm'
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod'
import { z } from 'zod'

import {
  DmListResponseSchema,
  DmMarkReadRequestSchema,
  DmOpenResponseSchema,
  ErrorBodySchema,
  type DmSummary,
} from '@kakdela/ginzu/api-types'

import { channels, dmChannels, messages, users } from '../db/schema.js'
import { db } from '../lib/db.js'
import { forbidden, notFound } from '../lib/permissions.js'
import { presence } from '../presence/store.js'
import { broadcastToUser } from '../ws/broadcast.js'
import { registry } from '../ws/registry.js'

const PREVIEW_MAX = 80

function preview(s: string): string {
  const trimmed = s.replace(/\s+/g, ' ').trim()
  return trimmed.length > PREVIEW_MAX ? trimmed.slice(0, PREVIEW_MAX - 1) + '…' : trimmed
}

// Канонический порядок участников DM: меньший uuid идёт первым. Гарантирует
// уникальность ключа (userA, userB) для любой пары без дубликата (B, A).
function orderPair(a: string, b: string): { userAId: string; userBId: string } {
  return a < b ? { userAId: a, userBId: b } : { userAId: b, userBId: a }
}

export const dmRoutes: FastifyPluginAsyncZod = async (app) => {
  // ───── GET /api/dm ─────
  app.get(
    '/dm',
    {
      preHandler: app.authenticate,
      schema: {
        response: {
          200: DmListResponseSchema,
          401: ErrorBodySchema,
        },
      },
    },
    async (req, reply) => {
      const userId = req.authUser!.id

      const dmRows = await db
        .select({
          channelId:  dmChannels.channelId,
          userAId:    dmChannels.userAId,
          userBId:    dmChannels.userBId,
          lastReadA:  dmChannels.lastReadA,
          lastReadB:  dmChannels.lastReadB,
          hiddenA:    dmChannels.hiddenA,
          hiddenB:    dmChannels.hiddenB,
        })
        .from(dmChannels)
        .where(or(eq(dmChannels.userAId, userId), eq(dmChannels.userBId, userId)))

      if (dmRows.length === 0) return reply.code(200).send({ dms: [] })

      const channelIds = dmRows.map((d) => d.channelId)
      const otherIds = dmRows.map((d) => (d.userAId === userId ? d.userBId : d.userAId))

      // 1) Метаданные собеседников + live presence
      const otherUsersRows = await db
        .select({
          id:           users.id,
          displayName:  users.displayName,
          username:     users.username,
          avatarUrl:    users.avatarUrl,
          status:       users.status,
          customStatus: users.customStatus,
        })
        .from(users)
        .where(inArray(users.id, otherIds))
      const otherUserById = new Map(otherUsersRows.map((u) => [u.id, u]))
      const presenceMap = await presence.getStatusBulk(otherIds)

      // 2) Последнее НЕ-удалённое сообщение каждого DM-канала. DISTINCT ON
      //    вместо MAX(id): агрегата max(uuid) в Postgres нет, а id (uuidv7)
      //    монотонен — сортировки по нему достаточно.
      const lastMsgRows = await db
        .selectDistinctOn([messages.channelId], {
          id:        messages.id,
          channelId: messages.channelId,
          authorId:  messages.authorId,
          content:   messages.content,
          poll:      messages.poll,
          createdAt: messages.createdAt,
        })
        .from(messages)
        .where(and(inArray(messages.channelId, channelIds), isNull(messages.deletedAt)))
        .orderBy(messages.channelId, desc(messages.id))
      const lastByChannel = new Map(lastMsgRows.map((m) => [m.channelId, m]))

      // 3) unread = одно SQL'е через JOIN с dm_channels:
      //    для своей стороны фильтруем по lastReadA/B (или без фильтра, если null).
      const unreadRows = await db
        .select({
          channelId: messages.channelId,
          count:     sql<number>`COUNT(*)::int`,
        })
        .from(messages)
        .innerJoin(dmChannels, eq(messages.channelId, dmChannels.channelId))
        .where(
          and(
            inArray(messages.channelId, channelIds),
            ne(messages.authorId, userId),
            isNull(messages.deletedAt),
            or(
              and(
                eq(dmChannels.userAId, userId),
                or(
                  isNull(dmChannels.lastReadA),
                  sql`${messages.id} > ${dmChannels.lastReadA}`,
                ),
              ),
              and(
                eq(dmChannels.userBId, userId),
                or(
                  isNull(dmChannels.lastReadB),
                  sql`${messages.id} > ${dmChannels.lastReadB}`,
                ),
              ),
            ),
          ),
        )
        .groupBy(messages.channelId)
      const unreadByChannel = new Map(unreadRows.map((u) => [u.channelId, u.count]))

      const summaries: DmSummary[] = []
      for (const dm of dmRows) {
        const otherId = dm.userAId === userId ? dm.userBId : dm.userAId
        const other = otherUserById.get(otherId)
        if (!other) continue
        // Закрытая переписка скрыта, пока нет непрочитанного. Новое сообщение
        // (unread > 0) вернёт её в список автоматически.
        const hidden = dm.userAId === userId ? dm.hiddenA : dm.hiddenB
        const unread = unreadByChannel.get(dm.channelId) ?? 0
        if (hidden && unread === 0) continue
        const last = lastByChannel.get(dm.channelId)
        summaries.push({
          channelId: dm.channelId,
          peerLastReadMessageId: dm.userAId === userId ? dm.lastReadB : dm.lastReadA,
          otherUser: {
            id:           other.id,
            displayName:  other.displayName,
            username:     other.username,
            avatarUrl:    other.avatarUrl,
            status:       presenceMap.get(other.id)?.status ?? other.status,
            customStatus: other.customStatus,
            roles:        [],
            permissions:  0,
          },
          lastMessage: last
            ? {
                id:        last.id,
                authorId:  last.authorId,
                // У сообщения-опроса content пустой — превью строим из вопроса.
                preview:   last.poll
                  ? preview(`[опрос] ${(last.poll as { question?: string }).question ?? ''}`)
                  : preview(last.content),
                createdAt: last.createdAt.toISOString(),
              }
            : null,
          unreadCount: unreadByChannel.get(dm.channelId) ?? 0,
        })
      }

      // Самые свежие — сверху. DM без сообщений (только что созданный) идут вниз.
      summaries.sort((a, b) => {
        const ta = a.lastMessage?.createdAt ?? ''
        const tb = b.lastMessage?.createdAt ?? ''
        if (ta && tb) return tb.localeCompare(ta)
        if (ta) return -1
        if (tb) return 1
        return 0
      })

      return reply.code(200).send({ dms: summaries })
    },
  )

  // ───── POST /api/dm/with/:userId ─────
  app.post(
    '/dm/with/:userId',
    {
      preHandler: app.authenticate,
      schema: {
        params: z.object({ userId: z.string().uuid() }),
        response: {
          200: DmOpenResponseSchema,
          400: ErrorBodySchema,
          401: ErrorBodySchema,
          404: ErrorBodySchema,
        },
      },
    },
    async (req, reply) => {
      const me = req.authUser!.id
      const other = req.params.userId
      // me === other разрешён: «заметки себе» (Telegram Saved Messages).
      // orderPair(me, me) даёт каноническую пару (me, me) — обычный DM-канал,
      // где оба участника — один юзер; unread всегда 0 (свои сообщения не
      // считаются), звонки клиент не показывает.

      const otherRows = await db
        .select({
          id:           users.id,
          displayName:  users.displayName,
          username:     users.username,
          avatarUrl:    users.avatarUrl,
          status:       users.status,
          customStatus: users.customStatus,
        })
        .from(users)
        .where(eq(users.id, other))
        .limit(1)
      const otherUser = otherRows[0]
      if (!otherUser) throw notFound('user-not-found', 'user not found')

      const pair = orderPair(me, other)

      // Идемпотентный path: возвращаем существующий DM, если есть.
      const existing = await db
        .select()
        .from(dmChannels)
        .where(and(eq(dmChannels.userAId, pair.userAId), eq(dmChannels.userBId, pair.userBId)))
        .limit(1)

      const presenceMap = await presence.getStatusBulk([other])
      const otherPublic = {
        id:           otherUser.id,
        displayName:  otherUser.displayName,
        username:     otherUser.username,
        avatarUrl:    otherUser.avatarUrl,
        status:       presenceMap.get(otherUser.id)?.status ?? otherUser.status,
        customStatus: otherUser.customStatus,
        roles:        [],
        permissions:  0,
      }

      if (existing[0]) {
        const dm = existing[0]
        // Явное открытие переписки снимает «скрыто» у открывшего.
        const myHidden = me === dm.userAId ? dm.hiddenA : dm.hiddenB
        if (myHidden) {
          await db
            .update(dmChannels)
            .set(me === dm.userAId ? { hiddenA: false } : { hiddenB: false })
            .where(eq(dmChannels.channelId, dm.channelId))
        }
        const chRows = await db
          .select()
          .from(channels)
          .where(eq(channels.id, dm.channelId))
          .limit(1)
        const ch = chRows[0]
        if (!ch) throw notFound('channel-not-found', 'channel not found')
        return reply.code(200).send({
          channel: {
            id: ch.id,
            serverId: ch.serverId,
            name: ch.name,
            kind: ch.kind,
            category: ch.category,
            topic: ch.topic,
            position: ch.position,
          },
          otherUser: otherPublic,
          created: false,
        })
      }

      // Создаём пару: channels row (serverId=NULL, kind='dm') + dm_channels.
      // Имя для DM в UI не используется (заголовок строится из otherUser), но
      // храним строкой — на случай поиска/дампов.
      const channelName = `dm:${pair.userAId.slice(0, 8)}:${pair.userBId.slice(0, 8)}`
      const insertedCh = await db
        .insert(channels)
        .values({
          serverId: null,
          name:     channelName,
          kind:     'dm',
          position: 0,
        })
        .returning()
      const ch = insertedCh[0]
      if (!ch) throw new Error('insert into channels returned no rows')

      await db.insert(dmChannels).values({
        channelId: ch.id,
        userAId:   pair.userAId,
        userBId:   pair.userBId,
      })

      // Hot-attach новый DM ко всем активным соединениям обоих юзеров, чтобы
      // msg.new сразу полетел через registry.byChannel.
      for (const uid of [me, other]) {
        for (const conn of registry.forUser(uid)) {
          registry.subscribeChannel(conn, ch.id)
        }
      }
      // Сообщаем собеседнику о новом DM — UI рисует карточку без перезагрузки.
      void broadcastToUser(other, { t: 'dm.new', channelId: ch.id, withUserId: me })

      return reply.code(200).send({
        channel: {
          id: ch.id,
          serverId: ch.serverId,
          name: ch.name,
          kind: ch.kind,
          category: ch.category,
          topic: ch.topic,
          position: ch.position,
        },
        otherUser: otherPublic,
        created: true,
      })
    },
  )

  // ───── POST /api/dm/:channelId/read ─────
  // Помечаем DM как прочитанный до конкретного messageId — UI шлёт это при
  // фокусе на канале и при появлении новых сообщений снизу. Монотонно
  // продвигаем вперёд (uuidv7 = time-ordered).
  app.post(
    '/dm/:channelId/read',
    {
      preHandler: app.authenticate,
      schema: {
        params: z.object({ channelId: z.string().uuid() }),
        body: DmMarkReadRequestSchema,
        response: {
          204: z.null(),
          401: ErrorBodySchema,
          403: ErrorBodySchema,
          404: ErrorBodySchema,
        },
      },
    },
    async (req, reply) => {
      const userId = req.authUser!.id
      const { channelId } = req.params
      const { messageId } = req.body

      const dmRows = await db
        .select()
        .from(dmChannels)
        .where(eq(dmChannels.channelId, channelId))
        .limit(1)
      const dm = dmRows[0]
      if (!dm) throw notFound('channel-not-found', 'dm channel not found')
      if (dm.userAId !== userId && dm.userBId !== userId) {
        throw forbidden('not a participant of this dm')
      }

      const isA = dm.userAId === userId
      const prev = isA ? dm.lastReadA : dm.lastReadB
      if (prev && messageId <= prev) {
        return reply.code(204).send(null)
      }

      // Чтение свежего сообщения снимает «скрыто» — переписка остаётся в списке.
      await db
        .update(dmChannels)
        .set(isA ? { lastReadA: messageId, hiddenA: false } : { lastReadB: messageId, hiddenB: false })
        .where(eq(dmChannels.channelId, channelId))

      // Сообщаем собеседнику: его сообщения до messageId прочитаны (галочки).
      const otherId = isA ? dm.userBId : dm.userAId
      void broadcastToUser(otherId, { t: 'dm.read', channelId, userId, messageId })

      return reply.code(204).send(null)
    },
  )

  // ───── POST /api/dm/:channelId/hide ─────
  // «Закрыть переписку»: убрать из своего списка до следующего сообщения.
  // Per-user, собеседника не трогает.
  app.post(
    '/dm/:channelId/hide',
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
      const userId = req.authUser!.id
      const { channelId } = req.params

      const dmRows = await db
        .select()
        .from(dmChannels)
        .where(eq(dmChannels.channelId, channelId))
        .limit(1)
      const dm = dmRows[0]
      if (!dm) throw notFound('channel-not-found', 'dm channel not found')
      if (dm.userAId !== userId && dm.userBId !== userId) {
        throw forbidden('not a participant of this dm')
      }

      await db
        .update(dmChannels)
        .set(dm.userAId === userId ? { hiddenA: true } : { hiddenB: true })
        .where(eq(dmChannels.channelId, channelId))

      return reply.code(204).send(null)
    },
  )
}
