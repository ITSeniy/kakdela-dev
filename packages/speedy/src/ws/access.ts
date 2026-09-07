import { inArray, or, sql as sqlQuery } from 'drizzle-orm'

import type { ServerEvent } from '@kakdela/ginzu/ws-events'

import { channels, dmChannels, serverMembers, users } from '../db/schema.js'
import { db } from '../lib/db.js'
import type { Connection } from './connection.js'
import { registry, type Registry } from './registry.js'

export interface AccessSnapshot {
  exists: boolean
  servers: Set<string>
  channels: Set<string>
}

/**
 * Database membership is the authority, never a Redis notification or registry.
 * Keep membership row locks until synchronous socket sends have been enqueued.
 * DELETE membership therefore linearizes before or after delivery across workers.
 * Callbacks must not start asynchronous work or escape the snapshot.
 */
export async function withUserAccess(
  userIds: readonly string[],
  send: (snapshots: ReadonlyMap<string, AccessSnapshot>) => void,
): Promise<void> {
  const ids = [...new Set(userIds)].sort()
  if (ids.length === 0) return
  await db.transaction(async (tx) => {
    await tx.execute(sqlQuery`SET LOCAL statement_timeout = '3000ms'`)
    const existing = await tx.select({ id: users.id }).from(users).where(inArray(users.id, ids))
    const memberships = await tx.select({ userId: serverMembers.userId, serverId: serverMembers.serverId })
      .from(serverMembers).where(inArray(serverMembers.userId, ids))
      .orderBy(serverMembers.serverId, serverMembers.userId).for('share')
    const serverIds = [...new Set(memberships.map((m) => m.serverId))]
    const serverChannels = serverIds.length === 0 ? [] : await tx.select({ id: channels.id, serverId: channels.serverId })
      .from(channels).where(inArray(channels.serverId, serverIds))
    const dms = await tx.select().from(dmChannels)
      .where(or(inArray(dmChannels.userAId, ids), inArray(dmChannels.userBId, ids)))
    const existingIds = new Set(existing.map((u) => u.id))
    const snapshots = new Map<string, AccessSnapshot>()
    for (const id of ids) {
      const memberServers = new Set(memberships.filter((m) => m.userId === id).map((m) => m.serverId))
      snapshots.set(id, {
        exists: existingIds.has(id), servers: memberServers,
        channels: new Set([
          ...serverChannels.filter((c) => c.serverId && memberServers.has(c.serverId)).map((c) => c.id),
          ...dms.filter((d) => d.userAId === id || d.userBId === id).map((d) => d.channelId),
        ]),
      })
    }
    send(snapshots)
  })
}

export function revokeConnection(conn: Connection, target: Registry = registry, lostServers: readonly string[] = []): void {
  // This control event contains only IDs already known to the user. Send BEFORE close.
  for (const serverId of lostServers) conn.send({ t: 'member.leave', serverId, userId: conn.userId })
  target.remove(conn)
  conn.subscribedServers.clear()
  conn.subscribedChannels.clear()
  conn.cleanup()
  conn.close(4001, lostServers.length ? 'membership-changed' : 'authorization-unavailable')
}

export function reconcileConnection(conn: Connection, access: AccessSnapshot | undefined, target: Registry = registry): boolean {
  const lost = [...conn.subscribedServers].filter((id) => !access?.servers.has(id))
  if (!access?.exists || lost.length > 0) { revokeConnection(conn, target, lost); return false }
  return conn.isActive
}

export function canReceive(topic: string, event: ServerEvent, userId: string, access: AccessSnapshot): boolean {
  if (!access.exists) return false
  if (topic.startsWith('server:')) {
    if (!access.servers.has(topic.slice(7))) return false
  } else if (topic.startsWith('channel:')) {
    if (!access.channels.has(topic.slice(8))) return false
  } else if (topic !== 'user:' + userId) return false

  // Targeted events (mentions, rings, reminders) must not bypass their parent ACL.
  if ('serverId' in event && !access.servers.has(event.serverId)) return false
  if (event.t === 'server.update' && !access.servers.has(event.server.id)) return false
  if (event.t === 'member.join' && !access.servers.has(event.member.serverId)) return false
  if ('channelId' in event && event.t !== 'channel.delete' && !access.channels.has(event.channelId)) return false
  if ('parentChannelId' in event && !access.channels.has(event.parentChannelId)) return false
  if (event.t === 'voice.moved' && (!access.channels.has(event.fromChannelId) || !access.channels.has(event.toChannelId))) return false
  return true
}

/** Revalidate a potentially stale hello snapshot immediately before registering it. */
export async function finishHello(conn: Connection, ready: Extract<ServerEvent, { t: 'ready' }>, target: Registry = registry): Promise<boolean> {
  let attached = false
  await withUserAccess([conn.userId], (snapshots) => {
    const access = snapshots.get(conn.userId)
    if (!access?.exists || !conn.isActive) return
    if (target.forUser(conn.userId).length >= 10) { conn.close(4429, 'too-many-user-connections'); return }
    for (const id of conn.subscribedServers) if (!access.servers.has(id)) conn.subscribedServers.delete(id)
    for (const id of conn.subscribedChannels) if (!access.channels.has(id)) conn.subscribedChannels.delete(id)
    target.add(conn)
    conn.send({ ...ready, servers: ready.servers.filter((s) => access.servers.has(s.id)) })
    conn.startHeartbeat()
    attached = true
  })
  return attached
}

export async function reconcileRegistry(target: Registry = registry): Promise<void> {
  const connections = target.all()
  try {
    await withUserAccess(connections.map((c) => c.userId), (snapshots) => {
      for (const conn of connections) reconcileConnection(conn, snapshots.get(conn.userId), target)
    })
  } catch (err) {
    for (const conn of connections) revokeConnection(conn, target)
    throw err
  }
}

export function startAccessReconciler(log: { warn: (obj: object, message: string) => void }, target: Registry = registry): () => void {
  let running = false
  const timer = setInterval(() => {
    if (running) return
    running = true
    void reconcileRegistry(target).catch((err: unknown) => log.warn({ err }, 'ws access reconciliation failed'))
      .finally(() => { running = false })
  }, 5000)
  timer.unref()
  return () => clearInterval(timer)
}
