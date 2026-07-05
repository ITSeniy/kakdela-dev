import { and, desc, eq, gt, isNull, lt, sql } from 'drizzle-orm'
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod'

import {
  ErrorBodySchema,
  SearchRequestSchema,
  SearchResponseSchema,
  type SearchResultItem,
} from '@kakdela/ginzu/api-types'

import { channels, messages, serverMembers, servers, users } from '../db/schema.js'
import { db } from '../lib/db.js'
import { assertCanAccessChannel } from '../lib/permissions.js'

const TS_CONFIG = 'russian'

export const searchRoutes: FastifyPluginAsyncZod = async (app) => {
  // ───── GET /api/search/messages ─────
  //
  // Полнотекстовый поиск через `messages.search_vector` (GENERATED ALWAYS AS,
  // GIN-индекс — см. миграцию 0009). `websearch_to_tsquery` принимает
  // Google-style синтаксис от пользователя (кавычки, минус), но не падает на
  // мусоре — оборачивать руками в `to_tsquery` опасно (любая скобка ломает).
  //
  // Permission: явный channelId → проверяем assertCanAccessChannel.
  // Без channelId — фильтр в WHERE сужает до server-каналов с членством
  // user'а и DM-каналов с его участием. Это две дешёвые подзапроса, GIN
  // покрывает основной фильтр @@.
  app.get(
    '/search/messages',
    {
      preHandler: app.authenticate,
      schema: {
        querystring: SearchRequestSchema,
        response: {
          200: SearchResponseSchema,
          400: ErrorBodySchema,
          401: ErrorBodySchema,
          403: ErrorBodySchema,
          404: ErrorBodySchema,
        },
      },
    },
    async (req, reply) => {
      const userId = req.authUser!.id
      const { q, channelId, serverId, authorId, before, after, limit, sort } = req.query

      if (channelId) {
        await assertCanAccessChannel(userId, channelId)
      }

      // Используем websearch_to_tsquery для устойчивости к произвольному
      // вводу. Имя конфигурации захардкожено — внешним параметром не делаем,
      // чтобы не плодить attack-surface (`set_config`-style инъекции).
      const tsq = sql`websearch_to_tsquery(${TS_CONFIG}, ${q})`

      const conditions = [
        sql`messages.search_vector @@ ${tsq}`,
        isNull(messages.deletedAt),
      ]

      if (channelId) {
        conditions.push(eq(messages.channelId, channelId))
      } else if (serverId) {
        // Поиск в пределах одного сервера: только его каналы И только если
        // user в нём состоит (членство гарантирует подзапрос). Не-член → пусто.
        conditions.push(sql`
          messages.channel_id IN (
            SELECT c.id FROM channels c
            WHERE c.server_id = ${serverId}
              AND c.server_id IN (
                SELECT sm.server_id FROM server_members sm WHERE sm.user_id = ${userId}
              )
          )
        `)
      } else {
        // Без явного channelId — ограничиваем до доступных user'у каналов.
        // Все server-каналы, где есть его server_members row, плюс все
        // dm_channels, где он userA или userB.
        conditions.push(sql`
          messages.channel_id IN (
            SELECT c.id FROM channels c
            WHERE c.server_id IN (
              SELECT sm.server_id FROM server_members sm WHERE sm.user_id = ${userId}
            )
            OR c.id IN (
              SELECT d.channel_id FROM dm_channels d
              WHERE d.user_a_id = ${userId} OR d.user_b_id = ${userId}
            )
          )
        `)
      }

      if (authorId) conditions.push(eq(messages.authorId, authorId))
      if (before)   conditions.push(lt(messages.createdAt, new Date(before)))
      if (after)    conditions.push(gt(messages.createdAt, new Date(after)))

      const headlineOpts =
        'StartSel=<mark>, StopSel=</mark>, MaxFragments=2, MaxWords=18, MinWords=4, FragmentDelimiter=" … "'

      const orderBy = sort === 'recent'
        ? [desc(messages.createdAt)]
        : [
            desc(sql`ts_rank_cd(messages.search_vector, ${tsq})`),
            desc(messages.createdAt),
          ]

      // Cap LIMIT at the validated value (Zod already constrained 1..100).
      const rows = await db
        .select({
          messageId:       messages.id,
          channelId:       messages.channelId,
          authorId:        messages.authorId,
          content:         messages.content,
          createdAt:       messages.createdAt,
          rank:            sql<number>`ts_rank_cd(messages.search_vector, ${tsq})`,
          headline:        sql<string>`ts_headline(${TS_CONFIG}, ${messages.content}, ${tsq}, ${headlineOpts})`,
          channelName:     channels.name,
          channelKind:     channels.kind,
          serverId:        channels.serverId,
          serverName:      servers.name,
          // Серверный профиль автора поверх глобального (в DM join пустой).
          authorName:      sql<string>`COALESCE(${serverMembers.nickname}, ${users.displayName})`,
          authorAvatarUrl: sql<string | null>`COALESCE(${serverMembers.avatarUrl}, ${users.avatarUrl})`,
        })
        .from(messages)
        .innerJoin(channels, eq(messages.channelId, channels.id))
        .leftJoin(servers, eq(channels.serverId, servers.id))
        .innerJoin(users, eq(messages.authorId, users.id))
        .leftJoin(serverMembers, and(
          eq(serverMembers.serverId, channels.serverId),
          eq(serverMembers.userId, messages.authorId),
        ))
        .where(and(...conditions))
        .orderBy(...orderBy)
        .limit(limit)

      const results: SearchResultItem[] = rows.map((r) => ({
        messageId:       r.messageId,
        channelId:       r.channelId,
        channelName:     r.channelKind === 'dm' ? r.authorName : r.channelName,
        channelKind:     r.channelKind,
        serverId:        r.serverId,
        serverName:      r.serverName ?? null,
        authorId:        r.authorId,
        authorName:      r.authorName,
        authorAvatarUrl: r.authorAvatarUrl,
        content:         r.content,
        headline:        r.headline,
        createdAt:       r.createdAt.toISOString(),
        rank:            typeof r.rank === 'number' ? r.rank : Number(r.rank ?? 0),
      }))

      // Total — простой COUNT(*) с теми же условиями. На самохосте 15-20
      // friends объёмы маленькие; если станет узким — можно срезать total и
      // показывать «>= limit» без точного числа.
      const totalRows = await db
        .select({ count: sql<number>`COUNT(*)::int` })
        .from(messages)
        .innerJoin(channels, eq(messages.channelId, channels.id))
        .where(and(...conditions))
      const total = totalRows[0]?.count ?? 0

      return reply.code(200).send({ results, total, query: q })
    },
  )
}
