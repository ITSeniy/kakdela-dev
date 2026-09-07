import { createHash, randomUUID } from 'node:crypto'

import Fastify from 'fastify'
import { SignJWT } from 'jose'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../media/revocation.js', () => ({ enforceVoiceEventAccess: vi.fn().mockResolvedValue(true) }))
vi.mock('../media/webhook.js', () => ({ alreadyProcessed: vi.fn().mockResolvedValue(false), handleWebhookEvent: vi.fn().mockResolvedValue(undefined) }))
import { env } from '../env.js'
import { enforceVoiceEventAccess } from '../media/revocation.js'
import { alreadyProcessed, handleWebhookEvent } from '../media/webhook.js'
import { internalRoutes } from './internal.js'

describe('LiveKit security checks precede webhook dedup', () => {
  const app = Fastify()
  beforeAll(async () => { await app.register(internalRoutes, { prefix: '/api' }); await app.ready() })
  afterAll(async () => { await app.close() })
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(enforceVoiceEventAccess).mockResolvedValue(true)
    vi.mocked(alreadyProcessed).mockResolvedValue(false)
  })
  async function webhook(validSignature = true) {
    const body = JSON.stringify({ id: randomUUID(), event: 'participant_joined', room: { name: 'voice-' + randomUUID() }, participant: { identity: randomUUID() + ':desktop' } })
    const auth = await new SignJWT({ sha256: createHash('sha256').update(body).digest('base64') })
      .setProtectedHeader({ alg: 'HS256' }).setIssuer(env.LIVEKIT_API_KEY).setExpirationTime('1m')
      .sign(new TextEncoder().encode(validSignature ? env.LIVEKIT_API_SECRET : 'synthetic-wrong-secret'))
    return app.inject({ method: 'POST', url: '/api/internal/livekit-webhook', headers: { 'content-type': 'application/webhook+json', authorization: auth }, payload: body })
  }
  it('rejects unauthenticated events before touching access or presence', async () => {
    expect((await webhook(false)).statusCode).toBe(401)
    expect(enforceVoiceEventAccess).not.toHaveBeenCalled()
    expect(alreadyProcessed).not.toHaveBeenCalled()
  })
  it('returns retryable 503 without marking a failed security check as seen', async () => {
    vi.mocked(enforceVoiceEventAccess).mockRejectedValueOnce(new Error('synthetic SFU outage'))
    expect((await webhook()).statusCode).toBe(503)
    expect(alreadyProcessed).not.toHaveBeenCalled(); expect(handleWebhookEvent).not.toHaveBeenCalled()
    expect((await webhook()).statusCode).toBe(200)
    expect(handleWebhookEvent).toHaveBeenCalledTimes(1)
  })
  it('does not broadcast presence for a removed participant', async () => {
    vi.mocked(enforceVoiceEventAccess).mockResolvedValue(false)
    const result = await webhook()
    expect(result.statusCode).toBe(200); expect(result.json()).toEqual({ ok: true, revoked: true })
    expect(alreadyProcessed).not.toHaveBeenCalled(); expect(handleWebhookEvent).not.toHaveBeenCalled()
  })
  it('rechecks access even if the event is already marked as seen', async () => {
    vi.mocked(alreadyProcessed).mockResolvedValue(true)
    expect((await webhook()).statusCode).toBe(200)
    expect(enforceVoiceEventAccess).toHaveBeenCalledTimes(1)
    expect(enforceVoiceEventAccess).toHaveBeenCalledBefore(alreadyProcessed)
    expect(handleWebhookEvent).not.toHaveBeenCalled()
  })
})
