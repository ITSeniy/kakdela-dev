import {
  MAX_ATTACHMENT_SIZE,
  PRESIGN_ALLOWED_CONTENT_TYPES,
  type Attachment,
  type FinalizeResponse,
  type PresignResponse,
} from '@kakdela/ginzu/api-types'

import { ApiError, apiFetch } from '../../lib/api.js'

export class UploadError extends Error {
  constructor(
    public readonly code:
      | 'presign-failed'
      | 'upload-failed'
      | 'finalize-failed'
      | 'unsupported-type'
      | 'too-large'
      | 'aborted',
    message: string,
  ) {
    super(message)
    this.name = 'UploadError'
  }
}

const SUPPORTED_TYPES: ReadonlySet<string> = new Set(PRESIGN_ALLOWED_CONTENT_TYPES)

export function isSupportedType(mime: string): boolean {
  return SUPPORTED_TYPES.has(mime)
}

export { MAX_ATTACHMENT_SIZE }

// Normalize browser-supplied MIME quirks (Windows in particular reports
// `application/x-zip-compressed` for .zip and `audio/mp3` for .mp3).
const MIME_ALIASES: Record<string, string> = {
  'application/x-zip-compressed': 'application/zip',
  'application/x-zip':            'application/zip',
  'application/vnd.rar':          'application/x-rar-compressed',
  'application/x-gzip':           'application/gzip',
  'audio/mp3':                    'audio/mpeg',
  'audio/x-mpeg':                 'audio/mpeg',
  'audio/x-mpg':                  'audio/mpeg',
  'audio/x-mp3':                  'audio/mpeg',
  'audio/x-wav':                  'audio/wav',
  'audio/wave':                   'audio/wav',
  'audio/vnd.wave':               'audio/wav',
  'audio/x-flac':                 'audio/flac',
  'audio/x-m4a':                  'audio/mp4',
  'video/x-m4v':                  'video/mp4',
}

// Браузер часто отдаёт пустой file.type для «незнакомых» расширений
// (rar/7z/flac на Windows) — добиваем по расширению.
const MIME_BY_EXT: Record<string, string> = {
  txt:  'text/plain',
  zip:  'application/zip',
  '7z': 'application/x-7z-compressed',
  rar:  'application/x-rar-compressed',
  gz:   'application/gzip',
  pdf:  'application/pdf',
  mp3:  'audio/mpeg',
  ogg:  'audio/ogg',
  wav:  'audio/wav',
  flac: 'audio/flac',
  m4a:  'audio/mp4',
  weba: 'audio/webm',
  mp4:  'video/mp4',
  webm: 'video/webm',
  mov:  'video/quicktime',
}

// Строка для `<input accept>` — системный пикер сразу фильтрует то, что мы
// умеем принимать. Расширения дублируем к MIME-типам: для части форматов
// (rar/7z/flac…) Windows не отдаёт тип, и без явного расширения пикер
// прятал бы их даже при разрешённом MIME.
export const FILE_PICKER_ACCEPT = [
  ...PRESIGN_ALLOWED_CONTENT_TYPES,
  ...Object.keys(MIME_BY_EXT).map((ext) => '.' + ext),
].join(',')

// Категории для showOpenFilePicker (File System Access API): в выпадашке
// системного пикера появляется отдельный пункт на каждую запись. `<input
// accept>` так не умеет — он даёт ровно один смешанный фильтр, поэтому
// Composer сначала пробует showOpenFilePicker и падает обратно на input.
export interface FilePickerCategory {
  description: string
  accept: Record<string, string[]>
}

const PICKER_CATEGORIES: FilePickerCategory[] = [
  {
    description: 'картинки',
    accept: {
      'image/jpeg': ['.jpg', '.jpeg'],
      'image/png':  ['.png'],
      'image/webp': ['.webp'],
      'image/gif':  ['.gif'],
    },
  },
  {
    description: 'видео',
    accept: {
      'video/mp4':       ['.mp4', '.m4v'],
      'video/webm':      ['.webm'],
      'video/quicktime': ['.mov'],
    },
  },
  {
    description: 'аудио',
    accept: {
      'audio/mpeg': ['.mp3'],
      'audio/ogg':  ['.ogg'],
      'audio/wav':  ['.wav'],
      'audio/flac': ['.flac'],
      'audio/mp4':  ['.m4a'],
      'audio/webm': ['.weba'],
    },
  },
  {
    description: 'архивы',
    accept: {
      'application/zip':               ['.zip'],
      'application/x-7z-compressed':   ['.7z'],
      'application/x-rar-compressed':  ['.rar'],
      'application/gzip':              ['.gz'],
    },
  },
  {
    description: 'документы',
    accept: {
      'application/pdf': ['.pdf'],
      'text/plain':      ['.txt'],
    },
  },
]

// Первый пункт — «всё поддерживаемое» (он же выбран по умолчанию),
// дальше категории по типу.
export const FILE_PICKER_TYPES: FilePickerCategory[] = [
  {
    description: 'все поддерживаемые',
    accept: PICKER_CATEGORIES.reduce<Record<string, string[]>>(
      (all, c) => Object.assign(all, c.accept),
      {},
    ),
  },
  ...PICKER_CATEGORIES,
]

function detectMime(file: File): string {
  const raw = file.type ? (MIME_ALIASES[file.type] ?? file.type) : ''
  if (raw) return raw
  const ext = file.name.toLowerCase().split('.').pop() ?? ''
  return MIME_BY_EXT[ext] ?? ''
}

export interface UploadOptions {
  onProgress?: (pct: number) => void
  signal?: AbortSignal
  /** Записи с устройства: флаги + длительность уезжают в presign и
      возвращаются в Attachment — клиенты рендерят особый плеер.
      voice — голосовое (T-104), circle — кружок (T-105). */
  voice?: boolean
  circle?: boolean
  durationSec?: number
}

async function putWithProgress(
  url: string,
  blob: Blob,
  contentType: string,
  { onProgress, signal }: UploadOptions,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    xhr.open('PUT', url)
    xhr.setRequestHeader('Content-Type', contentType)

    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable && onProgress) {
        onProgress(Math.round((e.loaded / e.total) * 100))
      }
    }
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) resolve()
      else reject(new UploadError('upload-failed', `S3 PUT failed: ${xhr.status} ${xhr.statusText}`))
    }
    xhr.onerror = () => reject(new UploadError('upload-failed', 'network error during upload'))
    xhr.onabort = () => reject(new UploadError('aborted', 'upload aborted'))

    if (signal) {
      if (signal.aborted) {
        xhr.abort()
      } else {
        signal.addEventListener('abort', () => xhr.abort(), { once: true })
      }
    }

    xhr.send(blob)
  })
}

/**
 * Полный двухфазный upload для T-063 attachments:
 *   1. POST /api/files/presign — создаёт DB-row 'pending', возвращает PUT URL
 *   2. PUT в MinIO (с прогрессом через XHR)
 *   3. POST /api/files/:id/finalize — сервер проверяет magic bytes,
 *      определяет dimensions, переключает в 'ready' и возвращает Attachment.
 */
export async function uploadAttachment(
  file: File,
  opts: UploadOptions = {},
): Promise<Attachment> {
  const contentType = detectMime(file)
  if (!isSupportedType(contentType)) {
    throw new UploadError('unsupported-type', `unsupported content type: ${contentType || '(unknown)'}`)
  }
  if (file.size > MAX_ATTACHMENT_SIZE) {
    throw new UploadError('too-large', `файл больше ${Math.round(MAX_ATTACHMENT_SIZE / 1024 / 1024)} МБ`)
  }

  let presign: PresignResponse
  try {
    presign = await apiFetch<PresignResponse>('/api/files/presign', {
      method: 'POST',
      body: JSON.stringify({
        contentType,
        size: file.size,
        originalName: file.name.slice(0, 255),
        ...(opts.voice ? { voice: true } : {}),
        ...(opts.circle ? { circle: true } : {}),
        ...(opts.durationSec ? { durationSec: opts.durationSec } : {}),
      }),
    })
  } catch (err) {
    const msg = err instanceof ApiError ? err.message : String(err)
    throw new UploadError('presign-failed', msg)
  }

  try {
    await putWithProgress(presign.uploadUrl, file, contentType, opts)
  } catch (err) {
    if (err instanceof UploadError) throw err
    throw new UploadError('upload-failed', err instanceof Error ? err.message : String(err))
  }

  let finalized: FinalizeResponse
  try {
    finalized = await apiFetch<FinalizeResponse>(`/api/files/${presign.fileId}/finalize`, {
      method: 'POST',
    })
  } catch (err) {
    const msg = err instanceof ApiError ? err.message : String(err)
    throw new UploadError('finalize-failed', msg)
  }

  return finalized.attachment
}

/**
 * Используется снапшотом screen-share (T-053): для него важен только
 * publicUrl, который потом вставляется в content сообщения. Двухфазный
 * flow с finalize не нужен — снапшот сразу attachable и не имеет
 * метаданных, а сам JPEG идёт прямо в чат как markdown image.
 */
export async function uploadBlob(blob: Blob): Promise<{ fileId: string; publicUrl: string }> {
  if (!SUPPORTED_TYPES.has(blob.type)) {
    throw new UploadError('unsupported-type', `unsupported content type: ${blob.type}`)
  }

  let presign: PresignResponse
  try {
    presign = await apiFetch<PresignResponse>('/api/files/presign', {
      method: 'POST',
      body: JSON.stringify({ contentType: blob.type, size: blob.size }),
    })
  } catch (err) {
    const msg = err instanceof ApiError ? err.message : String(err)
    throw new UploadError('presign-failed', msg)
  }

  let res: Response
  try {
    res = await fetch(presign.uploadUrl, {
      method: 'PUT',
      body: blob,
      headers: { 'Content-Type': blob.type },
    })
  } catch (err) {
    throw new UploadError('upload-failed', err instanceof Error ? err.message : String(err))
  }
  if (!res.ok) {
    throw new UploadError('upload-failed', `S3 PUT failed: ${res.status} ${res.statusText}`)
  }

  // Snapshot path — caller publishes publicUrl directly without finalize.
  // The finalize endpoint would still work, but T-053 messages embed the URL
  // as markdown image and don't need a structured attachment record yet.
  return { fileId: presign.fileId, publicUrl: presign.publicUrl }
}
