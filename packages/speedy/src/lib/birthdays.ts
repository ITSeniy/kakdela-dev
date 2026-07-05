// Дни рождения: раз в час ищем юзеров, у кого birthday (MM-DD) наступил
// «сегодня» в их таймзоне (фолбэк — таймзона сервера), и постим системное
// сообщение {kind:'birthday'} в default-канал каждого их сервера. Дедуп —
// Redis SET NX с TTL 400 дней на пару (userId, год): пере-запуски speedy и
// почасовые тики не поздравляют дважды.

import { and, eq, isNotNull } from 'drizzle-orm'

import type { Message, SystemEvent } from '@kakdela/ginzu/api-types'

import { channels, serverMembers, users, messages } from '../db/schema.js'
import { db } from './db.js'
import { redis } from './redis.js'
import { broadcastToChannel } from '../ws/broadcast.js'

const CHECK_INTERVAL_MS = 60 * 60 * 1000

interface BirthdayLogger {
  info(obj: unknown, msg?: string): void
  warn(obj: unknown, msg?: string): void
}

/** «MM-DD» сегодняшнего дня в заданной таймзоне (кривая зона → серверная). */
function todayInZone(timezone: string | null): string {
  try {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone ?? undefined,
      month: '2-digit',
      day: '2-digit',
    }).formatToParts(new Date())
    const mm = parts.find((p) => p.type === 'month')?.value
    const dd = parts.find((p) => p.type === 'day')?.value
    if (mm && dd) return `${mm}-${dd}`
  } catch { /* неизвестная таймзона — фолбэк ниже */ }
  const now = new Date()
  return `${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
}

async function congratulate(userId: string, log: BirthdayLogger): Promise<void> {
  // Все default-каналы серверов, где юзер состоит.
  const targets = await db
    .select({ channelId: channels.id })
    .from(serverMembers)
    .innerJoin(channels, and(
      eq(channels.serverId, serverMembers.serverId),
      eq(channels.isDefault, true),
    ))
    .where(eq(serverMembers.userId, userId))

  const system: SystemEvent = { kind: 'birthday' }
  for (const t of targets) {
    const inserted = await db
      .insert(messages)
      .values({ channelId: t.channelId, authorId: userId, content: 'День рождения', system })
      .returning({ id: messages.id, createdAt: messages.createdAt })
    const row = inserted[0]
    if (!row) continue
    const message: Message = {
      id: row.id,
      channelId: t.channelId,
      authorId: userId,
      content: 'День рождения',
      replyToId: null,
      replyTo: null,
      createdAt: row.createdAt.toISOString(),
      editedAt: null,
      reactions: [],
      attachments: [],
      thread: null,
      pinned: false,
      pinnedAt: null,
      forwarded: null,
      linkPreviews: [],
      system,
    }
    await broadcastToChannel(t.channelId, { t: 'msg.new', channelId: t.channelId, message })
  }
  log.info({ userId, channels: targets.length }, 'birthday congratulation posted')
}

async function sweep(log: BirthdayLogger): Promise<void> {
  const rows = await db
    .select({ id: users.id, birthday: users.birthday, timezone: users.timezone })
    .from(users)
    .where(isNotNull(users.birthday))

  const year = new Date().getFullYear()
  for (const u of rows) {
    if (u.birthday !== todayInZone(u.timezone)) continue
    // NX-ключ на (userId, год) — TTL 400 дней перекрывает год с запасом.
    const key = `bday:${u.id}:${year}`
    const set = await redis.set(key, '1', 'EX', 400 * 24 * 3600, 'NX')
    if (set === null) continue // уже поздравляли в этом году
    try {
      await congratulate(u.id, log)
    } catch (err) {
      // Поздравление не ушло — отпускаем ключ, попробуем на следующем тике.
      await redis.del(key).catch(() => {})
      log.warn({ userId: u.id, err }, 'birthday congratulation failed')
    }
  }
}

export function startBirthdaySweeper(log: BirthdayLogger): void {
  void sweep(log).catch((err) => log.warn({ err }, 'birthday sweep failed'))
  setInterval(() => {
    void sweep(log).catch((err) => log.warn({ err }, 'birthday sweep failed'))
  }, CHECK_INTERVAL_MS).unref()
}
