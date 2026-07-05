import type { User } from '@kakdela/ginzu'

import { useAuthStore } from '../features/auth/store.js'
import { friendlyMessage } from './errorMessages.js'
import { SPEEDY_URL } from './serverUrl.js'

export class ApiError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status: number,
  ) {
    super(message)
    this.name = 'ApiError'
  }
}

// Таймаут запроса: без него зависшее соединение (TCP half-open) держит
// запрос вечно — отправка сообщения залипает в «sending». Аплоады больших
// файлов идут НЕ через apiFetch (XHR прямо в MinIO), так что лимит безопасен.
const REQUEST_TIMEOUT_MS = 25_000

async function performRefresh(): Promise<string | null> {
  let res: Response
  try {
    res = await fetch(`${SPEEDY_URL}/api/auth/refresh`, {
      method: 'POST',
      credentials: 'include',
    })
  } catch {
    // Сеть моргнула во время рефреша — НЕ разлогиниваем. Бросаем ошибку:
    // исходный запрос просто упадёт, сессия останется (повторим позже).
    throw new ApiError('network-error', friendlyMessage('network-error', 'нет связи с сервером'), 0)
  }
  // Ответ получен, но не ok (401) — refresh-токен истёк/отозван: честный логаут.
  if (!res.ok) return null
  const data = await res.json() as { accessToken: string; user: User }
  useAuthStore.getState().setSession(data.user, data.accessToken)
  return data.accessToken
}

// Singleflight: при истечении access-токена сразу несколько запросов ловят
// 401 и кидаются обновлять токен. Сервер ротирует refresh-токен на ПЕРВОМ
// /refresh, а остальные получают session-revoked → ложный разлогин. Поэтому
// все параллельные 401 ждут один общий промис обновления.
let refreshPromise: Promise<string | null> | null = null

function tryRefresh(): Promise<string | null> {
  if (!refreshPromise) {
    refreshPromise = performRefresh().finally(() => { refreshPromise = null })
  }
  return refreshPromise
}

/**
 * Единственная легальная точка ручного обновления сессии по refresh-cookie.
 * Идёт через тот же singleflight, что и 401-и внутри apiFetch: прямой fetch
 * /auth/refresh в обход него устраивает гонку двух ротаций (сервер атомарно
 * удаляет старую сессию — второй запрос получает session-revoked и разлогин).
 * null = сервер отверг cookie (истёк/отозван); сеть/5xx — бросает ApiError.
 */
export function refreshSession(): Promise<string | null> {
  return tryRefresh()
}

async function doRequest(path: string, token: string | null, init?: RequestInit): Promise<Response> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
  try {
    return await fetch(`${SPEEDY_URL}${path}`, {
      ...init,
      signal: controller.signal,
      headers: {
        // Content-Type только при наличии тела: Fastify 5 отвергает пустой
        // body с заголовком application/json (FST_ERR_CTP_EMPTY_JSON_BODY),
        // что ломало DELETE-запросы (удаление сообщений, снятие реакций).
        ...(init?.body != null ? { 'Content-Type': 'application/json' } : {}),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(init?.headers as Record<string, string> ?? {}),
      },
      credentials: 'include',
    })
  } catch {
    // fetch reject = сеть лежит / таймаут / сервер недоступен (не HTTP-ошибка).
    // Даём дружелюбный код вместо «Failed to fetch».
    throw new ApiError('network-error', friendlyMessage('network-error', 'нет связи с сервером'), 0)
  } finally {
    clearTimeout(timer)
  }
}

export async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const token = useAuthStore.getState().accessToken

  let res = await doRequest(path, token, init)

  if (res.status === 401) {
    const fresh = await tryRefresh()
    if (fresh) {
      res = await doRequest(path, fresh, init)
    } else {
      useAuthStore.getState().clear()
    }
  }

  // 204 No Content
  if (res.status === 204) return undefined as T

  if (!res.ok) {
    let body: { error?: { code: string; message: string } } = {}
    try {
      body = await res.json() as typeof body
    } catch { /* ignore parse errors */ }
    const code = body.error?.code ?? 'unknown-error'
    throw new ApiError(
      code,
      friendlyMessage(code, body.error?.message ?? res.statusText),
      res.status,
    )
  }

  return res.json() as Promise<T>
}
