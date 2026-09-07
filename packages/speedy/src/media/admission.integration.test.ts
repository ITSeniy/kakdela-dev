import { randomUUID } from 'node:crypto'
import { fork, type ChildProcess } from 'node:child_process'
import { fileURLToPath } from 'node:url'

import Fastify from 'fastify'
import websocket from '@fastify/websocket'
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod'
import { SignalResponse, ClientConfigSetting } from '@livekit/protocol'
import { AccessToken } from 'livekit-server-sdk'
import { WebSocket } from 'ws'
import { eq } from 'drizzle-orm'
import { migrate } from 'drizzle-orm/postgres-js/migrator'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

vi.hoisted(() => {
  const url = process.env.AUDIT_ADMISSION_URL
  if (!url) return
  if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(url) || !process.env.AUDIT_DATABASE_URL)
    throw new Error('dedicated admission runner required')
  process.env.LIVEKIT_ADMIN_URL = url
  process.env.LIVEKIT_URL = 'ws://127.0.0.1:9/livekit'
  process.env.LIVEKIT_API_KEY = 'auditkey'
  process.env.LIVEKIT_API_SECRET = 'synthetic-audit-livekit-secret-32chars'
})
vi.mock('../lib/redis.js', () => ({
  redis: {
    srem: vi.fn().mockResolvedValue(1),
    hdel: vi.fn().mockResolvedValue(1),
    del: vi.fn().mockResolvedValue(1),
  },
}))
vi.mock('../ws/broadcast.js', () => ({
  broadcastToServer: vi.fn().mockRejectedValue(new Error('deliberately lost pubsub event')),
}))
vi.mock('../lib/audit.js', () => ({ audit: { log: vi.fn() } }))
import { env } from '../env.js'
import { db, sql } from '../lib/db.js'
import { channels, serverMembers, servers, users, dmChannels } from '../db/schema.js'
import { serversRoutes } from '../routes/servers.js'
import { getRoomService, issueToken } from './guido.js'
import { createAdmissionGateway, type GatewayDependencies } from './admission-gateway.js'
import { withMediaAccess } from './admission-access.js'
import { createBootstrapToken, elevateParticipant } from './admission-sfu.js'
import { verifyAdmissionToken, verifySfuToken } from './admission-token.js'
import { revokeServerVoice } from './revocation.js'

const defaults: GatewayDependencies = {
  access: withMediaAccess,
  bootstrap: createBootstrapToken,
  elevate: elevateParticipant,
}
function deferred() {
  let release!: () => void
  const promise = new Promise<void>((resolve) => {
    release = resolve
  })
  return { promise, release }
}

describe.skipIf(!process.env.AUDIT_ADMISSION_URL)(
  'real SFU admission with PostgreSQL authorization',
  () => {
    const owner = randomUUID(),
      member = randomUUID()
    let serverId: string, channelId: string
    const clients: WebSocket[] = []
    const apps: ReturnType<typeof Fastify>[] = []
    const workers: ChildProcess[] = []
    const unblock: (() => void)[] = []
    const http = Fastify()
    beforeAll(async () => {
      await migrate(db, { migrationsFolder: './drizzle' })
      http.setValidatorCompiler(validatorCompiler)
      http.setSerializerCompiler(serializerCompiler)
      http.decorate('authenticate', async (req) => {
        req.authUser = { id: owner }
      })
      await http.register(serversRoutes, { prefix: '/api' })
      await http.ready()
    })
    beforeEach(async () => {
      await sql.unsafe('TRUNCATE users, servers CASCADE')
      await db
        .insert(users)
        .values(
          [owner, member].map((id, i) => ({
            id,
            username: 'gate' + i,
            displayName: 'Test ' + i,
            email: 'gate' + i + '@example.com',
            passwordHash: 'unused',
          })),
        )
      const [server] = await db.insert(servers).values({ name: 'Private' }).returning()
      serverId = server!.id
      await db.insert(serverMembers).values([
        { serverId, userId: owner, role: 'owner' },
        { serverId, userId: member, role: 'member' },
      ])
      const [channel] = await db
        .insert(channels)
        .values({ serverId, name: 'Private voice', kind: 'voice' })
        .returning()
      channelId = channel!.id
    })
    afterEach(async () => {
      for (const release of unblock.splice(0)) release()
      for (const client of clients.splice(0)) client.terminate()
      for (const child of [...workers]) await stopWorker(child)
      for (const app of apps.splice(0)) await app.close()
      for (const room of await getRoomService().listRooms())
        await getRoomService().deleteRoom(room.name)
      vi.restoreAllMocks()
    })
    afterAll(async () => {
      await http.close()
      // Fault-injection terminates a real backend; do not wait indefinitely for
      // that dead pool connection during disposable test teardown.
      await sql.end({ timeout: 2 })
    })

    async function stopWorker(child: ChildProcess) {
      const index = workers.indexOf(child)
      if (index >= 0) workers.splice(index, 1)
      if (child.exitCode !== null || child.signalCode !== null) return
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => child.kill(), 3000)
        child.once('exit', () => {
          clearTimeout(timer)
          resolve()
        })
        child.send('close')
      })
    }
    async function gateway(overrides: Partial<GatewayDependencies> = {}) {
      const app = Fastify()
      apps.push(app)
      await app.register(websocket, { options: { maxPayload: 65536 } })
      await app.register(createAdmissionGateway({ ...defaults, ...overrides }))
      await app.listen({ host: '127.0.0.1', port: 0 })
      const address = app.server.address()
      if (!address || typeof address === 'string') throw new Error('invalid test address')
      return 'ws://127.0.0.1:' + address.port + '/livekit'
    }
    async function worker() {
      const child = fork(
        fileURLToPath(new URL('../../test/admission-worker.ts', import.meta.url)),
        {
          execArgv: ['--import', 'tsx'],
          env: process.env,
          stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
        },
      )
      workers.push(child)
      child.stderr?.resume()
      return new Promise<string>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('test worker boot timeout')), 10000)
        child.once('message', (message) => {
          clearTimeout(timer)
          resolve('ws://127.0.0.1:' + (message as { port: number }).port + '/livekit')
        })
        child.once('exit', () => {
          clearTimeout(timer)
          reject(new Error('test worker exited'))
        })
      })
    }
    async function token(userId = member, deviceId = 'desktop') {
      return (await issueToken({ userId, channelId, displayName: 'Test', deviceId })).token
    }
    async function legacy(userId = member) {
      const t = new AccessToken(env.LIVEKIT_API_KEY, env.LIVEKIT_API_SECRET, {
        identity: userId + ':legacy',
        ttl: 600,
      })
      t.addGrant({
        roomJoin: true,
        room: 'voice-' + channelId,
        canPublish: true,
        canSubscribe: true,
        canPublishData: true,
      })
      return t.toJwt()
    }
    function connect(url: string, value: string, suffix = '') {
      const socket = new WebSocket(
        url + '/rtc?protocol=15&access_token=' + encodeURIComponent(value) + suffix,
      )
      clients.push(socket)
      const messages: SignalResponse[] = []
      let done!: (joined: boolean) => void
      const joined = new Promise<boolean>((resolve) => {
        done = resolve
      })
      socket.on('message', (data) => {
        const response = SignalResponse.fromBinary(new Uint8Array(data as Buffer))
        messages.push(response)
        if (response.message.case === 'join') done(true)
      })
      socket.on('error', () => done(false))
      socket.on('close', () => done(false))
      return { socket, messages, joined }
    }
    const kick = () =>
      http.inject({ method: 'DELETE', url: '/api/servers/' + serverId + '/members/' + member })
    const infos = () => getRoomService().listParticipants('voice-' + channelId)

    it.skipIf(process.env.AUDIT_MEDIA_SMOKE !== '1')(
      'carries real synthetic audio over the gate and stops delivery after HTTP kick',
      async () => {
        const url = await worker()
        const child = fork(
          fileURLToPath(new URL('../../../../ops/media-smoke/client.mjs', import.meta.url)),
          { execArgv: [], env: process.env, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] },
        )
        const events: { type: string; received?: number; message?: string }[] = []
        child.on('message', (message) => events.push(message as (typeof events)[number]))
        try {
          child.send({
            type: 'start',
            url,
            senderToken: await token(owner),
            receiverToken: await token(),
          })
          await vi.waitFor(
            () => {
              expect(events.find((e) => e.type === 'error')).toBeUndefined()
              expect(events.some((e) => e.type === 'ready')).toBe(true)
            },
            { timeout: 25000, interval: 100 },
          )
          expect((await kick()).statusCode).toBe(204)
          await new Promise((r) => setTimeout(r, 500))
          const counts = () => events.filter((e) => e.type === 'count')
          child.send({ type: 'count' })
          await vi.waitFor(() => expect(counts()).toHaveLength(1))
          await new Promise((r) => setTimeout(r, 500))
          child.send({ type: 'count' })
          await vi.waitFor(() => expect(counts()).toHaveLength(2))
          expect(counts()[1]!.received).toBe(counts()[0]!.received)
          expect((await infos()).map((p) => p.identity)).toEqual([owner + ':desktop'])
        } finally {
          if (child.exitCode === null && child.signalCode === null) {
            const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()))
            child.send({ type: 'close' })
            const timer = setTimeout(() => child.kill(), 3000)
            await exited
            clearTimeout(timer)
          }
        }
      },
      40000,
    )
    it('accepts one bearer token but rejects mixed or malformed credentials', async () => {
      const url = (await gateway()).replace('ws:', 'http:') + '/rtc/validate'
      const ticket = await token()
      expect((await fetch(url, { headers: { authorization: 'Bearer ' + ticket } })).status).toBe(
        200,
      )
      expect(
        (
          await fetch(url + '?access_token=' + ticket, {
            headers: { authorization: 'Bearer ' + ticket },
          })
        ).status,
      ).toBe(401)
      expect((await fetch(url, { headers: { authorization: 'Basic ' + ticket } })).status).toBe(401)
    })
    it('withholds signaling if the actual PostgreSQL connection dies after permission elevation', async () => {
      const url = await gateway({
        elevate: async (a) => {
          const participant = await elevateParticipant(a)
          const victims = await sql.unsafe(
            "SELECT pid FROM pg_stat_activity WHERE datname = current_database() AND pid <> pg_backend_pid() AND state = 'idle in transaction' AND query LIKE '%server_members%'",
          )
          expect(victims).toHaveLength(1)
          await sql.unsafe('SELECT pg_terminate_backend($1)', [victims[0]!.pid])
          return participant
        },
      })
      const client = connect(url, await token())
      expect(await client.joined).toBe(false)
      expect(client.messages).toHaveLength(0)
      expect((await kick()).statusCode).toBe(204)
    })
    it('canonicalizes uppercase UUIDs so kick targets the actual SFU room and identity', async () => {
      const url = await gateway()
      const ticket = (
        await issueToken({
          userId: member.toUpperCase(),
          channelId: channelId.toUpperCase(),
          displayName: 'Test',
          deviceId: 'Desktop-A',
        })
      ).token
      expect(await connect(url, ticket).joined).toBe(true)
      await vi.waitFor(async () =>
        expect((await infos()).map((p) => p.identity)).toEqual([member + ':Desktop-A']),
      )
      expect((await getRoomService().listRooms()).map((r) => r.name)).toEqual([
        'voice-' + channelId,
      ])
      expect(
        (
          await http.inject({
            method: 'DELETE',
            url: '/api/servers/' + serverId.toUpperCase() + '/members/' + member.toUpperCase(),
          })
        ).statusCode,
      ).toBe(204)
      expect(await infos()).toHaveLength(0)
      expect(await connect(url, ticket).joined).toBe(false)
    })
    it('rejoins with a refreshed ticket after a gateway restart, but not after revocation', async () => {
      const a = await worker(),
        original = await token()
      const client = connect(a, original)
      expect(await client.joined).toBe(true)
      await vi.waitFor(() =>
        expect(client.messages.some((m) => m.message.case === 'refreshToken')).toBe(true),
      )
      const message = client.messages.find((m) => m.message.case === 'refreshToken')!.message
      if (message.case !== 'refreshToken') throw new Error('missing refresh')
      await stopWorker(workers[0]!)
      const b = await worker()
      expect(await connect(b, message.value).joined).toBe(true)
      expect((await kick()).statusCode).toBe(204)
      expect(await connect(b, message.value).joined).toBe(false)
    }, 20000)
    it('does not leak or forward queued SDP while authorization is unresolved', async () => {
      const paused = deferred(),
        entered = deferred()
      unblock.push(paused.release)
      const url = await gateway({
        elevate: async (a) => {
          entered.release()
          await paused.promise
          return elevateParticipant(a)
        },
      })
      const client = connect(url, await token())
      await entered.promise
      // Malformed synthetic SDP would cause a protocol failure if forwarded early.
      client.socket.send(JSON.stringify({ offer: { type: 'offer', sdp: 'must-not-reach-sfu' } }))
      await new Promise((r) => setTimeout(r, 100))
      expect(client.messages).toHaveLength(0)
      expect(client.socket.readyState).toBe(WebSocket.OPEN)
      client.socket.terminate()
      await vi.waitFor(() => expect(client.socket.readyState).toBe(WebSocket.CLOSED))
      paused.release()
      expect(await client.joined).toBe(false)
      expect(client.messages).toHaveLength(0)
    })
    it('bounds pre-admission client buffering', async () => {
      const paused = deferred(),
        entered = deferred()
      unblock.push(paused.release)
      const url = await gateway({
        bootstrap: async (a) => {
          entered.release()
          await paused.promise
          return createBootstrapToken(a)
        },
      })
      const client = connect(url, await token())
      await entered.promise
      for (let i = 0; i < 129; i++) client.socket.send(Buffer.from([0]))
      expect(await client.joined).toBe(false)
      expect(client.messages).toHaveLength(0)
      paused.release()
      expect(await getRoomService().listRooms()).toHaveLength(0)
    })
    it('checks authoritative channel kind, DM parties, and membership on validate and join', async () => {
      const url = await gateway()
      const values = [
        await token(randomUUID()),
        (await issueToken({ userId: member, channelId: randomUUID(), displayName: 'Test' })).token,
        (
          await issueToken({
            userId: member,
            channelId,
            room: 'dm-' + channelId,
            displayName: 'Test',
          })
        ).token,
      ]
      const [dm] = await db
        .insert(channels)
        .values({ serverId: null, name: '', kind: 'dm' })
        .returning()
      await db.insert(dmChannels).values({ channelId: dm!.id, userAId: owner, userBId: owner })
      values.push(
        (
          await issueToken({
            userId: member,
            channelId: dm!.id,
            room: 'dm-' + dm!.id,
            displayName: 'Test',
          })
        ).token,
      )
      for (const value of values) {
        const response = await fetch(
          url.replace('ws:', 'http:') + '/rtc/validate?access_token=' + value,
        )
        expect(response.status).toBe(403)
        expect(await connect(url, value).joined).toBe(false)
      }
      expect(await getRoomService().listRooms()).toHaveLength(0)
    })
    it('admits a current member only after SFU permission elevation', async () => {
      const url = await gateway()
      const client = connect(url, await token())
      expect(await client.joined).toBe(true)
      await vi.waitFor(async () => expect((await infos()).length).toBe(1))
      const participant = (await infos())[0]!
      expect(participant.permission).toMatchObject({
        canPublish: true,
        canSubscribe: true,
        canPublishData: true,
      })
      const join = client.messages.find((m) => m.message.case === 'join')!.message
      if (join.case !== 'join') throw new Error('missing join')
      expect(join.value.clientConfiguration?.resumeConnection).toBe(ClientConfigSetting.DISABLED)
    })
    it('blocks original, legacy and refreshed tickets after HTTP kick across two real workers without pubsub', async () => {
      const [a, b] = await Promise.all([worker(), worker()])
      const original = await token(),
        mobile = await token(member, 'mobile'),
        old = await legacy()
      const one = connect(a, original),
        two = connect(b, mobile),
        peer = connect(b, await token(owner))
      expect(await one.joined).toBe(true)
      expect(await two.joined).toBe(true)
      expect(await peer.joined).toBe(true)
      await vi.waitFor(
        () => expect(one.messages.some((m) => m.message.case === 'refreshToken')).toBe(true),
        { timeout: 3000 },
      )
      const refreshed = one.messages.find((m) => m.message.case === 'refreshToken')!.message
      if (refreshed.case !== 'refreshToken') throw new Error('missing refresh')
      await expect(verifySfuToken(refreshed.value)).rejects.toThrow()
      expect((await verifyAdmissionToken(refreshed.value)).userId).toBe(member)
      expect(await verifyAdmissionToken(refreshed.value)).toMatchObject({
        canPublish: true,
        canSubscribe: true,
        canPublishData: true,
      })
      await vi.waitFor(async () => expect(await infos()).toHaveLength(3))
      const result = await kick()
      expect(result.statusCode, result.body).toBe(204)
      for (const ticket of [original, mobile, old, refreshed.value])
        expect(await connect(b, ticket).joined).toBe(false)
      expect((await infos()).every((p) => p.identity.startsWith(owner))).toBe(true)
      expect(peer.socket.readyState).toBe(WebSocket.OPEN)
    }, 20000)
    it('never forwards a pending bootstrap join that races with completed revocation', async () => {
      const paused = deferred(),
        entered = deferred()
      unblock.push(paused.release)
      const url = await gateway({
        bootstrap: async (a) => {
          entered.release()
          await paused.promise
          return createBootstrapToken(a)
        },
      })
      const client = connect(url, await token())
      await entered.promise
      // Simulate revocation on another process: no local gateway registry notification.
      await db.delete(serverMembers).where(eq(serverMembers.userId, member))
      await revokeServerVoice(member, serverId)
      paused.release()
      expect(await client.joined).toBe(false)
      expect(client.messages).toHaveLength(0)
      const remaining = await infos().catch(() => [])
      for (const p of remaining)
        expect(p.permission).toMatchObject({
          canPublish: false,
          canSubscribe: false,
          canPublishData: false,
        })
    })
    it('serializes kick behind an in-flight elevation, then denies reconnect', async () => {
      const paused = deferred(),
        entered = deferred()
      unblock.push(paused.release)
      const url = await gateway({
        elevate: async (a) => {
          entered.release()
          await paused.promise
          return elevateParticipant(a)
        },
      })
      const ticket = await token(),
        client = connect(url, ticket)
      await entered.promise
      const pending = Promise.resolve(kick())
      await vi.waitFor(
        async () => {
          const locks = await sql.unsafe(
            "SELECT count(*)::int AS n FROM pg_locks WHERE NOT granted AND locktype = 'transactionid'",
          )
          expect(locks[0]?.['n']).toBeGreaterThan(0)
        },
        { timeout: 1500 },
      )
      expect(client.messages).toHaveLength(0)
      paused.release()
      expect((await pending).statusCode).toBe(204)
      expect(await connect(url, ticket).joined).toBe(false)
    })
    it('does not release signaling when the DB transaction fails after a successful SFU RPC', async () => {
      let calls = 0
      const url = await gateway({
        access: async (a, cb) => {
          const value = await withMediaAccess(a, cb)
          if (++calls === 2) throw new Error('synthetic commit failure')
          return value
        },
      })
      const client = connect(url, await token())
      expect(await client.joined).toBe(false)
      expect(client.messages).toHaveLength(0)
    })
    it('fails closed on elevation error and on unavailable authorization', async () => {
      const failedRpc = await gateway({
        elevate: async () => {
          throw new Error('synthetic RPC failure')
        },
      })
      expect(await connect(failedRpc, await token()).joined).toBe(false)
      const failedDb = await gateway({
        access: async () => {
          throw new Error('synthetic DB failure')
        },
      })
      expect(await connect(failedDb, await token()).joined).toBe(false)
    })
    it('rejects query overrides and direct SFU API paths', async () => {
      const url = await gateway(),
        ticket = await token()
      for (const suffix of [
        '&publish=admin',
        '&join_request=embedded-sdp',
        '&access_token=duplicate',
        '&identity=other',
      ]) {
        expect(await connect(url, ticket, suffix).joined).toBe(false)
      }
      expect(
        (
          await fetch(url.replace('ws:', 'http:') + '/twirp/livekit.RoomService/ListRooms', {
            method: 'POST',
          })
        ).status,
      ).toBe(404)
      expect(
        (await fetch(url.replace('ws:', 'http:') + '/rtc/v1/validate?access_token=' + ticket))
          .status,
      ).toBe(404)
      expect(await getRoomService().listRooms()).toHaveLength(0)
    })
    it('requires full reconnect instead of resuming an old DTLS session', async () => {
      const url = await gateway(),
        ticket = await token()
      const client = connect(url, ticket, '&reconnect=1&sid=old-session')
      expect(await client.joined).toBe(false)
      expect(client.messages.some((m) => m.message.case === 'leave')).toBe(true)
      expect(await getRoomService().listRooms()).toHaveLength(0)
    })
    it('keeps legitimate DM access separate from server membership', async () => {
      const [channel] = await db.insert(channels).values({ kind: 'dm', name: 'DM' }).returning()
      await db
        .insert(dmChannels)
        .values({ channelId: channel!.id, userAId: owner, userBId: member })
      await db.delete(serverMembers).where(eq(serverMembers.userId, member))
      const url = await gateway()
      const ticket = (
        await issueToken({
          userId: member,
          channelId: channel!.id,
          room: 'dm-' + channel!.id,
          displayName: 'Test',
        })
      ).token
      expect(await connect(url, ticket).joined).toBe(true)
    })
  },
)
