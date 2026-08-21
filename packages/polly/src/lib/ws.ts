import { ServerEventSchema, type ClientEvent, type ServerEvent } from '@kakdela/ginzu/ws-events'

import { useRealtimeStore } from '../features/realtime/store.js'
import { ensureFreshAccessToken } from './api.js'
import { SPEEDY_URL } from './serverUrl.js'

const WS_URL = SPEEDY_URL.replace(/^http/, 'ws') + '/ws'

const RECONNECT_BASE_MS = 1_000
const RECONNECT_MAX_MS = 30_000
const CLIENT_PING_INTERVAL_MS = 25_000
// Сколько раз подряд сервер может отвергнуть токен (4401), прежде чем мы
// сдадимся. Каждый 4401 сопровождается принудительным refresh, так что
// 2 подряд означают «сессия отозвана на сервере» — честный логаут через
// clear() внутри refresh-пути.
const MAX_UNAUTHORIZED_ATTEMPTS = 2

type Handler = (e: ServerEvent) => void

export class WsClient {
  private ws: WebSocket | null = null
  private handlers = new Set<Handler>()
  private reconnectAttempt = 0
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private pingTimer: ReturnType<typeof setInterval> | null = null
  private lastPingSentAt: number | null = null
  private intentionallyClosed = false
  private unauthorizedAttempts = 0

  // Токен больше не инжектится снаружи: openSocketAsync берёт его через
  // ensureFreshAccessToken() (общий singleflight-refresh с REST).
  constructor() {}

  connect(): void {
    this.intentionallyClosed = false
    this.openSocket()
  }

  close(): void {
    this.intentionallyClosed = true
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    this.stopPingProbe()
    if (this.ws) {
      try { this.ws.close(1000, 'client-shutdown') } catch { /* ignore */ }
      this.ws = null
    }
    useRealtimeStore.getState().setStatus('disconnected')
    useRealtimeStore.getState().setLatency(null)
  }

  send(event: ClientEvent): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      try { this.ws.send(JSON.stringify(event)) } catch { /* ignore */ }
    }
  }

  on(handler: Handler): () => void {
    this.handlers.add(handler)
    return () => { this.handlers.delete(handler) }
  }

  private openSocket(): void {
    void this.openSocketAsync()
  }

  /**
   * Перед КАЖДЫМ подключением убеждаемся, что access-токен проживёт ещё
   * хотя бы ~30 секунд (ensureFreshAccessToken обновит его через общий
   * с REST singleflight). Без этого reconnect после обрыва длиннее TTL
   * токена (15 мин) получал 4401 и умирал навсегда (аудит C-1).
   */
  private async openSocketAsync(): Promise<void> {
    const token = await ensureFreshAccessToken()
    if (!token || this.intentionallyClosed) {
      useRealtimeStore.getState().setStatus('disconnected')
      return
    }
    // Пока ждали refresh, соединение могли закрыть/пересоздать.
    if (this.ws !== null && this.ws.readyState !== WebSocket.CLOSED) return

    useRealtimeStore.getState().setStatus(this.reconnectAttempt === 0 ? 'connecting' : 'reconnecting')

    const ws = new WebSocket(WS_URL)
    this.ws = ws

    ws.addEventListener('open', () => {
      this.send({ t: 'hello', token })
      this.startPingProbe()
    })

    ws.addEventListener('message', (ev) => {
      if (typeof ev.data !== 'string') return
      let parsed: unknown
      try {
        parsed = JSON.parse(ev.data)
      } catch {
        return
      }
      const result = ServerEventSchema.safeParse(parsed)
      if (!result.success) {
        // Тело события не логируем — там бывает контент сообщений; только тип.
        const t = typeof parsed === 'object' && parsed !== null && 't' in parsed
          ? String((parsed as { t: unknown }).t)
          : 'unknown'
        console.warn(`[ws] invalid server event (t=${t})`, result.error.issues)
        return
      }
      this.handleEvent(result.data)
    })

    ws.addEventListener('close', (ev) => {
      this.stopPingProbe()
      this.ws = null
      if (this.intentionallyClosed) {
        useRealtimeStore.getState().setStatus('disconnected')
        return
      }
      if (ev.code === 4401) {
        // Токен отвергнут. openSocketAsync уже пытался обновить его перед
        // подключением — значит refresh либо не успел, либо сессия отозвана.
        // Форсируем ещё один refresh и пробуем снова; после N неудач сдаёмся
        // (сессия очистится внутри refresh-пути → App закроет сокет).
        this.unauthorizedAttempts += 1
        if (this.unauthorizedAttempts > MAX_UNAUTHORIZED_ATTEMPTS) {
          useRealtimeStore.getState().setStatus('disconnected')
          console.warn('[ws] unauthorized — giving up after repeated token rejection')
          return
        }
        console.warn('[ws] unauthorized — refreshing session and retrying')
        void ensureFreshAccessToken().catch(() => {})
        this.scheduleReconnect()
        return
      }
      this.scheduleReconnect()
    })

    ws.addEventListener('error', () => {
      // Will be followed by close — handle reconnect there.
    })
  }

  private handleEvent(event: ServerEvent): void {
    if (event.t === 'ready') {
      this.reconnectAttempt = 0
      this.unauthorizedAttempts = 0
      useRealtimeStore.getState().setStatus('connected')
    }
    if (event.t === 'ping') {
      this.send({ t: 'pong' })
    }
    if (event.t === 'pong' && this.lastPingSentAt !== null) {
      useRealtimeStore.getState().setLatency(Date.now() - this.lastPingSentAt)
      this.lastPingSentAt = null
    }
    for (const h of this.handlers) h(event)
  }

  private startPingProbe(): void {
    this.stopPingProbe()
    this.pingTimer = setInterval(() => {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.lastPingSentAt = Date.now()
        this.send({ t: 'ping' })
      }
    }, CLIENT_PING_INTERVAL_MS)
  }

  private stopPingProbe(): void {
    if (this.pingTimer) {
      clearInterval(this.pingTimer)
      this.pingTimer = null
    }
    this.lastPingSentAt = null
  }

  private scheduleReconnect(): void {
    const base = Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * (2 ** this.reconnectAttempt))
    const jitter = Math.random() * 1_000
    const delay = base + jitter
    this.reconnectAttempt += 1
    useRealtimeStore.getState().setStatus('reconnecting')
    this.reconnectTimer = setTimeout(() => {
      this.openSocket()
    }, delay)
  }
}

export const wsClient = new WsClient()
