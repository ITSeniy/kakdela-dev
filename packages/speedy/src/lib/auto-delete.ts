// Фоновый sweeper автоудаления сообщений. Каналы с channels.auto_delete_sec
// гасят сообщения старше указанного срока: soft-delete (deletedAt + пустой
// content) + WS msg.delete, чтобы у открытых клиентов сообщение пропало.
//
// Запускается из index.ts после listen. Интервал — раз в 30 минут, плюс один
// прогон через минуту после старта. Лёгкий: один UPDATE на канал.

import { and, eq, inArray, isNotNull, isNull, lt } from 'drizzle-orm'
import type { FastifyBaseLogger } from 'fastify'

import { channels, messages } from '../db/schema.js'
import { db } from './db.js'
import { broadcastToChannel } from '../ws/broadcast.js'

const SWEEP_INTERVAL_MS = 30 * 60 * 1000
const FIRST_SWEEP_DELAY_MS = 60 * 1000
// Защита от лавины, если накопился большой бэклог: за одну итерацию гасим не
// больше N сообщений — и БД, и broadcast. Итерации повторяются, пока есть что
// удалять (до полного опустошения канала), так что клиенты всегда получают
// msg.delete на каждое реально удалённое сообщение.
const MAX_PER_BATCH = 1000

async function sweepOnce(log: FastifyBaseLogger): Promise<void> {
  const chs = await db
    .select({ id: channels.id, sec: channels.autoDeleteSec })
    .from(channels)
    .where(isNotNull(channels.autoDeleteSec))

  for (const ch of chs) {
    if (!ch.sec || ch.sec <= 0) continue
    const cutoff = new Date(Date.now() - ch.sec * 1000)
    let swept = 0
    for (;;) {
      // Сначала выбираем пачку id, потом удаляем по ним: UPDATE ... LIMIT в
      // Postgres нет, а удалять вслепую — значит терять id для broadcast.
      const doomed = await db
        .select({ id: messages.id })
        .from(messages)
        .where(and(
          eq(messages.channelId, ch.id),
          isNull(messages.deletedAt),
          lt(messages.createdAt, cutoff),
        ))
        .orderBy(messages.id)
        .limit(MAX_PER_BATCH)
      if (doomed.length === 0) break
      const ids = doomed.map((d) => d.id)

      await db
        .update(messages)
        .set({ deletedAt: new Date(), content: '' })
        .where(inArray(messages.id, ids))

      for (const id of ids) {
        void broadcastToChannel(ch.id, { t: 'msg.delete', channelId: ch.id, messageId: id })
      }
      swept += ids.length
      if (doomed.length < MAX_PER_BATCH) break
    }
    if (swept > 0) {
      log.info({ channelId: ch.id, count: swept }, 'auto-delete swept channel')
    }
  }
}

/** Запускает периодический sweeper. Возвращает функцию остановки. */
export function startAutoDeleteSweeper(log: FastifyBaseLogger): () => void {
  const run = () => {
    sweepOnce(log).catch((err) => log.error({ err }, 'auto-delete sweep failed'))
  }
  const interval = setInterval(run, SWEEP_INTERVAL_MS)
  const first = setTimeout(run, FIRST_SWEEP_DELAY_MS)
  return () => { clearInterval(interval); clearTimeout(first) }
}
