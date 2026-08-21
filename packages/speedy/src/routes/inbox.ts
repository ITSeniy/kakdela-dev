import { and, desc, eq, inArray, isNotNull, isNull, lt, ne, or, sql } from 'drizzle-orm'
import { alias } from 'drizzle-orm/pg-core'
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod'
import { z } from 'zod'

import {
  ErrorBodySchema,
  InboxMarkReadRequestSchema,
  InboxMentionsResponseSchema,
  type InboxMention,
} from '@kakdela/ginzu/api-types'

import { channels, dmChannels, mentions, messages, serverMembers, servers, users } from '../db/schema.js'
import { db } from '../lib/db.js'

const PREVIEW_MAX = 240

// Членство ЗРИТЛЯ в сервере канала (join для author-профиля — отдельный).
const viewerMembership = alias(serverMembers, 'viewer_membership')

/**
 * Упоминание видно в инбоксе, только если канал сейчас доступен: после кика/
 * выхода с сервера старые упоминания с превью контента не должны ни
 * показываться, ни считаться непрочитанными (аудит M-5). Поиск фильтрует так
 * же. Повторный вход на сервер упоминания возвращает.
 */
function accessCondition(userId: string) {
  return or(
    and(
      eq(channels.kind, 'dm'),
      or(eq(dmChannels.userAId, userId), eq(dmChannels.userBId, userId)),
    ),
    and(ne(channels.kind, 'dm'), isNotNull(viewerMembership.userId)),
  )
}

function preview(s: string): string {
  const trimmed = s.replace(/\s+/g, ' ').trim()
  return trimmed.length > PREVIEW_MAX ? trimmed.slice(0, PREVIEW_MAX - 1) + '…' : trimmed
}

export const inboxRoutes: FastifyPluginAsyncZod = async (app) => {
  // ───── GET /api/inbox/mentions ─────
  // Постранично: cursor — id последнего сообщения с предыдущей страницы
  // (uuidv7 time-ordered, идём от свежих к старым).
  app.get(
    '/inbox/mentions',
    {
      preHandler: app.authenticate,
      schema: {
        querystring: z.object({
          before: z.string().uuid().optional(),
          limit:  z.coerce.number().int().min(1).max(100).default(50),
          unreadOnly: z.coerce.boolean().optional().default(false),
        }),
        response: {
          200: InboxMentionsResponseSchema,
          401: ErrorBodySchema,
        },
      },
    },
    async (req, reply) => {
      const userId = req.authUser!.id
      const { before, limit, unreadOnly } = req.query

      const conditions = [
        eq(mentions.mentionedUserId, userId),
        isNull(messages.deletedAt),
        accessCondition(userId),
      ]
      if (unreadOnly) conditions.push(isNull(mentions.readAt))
      if (before !== undefined) conditions.push(lt(messages.id, before))

      const rows = await db
        .select({
          messageId:        messages.id,
          channelId:        messages.channelId,
          authorId:         messages.authorId,
          content:          messages.content,
          createdAt:        messages.createdAt,
          mentionType:      mentions.mentionType,
          readAt:           mentions.readAt,
          channelName:      channels.name,
          channelKind:      channels.kind,
          serverId:         channels.serverId,
          // Серверный профиль автора поверх глобального (в DM join пустой).
          authorDisplay:    sql<string>`COALESCE(${serverMembers.nickname}, ${users.displayName})`,
          authorAvatarUrl:  sql<string | null>`COALESCE(${serverMembers.avatarUrl}, ${users.avatarUrl})`,
        })
        .from(mentions)
        .innerJoin(messages, eq(mentions.messageId, messages.id))
        .innerJoin(channels, eq(messages.channelId, channels.id))
        .innerJoin(users, eq(messages.authorId, users.id))
        .leftJoin(serverMembers, and(
          eq(serverMembers.serverId, channels.serverId),
          eq(serverMembers.userId, messages.authorId),
        ))
        .leftJoin(dmChannels, eq(dmChannels.channelId, messages.channelId))
        .leftJoin(viewerMembership, and(
          eq(viewerMembership.serverId, channels.serverId),
          eq(viewerMembership.userId, userId),
        ))
        .where(and(...conditions))
        .orderBy(desc(messages.id))
        .limit(limit + 1)

      const hasMore = rows.length > limit
      if (hasMore) rows.pop()
      const nextCursor = hasMore ? (rows[rows.length - 1]?.messageId ?? null) : null

      // Подтянуть имена серверов одним запросом.
      const serverIds = [...new Set(
        rows.map((r) => r.serverId).filter((s): s is string => s !== null),
      )]
      const serverRows = serverIds.length > 0
        ? await db
            .select({ id: servers.id, name: servers.name })
            .from(servers)
            .where(inArray(servers.id, serverIds))
        : []
      const serverNameById = new Map(serverRows.map((s) => [s.id, s.name]))

      const items: InboxMention[] = rows.map((r) => ({
        messageId:       r.messageId,
        channelId:       r.channelId,
        channelName:     r.channelName,
        channelKind:     r.channelKind,
        serverId:        r.serverId,
        serverName:      r.serverId ? (serverNameById.get(r.serverId) ?? null) : null,
        authorId:        r.authorId,
        authorName:      r.authorDisplay,
        authorAvatarUrl: r.authorAvatarUrl,
        content:         preview(r.content),
        createdAt:       r.createdAt.toISOString(),
        mentionType:     r.mentionType,
        readAt:          r.readAt?.toISOString() ?? null,
      }))

      // Общее число непрочитанных — для бейджа на иконке «входящие».
      // Тот же фильтр доступа: недоступные упоминания не считаются.
      const unreadRows = await db
        .select({ count: sql<number>`COUNT(*)::int` })
        .from(mentions)
        .innerJoin(messages, eq(mentions.messageId, messages.id))
        .innerJoin(channels, eq(messages.channelId, channels.id))
        .leftJoin(dmChannels, eq(dmChannels.channelId, messages.channelId))
        .leftJoin(viewerMembership, and(
          eq(viewerMembership.serverId, channels.serverId),
          eq(viewerMembership.userId, userId),
        ))
        .where(and(
          eq(mentions.mentionedUserId, userId),
          isNull(mentions.readAt),
          isNull(messages.deletedAt),
          accessCondition(userId),
        ))
      const unreadTotal = unreadRows[0]?.count ?? 0

      return reply.code(200).send({ mentions: items, nextCursor, unreadTotal })
    },
  )

  // ───── POST /api/inbox/mentions/read ─────
  // Идемпотентно отмечает упоминания прочитанными по messageIds. Никакой
  // проверки доступа к сообщению — упомянутый user тривиально имеет право
  // погасить свой бейдж: затрагиваем только строки mentioned_user_id = me.
  // Это же позволяет клиенту дочистить непрочитанные по каналам, ставшим
  // недоступными после кика (в списке они больше не показываются).
  app.post(
    '/inbox/mentions/read',
    {
      preHandler: app.authenticate,
      schema: {
        body: InboxMarkReadRequestSchema,
        response: {
          204: z.null(),
          401: ErrorBodySchema,
        },
      },
    },
    async (req, reply) => {
      const userId = req.authUser!.id
      const { messageIds } = req.body
      if (messageIds.length === 0) return reply.code(204).send(null)

      await db
        .update(mentions)
        .set({ readAt: new Date() })
        .where(and(
          eq(mentions.mentionedUserId, userId),
          inArray(mentions.messageId, messageIds),
          isNull(mentions.readAt),
        ))

      return reply.code(204).send(null)
    },
  )
}
