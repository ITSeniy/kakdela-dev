import { describe, expect, it } from 'vitest'

import type { Connection } from './connection.js'
import { registry } from './registry.js'

// Registry работает только с публичными полями Connection
// (userId, subscribedChannels/Servers) — для юнит-тестов достаточно заглушки.
function fakeConn(userId: string): Connection {
  return {
    userId,
    subscribedChannels: new Set<string>(),
    subscribedServers: new Set<string>(),
  } as unknown as Connection
}

function sub(conn: Connection, serverId: string, channelIds: string[]): void {
  registry.subscribeServer(conn, serverId)
  for (const id of channelIds) registry.subscribeChannel(conn, id)
}

describe('registry subscriptions', () => {
  it('unsubscribeFromServer removes server+channels but keeps other servers', () => {
    const conn = fakeConn('u1')
    registry.add(conn)
    sub(conn, 'srv-a', ['ch-a1', 'ch-a2'])
    sub(conn, 'srv-b', ['ch-b1'])

    registry.unsubscribeFromServer('u1', 'srv-a', ['ch-a1', 'ch-a2'])

    expect(conn.subscribedServers.has('srv-a')).toBe(false)
    expect(conn.subscribedServers.has('srv-b')).toBe(true)
    expect(registry.forServer('srv-a')).toEqual([])
    expect(registry.forChannel('ch-a1')).toEqual([])
    // Чужой сервер не пострадал.
    expect(registry.forServer('srv-b').map((c) => c.userId)).toEqual(['u1'])
    expect(registry.forChannel('ch-b1').map((c) => c.userId)).toEqual(['u1'])

    registry.remove(conn)
  })

  it('unsubscribeFromServer affects ALL connections of the user (multi-device)', () => {
    const desktop = fakeConn('u1')
    const phone = fakeConn('u1')
    registry.add(desktop)
    registry.add(phone)
    sub(desktop, 'srv-a', ['ch-a1'])
    sub(phone, 'srv-a', ['ch-a1'])

    registry.unsubscribeFromServer('u1', 'srv-a', ['ch-a1'])

    expect(registry.forServer('srv-a')).toEqual([])
    expect(registry.forChannel('ch-a1')).toEqual([])

    registry.remove(desktop)
    registry.remove(phone)
  })

  it('dropServer detaches every subscriber and clears the index', () => {
    const a = fakeConn('u1')
    const b = fakeConn('u2')
    registry.add(a)
    registry.add(b)
    sub(a, 'srv-x', ['ch-x1'])
    sub(b, 'srv-x', ['ch-x1'])
    sub(b, 'srv-y', ['ch-y1'])

    registry.dropServer('srv-x', ['ch-x1'])

    expect(registry.forServer('srv-x')).toEqual([])
    expect(registry.forChannel('ch-x1')).toEqual([])
    expect(a.subscribedChannels.size).toBe(0)
    // b остался подписан на другой сервер.
    expect(registry.forServer('srv-y').map((c) => c.userId)).toEqual(['u2'])
    expect(b.subscribedServers.has('srv-x')).toBe(false)

    registry.remove(a)
    registry.remove(b)
  })

  it('remove() still cleans everything after manual unsubscribe is a no-op-safe path', () => {
    const conn = fakeConn('u3')
    registry.add(conn)
    sub(conn, 'srv-c', ['ch-c1'])

    registry.unsubscribeFromServer('u3', 'srv-c', ['ch-c1'])
    // Повторный remove после отвязки не должен бросить и не должен
    // воскресить записи.
    expect(() => registry.remove(conn)).not.toThrow()
    expect(registry.forUser('u3')).toEqual([])
  })
})
