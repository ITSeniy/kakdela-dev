import { and, asc, eq, gt, inArray, sql } from 'drizzle-orm'
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod'
import { z } from 'zod'

import {
  ErrorBodySchema,
  SecretAckRequestSchema,
  SecretInboxResponseSchema,
  SecretSendRequestSchema,
  SecretSendResponseSchema,
} from '@kakdela/ginzu/api-types'

import { secretEnvelopes, users } from '../db/schema.js'
import { db } from '../lib/db.js'
import { notFound } from '../lib/permissions.js'
import { broadcastToUser } from '../ws/broadcast.js'

// Слепой релей секретных чатов (T-102). Сервер хранит непрозрачный шифртекст
// как очередь store-and-forward и удаляет его после ack получателем. Контента
// он не видит и не парсит. read/typing — это типизированные конверты, идущие
// тем же E2EE-каналом (их «значение» зашифровано внутри).
const INBOX_LIMIT = 200
// Капа на очередь одного получателя: защита от флуда конвертами (64 KB каждый,
// retention 30 дней). Порядок величины — месяцы активной переписки 1:1.
const MAX_PENDING_PER_RECIPIENT = 500

export const secretChatRoutes: FastifyPluginAsyncZod = async (app) => {
  // ───── POST /api/secret/send — положить конверт в очередь адресата ─────
  app.post(
    '/secret/send',
    {
      preHandler: app.authenticate,
      config: { rateLimit: { max: 60, timeWindow: '1 minute' } },
      schema: {
        body: SecretSendRequestSchema,
        response: {
          200: SecretSendResponseSchema,
          400: ErrorBodySchema,
          401: ErrorBodySchema,
          404: ErrorBodySchema,
          429: ErrorBodySchema,
        },
      },
    },
    async (req, reply) => {
      const me = req.authUser!.id
      const { toUserId, ciphertext, msgType } = req.body
      if (toUserId === me) {
        return reply
          .code(400)
          .send({ error: { code: 'self-secret', message: 'cannot send a secret message to yourself' } })
      }

      // Адресат должен существовать. Политика доступа — как у DM: писать может
      // любой аутентифицированный (all-friends-by-default, см. routes/dm.ts).
      const exists = await db.select({ id: users.id }).from(users).where(eq(users.id, toUserId)).limit(1)
      if (!exists[0]) throw notFound('user-not-found', 'recipient not found')

      // Не даём переполнить очередь получателя (race между параллельными
      // send'ами не критичен — капа приблизительная, sweeper всё равно чистит).
      const countRows = await db
        .select({ count: sql<number>`COUNT(*)::int` })
        .from(secretEnvelopes)
        .where(eq(secretEnvelopes.toUserId, toUserId))
      if ((countRows[0]?.count ?? 0) >= MAX_PENDING_PER_RECIPIENT) {
        return reply.code(429).send({
          error: { code: 'mailbox-full', message: 'recipient has too many pending envelopes' },
        })
      }

      const inserted = await db
        .insert(secretEnvelopes)
        .values({
          fromUserId: me,
          toUserId,
          ciphertext: Buffer.from(ciphertext, 'base64'),
          msgType,
        })
        .returning({ id: secretEnvelopes.id })
      const id = inserted[0]!.id

      // Уведомляем адресата (если онлайн) — БЕЗ контента, только «есть письмо».
      void broadcastToUser(toUserId, { t: 'secret.envelope', id, fromUserId: me })

      return reply.code(200).send({ id })
    },
  )

  // ───── GET /api/secret/inbox — недоставленные конверты для меня ─────
  app.get(
    '/secret/inbox',
    {
      preHandler: app.authenticate,
      schema: { querystring: z.object({ after: z.string().uuid().optional() }), response: { 200: SecretInboxResponseSchema, 401: ErrorBodySchema } },
    },
    async (req, reply) => {
      const me = req.authUser!.id
      const rows = await db
        .select({
          id:         secretEnvelopes.id,
          fromUserId: secretEnvelopes.fromUserId,
          ciphertext: secretEnvelopes.ciphertext,
          msgType:    secretEnvelopes.msgType,
          createdAt:  secretEnvelopes.createdAt,
        })
        .from(secretEnvelopes)
        .where(and(eq(secretEnvelopes.toUserId, me), req.query.after ? gt(secretEnvelopes.id, req.query.after) : undefined))
        .orderBy(asc(secretEnvelopes.id))
        .limit(INBOX_LIMIT + 1)

      return reply.code(200).send({
        nextCursor: rows.length > INBOX_LIMIT ? rows[INBOX_LIMIT - 1]!.id : null,
        envelopes: rows.slice(0, INBOX_LIMIT).map((r) => ({
          id:         r.id,
          fromUserId: r.fromUserId,
          ciphertext: Buffer.from(r.ciphertext).toString('base64'),
          msgType:    r.msgType,
          createdAt:  r.createdAt.toISOString(),
        })),
      })
    },
  )

  // ───── POST /api/secret/ack — удалить доставленные конверты (только свои) ─────
  app.post(
    '/secret/ack',
    {
      preHandler: app.authenticate,
      schema: {
        body: SecretAckRequestSchema,
        response: { 204: z.null(), 401: ErrorBodySchema },
      },
    },
    async (req, reply) => {
      const me = req.authUser!.id
      await db
        .delete(secretEnvelopes)
        .where(and(eq(secretEnvelopes.toUserId, me), inArray(secretEnvelopes.id, req.body.ids)))
      return reply.code(204).send(null)
    },
  )
}
