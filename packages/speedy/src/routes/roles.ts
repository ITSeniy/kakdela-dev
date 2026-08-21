// Система ролей: CRUD ролей + назначение участникам. Защита иерархии (нельзя
// трогать роль/участника выше своей позиции) и от эскалации привилегий (нельзя
// выдать роли право, которого у тебя самого нет — кроме ADMINISTRATOR/owner).

import { and, eq, inArray, max } from 'drizzle-orm'
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod'
import { z } from 'zod'

import {
  CreateRoleRequestSchema,
  ErrorBodySchema,
  PatchRoleRequestSchema,
  RoleSchema,
  RolesListResponseSchema,
  SetMemberRolesRequestSchema,
} from '@kakdela/ginzu/api-types'
import { hasPermission, sanitizePermissions } from '@kakdela/ginzu/permissions'

import { memberRoles, serverRoles } from '../db/schema.js'
import { audit } from '../lib/audit.js'
import { db } from '../lib/db.js'
import {
  assertMember,
  assertPermission,
  canActOnMember,
  canManageRolePosition,
  forbidden,
  getMemberPermissions,
  notFound,
} from '../lib/permissions.js'
import { listServerRoles, serializeRole } from '../lib/roles.js'
import { broadcastToServer } from '../ws/broadcast.js'

/** Нельзя выдать роли право, которого нет у тебя (ADMINISTRATOR обходит). */
function assertNoEscalation(actorMask: number, requested: number): void {
  if (hasPermission(actorMask, 'ADMINISTRATOR')) return
  if ((requested & ~actorMask) !== 0) {
    throw forbidden('нельзя выдать роли право, которого нет у вас')
  }
}

async function loadRole(roleId: string) {
  const rows = await db.select().from(serverRoles).where(eq(serverRoles.id, roleId)).limit(1)
  const role = rows[0]
  if (!role) throw notFound('role-not-found', 'role not found')
  return role
}

export const rolesRoutes: FastifyPluginAsyncZod = async (app) => {
  // ───── GET /api/servers/:serverId/roles ─────
  app.get(
    '/servers/:serverId/roles',
    {
      preHandler: app.authenticate,
      schema: {
        params: z.object({ serverId: z.string().uuid() }),
        response: { 200: RolesListResponseSchema, 401: ErrorBodySchema, 403: ErrorBodySchema },
      },
    },
    async (req, reply) => {
      const { serverId } = req.params
      await assertMember(req.authUser!.id, serverId)
      return reply.code(200).send({ roles: await listServerRoles(serverId) })
    },
  )

  // ───── POST /api/servers/:serverId/roles ─────
  app.post(
    '/servers/:serverId/roles',
    {
      preHandler: app.authenticate,
      schema: {
        params: z.object({ serverId: z.string().uuid() }),
        body: CreateRoleRequestSchema,
        response: { 201: RoleSchema, 401: ErrorBodySchema, 403: ErrorBodySchema },
      },
    },
    async (req, reply) => {
      const { serverId } = req.params
      const userId = req.authUser!.id
      const ctx = await assertPermission(userId, serverId, 'MANAGE_ROLES')

      const perms = sanitizePermissions(req.body.permissions ?? 0)
      assertNoEscalation(ctx.permissions, perms)

      // Новая роль — над всеми кастомными, но строго ниже актора по иерархии.
      const maxRows = await db
        .select({ m: max(serverRoles.position) })
        .from(serverRoles)
        .where(eq(serverRoles.serverId, serverId))
      const position = (maxRows[0]?.m ?? 0) + 1
      if (!canManageRolePosition(ctx, position)) {
        throw forbidden('нельзя создать роль выше своей')
      }

      const inserted = await db
        .insert(serverRoles)
        .values({
          serverId,
          name:        req.body.name,
          color:       req.body.color ?? null,
          permissions: perms,
          position,
          hoist:       req.body.hoist ?? false,
          mentionable: req.body.mentionable ?? false,
        })
        .returning()
      const role = inserted[0]!
      audit.log({
        serverId,
        actorId:    userId,
        action:     'role.create',
        targetType: 'role',
        targetId:   role.id,
        metadata:   { name: role.name, permissions: perms },
      })
      void broadcastToServer(serverId, { t: 'role.update', serverId })
      return reply.code(201).send(serializeRole(role))
    },
  )

  // ───── PATCH /api/roles/:roleId ─────
  app.patch(
    '/roles/:roleId',
    {
      preHandler: app.authenticate,
      schema: {
        params: z.object({ roleId: z.string().uuid() }),
        body: PatchRoleRequestSchema,
        response: { 200: RoleSchema, 401: ErrorBodySchema, 403: ErrorBodySchema, 404: ErrorBodySchema },
      },
    },
    async (req, reply) => {
      const userId = req.authUser!.id
      const role = await loadRole(req.params.roleId)
      const ctx = await assertPermission(userId, role.serverId, 'MANAGE_ROLES')

      // Иерархия: нельзя редактировать роль не ниже своей.
      if (!canManageRolePosition(ctx, role.position)) throw forbidden('эта роль выше вашей')

      const b = req.body
      const updates: Partial<typeof serverRoles.$inferInsert> = {}

      if (role.isEveryone) {
        // @everyone: меняем только права (имя/позиция/hoist/color/удаление — нет).
        if (b.name !== undefined || b.position !== undefined || b.hoist !== undefined) {
          throw forbidden('базовую роль @everyone нельзя переименовать или переместить')
        }
      } else {
        if (b.name !== undefined) updates.name = b.name
        if (b.color !== undefined) updates.color = b.color
        if (b.hoist !== undefined) updates.hoist = b.hoist
        if (b.mentionable !== undefined) updates.mentionable = b.mentionable
        if (b.position !== undefined) {
          if (b.position <= 0) throw forbidden('позиция должна быть выше @everyone')
          if (!canManageRolePosition(ctx, b.position)) throw forbidden('нельзя поднять роль выше своей')
          updates.position = b.position
        }
      }
      if (b.permissions !== undefined) {
        const perms = sanitizePermissions(b.permissions)
        assertNoEscalation(ctx.permissions, perms)
        updates.permissions = perms
      }

      const updated = await db.update(serverRoles).set(updates).where(eq(serverRoles.id, role.id)).returning()
      audit.log({
        serverId:   role.serverId,
        actorId:    userId,
        action:     'role.update',
        targetType: 'role',
        targetId:   role.id,
        metadata:   { name: role.name, changed: Object.keys(updates) },
      })
      void broadcastToServer(role.serverId, { t: 'role.update', serverId: role.serverId })
      return reply.code(200).send(serializeRole(updated[0]!))
    },
  )

  // ───── DELETE /api/roles/:roleId ─────
  app.delete(
    '/roles/:roleId',
    {
      preHandler: app.authenticate,
      schema: {
        params: z.object({ roleId: z.string().uuid() }),
        response: { 204: z.null(), 401: ErrorBodySchema, 403: ErrorBodySchema, 404: ErrorBodySchema },
      },
    },
    async (req, reply) => {
      const userId = req.authUser!.id
      const role = await loadRole(req.params.roleId)
      const ctx = await assertPermission(userId, role.serverId, 'MANAGE_ROLES')
      if (role.isEveryone) throw forbidden('базовую роль @everyone нельзя удалить')
      if (!canManageRolePosition(ctx, role.position)) throw forbidden('эта роль выше вашей')

      await db.delete(serverRoles).where(eq(serverRoles.id, role.id)) // assignments — cascade
      audit.log({
        serverId:   role.serverId,
        actorId:    userId,
        action:     'role.delete',
        targetType: 'role',
        targetId:   role.id,
        metadata:   { name: role.name },
      })
      void broadcastToServer(role.serverId, { t: 'role.update', serverId: role.serverId })
      return reply.code(204).send(null)
    },
  )

  // ───── PUT /api/servers/:serverId/members/:userId/roles ─────
  // Полностью задаёт набор кастомных ролей участника (idempotent).
  app.put(
    '/servers/:serverId/members/:userId/roles',
    {
      preHandler: app.authenticate,
      schema: {
        params: z.object({ serverId: z.string().uuid(), userId: z.string().uuid() }),
        body: SetMemberRolesRequestSchema,
        response: { 204: z.null(), 401: ErrorBodySchema, 403: ErrorBodySchema, 404: ErrorBodySchema },
      },
    },
    async (req, reply) => {
      const actorId = req.authUser!.id
      const { serverId, userId: targetId } = req.params
      const ctx = await assertPermission(actorId, serverId, 'MANAGE_ROLES')

      const target = await getMemberPermissions(targetId, serverId) // бросит forbidden, если не член
      if (!canActOnMember(ctx, target) && actorId !== targetId) {
        throw forbidden('нельзя менять роли участника не ниже вас')
      }

      // Валидируем целевые роли: принадлежат серверу, не @everyone, ниже актора.
      const requested = [...new Set(req.body.roleIds)]
      const roleRows = requested.length > 0
        ? await db.select().from(serverRoles).where(and(eq(serverRoles.serverId, serverId), inArray(serverRoles.id, requested)))
        : []
      if (roleRows.length !== requested.length) throw notFound('role-not-found', 'one or more roles not found')
      for (const r of roleRows) {
        if (r.isEveryone) throw forbidden('@everyone назначается автоматически')
        if (!canManageRolePosition(ctx, r.position)) throw forbidden('нельзя назначить роль не ниже вашей')
      }

      // Текущие назначения, которыми актор НЕ вправе управлять (выше него), —
      // сохраняем как есть; меняем только управляемое подмножество.
      const current = await db
        .select({ roleId: memberRoles.roleId, position: serverRoles.position })
        .from(memberRoles)
        .innerJoin(serverRoles, eq(memberRoles.roleId, serverRoles.id))
        .where(and(eq(memberRoles.serverId, serverId), eq(memberRoles.userId, targetId)))
      const lockedKeep = current.filter((c) => !canManageRolePosition(ctx, c.position)).map((c) => c.roleId)

      const finalSet = new Set<string>([...lockedKeep, ...requested])

      await db.transaction(async (tx) => {
        await tx.delete(memberRoles).where(and(eq(memberRoles.serverId, serverId), eq(memberRoles.userId, targetId)))
        if (finalSet.size > 0) {
          await tx.insert(memberRoles).values([...finalSet].map((roleId) => ({ serverId, userId: targetId, roleId })))
        }
      })

      audit.log({
        serverId,
        actorId,
        action:     'member.role.set',
        targetType: 'user',
        targetId,
        metadata:   { roleIds: [...finalSet] },
      })

      void broadcastToServer(serverId, { t: 'member.roles', serverId, userId: targetId })
      return reply.code(204).send(null)
    },
  )
}
