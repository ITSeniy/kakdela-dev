import { randomUUID } from 'node:crypto'

import { AccessToken } from 'livekit-server-sdk'

import { afterAll, describe, expect, it, vi } from 'vitest'

vi.hoisted(() => {
  const url = process.env.AUDIT_LIVEKIT_URL
  if (!url) return
  if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(url)) throw new Error('only disposable loopback LiveKit is allowed')
  process.env.LIVEKIT_ADMIN_URL = url
  process.env.LIVEKIT_URL = 'ws://127.0.0.1:9/livekit'
  process.env.LIVEKIT_API_KEY = 'auditkey'
  process.env.LIVEKIT_API_SECRET = 'synthetic-audit-livekit-secret-32chars'
})
import { issueToken, listActiveVoiceChannels, listParticipants, revokeUser } from './guido.js'
import { env } from '../env.js'

// Signaling only. No camera, microphone, RTP, external rooms or existing containers.
describe.skipIf(!process.env.AUDIT_LIVEKIT_URL)('disposable self-hosted LiveKit characterization', () => {
  const sockets: WebSocket[] = []
  const channelId = randomUUID(), userId = randomUUID(), peerId = randomUUID()
  afterAll(() => { for (const socket of sockets) socket.close() })
  async function connect(url: string, token: string) {
    const socket = new WebSocket(url + '/rtc?protocol=15&auto_subscribe=1&access_token=' + encodeURIComponent(token))
    sockets.push(socket)
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { socket.close(); reject(new Error('signaling timeout')) }, 5000)
      socket.addEventListener('open', () => { clearTimeout(timer); resolve() }, { once: true })
      socket.addEventListener('error', () => { clearTimeout(timer); reject(new Error('signaling connection failed')) }, { once: true })
    })
    return socket
  }
  async function legacy(identity: string) {
    const token = new AccessToken(env.LIVEKIT_API_KEY, env.LIVEKIT_API_SECRET, { identity, ttl: 600 })
    token.addGrant({ roomJoin: true, room: 'voice-' + channelId, canPublish: true, canSubscribe: true, canPublishData: true })
    return { token: await token.toJwt(), url: process.env.AUDIT_LIVEKIT_URL!.replace('http:', 'ws:') }
  }
  it('rejects public gateway tickets at the SFU itself', async () => {
    const ticket = await issueToken({ userId, channelId, displayName: 'Test' })
    await expect(connect(process.env.AUDIT_LIVEKIT_URL!.replace('http:', 'ws:'), ticket.token)).rejects.toThrow()
  })
  it('demonstrates why direct SFU signaling must remain private: legacy JWTs are replayable', async () => {
    const desktop = await legacy(userId + ':desktop')
    const mobile = await legacy(userId + ':mobile')
    const peer = await legacy(peerId)
    await connect(desktop.url, desktop.token); await connect(mobile.url, mobile.token); await connect(peer.url, peer.token)
    await vi.waitFor(async () => { expect(await listParticipants(channelId)).toHaveLength(3) }, { timeout: 5000, interval: 50 })
    expect(await listActiveVoiceChannels()).toContain(channelId)
    await revokeUser({ channelId, userId })
    await vi.waitFor(async () => { expect((await listParticipants(channelId)).map((p) => p.userId)).toEqual([peerId]) }, { timeout: 5000, interval: 50 })
    // Deliberate bypass inside this disposable test. Public-gateway rejection is
    // covered separately by admission.integration.test.ts, including refresh tokens.
    await connect(desktop.url, desktop.token)
    await vi.waitFor(async () => { expect((await listParticipants(channelId)).map((p) => p.userId)).toContain(userId) }, { timeout: 5000, interval: 50 })
    console.log('Direct SFU still accepts legacy JWT replay; never expose its signaling port.')
    await revokeUser({ channelId, userId }); await revokeUser({ channelId, userId: peerId })
  }, 25000)
})
