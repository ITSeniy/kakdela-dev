// Рендер клипа Klipy (короткое видео СО звуком). В отличие от gif — не
// muted-loop: показываем постер (gif-превью) с кнопкой play, по клику
// проигрываем mp4 со звуком и нативными контролами. Звук — осознанное действие
// пользователя, чтобы лента не «загорелась» десятком клипов разом.

import { useState } from 'react'

import type { ClipEmbed as ClipEmbedData } from '@kakdela/ginzu/api-types'

import { Icon } from '../../components/Icon.js'

const MAX_W = 400
const MAX_H = 300

export function ClipEmbed({ clip }: { clip: ClipEmbedData }) {
  const [playing, setPlaying] = useState(false)

  let w = clip.width
  let h = clip.height
  if (w > MAX_W) { h = h * (MAX_W / w); w = MAX_W }
  if (h > MAX_H) { w = w * (MAX_H / h); h = MAX_H }

  return (
    <div className="mt-1.5">
      <div
        className="relative rounded-kd overflow-hidden border border-kd-border bg-kd-stage"
        style={{ width: Math.round(w), maxWidth: '100%', aspectRatio: `${clip.width} / ${clip.height}` }}
      >
        {playing ? (
          <video
            src={clip.mp4Url}
            poster={clip.previewUrl}
            autoPlay
            controls
            playsInline
            className="w-full h-full object-contain bg-black"
          />
        ) : (
          <button
            type="button"
            onClick={() => setPlaying(true)}
            title="играть со звуком"
            className="group block w-full h-full"
          >
            <img
              src={clip.previewUrl}
              alt={clip.title || 'клип'}
              loading="lazy"
              draggable={false}
              className="w-full h-full object-cover"
            />
            <span className="absolute inset-0 flex items-center justify-center">
              <span className="w-14 h-14 rounded-full bg-kd-overlay-strong text-white flex items-center justify-center pl-1 transition-transform group-hover:scale-105">
                <Icon.Play size={24} />
              </span>
            </span>
            <span className="absolute left-1.5 bottom-1.5 px-1.5 py-0.5 rounded bg-kd-overlay-strong text-kd-stage-text text-[9px] font-mono font-bold tracking-wide select-none">
              CLIP 🔊
            </span>
          </button>
        )}
      </div>
    </div>
  )
}
