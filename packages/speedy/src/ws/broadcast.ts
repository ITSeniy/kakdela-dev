import type { ServerEvent } from '@kakdela/ginzu/ws-events'

import { broker } from './broker.js'
import { registry } from './registry.js'

export async function broadcastToChannel(channelId: string, event: ServerEvent): Promise<void> {
  await broker.publish('channel:' + channelId, event)
}

export async function broadcastToServer(serverId: string, event: ServerEvent): Promise<void> {
  await broker.publish('server:' + serverId, event)
}

export async function broadcastToUser(userId: string, event: ServerEvent): Promise<void> {
  await broker.publish('user:' + userId, event)
}

export function wireBrokerToRegistry(): void {
  broker.onMessage((topic, event) => {
    if (event.t === 'member.leave') {
      for (const conn of registry.forUser(event.userId)) {
        registry.remove(conn)
        conn.subscribedChannels.clear()
        conn.subscribedServers.clear()
        conn.close(4001, 'membership-changed')
      }
    }
    if (topic.startsWith('channel:')) {
      const channelId = topic.slice('channel:'.length)
      for (const conn of registry.forChannel(channelId)) {
        conn.send(event)
      }
      return
    }
    if (topic.startsWith('server:')) {
      const serverId = topic.slice('server:'.length)
      for (const conn of registry.forServer(serverId)) {
        conn.send(event)
      }
      return
    }
    if (topic.startsWith('user:')) {
      const userId = topic.slice('user:'.length)
      for (const conn of registry.forUser(userId)) {
        conn.send(event)
      }
    }
  })
}
