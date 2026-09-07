import { randomUUID } from 'node:crypto'
import type { SendMessageRequest } from '@kakdela/ginzu'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import Fastify from 'fastify'
import cookie from '@fastify/cookie'
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod'
import { eq, sql as sqlQuery } from 'drizzle-orm'
import { migrate } from 'drizzle-orm/postgres-js/migrator'
vi.mock('../ws/broadcast.js', () => ({ broadcastToChannel: vi.fn().mockResolvedValue(undefined), broadcastToUser: vi.fn().mockResolvedValue(undefined), broadcastToServer: vi.fn().mockResolvedValue(undefined) }))
vi.mock('../lib/redis.js', () => ({ redis: { get: vi.fn().mockResolvedValue(null), set: vi.fn().mockResolvedValue('OK'), mget: vi.fn().mockResolvedValue([]) } }))
vi.mock('../presence/store.js', () => ({ presence: { getStatusBulk: vi.fn().mockResolvedValue(new Map()) } }))
import { db, sql } from '../lib/db.js'
import { channels, dmChannels, files, invites, messages, serverMembers, servers, sessions, users } from '../db/schema.js'
import { authRoutes } from './auth.js'
import { messagesRoutes } from './messages.js'

// Opt-in ONLY through ops/test-postgres.mjs (random local port, disposable database).
describe.skipIf(!process.env.AUDIT_DATABASE_URL)('audit HTTP + real PostgreSQL regressions', () => {
  const actor = randomUUID(), peer = randomUUID(), other = randomUUID()
  let channelId: string, privateChannel: string
  const app = Fastify()
  beforeAll(async () => {
    await migrate(db, { migrationsFolder: './drizzle' })
    app.setValidatorCompiler(validatorCompiler)
    app.setSerializerCompiler(serializerCompiler)
    await app.register(cookie)
    app.decorate('authenticate', async (req) => { req.authUser = { id: actor, username: 'actor' } })
    app.setErrorHandler((err, _req, reply) => {
      const error = err as { statusCode?: number; code?: string; message?: string }
      return reply.code(error.statusCode ?? 500).send({ error: { code: error.code ?? 'internal-error', message: error.message ?? 'error' } })
    })
    await app.register(authRoutes, { prefix: '/api' })
    await app.register(messagesRoutes, { prefix: '/api' })
    await app.ready()
  }, 30000)
  beforeEach(async () => {
    await sql.unsafe('DROP TRIGGER IF EXISTS audit_fail_session ON sessions')
    await sql.unsafe('TRUNCATE users, servers CASCADE')
    await db.insert(users).values([actor, peer, other].map((id, i) => ({ id, username: 'test' + i, displayName: 'Test ' + i, email: 'test' + i + '@example.com', passwordHash: 'unused' })))
    const rows = await db.insert(channels).values([{ name: 'accessible', kind: 'dm' }, { name: 'private', kind: 'dm' }]).returning()
    channelId = rows[0]!.id; privateChannel = rows[1]!.id
    await db.insert(dmChannels).values([{ channelId, userAId: actor, userBId: peer }, { channelId: privateChannel, userAId: peer, userBId: other }])
  })
  afterAll(async () => { await app.close(); await sql.end() })
  const send = (payload: SendMessageRequest) => app.inject({ method: 'POST', url: '/api/channels/' + channelId + '/messages', payload })
  const countMessages = async () => (await db.select({ n: sqlQuery<number>`count(*)::int` }).from(messages))[0]!.n

  it('rejects foreign replies before insertion and hides legacy invalid references', async () => {
    const [secret] = await db.insert(messages).values({ channelId: privateChannel, authorId: other, content: 'TOP SECRET CONTENT' }).returning()
    const res = await send({ content: 'reply', replyToId: secret!.id })
    expect(res.statusCode, res.body).toBe(422)
    expect(await countMessages()).toBe(1)
    await db.insert(messages).values({ channelId, authorId: actor, content: 'legacy', replyToId: secret!.id })
    const read = await app.inject('/api/channels/' + channelId + '/messages')
    expect(read.statusCode, read.body).toBe(200)
    expect(read.body).not.toContain('TOP SECRET CONTENT')
  })
  it('rolls back a message when an attachment is invalid', async () => {
    const res = await send({ content: 'bad attachment', attachments: [randomUUID()] })
    expect(res.statusCode, res.body).toBe(422)
    expect(await countMessages()).toBe(0)
  })
  it('serializes concurrent nonce retries and rejects payload reuse', async () => {
    const nonce = randomUUID()
    const responses = await Promise.all(Array.from({ length: 5 }, () => send({ content: 'same payload', clientNonce: nonce })))
    for (const res of responses) expect(res.statusCode, res.body).toBe(201)
    expect(await countMessages()).toBe(1)
    expect((await send({ content: 'different', clientNonce: nonce })).statusCode).toBe(409)
  })
  it('allows only one message to claim an attachment', async () => {
    const [file] = await db.insert(files).values({ ownerId: actor, key: 'synthetic.txt', originalName: 'test.txt', contentType: 'text/plain', sizeBytes: 4, status: 'ready' }).returning()
    const responses = await Promise.all([send({ content: 'first', attachments: [file!.id] }), send({ content: 'second', attachments: [file!.id] })])
    expect(responses.map((r) => r.statusCode).sort()).toEqual([201, 422])
    expect(await countMessages()).toBe(1)
  })
  // Leave exactly one pool connection available. Nested global-db reads inside
  // a transaction would wait forever for another connection; release on failure.
  async function withLastPoolConnection<T>(operation: () => PromiseLike<T>): Promise<T> {
    const held: Awaited<ReturnType<typeof sql.reserve>>[] = []
    let timer: ReturnType<typeof setTimeout> | undefined
    let pending: Promise<T> | undefined
    try {
      for (let i = 1; i < sql.options.max; i += 1) held.push(await sql.reserve())
      pending = Promise.resolve().then(operation)
      return await Promise.race([
        pending,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error('transaction requested another pool connection')), 3000)
        }),
      ])
    } finally {
      clearTimeout(timer)
      for (const connection of held) connection.release()
      // Do not leave an unfinished HTTP operation running into the next fixture.
      await pending?.catch(() => undefined)
    }
  }
  it('replays a nonce using only the transaction connection', async () => {
    const payload = { content: 'same payload', clientNonce: randomUUID() }
    expect((await send(payload)).statusCode).toBe(201)
    const replay = await withLastPoolConnection(() => send(payload))
    expect(replay.statusCode, replay.body).toBe(201)
    expect(await countMessages()).toBe(1)
  })
  it('checks server slow mode and member permissions on the transaction connection', async () => {
    const [server] = await db.insert(servers).values({ name: 'pool regression' }).returning()
    await db.insert(serverMembers).values({ serverId: server!.id, userId: actor, role: 'member' })
    const [channel] = await db.insert(channels).values({ name: 'slow mode', kind: 'text', serverId: server!.id, slowModeSec: 30 }).returning()
    const response = await withLastPoolConnection(() => app.inject({
      method: 'POST', url: '/api/channels/' + channel!.id + '/messages', payload: { content: 'server message' },
    }))
    expect(response.statusCode, response.body).toBe(201)
  })
  async function failSessionInsert() {
    await sql.unsafe("CREATE OR REPLACE FUNCTION audit_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic session failure'; END $$")
    await sql.unsafe('CREATE TRIGGER audit_fail_session BEFORE INSERT ON sessions FOR EACH ROW EXECUTE FUNCTION audit_fail()')
  }
  async function makeInvite() {
    const [server] = await db.insert(servers).values({ name: 'test server' }).returning()
    await db.insert(invites).values({ code: 'audittest', serverId: server!.id, maxUses: 1 })
  }
  const register = () => app.inject({ method: 'POST', url: '/api/auth/register', headers: { 'x-kd-client': 'tauri' }, payload: { username: 'new_account', displayName: 'New', email: 'new@example.com', password: 'test-password-long-123', inviteCode: 'audittest' } })
  it('rolls back invite, user and membership if session creation fails', async () => {
    await makeInvite(); await failSessionInsert()
    const res = await register()
    expect(res.statusCode, res.body).toBe(500)
    expect((await db.select().from(invites))[0]!.useCount).toBe(0)
    expect(await db.select().from(users).where(eq(users.username, 'new_account'))).toHaveLength(0)
    await sql.unsafe('DROP TRIGGER audit_fail_session ON sessions')
    expect((await register()).statusCode).toBe(200)
  })
  it('preserves the old refresh session when replacement insertion fails', async () => {
    await makeInvite()
    const registered = await register()
    expect(registered.statusCode, registered.body).toBe(200)
    const { refreshToken } = registered.json() as { refreshToken: string }
    expect(refreshToken).toBeTruthy()
    await failSessionInsert()
    const refresh = () => app.inject({ method: 'POST', url: '/api/auth/refresh', payload: { refreshToken } })
    expect((await refresh()).statusCode).toBe(500)
    expect(await db.select().from(sessions)).toHaveLength(1)
    await sql.unsafe('DROP TRIGGER audit_fail_session ON sessions')
    expect((await refresh()).statusCode).toBe(200)
  })
})
