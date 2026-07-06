// Карточки превью ссылок (OG-метаданные). Сервер снимает их асинхронно после
// отправки и кладёт в message.linkPreviews; здесь только рендер. Клик ведёт во
// внешний браузер через host/shell (как обычные ссылки в markdown).
//
// kind='image' — прямая ссылка на картинку: показываем только изображение.
// kind='link' — обычная карточка: сайт · заголовок · описание (+ превью-картинка).

import { useState } from 'react'

import type { LinkPreview } from '@kakdela/ginzu/api-types'

import { openExternal } from '../../lib/host/shell.js'
import { isInviteUrl } from './InviteCard.js'

const MAX_CARDS = 3

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return url
  }
}

function PreviewImage({ src, alt, onOpen }: { src: string; alt: string; onOpen: () => void }) {
  return (
    <button
      type="button"
      onClick={onOpen}
      className="block mt-1.5 rounded-kd overflow-hidden border border-kd-border bg-kd-panel-alt max-w-full"
      style={{ maxWidth: 400 }}
      title={alt || 'открыть'}
    >
      <img
        src={src}
        alt={alt}
        loading="lazy"
        className="block w-full max-h-[260px] object-cover"
        // Битые og:image не должны оставлять пустую рамку — прячем сам img.
        onError={(e) => { (e.currentTarget.parentElement as HTMLElement).style.display = 'none' }}
      />
    </button>
  )
}

/** Встраиваемый плеер (YouTube): превью-кадр с ▶, по клику — inline iframe. */
function VideoEmbed({ preview }: { preview: LinkPreview }) {
  const [playing, setPlaying] = useState(false)
  const site = preview.siteName || 'видео'
  return (
    <div className="mt-1 border-l-[3px] border-kd-accent/50 bg-kd-panel-alt rounded-r-kd pl-2.5 pr-3 py-2 max-w-[440px] min-w-0">
      <div className="text-[10px] font-mono text-kd-text-mute truncate">{site}</div>
      {preview.title && (
        <button
          type="button"
          onClick={() => { void openExternal(preview.url) }}
          className="block text-left text-[13px] font-semibold text-kd-accent hover:underline break-words mt-0.5 min-w-0"
          title={preview.url}
        >
          {preview.title}
        </button>
      )}
      <div
        className="mt-1.5 rounded-kd overflow-hidden bg-black max-w-full"
        style={{ width: 400, maxWidth: '100%', aspectRatio: '16 / 9' }}
      >
        {playing && preview.embedUrl ? (
          <iframe
            src={`${preview.embedUrl}?autoplay=1`}
            title={preview.title ?? 'video'}
            className="w-full h-full"
            allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; fullscreen"
            allowFullScreen
          />
        ) : (
          <button
            type="button"
            onClick={() => setPlaying(true)}
            className="relative w-full h-full group"
            title="смотреть"
          >
            {preview.imageUrl && (
              <img src={preview.imageUrl} alt={preview.title ?? ''} className="w-full h-full object-cover" loading="lazy" />
            )}
            <span className="absolute inset-0 flex items-center justify-center">
              <span className="flex items-center justify-center w-14 h-10 rounded-xl bg-kd-danger/90 text-white text-[18px] group-hover:scale-110 transition-transform">▶</span>
            </span>
          </button>
        )}
      </div>
    </div>
  )
}

function Card({ preview }: { preview: LinkPreview }) {
  const open = () => { void openExternal(preview.url) }

  // Встраиваемое видео (YouTube) — превью с плеером.
  if (preview.kind === 'video') {
    return <VideoEmbed preview={preview} />
  }

  // Прямая картинка — без «обвязки» карточки, только изображение.
  if (preview.kind === 'image') {
    return preview.imageUrl ? <PreviewImage src={preview.imageUrl} alt={preview.title ?? ''} onOpen={open} /> : null
  }

  const site = preview.siteName || hostOf(preview.url)
  return (
    <div className="mt-1 border-l-[3px] border-kd-accent/50 bg-kd-panel-alt rounded-r-kd pl-2.5 pr-3 py-2 max-w-[440px] min-w-0">
      <div className="text-[10px] font-mono text-kd-text-mute truncate">{site}</div>
      {preview.title && (
        <button
          type="button"
          onClick={open}
          className="block text-left text-[13px] font-semibold text-kd-accent hover:underline break-words mt-0.5 min-w-0"
          title={preview.url}
        >
          {preview.title}
        </button>
      )}
      {preview.description && (
        <div className="text-[12px] text-kd-text-soft leading-snug break-words mt-0.5 line-clamp-3">
          {preview.description}
        </div>
      )}
      {preview.imageUrl && <PreviewImage src={preview.imageUrl} alt={preview.title ?? site} onOpen={open} />}
    </div>
  )
}

export function LinkPreviews({ previews }: { previews: LinkPreview[] | undefined }) {
  if (!previews || previews.length === 0) return null
  // Инвайт-ссылки уже показаны карточкой приглашения (InviteEmbeds) —
  // OG-превью для них дублирует информацию и только шумит.
  const shown = previews.filter((p) => !isInviteUrl(p.url))
  if (shown.length === 0) return null
  return (
    <div className="flex flex-col items-start min-w-0">
      {shown.slice(0, MAX_CARDS).map((p, i) => (
        <Card key={`${p.url}-${i}`} preview={p} />
      ))}
    </div>
  )
}
