import { auditLog } from '../db/schema.js'
import { db } from './db.js'

// Whitelist разрешённых action'ов — TS-safety + дешёвая проверка перед
// записью (схема enum уже отлавливает левый action на уровне postgres, но
// явный list документирует, что вообще логируется).
export const AUDIT_ACTIONS = [
  'channel.create', 'channel.update', 'channel.delete',
  'member.promote', 'member.demote', 'member.kick', 'member.role.set',
  'invite.create',  'invite.revoke',
  'emoji.create',   'emoji.delete',
  'role.create',    'role.update',    'role.delete',
  'server.update',  'server.transfer',
] as const
export type AuditAction = (typeof AUDIT_ACTIONS)[number]

export const AUDIT_TARGET_TYPES = [
  'channel', 'user', 'invite', 'emoji', 'role', 'server',
] as const
export type AuditTargetType = (typeof AUDIT_TARGET_TYPES)[number]

export interface AuditEntry {
  serverId:   string
  actorId:    string
  action:     AuditAction
  targetType: AuditTargetType
  targetId?:  string | null
  metadata?:  Record<string, unknown>
}

/**
 * Fire-and-forget запись в audit log. Не ждём результата в основном запросе —
 * это не критично для пользователя и не должно увеличивать latency. Ошибка
 * пишется в stderr, но не валит запрос.
 */
function writeAsync(entry: AuditEntry): void {
  setImmediate(() => {
    void db
      .insert(auditLog)
      .values({
        serverId:   entry.serverId,
        actorId:    entry.actorId,
        action:     entry.action,
        targetType: entry.targetType,
        targetId:   entry.targetId ?? null,
        metadata:   entry.metadata ?? null,
      })
      .catch((err) => {
        // eslint-disable-next-line no-console
        console.error('[audit] failed to write entry', { entry, err })
      })
  })
}

export const audit = { log: writeAsync }
