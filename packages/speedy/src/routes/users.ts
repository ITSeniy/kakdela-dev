import { and, desc, eq, inArray, or } from 'drizzle-orm'
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod'
import { z } from 'zod'

import {
  ErrorBodySchema,
  PatchMeRequestSchema,
  UserProfileSchema,
  UserSchema,
  type SharedServer,
} from '@kakdela/ginzu/api-types'

import { dmChannels, memberRoles, serverMembers, serverRoles, servers, users } from '../db/schema.js'
import { db } from '../lib/db.js'
import { forbidden, notFound } from '../lib/permissions.js'
import { presence } from '../presence/store.js'
import { broadcastToServer, broadcastToUser } from '../ws/broadcast.js'

function publicUser(row: typeof users.$inferSelect) {
  return {
    id:           row.id,
    username:     row.username,
    displayName:  row.displayName,
    avatarUrl:    row.avatarUrl,
    status:       row.status,
    customStatus: row.customStatus,
  }
}

export const usersRoutes: FastifyPluginAsyncZod = async (app) => {
  // ───── GET /api/users/:id ─────
  //
  // Public profile. Чтобы не превращать сервер в каталог всех аккаунтов,
  // показываем профиль только если у запрашивающего есть **общий контекст**
  // с этим user'ом: общий server (любой) или активный DM-channel. Иначе 404
  // (не 403 — чтобы не палить факт существования).
  app.get(
    '/users/:id',
    {
      preHandler: app.authenticate,
      schema: {
        params: z.object({ id: z.string().uuid() }),
        response: {
          200: UserProfileSchema,
          401: ErrorBodySchema,
          404: ErrorBodySchema,
        },
      },
    },
    async (req, reply) => {
      const me = req.authUser!.id
      const targetId = req.params.id

      const userRows = await db.select().from(users).where(eq(users.id, targetId)).limit(1)
      const target = userRows[0]
      if (!target) throw notFound('user-not-found', 'user not found')

      const isSelf = me === targetId

      // Серверы, в которых есть оба user'а. Делаем JOIN на server_members
      // дважды — отдельно для me и target — и пересекаем по server_id.
      const myMembership = db
        .select({ serverId: serverMembers.serverId })
        .from(serverMembers)
        .where(eq(serverMembers.userId, me))
      const myServerIdsRows = await myMembership
      const myServerIds = myServerIdsRows.map((r) => r.serverId)

      const sharedServerRows = isSelf
        ? await db
            .select({
              serverId: serverMembers.serverId,
              role:     serverMembers.role,
              joinedAt: serverMembers.joinedAt,
              name:     servers.name,
              iconUrl:  servers.iconUrl,
            })
            .from(serverMembers)
            .innerJoin(servers, eq(serverMembers.serverId, servers.id))
            .where(eq(serverMembers.userId, me))
        : myServerIds.length > 0
          ? await db
              .select({
                serverId: serverMembers.serverId,
                role:     serverMembers.role,
                joinedAt: serverMembers.joinedAt,
                name:     servers.name,
                iconUrl:  servers.iconUrl,
              })
              .from(serverMembers)
              .innerJoin(servers, eq(serverMembers.serverId, servers.id))
              .where(and(
                eq(serverMembers.userId, targetId),
                inArray(serverMembers.serverId, myServerIds),
              ))
          : []

      // Дополнительный контекст: активный DM-канал между нами.
      const hasDm = !isSelf && (await db
        .select({ channelId: dmChannels.channelId })
        .from(dmChannels)
        .where(or(
          and(eq(dmChannels.userAId, me), eq(dmChannels.userBId, targetId)),
          and(eq(dmChannels.userAId, targetId), eq(dmChannels.userBId, me)),
        ))
        .limit(1)).length > 0

      if (!isSelf && sharedServerRows.length === 0 && !hasDm) {
        throw notFound('user-not-found', 'user not found')
      }

      const sharedServers: SharedServer[] = sharedServerRows.map((r) => ({
        id:       r.serverId,
        name:     r.name,
        iconUrl:  r.iconUrl ?? null,
        role:     r.role,
        joinedAt: r.joinedAt.toISOString(),
      }))

      // Кастомные роли target'а — только по общим (видимым requester'у) серверам.
      const visibleServerIds = sharedServers.map((s) => s.id)
      const roleRows = visibleServerIds.length > 0
        ? await db
            .select({
              id:       serverRoles.id,
              name:     serverRoles.name,
              color:    serverRoles.color,
              position: serverRoles.position,
              hoist:    serverRoles.hoist,
            })
            .from(memberRoles)
            .innerJoin(serverRoles, eq(memberRoles.roleId, serverRoles.id))
            .where(and(
              eq(memberRoles.userId, targetId),
              inArray(memberRoles.serverId, visibleServerIds),
            ))
            .orderBy(desc(serverRoles.position))
        : []
      const roles = roleRows.map((r) => ({
        id: r.id, name: r.name, color: r.color, position: r.position, hoist: r.hoist,
      }))

      // Live presence overlay.
      const liveStatus = (await presence.getStatusBulk([target.id])).get(target.id)?.status ?? target.status

      return reply.code(200).send({
        id:            target.id,
        username:      target.username,
        displayName:   target.displayName,
        avatarUrl:     target.avatarUrl,
        customStatus:  target.customStatus ?? null,
        status:        liveStatus,
        about:         target.about ?? null,
        timezone:      target.timezone ?? null,
        birthday:      target.birthday ?? null,
        bannerUrl:     target.bannerUrl ?? null,
        createdAt:     target.createdAt.toISOString(),
        sharedServers,
        roles,
        isSelf,
      })
    },
  )

  // ───── PATCH /api/me ─────
  //
  // Обновление *своего* профиля. Username и email менять нельзя — это
  // identity. Смена пароля вынесена в POST /api/auth/password: там она
  // заодно перевыпускает сессию вызывающего устройства, чтобы оно не
  // разлогинилось (T-068).
  app.patch(
    '/me',
    {
      preHandler: app.authenticate,
      schema: {
        body: PatchMeRequestSchema,
        response: {
          200: UserSchema,
          400: ErrorBodySchema,
          401: ErrorBodySchema,
        },
      },
    },
    async (req, reply) => {
      const userId = req.authUser!.id
      const body = req.body

      const userRows = await db.select().from(users).where(eq(users.id, userId)).limit(1)
      const user = userRows[0]
      if (!user) throw forbidden('user not found')

      // Пароль меняется отдельным эндпоинтом (POST /api/auth/password):
      // только там можно корректно перевыпустить сессию вызывающему.
      if (body.newPassword !== undefined || body.currentPassword !== undefined) {
        return reply.code(400).send({
          error: { code: 'use-password-endpoint', message: 'change password via POST /api/auth/password' },
        })
      }

      const updates: Partial<typeof users.$inferInsert> = {}
      if (body.displayName !== undefined)  updates.displayName  = body.displayName
      if (body.customStatus !== undefined) updates.customStatus = body.customStatus
      if (body.avatarUrl !== undefined)    updates.avatarUrl    = body.avatarUrl
      if (body.about !== undefined)        updates.about        = body.about
      if (body.timezone !== undefined)     updates.timezone     = body.timezone
      if (body.birthday !== undefined) {
        // Формат MM-DD проверила Zod-схема; здесь — валидность дня в месяце
        // (високальное 02-29 разрешаем: сработает в невисокосный год 1 марта).
        if (body.birthday !== null) {
          const [mm, dd] = body.birthday.split('-').map(Number)
          const daysInMonth = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
          if (!mm || !dd || dd > (daysInMonth[mm - 1] ?? 0)) {
            return reply.code(400).send({ error: { code: 'bad-birthday', message: 'invalid day for month' } })
          }
        }
        updates.birthday = body.birthday
      }
      if (body.bannerUrl !== undefined)    updates.bannerUrl    = body.bannerUrl

      if (Object.keys(updates).length > 0) {
        await db.update(users).set(updates).where(eq(users.id, userId))
      }

      const freshRows = await db.select().from(users).where(eq(users.id, userId)).limit(1)
      const fresh = freshRows[0]
      if (!fresh) throw new Error('user disappeared after update')

      // WS broadcast — серверам, где user состоит, плюс точечно себе
      // (для других своих сессий/устройств).
      const memberships = await db
        .select({ serverId: serverMembers.serverId })
        .from(serverMembers)
        .where(eq(serverMembers.userId, userId))
      const event = {
        t: 'user.update' as const,
        userId,
        displayName:  fresh.displayName,
        avatarUrl:    fresh.avatarUrl,
        customStatus: fresh.customStatus ?? null,
      }
      for (const m of memberships) void broadcastToServer(m.serverId, event)
      void broadcastToUser(userId, event)

      return reply.code(200).send(publicUser(fresh))
    },
  )
}
