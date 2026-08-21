import { and, eq, isNull, ne, sql } from 'drizzle-orm'
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod'
import { z } from 'zod'

import {
  ChannelSchema,
  ErrorBodySchema,
  PatchChannelRequestSchema,
} from '@kakdela/ginzu/api-types'

import { channelCategories, channelReads, channels, messages } from '../db/schema.js'
import { audit } from '../lib/audit.js'
import { CHANNEL_DTO_COLS } from '../lib/channel-dto.js'
import { db } from '../lib/db.js'
import { purgeFilesForChannel } from '../lib/media-gc.js'
import { assertCanAccessChannel, assertMember, assertPermission, notFound } from '../lib/permissions.js'
import { broadcastToServer } from '../ws/broadcast.js'

export const channelsRoutes: FastifyPluginAsyncZod = async (app) => {
  // ───── GET /api/channels/:channelId ─────
  app.get(
    '/channels/:channelId',
    {
      preHandler: app.authenticate,
      schema: {
        params: z.object({ channelId: z.string().uuid() }),
        response: {
          200: ChannelSchema,
          401: ErrorBodySchema,
          403: ErrorBodySchema,
          404: ErrorBodySchema,
        },
      },
    },
    async (req, reply) => {
      const { channelId } = req.params
      const userId = req.authUser!.id

      const rows = await db
        .select(CHANNEL_DTO_COLS)
        .from(channels)
        .where(eq(channels.id, channelId))
        .limit(1)
      const channel = rows[0]
      if (!channel) throw notFound('channel-not-found', 'channel not found')
      if (!channel.serverId) throw notFound('channel-not-found', 'channel not found')

      await assertMember(userId, channel.serverId)

      return reply.code(200).send(channel)
    },
  )

  // ───── GET /api/channels/:channelId/stats ─────
  // Лёгкая статистика для шапки канала: число сообщений (без удалённых).
  app.get(
    '/channels/:channelId/stats',
    {
      preHandler: app.authenticate,
      schema: {
        params: z.object({ channelId: z.string().uuid() }),
        response: {
          200: z.object({ messageCount: z.number().int().nonnegative() }),
          401: ErrorBodySchema,
          403: ErrorBodySchema,
          404: ErrorBodySchema,
        },
      },
    },
    async (req, reply) => {
      const { channelId } = req.params
      await assertCanAccessChannel(req.authUser!.id, channelId)
      const rows = await db
        .select({ count: sql<number>`COUNT(*)::int` })
        .from(messages)
        .where(and(eq(messages.channelId, channelId), isNull(messages.deletedAt)))
      return reply.code(200).send({ messageCount: rows[0]?.count ?? 0 })
    },
  )

  // ───── POST /api/channels/:channelId/read ─────
  // Пометить канал прочитанным (lastReadAt = now). Клиент шлёт при открытии
  // канала и из ПКМ «пометить прочитанным».
  app.post(
    '/channels/:channelId/read',
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
      await assertCanAccessChannel(userId, channelId)

      await db
        .insert(channelReads)
        .values({ userId, channelId })
        .onConflictDoUpdate({
          target: [channelReads.userId, channelReads.channelId],
          set: { lastReadAt: sql`NOW()` },
        })

      return reply.code(204).send(null)
    },
  )

  // ───── PATCH /api/channels/:channelId ─────
  app.patch(
    '/channels/:channelId',
    {
      preHandler: app.authenticate,
      schema: {
        params: z.object({ channelId: z.string().uuid() }),
        body: PatchChannelRequestSchema,
        response: {
          200: ChannelSchema,
          401: ErrorBodySchema,
          403: ErrorBodySchema,
          404: ErrorBodySchema,
        },
      },
    },
    async (req, reply) => {
      const { channelId } = req.params
      const userId = req.authUser!.id

      const rows = await db
        .select({
          serverId: channels.serverId,
          name:     channels.name,
          topic:    channels.topic,
          position: channels.position,
          category: channels.category,
        })
        .from(channels)
        .where(eq(channels.id, channelId))
        .limit(1)
      const existing = rows[0]
      if (!existing || !existing.serverId) throw notFound('channel-not-found', 'channel not found')
      const existingServerId = existing.serverId

      await assertPermission(userId, existingServerId, 'MANAGE_CHANNELS')

      const { name, topic, position, category, kind, slowModeSec, autoDeleteSec, isDefault, friendsOnly, nsfw, threadsAllowed } = req.body
      const updates: Partial<typeof channels.$inferInsert> = {}
      if (name !== undefined) updates.name = name
      if (topic !== undefined) updates.topic = topic ?? null
      if (position !== undefined) updates.position = position
      if (category !== undefined) updates.category = category ?? null
      if (kind !== undefined) updates.kind = kind
      if (slowModeSec !== undefined) updates.slowModeSec = slowModeSec
      if (autoDeleteSec !== undefined) updates.autoDeleteSec = autoDeleteSec
      if (isDefault !== undefined) updates.isDefault = isDefault
      if (friendsOnly !== undefined) updates.friendsOnly = friendsOnly
      if (nsfw !== undefined) updates.nsfw = nsfw
      if (threadsAllowed !== undefined) updates.threadsAllowed = threadsAllowed

      // «Канал по умолчанию» — ровно один на сервер: при установке снимаем флаг
      // с остальных каналов до апдейта текущего.
      if (isDefault === true) {
        await db
          .update(channels)
          .set({ isDefault: false })
          .where(and(eq(channels.serverId, existingServerId), ne(channels.id, channelId)))
      }

      // Категория — отдельная сущность: если канал двигают в категорию,
      // которой нет в таблице (например, её успели удалить), регистрируем.
      if (category) {
        const maxCat = await db
          .select({ max: sql<number>`COALESCE(MAX(position), -1)::int` })
          .from(channelCategories)
          .where(eq(channelCategories.serverId, existingServerId))
        await db
          .insert(channelCategories)
          .values({ serverId: existingServerId, name: category, position: (maxCat[0]?.max ?? -1) + 1 })
          .onConflictDoNothing()
      }

      const updated = await db
        .update(channels)
        .set(updates)
        .where(eq(channels.id, channelId))
        .returning(CHANNEL_DTO_COLS)

      const channel = updated[0]
      if (!channel) throw new Error('update channels returned no rows')

      audit.log({
        serverId:   existingServerId,
        actorId:    userId,
        action:     'channel.update',
        targetType: 'channel',
        targetId:   channelId,
        metadata: {
          before: { name: existing.name, topic: existing.topic, position: existing.position, category: existing.category },
          after:  { name: channel.name,  topic: channel.topic,  position: channel.position,  category: channel.category },
        },
      })

      void broadcastToServer(existingServerId, {
        t: 'channel.update',
        serverId: existingServerId,
        channel,
      })

      return reply.code(200).send(channel)
    },
  )

  // ───── DELETE /api/channels/:channelId ─────
  app.delete(
    '/channels/:channelId',
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

      const rows = await db
        .select({
          serverId: channels.serverId,
          name:     channels.name,
          kind:     channels.kind,
        })
        .from(channels)
        .where(eq(channels.id, channelId))
        .limit(1)
      const existing = rows[0]
      if (!existing || !existing.serverId) throw notFound('channel-not-found', 'channel not found')
      const existingServerId = existing.serverId

      await assertPermission(userId, existingServerId, 'MANAGE_CHANNELS')

      // Файлы канала (и его тредов) — ДО удаления: после каскада строки files
      // исчезнут, и ключи S3-объектов будет нечем найти (аудит M-6).
      await purgeFilesForChannel(channelId, req.log)

      await db.delete(channels).where(eq(channels.id, channelId))

      audit.log({
        serverId:   existingServerId,
        actorId:    userId,
        action:     'channel.delete',
        targetType: 'channel',
        // targetId намеренно `null` после delete — само сообщение об удалении
        // достаточно идентифицируется по `name` в metadata.
        targetId:   null,
        metadata: { name: existing.name, kind: existing.kind },
      })

      void broadcastToServer(existingServerId, {
        t: 'channel.delete',
        serverId: existingServerId,
        channelId,
      })

      return reply.code(204).send(null)
    },
  )
}
