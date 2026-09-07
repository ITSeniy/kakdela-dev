import { randomUUID } from 'node:crypto'

import { eq } from 'drizzle-orm'
import { migrate } from 'drizzle-orm/postgres-js/migrator'
import type { WebSocket } from '@fastify/websocket'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import type { ServerEvent } from '@kakdela/ginzu/ws-events'

const transport = vi.hoisted(() => ({ handler: null as null | ((topic: string, event: ServerEvent) => void | Promise<void>) }))
vi.mock('./broker.js', () => ({ broker: {
  onMessage: (handler: typeof transport.handler) => { transport.handler = handler },
  publish: vi.fn().mockResolvedValue(undefined), init: vi.fn(), close: vi.fn(),
} }))
import { channels, serverMembers, servers, users } from '../db/schema.js'
import { db, sql } from '../lib/db.js'
import { wireBrokerToRegistry } from './broadcast.js'
import { Connection } from './connection.js'
import { registry, Registry } from './registry.js'
import { finishHello, reconcileRegistry, withUserAccess } from './access.js'
import type { Broker } from './broker.js'
import { broker } from './broker.js'
import { dispatchClientEvent } from './router.js'

// Only ops/test-postgres.mjs supplies this opt-in disposable database.
describe.skipIf(!process.env.AUDIT_DATABASE_URL)('revocation with authoritative PostgreSQL', () => {
  const userId = randomUUID()
  let serverId: string, channelId: string
  const connections: Connection[] = []
  let stop: unknown
  beforeAll(async () => {
    await migrate(db, { migrationsFolder: './drizzle' })
    stop = wireBrokerToRegistry()
  })
  beforeEach(async () => {
    await sql.unsafe('TRUNCATE users, servers CASCADE')
    await db.insert(users).values({ id: userId, username: 'revocation', displayName: 'Test', email: 'revocation@example.com', passwordHash: 'unused' })
    const [server] = await db.insert(servers).values({ name: 'private server' }).returning()
    serverId = server!.id
    await db.insert(serverMembers).values({ serverId, userId, role: 'member' })
    const [channel] = await db.insert(channels).values({ serverId, name: 'private channel', kind: 'text' }).returning()
    channelId = channel!.id
  })
  afterEach(() => {
    vi.restoreAllMocks()
    for (const conn of connections.splice(0)) { registry.remove(conn); conn.cleanup() }
  })
  afterAll(async () => { if (typeof stop === 'function') stop(); await sql.end() })
  function device() {
    const received: ServerEvent[] = []
    const socket = { OPEN: 1, readyState: 1, send: (text: string) => { received.push(JSON.parse(text) as ServerEvent) }, close: vi.fn(() => { socket.readyState = 3 }) }
    const conn = new Connection(userId, socket as unknown as WebSocket)
    conn.subscribeTo([serverId], [channelId]); registry.add(conn); connections.push(conn)
    return { received, socket, conn }
  }
  const revoke = () => db.delete(serverMembers).where(eq(serverMembers.userId, userId))
  const message = (): ServerEvent => ({ t: 'msg.edit', channelId, messageId: randomUUID(), content: 'PRIVATE AFTER KICK', editedAt: new Date().toISOString() })
  const deliver = async (topic: string, event: ServerEvent) => { await transport.handler!(topic, event) }

  it('does not deliver channel content when member.leave was lost', async () => {
    const a = device(), b = device()
    await revoke()
    await deliver('channel:' + channelId, message())
    expect(a.received.some((e) => e.t === 'msg.edit')).toBe(false)
    expect(b.received.some((e) => e.t === 'msg.edit')).toBe(false)
  })
  it('notifies both devices before closing them on member.leave', async () => {
    const a = device(), b = device()
    await revoke()
    const event: ServerEvent = { t: 'member.leave', serverId, userId }
    await deliver('server:' + serverId, event)
    for (const client of [a, b]) {
      expect(client.received).toContainEqual(event)
      expect(client.socket.close).toHaveBeenCalled()
    }
    expect(registry.forUser(userId)).toHaveLength(0)
  })
  it('rechecks membership after a subscriber reconnect without replaying the leave event', async () => {
    const a = device()
    await revoke()
    // The first ordinary event after reconnect must not trust the old registry.
    await deliver('server:' + serverId, { t: 'presence', userId, status: 'online' })
    expect(a.received.some((e) => e.t === 'presence')).toBe(false)
  })
  it('checks the channel ACL for targeted mention notifications too', async () => {
    const a = device()
    await revoke()
    await deliver('user:' + userId, { t: 'mention', channelId, messageId: randomUUID(), mentionedUserId: userId, mentionType: 'user' })
    expect(a.received.some((e) => e.t === 'mention')).toBe(false)
  })
  const ready = (): Extract<ServerEvent, { t: 'ready' }> => ({
    t: 'ready', user: { id: userId, username: 'revocation', displayName: 'Test', avatarUrl: null, status: 'online', customStatus: null },
    servers: [{ id: serverId, name: 'private server', iconUrl: null }],
  })
  it('filters a stale hello snapshot taken before revocation', async () => {
    const a = device(); registry.remove(a.conn)
    const snapshot = ready()
    await revoke()
    expect(await finishHello(a.conn, snapshot)).toBe(true)
    expect(a.received).toEqual([{ ...snapshot, servers: [] }])
    expect(registry.forServer(serverId)).toHaveLength(0)
    expect(registry.forChannel(channelId)).toHaveLength(0)
  })
  it('does not resurrect a connection closed while hello was pending', async () => {
    const a = device(); registry.remove(a.conn); a.conn.close(4001, 'gone')
    expect(await finishHello(a.conn, ready())).toBe(false)
    expect(registry.forUser(userId)).toHaveLength(0)
    expect(a.received).toHaveLength(0)
  })
  it('reconciles idle sockets even when no broker events arrive', async () => {
    const a = device(); await revoke(); await reconcileRegistry()
    expect(a.socket.close).toHaveBeenCalled()
    expect(registry.forUser(userId)).toHaveLength(0)
  })
  it('protects an independent worker that missed the leave event', async () => {
    const a = device(), b = device(), worker = new Registry()
    registry.remove(b.conn); worker.add(b.conn)
    let handler: typeof transport.handler = null
    const stopWorker = wireBrokerToRegistry(worker, { onMessage: (h: typeof handler) => { handler = h } } as unknown as Broker)
    try {
      await revoke()
      await deliver('server:' + serverId, { t: 'member.leave', serverId, userId })
      await handler!('channel:' + channelId, message())
      expect(a.socket.close).toHaveBeenCalled()
      expect(b.socket.close).toHaveBeenCalled()
      expect(b.received.some((e) => e.t === 'msg.edit')).toBe(false)
      expect(worker.size()).toBe(0)
    } finally { stopWorker(); worker.remove(b.conn) }
  })
  it('serializes membership deletion with the delivery boundary', async () => {
    const held = await sql.reserve()
    let pending: Promise<void> | undefined
    try {
      await held.unsafe('BEGIN')
      await held.unsafe('DELETE FROM server_members WHERE user_id = $1', [userId])
      let sent = false
      pending = withUserAccess([userId], (snapshots) => { sent = snapshots.get(userId)!.servers.has(serverId) })
      await vi.waitFor(async () => {
        // pg_stat_activity caches a snapshot within this transaction; refresh it.
        await held.unsafe('SELECT pg_stat_clear_snapshot()')
        const rows = await held.unsafe("SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND pid <> pg_backend_pid() AND wait_event_type = 'Lock' AND query ILIKE '%server_members%'")
        expect(rows[0]?.['n']).toBeGreaterThan(0)
      }, { timeout: 1500, interval: 20 })
      expect(sent).toBe(false)
      await held.unsafe('COMMIT')
      await pending
      expect(sent).toBe(false)
    } finally {
      await held.unsafe('ROLLBACK'); held.release(); await pending
    }
  })
  it('ignores typing from a revoked connection after a lost leave event', async () => {
    const a = device(); await revoke(); vi.mocked(broker.publish).mockClear()
    await dispatchClientEvent(a.conn, { t: 'typing', channelId })
    expect(broker.publish).not.toHaveBeenCalled()
    expect(a.socket.close).toHaveBeenCalled()
  })
  it('continues delivering authorized content', async () => {
    const a = device(), event = message()
    await deliver('channel:' + channelId, event)
    expect(a.received).toContainEqual(event)
  })
  it('fails closed when authoritative access checks are unavailable', async () => {
    const a = device()
    vi.spyOn(db, 'transaction').mockRejectedValueOnce(new Error('synthetic database outage'))
    await deliver('channel:' + channelId, message())
    expect(a.received.some((e) => e.t === 'msg.edit')).toBe(false)
    expect(a.socket.close).toHaveBeenCalled()
  })
})
