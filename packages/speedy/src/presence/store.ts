import type { Redis } from 'ioredis'

import { redis } from '../lib/redis.js'

export type PresenceStatus = 'online' | 'idle' | 'dnd' | 'offline'

export interface PresenceState {
  status: PresenceStatus
  customStatus: string | null
  lastSeen: number
}

const KEY = (userId: string) => `presence:user:${userId}`
const ALLOWED: PresenceStatus[] = ['online', 'idle', 'dnd', 'offline']
const OFFLINE_DEBOUNCE_MS = 30_000

function parseState(raw: Record<string, string> | null | undefined): PresenceState {
  const status = (raw?.['status'] ?? 'offline') as PresenceStatus
  return {
    status: ALLOWED.includes(status) ? status : 'offline',
    customStatus: raw?.['customStatus'] ?? null,
    lastSeen: Number.parseInt(raw?.['lastSeen'] ?? '0', 10) || 0,
  }
}

type OfflineHandler = (userId: string) => void | Promise<void>

class PresenceStore {
  private readonly pendingOffline = new Map<string, ReturnType<typeof setTimeout>>()
  private offlineHandler: OfflineHandler | null = null

  constructor(private readonly client: Redis) {}

  onOffline(handler: OfflineHandler): void {
    this.offlineHandler = handler
  }

  /** Increment the connection counter. Returns whether the user transitioned
   *  to a publishable 'online' state (i.e. caller should broadcast). */
  async addConnection(userId: string): Promise<{ broadcast: boolean; status: PresenceStatus }> {
    const existing = this.pendingOffline.get(userId)
    if (existing) {
      clearTimeout(existing)
      this.pendingOffline.delete(userId)
    }

    const key = KEY(userId)
    const prevStatus = await this.client.hget(key, 'status')
    await this.client.hincrby(key, 'connectionCount', 1)
    await this.client.hset(key, { status: 'online', lastSeen: String(Date.now()) })

    return {
      broadcast: prevStatus !== 'online',
      status: 'online',
    }
  }

  /** Decrement and, if the counter reaches zero, schedule an offline
   *  broadcast after the debounce window. */
  async removeConnection(userId: string): Promise<void> {
    const key = KEY(userId)
    const count = await this.client.hincrby(key, 'connectionCount', -1)
    if (count > 0) return
    if (count < 0) {
      await this.client.hset(key, { connectionCount: '0' })
    }

    const existing = this.pendingOffline.get(userId)
    if (existing) clearTimeout(existing)

    const timer = setTimeout(() => {
      this.pendingOffline.delete(userId)
      void this.finalizeOffline(userId)
    }, OFFLINE_DEBOUNCE_MS)
    this.pendingOffline.set(userId, timer)
  }

  private async finalizeOffline(userId: string): Promise<void> {
    const key = KEY(userId)
    const raw = await this.client.hget(key, 'connectionCount')
    const stillZero = (Number.parseInt(raw ?? '0', 10) || 0) <= 0
    if (!stillZero) return
    await this.client.hset(key, { status: 'offline', lastSeen: String(Date.now()) })
    if (this.offlineHandler) {
      try {
        await this.offlineHandler(userId)
      } catch { /* swallow — broadcast is best-effort */ }
    }
  }

  async setStatus(userId: string, status: PresenceStatus): Promise<void> {
    await this.client.hset(KEY(userId), { status, lastSeen: String(Date.now()) })
  }

  async setCustomStatus(userId: string, text: string | null): Promise<void> {
    if (text === null) {
      await this.client.hdel(KEY(userId), 'customStatus')
    } else {
      await this.client.hset(KEY(userId), { customStatus: text })
    }
  }

  async getStatus(userId: string): Promise<PresenceState> {
    const raw = await this.client.hgetall(KEY(userId))
    return parseState(raw)
  }

  /**
   * Реконсиляция на старте процесса. После рестарта/краша speedy счётчики
   * соединений в Redis осиротели (close-хендлеры не отработали), а offline-
   * дебаунс-таймеры жили в памяти — без сброса все, кто был подключён,
   * выглядят «online» навечно. customStatus и lastSeen сохраняем; живые
   * клиенты переподключатся и снова станут online через addConnection.
   */
  async resetAll(): Promise<void> {
    let cursor = '0'
    do {
      const [next, keys] = await this.client.scan(cursor, 'MATCH', KEY('*'), 'COUNT', 100)
      cursor = next
      if (keys.length === 0) continue
      const pipeline = this.client.pipeline()
      for (const key of keys) {
        pipeline.hset(key, { status: 'offline', connectionCount: '0' })
      }
      await pipeline.exec()
    } while (cursor !== '0')
  }

  async getStatusBulk(userIds: readonly string[]): Promise<Map<string, PresenceState>> {
    const out = new Map<string, PresenceState>()
    if (userIds.length === 0) return out
    const pipeline = this.client.pipeline()
    for (const id of userIds) pipeline.hgetall(KEY(id))
    const results = await pipeline.exec()
    if (!results) return out
    for (let i = 0; i < userIds.length; i += 1) {
      const userId = userIds[i]
      const entry = results[i]
      if (!userId || !entry) continue
      const [err, raw] = entry
      if (err) continue
      out.set(userId, parseState(raw as Record<string, string>))
    }
    return out
  }
}

export const presence = new PresenceStore(redis)
