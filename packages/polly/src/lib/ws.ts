import { ServerEventSchema, type ClientEvent, type ServerEvent } from '@kakdela/ginzu/ws-events'

import { useAuthStore } from '../features/auth/store.js'
import { useRealtimeStore } from '../features/realtime/store.js'
import { SPEEDY_URL } from './serverUrl.js'

const WS_URL = SPEEDY_URL.replace(/^http/, 'ws') + '/ws'

const RECONNECT_BASE_MS = 1_000
const RECONNECT_MAX_MS = 30_000
const CLIENT_PING_INTERVAL_MS = 25_000

type Handler = (e: ServerEvent) => void

export class WsClient {
  private ws: WebSocket | null = null
  private handlers = new Set<Handler>()
  private reconnectAttempt = 0
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private pingTimer: ReturnType<typeof setInterval> | null = null
  private lastPingSentAt: number | null = null
  private intentionallyClosed = false
  private getToken: () => string | null

  constructor(getToken: () => string | null) {
    this.getToken = getToken
  }

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
    const token = this.getToken()
    if (!token) {
      useRealtimeStore.getState().setStatus('disconnected')
      return
    }

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
        // Token bad — don't loop forever. App-level re-auth will reconnect.
        useRealtimeStore.getState().setStatus('disconnected')
        console.warn('[ws] unauthorized — token rejected')
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

export const wsClient = new WsClient(() => useAuthStore.getState().accessToken)
