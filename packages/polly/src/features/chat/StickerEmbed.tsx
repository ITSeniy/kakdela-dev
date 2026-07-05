// Рендер стикер-вложения сообщения. Крупная картинка (до 160px), клик
// открывает в лайтбоксе зум-картинкой (как гифки). Снимок StickerRef
// переживает удаление стикера из набора сервера.

import { useState } from 'react'

import type { Attachment, StickerRef } from '@kakdela/ginzu/api-types'

import { Lightbox } from './Lightbox.js'

const MAX = 160

export function StickerEmbed({ sticker }: { sticker: StickerRef }) {
  const [open, setOpen] = useState(false)

  // Целевой размер тайла: длинная сторона ≤160, сохраняя пропорции.
  let w = sticker.width
  let h = sticker.height
  if (w > MAX || h > MAX) {
    const k = MAX / Math.max(w, h)
    w = Math.round(w * k)
    h = Math.round(h * k)
  }

  const lightboxItem: Attachment = {
    id: 'sticker',
    kind: 'image',
    url: sticker.imageUrl,
    thumbUrl: sticker.imageUrl,
    contentType: 'image/png',
    originalName: sticker.name,
    sizeBytes: 0,
    width: sticker.width,
    height: sticker.height,
    spoiler: false,
    voice: false,
    circle: false,
  }

  return (
    <div className="mt-1.5">
      <button
        type="button"
        onClick={() => setOpen(true)}
        title={sticker.name}
        className="block rounded-kd hover:bg-kd-hover transition-colors p-0.5 -m-0.5"
        style={{ width: w, height: h }}
      >
        <img
          src={sticker.imageUrl}
          alt={sticker.name}
          loading="lazy"
          draggable={false}
          className="w-full h-full object-contain"
        />
      </button>
      {open && <Lightbox images={[lightboxItem]} startIndex={0} onClose={() => setOpen(false)} />}
    </div>
  )
}
