import { useState } from 'react'

import type { Attachment } from '@kakdela/ginzu/api-types'

import { Icon } from '../../components/Icon.js'
import { openExternal } from '../../lib/host/shell.js'
import { useFavorites } from '../favorites/api.js'
import { Lightbox, type LightboxContext } from './Lightbox.js'
import { AudioPlayer } from './media/AudioPlayer.js'
import { VideoCircle } from './media/VideoCircle.js'
import { VoiceMessage } from './media/VoiceMessage.js'
import { formatBytes } from './formatBytes.js'

interface AttachmentListProps {
  attachments: Attachment[]
  /** Контекст сообщения для шапки лайтбокса (автор, канал, дата, jump). */
  lightboxContext?: LightboxContext
  /** NSFW-канал: скрыть медиа за блюром до клика «показать». */
  blur?: boolean
}

/** Загруженный .gif — по MIME или расширению. Такие можно класть в избранное. */
function isGif(att: Attachment): boolean {
  return att.contentType === 'image/gif' || /\.gif$/i.test(att.originalName)
}

/** Звёздочка «в избранное» поверх gif-вложения (сосед-кнопка, не вложенная). */
function GifFavStar({ attachment, children }: { attachment: Attachment; children: React.ReactNode }) {
  const fav = useFavorites('gif')
  const existing = fav.byRef.get(attachment.url)
  const faved = existing !== undefined
  return (
    <div className="relative inline-block group">
      {children}
      <button
        type="button"
        onClick={() => {
          if (existing) fav.remove.mutate(existing.id)
          else fav.add.mutate({
            refKey:  attachment.url,
            payload: {
              gifUrl:     attachment.url,
              mp4Url:     null,
              previewUrl: attachment.thumbUrl ?? attachment.url,
              width:      attachment.width ?? 200,
              height:     attachment.height ?? 200,
              title:      attachment.originalName,
            },
          })
        }}
        title={faved ? 'убрать из избранного' : 'в избранное'}
        className={`absolute top-1.5 right-1.5 w-7 h-7 flex items-center justify-center rounded text-[14px] leading-none bg-kd-overlay-strong transition-opacity ${
          faved ? 'text-kd-warm opacity-100' : 'text-white opacity-0 group-hover:opacity-100'
        }`}
      >
        {faved ? '★' : '☆'}
      </button>
    </div>
  )
}

/** EXT для плашки карточки файла: расширение из имени, максимум 4 символа. */
function extOf(name: string): string {
  const dot = name.lastIndexOf('.')
  if (dot <= 0) return 'FILE'
  return name.slice(dot + 1).toUpperCase().slice(0, 4) || 'FILE'
}

function ImageThumb({
  attachment,
  onOpen,
}: {
  attachment: Attachment
  onOpen: () => void
}) {
  // Целевой размер: длинная сторона ≤400, высота ≤300. Высоту НЕ фиксируем —
  // задаём aspect-ratio: когда maxWidth ужимает блок в узком чате, высота
  // следует за пропорцией и картинка не обрезается object-cover'ом.
  const maxW = 400
  const maxH = 300
  let w = attachment.width ?? maxW
  let h = attachment.height ?? maxH
  if (w > maxW) { h = h * (maxW / w); w = maxW }
  if (h > maxH) { w = w * (maxH / h); h = maxH }
  return (
    <button
      type="button"
      onClick={onOpen}
      className="block rounded-kd overflow-hidden border border-kd-border bg-kd-panel-alt"
      style={{ width: Math.round(w), maxWidth: '100%', aspectRatio: `${Math.round(w)} / ${Math.round(h)}` }}
      title={attachment.originalName}
    >
      <img
        src={attachment.thumbUrl ?? attachment.url}
        alt={attachment.originalName}
        className="w-full h-full object-cover"
        loading="lazy"
      />
    </button>
  )
}

/** Превью видео в стиле фото: первый кадр + ▶, клик открывает лайтбокс. */
function VideoThumb({
  attachment,
  onOpen,
}: {
  attachment: Attachment
  onOpen: () => void
}) {
  return (
    <button
      type="button"
      onClick={onOpen}
      className="relative block rounded-kd overflow-hidden border border-kd-border bg-kd-stage"
      style={{ width: 400, maxWidth: '100%', aspectRatio: '16 / 9' }}
      title={attachment.originalName}
    >
      {/* preload=metadata рисует первый кадр без скачивания всего файла */}
      <video
        src={attachment.url}
        preload="metadata"
        muted
        playsInline
        className="w-full h-full object-cover pointer-events-none"
      />
      <span className="absolute inset-0 flex items-center justify-center">
        <span className="w-11 h-11 rounded-full bg-kd-overlay-strong text-kd-stage-text flex items-center justify-center text-[16px] pl-0.5">
          ▶
        </span>
      </span>
      <span className="absolute left-1.5 bottom-1.5 px-1.5 py-0.5 rounded bg-kd-overlay-strong text-kd-stage-text text-[9px] font-mono">
        видео · {formatBytes(attachment.sizeBytes)}
      </span>
    </button>
  )
}

function FileCard({ attachment }: { attachment: Attachment }) {
  function download(e: React.MouseEvent) {
    e.preventDefault()
    void openExternal(attachment.url)
  }
  return (
    <div
      className="inline-flex items-center gap-2 p-2 max-w-[340px] rounded-kd border border-kd-border bg-kd-panel-alt"
      title={attachment.originalName}
    >
      <div className="w-8 h-8 shrink-0 rounded bg-kd-warm text-white text-[10px] font-bold font-mono flex items-center justify-center select-none">
        {extOf(attachment.originalName)}
      </div>
      <div className="min-w-0 flex-1">
        <div className="text-[12px] text-kd-text font-semibold truncate font-sans">{attachment.originalName}</div>
        <div className="text-[11px] text-kd-text-soft font-mono">{formatBytes(attachment.sizeBytes)}</div>
      </div>
      <a
        href={attachment.url}
        onClick={download}
        title="скачать"
        className="text-kd-text-mute hover:text-kd-text shrink-0 p-1"
      >
        <Icon.Download size={13} />
      </a>
    </div>
  )
}

/** Пер-вложенный спойлер: элемент скрыт блюром + плашкой до клика. Отдельно
    от NSFW-блюра (тот гасит весь блок одной кнопкой). */
function SpoilerWrap({ children }: { children: React.ReactNode }) {
  const [revealed, setRevealed] = useState(false)
  if (revealed) return <>{children}</>
  return (
    <div className="relative inline-block">
      <div className="blur-xl pointer-events-none select-none">{children}</div>
      <button
        type="button"
        onClick={() => setRevealed(true)}
        className="absolute inset-0 flex items-center justify-center rounded-kd bg-kd-overlay-soft"
      >
        <span className="px-2 py-0.5 rounded bg-kd-bg-deep/80 text-[10px] font-mono font-bold text-kd-text uppercase tracking-wide">
          спойлер
        </span>
      </button>
    </div>
  )
}

export function AttachmentList({ attachments, lightboxContext, blur = false }: AttachmentListProps) {
  const [lightboxIdx, setLightboxIdx] = useState<number | null>(null)
  // NSFW-канал: медиа скрыто за блюром до первого клика «показать».
  const [revealed, setRevealed] = useState(false)
  if (attachments.length === 0) return null

  // В лайтбокс идут и фото, и видео — единая лента просмотра. Кружки (T-105)
  // не входят: они играют inline круглым плеером.
  const media = attachments.filter((a) => (a.kind === 'image' || a.kind === 'video') && !a.circle)

  function openMedia(att: Attachment) {
    const idx = media.findIndex((a) => a.id === att.id)
    if (idx >= 0) setLightboxIdx(idx)
  }

  function renderItem(att: Attachment) {
    switch (att.kind) {
      case 'image':
        return isGif(att)
          ? <GifFavStar attachment={att}><ImageThumb attachment={att} onOpen={() => openMedia(att)} /></GifFavStar>
          : <ImageThumb attachment={att} onOpen={() => openMedia(att)} />
      case 'video':
        return att.circle
          ? <VideoCircle attachment={att} />
          : <VideoThumb attachment={att} onOpen={() => openMedia(att)} />
      case 'audio':
        return att.voice ? <VoiceMessage attachment={att} /> : <AudioPlayer attachment={att} />
      default:
        return <FileCard attachment={att} />
    }
  }

  const hideBehindBlur = blur && !revealed

  return (
    <div className="mt-1.5 flex flex-col gap-1.5 items-start relative">
      <div className={hideBehindBlur ? 'flex flex-col gap-1.5 items-start blur-xl pointer-events-none select-none' : 'flex flex-col gap-1.5 items-start'}>
        {attachments.map((att) => (
          <div key={att.id}>
            {att.spoiler ? <SpoilerWrap>{renderItem(att)}</SpoilerWrap> : renderItem(att)}
          </div>
        ))}
      </div>
      {hideBehindBlur && (
        <button
          type="button"
          onClick={() => setRevealed(true)}
          className="absolute inset-0 flex flex-col items-center justify-center gap-1 rounded-kd bg-kd-overlay-soft text-center"
        >
          <span className="text-[13px]">🔞</span>
          <span className="text-[11px] font-mono text-kd-text font-semibold">NSFW · показать</span>
        </button>
      )}
      {lightboxIdx !== null && (
        <Lightbox
          images={media}
          startIndex={lightboxIdx}
          onClose={() => setLightboxIdx(null)}
          context={lightboxContext}
        />
      )}
    </div>
  )
}
