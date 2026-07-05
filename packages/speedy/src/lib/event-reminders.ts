// Напоминания о встречах: раз в минуту ищем сообщения-встречи, чей startsAt
// попадает в ближайшие 15 минут, и шлём targeted WS event.reminder всем, кто
// ответил «пойду» (+ автору). Дедуп — Redis NX на messageId (TTL сутки).
// Оффлайн-юзеры напоминание не получат (нет push-инфраструктуры) — осознанно.

import { and, eq, isNull, sql } from 'drizzle-orm'

import type { EventDefinition } from '@kakdela/ginzu/api-types'

import { eventRsvps, messages } from '../db/schema.js'
import { db } from './db.js'
import { redis } from './redis.js'
import { broadcastToUser } from '../ws/broadcast.js'

const CHECK_INTERVAL_MS = 60_000
const REMIND_BEFORE_MIN = 15

interface ReminderLogger {
  info(obj: unknown, msg?: string): void
  warn(obj: unknown, msg?: string): void
}

async function sweep(log: ReminderLogger): Promise<void> {
  // startsAt лежит внутри jsonb — сравниваем через ::timestamptz. Окно
  // [now, now+15m): напоминание уходит один раз при входе события в окно.
  const rows = await db
    .select({ id: messages.id, channelId: messages.channelId, authorId: messages.authorId, event: messages.event })
    .from(messages)
    .where(and(
      isNull(messages.deletedAt),
      sql`${messages.event} IS NOT NULL`,
      sql`(${messages.event}->>'startsAt')::timestamptz > now()`,
      sql`(${messages.event}->>'startsAt')::timestamptz <= now() + interval '${sql.raw(String(REMIND_BEFORE_MIN))} minutes'`,
    ))

  for (const row of rows) {
    const set = await redis.set(`evremind:${row.id}`, '1', 'EX', 24 * 3600, 'NX')
    if (set === null) continue // уже напомнили

    const def = row.event as EventDefinition
    const goingRows = await db
      .select({ userId: eventRsvps.userId })
      .from(eventRsvps)
      .where(and(eq(eventRsvps.messageId, row.id), eq(eventRsvps.going, true)))

    // Автор получает напоминание всегда — он встречу и назначил.
    const targets = new Set<string>([row.authorId, ...goingRows.map((r) => r.userId)])
    for (const userId of targets) {
      void broadcastToUser(userId, {
        t: 'event.reminder',
        channelId: row.channelId,
        messageId: row.id,
        title: def.title,
        startsAt: def.startsAt,
        place: def.place ?? null,
      })
    }
    log.info({ messageId: row.id, targets: targets.size }, 'event reminder sent')
  }
}

export function startEventReminders(log: ReminderLogger): void {
  setInterval(() => {
    void sweep(log).catch((err) => log.warn({ err }, 'event reminder sweep failed'))
  }, CHECK_INTERVAL_MS).unref()
}
