import { useEffect, useRef, useState } from 'react'

import { Icon } from '../../components/Icon.js'
import {
  type DeviceMediaItem,
  ensureMediaPermission,
  getMediaThumb,
  isNativeGalleryAvailable,
  listDeviceMedia,
} from '../../lib/host/media.js'
import { MAX_ATTACHMENT_SIZE } from '../files/upload.js'

const PAGE_SIZE = 30
const THUMB_PX = 288

function formatDuration(ms: number): string {
  const totalSec = Math.round(ms / 1000)
  const m = Math.floor(totalSec / 60)
  const s = totalSec % 60
  return `${m}:${String(s).padStart(2, '0')}`
}

/** Ячейка сетки: миниатюра подгружается лениво через глобальную очередь —
    KdMedia.thumb синхронно декодирует bitmap на JS-bridge-потоке, поэтому
    грузим по одной, уступая кадр между вызовами. */
function MediaCell({ item, selectedIdx, disabled, onToggle, enqueueThumb }: {
  item: DeviceMediaItem
  /** 1-based номер в выборке; 0 — не выбран. */
  selectedIdx: number
  disabled: boolean
  onToggle: () => void
  enqueueThumb: (uri: string, cb: (data: string | null) => void) => void
}) {
  const [thumb, setThumb] = useState<string | null>(null)
  useEffect(() => {
    let alive = true
    enqueueThumb(item.uri, (data) => { if (alive) setThumb(data) })
    return () => { alive = false }
  }, [item.uri, enqueueThumb])

  return (
    <button
      type="button"
      onClick={onToggle}
      disabled={disabled}
      className={[
        'relative aspect-square rounded-md overflow-hidden bg-kd-panel-hi transition-opacity',
        disabled ? 'opacity-40' : '',
        selectedIdx > 0 ? 'ring-2 ring-kd-accent ring-inset' : '',
      ].join(' ')}
    >
      {thumb ? (
        <img src={thumb} alt="" className="w-full h-full object-cover" draggable={false} />
      ) : (
        <span className="absolute inset-0 flex items-center justify-center text-kd-text-mute">
          <Icon.Image size={20} />
        </span>
      )}
      {item.video && (
        <span className="absolute bottom-1 left-1 px-1 py-px rounded bg-black/60 text-white text-[9px] font-mono leading-tight">
          {item.durationMs > 0 ? formatDuration(item.durationMs) : 'видео'}
        </span>
      )}
      {selectedIdx > 0 && (
        <span className="absolute top-1 right-1 w-5 h-5 rounded-full bg-kd-accent text-white text-[11px] font-bold flex items-center justify-center">
          {selectedIdx}
        </span>
      )}
    </button>
  )
}

/**
 * Мобильный bottom-sheet вложений («+» в композере). Сверху — галерея
 * устройства (MediaStore через lib/host/media.ts, мультивыбор), ниже — прочие
 * действия; они закрывают sheet и открывают свои пикеры/модалки в композере.
 * На web-мобиле (нет нативного моста) галереи нет — только действия.
 */
export function AttachSheet({
  gifEnabled, showPollEvent, maxSelect,
  onClose, onPickMedia, onPickFile, onGif, onSticker, onPoll, onEvent,
}: {
  gifEnabled: boolean
  showPollEvent: boolean
  /** Сколько ещё можно прикрепить (MAX_ATTACHMENTS минус уже выбранные). */
  maxSelect: number
  onClose: () => void
  onPickMedia: (items: DeviceMediaItem[]) => void
  onPickFile: () => void
  onGif: () => void
  onSticker: () => void
  onPoll: () => void
  onEvent: () => void
}) {
  const galleryAvailable = isNativeGalleryAvailable()
  const [permission, setPermission] = useState<'pending' | 'granted' | 'denied'>('pending')
  const [items, setItems] = useState<DeviceMediaItem[]>([])
  const [exhausted, setExhausted] = useState(false)
  const [selected, setSelected] = useState<string[]>([])

  // Очередь миниатюр: по одной за макрозадачу, чтобы синхронный мост не
  // замораживал скролл. Кэш — на жизнь sheet'а.
  const thumbCache = useRef(new Map<string, string | null>())
  const thumbQueue = useRef<Array<{ uri: string; cb: (d: string | null) => void }>>([])
  const thumbPumping = useRef(false)
  const enqueueThumb = useRef((uri: string, cb: (data: string | null) => void) => {
    const cached = thumbCache.current.get(uri)
    if (cached !== undefined) { cb(cached); return }
    thumbQueue.current.push({ uri, cb })
    if (thumbPumping.current) return
    thumbPumping.current = true
    const pump = () => {
      const next = thumbQueue.current.shift()
      if (!next) { thumbPumping.current = false; return }
      const cached2 = thumbCache.current.get(next.uri)
      const data = cached2 !== undefined ? cached2 : getMediaThumb(next.uri, THUMB_PX)
      thumbCache.current.set(next.uri, data)
      next.cb(data)
      setTimeout(pump, 0)
    }
    setTimeout(pump, 0)
  }).current

  useEffect(() => {
    if (!galleryAvailable) return
    let alive = true
    void ensureMediaPermission().then((granted) => {
      if (!alive) return
      setPermission(granted ? 'granted' : 'denied')
      if (granted) {
        const first = listDeviceMedia(0, PAGE_SIZE)
        setItems(first)
        if (first.length < PAGE_SIZE) setExhausted(true)
      }
    })
    return () => { alive = false }
  }, [galleryAvailable])

  function loadMore() {
    const more = listDeviceMedia(items.length, PAGE_SIZE)
    setItems((prev) => [...prev, ...more])
    if (more.length < PAGE_SIZE) setExhausted(true)
  }

  function toggle(item: DeviceMediaItem) {
    setSelected((prev) => {
      if (prev.includes(item.uri)) return prev.filter((u) => u !== item.uri)
      if (prev.length >= maxSelect) return prev
      return [...prev, item.uri]
    })
  }

  function confirmMedia() {
    const chosen = selected
      .map((uri) => items.find((i) => i.uri === uri))
      .filter((i): i is DeviceMediaItem => i !== undefined)
    if (chosen.length > 0) onPickMedia(chosen)
  }

  const actions: Array<{ id: string; label: string; icon: typeof Icon.Smile; run: () => void }> = [
    { id: 'file', label: 'файл', icon: Icon.Paperclip, run: onPickFile },
    ...(gifEnabled ? [{ id: 'gif', label: 'гифка', icon: Icon.Image, run: onGif }] : []),
    { id: 'sticker', label: 'стикер', icon: Icon.Sticker, run: onSticker },
    ...(showPollEvent
      ? [
          { id: 'poll', label: 'опрос', icon: Icon.BarChart, run: onPoll },
          { id: 'event', label: 'встреча', icon: Icon.Calendar, run: onEvent },
        ]
      : []),
  ]

  return (
    <div className="fixed inset-0 z-50">
      <div className="absolute inset-0 bg-black/40 kd-overlay-in" onClick={onClose} />
      <div className="absolute inset-x-0 bottom-0 bg-kd-panel rounded-t-2xl border-t border-kd-border kd-toast-in kd-safe-bottom flex flex-col max-h-[75vh]">
        <div className="shrink-0 flex justify-center pt-2 pb-1">
          <div className="w-9 h-1 rounded-full bg-kd-border" />
        </div>

        {galleryAvailable && permission === 'granted' && (
          <div className="min-h-0 overflow-y-auto px-3">
            {items.length === 0 ? (
              <div className="py-8 text-center text-[11px] font-mono text-kd-text-mute">
                в галерее пока пусто
              </div>
            ) : (
              <div className="grid grid-cols-3 gap-1.5 pb-2">
                {items.map((item) => (
                  <MediaCell
                    key={item.uri}
                    item={item}
                    selectedIdx={selected.indexOf(item.uri) + 1}
                    disabled={item.size > MAX_ATTACHMENT_SIZE}
                    onToggle={() => toggle(item)}
                    enqueueThumb={enqueueThumb}
                  />
                ))}
                {!exhausted && (
                  <button
                    type="button"
                    onClick={loadMore}
                    className="aspect-square rounded-md bg-kd-panel-hi text-[11px] font-mono text-kd-text-soft"
                  >
                    ещё…
                  </button>
                )}
              </div>
            )}
          </div>
        )}
        {galleryAvailable && permission === 'denied' && (
          <div className="px-4 py-5 text-center text-[11px] font-mono text-kd-text-mute">
            нет доступа к галерее — разрешите в настройках системы
            <br />или прикрепите через «файл»
          </div>
        )}

        <div className="shrink-0 border-t border-kd-border-soft px-2 py-2 flex items-stretch justify-around">
          {actions.map(({ id, label, icon: I, run }) => (
            <button
              key={id}
              type="button"
              onClick={run}
              className="flex flex-col items-center gap-1 px-2 py-1 text-kd-text-soft active:text-kd-accent"
            >
              <span className="w-11 h-11 rounded-full bg-kd-panel-hi flex items-center justify-center">
                <I size={19} />
              </span>
              <span className="text-[10px] font-mono">{label}</span>
            </button>
          ))}
        </div>

        {selected.length > 0 && (
          <div className="shrink-0 px-3 pb-2">
            <button
              type="button"
              onClick={confirmMedia}
              className="w-full h-11 rounded-kd bg-kd-accent text-white text-[13px] font-bold flex items-center justify-center gap-2 active:bg-kd-accent-deep transition-colors"
            >
              <Icon.Send size={15} />
              прикрепить{selected.length > 1 ? ` (${selected.length})` : ''}
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
