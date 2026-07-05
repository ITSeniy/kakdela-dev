// Галерея устройства для мобильного композера («+» → фото/видео).
//
// Android: WebView-мост `window.KdMedia` (см. MainActivity.KdMediaBridge) —
// список последних фото/видео из MediaStore, миниатюры и чтение полного файла.
// Web/desktop: моста нет — isNativeGalleryAvailable() === false, композер
// откатывается на системный файловый пикер.

export interface DeviceMediaItem {
  /** content://-URI — ключ для thumb/read. */
  uri: string
  mime: string
  video: boolean
  /** Только у видео; 0 — неизвестно. */
  durationMs: number
  name: string
  size: number
}

interface KdMediaBridge {
  hasPermission(): boolean
  requestPermission(): void
  list(offset: number, limit: number): string
  thumb(uri: string, px: number): string
  read(uri: string): string
}

function bridge(): KdMediaBridge | null {
  return (window as Window & { KdMedia?: KdMediaBridge }).KdMedia ?? null
}

export function isNativeGalleryAvailable(): boolean {
  return bridge() !== null
}

/**
 * true — доступ к галерее есть (полный или «частичный» Android 14+).
 * false — пользователь отказал; спрашивать снова имеет смысл только по
 * явному тапу (система может больше не показывать диалог — тогда настройки).
 */
export async function ensureMediaPermission(): Promise<boolean> {
  const b = bridge()
  if (!b) return false
  if (b.hasPermission()) return true
  return new Promise((resolve) => {
    const onResult = (e: Event) => {
      window.removeEventListener('kd-media-permission', onResult)
      resolve(Boolean((e as CustomEvent<{ granted?: boolean }>).detail?.granted))
    }
    window.addEventListener('kd-media-permission', onResult)
    b.requestPermission()
  })
}

/** Последние фото/видео устройства, новые сверху. Пустой массив — конец. */
export function listDeviceMedia(offset: number, limit: number): DeviceMediaItem[] {
  const b = bridge()
  if (!b) return []
  try {
    const parsed: unknown = JSON.parse(b.list(offset, limit))
    if (!Array.isArray(parsed)) return []
    return parsed as DeviceMediaItem[]
  } catch {
    return []
  }
}

/** Миниатюра как data-URL; null — не получилось (грид покажет заглушку). */
export function getMediaThumb(uri: string, px: number): string | null {
  const b = bridge()
  if (!b) return null
  const data = b.thumb(uri, px)
  return data.length > 0 ? data : null
}

/** Полный файл для upload-пайплайна вложений. Бросает Error с русским текстом. */
export function readMediaAsFile(item: DeviceMediaItem): File {
  const b = bridge()
  if (!b) throw new Error('галерея недоступна')
  const parsed: unknown = JSON.parse(b.read(item.uri))
  const res = parsed as { ok: boolean; b64?: string; error?: string }
  if (!res.ok || !res.b64) throw new Error(res.error ?? 'не удалось прочитать файл')
  const bin = atob(res.b64)
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i)
  return new File([bytes], item.name, { type: item.mime })
}
