import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import Fastify from 'fastify'
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod'
import { eq } from 'drizzle-orm'
import { migrate } from 'drizzle-orm/postgres-js/migrator'
import { WebhookEvent } from 'livekit-server-sdk'
import type * as Guido from '../media/guido.js'

vi.mock('../ws/broadcast.js', () => ({ broadcastToChannel: vi.fn().mockResolvedValue(undefined), broadcastToUser: vi.fn().mockResolvedValue(undefined), broadcastToServer: vi.fn().mockResolvedValue(undefined) }))
vi.mock('../lib/audit.js', () => ({ audit: { log: vi.fn() } }))
vi.mock('../lib/redis.js', () => ({ redis: { get: vi.fn().mockResolvedValue(null), set: vi.fn().mockResolvedValue('OK'), sadd: vi.fn().mockResolvedValue(1), srem: vi.fn().mockResolvedValue(1), hdel: vi.fn().mockResolvedValue(1), del: vi.fn().mockResolvedValue(1), hgetall: vi.fn().mockResolvedValue({}) } }))
vi.mock('../media/guido.js', async (importOriginal) => ({
  ...await importOriginal<typeof Guido>(),
  revokeUser: vi.fn().mockResolvedValue(undefined), listActiveVoiceChannels: vi.fn().mockResolvedValue([]),
  listParticipants: vi.fn().mockResolvedValue([]), issueToken: vi.fn(),
}))
import { db, sql } from '../lib/db.js'
import { channels, serverMembers, servers, users } from '../db/schema.js'
import { redis } from '../lib/redis.js'
import { broadcastToServer } from '../ws/broadcast.js'
import { issueToken, listActiveVoiceChannels, listParticipants, revokeUser } from '../media/guido.js'
import { enforceVoiceEventAccess, reconcileVoiceAccess } from '../media/revocation.js'
import { serversRoutes } from './servers.js'
import { voiceRoutes } from './voice.js'

// No production services: only ops/test-postgres.mjs opts into a disposable DB.
describe.skipIf(!process.env.AUDIT_DATABASE_URL)('membership HTTP and media reconciliation', () => {
  const owner = randomUUID(), member = randomUUID()
  let actor: string, serverId: string, roomId: string, secondRoom: string
  const app = Fastify()
  beforeAll(async () => {
    await migrate(db, { migrationsFolder: './drizzle' })
    app.setValidatorCompiler(validatorCompiler); app.setSerializerCompiler(serializerCompiler)
    app.decorate('authenticate', async (req) => { req.authUser = { id: actor, username: 'test' } })
    app.setErrorHandler((err, _req, reply) => {
      const e = err as { statusCode?: number; code?: string; message?: string }
      return reply.code(e.statusCode ?? 500).send({ error: { code: e.code ?? 'internal-error', message: e.message ?? 'error' } })
    })
    await app.register(serversRoutes, { prefix: '/api' }); await app.register(voiceRoutes, { prefix: '/api' }); await app.ready()
  })
  beforeEach(async () => {
    vi.clearAllMocks(); vi.restoreAllMocks()
    vi.mocked(revokeUser).mockResolvedValue(undefined)
    vi.mocked(listActiveVoiceChannels).mockResolvedValue([])
    vi.mocked(listParticipants).mockResolvedValue([])
    vi.mocked(broadcastToServer).mockResolvedValue(undefined)
    vi.mocked(redis.srem).mockResolvedValue(1)
    actor = owner
    await sql.unsafe('TRUNCATE users, servers CASCADE')
    await db.insert(users).values([owner, member].map((id, i) => ({ id, username: 'voice' + i, displayName: 'Voice ' + i, email: 'voice' + i + '@example.com', passwordHash: 'unused' })))
    const [server] = await db.insert(servers).values({ name: 'private' }).returning(); serverId = server!.id
    await db.insert(serverMembers).values([{ serverId, userId: owner, role: 'owner' }, { serverId, userId: member, role: 'member' }])
    const rooms = await db.insert(channels).values([{ serverId, kind: 'voice', name: 'one' }, { serverId, kind: 'voice', name: 'two' }]).returning()
    roomId = rooms[0]!.id; secondRoom = rooms[1]!.id
    vi.mocked(issueToken).mockResolvedValue({ token: 'synthetic', url: 'ws://localhost:7880', room: 'voice-' + roomId })
  })
  afterAll(async () => { await app.close(); await sql.end() })
  const kick = () => app.inject({ method: 'DELETE', url: '/api/servers/' + serverId + '/members/' + member })
  const remaining = () => db.select().from(serverMembers).where(eq(serverMembers.userId, member))
  const participant = (userId: string) => ({ userId, displayName: 'Test', joinedAt: new Date().toISOString(), isPublishing: false, isScreenSharing: false, isMuted: false })

  it('kicks a member from all voice channels after committing membership removal', async () => {
    vi.mocked(revokeUser).mockImplementation(async () => { expect(await remaining()).toHaveLength(0) })
    const response = await kick(); expect(response.statusCode, response.body).toBe(204)
    expect(revokeUser).toHaveBeenCalledWith({ channelId: roomId, userId: member })
    expect(revokeUser).toHaveBeenCalledWith({ channelId: secondRoom, userId: member })
    actor = member
    expect((await app.inject('/api/servers/' + serverId)).statusCode).toBe(403)
    expect((await app.inject({ method: 'POST', url: '/api/voice/' + roomId + '/join', payload: {} })).statusCode).toBe(403)
  })
  it('revokes voice on voluntary leave too', async () => {
    actor = member
    const response = await app.inject({ method: 'DELETE', url: '/api/servers/' + serverId + '/members/me' })
    expect(response.statusCode, response.body).toBe(204)
    expect(await remaining()).toHaveLength(0); expect(revokeUser).toHaveBeenCalledTimes(2)
  })
  it('does not allow an ordinary member to kick the owner', async () => {
    actor = member
    const response = await app.inject({ method: 'DELETE', url: '/api/servers/' + serverId + '/members/' + owner })
    expect(response.statusCode).toBe(403); expect(revokeUser).not.toHaveBeenCalled()
  })
  it('reports SFU failure without restoring membership, then retries from durable absence', async () => {
    vi.mocked(revokeUser).mockRejectedValueOnce(new Error('synthetic SFU outage'))
    const response = await kick(); expect(response.statusCode, response.body).toBe(503)
    expect(response.json()).toMatchObject({ error: { code: 'voice-revocation-pending' } })
    expect(await remaining()).toHaveLength(0)
    // The other room was still attempted despite the first failure.
    expect(revokeUser).toHaveBeenCalledTimes(2)
    vi.mocked(listActiveVoiceChannels).mockResolvedValue([roomId])
    vi.mocked(listParticipants).mockResolvedValue([participant(member)])
    await reconcileVoiceAccess()
    expect(revokeUser).toHaveBeenCalledTimes(3)
  })
  it('does not let Redis failure prevent SFU revocation', async () => {
    vi.mocked(broadcastToServer).mockRejectedValue(new Error('synthetic pubsub outage'))
    vi.mocked(redis.srem).mockRejectedValue(new Error('synthetic cache outage'))
    const response = await kick(); expect(response.statusCode, response.body).toBe(204)
    expect(revokeUser).toHaveBeenCalledTimes(2)
  })
  it('reconciles lost webhooks and orphaned rooms, leaving authorized users alone', async () => {
    const orphan = randomUUID()
    await db.delete(serverMembers).where(eq(serverMembers.userId, member))
    vi.mocked(listActiveVoiceChannels).mockResolvedValue([roomId, orphan])
    vi.mocked(listParticipants).mockImplementation(async (channelId) => channelId === orphan ? [participant(owner)] : [participant(member), participant(owner)])
    await reconcileVoiceAccess()
    expect(revokeUser).toHaveBeenCalledTimes(2)
    expect(revokeUser).toHaveBeenCalledWith({ channelId: roomId, userId: member })
    expect(revokeUser).toHaveBeenCalledWith({ channelId: orphan, userId: owner })
  })
  it('fails closed on database errors while inspecting live voice access', async () => {
    vi.mocked(listActiveVoiceChannels).mockResolvedValue([roomId])
    vi.mocked(listParticipants).mockResolvedValue([participant(member)])
    vi.spyOn(db, 'select').mockImplementationOnce(() => { throw new Error('synthetic DB outage') })
    await reconcileVoiceAccess()
    expect(revokeUser).toHaveBeenCalledWith({ channelId: roomId, userId: member })
  })
  it('enforces webhook participants using the user portion of a device identity', async () => {
    const event = WebhookEvent.fromJson({ event: 'participant_joined', room: { name: 'voice-' + roomId }, participant: { identity: member + ':desktop' } })
    expect(await enforceVoiceEventAccess(event)).toBe(true)
    await db.delete(serverMembers).where(eq(serverMembers.userId, member))
    expect(await enforceVoiceEventAccess(event)).toBe(false)
    expect(revokeUser).toHaveBeenCalledWith({ channelId: roomId, userId: member })
  })
  it('rejects a token response when membership was removed during token issuance', async () => {
    actor = member
    vi.mocked(issueToken).mockImplementation(async () => {
      await db.delete(serverMembers).where(eq(serverMembers.userId, member))
      return { token: 'MUST_NOT_LEAK', url: 'ws://localhost:7880', room: 'voice-' + roomId }
    })
    const response = await app.inject({ method: 'POST', url: '/api/voice/' + roomId + '/join', payload: {} })
    expect(response.statusCode, response.body).toBe(403)
    expect(response.body).not.toContain('MUST_NOT_LEAK')
  })
})
