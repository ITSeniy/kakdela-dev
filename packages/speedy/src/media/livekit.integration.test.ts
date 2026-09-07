import { randomUUID } from 'node:crypto'

import { afterAll, describe, expect, it, vi } from 'vitest'

vi.hoisted(() => {
  const url = process.env.AUDIT_LIVEKIT_URL
  if (!url) return
  if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(url)) throw new Error('only disposable loopback LiveKit is allowed')
  process.env.LIVEKIT_ADMIN_URL = url
  process.env.LIVEKIT_URL = url.replace('http:', 'ws:')
  process.env.LIVEKIT_API_KEY = 'auditkey'
  process.env.LIVEKIT_API_SECRET = 'synthetic-audit-livekit-secret-32chars'
})
import { issueToken, listActiveVoiceChannels, listParticipants, revokeUser } from './guido.js'

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
  it('removes all devices, but a still-valid token can rejoin (known open security gap)', async () => {
    const desktop = await issueToken({ userId, channelId, deviceId: 'desktop', displayName: 'Test' })
    const mobile = await issueToken({ userId, channelId, deviceId: 'mobile', displayName: 'Test' })
    const peer = await issueToken({ userId: peerId, channelId, displayName: 'Peer' })
    await connect(desktop.url, desktop.token); await connect(mobile.url, mobile.token); await connect(peer.url, peer.token)
    await vi.waitFor(async () => { expect(await listParticipants(channelId)).toHaveLength(3) }, { timeout: 5000, interval: 50 })
    expect(await listActiveVoiceChannels()).toContain(channelId)
    await revokeUser({ channelId, userId })
    await vi.waitFor(async () => { expect((await listParticipants(channelId)).map((p) => p.userId)).toEqual([peerId]) }, { timeout: 5000, interval: 50 })
    // This expectation records the vulnerability, NOT successful authorization.
    // Replace it with a rejection assertion once a trusted admission boundary exists.
    await connect(desktop.url, desktop.token)
    await vi.waitFor(async () => { expect((await listParticipants(channelId)).map((p) => p.userId)).toContain(userId) }, { timeout: 5000, interval: 50 })
    console.log('Confirmed: all devices removed; original JWT admitted again. Strict media revocation remains OPEN.')
    await revokeUser({ channelId, userId }); await revokeUser({ channelId, userId: peerId })
  }, 25000)
})
