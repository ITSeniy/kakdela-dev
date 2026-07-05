import type { User } from '@kakdela/ginzu'

import { ApiError, apiFetch, refreshSession } from '../../lib/api.js'
import { secrets } from '../../lib/host/secrets.js'
import { SPEEDY_URL } from '../../lib/serverUrl.js'
import { useAuthStore } from './store.js'

export type InviteInfo = { serverName: string; serverIcon: string | null; expiresAt: string | null }

// Сессия (user + access-токен) лежит в защищённом сторе (lib/host/secrets):
// зашифрована at-rest, переживает холодный старт. На неё опирается
// оптимистичное восстановление в initAuth.
const SESSION_KEY = 'kd:session'
const LEGACY_TOKEN_KEY = 'kd:accessToken'

async function persistSession(user: User, accessToken: string): Promise<void> {
  await secrets.set(SESSION_KEY, JSON.stringify({ user, accessToken }))
}

async function clearSession(): Promise<void> {
  await secrets.delete(SESSION_KEY)
  await secrets.delete(LEGACY_TOKEN_KEY)
  useAuthStore.getState().clear()
}

export async function lookupInvite(code: string): Promise<InviteInfo> {
  const res = await fetch(`${SPEEDY_URL}/api/invites/${encodeURIComponent(code)}`)
  if (!res.ok) {
    let body: { error?: { code: string; message: string } } = {}
    try { body = await res.json() as typeof body } catch { /* ignore */ }
    throw new ApiError(
      body.error?.code ?? 'unknown-error',
      body.error?.message ?? res.statusText,
      res.status,
    )
  }
  return res.json() as Promise<InviteInfo>
}

type AuthResponse = { accessToken: string; user: User }

export async function login(email: string, password: string): Promise<void> {
  const data = await apiFetch<AuthResponse>('/api/auth/login', {
    method: 'POST',
    body: JSON.stringify({ email, password }),
  })
  await persistSession(data.user, data.accessToken)
  useAuthStore.getState().setSession(data.user, data.accessToken)
}

export async function register(params: {
  inviteCode: string
  username: string
  /** Опционально: имя задаётся на втором шаге, сервер подставит username. */
  displayName?: string
  email: string
  password: string
}): Promise<void> {
  const data = await apiFetch<AuthResponse>('/api/auth/register', {
    method: 'POST',
    body: JSON.stringify(params),
  })
  await persistSession(data.user, data.accessToken)
  useAuthStore.getState().setSession(data.user, data.accessToken)
}

export async function logout(): Promise<void> {
  try {
    await apiFetch<void>('/api/auth/logout', { method: 'POST' })
  } catch { /* ignore network errors on logout */ }
  await clearSession()
}

export async function initAuth(): Promise<void> {
  useAuthStore.getState().setStatus('loading')

  // 1) Оптимистично поднимаем сессию из защищённого стора — мгновенный холодный
  //    старт без ожидания сети.
  let restored = false
  try {
    const raw = await secrets.get(SESSION_KEY)
    if (raw) {
      const sess = JSON.parse(raw) as { user: User; accessToken: string }
      useAuthStore.getState().setSession(sess.user, sess.accessToken)
      restored = true
    }
  } catch { /* битый стор — игнорируем, пойдём через refresh */ }

  if (restored) {
    // 2а) Валидируем сессию через GET /auth/me — БЕЗ ротации refresh-токена.
    //     Если access истёк, apiFetch сам обновит его через singleflight.
    //     Раньше здесь был прямой POST /auth/refresh: он гонялся с 401-refresh'ами
    //     первых запросов приложения, сервер ротирует токен атомарно — проигравший
    //     получал session-revoked, и клиент случайно разлогинивался на старте.
    try {
      const me = await apiFetch<User>('/api/auth/me')
      const token = useAuthStore.getState().accessToken
      if (token) {
        useAuthStore.getState().setSession(me, token)
        await persistSession(me, token)
      }
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) {
        // Настоящий отказ (cookie истёк/отозван) — честный логаут.
        // Сеть/5xx логаутом не считаем: оставляем локальную сессию (офлайн).
        await clearSession()
      }
    }
    return
  }

  // 2б) Локальной сессии нет — единственный путь через refresh-cookie,
  //     тем же singleflight'ом, что и остальные обновления.
  try {
    const token = await refreshSession()
    const user = useAuthStore.getState().user
    if (token && user) {
      await persistSession(user, token)
    } else {
      useAuthStore.getState().clear()
    }
  } catch {
    // Сеть моргнула, восстанавливать нечего — unauthed.
    useAuthStore.getState().clear()
  }
}
