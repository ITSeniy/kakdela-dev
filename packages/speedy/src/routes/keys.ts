import { and, eq, isNull, sql } from 'drizzle-orm'
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod'
import { z } from 'zod'

import {
  ErrorBodySchema,
  PrekeyBundleResponseSchema,
  PrekeyCountResponseSchema,
  PublishKeysRequestSchema,
  TopupPrekeysRequestSchema,
} from '@kakdela/ginzu/api-types'

import { secretIdentities, secretOneTimePrekeys } from '../db/schema.js'
import { db } from '../lib/db.js'
import { notFound } from '../lib/permissions.js'

// Слепой каталог ключей (T-101). Сервер хранит и отдаёт ТОЛЬКО публичные ключи;
// приватных он не видит и расшифровать ничего не может. Доступ — как у DM:
// аутентифицирован = может получить чужой бандл (all-friends-by-default,
// см. routes/dm.ts).
export const keysRoutes: FastifyPluginAsyncZod = async (app) => {
  // ───── POST /api/keys/bundle — опубликовать свой публичный бандл ─────
  app.post(
    '/keys/bundle',
    {
      preHandler: app.authenticate,
      config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
      schema: {
        body: PublishKeysRequestSchema,
        response: { 204: z.null(), 401: ErrorBodySchema },
      },
    },
    async (req, reply) => {
      const userId = req.authUser!.id
      const body = req.body

      const identityValues = {
        identityKey:     body.identityKey,
        registrationId:  body.registrationId,
        signedPreKeyId:  body.signedPrekey.keyId,
        signedPreKey:    body.signedPrekey.pubKey,
        signedPreKeySig: body.signedPrekey.signature,
        kyberPreKeyId:   body.kyberPrekey.keyId,
        kyberPreKey:     body.kyberPrekey.pubKey,
        kyberPreKeySig:  body.kyberPrekey.signature,
        updatedAt:       new Date(),
      }
      await db.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${'keys:' + userId}, 0))`)
      const [previous] = await tx.select().from(secretIdentities).where(eq(secretIdentities.userId, userId)).limit(1)
      if (previous && previous.identityKey !== body.identityKey) {
        await tx.delete(secretOneTimePrekeys).where(eq(secretOneTimePrekeys.userId, userId))
      }
      await tx
        .insert(secretIdentities)
        .values({ userId, ...identityValues })
        .onConflictDoUpdate({ target: secretIdentities.userId, set: identityValues })

      if (body.oneTimePrekeys.length > 0) {
        await tx
          .insert(secretOneTimePrekeys)
          .values(body.oneTimePrekeys.map((k) => ({ userId, keyId: k.keyId, pubKey: k.pubKey })))
          .onConflictDoNothing()
      }
      })

      return reply.code(204).send(null)
    },
  )

  // ───── POST /api/keys/topup — долить одноразовые prekey'и ─────
  app.post(
    '/keys/topup',
    {
      preHandler: app.authenticate,
      config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
      schema: {
        body: TopupPrekeysRequestSchema,
        response: { 204: z.null(), 401: ErrorBodySchema },
      },
    },
    async (req, reply) => {
      const userId = req.authUser!.id
      await db.transaction(async (tx) => {
        await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${'keys:' + userId}, 0))`)
        const [identity] = await tx.select().from(secretIdentities).where(eq(secretIdentities.userId, userId)).limit(1)
        if (!identity || identity.identityKey !== req.body.identityKey) {
          throw Object.assign(new Error('publish the current identity before topping up'), { statusCode: 409, code: 'identity-changed' })
        }
        await tx.insert(secretOneTimePrekeys)
          .values(req.body.oneTimePrekeys.map((k) => ({ userId, keyId: k.keyId, pubKey: k.pubKey })))
          .onConflictDoNothing()
      })
      return reply.code(204).send(null)
    },
  )

  // ───── GET /api/keys/count — остаток своих неиспользованных one-time ─────
  app.get(
    '/keys/count',
    {
      preHandler: app.authenticate,
      schema: { response: { 200: PrekeyCountResponseSchema, 401: ErrorBodySchema } },
    },
    async (req, reply) => {
      const userId = req.authUser!.id
      const rows = await db
        .select({ count: sql<number>`COUNT(*)::int` })
        .from(secretOneTimePrekeys)
        .where(and(eq(secretOneTimePrekeys.userId, userId), isNull(secretOneTimePrekeys.consumedAt)))
      const [identity] = await db.select({ key: secretIdentities.identityKey }).from(secretIdentities).where(eq(secretIdentities.userId, userId)).limit(1)
      return reply.code(200).send({ oneTimePrekeys: rows[0]?.count ?? 0, identityKey: identity?.key ?? null })
    },
  )

  // ───── GET /api/keys/:userId/bundle — бандл для старта X3DH-сессии ─────
  // Атомарно выдаёт и помечает consumed один одноразовый prekey адресата.
  app.get(
    '/keys/:userId/bundle',
    {
      preHandler: app.authenticate,
      // Каждый запрос поглощает один one-time prekey получателя: без лимита
      // любой аутентифицированный может циклично опустошить OTP-пул жертвы
      // (деградация forward secrecy). 20/мин хватает на любые легитимные
      // старты сессий, клиент сам топапит пул.
      config: { rateLimit: { max: 20, timeWindow: '1 minute' } },
      schema: {
        params: z.object({ userId: z.string().uuid() }),
        response: { 200: PrekeyBundleResponseSchema, 401: ErrorBodySchema, 404: ErrorBodySchema },
      },
    },
    async (req, reply) => {
      const target = req.params.userId

      const { identity, otp } = await db.transaction(async (tx) => {
        await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${'keys:' + target}, 0))`)
        const [identity] = await tx.select().from(secretIdentities).where(eq(secretIdentities.userId, target)).limit(1)
        if (!identity) throw notFound('keys-not-found', 'user has no published keys')
        const rows = await tx
          .select({ keyId: secretOneTimePrekeys.keyId, pubKey: secretOneTimePrekeys.pubKey })
          .from(secretOneTimePrekeys)
          .where(and(eq(secretOneTimePrekeys.userId, target), isNull(secretOneTimePrekeys.consumedAt)))
          .orderBy(secretOneTimePrekeys.keyId)
          .limit(1)
          .for('update', { skipLocked: true })
        const k = rows[0]
        if (!k) return { identity, otp: null }
        await tx
          .update(secretOneTimePrekeys)
          .set({ consumedAt: new Date() })
          .where(and(eq(secretOneTimePrekeys.userId, target), eq(secretOneTimePrekeys.keyId, k.keyId)))
        return { identity, otp: k }
      })

      return reply.code(200).send({
        userId:         target,
        identityKey:    identity.identityKey,
        registrationId: identity.registrationId,
        signedPrekey: {
          keyId:     identity.signedPreKeyId,
          pubKey:    identity.signedPreKey,
          signature: identity.signedPreKeySig,
        },
        kyberPrekey: {
          keyId:     identity.kyberPreKeyId,
          pubKey:    identity.kyberPreKey,
          signature: identity.kyberPreKeySig,
        },
        oneTimePrekey: otp ? { keyId: otp.keyId, pubKey: otp.pubKey } : null,
      })
    },
  )
}
