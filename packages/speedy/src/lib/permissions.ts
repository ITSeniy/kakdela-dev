import { and, eq } from 'drizzle-orm'

import { ALL_PERMISSIONS, Permissions, hasPermission, type PermissionFlag } from '@kakdela/ginzu/permissions'

import { channels, dmChannels, memberRoles, serverMembers, serverRoles } from '../db/schema.js'
import { db, type DbExecutor } from './db.js'

export type MemberRole = 'owner' | 'admin' | 'member'

// Иерархия: owner — выше всех; builtin admin — выше любых кастомных ролей, но
// ниже owner; кастомные роли — по своей position; @everyone (position 0) — низ.
const OWNER_POSITION = Number.POSITIVE_INFINITY
const ADMIN_POSITION = 1_000_000_000

function makeError(statusCode: number, code: string, message: string): Error {
  return Object.assign(new Error(message), { statusCode, code })
}

export function forbidden(message = 'access denied'): Error {
  return makeError(403, 'forbidden', message)
}

export function notFound(code: string, message: string): Error {
  return makeError(404, code, message)
}

export async function assertMember(userId: string, serverId: string, database: DbExecutor = db): Promise<{ role: MemberRole }> {
  const rows = await database
    .select({ role: serverMembers.role })
    .from(serverMembers)
    .where(and(eq(serverMembers.serverId, serverId), eq(serverMembers.userId, userId)))
    .limit(1)
  const member = rows[0]
  if (!member) throw forbidden('not a member of this server')
  return { role: member.role }
}

export async function assertRole(
  userId: string,
  serverId: string,
  roles: MemberRole[],
): Promise<void> {
  const { role } = await assertMember(userId, serverId)
  if (!roles.includes(role)) throw forbidden('insufficient permissions')
}

// ───── Эффективные разрешения (система ролей) ─────

export interface MemberPermissionContext {
  role: MemberRole
  /** Итоговая битовая маска (builtin ∪ @everyone ∪ кастомные роли). */
  permissions: number
  /** Позиция в иерархии (для проверок «можно ли управлять X»). */
  position: number
}

/**
 * Считает эффективные права участника: owner → всё; иначе @everyone ∪
 * назначенные роли, плюс builtin admin даёт ADMINISTRATOR. Бросает forbidden,
 * если user не состоит в сервере.
 */
export async function getMemberPermissions(userId: string, serverId: string, database: DbExecutor = db): Promise<MemberPermissionContext> {
  const { role } = await assertMember(userId, serverId, database)
  if (role === 'owner') {
    return { role, permissions: ALL_PERMISSIONS, position: OWNER_POSITION }
  }

  // @everyone базовая маска.
  const everyoneRows = await database
    .select({ permissions: serverRoles.permissions })
    .from(serverRoles)
    .where(and(eq(serverRoles.serverId, serverId), eq(serverRoles.isEveryone, true)))
    .limit(1)
  let mask = everyoneRows[0]?.permissions ?? 0

  // Назначенные кастомные роли.
  const assigned = await database
    .select({ permissions: serverRoles.permissions, position: serverRoles.position })
    .from(memberRoles)
    .innerJoin(serverRoles, eq(memberRoles.roleId, serverRoles.id))
    .where(and(eq(memberRoles.serverId, serverId), eq(memberRoles.userId, userId)))

  let topPosition = 0
  for (const r of assigned) {
    mask |= r.permissions
    if (r.position > topPosition) topPosition = r.position
  }

  if (role === 'admin') {
    mask |= Permissions.ADMINISTRATOR
    return { role, permissions: mask, position: ADMIN_POSITION }
  }
  return { role, permissions: mask, position: topPosition }
}

/** Бросает forbidden, если у участника нет нужного права (ADMINISTRATOR/owner проходят). */
export async function assertPermission(userId: string, serverId: string, flag: PermissionFlag): Promise<MemberPermissionContext> {
  const ctx = await getMemberPermissions(userId, serverId)
  if (!hasPermission(ctx.permissions, flag)) throw forbidden(`missing permission: ${flag}`)
  return ctx
}

/** Может ли актор управлять ролью на позиции rolePosition (создание/правка/назначение). */
export function canManageRolePosition(ctx: MemberPermissionContext, rolePosition: number): boolean {
  return ctx.position > rolePosition
}

/** Может ли актор действовать над целевым участником (кик/смена ролей). */
export function canActOnMember(actor: MemberPermissionContext, target: MemberPermissionContext): boolean {
  if (target.role === 'owner') return false
  return actor.position > target.position
}

export type ChannelAccess =
  | { kind: 'server'; channelId: string; serverId: string }
  | { kind: 'dm';     channelId: string; userAId: string; userBId: string }

/**
 * Универсальная проверка доступа: serverChannel — через members, DM —
 * через `dm_channels` (user должен быть одним из двух участников).
 * Возвращает «классификацию» канала, чтобы вызывающая логика могла, к
 * примеру, корректно собрать broadcast topic'и или подтянуть собеседника.
 */
export async function assertCanAccessChannel(
  userId: string,
  channelId: string,
): Promise<ChannelAccess> {
  const chRows = await db
    .select({ id: channels.id, serverId: channels.serverId, kind: channels.kind })
    .from(channels)
    .where(eq(channels.id, channelId))
    .limit(1)
  const ch = chRows[0]
  if (!ch) throw notFound('channel-not-found', 'channel not found')

  if (ch.kind === 'dm') {
    const dmRows = await db
      .select({ userAId: dmChannels.userAId, userBId: dmChannels.userBId })
      .from(dmChannels)
      .where(eq(dmChannels.channelId, channelId))
      .limit(1)
    const dm = dmRows[0]
    if (!dm) throw notFound('channel-not-found', 'channel not found')
    if (dm.userAId !== userId && dm.userBId !== userId) {
      throw forbidden('not a participant of this dm')
    }
    return { kind: 'dm', channelId, userAId: dm.userAId, userBId: dm.userBId }
  }

  if (!ch.serverId) {
    // text/voice channel without a server: should never happen, but
    // defensively refuse access rather than 500.
    throw notFound('channel-not-found', 'channel not found')
  }
  await assertMember(userId, ch.serverId)
  return { kind: 'server', channelId, serverId: ch.serverId }
}
