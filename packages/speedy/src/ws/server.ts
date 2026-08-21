import fastifyWebsocket, { type WebSocket } from '@fastify/websocket'
import { eq, inArray } from 'drizzle-orm'
import type { FastifyPluginAsync } from 'fastify'

import type { Server, User } from '@kakdela/ginzu/api-types'
import { ClientEventSchema, type ServerEvent } from '@kakdela/ginzu/ws-events'

import { or } from 'drizzle-orm'

import { verifyAccessToken } from '../auth/tokens.js'
import { channels, dmChannels, serverMembers, servers, users } from '../db/schema.js'
import { db } from '../lib/db.js'
import { presence } from '../presence/store.js'
import { broker } from './broker.js'
import { broadcastToServer, wireBrokerToRegistry } from './broadcast.js'
import { Connection } from './connection.js'
import { registry } from './registry.js'
import { dispatchClientEvent } from './router.js'

const HELLO_TIMEOUT_MS = 5_000
// hello/typing/pong — крошечные JSON-кадры. Дефолт ws (~100 MiB) позволял
// пре-auth DoS: JSON.parse гигантских кадров до аутентификации.
const MAX_WS_PAYLOAD_BYTES = 64 * 1024
// Лимит одновременных соединений с одного IP (защита от сокет-флуда).
// С запасом для семьи за одним NAT и человека с телефоном+десктопом.
const MAX_SOCKETS_PER_IP = 30

type DbUser = typeof users.$inferSelect

function publicUser(row: DbUser): User {
  return {
    id:           row.id,
    username:     row.username,
    displayName:  row.displayName,
    avatarUrl:    row.avatarUrl,
    status:       row.status,
    customStatus: row.customStatus ?? null,
  }
}

interface HelloResult {
  conn: Connection
  ready: ServerEvent
}

async function authorizeHello(token: string, socket: WebSocket): Promise<HelloResult | null> {
  const verified = await verifyAccessToken(token)
  if (!verified.ok) return null

  const userId = verified.payload.sub

  const userRows = await db.select().from(users).where(eq(users.id, userId)).limit(1)
  const user = userRows[0]
  if (!user) return null

  const serverRows = await db
    .select({ id: servers.id, name: servers.name, iconUrl: servers.iconUrl })
    .from(serverMembers)
    .innerJoin(servers, eq(serverMembers.serverId, servers.id))
    .where(eq(serverMembers.userId, userId))

  const serverIds = serverRows.map((s) => s.id)

  const channelRows = serverIds.length > 0
    ? await db
        .select({ id: channels.id })
        .from(channels)
        .where(inArray(channels.serverId, serverIds))
    : []

  const dmRows = await db
    .select({ id: dmChannels.channelId })
    .from(dmChannels)
    .where(or(eq(dmChannels.userAId, userId), eq(dmChannels.userBId, userId)))

  const subscribedChannelIds = [
    ...channelRows.map((c) => c.id),
    ...dmRows.map((d) => d.id),
  ]

  const conn = new Connection(userId, socket)
  conn.subscribeTo(serverIds, subscribedChannelIds)

  const serverList: Server[] = serverRows.map((s) => ({
    id:      s.id,
    name:    s.name,
    iconUrl: s.iconUrl ?? null,
  }))

  return {
    conn,
    ready: { t: 'ready', user: publicUser(user), servers: serverList },
  }
}

export const wsPlugin: FastifyPluginAsync = async (app) => {
  await app.register(fastifyWebsocket, { options: { maxPayload: MAX_WS_PAYLOAD_BYTES } })
  await broker.init()
  wireBrokerToRegistry()

  const socketsPerIp = new Map<string, number>()
  function acquireIpSlot(ip: string): boolean {
    const n = socketsPerIp.get(ip) ?? 0
    if (n >= MAX_SOCKETS_PER_IP) return false
    socketsPerIp.set(ip, n + 1)
    return true
  }
  function releaseIpSlot(ip: string): void {
    const n = socketsPerIp.get(ip)
    if (n === undefined) return
    if (n <= 1) socketsPerIp.delete(ip)
    else socketsPerIp.set(ip, n - 1)
  }

  presence.onOffline(async (userId) => {
    const rows = await db
      .select({ serverId: serverMembers.serverId })
      .from(serverMembers)
      .where(eq(serverMembers.userId, userId))
    for (const { serverId } of rows) {
      void broadcastToServer(serverId, { t: 'presence', userId, status: 'offline' })
    }
  })

  app.get('/ws', { websocket: true }, (socket, req) => {
    if (!acquireIpSlot(req.ip)) {
      try { socket.close(4429, 'too-many-connections') } catch { /* ignore */ }
      return
    }

    let conn: Connection | null = null
    let helloed = false
    let helloPending = false

    const helloTimeout = setTimeout(() => {
      if (!helloed) {
        try { socket.close(4400, 'hello-timeout') } catch { /* ignore */ }
      }
    }, HELLO_TIMEOUT_MS)

    socket.on('message', (raw: Buffer | ArrayBuffer | Buffer[]) => {
      const text = Buffer.isBuffer(raw)
        ? raw.toString('utf8')
        : Array.isArray(raw)
          ? Buffer.concat(raw).toString('utf8')
          : Buffer.from(raw).toString('utf8')

      let parsed: unknown
      try {
        parsed = JSON.parse(text)
      } catch {
        return
      }

      const result = ClientEventSchema.safeParse(parsed)
      if (!result.success) {
        app.log.debug({ err: result.error.message }, 'ws: invalid client event')
        return
      }
      const ev = result.data

      if (!helloed) {
        if (helloPending) return
        if (ev.t !== 'hello') {
          try { socket.close(4400, 'expected-hello') } catch { /* ignore */ }
          return
        }
        helloPending = true
        void authorizeHello(ev.token, socket).then((result) => {
          helloPending = false
          if (!result) {
            try { socket.close(4401, 'unauthorized') } catch { /* ignore */ }
            return
          }
          helloed = true
          conn = result.conn
          clearTimeout(helloTimeout)
          registry.add(result.conn)
          result.conn.send(result.ready)
          result.conn.startHeartbeat()

          void presence.addConnection(result.conn.userId).then((p) => {
            if (!p.broadcast) return
            for (const sid of result.conn.subscribedServers) {
              void broadcastToServer(sid, {
                t: 'presence',
                userId: result.conn.userId,
                status: p.status,
              })
            }
          }).catch((err: unknown) => {
            app.log.warn({ err }, 'ws: presence.addConnection failed')
          })
        }).catch((err) => {
          helloPending = false
          app.log.error({ err }, 'ws: authorizeHello failed')
          try { socket.close(1011, 'internal-error') } catch { /* ignore */ }
        })
        return
      }

      if (conn) dispatchClientEvent(conn, ev)
    })

    socket.on('close', () => {
      releaseIpSlot(req.ip)
      clearTimeout(helloTimeout)
      if (conn) {
        conn.cleanup()
        registry.remove(conn)
        void presence.removeConnection(conn.userId).catch((err: unknown) => {
          app.log.warn({ err }, 'ws: presence.removeConnection failed')
        })
      }
    })

    socket.on('error', (err: Error) => {
      app.log.debug({ err: err.message }, 'ws: socket error')
    })
  })
}
