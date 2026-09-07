import { isNull, or } from 'drizzle-orm'
import type { DbExecutor } from '../lib/db.js'
import { Buffer } from 'node:buffer'

import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'
import { and, eq, inArray } from 'drizzle-orm'
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod'
import probe from 'probe-image-size'
import sharp from 'sharp'
import { z } from 'zod'

import {
  ErrorBodySchema,
  FinalizeResponseSchema,
  PresignRequestSchema,
  PresignResponseSchema,
  type Attachment,
  type AttachmentKind,
} from '@kakdela/ginzu/api-types'

import { files } from '../db/schema.js'
import { db } from '../lib/db.js'
import {
  EXTENSION_FOR_TYPE,
  type AllowedMimeType,
  checkMagicBytes,
  isAllowedMime,
} from '../lib/file-validation.js'
import { S3_BUCKET, S3_PUBLIC_ENDPOINT, s3, s3Public } from '../lib/s3.js'
import { uuidv7 } from '../lib/uuidv7.js'

const PRESIGN_TTL_SECONDS = 300

// 64 KB is plenty: file-type needs <100 bytes for every format we accept,
// and probe-image-size for non-streamed buffers also reads headers only.
const MAGIC_PREFIX_BYTES = 64 * 1024

// Миниатюры для чата: webp, длинная сторона ≤480px. GIF не трогаем (теряется
// анимация), картинки уже ≤480px — тоже (нет выигрыша). Файлы крупнее лимита
// не миниатюризируем, чтобы не раздувать память процесса.
const THUMB_MAX_SIDE = 480
const THUMB_WEBP_QUALITY = 82
const THUMB_SOURCE_MAX_BYTES = 25 * 1024 * 1024

// Слишком большие оригиналы ужимаем на месте при finalize: длинная сторона
// ≤2560px достаточна и для баннеров, и для чата, а хранилище не пухнет от
// 40-мегапиксельных фото. GIF не трогаем (анимация).
const ORIGINAL_MAX_SIDE = 2560
const ORIGINAL_JPEG_QUALITY = 85
const ORIGINAL_WEBP_QUALITY = 90

const ARCHIVE_MIMES = new Set([
  'application/zip',
  'application/x-7z-compressed',
  'application/x-rar-compressed',
  'application/gzip',
])

function kindFromMime(mime: string): AttachmentKind {
  if (mime.startsWith('image/')) return 'image'
  if (mime.startsWith('video/')) return 'video'
  if (mime.startsWith('audio/')) return 'audio'
  if (mime === 'application/pdf') return 'pdf'
  if (mime === 'text/plain') return 'text'
  if (ARCHIVE_MIMES.has(mime)) return 'archive'
  return 'other'
}

function publicUrlFor(key: string): string {
  return `${S3_PUBLIC_ENDPOINT}/${S3_BUCKET}/${key}`
}

export function toAttachment(row: {
  id: string
  key: string
  thumbKey: string | null
  originalName: string
  contentType: string
  sizeBytes: number
  width: number | null
  height: number | null
  spoiler?: boolean
  voice?: boolean
  circle?: boolean
  durationSec?: number | null
}): Attachment {
  return {
    id:           row.id,
    url:          publicUrlFor(row.key),
    thumbUrl:     row.thumbKey ? publicUrlFor(row.thumbKey) : null,
    kind:         kindFromMime(row.contentType),
    contentType:  row.contentType,
    originalName: row.originalName,
    sizeBytes:    row.sizeBytes,
    width:        row.width,
    height:       row.height,
    spoiler:      row.spoiler ?? false,
    voice:        row.voice ?? false,
    circle:       row.circle ?? false,
    durationSec:  row.durationSec ?? null,
  }
}

async function readPrefix(key: string, bytes: number): Promise<Uint8Array> {
  const res = await s3.send(new GetObjectCommand({
    Bucket: S3_BUCKET,
    Key: key,
    Range: `bytes=0-${bytes - 1}`,
  }))
  const body = res.Body
  if (!body) throw new Error('no body in GetObject response')
  // AWS SDK v3 Body is a Readable stream in Node.
  const chunks: Buffer[] = []
  for await (const chunk of body as AsyncIterable<Buffer | Uint8Array>) {
    chunks.push(chunk instanceof Buffer ? chunk : Buffer.from(chunk))
  }
  return Uint8Array.from(Buffer.concat(chunks))
}

async function readFull(key: string): Promise<Buffer> {
  const res = await s3.send(new GetObjectCommand({ Bucket: S3_BUCKET, Key: key }))
  const body = res.Body
  if (!body) throw new Error('no body in GetObject response')
  const chunks: Buffer[] = []
  for await (const chunk of body as AsyncIterable<Buffer | Uint8Array>) {
    chunks.push(chunk instanceof Buffer ? chunk : Buffer.from(chunk))
  }
  return Buffer.concat(chunks)
}

/** Генерирует миниатюру и кладёт в S3. Возвращает thumbKey либо null
    (gif / мелкая картинка / слишком большой файл / ошибка — не фатально). */
async function makeThumbnail(file: {
  id: string
  key: string
  ownerId: string
  contentType: string
  sizeBytes: number
}, width: number | null, height: number | null): Promise<string | null> {
  if (!file.contentType.startsWith('image/')) return null
  if (file.contentType === 'image/gif') return null
  if (file.sizeBytes > THUMB_SOURCE_MAX_BYTES) return null
  if (width !== null && height !== null && Math.max(width, height) <= THUMB_MAX_SIDE) return null

  const original = await readFull(file.key)
  const thumb = await sharp(original)
    .rotate() // уважаем EXIF-ориентацию фото
    .resize(THUMB_MAX_SIDE, THUMB_MAX_SIDE, { fit: 'inside', withoutEnlargement: true })
    .webp({ quality: THUMB_WEBP_QUALITY })
    .toBuffer()

  const thumbKey = `public/${file.ownerId}/${file.id}.thumb.webp`
  await s3.send(new PutObjectCommand({
    Bucket: S3_BUCKET,
    Key: thumbKey,
    Body: thumb,
    ContentType: 'image/webp',
  }))
  return thumbKey
}

/** Ужимает слишком большой оригинал картинки на месте (тот же key, тот же
    формат). Возвращает новые размеры/вес либо null (не картинка / gif /
    в пределах лимита / слишком тяжёлый для обработки в памяти). */
async function downscaleOriginal(file: {
  key: string
  contentType: string
  sizeBytes: number
}, width: number | null, height: number | null): Promise<{ width: number; height: number; sizeBytes: number } | null> {
  if (!file.contentType.startsWith('image/')) return null
  if (file.contentType === 'image/gif') return null
  if (file.sizeBytes > THUMB_SOURCE_MAX_BYTES) return null
  if (width === null || height === null) return null
  if (Math.max(width, height) <= ORIGINAL_MAX_SIDE) return null

  const original = await readFull(file.key)
  let pipeline = sharp(original)
    .rotate() // уважаем EXIF-ориентацию фото
    .resize(ORIGINAL_MAX_SIDE, ORIGINAL_MAX_SIDE, { fit: 'inside', withoutEnlargement: true })
  if (file.contentType === 'image/png') pipeline = pipeline.png()
  else if (file.contentType === 'image/webp') pipeline = pipeline.webp({ quality: ORIGINAL_WEBP_QUALITY })
  else pipeline = pipeline.jpeg({ quality: ORIGINAL_JPEG_QUALITY })

  const { data, info } = await pipeline.toBuffer({ resolveWithObject: true })
  await s3.send(new PutObjectCommand({
    Bucket: S3_BUCKET,
    Key: file.key,
    Body: data,
    ContentType: file.contentType,
  }))
  return { width: info.width, height: info.height, sizeBytes: data.length }
}

async function deleteObject(key: string): Promise<void> {
  try {
    await s3.send(new DeleteObjectCommand({ Bucket: S3_BUCKET, Key: key }))
  } catch (err) {
    // Best-effort cleanup; log but don't fail the finalize response.
    console.warn('[files] failed to delete orphaned object', key, err)
  }
}

export const filesRoutes: FastifyPluginAsyncZod = async (app) => {
  // ───── POST /api/files/presign ─────
  //
  // Шаг 1 двухфазного upload'а. Создаёт запись в `files` со статусом
  // `pending` и возвращает presigned PUT URL для прямого upload'а в MinIO.
  //
  // Кладём всё под `public/<userId>/<fileId>.<ext>` — этот префикс настроен
  // на анонимный download (см. docker-compose.dev.yml → `mc anonymous set
  // download local/kakdela/public`). На каждый файл выдаём новый uuidv7 —
  // нет коллизий, можно отслеживать историю по timestamp'у в id.
  app.post(
    '/files/presign',
    {
      preHandler: app.authenticate,
      // Без лимита presign = бесконечные pending-строки в files и безлимитная
      // заливка в MinIO. 30 стартов загрузки/мин — с запасом для любого UI.
      config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
      schema: {
        body: PresignRequestSchema,
        response: {
          200: PresignResponseSchema,
          401: ErrorBodySchema,
        },
      },
    },
    async (req, reply) => {
      const { contentType, size, originalName, voice, circle, durationSec } = req.body
      const userId = req.authUser!.id

      const ext = EXTENSION_FOR_TYPE[contentType as AllowedMimeType] ?? 'bin'
      const fileId = uuidv7()
      const key = `public/${userId}/${fileId}.${ext}`

      // Флаги записей привязаны к типу медиа: «голосовое» — только аудио,
      // «кружок» — только видео. На прочих типах молча игнорируем, чтобы
      // нельзя было навязать неподходящий рендер.
      const isVoice = (voice ?? false) && contentType.startsWith('audio/')
      const isCircle = (circle ?? false) && contentType.startsWith('video/')

      await db.insert(files).values({
        id:           fileId,
        ownerId:      userId,
        key,
        originalName: originalName ?? `file.${ext}`,
        contentType,
        sizeBytes:    size,
        status:       'pending',
        voice:        isVoice,
        circle:       isCircle,
        durationSec:  isVoice || isCircle ? (durationSec ?? null) : null,
      })

      const command = new PutObjectCommand({
        Bucket: S3_BUCKET,
        Key: key,
        ContentType: contentType,
        ContentLength: size,
      })

      const uploadUrl = await getSignedUrl(s3Public, command, {
        expiresIn: PRESIGN_TTL_SECONDS,
        // Иначе SDK подписывает host-заголовок, который браузер вычисляет
        // отдельно, и MinIO бьёт SignatureMismatch.
        unhoistableHeaders: new Set(['host']),
      })

      return reply.code(200).send({ fileId, uploadUrl, publicUrl: publicUrlFor(key) })
    },
  )

  // ───── POST /api/files/:id/finalize ─────
  //
  // Шаг 2. Клиент дёрнул PUT в MinIO; теперь сервер должен:
  //   1. Скачать первые ~64 KB
  //   2. Сравнить magic bytes с заявленным contentType (без доверия клиенту)
  //   3. Для картинок — прочитать dimensions через probe-image-size
  //   4. Обновить status='ready'. Иначе — удалить объект и пометить 'failed'.
  app.post(
    '/files/:id/finalize',
    {
      preHandler: app.authenticate,
      // Финализация тянет 64 KB из MinIO и гоняет magic-bytes/размеры —
      // не даём крутить её в цикле.
      config: { rateLimit: { max: 60, timeWindow: '1 minute' } },
      schema: {
        params: z.object({ id: z.string().uuid() }),
        response: {
          200: FinalizeResponseSchema,
          401: ErrorBodySchema,
          403: ErrorBodySchema,
          404: ErrorBodySchema,
          422: ErrorBodySchema,
        },
      },
    },
    async (req, reply) => {
      const { id } = req.params
      const userId = req.authUser!.id

      const rows = await db.select().from(files).where(eq(files.id, id)).limit(1)
      const file = rows[0]
      if (!file) return reply.code(404).send({ error: { code: 'file-not-found', message: 'file not found' } })
      if (file.ownerId !== userId) {
        return reply.code(403).send({ error: { code: 'forbidden', message: 'not the owner of this file' } })
      }
      if (file.status === 'ready') {
        // Idempotent — повторный finalize по тому же id вернёт уже готовый объект.
        return reply.code(200).send({ attachment: toAttachment(file) })
      }

      if (!isAllowedMime(file.contentType)) {
        await deleteObject(file.key)
        await db.update(files).set({ status: 'failed' }).where(eq(files.id, id))
        return reply.code(422).send({ error: { code: 'unsupported-type', message: 'content type not allowed' } })
      }

      let prefix: Uint8Array
      try {
        prefix = await readPrefix(file.key, MAGIC_PREFIX_BYTES)
      } catch (err) {
        req.log.warn({ err, fileId: id }, '[files] readPrefix failed during finalize')
        return reply.code(422).send({ error: { code: 'upload-incomplete', message: 'could not read uploaded object' } })
      }

      const magic = await checkMagicBytes(file.contentType, prefix)
      if (!magic.ok) {
        await deleteObject(file.key)
        await db.update(files).set({ status: 'failed' }).where(eq(files.id, id))
        req.log.warn({
          fileId: id,
          declared: file.contentType,
          detected: 'detectedMime' in magic ? magic.detectedMime : undefined,
          reason: magic.reason,
        }, '[files] magic-bytes mismatch — refusing upload')
        return reply.code(422).send({
          error: {
            code: 'magic-bytes-mismatch',
            message: `file content does not match declared type ${file.contentType}`,
          },
        })
      }

      let width: number | null = null
      let height: number | null = null
      if (file.contentType.startsWith('image/')) {
        try {
          const dims = probe.sync(Buffer.from(prefix))
          if (dims && dims.width > 0 && dims.height > 0) {
            width = dims.width
            height = dims.height
          }
        } catch (err) {
          req.log.debug({ err, fileId: id }, '[files] probe-image-size failed (non-fatal)')
        }
      }

      // Сильно большие картинки ужимаем на месте — best-effort: при ошибке
      // остаётся оригинал как есть.
      let sizeBytes = file.sizeBytes
      try {
        const downscaled = await downscaleOriginal(file, width, height)
        if (downscaled) {
          width = downscaled.width
          height = downscaled.height
          sizeBytes = downscaled.sizeBytes
          req.log.info({ fileId: id, width, height, sizeBytes }, '[files] oversized image downscaled in place')
        }
      } catch (err) {
        req.log.warn({ err, fileId: id }, '[files] original downscale failed (non-fatal)')
      }

      // Миниатюра для чата — best-effort: при ошибке файл всё равно ready,
      // клиент покажет оригинал.
      let thumbKey: string | null = null
      try {
        thumbKey = await makeThumbnail({ ...file, sizeBytes }, width, height)
      } catch (err) {
        req.log.warn({ err, fileId: id }, '[files] thumbnail generation failed (non-fatal)')
      }

      const updated = await db
        .update(files)
        .set({ status: 'ready', width, height, thumbKey, sizeBytes })
        .where(eq(files.id, id))
        .returning()
      const fresh = updated[0]
      if (!fresh) throw new Error('update files returned no rows')

      return reply.code(200).send({ attachment: toAttachment(fresh) })
    },
  )
}

// ───── Helpers exported for other routes ─────

export async function attachFilesToMessage(opts: {
  fileIds: string[]
  ownerId: string
  messageId: string
  /** Подмножество fileIds, помечаемых спойлером. */
  spoilerFileIds?: string[]
  database?: DbExecutor
}): Promise<Attachment[]> {
  if (!opts.database) return db.transaction((tx) => attachFilesToMessage({ ...opts, database: tx }))
  const database = opts.database
  const { fileIds, ownerId, messageId } = opts
  const spoilerSet = new Set(opts.spoilerFileIds ?? [])
  if (fileIds.length === 0) return []
  if (new Set(fileIds).size !== fileIds.length || [...spoilerSet].some((id) => !fileIds.includes(id))) {
    throw Object.assign(new Error('invalid attachment ids'), { statusCode: 422, code: 'invalid-attachments' })
  }

  const rows = await database
    .select()
    .from(files)
    .where(and(
      inArray(files.id, fileIds),
      eq(files.ownerId, ownerId),
      eq(files.status, 'ready'),
    )).orderBy(files.id).for('update')

  // Order by original input — keep client-supplied order so previews and
  // messages render in the same sequence.
  const byId = new Map(rows.map((r) => [r.id, r]))
  const ordered = fileIds
    .map((id) => byId.get(id))
    .filter((r): r is (typeof rows)[number] => r !== undefined)

  // Reject if some files weren't found / aren't owned / aren't ready.
  if (ordered.length !== fileIds.length) {
    const reason = new Error('one or more attachments are unknown or not yet ready')
    Object.assign(reason, { statusCode: 422, code: 'invalid-attachments' })
    throw reason
  }

  // Reject if any of these files are already attached to another message.
  const reused = ordered.find((r) => r.messageId !== null && r.messageId !== messageId)
  if (reused) {
    const reason = new Error('attachment is already linked to another message')
    Object.assign(reason, { statusCode: 422, code: 'attachment-reused' })
    throw reason
  }

  const claimed = await database.update(files).set({ messageId }).where(and(
    inArray(files.id, fileIds), eq(files.ownerId, ownerId), eq(files.status, 'ready'),
    or(isNull(files.messageId), eq(files.messageId, messageId)),
  )).returning({ id: files.id })
  if (claimed.length !== fileIds.length) throw Object.assign(new Error('attachment concurrently claimed'), { statusCode: 422, code: 'attachment-reused' })
  const spoilerIds = ordered.map((r) => r.id).filter((id) => spoilerSet.has(id))
  if (spoilerIds.length > 0) {
    await database.update(files).set({ spoiler: true }).where(inArray(files.id, spoilerIds))
  }

  return ordered.map((r) => toAttachment({ ...r, spoiler: spoilerSet.has(r.id) }))
}

export async function loadAttachmentsForMessages(messageIds: string[], database: DbExecutor = db): Promise<Map<string, Attachment[]>> {
  const out = new Map<string, Attachment[]>()
  if (messageIds.length === 0) return out
  const rows = await database
    .select()
    .from(files)
    .where(and(inArray(files.messageId, messageIds), eq(files.status, 'ready')))
  for (const r of rows) {
    if (!r.messageId) continue
    const list = out.get(r.messageId) ?? []
    list.push(toAttachment(r))
    out.set(r.messageId, list)
  }
  // Stable order — by file id (uuidv7, time-ordered).
  for (const list of out.values()) list.sort((a, b) => a.id.localeCompare(b.id))
  return out
}
