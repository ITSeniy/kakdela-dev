// Сборщик мусора для MinIO (аудит M-6). Модель данных удаляет строки files
// каскадом (сообщение → канал → сервер → юзер), но S3-объекты сами себя не
// удаляют: «удалённое» вложение оставалось доступным по прямой ссылке
// бессрочно. Sweeper закрывает три дыры:
//
//   A. pending и не финализирован за сутки (presign живёт 5 минут) — объект
//      мог долиться, а мог и нет; чистим и то, и то.
//   B. ready, но никогда не приложен к сообщению (messageId IS NULL) неделю —
//      финализировали загрузку и передумали отправлять.
//   C. готовые вложения soft-deleted сообщений (ручное удаление, автоудаление).
//
// Плюс экспортируются хелперы для синхронной очистки ПЕРЕД жёстким удалением
// (канал/сервер): после каскада строки files исчезают, и найти ключи уже
// нечем.
//
// Запускается из index.ts после listen. Раз в час, первый прогон через 5 мин.

import { DeleteObjectsCommand } from '@aws-sdk/client-s3'
import { and, eq, inArray, isNull, isNotNull, lt } from 'drizzle-orm'
import type { FastifyBaseLogger } from 'fastify'

import { channels, files, messages } from '../db/schema.js'
import { db } from './db.js'
import { S3_BUCKET, s3 } from './s3.js'

const SWEEP_INTERVAL_MS = 60 * 60 * 1000
const FIRST_SWEEP_DELAY_MS = 5 * 60 * 1000
// Лимит одного прохода: не глотаем весь бэклог разом, остаток доберётся в
// следующий часовой проход.
const BATCH_SIZE = 500
const MAX_BATCHES_PER_PASS = 10

const PENDING_TTL_MS = 24 * 60 * 60 * 1000
const UNATTACHED_TTL_MS = 7 * 24 * 60 * 60 * 1000

export interface FileRef {
  key: string
  thumbKey: string | null
}

/** Пакетно удаляет S3-объекты (оригиналы + миниатюры). Best-effort. */
export async function deleteFileObjects(refs: readonly FileRef[], log: FastifyBaseLogger): Promise<void> {
  const keys = [...new Set(refs.flatMap((r) => (r.thumbKey ? [r.key, r.thumbKey] : [r.key])))]
  // Протокол S3: максимум 1000 ключей на один DeleteObjects.
  for (let i = 0; i < keys.length; i += 1000) {
    const chunk = keys.slice(i, i + 1000)
    try {
      await s3.send(new DeleteObjectsCommand({
        Bucket: S3_BUCKET,
        Delete: { Objects: chunk.map((Key) => ({ Key })), Quiet: true },
      }))
    } catch (err) {
      log.warn({ err, count: chunk.length }, '[media-gc] failed to delete objects')
    }
  }
}

/**
 * Удаляет готовые вложения перечисленных сообщений: сначала S3-объекты,
 * потом строки files. Вызывается при soft-delete сообщения (ручном и
 * автоудалении).
 */
export async function purgeAttachmentsForMessages(
  messageIds: readonly string[],
  log: FastifyBaseLogger,
): Promise<void> {
  if (messageIds.length === 0) return
  const ids = [...messageIds]
  const rows = await db
    .select({ id: files.id, key: files.key, thumbKey: files.thumbKey })
    .from(files)
    .where(inArray(files.messageId, ids))
  if (rows.length === 0) return

  await deleteFileObjects(rows, log)
  await db.delete(files).where(inArray(files.id, rows.map((r) => r.id)))
}

/**
 * Собирает и удаляет все файлы канала ВМЕСТЕ с его тредами. Звать ДО
 * удаления канала — после каскада строки files исчезнут, и ключи S3-объектов
 * будет нечем найти (аудит M-6).
 */
export async function purgeFilesForChannel(channelId: string, log: FastifyBaseLogger): Promise<void> {
  const threadRows = await db
    .select({ id: channels.id })
    .from(channels)
    .where(eq(channels.parentChannelId, channelId))
  const channelIds = [channelId, ...threadRows.map((t) => t.id)]

  const rows = await db
    .select({ id: files.id, key: files.key, thumbKey: files.thumbKey })
    .from(files)
    .innerJoin(messages, eq(files.messageId, messages.id))
    .where(inArray(messages.channelId, channelIds))
  if (rows.length === 0) return

  await deleteFileObjects(rows, log)
  await db.delete(files).where(inArray(files.id, rows.map((r) => r.id)))
}

/**
 * То же для целого сервера. Треды наследуют serverId родительского канала
 * (см. routes/threads.ts), поэтому выборка по channels.serverId их покрывает.
 */
export async function purgeFilesForServer(serverId: string, log: FastifyBaseLogger): Promise<void> {
  const rows = await db
    .select({ id: files.id, key: files.key, thumbKey: files.thumbKey })
    .from(files)
    .innerJoin(messages, eq(files.messageId, messages.id))
    .innerJoin(channels, eq(messages.channelId, channels.id))
    .where(eq(channels.serverId, serverId))
  if (rows.length === 0) return

  await deleteFileObjects(rows, log)
  await db.delete(files).where(inArray(files.id, rows.map((r) => r.id)))
}

async function sweepOnce(log: FastifyBaseLogger): Promise<void> {
  // ── A. Заброшенные pending (не финализированы за сутки) ──
  const pendingCutoff = new Date(Date.now() - PENDING_TTL_MS)
  for (let batch = 0; batch < MAX_BATCHES_PER_PASS; batch++) {
    const rows = await db
      .select({ id: files.id, key: files.key, thumbKey: files.thumbKey })
      .from(files)
      .where(and(eq(files.status, 'pending'), lt(files.createdAt, pendingCutoff)))
      .limit(BATCH_SIZE)
    if (rows.length === 0) break
    await deleteFileObjects(rows, log)
    await db.delete(files).where(inArray(files.id, rows.map((r) => r.id)))
    if (rows.length < BATCH_SIZE) break
  }

  // ── B. Готовые, но ни к одному сообщению не приложенные (неделя) ──
  const unattachedCutoff = new Date(Date.now() - UNATTACHED_TTL_MS)
  for (let batch = 0; batch < MAX_BATCHES_PER_PASS; batch++) {
    const rows = await db
      .select({ id: files.id, key: files.key, thumbKey: files.thumbKey })
      .from(files)
      .where(and(eq(files.status, 'ready'), isNull(files.messageId), lt(files.createdAt, unattachedCutoff)))
      .limit(BATCH_SIZE)
    if (rows.length === 0) break
    await deleteFileObjects(rows, log)
    await db.delete(files).where(inArray(files.id, rows.map((r) => r.id)))
    if (rows.length < BATCH_SIZE) break
  }

  // ── C. Вложения soft-deleted сообщений ──
  for (let batch = 0; batch < MAX_BATCHES_PER_PASS; batch++) {
    const rows = await db
      .select({ id: files.id, key: files.key, thumbKey: files.thumbKey })
      .from(files)
      .innerJoin(messages, eq(files.messageId, messages.id))
      .where(isNotNull(messages.deletedAt))
      .limit(BATCH_SIZE)
    if (rows.length === 0) break
    await deleteFileObjects(rows, log)
    await db.delete(files).where(inArray(files.id, rows.map((r) => r.id)))
    if (rows.length < BATCH_SIZE) break
  }
}

/** Запускает периодический GC. Возвращает функцию остановки. */
export function startMediaGcSweeper(log: FastifyBaseLogger): () => void {
  const run = () => {
    sweepOnce(log).catch((err) => log.error({ err }, '[media-gc] sweep failed'))
  }
  const interval = setInterval(run, SWEEP_INTERVAL_MS)
  const first = setTimeout(run, FIRST_SWEEP_DELAY_MS)
  return () => { clearInterval(interval); clearTimeout(first) }
}
