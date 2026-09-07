import type { DbExecutor } from '../lib/db.js'
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod'
import { and, eq, gt, isNull, lt, or, sql } from 'drizzle-orm'
import { z } from 'zod'

import {
  AuthResponseSchema,
  ErrorBodySchema,
  LoginRequestSchema,
  RefreshRequestSchema,
  RegisterRequestSchema,
  UserSchema,
} from '@kakdela/ginzu/api-types'

import { hashPassword, verifyAgainstFakeHash, verifyPassword } from '../auth/passwords.js'
import {
  hashRefreshToken,
  issueAccessToken,
  issueRefreshToken,
  verifyRefreshToken,
} from '../auth/tokens.js'
import { db } from '../lib/db.js'
import { invites, serverMembers, sessions, users } from '../db/schema.js'
import { env } from '../env.js'
import { broadcastToServer } from '../ws/broadcast.js'

const REFRESH_COOKIE = 'kd_refresh'

type DbUser = typeof users.$inferSelect

function publicUser(row: DbUser) {
  return {
    id: row.id,
    username: row.username,
    displayName: row.displayName,
    avatarUrl: row.avatarUrl,
    status: row.status,
    customStatus: row.customStatus,
  }
}

function refreshCookieOptions(expiresAt: Date) {
  return {
    path: '/api/auth',
    httpOnly: true,
    sameSite: 'strict' as const,
    secure: env.NODE_ENV === 'production',
    expires: expiresAt,
  }
}

function clientMeta(req: { ip: string; headers: Record<string, string | string[] | undefined> }) {
  const ua = req.headers['user-agent']
  return {
    ipAddress: req.ip,
    userAgent: typeof ua === 'string' ? ua.slice(0, 512) : null,
  }
}

/**
 * Нативный Tauri-клиент (desktop/mobile). Его WebView живёт на
 * tauri.localhost — кросс-сайт к API, SameSite=Strict cookie туда не
 * отправляется (а Android WebView third-party cookie и не сохранит). Таким
 * клиентам refresh-токен отдаём в body, web-клиенту — только httpOnly-cookie.
 */
function isNativeClient(req: { headers: Record<string, string | string[] | undefined> }): boolean {
  return req.headers['x-kd-client'] === 'tauri'
}

async function issueSession(userId: string, ipAddress: string, userAgent: string | null, database: DbExecutor = db) {
  const accessToken = await issueAccessToken(userId)
  const refresh = await issueRefreshToken(userId)
  await database.insert(sessions).values({
    userId,
    refreshTokenHash: refresh.hash,
    expiresAt: refresh.expiresAt,
    ipAddress,
    userAgent,
  })
  return { accessToken, refresh }
}

export const authRoutes: FastifyPluginAsyncZod = async (app) => {
  // ───── POST /api/auth/register ─────
  app.post(
    '/auth/register',
    {
      config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
      schema: {
        body: RegisterRequestSchema,
        response: {
          200: AuthResponseSchema,
          400: ErrorBodySchema,
          409: ErrorBodySchema,
        },
      },
    },
    async (req, reply) => {
      const { inviteCode: rawCode, username, displayName, email, password } = req.body
      const inviteCode = rawCode.toLowerCase().replace(/[^a-z0-9]/g, '')

      const passwordHash = await hashPassword(password)
      const { ipAddress, userAgent } = clientMeta(req)
      const result = await db.transaction(async (tx) => {
        const [invite] = await tx.update(invites).set({ useCount: sql`${invites.useCount} + 1` })
          .where(and(eq(invites.code, inviteCode), eq(invites.revoked, false),
            or(isNull(invites.expiresAt), gt(invites.expiresAt, sql`NOW()`)),
            or(isNull(invites.maxUses), lt(invites.useCount, invites.maxUses)))).returning({ serverId: invites.serverId })
        if (!invite) throw Object.assign(new Error('invite is expired, revoked, exhausted or missing'), { statusCode: 400, code: 'invite-expired' })
        const [inserted] = await tx.insert(users).values({ username, displayName: displayName ?? username, email, passwordHash }).returning()
        if (!inserted) throw new Error('insert into users returned no rows')
        const [member] = await tx.insert(serverMembers).values({ serverId: invite.serverId, userId: inserted.id })
          .returning({ role: serverMembers.role, joinedAt: serverMembers.joinedAt })
        const session = await issueSession(inserted.id, ipAddress, userAgent, tx)
        return { inserted, invite, member, ...session }
      }).catch((err: unknown) => {
        const cause = err as { message?: string; constraint_name?: string; cause?: { message?: string; constraint_name?: string } }
        const detail = [cause.message, cause.constraint_name, cause.cause?.message, cause.cause?.constraint_name].join(' ')
        if (detail.includes('users_username_unique')) throw Object.assign(new Error('username already in use'), { statusCode: 409, code: 'username-taken' })
        if (detail.includes('users_email_unique')) throw Object.assign(new Error('email already in use'), { statusCode: 409, code: 'email-taken' })
        throw err
      })
      const { inserted, accessToken, refresh, invite, member } = result
      if (member) void broadcastToServer(invite.serverId, { t: 'member.join', member: {
        serverId: invite.serverId, userId: inserted.id, role: member.role, joinedAt: member.joinedAt.toISOString(),
      } })

      void reply.setCookie(REFRESH_COOKIE, refresh.token, refreshCookieOptions(refresh.expiresAt))
      return reply.code(200).send({
        accessToken,
        user: publicUser(inserted),
        ...(isNativeClient(req) ? { refreshToken: refresh.token } : {}),
      })
    },
  )

  // ───── POST /api/auth/login ─────
  app.post(
    '/auth/login',
    {
      config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
      schema: {
        body: LoginRequestSchema,
        response: {
          200: AuthResponseSchema,
          401: ErrorBodySchema,
        },
      },
    },
    async (req, reply) => {
      const { email, password } = req.body
      const rows = await db.select().from(users).where(eq(users.email, email)).limit(1)
      const user = rows[0]

      if (!user) {
        // Чтобы тайминг был тот же, что и для неверного пароля,
        // всегда выполняем argon2.verify хотя бы один раз.
        await verifyAgainstFakeHash(password)
        return reply.code(401).send({ error: { code: 'invalid-credentials', message: 'invalid email or password' } })
      }

      const ok = await verifyPassword(user.passwordHash, password)
      if (!ok) {
        return reply.code(401).send({ error: { code: 'invalid-credentials', message: 'invalid email or password' } })
      }

      const { ipAddress, userAgent } = clientMeta(req)
      const { accessToken, refresh } = await issueSession(user.id, ipAddress, userAgent)

      void reply.setCookie(REFRESH_COOKIE, refresh.token, refreshCookieOptions(refresh.expiresAt))
      return reply.code(200).send({
        accessToken,
        user: publicUser(user),
        ...(isNativeClient(req) ? { refreshToken: refresh.token } : {}),
      })
    },
  )

  // ───── POST /api/auth/password ─────
  //
  // Смена пароля (T-068). Текущий пароль проверяем, хеш обновляем, ВСЕ
  // старые сессии сгорают — но вызывающему устройству сразу выдаём свежую
  // сессию: оно остаётся залогиненным, прочие устройства честно
  // разлогиниваются. Раньше удалялись все сессии без замены, и устройство,
  // сменившее пароль, вылетало через 15 минут по истечении access-токена.
  app.post(
    '/auth/password',
    {
      preHandler: app.authenticate,
      config: { rateLimit: { max: 5, timeWindow: '1 minute' } },
      schema: {
        body: z.object({
          currentPassword: z.string().min(1),
          newPassword: z.string().min(6),
        }),
        response: {
          200: AuthResponseSchema,
          400: ErrorBodySchema,
          401: ErrorBodySchema,
        },
      },
    },
    async (req, reply) => {
      const userId = req.authUser!.id
      const rows = await db.select().from(users).where(eq(users.id, userId)).limit(1)
      const user = rows[0]
      if (!user) {
        return reply.code(401).send({ error: { code: 'unauthorized', message: 'missing bearer token' } })
      }

      const ok = await verifyPassword(user.passwordHash, req.body.currentPassword)
      if (!ok) {
        return reply.code(400).send({ error: { code: 'invalid-current-password', message: 'invalid current password' } })
      }

      const newHash = await hashPassword(req.body.newPassword)
      await db.update(users).set({ passwordHash: newHash }).where(eq(users.id, userId))

      // Старые refresh-токены не переживают смену пароля...
      await db.delete(sessions).where(eq(sessions.userId, userId))
      // ...а это устройство получает новую сессию прямо в ответе.
      const { ipAddress, userAgent } = clientMeta(req)
      const { accessToken, refresh } = await issueSession(userId, ipAddress, userAgent)

      void reply.setCookie(REFRESH_COOKIE, refresh.token, refreshCookieOptions(refresh.expiresAt))
      return reply.code(200).send({
        accessToken,
        user: publicUser(user),
        ...(isNativeClient(req) ? { refreshToken: refresh.token } : {}),
      })
    },
  )

  // ───── POST /api/auth/refresh ─────
  app.post(
    '/auth/refresh',
    {
      schema: {
        body: RefreshRequestSchema.nullish(),
        response: {
          200: AuthResponseSchema,
          401: ErrorBodySchema,
        },
      },
    },
    async (req, reply) => {
      const cookieToken = req.cookies[REFRESH_COOKIE]
      const bodyToken = req.body?.refreshToken
      const token = cookieToken ?? bodyToken
      if (!token) {
        return reply.code(401).send({ error: { code: 'unauthorized', message: 'no refresh token' } })
      }

      const verified = await verifyRefreshToken(token)
      if (!verified.ok) {
        return reply.code(401).send({ error: { code: verified.reason, message: verified.reason } })
      }

      const tokenHash = hashRefreshToken(token)
      const { ipAddress, userAgent } = clientMeta(req)
      const { user, accessToken, refresh } = await db.transaction(async (tx) => {
        const [old] = await tx.delete(sessions).where(and(
          eq(sessions.refreshTokenHash, tokenHash), eq(sessions.userId, verified.payload.sub), gt(sessions.expiresAt, new Date()),
        )).returning({ id: sessions.id })
        if (!old) throw Object.assign(new Error('session no longer valid'), { statusCode: 401, code: 'session-revoked' })
        const [user] = await tx.select().from(users).where(eq(users.id, verified.payload.sub)).limit(1)
        if (!user) throw Object.assign(new Error('user gone'), { statusCode: 401, code: 'unauthorized' })
        return { user, ...await issueSession(user.id, ipAddress, userAgent, tx) }
      })

      void reply.setCookie(REFRESH_COOKIE, refresh.token, refreshCookieOptions(refresh.expiresAt))
      return reply.code(200).send({
        accessToken,
        user: publicUser(user),
        ...(isNativeClient(req) ? { refreshToken: refresh.token } : {}),
      })
    },
  )

  // ───── POST /api/auth/logout ─────
  app.post(
    '/auth/logout',
    {
      schema: {
        body: RefreshRequestSchema.nullish(),
        response: { 204: z.null() },
      },
    },
    async (req, reply) => {
      // Нативные клиенты держат refresh в body (cookie у них нет — см.
      // isNativeClient); web — в httpOnly-cookie.
      const token = req.cookies[REFRESH_COOKIE] ?? req.body?.refreshToken
      if (token) {
        const tokenHash = hashRefreshToken(token)
        await db.delete(sessions).where(eq(sessions.refreshTokenHash, tokenHash))
      }
      void reply.clearCookie(REFRESH_COOKIE, { path: '/api/auth' })
      return reply.code(204).send(null)
    },
  )

  // ───── GET /api/auth/me ─────
  app.get(
    '/auth/me',
    {
      preHandler: app.authenticate,
      schema: {
        response: {
          200: UserSchema,
          401: ErrorBodySchema,
        },
      },
    },
    async (req, reply) => {
      const userId = req.authUser?.id
      if (!userId) {
        return reply.code(401).send({ error: { code: 'unauthorized', message: 'not authenticated' } })
      }
      const rows = await db.select().from(users).where(eq(users.id, userId)).limit(1)
      const user = rows[0]
      if (!user) {
        return reply.code(401).send({ error: { code: 'unauthorized', message: 'user gone' } })
      }
      return reply.code(200).send(publicUser(user))
    },
  )
}
