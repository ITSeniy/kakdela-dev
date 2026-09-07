import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { User } from '@kakdela/ginzu'
vi.mock('../../../polly/src/lib/host/secrets.js', () => ({ secrets: { get: vi.fn().mockResolvedValue(null), set: vi.fn().mockResolvedValue(undefined) } }))
vi.mock('../../../polly/src/lib/serverUrl.js', () => ({ SPEEDY_URL: 'http://' + 'invalid.invalid' }))
import { apiFetch, refreshSession } from '../../../polly/src/lib/api.js'
import { useAuthStore } from '../../../polly/src/features/auth/store.js'
const user: User = { id: '11111111-1111-4111-8111-111111111111', username: 'a', displayName: 'A', avatarUrl: null, status: 'offline', customStatus: null }
beforeEach(() => { useAuthStore.getState().clear(); useAuthStore.getState().setSession(user, 'old-token') })
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers() })
describe('refresh session safety', () => {
  it.each([429, 500, 503])('retains credentials on refresh %s', async (status) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('', { status })))
    await expect(refreshSession()).rejects.toMatchObject({ status })
    expect(useAuthStore.getState().accessToken).toBe('old-token')
  })
  it('logs out only on genuine refresh 401', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('', { status: 401 })))
    await expect(apiFetch('/api/protected')).rejects.toMatchObject({ status: 401 })
    expect(useAuthStore.getState().user).toBeNull()
  })
  it('shares one refresh request across concurrent callers', async () => {
    const fetcher = vi.fn().mockResolvedValue(Response.json({ accessToken: 'new-token', user }))
    vi.stubGlobal('fetch', fetcher)
    expect(await Promise.all([refreshSession(), refreshSession(), refreshSession()])).toEqual(['new-token', 'new-token', 'new-token'])
    expect(fetcher).toHaveBeenCalledTimes(1)
  })
  it('cannot resurrect a session after logout', async () => {
    let finish!: (value: Response) => void
    const fetcher = vi.fn(() => new Promise<Response>((resolve) => { finish = resolve }))
    vi.stubGlobal('fetch', fetcher)
    const pending = refreshSession()
    const rejected = expect(pending).rejects.toMatchObject({ code: 'session-changed' })
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1))
    useAuthStore.getState().clear()
    finish(Response.json({ accessToken: 'late-token', user }))
    await rejected
    expect(useAuthStore.getState().accessToken).toBeNull()
  })
  it('times out a hung request without logging out', async () => {
    vi.useFakeTimers()
    vi.stubGlobal('fetch', vi.fn((_url, init: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
    })))
    const pending = refreshSession()
    const rejected = expect(pending).rejects.toMatchObject({ code: 'network-error' })
    await vi.advanceTimersByTimeAsync(25_001)
    await rejected
    expect(useAuthStore.getState().accessToken).toBe('old-token')
  })
})
