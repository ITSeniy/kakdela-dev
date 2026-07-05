// Рендер GIF-вложения сообщения. GIPHY-гифки приходят с mp4 → рисуем <video>
// (loop/muted/autoplay): легче, чем animated-gif, и WebView2 не перезагружает
// кадры при уходе за экран. Загруженные .gif без mp4 — обычный <img>. Клик
// открывает лайтбокс (как видео для mp4, как зацикленная картинка иначе).

import { useState } from 'react'

import type { Attachment, GifEmbed as GifEmbedData } from '@kakdela/ginzu/api-types'

import { useChatPrefs } from '../settings/chatPrefs.js'
import { Lightbox } from './Lightbox.js'

const MAX_W = 320
const MAX_H = 240

export function GifEmbed({ gif }: { gif: GifEmbedData }) {
  const [open, setOpen] = useState(false)
  const autoplay = useChatPrefs((s) => s.autoplayGifs)

  // Целевой размер для тайла в ленте (длинная сторона ограничена).
  let w = gif.width
  let h = gif.height
  if (w > MAX_W) { h = h * (MAX_W / w); w = MAX_W }
  if (h > MAX_H) { w = w * (MAX_H / h); h = MAX_H }

  // В лайтбоксе гифку показываем как зацикленную КАРТИНКУ (kind='image') —
  // получаем фуллскрин-оверлей и зум/пан лайтбокса, без видео-контролов.
  const lightboxItem: Attachment = {
    id: 'gif',
    kind: 'image',
    url: gif.gifUrl,
    thumbUrl: gif.previewUrl,
    contentType: 'image/gif',
    originalName: 'GIF',
    sizeBytes: 0,
    width: gif.width,
    height: gif.height,
    spoiler: false,
    voice: false,
    circle: false,
  }

  return (
    <div className="mt-1.5">
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="relative block rounded-kd overflow-hidden border border-kd-border bg-kd-stage"
        style={{ width: Math.round(w), maxWidth: '100%', aspectRatio: `${gif.width} / ${gif.height}` }}
        title="открыть"
      >
        {gif.mp4Url ? (
          <video
            src={gif.mp4Url}
            poster={gif.previewUrl}
            autoPlay={autoplay}
            loop
            muted
            playsInline
            className="w-full h-full object-cover pointer-events-none"
          />
        ) : (
          <img
            src={gif.gifUrl}
            alt="gif"
            loading="lazy"
            draggable={false}
            className="w-full h-full object-cover pointer-events-none"
          />
        )}
        <span className="absolute left-1.5 bottom-1.5 px-1.5 py-0.5 rounded bg-kd-overlay-strong text-kd-stage-text text-[9px] font-mono font-bold tracking-wide select-none">
          GIF
        </span>
      </button>
      {open && <Lightbox images={[lightboxItem]} startIndex={0} onClose={() => setOpen(false)} />}
    </div>
  )
}
