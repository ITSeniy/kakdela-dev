import type { LocalVideoTrack, RemoteVideoTrack } from 'livekit-client'

export class SnapshotError extends Error {
  constructor(public readonly code: 'no-frame' | 'no-canvas-ctx' | 'blob-failed') {
    super(code)
    this.name = 'SnapshotError'
  }
}

/** Ждём первый декодированный кадр: сразу после attach() videoWidth ещё 0 —
    без ожидания снимок всегда падал в 'no-frame'. */
function waitForFrame(video: HTMLVideoElement, timeoutMs = 2500): Promise<void> {
  if (video.videoWidth > 0 && video.readyState >= 2) return Promise.resolve()
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new SnapshotError('no-frame')), timeoutMs)
    const done = () => {
      clearTimeout(timer)
      resolve()
    }
    // rVFC гарантирует «кадр реально нарисован»; fallback — loadeddata.
    const rvfc = (video as HTMLVideoElement & {
      requestVideoFrameCallback?: (cb: () => void) => number
    }).requestVideoFrameCallback
    if (typeof rvfc === 'function') rvfc.call(video, done)
    else video.addEventListener('loadeddata', done, { once: true })
  })
}

/**
 * Снять текущий кадр screen-share track'а в JPEG Blob:
 *
 *   1. `track.attach()` отдаёт <video> с подписанным srcObject; кадра в нём
 *      ещё нет — ждём первый через requestVideoFrameCallback (с таймаутом).
 *   2. canvas.drawImage(video, …) рисует текущий decoded-кадр.
 *   3. detach обязательно: иначе LiveKit считает video элемент активным
 *      подписчиком трека и будет дольше держать decoding pipeline.
 */
export interface SnapshotOptions {
  /** Даунскейл до этой ширины (aspect сохраняется). Для hover-превью демки
      хватает ~480px — кадр весит десятки КБ вместо сотен. */
  maxWidth?: number
  /** JPEG-качество 0..1. По умолчанию 0.85 (см. пометку T-053 ниже). */
  quality?: number
}

export async function snapshotTrack(
  track: LocalVideoTrack | RemoteVideoTrack,
  opts: SnapshotOptions = {},
): Promise<Blob> {
  const video = track.attach() as HTMLVideoElement
  video.muted = true
  try {
    // play() может реджектиться (например, элемент вне DOM в некоторых
    // браузерах) — не фатально, rVFC всё равно дождётся кадра.
    try { await video.play() } catch { /* ignore */ }
    await waitForFrame(video)
    if (video.videoWidth === 0 || video.videoHeight === 0) {
      throw new SnapshotError('no-frame')
    }
    const scale = opts.maxWidth && video.videoWidth > opts.maxWidth
      ? opts.maxWidth / video.videoWidth
      : 1
    const canvas = document.createElement('canvas')
    canvas.width = Math.round(video.videoWidth * scale)
    canvas.height = Math.round(video.videoHeight * scale)
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new SnapshotError('no-canvas-ctx')
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height)
    const blob = await new Promise<Blob | null>((resolve) => {
      // 0.85 — sweet-spot для JPEG: визуально без артефактов, ~200-500 KB
      // на 1080p. webp сильно меньше при том же качестве, но не везде
      // одинаково декодится (см. T-053 пометка).
      canvas.toBlob(resolve, 'image/jpeg', opts.quality ?? 0.85)
    })
    if (!blob) throw new SnapshotError('blob-failed')
    return blob
  } finally {
    try { track.detach(video) } catch { /* SDK already detached */ }
    video.remove()
  }
}
