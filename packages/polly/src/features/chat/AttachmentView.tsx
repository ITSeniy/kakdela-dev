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

// ───── Альбом (2+ фото/видео одним сообщением, как в Telegram) ─────

/** Разбивка альбома на ряды: 2 → [2], 3 → [1,2], 4 → [2,2], дальше —
    остаток от деления на 3 первым рядом («герой»), затем ряды по 3. */
function albumRowSizes(n: number): number[] {
  if (n === 2) return [2]
  if (n === 3) return [1, 2]
  if (n === 4) return [2, 2]
  const r = n % 3
  const rows = r === 0 ? [] : [r]
  for (let left = n - r; left > 0; left -= 3) rows.push(3)
  return rows
}

/** Пропорция плитки по числу элементов в ряду: одиночный ряд — широкий кадр,
    пара — 4:3, тройка — квадраты. */
function albumAspect(rowLen: number): string {
  if (rowLen === 1) return 'aspect-[16/9]'
  if (rowLen === 2) return 'aspect-[4/3]'
  return 'aspect-square'
}

/** Плитка альбома: фото или первый кадр видео, object-cover под обрез ряда.
    Спойлер здесь пер-плиточный — первый клик снимает блюр, второй открывает. */
function AlbumTile({ attachment, onOpen }: { attachment: Attachment; onOpen: () => void }) {
  const [revealed, setRevealed] = useState(false)
  const hidden = Boolean(attachment.spoiler) && !revealed
  return (
    <button
      type="button"
      onClick={() => (hidden ? setRevealed(true) : onOpen())}
      title={attachment.originalName}
      className="relative block w-full h-full overflow-hidden bg-kd-panel-alt"
    >
      <div className={hidden ? 'w-full h-full blur-xl pointer-events-none select-none' : 'w-full h-full'}>
        {attachment.kind === 'image' ? (
          <img
            src={attachment.thumbUrl ?? attachment.url}
            alt={attachment.originalName}
            loading="lazy"
            className="w-full h-full object-cover"
          />
        ) : (
          <video
            src={attachment.url}
            preload="metadata"
            muted
            playsInline
            className="w-full h-full object-cover pointer-events-none"
          />
        )}
      </div>
      {attachment.kind === 'video' && !hidden && (
        <span className="absolute inset-0 flex items-center justify-center pointer-events-none">
          <span className="w-9 h-9 rounded-full bg-kd-overlay-strong text-kd-stage-text flex items-center justify-center text-[13px] pl-0.5">
            ▶
          </span>
        </span>
      )}
      {hidden && (
        <span className="absolute inset-0 flex items-center justify-center bg-kd-overlay-soft">
          <span className="px-2 py-0.5 rounded bg-kd-bg-deep/80 text-[10px] font-mono font-bold text-kd-text uppercase tracking-wide">
            спойлер
          </span>
        </span>
      )}
    </button>
  )
}

/** Мозаика альбома: скруглён контейнер целиком, плитки внутри с зазором 3px. */
function Album({ media, onOpen }: { media: Attachment[]; onOpen: (att: Attachment) => void }) {
  const rows: Attachment[][] = []
  let idx = 0
  for (const size of albumRowSizes(media.length)) {
    rows.push(media.slice(idx, idx + size))
    idx += size
  }
  return (
    <div className="w-[400px] max-w-full rounded-kd overflow-hidden border border-kd-border flex flex-col gap-[3px] bg-kd-panel-alt">
      {rows.map((row) => (
        <div key={row[0]?.id ?? ''} className="flex gap-[3px]">
          {row.map((att) => (
            <div key={att.id} className={`flex-1 min-w-0 ${albumAspect(row.length)}`}>
              <AlbumTile attachment={att} onOpen={() => onOpen(att)} />
            </div>
          ))}
        </div>
      ))}
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

  // 2+ фото/видео складываются в альбом-мозаику; остальные вложения
  // (файлы, аудио, кружки) рендерятся ниже поштучно, как раньше.
  const isAlbum = media.length >= 2
  const albumIds = new Set(isAlbum ? media.map((a) => a.id) : [])
  const single = attachments.filter((a) => !albumIds.has(a.id))

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
        {isAlbum && <Album media={media} onOpen={openMedia} />}
        {single.map((att) => (
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
