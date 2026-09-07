import type { ServerEvent } from '@kakdela/ginzu/ws-events'

import { canReceive, reconcileConnection, revokeConnection, withUserAccess } from './access.js'
import { broker, type Broker } from './broker.js'
import { registry, type Registry } from './registry.js'

export async function broadcastToChannel(channelId: string, event: ServerEvent): Promise<void> {
  await broker.publish('channel:' + channelId, event)
}

export async function broadcastToServer(serverId: string, event: ServerEvent): Promise<void> {
  await broker.publish('server:' + serverId, event)
}

export async function broadcastToUser(userId: string, event: ServerEvent): Promise<void> {
  await broker.publish('user:' + userId, event)
}

export function wireBrokerToRegistry(
  target: Registry = registry,
  transport: Broker = broker,
  log?: { warn: (obj: object, message: string) => void },
): () => void {
  let tail = Promise.resolve()
  let pending = 0
  let disposed = false
  transport.onMessage((topic, event) => {
    if (disposed) return Promise.resolve()
    // Bound queued payloads if the database is slow. Never fall back to unchecked sends.
    if (pending >= 128) {
      for (const conn of target.all()) revokeConnection(conn, target)
      log?.warn({}, 'ws delivery queue full; connections closed')
      return Promise.resolve()
    }
    pending += 1
    const delivery = tail.then(async () => {
      if (disposed) return
      if (event.t === 'member.leave') {
        for (const conn of target.forUser(event.userId)) revokeConnection(conn, target, [event.serverId])
      }
      if (event.t === 'server.delete' && topic === 'server:' + event.serverId) {
        for (const conn of target.forServer(event.serverId)) {
          conn.send(event)
          revokeConnection(conn, target, [event.serverId])
        }
        return
      }
      const connections = topic.startsWith('channel:') ? target.forChannel(topic.slice(8))
        : topic.startsWith('server:') ? target.forServer(topic.slice(7))
          : topic.startsWith('user:') ? target.forUser(topic.slice(5)) : []
      try {
        await withUserAccess(connections.map((c) => c.userId), (snapshots) => {
          for (const conn of connections) {
            const access = snapshots.get(conn.userId)
            if (reconcileConnection(conn, access, target) && access && canReceive(topic, event, conn.userId, access)) conn.send(event)
          }
        })
      } catch (err) {
        for (const conn of connections) revokeConnection(conn, target)
        log?.warn({ err }, 'ws delivery denied: access checks unavailable')
      }
    }).catch((err: unknown) => {
      for (const conn of target.all()) revokeConnection(conn, target)
      log?.warn({ err }, 'ws delivery failed closed')
    }).finally(() => { pending -= 1 })
    tail = delivery
    return delivery
  })
  return () => { disposed = true; transport.onMessage(() => {}) }
}
