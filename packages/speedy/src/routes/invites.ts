import { randomBytes } from 'node:crypto'

import { and, asc, desc, eq, gt, isNull, lt, or, sql } from 'drizzle-orm'
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod'
import { z } from 'zod'

import {
  CreateInviteResponseSchema,
  ErrorBodySchema,
  InvitePublicSchema,
  InvitesListResponseSchema,
  type Message,
  type SystemEvent,
} from '@kakdela/ginzu/api-types'

import { channels, invites, messages, serverMembers, servers } from '../db/schema.js'
import { env } from '../env.js'
import { audit } from '../lib/audit.js'
import { db } from '../lib/db.js'
import { assertPermission } from '../lib/permissions.js'
import { attachUserToServer } from '../ws/attach.js'
import { broadcastToChannel, broadcastToServer } from '../ws/broadcast.js'

/**
 * Системное сообщение «участник присоединился» в канал по умолчанию сервера
 * (а если такого нет — первый текстовый верхнего уровня). Best-effort: ошибки
 * не валят сам accept. Не дёргает уведомления — triggers пропускает system.
 */
async function postJoinMessage(serverId: string, userId: string): Promise<void> {
  const chRows = await db
    .select({ id: channels.id })
    .from(channels)
    .where(and(
      eq(channels.serverId, serverId),
      eq(channels.kind, 'text'),
      isNull(channels.parentChannelId),
    ))
    .orderBy(desc(channels.isDefault), asc(channels.position))
    .limit(1)
  const channelId = chRows[0]?.id
  if (!channelId) return

  const system: SystemEvent = { kind: 'join' }
  const inserted = await db
    .insert(messages)
    .values({ channelId, authorId: userId, content: '', system })
    .returning({ id: messages.id, createdAt: messages.createdAt })
  const row = inserted[0]
  if (!row) return

  const message: Message = {
    id: row.id,
    channelId,
    authorId: userId,
    content: '',
    replyToId: null,
    replyTo: null,
    createdAt: row.createdAt.toISOString(),
    editedAt: null,
    reactions: [],
    attachments: [],
    thread: null,
    pinned: false,
    pinnedAt: null,
    forwarded: null,
    linkPreviews: [],
    system,
  }
  await broadcastToChannel(channelId, { t: 'msg.new', channelId, message })
}

// Ровно 32 символа — каждое 5-битное значение (0..31) обязано попадать в
// алфавит, иначе charAt(31) вернёт пустую строку и код выйдет 7-значным.
// Исключены визуально неоднозначные i/l/o/1; «0» есть, o→0 чинит normalizeCode.
const BASE32 = 'abcdefghjkmnpqrstuvwxyz023456789'

function generateCode(): string {
  const bytes = randomBytes(5)
  let num = 0n
  for (const byte of bytes) {
    num = (num << 8n) | BigInt(byte)
  }
  let code = ''
  for (let i = 7; i >= 0; i--) {
    code += BASE32.charAt(Number((num >> BigInt(i * 5)) & 0x1fn))
  }
  return code
}

function normalizeCode(raw: string): string {
  return raw.toLowerCase().replace(/[^a-z0-9]/g, '').replace(/o/g, '0')
}

export const invitesRoutes: FastifyPluginAsyncZod = async (app) => {
  // ───── POST /api/servers/:serverId/invites ─────
  app.post(
    '/servers/:serverId/invites',
    {
      preHandler: app.authenticate,
      schema: {
        params: z.object({ serverId: z.string().uuid() }),
        body: z.object({
          expiresInDays: z.number().int().positive().optional(),
          maxUses: z.number().int().positive().optional(),
        }),
        response: {
          200: CreateInviteResponseSchema,
          403: ErrorBodySchema,
          404: ErrorBodySchema,
        },
      },
    },
    async (req, reply) => {
      const { serverId } = req.params
      // preHandler: app.authenticate guarantees authUser is set
      const userId = req.authUser!.id

      await assertPermission(userId, serverId, 'MANAGE_INVITES')

      const serverRows = await db
        .select({ id: servers.id })
        .from(servers)
        .where(eq(servers.id, serverId))
        .limit(1)
      if (!serverRows[0]) {
        return reply.code(404).send({ error: { code: 'server-not-found', message: 'server not found' } })
      }

      const expiresAt = req.body.expiresInDays != null
        ? new Date(Date.now() + req.body.expiresInDays * 86_400_000)
        : null

      let code: string | null = null
      for (let attempt = 0; attempt < 3; attempt++) {
        const candidate = generateCode()
        const existing = await db
          .select({ code: invites.code })
          .from(invites)
          .where(eq(invites.code, candidate))
          .limit(1)
        if (!existing[0]) {
          code = candidate
          break
        }
      }
      if (!code) {
        throw new Error('failed to generate unique invite code after 3 attempts')
      }

      await db.insert(invites).values({
        code,
        serverId,
        createdBy: userId,
        expiresAt,
        maxUses: req.body.maxUses ?? null,
      })

      audit.log({
        serverId,
        actorId:    userId,
        action:     'invite.create',
        targetType: 'invite',
        // invite.code — natural primary key, не uuid; кладём в metadata.
        targetId:   null,
        metadata: {
          code,
          expiresAt: expiresAt?.toISOString() ?? null,
          maxUses:   req.body.maxUses ?? null,
        },
      })

      return reply.code(200).send({ code, url: `${env.PUBLIC_ORIGIN}/invite/${code}` })
    },
  )

  // ───── GET /api/servers/:serverId/invites ─────
  //
  // Список активных и недавних инвайтов для админ-UI. Возвращаем без
  // фильтрации по revoked/expired — UI решает, как показать «отозванные».
  app.get(
    '/servers/:serverId/invites',
    {
      preHandler: app.authenticate,
      schema: {
        params: z.object({ serverId: z.string().uuid() }),
        response: {
          200: InvitesListResponseSchema,
          401: ErrorBodySchema,
          403: ErrorBodySchema,
        },
      },
    },
    async (req, reply) => {
      const { serverId } = req.params
      const userId = req.authUser!.id

      await assertPermission(userId, serverId, 'MANAGE_INVITES')

      const rows = await db
        .select({
          code:      invites.code,
          createdBy: invites.createdBy,
          expiresAt: invites.expiresAt,
          maxUses:   invites.maxUses,
          useCount:  invites.useCount,
          revoked:   invites.revoked,
          createdAt: invites.createdAt,
        })
        .from(invites)
        .where(eq(invites.serverId, serverId))
        .orderBy(sql`${invites.createdAt} DESC`)

      const items = rows.map((r) => ({
        code:      r.code,
        url:       `${env.PUBLIC_ORIGIN}/?invite=${r.code}`,
        createdBy: r.createdBy,
        expiresAt: r.expiresAt?.toISOString() ?? null,
        maxUses:   r.maxUses,
        useCount:  r.useCount,
        revoked:   r.revoked,
        createdAt: r.createdAt.toISOString(),
      }))

      return reply.code(200).send({ invites: items })
    },
  )

  // ───── GET /api/invites/:code ─────
  app.get(
    '/invites/:code',
    {
      schema: {
        params: z.object({ code: z.string() }),
        response: {
          200: InvitePublicSchema,
          404: ErrorBodySchema,
          410: ErrorBodySchema,
        },
      },
    },
    async (req, reply) => {
      const code = normalizeCode(req.params.code)

      const rows = await db
        .select({
          revoked:    invites.revoked,
          expiresAt:  invites.expiresAt,
          maxUses:    invites.maxUses,
          useCount:   invites.useCount,
          serverId:   servers.id,
          serverName: servers.name,
          serverIcon: servers.iconUrl,
        })
        .from(invites)
        .innerJoin(servers, eq(invites.serverId, servers.id))
        .where(eq(invites.code, code))
        .limit(1)

      const invite = rows[0]
      if (!invite) {
        return reply.code(404).send({ error: { code: 'invite-not-found', message: 'invite not found' } })
      }
      if (invite.revoked || (invite.expiresAt !== null && invite.expiresAt < new Date())) {
        return reply.code(410).send({ error: { code: 'invite-expired', message: 'invite has expired or been revoked' } })
      }
      if (invite.maxUses !== null && invite.useCount >= invite.maxUses) {
        return reply.code(410).send({ error: { code: 'invite-exhausted', message: 'invite has reached its maximum uses' } })
      }

      const countRows = await db
        .select({ n: sql<number>`COUNT(*)::int` })
        .from(serverMembers)
        .where(eq(serverMembers.serverId, invite.serverId))

      return reply.code(200).send({
        serverId:    invite.serverId,
        serverName:  invite.serverName,
        serverIcon:  invite.serverIcon ?? null,
        memberCount: countRows[0]?.n ?? 0,
        expiresAt:   invite.expiresAt?.toISOString() ?? null,
      })
    },
  )

  // ───── POST /api/invites/:code/accept ─────
  app.post(
    '/invites/:code/accept',
    {
      preHandler: app.authenticate,
      schema: {
        params: z.object({ code: z.string() }),
        response: {
          200: z.object({ serverId: z.string().uuid() }),
          404: ErrorBodySchema,
          410: ErrorBodySchema,
        },
      },
    },
    async (req, reply) => {
      const code = normalizeCode(req.params.code)
      // preHandler: app.authenticate guarantees authUser is set
      const userId = req.authUser!.id

      // Atomically increment use_count only when the invite is still valid.
      // If two concurrent requests race with maxUses: 1, only one UPDATE wins.
      const updated = await db
        .update(invites)
        .set({ useCount: sql`${invites.useCount} + 1` })
        .where(
          and(
            eq(invites.code, code),
            eq(invites.revoked, false),
            or(isNull(invites.expiresAt), gt(invites.expiresAt, sql`NOW()`)),
            or(isNull(invites.maxUses), lt(invites.useCount, invites.maxUses)),
          ),
        )
        .returning({ serverId: invites.serverId })

      const row = updated[0]
      if (!row) {
        const exists = await db
          .select({ code: invites.code })
          .from(invites)
          .where(eq(invites.code, code))
          .limit(1)
        if (!exists[0]) {
          return reply.code(404).send({ error: { code: 'invite-not-found', message: 'invite not found' } })
        }
        return reply.code(410).send({ error: { code: 'invite-expired', message: 'invite is expired, revoked, or exhausted' } })
      }

      const memberInsert = await db
        .insert(serverMembers)
        .values({ serverId: row.serverId, userId })
        .onConflictDoNothing()
        .returning({
          userId:   serverMembers.userId,
          role:     serverMembers.role,
          joinedAt: serverMembers.joinedAt,
        })

      // Hot-attach до broadcast'ов, чтобы свежий участник увидел и своё
      // системное сообщение о вступлении. При повторном accept подписки уже
      // есть — операция идемпотентна и дёшева.
      try {
        await attachUserToServer(userId, row.serverId)
      } catch (err) {
        req.log.warn({ err, serverId: row.serverId, userId }, 'ws hot-attach on join failed')
      }

      // Только при ПЕРВОМ вступлении (не при повторном accept) — системное
      // сообщение в канал. Best-effort: падение тут не должно ломать accept.
      const inserted = memberInsert[0]
      if (inserted) {
        try {
          await postJoinMessage(row.serverId, userId)
        } catch (err) {
          req.log.warn({ err, serverId: row.serverId, userId }, 'join system message failed')
        }
        // Остальным участникам — событие для обновления списка участников.
        void broadcastToServer(row.serverId, {
          t: 'member.join',
          member: {
            serverId: row.serverId,
            userId:   inserted.userId,
            role:     inserted.role,
            joinedAt: inserted.joinedAt.toISOString(),
          },
        })
      }

      return reply.code(200).send({ serverId: row.serverId })
    },
  )

  // ───── DELETE /api/invites/:code ─────
  app.delete(
    '/invites/:code',
    {
      preHandler: app.authenticate,
      schema: {
        params: z.object({ code: z.string() }),
        response: {
          204: z.null(),
          403: ErrorBodySchema,
          404: ErrorBodySchema,
        },
      },
    },
    async (req, reply) => {
      const code = normalizeCode(req.params.code)
      // preHandler: app.authenticate guarantees authUser is set
      const userId = req.authUser!.id

      const inviteRows = await db
        .select({ serverId: invites.serverId })
        .from(invites)
        .where(eq(invites.code, code))
        .limit(1)
      const invite = inviteRows[0]
      if (!invite) {
        return reply.code(404).send({ error: { code: 'invite-not-found', message: 'invite not found' } })
      }

      await assertPermission(userId, invite.serverId, 'MANAGE_INVITES')

      await db.update(invites).set({ revoked: true }).where(eq(invites.code, code))

      audit.log({
        serverId:   invite.serverId,
        actorId:    userId,
        action:     'invite.revoke',
        targetType: 'invite',
        targetId:   null,
        metadata: { code },
      })

      return reply.code(204).send(null)
    },
  )
}
