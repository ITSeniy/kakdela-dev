import type { Redis } from 'ioredis'

import { ServerEventSchema, type ServerEvent } from '@kakdela/ginzu/ws-events'

import { redis } from '../lib/redis.js'

const KEY_PREFIX = 'kakdela:ws:'

export type BrokerHandler = (topic: string, event: ServerEvent) => void | Promise<void>

export interface Broker {
  publish(topic: string, event: ServerEvent): Promise<void>
  onMessage(handler: BrokerHandler): void
  init(): Promise<void>
  close(): Promise<void>
}

class RedisBroker implements Broker {
  private handler: BrokerHandler | null = null
  private started = false

  constructor(private readonly pub: Redis, private readonly sub: Redis) {}

  async init(): Promise<void> {
    if (this.started) return
    this.started = true
    await this.sub.psubscribe(KEY_PREFIX + '*')
    this.sub.on('pmessage', (_pattern: string, channel: string, message: string) => {
      if (!this.handler) return
      if (!channel.startsWith(KEY_PREFIX)) return
      const topic = channel.slice(KEY_PREFIX.length)
      let parsed: unknown
      try {
        parsed = JSON.parse(message)
      } catch {
        return
      }
      const result = ServerEventSchema.safeParse(parsed)
      if (!result.success) return
      this.handler(topic, result.data)
    })
  }

  async publish(topic: string, event: ServerEvent): Promise<void> {
    await this.pub.publish(KEY_PREFIX + topic, JSON.stringify(event))
  }

  onMessage(handler: BrokerHandler): void {
    this.handler = handler
  }

  async close(): Promise<void> {
    if (!this.started) return
    try { await this.sub.punsubscribe(KEY_PREFIX + '*') } catch { /* ignore */ }
    try { this.sub.disconnect() } catch { /* ignore */ }
  }
}

export const broker: Broker = new RedisBroker(redis, redis.duplicate())
