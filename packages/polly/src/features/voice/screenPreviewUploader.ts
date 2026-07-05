// Пока я стримлю в СЕРВЕРНОМ голосовом канале — раз в INTERVAL_MS снимаем
// кадр своей демки и заливаем на сервер (Redis, короткий TTL). Это питает
// hover-превью у участников сервера, которые НЕ в комнате: живая
// LiveKit-подписка им недоступна (см. ScreenHoverPreview).
//
// DM-звонки пропускаем: в списке личек стримы не показываются, превью не
// нужно, а серверный роут принимает только серверные voice-каналы.

import { getLocalScreenVideoTrack } from '../../lib/livekit.js'
import { uploadScreenPreview } from './api.js'
import { snapshotTrack } from './snapshot.js'
import { useVoiceStore } from './store.js'

const INTERVAL_MS = 15_000
// Первый кадр — с небольшой задержкой: сразу после публикации у трека ещё
// может не быть декодированного кадра, а зрителю превью нужно поскорее.
const FIRST_SHOT_DELAY_MS = 2_000
const PREVIEW_MAX_WIDTH = 480
const PREVIEW_JPEG_QUALITY = 0.7

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const fr = new FileReader()
    fr.onload = () => {
      const s = String(fr.result)
      resolve(s.slice(s.indexOf(',') + 1))
    }
    fr.onerror = () => reject(fr.error ?? new Error('blob read failed'))
    fr.readAsDataURL(blob)
  })
}

/** channelId активного серверного стрима или null. */
function activeStreamChannel(): string | null {
  const s = useVoiceStore.getState()
  return s.screenSharing && s.activeContext === 'channel' && s.status === 'connected'
    ? s.activeChannelId
    : null
}

/**
 * Запустить фоновый цикл заливки превью. Возвращает cleanup. Сам следит за
 * voice store: стрим начался → цикл пошёл, кончился → тихо остановился
 * (серверное превью просто истечёт по TTL).
 */
export function startScreenPreviewUploader(): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null
  let busy = false

  async function tick(): Promise<void> {
    timer = null
    const channelId = activeStreamChannel()
    if (!channelId) return
    if (!busy) {
      busy = true
      try {
        const track = getLocalScreenVideoTrack()
        if (track) {
          const blob = await snapshotTrack(track, {
            maxWidth: PREVIEW_MAX_WIDTH,
            quality: PREVIEW_JPEG_QUALITY,
          })
          await uploadScreenPreview(channelId, await blobToBase64(blob))
        }
      } catch (err) {
        // Не критично: hover-превью деградирует до «загрузка превью…»,
        // следующий тик попробует снова.
        console.warn('[voice] screen preview upload failed', err)
      } finally {
        busy = false
      }
    }
    if (activeStreamChannel() && timer === null) {
      timer = setTimeout(() => void tick(), INTERVAL_MS)
    }
  }

  const arm = () => {
    if (activeStreamChannel() && timer === null && !busy) {
      timer = setTimeout(() => void tick(), FIRST_SHOT_DELAY_MS)
    }
  }
  const unsubscribe = useVoiceStore.subscribe(arm)
  arm()

  return () => {
    unsubscribe()
    if (timer) {
      clearTimeout(timer)
      timer = null
    }
  }
}
