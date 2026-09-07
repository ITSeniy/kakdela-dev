import { and, eq, inArray, isNull, sql } from 'drizzle-orm'
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod'
import { z } from 'zod'
import { hasPermission } from '@kakdela/ginzu/permissions'

import {
  ChannelCategorySchema,
  ChannelSchema,
  CreateCategoryRequestSchema,
  CreateChannelRequestSchema,
  CreateServerRequestSchema,
  ErrorBodySchema,
  MemberProfileResponseSchema,
  MemberPublicSchema,
  PatchMemberProfileRequestSchema,
  PatchServerRequestSchema,
  ServerDetailSchema,
  ServerSchema,
  ServerUnreadResponseSchema,
} from '@kakdela/ginzu/api-types'

import { channelCategories, channelReads, channels, memberRoles, serverMembers, serverRoles, servers, users } from '../db/schema.js'
import { audit } from '../lib/audit.js'
import { CHANNEL_DTO_COLS } from '../lib/channel-dto.js'
import { db } from '../lib/db.js'
import { purgeFilesForServer } from '../lib/media-gc.js'
import { finishMemberRevocation } from '../lib/member-revocation.js'
import {
  assertMember,
  assertPermission,
  assertRole,
  canActOnMember,
  forbidden,
  getMemberPermissions,
  notFound,
} from '../lib/permissions.js'
import { loadMemberRoleInfo } from '../lib/roles.js'
import { presence } from '../presence/store.js'
import { attachUserToServer, dropServerSubscriptions, serverChannelIds } from '../ws/attach.js'
import { broadcastToServer } from '../ws/broadcast.js'
import { registry } from '../ws/registry.js'

const STATUS_ORDER: Record<string, number> = { online: 0, idle: 1, dnd: 2, offline: 3 }

export const serversRoutes: FastifyPluginAsyncZod = async (app) => {
  // ───── GET /api/servers ─────
  app.get(
    '/servers',
    {
      preHandler: app.authenticate,
      schema: {
        response: {
          200: z.object({ servers: z.array(ServerSchema) }),
          401: ErrorBodySchema,
        },
      },
    },
    async (req, reply) => {
      const userId = req.authUser!.id

      const rows = await db
        .select({
          id: servers.id,
          name: servers.name,
          iconUrl: servers.iconUrl,
          bannerUrl: servers.bannerUrl,
        })
        .from(serverMembers)
        .innerJoin(servers, eq(serverMembers.serverId, servers.id))
        .where(eq(serverMembers.userId, userId))

      return reply.code(200).send({ servers: rows })
    },
  )

  // ───── POST /api/servers ─────
  //
  // Любой авторизованный юзер может создать сервер. При создании сразу
  // получает роль `owner`, плюс мы заводим два дефолтных канала — #общее
  // (text) и общая комната (voice), чтобы пустой сервер не пугал свежей
  // тишиной. Всё это одной транзакцией: если что-то падает на полпути,
  // мы не оставляем «полу-сервер» без owner'а.
  app.post(
    '/servers',
    {
      preHandler: app.authenticate,
      schema: {
        body: CreateServerRequestSchema,
        response: {
          201: ServerSchema,
          401: ErrorBodySchema,
        },
      },
    },
    async (req, reply) => {
      const userId = req.authUser!.id
      const { name, iconUrl } = req.body

      const server = await db.transaction(async (tx) => {
        const inserted = await tx
          .insert(servers)
          .values({ name, iconUrl: iconUrl ?? null, ownerId: userId })
          .returning({ id: servers.id, name: servers.name, iconUrl: servers.iconUrl })
        const row = inserted[0]
        if (!row) throw new Error('insert into servers returned no rows')

        await tx.insert(serverMembers).values({
          serverId: row.id,
          userId,
          role:     'owner',
        })

        await tx.insert(channels).values([
          { serverId: row.id, name: 'общее',         kind: 'text',  position: 0 },
          { serverId: row.id, name: 'общая комната', kind: 'voice', position: 1 },
        ])

        // Базовая роль @everyone (position 0, нулевые права) — фундамент
        // системы ролей; остальные роли позиционируются выше неё.
        await tx.insert(serverRoles).values({
          serverId: row.id, name: '@everyone', permissions: 0, position: 0, isEveryone: true,
        })

        return row
      })

      // Создатель тоже участник: hot-attach его живых соединений на новый
      // сервер и каналы (аудит 2026-08 M-7) — иначе до реконнекта он не
      // получит ни member.join первого приглашённого, ни presence, ни voice.*.
      await attachUserToServer(userId, server.id)

      return reply.code(201).send({ id: server.id, name: server.name, iconUrl: server.iconUrl ?? null })
    },
  )

  // ───── GET /api/servers/:serverId ─────
  app.get(
    '/servers/:serverId',
    {
      preHandler: app.authenticate,
      schema: {
        params: z.object({ serverId: z.string().uuid() }),
        response: {
          200: ServerDetailSchema,
          401: ErrorBodySchema,
          403: ErrorBodySchema,
          404: ErrorBodySchema,
        },
      },
    },
    async (req, reply) => {
      const { serverId } = req.params
      const userId = req.authUser!.id

      await assertMember(userId, serverId)

      const serverRows = await db
        .select({ id: servers.id, name: servers.name, iconUrl: servers.iconUrl, bannerUrl: servers.bannerUrl })
        .from(servers)
        .where(eq(servers.id, serverId))
        .limit(1)
      const server = serverRows[0]
      if (!server) throw notFound('server-not-found', 'server not found')

      const channelRows = await db
        .select(CHANNEL_DTO_COLS)
        .from(channels)
        .where(eq(channels.serverId, serverId))
        .orderBy(channels.position)

      const countRows = await db
        .select({ count: sql<number>`COUNT(*)::int` })
        .from(serverMembers)
        .where(eq(serverMembers.serverId, serverId))
      const memberCount = countRows[0]?.count ?? 0

      const categoryRows = await db
        .select({ name: channelCategories.name, position: channelCategories.position })
        .from(channelCategories)
        .where(eq(channelCategories.serverId, serverId))
        .orderBy(channelCategories.position)

      // Топ-уровневые каналы: исключаем DM и треды (треды живут отдельно
      // в ThreadPanel и подгружаются через /api/channels/:id/threads).
      return reply.code(200).send({
        server,
        channels: channelRows.filter((c) => c.kind !== 'dm' && c.parentChannelId === null),
        categories: categoryRows,
        memberCount,
      })
    },
  )

  // ───── GET /api/servers/:serverId/members ─────
  app.get(
    '/servers/:serverId/members',
    {
      preHandler: app.authenticate,
      schema: {
        params: z.object({ serverId: z.string().uuid() }),
        response: {
          200: z.object({ members: z.array(MemberPublicSchema) }),
          401: ErrorBodySchema,
          403: ErrorBodySchema,
          404: ErrorBodySchema,
        },
      },
    },
    async (req, reply) => {
      const { serverId } = req.params
      const userId = req.authUser!.id

      await assertMember(userId, serverId)

      const serverExists = await db
        .select({ id: servers.id })
        .from(servers)
        .where(eq(servers.id, serverId))
        .limit(1)
      if (!serverExists[0]) throw notFound('server-not-found', 'server not found')

      const rows = await db
        .select({
          id: users.id,
          displayName: users.displayName,
          username: users.username,
          avatarUrl: users.avatarUrl,
          status: users.status,
          customStatus: users.customStatus,
          birthday: users.birthday,
          role: serverMembers.role,
          nickname: serverMembers.nickname,
          serverAvatarUrl: serverMembers.avatarUrl,
        })
        .from(serverMembers)
        .innerJoin(users, eq(serverMembers.userId, users.id))
        .where(eq(serverMembers.serverId, serverId))

      // Overlay live presence from Redis; fall back to DB column when missing.
      const presenceMap = await presence.getStatusBulk(rows.map((r) => r.id))

      // Роли + эффективные права для каждого участника (bulk, без N запросов).
      const builtinRoles = new Map(rows.map((r) => [r.id, r.role]))
      const roleInfo = await loadMemberRoleInfo(serverId, builtinRoles)

      // displayName/avatarUrl — ЭФФЕКТИВНЫЕ (серверный профиль поверх
      // глобального); сырые override'ы едут отдельными полями для UI.
      const enriched = rows.map((r) => ({
        ...r,
        displayName: r.nickname ?? r.displayName,
        avatarUrl: r.serverAvatarUrl ?? r.avatarUrl,
        status: presenceMap.get(r.id)?.status ?? r.status,
        roles: roleInfo.get(r.id)?.roles ?? [],
        permissions: roleInfo.get(r.id)?.permissions ?? 0,
      }))

      enriched.sort((a, b) => {
        const sa = STATUS_ORDER[a.status] ?? 4
        const sb = STATUS_ORDER[b.status] ?? 4
        if (sa !== sb) return sa - sb
        return a.displayName.localeCompare(b.displayName)
      })

      return reply.code(200).send({ members: enriched })
    },
  )

  // ───── POST /api/servers/:serverId/channels ─────
  app.post(
    '/servers/:serverId/channels',
    {
      preHandler: app.authenticate,
      schema: {
        params: z.object({ serverId: z.string().uuid() }),
        body: CreateChannelRequestSchema,
        response: {
          201: ChannelSchema,
          401: ErrorBodySchema,
          403: ErrorBodySchema,
          404: ErrorBodySchema,
        },
      },
    },
    async (req, reply) => {
      const { serverId } = req.params
      const userId = req.authUser!.id

      await assertPermission(userId, serverId, 'MANAGE_CHANNELS')

      const serverExists = await db
        .select({ id: servers.id })
        .from(servers)
        .where(eq(servers.id, serverId))
        .limit(1)
      if (!serverExists[0]) throw notFound('server-not-found', 'server not found')

      const { name, kind, category, topic } = req.body

      // Категория — отдельная сущность: если канал создаётся с категорией,
      // которой ещё нет в таблице, регистрируем её (в конец списка).
      if (category) {
        const maxCat = await db
          .select({ max: sql<number>`COALESCE(MAX(position), -1)::int` })
          .from(channelCategories)
          .where(eq(channelCategories.serverId, serverId))
        await db
          .insert(channelCategories)
          .values({ serverId, name: category, position: (maxCat[0]?.max ?? -1) + 1 })
          .onConflictDoNothing()
      }

      // Position: next after last channel of same kind
      const maxRows = await db
        .select({ max: sql<number>`COALESCE(MAX(position), -1)::int` })
        .from(channels)
        .where(eq(channels.serverId, serverId))
      const position = (maxRows[0]?.max ?? -1) + 1

      const inserted = await db
        .insert(channels)
        .values({ serverId, name, kind, category: category ?? null, topic: topic ?? null, position })
        .returning(CHANNEL_DTO_COLS)

      const channel = inserted[0]
      if (!channel) throw new Error('insert into channels returned no rows')

      audit.log({
        serverId,
        actorId:    userId,
        action:     'channel.create',
        targetType: 'channel',
        targetId:   channel.id,
        metadata: {
          name:     channel.name,
          kind:     channel.kind,
          category: channel.category,
        },
      })

      // Hot-attach: подписки на каналы выдаются соединению на hello, поэтому
      // уже подключённых участников сервера досубскрайбим вручную — иначе
      // msg.new в новом канале не дойдёт до них до реконнекта (тот же
      // паттерн, что у DM и тредов).
      for (const conn of registry.forServer(serverId)) {
        registry.subscribeChannel(conn, channel.id)
      }
      void broadcastToServer(serverId, { t: 'channel.create', serverId, channel })

      return reply.code(201).send(channel)
    },
  )

  // ───── POST /api/servers/:serverId/categories ─────
  //
  // Категория может существовать пустой — это строка в channel_categories,
  // каналы ссылаются на неё по имени (channels.category).
  app.post(
    '/servers/:serverId/categories',
    {
      preHandler: app.authenticate,
      schema: {
        params: z.object({ serverId: z.string().uuid() }),
        body: CreateCategoryRequestSchema,
        response: {
          201: ChannelCategorySchema,
          401: ErrorBodySchema,
          403: ErrorBodySchema,
          404: ErrorBodySchema,
          409: ErrorBodySchema,
        },
      },
    },
    async (req, reply) => {
      const { serverId } = req.params
      const userId = req.authUser!.id

      await assertPermission(userId, serverId, 'MANAGE_CHANNELS')

      const serverExists = await db
        .select({ id: servers.id })
        .from(servers)
        .where(eq(servers.id, serverId))
        .limit(1)
      if (!serverExists[0]) throw notFound('server-not-found', 'server not found')

      const { name } = req.body

      const maxRows = await db
        .select({ max: sql<number>`COALESCE(MAX(position), -1)::int` })
        .from(channelCategories)
        .where(eq(channelCategories.serverId, serverId))
      const position = (maxRows[0]?.max ?? -1) + 1

      const inserted = await db
        .insert(channelCategories)
        .values({ serverId, name, position })
        .onConflictDoNothing()
        .returning({ name: channelCategories.name, position: channelCategories.position })
      const category = inserted[0]
      if (!category) {
        return reply.code(409).send({
          error: { code: 'category-exists', message: 'category with this name already exists' },
        })
      }

      void broadcastToServer(serverId, { t: 'category.create', serverId, name: category.name })

      return reply.code(201).send(category)
    },
  )

  // ───── DELETE /api/servers/:serverId/categories/:name ─────
  //
  // Каналы категории не удаляются — становятся «без категории».
  app.delete(
    '/servers/:serverId/categories/:name',
    {
      preHandler: app.authenticate,
      schema: {
        params: z.object({
          serverId: z.string().uuid(),
          name: z.string().min(1).max(64),
        }),
        response: {
          204: z.null(),
          401: ErrorBodySchema,
          403: ErrorBodySchema,
          404: ErrorBodySchema,
        },
      },
    },
    async (req, reply) => {
      const { serverId, name } = req.params
      const userId = req.authUser!.id

      await assertRole(userId, serverId, ['owner', 'admin'])

      const deleted = await db.transaction(async (tx) => {
        const rows = await tx
          .delete(channelCategories)
          .where(and(eq(channelCategories.serverId, serverId), eq(channelCategories.name, name)))
          .returning({ name: channelCategories.name })
        if (rows.length === 0) return false
        await tx
          .update(channels)
          .set({ category: null })
          .where(and(eq(channels.serverId, serverId), eq(channels.category, name)))
        return true
      })
      if (!deleted) throw notFound('category-not-found', 'category not found')

      void broadcastToServer(serverId, { t: 'category.delete', serverId, name })

      return reply.code(204).send(null)
    },
  )

  // ───── PATCH /api/servers/:serverId ─────
  //
  // Изменение имени / иконки. Owner/admin only. Owner создаёт `iconUrl`
  // отдельным upload'ом через /api/files и присылает финальный publicUrl.
  app.patch(
    '/servers/:serverId',
    {
      preHandler: app.authenticate,
      schema: {
        params: z.object({ serverId: z.string().uuid() }),
        body: PatchServerRequestSchema,
        response: {
          200: ServerSchema,
          401: ErrorBodySchema,
          403: ErrorBodySchema,
          404: ErrorBodySchema,
        },
      },
    },
    async (req, reply) => {
      const { serverId } = req.params
      const userId = req.authUser!.id
      const { name, iconUrl, bannerUrl } = req.body

      await assertPermission(userId, serverId, 'MANAGE_SERVER')

      const updates: Partial<typeof servers.$inferInsert> = {}
      if (name !== undefined) updates.name = name
      if (iconUrl !== undefined) updates.iconUrl = iconUrl ?? null
      if (bannerUrl !== undefined) updates.bannerUrl = bannerUrl ?? null

      const updated = await db
        .update(servers)
        .set(updates)
        .where(eq(servers.id, serverId))
        .returning({ id: servers.id, name: servers.name, iconUrl: servers.iconUrl, bannerUrl: servers.bannerUrl })
      const server = updated[0]
      if (!server) throw notFound('server-not-found', 'server not found')

      const dto = {
        id: server.id,
        name: server.name,
        iconUrl: server.iconUrl ?? null,
        bannerUrl: server.bannerUrl ?? null,
      }

      void broadcastToServer(serverId, { t: 'server.update', server: dto })

      audit.log({
        serverId,
        actorId:    userId,
        action:     'server.update',
        targetType: 'server',
        targetId:   serverId,
        metadata:   { changed: Object.keys(updates) },
      })

      return reply.code(200).send(dto)
    },
  )

  // ───── DELETE /api/servers/:serverId ─────
  //
  // Удаление — ТОЛЬКО owner. Каскадно сносит channels / members / invites /
  // emoji / audit_log / messages / reactions / mentions / files (FK с
  // `onDelete: 'cascade'`). На клиенте требуем двойной confirm — здесь не
  // ставим лишней защиты, доверяем UI.
  app.delete(
    '/servers/:serverId',
    {
      preHandler: app.authenticate,
      schema: {
        params: z.object({ serverId: z.string().uuid() }),
        response: {
          204: z.null(),
          401: ErrorBodySchema,
          403: ErrorBodySchema,
          404: ErrorBodySchema,
        },
      },
    },
    async (req, reply) => {
      const { serverId } = req.params
      const userId = req.authUser!.id

      await assertRole(userId, serverId, ['owner'])

      // Id каналов нужны ДО каскада (аудит M-9): и для очистки подписок,
      // и для GC файлов — после удаления строк их неоткуда взять.
      const channelIds = await serverChannelIds(serverId)

      // Файлы всех каналов сервера — ДО каскадного удаления (аудит M-6):
      // после него строки files исчезнут, ключи S3-объектов не найти.
      await purgeFilesForServer(serverId, req.log)

      // Событие — пока подписчики ещё в registry; у всех клиентов сервер
      // исчезнет из рельсы без F5, открытый канал закроется.
      void broadcastToServer(serverId, { t: 'server.delete', serverId })

      const result = await db.delete(servers).where(eq(servers.id, serverId)).returning({ id: servers.id })
      if (!result[0]) throw notFound('server-not-found', 'server not found')

      // Подписки всех соединений на несуществующий serverId больше не нужны.
      dropServerSubscriptions(serverId, channelIds)

      // audit_log тоже каскадно удалится — отдельный entry уже не нужен.
      return reply.code(204).send(null)
    },
  )

  // ───── PATCH /api/servers/:serverId/members/me — серверный профиль ─────
  //
  // Per-server ник и аватар (как в Discord). Только своё; null = сброс к
  // глобальному значению. Broadcast member.profile — у всех участников
  // сервера инвалидируется members-кэш.
  app.patch(
    '/servers/:serverId/members/me',
    {
      preHandler: app.authenticate,
      schema: {
        params: z.object({ serverId: z.string().uuid() }),
        body: PatchMemberProfileRequestSchema,
        response: {
          200: MemberProfileResponseSchema,
          401: ErrorBodySchema,
          403: ErrorBodySchema,
        },
      },
    },
    async (req, reply) => {
      const { serverId } = req.params
      const userId = req.authUser!.id

      await assertMember(userId, serverId)

      const updates: Partial<typeof serverMembers.$inferInsert> = {}
      if (req.body.nickname !== undefined)  updates.nickname  = req.body.nickname
      if (req.body.avatarUrl !== undefined) updates.avatarUrl = req.body.avatarUrl

      await db
        .update(serverMembers)
        .set(updates)
        .where(and(eq(serverMembers.serverId, serverId), eq(serverMembers.userId, userId)))

      const freshRows = await db
        .select({ nickname: serverMembers.nickname, avatarUrl: serverMembers.avatarUrl })
        .from(serverMembers)
        .where(and(eq(serverMembers.serverId, serverId), eq(serverMembers.userId, userId)))
        .limit(1)
      const fresh = freshRows[0]
      if (!fresh) throw forbidden('membership disappeared during update')

      void broadcastToServer(serverId, {
        t: 'member.profile',
        serverId,
        userId,
        nickname: fresh.nickname,
        avatarUrl: fresh.avatarUrl,
      })

      return reply.code(200).send({ nickname: fresh.nickname, avatarUrl: fresh.avatarUrl })
    },
  )

  // ───── DELETE /api/servers/:serverId/members/me ─────
  //
  // «Покинуть сервер». Owner не может — он должен либо удалить сервер,
  // либо (в будущем) передать владение. Так что если ты owner — 422.
  app.delete(
    '/servers/:serverId/members/me',
    {
      preHandler: app.authenticate,
      schema: {
        params: z.object({ serverId: z.string().uuid() }),
        response: {
          204: z.null(),
          401: ErrorBodySchema,
          403: ErrorBodySchema,
          422: ErrorBodySchema,
          503: ErrorBodySchema,
        },
      },
    },
    async (req, reply) => {
      const { serverId } = req.params
      const userId = req.authUser!.id

      const { role } = await assertMember(userId, serverId)
      if (role === 'owner') {
        return reply.code(422).send({
          error: {
            code: 'owner-cannot-leave',
            message: 'хозяин не может покинуть сервер — сначала удалите его',
          },
        })
      }

      await db.transaction(async (tx) => {
        const [current] = await tx.select({ role: serverMembers.role }).from(serverMembers)
          .where(and(eq(serverMembers.serverId, serverId), eq(serverMembers.userId, userId))).for('update')
        if (!current) throw forbidden('not a member of this server')
        if (current.role === 'owner') throw Object.assign(new Error('owner cannot leave'), { statusCode: 422, code: 'owner-cannot-leave' })
        await tx.delete(memberRoles).where(and(eq(memberRoles.serverId, serverId), eq(memberRoles.userId, userId)))
        await tx.delete(serverMembers).where(and(eq(serverMembers.serverId, serverId), eq(serverMembers.userId, userId)))
      })
      if (!await finishMemberRevocation(userId, serverId, app.log)) {
        return reply.code(503).send({ error: { code: 'voice-revocation-pending', message: 'Членство удалено; отключение от голосовых комнат будет повторено автоматически.' } })
      }

      return reply.code(204).send(null)
    },
  )

  // ───── DELETE /api/servers/:serverId/members/:userId ─────
  //
  // Выгнать участника. Право KICK_MEMBERS; цель должна быть ниже актора по
  // иерархии (canActOnMember закрывает owner'а и равных). Сносим membership и
  // его кастомные роли; broadcast member.leave — список участников обновится у
  // всех, а у самого изгнанного клиент уведёт его с сервера.
  app.delete(
    '/servers/:serverId/members/:userId',
    {
      preHandler: app.authenticate,
      schema: {
        params: z.object({ serverId: z.string().uuid(), userId: z.string().uuid() }),
        response: {
          204: z.null(),
          401: ErrorBodySchema,
          403: ErrorBodySchema,
          404: ErrorBodySchema,
          503: ErrorBodySchema,
        },
      },
    },
    async (req, reply) => {
      const { serverId, userId: targetId } = req.params
      const actorId = req.authUser!.id

      const ctx = await assertPermission(actorId, serverId, 'KICK_MEMBERS')
      const target = await getMemberPermissions(targetId, serverId) // 403, если не член
      if (!canActOnMember(ctx, target)) {
        throw forbidden('нельзя выгнать этого участника')
      }

      await db.transaction(async (tx) => {
        // Recheck under row locks: a concurrent promotion/transfer must not kick an owner.
        await tx.select({ userId: serverMembers.userId }).from(serverMembers)
          .where(and(eq(serverMembers.serverId, serverId), inArray(serverMembers.userId, [actorId, targetId])))
          .orderBy(serverMembers.userId).for('update')
        const currentActor = await getMemberPermissions(actorId, serverId, tx)
        const currentTarget = await getMemberPermissions(targetId, serverId, tx)
        if (!hasPermission(currentActor.permissions, 'KICK_MEMBERS') || !canActOnMember(currentActor, currentTarget)) throw forbidden('cannot kick this member')
        await tx
          .delete(memberRoles)
          .where(and(eq(memberRoles.serverId, serverId), eq(memberRoles.userId, targetId)))
        await tx
          .delete(serverMembers)
          .where(and(eq(serverMembers.serverId, serverId), eq(serverMembers.userId, targetId)))
      })

      audit.log({
        serverId,
        actorId,
        action:     'member.kick',
        targetType: 'user',
        targetId,
        metadata:   {},
      })

      if (!await finishMemberRevocation(targetId, serverId, app.log)) {
        return reply.code(503).send({ error: { code: 'voice-revocation-pending', message: 'Членство удалено; отключение от голосовых комнат будет повторено автоматически.' } })
      }

      return reply.code(204).send(null)
    },
  )

  // ───── POST /api/servers/:serverId/transfer ─────
  //
  // Передача владения сервером. Только текущий owner. Целевой пользователь
  // должен быть участником и не самим owner'ом. Транзакционно: новый owner
  // получает role='owner', прежний становится 'admin' (не теряет доступ).
  app.post(
    '/servers/:serverId/transfer',
    {
      preHandler: app.authenticate,
      schema: {
        params: z.object({ serverId: z.string().uuid() }),
        body: z.object({ userId: z.string().uuid() }),
        response: {
          204: z.null(),
          401: ErrorBodySchema,
          403: ErrorBodySchema,
          404: ErrorBodySchema,
          422: ErrorBodySchema,
        },
      },
    },
    async (req, reply) => {
      const { serverId } = req.params
      const actorId = req.authUser!.id
      const targetId = req.body.userId

      await assertRole(actorId, serverId, ['owner'])

      if (targetId === actorId) {
        return reply.code(422).send({
          error: { code: 'already-owner', message: 'вы уже владелец сервера' },
        })
      }
      // Цель должна быть участником (бросит forbidden/404, если нет).
      await assertMember(targetId, serverId)

      await db.transaction(async (tx) => {
        await tx
          .update(serverMembers)
          .set({ role: 'owner' })
          .where(and(eq(serverMembers.serverId, serverId), eq(serverMembers.userId, targetId)))
        await tx
          .update(serverMembers)
          .set({ role: 'admin' })
          .where(and(eq(serverMembers.serverId, serverId), eq(serverMembers.userId, actorId)))
      })

      audit.log({
        serverId,
        actorId,
        action:     'server.transfer',
        targetType: 'user',
        targetId:   targetId,
        metadata:   { transfer: 'owner' },
      })

      // Обновляем роли у всех: оба участника сменили встроенную роль.
      void broadcastToServer(serverId, { t: 'member.roles', serverId, userId: targetId })
      void broadcastToServer(serverId, { t: 'member.roles', serverId, userId: actorId })

      return reply.code(204).send(null)
    },
  )

  // ───── GET /api/servers/:serverId/unread ─────
  // Каналы сервера с непрочитанными: есть чужое сообщение новее последнего
  // прочтения (или новее вступления, если канал ни разу не открывали).
  app.get(
    '/servers/:serverId/unread',
    {
      preHandler: app.authenticate,
      schema: {
        params: z.object({ serverId: z.string().uuid() }),
        response: { 200: ServerUnreadResponseSchema, 401: ErrorBodySchema, 403: ErrorBodySchema },
      },
    },
    async (req, reply) => {
      const userId = req.authUser!.id
      const { serverId } = req.params
      await assertMember(userId, serverId)

      const rows = await db
        .select({ id: channels.id })
        .from(channels)
        .innerJoin(
          serverMembers,
          and(eq(serverMembers.serverId, channels.serverId), eq(serverMembers.userId, userId)),
        )
        .leftJoin(
          channelReads,
          and(eq(channelReads.channelId, channels.id), eq(channelReads.userId, userId)),
        )
        .where(and(
          eq(channels.serverId, serverId),
          eq(channels.kind, 'text'),
          isNull(channels.parentChannelId),
          sql`EXISTS (
            SELECT 1 FROM messages m
            WHERE m.channel_id = ${channels.id} AND m.deleted_at IS NULL
              AND m.author_id <> ${userId}
              AND m.created_at > COALESCE(${channelReads.lastReadAt}, ${serverMembers.joinedAt})
          )`,
        ))

      return reply.code(200).send({ channelIds: rows.map((r) => r.id) })
    },
  )

  // ───── POST /api/servers/:serverId/read ─────
  // Пометить весь сервер прочитанным (все текстовые каналы верхнего уровня).
  app.post(
    '/servers/:serverId/read',
    {
      preHandler: app.authenticate,
      schema: {
        params: z.object({ serverId: z.string().uuid() }),
        response: { 204: z.null(), 401: ErrorBodySchema, 403: ErrorBodySchema },
      },
    },
    async (req, reply) => {
      const userId = req.authUser!.id
      const { serverId } = req.params
      await assertMember(userId, serverId)

      const chans = await db
        .select({ id: channels.id })
        .from(channels)
        .where(and(
          eq(channels.serverId, serverId),
          eq(channels.kind, 'text'),
          isNull(channels.parentChannelId),
        ))
      if (chans.length > 0) {
        await db
          .insert(channelReads)
          .values(chans.map((c) => ({ userId, channelId: c.id })))
          .onConflictDoUpdate({
            target: [channelReads.userId, channelReads.channelId],
            set: { lastReadAt: sql`NOW()` },
          })
      }

      return reply.code(204).send(null)
    },
  )
}
