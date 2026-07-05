import { fileTypeFromBuffer } from 'file-type'

export const ALLOWED_MIME_TYPES = [
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif',
  'video/mp4',
  'video/webm',
  'video/quicktime',
  'audio/mpeg',
  'audio/ogg',
  'audio/wav',
  'audio/flac',
  'audio/mp4',
  'audio/webm',
  'application/pdf',
  'text/plain',
  'application/zip',
  'application/x-7z-compressed',
  'application/x-rar-compressed',
  'application/gzip',
] as const

export type AllowedMimeType = (typeof ALLOWED_MIME_TYPES)[number]

export const MAX_FILE_SIZE_BYTES = 25 * 1024 * 1024 // 25 MB

const ALLOWED_SET: ReadonlySet<string> = new Set(ALLOWED_MIME_TYPES)

export function isAllowedMime(mime: string): mime is AllowedMimeType {
  return ALLOWED_SET.has(mime)
}

export const EXTENSION_FOR_TYPE: Record<AllowedMimeType, string> = {
  'image/jpeg':       'jpg',
  'image/png':        'png',
  'image/webp':       'webp',
  'image/gif':        'gif',
  'video/mp4':        'mp4',
  'video/webm':       'webm',
  'video/quicktime':  'mov',
  'audio/mpeg':       'mp3',
  'audio/ogg':        'ogg',
  'audio/wav':        'wav',
  'audio/flac':       'flac',
  'audio/mp4':        'm4a',
  'audio/webm':       'weba',
  'application/pdf':  'pdf',
  'text/plain':       'txt',
  'application/zip':  'zip',
  'application/x-7z-compressed':  '7z',
  'application/x-rar-compressed': 'rar',
  'application/gzip':             'gz',
}

// MIME types whose real bytes file-type can identify. text/plain has no
// magic bytes and must be checked separately (heuristic: ASCII/UTF-8 only).
const MAGIC_DETECTABLE: ReadonlySet<AllowedMimeType> = new Set<AllowedMimeType>([
  'image/jpeg', 'image/png', 'image/webp', 'image/gif',
  'video/mp4', 'video/webm', 'video/quicktime',
  'audio/mpeg', 'audio/ogg', 'audio/wav', 'audio/flac', 'audio/mp4',
  'audio/webm',
  'application/pdf',
  'application/zip', 'application/x-7z-compressed',
  'application/x-rar-compressed', 'application/gzip',
])

// file-type в разных версиях отдаёт разные синонимы — нормализуем к нашему
// каноничному списку перед сравнением.
const DETECTED_MIME_ALIASES: Record<string, string> = {
  'audio/mp3':            'audio/mpeg',
  'audio/x-wav':          'audio/wav',
  'audio/vnd.wave':       'audio/wav',
  'audio/wave':           'audio/wav',
  'audio/x-flac':         'audio/flac',
  'audio/x-m4a':          'audio/mp4',
  'video/x-m4v':          'video/mp4',
  'application/vnd.rar':  'application/x-rar-compressed',
}

export type MagicCheck =
  | { ok: true; detectedMime: AllowedMimeType }
  | { ok: false; reason: 'mismatch' | 'unknown' | 'not-text'; detectedMime?: string }

/**
 * Sniff the real content type from the first few KB of the file and compare
 * with the declared MIME. We refuse to trust the client's contentType — that
 * value was set on presign time and could be a lie (e.g. an .exe declared as
 * image/png to slip past the whitelist).
 *
 * `file-type` reads magic bytes; ~64 KB is more than enough for every format
 * we accept (most need < 100 bytes). For text/plain we approximate by
 * rejecting anything that contains a NUL byte in the prefix.
 */
export async function checkMagicBytes(
  declared: AllowedMimeType,
  prefix: Uint8Array,
): Promise<MagicCheck> {
  if (declared === 'text/plain') {
    for (let i = 0; i < prefix.length; i += 1) {
      if (prefix[i] === 0) return { ok: false, reason: 'not-text' }
    }
    return { ok: true, detectedMime: 'text/plain' }
  }

  const detected = await fileTypeFromBuffer(prefix)
  if (!detected) {
    return MAGIC_DETECTABLE.has(declared)
      ? { ok: false, reason: 'unknown' }
      : { ok: true, detectedMime: declared }
  }

  const detectedMime = DETECTED_MIME_ALIASES[detected.mime] ?? detected.mime

  // file-type различает webm только по контейнеру (EBML) и всегда отдаёт
  // video/webm — audio-only webm из MediaRecorder (голосовые, T-104) с точки
  // зрения magic bytes неотличим, поэтому допускаем его под audio/webm.
  if (declared === 'audio/webm' && detectedMime === 'video/webm') {
    return { ok: true, detectedMime: declared }
  }

  if (detectedMime !== declared) {
    return { ok: false, reason: 'mismatch', detectedMime }
  }
  return { ok: true, detectedMime: declared as AllowedMimeType }
}
