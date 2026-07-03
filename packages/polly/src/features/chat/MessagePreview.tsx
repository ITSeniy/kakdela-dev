// Компактное «человеческое» превью сообщения для мест, где раньше показывался
// сырой текст: диалог удаления и список закреплённых. Рендерит инлайн-markdown
// (эмодзи + картинки/гифки `![](...)`) и миниатюры вложений — чтобы было видно
// фото/видео/гиф/эмодзи, а не `![](url)` и `:smile:`.

import { useMemo } from 'react'

import type { Attachment, Channel, CustomEmoji, MemberPublic, Message } from '@kakdela/ginzu/api-types'

import { Icon } from '../../components/Icon.js'
import { renderMarkdownInline } from './markdown.js'

interface MessagePreviewProps {
  message: Pick<Message, 'content' | 'attachments' | 'forwarded' | 'gif' | 'sticker'>
  memberMap?: ReadonlyMap<string, MemberPublic>
  channelMap?: ReadonlyMap<string, Channel>
  emojiMap?: ReadonlyMap<string, CustomEmoji>
  /** Ограничение высоты текста (line-clamp). По умолчанию 3. */
  clampLines?: 2 | 3
}

function AttachmentThumb({ att }: { att: Attachment }) {
  if (att.kind === 'image') {
    return (
      <div className="relative w-12 h-12 rounded overflow-hidden border border-kd-border bg-kd-panel-alt shrink-0">
        <img src={att.thumbUrl ?? att.url} alt={att.originalName} className="w-full h-full object-cover" loading="lazy" />
      </div>
    )
  }
  if (att.kind === 'video') {
    // thumbUrl всегда null у видео (см. AttachmentSchema) — как и в
    // AttachmentList, берём первый кадр напрямую через <video preload=metadata>.
    return (
      <div className="relative w-12 h-12 rounded overflow-hidden border border-kd-border bg-kd-stage shrink-0">
        <video src={att.url} preload="metadata" muted playsInline className="w-full h-full object-cover pointer-events-none" />
        <span className="absolute inset-0 flex items-center justify-center text-white text-[12px] bg-black/30">▶</span>
      </div>
    )
  }
  if (att.kind === 'audio') {
    return (
      <div className="w-12 h-12 rounded border border-kd-border bg-kd-panel-alt flex items-center justify-center text-kd-text-mute shrink-0">
        <Icon.Speaker size={16} />
      </div>
    )
  }
  const ext = (att.originalName.split('.').pop() ?? '').toUpperCase().slice(0, 4) || 'FILE'
  return (
    <div className="w-12 h-12 rounded border border-kd-border bg-kd-panel-alt flex items-center justify-center text-[9px] font-mono font-bold text-kd-text-mute shrink-0">
      {ext}
    </div>
  )
}

export function MessagePreview({ message, memberMap, channelMap, emojiMap, clampLines = 3 }: MessagePreviewProps) {
  const html = useMemo(
    () => (message.content.trim()
      ? renderMarkdownInline(message.content, { members: memberMap, channels: channelMap, emoji: emojiMap })
      : ''),
    [message.content, memberMap, channelMap, emojiMap],
  )
  const attachments = message.attachments ?? []
  const gif = message.gif ?? null
  const sticker = message.sticker ?? null
  const clampCls = clampLines === 2 ? 'line-clamp-2' : 'line-clamp-3'
  const empty = !html && attachments.length === 0 && !gif && !sticker

  return (
    <div className="flex flex-col gap-1.5 min-w-0">
      {message.forwarded && (
        <div className="flex items-center gap-1 text-[10px] text-kd-text-mute font-mono">
          <span className="text-kd-accent">↪</span> переслано · {message.forwarded.authorName}
        </div>
      )}
      {html && (
        <div
          className={`kd-md text-[12px] text-kd-text-soft break-words ${clampCls} [&_img]:inline [&_img]:max-h-[90px] [&_img]:w-auto [&_img]:rounded [&_img]:align-middle`}
          dangerouslySetInnerHTML={{ __html: html }}
        />
      )}
      {attachments.length > 0 && (
        <div className="flex items-center gap-1.5 flex-wrap">
          {attachments.slice(0, 4).map((a) => <AttachmentThumb key={a.id} att={a} />)}
          {attachments.length > 4 && (
            <span className="text-[10px] font-mono text-kd-text-mute">+{attachments.length - 4}</span>
          )}
        </div>
      )}
      {gif && (
        <div className="relative w-16 h-12 rounded overflow-hidden border border-kd-border bg-kd-stage shrink-0">
          <img src={gif.previewUrl} alt="gif" className="w-full h-full object-cover" loading="lazy" />
          <span className="absolute left-1 bottom-1 px-1 py-px rounded bg-kd-overlay-strong text-kd-stage-text text-[8px] font-mono font-bold tracking-wide select-none">
            GIF
          </span>
        </div>
      )}
      {sticker && (
        <div className="flex items-center gap-2">
          <div className="w-12 h-12 rounded border border-kd-border bg-kd-panel-alt flex items-center justify-center overflow-hidden shrink-0">
            <img src={sticker.imageUrl} alt={sticker.name} className="w-full h-full object-contain" loading="lazy" />
          </div>
          <span className="text-[11px] text-kd-text-mute truncate">стикер «{sticker.name}»</span>
        </div>
      )}
      {empty && (
        <div className="flex items-center gap-1 text-[11px] text-kd-text-mute">
          <Icon.Paperclip size={11} /> сообщение без текста
        </div>
      )}
    </div>
  )
}
