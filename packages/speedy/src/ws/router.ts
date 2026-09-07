import type { ClientEvent } from '@kakdela/ginzu/ws-events'

import { presence } from '../presence/store.js'
import { reconcileConnection, revokeConnection, withUserAccess } from './access.js'
import { broadcastToChannel, broadcastToServer } from './broadcast.js'
import type { Connection } from './connection.js'

export async function dispatchClientEvent(conn: Connection, event: ClientEvent): Promise<void> {
  if (!conn.isActive) return
  switch (event.t) {
    case 'hello': return // Already handled at handshake time.
    case 'pong': conn.handlePong(); return
    case 'ping': conn.send({ t: 'pong' }); return
    case 'typing':
    case 'presence': break
  }

  let allowed = false
  let serverIds: string[] = []
  try {
    await withUserAccess([conn.userId], (snapshots) => {
      const access = snapshots.get(conn.userId)
      if (!reconcileConnection(conn, access) || !access) return
      allowed = event.t === 'presence' || (access.channels.has(event.channelId) && conn.subscribedChannels.has(event.channelId))
      serverIds = [...conn.subscribedServers].filter((id) => access.servers.has(id))
    })
  } catch (err) { revokeConnection(conn); throw err }
  if (!allowed || !conn.isActive) return
  // Ephemeral events only; recipients independently recheck their own access.
  if (event.t === 'typing') {
    await broadcastToChannel(event.channelId, { t: 'typing', channelId: event.channelId, userId: conn.userId })
  } else {
    await presence.setStatus(conn.userId, event.status)
    for (const serverId of serverIds) {
      if (!conn.isActive) return
      await broadcastToServer(serverId, { t: 'presence', userId: conn.userId, status: event.status })
    }
  }
}
