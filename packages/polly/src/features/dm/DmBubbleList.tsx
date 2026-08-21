// Лента личных сообщений «пузырями» (designs/final-dm.jsx → KD_DMBubble).
// Локальная альтернатива общему chat/MessageList: те же данные useMessages,
// те же обработчики из DmScreen — другой только рендер (свои справа на
// kd-accent, чужие слева на kd-panel, время под пузырём).

import { type MouseEvent, type TouchEvent, Suspense, lazy, useEffect, useMemo, useRef, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'

import type { Channel, CustomEmoji, DmSummary, MemberPublic, Message as IMessage } from '@kakdela/ginzu/api-types'

import { Avatar } from '../../components/Avatar.js'
import { DayDivider } from '../../components/DayDivider.js'
import { Icon } from '../../components/Icon.js'
import { toast } from '../../components/toast/index.js'
import { openExternal } from '../../lib/host/shell.js'
import { pinMessage, unpinMessage } from '../chat/api.js'
import { AttachmentList } from '../chat/AttachmentView.js'
import { ClipEmbed } from '../chat/ClipEmbed.js'
import { GifEmbed } from '../chat/GifEmbed.js'
import { StickerEmbed } from '../chat/StickerEmbed.js'
import { ContextMenu } from '../chat/ContextMenu.js'
import { EventCard } from '../chat/EventCard.js'
import { ForwardedCard } from '../chat/ForwardedCard.js'
import { PollCard } from '../chat/PollCard.js'
import { addReminder } from '../reminders/store.js'
import { InviteEmbeds, isInviteOnlyContent } from '../chat/InviteCard.js'
import { LinkPreviews } from '../chat/LinkPreviewCard.js'
import { useForwardUi } from '../chat/forwardStore.js'
import { Reactions } from '../chat/Reactions.js'
import { renderMarkdown, renderMarkdownInline } from '../chat/markdown.js'
import { chatScrollMemory } from '../chat/scrollMemory.js'
import { useMessages } from '../chat/useMessages.js'
import type { PendingMessage } from '../chat/types.js'
import { useAllServerEmoji } from '../emoji/api.js'
import { useIsMobile } from '../../app/useIsMobile.js'
import { Popover } from '../../components/Popover.js'

interface DmBubbleListProps {
  channelId: string
  currentUserId: string | null
  memberMap: Map<string, MemberPublic>
  channelMap: Map<string, Channel>
  otherUser: DmSummary['otherUser'] | undefined
  /** Курсор чтения собеседника: мои сообщения с id <= него получают ✓✓. */
  peerReadUpTo?: string | null
  pending: PendingMessage[]
  onMention?: (userId: string) => void
  onEdit: (id: string, content: string) => void
  onDelete: (id: string) => void
  onRetry: (nonce: string) => void
  onReply: (message: IMessage) => void
  onAddReaction: (messageId: string, emoji: string) => void
  onRemoveReaction: (messageId: string, emoji: string) => void
}

function sameDay(a: string, b: string): boolean {
  const da = new Date(a)
  const db = new Date(b)
  return (
    da.getFullYear() === db.getFullYear()
    && da.getMonth() === db.getMonth()
    && da.getDate() === db.getDate()
  )
}

function formatDay(iso: string): string {
  return new Date(iso).toLocaleDateString('ru', {
    day: '2-digit', month: '2-digit', year: 'numeric', weekday: 'short',
  })
}

function fmtTime(iso: string): string {
  return new Date(iso).toLocaleTimeString('ru', { hour: '2-digit', minute: '2-digit' })
}

function minutesBetween(a: string, b: string): number {
  return Math.abs(new Date(a).getTime() - new Date(b).getTime()) / 60_000
}

// Окно склейки: подряд идущие сообщения одного автора в пределах 5 минут
// «приклеиваются» — без повторного аватара и с плотным отступом.
const GROUP_WINDOW_MIN = 5

const LazyEmojiPicker = lazy(() => import('../chat/EmojiPicker.js'))

// Кнопка «реакция» в hover-кластере десктопа: открывает полный emoji-picker.
// Вынесена из общей ленты (Reactions сворачивается, когда реакций нет), чтобы
// сообщения не занимали лишнюю высоту, но добавить реакцию по-прежнему легко.
function ReactionAddButton({
  emojiList, onPick, onOpenChange,
}: {
  emojiList?: CustomEmoji[]
  onPick: (emoji: string) => void
  /** Тулбар-родитель держит opacity-100, пока пикер открыт (пикер — портал, group-hover его не «видит»). */
  onOpenChange?: (open: boolean) => void
}) {
  const [open, setOpen] = useState(false)
  const btnRef = useRef<HTMLButtonElement>(null)
  function setOpenNotify(v: boolean) {
    setOpen(v)
    onOpenChange?.(v)
  }
  return (
    <>
      <button ref={btnRef} type="button" onClick={() => setOpenNotify(!open)} title="реакция" className="hover:text-kd-text p-1 block">
        <Icon.Smile size={13} />
      </button>
      {open && btnRef.current && (
        <Popover anchor={btnRef.current} onClose={() => setOpenNotify(false)}>
          <Suspense fallback={<div className="p-3 text-[11px] text-kd-text-mute bg-kd-panel rounded-kd border border-kd-border">…</div>}>
            <LazyEmojiPicker customEmoji={emojiList} onSelect={(emoji) => { onPick(emoji); setOpenNotify(false) }} />
          </Suspense>
        </Popover>
      )}
    </>
  )
}

const EDIT_WINDOW_MS = 30 * 24 * 60 * 60 * 1000

function scrollToMessage(id: string) {
  const el = document.querySelector(`[data-message-id="${id}"]`)
  if (!el) return
  el.scrollIntoView({ block: 'center', behavior: 'smooth' })
  setTimeout(() => {
    el.classList.add('kd-flash')
    el.addEventListener('animationend', () => el.classList.remove('kd-flash'), { once: true })
  }, 100)
}

function UnreadDivider() {
  return (
    <div className="px-4 py-1 flex items-center gap-2">
      <div className="flex-1 h-px bg-kd-warm" />
      <span className="text-[9px] text-kd-warm font-bold font-mono uppercase tracking-wider">
        непрочитанное
      </span>
      <div className="flex-1 h-px bg-kd-warm" />
    </div>
  )
}

// Русская плюрализация: one / few / many.
function plural(n: number, one: string, few: string, many: string): string {
  const mod10 = n % 10
  const mod100 = n % 100
  if (mod10 === 1 && mod100 !== 11) return one
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 10 || mod100 >= 20)) return few
  return many
}

function humanDuration(sec: number): string {
  if (sec >= 3600) {
    const h = Math.round(sec / 3600)
    return `${h} ${plural(h, 'час', 'часа', 'часов')}`
  }
  if (sec >= 60) {
    const m = Math.round(sec / 60)
    return `${m} ${plural(m, 'минуту', 'минуты', 'минут')}`
  }
  return `${sec} ${plural(sec, 'секунду', 'секунды', 'секунд')}`
}

function fmtSystemWhen(iso: string): string {
  const d = new Date(iso)
  const time = d.toLocaleTimeString('ru', { hour: '2-digit', minute: '2-digit' })
  const now = new Date()
  const sameDate = (a: Date, b: Date) =>
    a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate()
  const yesterday = new Date(now)
  yesterday.setDate(now.getDate() - 1)
  if (sameDate(d, now)) return `сегодня, в ${time}`
  if (sameDate(d, yesterday)) return `вчера, в ${time}`
  return `${d.toLocaleDateString('ru', { day: '2-digit', month: '2-digit' })}, в ${time}`
}

// Системная строка в ленте (designs — call-log): по центру, приглушённая,
// иконка-телефон + текст «<имя> начал звонок, который продлился N». Не «пузырь».
function SystemLine({ message, member }: { message: IMessage; member: MemberPublic | undefined }) {
  const name = member?.displayName ?? 'кто-то'
  const sys = message.system
  let text: string
  if (sys?.kind === 'call') {
    text = `${name} начал звонок, который продлился ${humanDuration(sys.durationSec)}`
  } else {
    text = message.content
  }
  return (
    <div className="px-5 py-1.5 flex items-center justify-center gap-2 text-center select-none">
      <Icon.Phone size={12} className="text-kd-online shrink-0" />
      <span className="text-[11px] text-kd-text-mute">
        {text}. <span className="font-mono text-kd-text-mute/80">{fmtSystemWhen(message.createdAt)}</span>
      </span>
    </div>
  )
}

interface DmBubbleProps {
  message: IMessage | PendingMessage
  member: MemberPublic | undefined
  isOwn: boolean
  /** Склейка: предыдущее сообщение того же автора рядом — без аватара, плотно. */
  grouped: boolean
  /** «Хвост» группы (последнее сообщение в склейке) — под ним и висит время. */
  isGroupTail: boolean
  currentUserId: string | null
  /** Своё сообщение прочитано собеседником: ✓ → ✓✓ в meta-строке. */
  readByPeer?: boolean
  /** Скрыть галочки доставки (заметки себе: собеседника нет). */
  hideReceipt?: boolean
  pendingStatus?: 'sending' | 'error'
  memberMap: ReadonlyMap<string, MemberPublic>
  channelMap: ReadonlyMap<string, Channel>
  emojiMap?: ReadonlyMap<string, CustomEmoji>
  /** Анимация входа — для сообщений, пришедших после первого рендера. */
  enter?: boolean
  onMention?: (userId: string) => void
  onEdit: (id: string, content: string) => void
  onDelete: (id: string) => void
  onRetry?: () => void
  onReply: (message: IMessage) => void
  onAddReaction: (messageId: string, emoji: string) => void
  onRemoveReaction: (messageId: string, emoji: string) => void
}

function DmBubble({
  message, member, isOwn, grouped, isGroupTail, currentUserId, readByPeer = false, hideReceipt = false, pendingStatus,
  memberMap, channelMap, emojiMap, enter = false, onMention,
  onEdit, onDelete, onRetry, onReply, onAddReaction, onRemoveReaction,
}: DmBubbleProps) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(message.content)
  const [menuPos, setMenuPos] = useState<{ x: number; y: number } | null>(null)
  // Пикер реакций открыт — держим hover-кластер видимым: сам пикер рендерится
  // порталом в body, и group-hover на него не распространяется.
  const [reactionPickerOpen, setReactionPickerOpen] = useState(false)
  const openForward = useForwardUi((s) => s.open)
  const queryClient = useQueryClient()
  const isMobile = useIsMobile()
  // Long-press на тач: hover-кластер действий недоступен пальцем, поэтому
  // открываем то же контекст-меню по удержанию (~450 мс). Жест-флаг гасит
  // «фантомный» click после удержания (иначе он улетел бы в ссылку/упоминание).
  const lpTimer = useRef<number | null>(null)
  const lpFired = useRef(false)
  const lpStart = useRef<{ x: number; y: number } | null>(null)

  // В DM закреплять может любой из двух участников.
  function handlePinToggle(pin: boolean) {
    const fn = pin ? pinMessage : unpinMessage
    fn(message.id)
      .then(() => queryClient.invalidateQueries({ queryKey: ['pins', message.channelId] }))
      .catch((err) => {
        toast.error(pin ? 'не удалось закрепить' : 'не удалось открепить')
        console.error('[pin] failed', err)
      })
  }

  useEffect(() => {
    if (editing) setDraft(message.content)
  }, [editing, message.content])

  const html = useMemo(
    () => renderMarkdown(message.content, { members: memberMap, channels: channelMap, emoji: emojiMap }),
    [message.content, memberMap, channelMap, emojiMap],
  )
  // Цитата ответа — инлайном: эмодзи и базовое форматирование, без блочной вёрстки.
  const replyHtml = useMemo(() => {
    const r = (message as IMessage).replyTo
    return r && !r.deleted
      ? renderMarkdownInline(r.content, { members: memberMap, channels: channelMap, emoji: emojiMap })
      : null
  }, [message, memberMap, channelMap, emojiMap])

  const messageReactions = 'reactions' in message ? (message.reactions ?? []) : []
  const msgReplyTo = 'replyTo' in message ? (message.replyTo ?? null) : null
  const msgAttachments = 'attachments' in message ? (message.attachments ?? []) : []
  const msgGif = message.gif ?? null
  const msgSticker = message.sticker ?? null
  const msgClip = message.clip ?? null
  const msgPoll = 'poll' in message ? (message.poll ?? null) : null
  const msgEvent = 'event' in message ? (message.event ?? null) : null

  const name = member?.displayName ?? 'неизвестно'
  const time = fmtTime(message.createdAt)
  const canDelete = isOwn
  const editDisabled = Date.now() - new Date(message.createdAt).getTime() > EDIT_WINDOW_MS
  const opacityCls = pendingStatus === 'sending' ? 'opacity-60' : ''
  // Время-метку показываем под «хвостом» группы (последнее сообщение), а не
  // под «головой» — иначе таймстамп вклинивается между склеенными сообщениями
  // одного автора. «(изм.)» / статус отправки важно видеть на любом сообщении.
  const showMeta = isGroupTail || Boolean(message.editedAt) || Boolean(pendingStatus)

  function copyContent() {
    if (navigator.clipboard) void navigator.clipboard.writeText(message.content)
  }

  function copyLink() {
    if (!navigator.clipboard) return
    const url = `${window.location.origin}${window.location.pathname}#msg:${message.id}`
    void navigator.clipboard.writeText(url)
  }

  function openContextMenu(e: React.MouseEvent) {
    if (pendingStatus) return
    e.preventDefault()
    setMenuPos({ x: e.clientX, y: e.clientY })
  }

  function clearLongPress() {
    if (lpTimer.current !== null) { window.clearTimeout(lpTimer.current); lpTimer.current = null }
  }
  function onTouchStart(e: TouchEvent<HTMLDivElement>) {
    if (!isMobile || pendingStatus) return
    const t = e.touches[0]
    if (!t) return
    lpStart.current = { x: t.clientX, y: t.clientY }
    lpFired.current = false
    clearLongPress()
    lpTimer.current = window.setTimeout(() => {
      lpFired.current = true
      if (lpStart.current) setMenuPos({ x: lpStart.current.x, y: lpStart.current.y })
    }, 450)
  }
  function onTouchMove(e: TouchEvent<HTMLDivElement>) {
    const t = e.touches[0]
    const s = lpStart.current
    if (!t || !s) return
    if (Math.abs(t.clientX - s.x) > 10 || Math.abs(t.clientY - s.y) > 10) clearLongPress()
  }
  function onClickCapture(e: MouseEvent<HTMLDivElement>) {
    // Click сразу после успешного удержания — глушим, чтобы не сработала
    // ссылка/упоминание/спойлер под пальцем.
    if (lpFired.current) { e.preventDefault(); e.stopPropagation(); lpFired.current = false }
  }

  const contextMenuEl = menuPos && !pendingStatus ? (
    <ContextMenu
      x={menuPos.x}
      y={menuPos.y}
      isOwn={isOwn}
      canDelete={canDelete}
      editDisabled={editDisabled}
      hideStartThread
      pinned={(message as IMessage).pinned}
      canPin
      onPickReaction={(emoji) => onAddReaction(message.id, emoji)}
      onReply={() => onReply(message as IMessage)}
      onForward={() => openForward(message as IMessage)}
      onRemind={(dueAt, label) => {
        addReminder({
          messageId: message.id,
          link: `${window.location.pathname}#msg:${message.id}`,
          authorName: name,
          preview: message.content.replace(/\s+/g, ' ').trim().slice(0, 120),
          dueAt,
        })
        toast.success(`напомним ${label}`)
      }}
      onPin={() => handlePinToggle(true)}
      onUnpin={() => handlePinToggle(false)}
      onEdit={() => setEditing(true)}
      onDelete={() => onDelete(message.id)}
      onCopyText={copyContent}
      onCopyLink={copyLink}
      onClose={() => setMenuPos(null)}
    />
  ) : null

  const forwardedEl = (message as IMessage).forwarded ? (
    <ForwardedCard fwd={(message as IMessage).forwarded!} memberMap={memberMap} channelMap={channelMap} emojiMap={emojiMap} />
  ) : null

  if (editing) {
    return (
      <div className="flex gap-2.5 px-5 py-1.5 items-start" data-message-id={message.id}>
        <div className="w-7 shrink-0" />
        <div className="flex-1 min-w-0">
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') { setEditing(false); return }
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                const trimmed = draft.trim()
                if (trimmed && trimmed !== message.content) onEdit(message.id, trimmed)
                setEditing(false)
              }
            }}
            className="w-full bg-kd-panel border border-kd-accent rounded-kd p-2 text-[13px] text-kd-text outline-none resize-none font-sans"
            rows={Math.min(8, draft.split('\n').length + 1)}
            autoFocus
          />
          <div className="flex gap-3 mt-1.5 text-[10px] font-mono">
            <button type="button" onClick={() => setEditing(false)} className="text-kd-text-mute hover:text-kd-text-soft">
              отмена · esc
            </button>
            <button
              type="button"
              onClick={() => {
                const trimmed = draft.trim()
                if (trimmed && trimmed !== message.content) onEdit(message.id, trimmed)
                setEditing(false)
              }}
              className="text-kd-accent hover:text-kd-accent-deep font-bold"
            >
              сохранить ⏎
            </button>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div
      className={`group flex items-end gap-2.5 px-5 ${grouped ? 'pt-0.5' : 'pt-2'} pb-0.5 ${isOwn ? 'flex-row-reverse' : ''} ${opacityCls} ${isMobile ? 'select-none' : ''} ${enter ? 'kd-msg-in' : ''}`}
      data-message-id={message.id}
      onContextMenu={openContextMenu}
      onTouchStart={onTouchStart}
      onTouchMove={onTouchMove}
      onTouchEnd={clearLongPress}
      onClickCapture={onClickCapture}
    >
      {contextMenuEl}
      {!isOwn && !grouped ? (
        <button
          type="button"
          title="открыть профиль"
          onClick={() => onMention?.(message.authorId)}
          className="shrink-0 self-end mb-[18px]"
        >
          <Avatar name={name} avatarUrl={member?.avatarUrl ?? null} size={28} />
        </button>
      ) : (
        <div className="w-7 shrink-0" />
      )}
      <div className={`max-w-[70%] flex flex-col min-w-0 ${isOwn ? 'items-end' : 'items-start'}`}>
        {(message as IMessage).pinned && (
          <div className="flex items-center gap-1 text-[10px] text-kd-warm font-mono mb-0.5 select-none">📌 закреплено</div>
        )}
        {msgReplyTo && (
          <button
            type="button"
            className="flex items-center gap-1.5 mb-0.5 px-1 max-w-full text-left text-[10px] text-kd-text-mute hover:opacity-80 transition-opacity min-w-0"
            onClick={() => scrollToMessage(msgReplyTo.id)}
          >
            {msgReplyTo.deleted ? (
              <span className="italic truncate">↳ оригинал удалён</span>
            ) : (
              <>
                <span className="font-mono font-bold text-kd-text-soft shrink-0">
                  ↳ {msgReplyTo.authorName}
                </span>
                {msgReplyTo.content.trim()
                  ? <span className="kd-md opacity-80 truncate min-w-0" dangerouslySetInnerHTML={{ __html: replyHtml ?? '' }} />
                  : <span className="italic opacity-70 truncate min-w-0">вложение</span>}
              </>
            )}
          </button>
        )}
        {/* Обёртка контента (пузырь + медиа) — якорь hover-кластера: он центрируется
            по самому сообщению, а не по всей колонке с меткой времени и реакциями
            (self-center по колонке уводил кластер вниз у «хвостовых» сообщений). */}
        <div className={`relative max-w-full min-w-0 flex flex-col ${isOwn ? 'items-end' : 'items-start'}`}>
          {/* Медиа выше подписи (как в Telegram): фото/гифка/стикер — потом текст. */}
          {msgAttachments.length > 0 && <AttachmentList attachments={msgAttachments} />}
          {msgGif && <GifEmbed gif={msgGif} />}
          {msgSticker && <StickerEmbed sticker={msgSticker} />}
          {msgClip && <ClipEmbed clip={msgClip} />}
          {/* Сообщение из одной инвайт-ссылки — «служебный» текст прячем,
              смысл несёт карточка приглашения ниже. */}
          {message.content && !isInviteOnlyContent(message.content) && (
            <div
              className={[
                `px-3 py-[7px] rounded-kd ${isMobile ? 'text-[14px]' : 'text-[13px]'} leading-[1.45] break-words max-w-full min-w-0`,
                isOwn
                  ? 'bg-kd-accent text-white kd-on-accent'
                  : 'bg-kd-panel border border-kd-border text-kd-text',
              ].join(' ')}
            >
              <div className="kd-md" dangerouslySetInnerHTML={{ __html: html }} />
            </div>
          )}
          {forwardedEl}
          <LinkPreviews previews={(message as IMessage).linkPreviews} />
          <InviteEmbeds content={message.content} />
          {msgPoll && <PollCard messageId={message.id} poll={msgPoll} />}
          {msgEvent && <EventCard messageId={message.id} event={msgEvent} memberMap={memberMap} />}
          {/* z-20 обязателен: -translate-y-1/2 (transform) создаёт стековый
              контекст и запирает в нём z-50 пикера, а relative-обёртки следующих
              сообщений при z:auto рисовались бы поверх него (порядок DOM). */}
          {!pendingStatus && !isMobile && (
            <div
              className={`absolute top-1/2 -translate-y-1/2 z-20 ${isOwn ? 'right-full mr-2' : 'left-full ml-2'} ${reactionPickerOpen ? 'opacity-100' : 'opacity-0'} group-hover:opacity-100 focus-within:opacity-100 transition-opacity flex items-center gap-0.5 px-0.5 py-0.5 bg-kd-panel border border-kd-border rounded-kd shadow-kd-tile text-kd-text-mute`}
            >
              <ReactionAddButton
                emojiList={emojiMap && emojiMap.size > 0 ? [...emojiMap.values()] : undefined}
                onPick={(emoji) => onAddReaction(message.id, emoji)}
                onOpenChange={setReactionPickerOpen}
              />
              <button type="button" onClick={() => onReply(message as IMessage)} title="ответить" className="hover:text-kd-text p-1">
                <Icon.Reply size={13} />
              </button>
              {isOwn && !editDisabled && (
                <button type="button" onClick={() => setEditing(true)} title="изменить" className="hover:text-kd-text p-1">
                  <Icon.Edit size={13} />
                </button>
              )}
              {canDelete && (
                <button type="button" onClick={() => onDelete(message.id)} title="удалить" className="hover:text-kd-danger p-1">
                  <Icon.Trash size={13} />
                </button>
              )}
            </div>
          )}
        </div>
        {showMeta && (
          <div className="flex items-center gap-1.5 mt-[2px] px-1 text-[10px] font-mono text-kd-text-mute">
            <span>{time}</span>
            {message.editedAt && <span className="text-[9px]">(изм.)</span>}
            {/* Галочки как в Telegram: ✓ доставлено, ✓✓ прочитано собеседником. */}
            {isOwn && !pendingStatus && !hideReceipt && (
              <span
                title={readByPeer ? 'прочитано' : 'доставлено'}
                className={readByPeer ? 'text-kd-accent' : ''}
              >
                {readByPeer ? '✓✓' : '✓'}
              </span>
            )}
            {pendingStatus === 'sending' && <span className="text-[9px]">отправляется…</span>}
            {pendingStatus === 'error' && onRetry && (
              <button type="button" onClick={onRetry} className="text-[9px] text-kd-danger hover:underline">
                ошибка · повторить?
              </button>
            )}
          </div>
        )}
        {!pendingStatus && (
          <Reactions
            messageId={message.id}
            reactions={messageReactions}
            currentUserId={currentUserId}
            memberMap={memberMap}
            emojiMap={emojiMap}
            plusFirst={isOwn}
            onAdd={onAddReaction}
            onRemove={onRemoveReaction}
          />
        )}
      </div>
    </div>
  )
}

export function DmBubbleList({
  channelId, currentUserId, memberMap, channelMap, otherUser, peerReadUpTo, pending,
  onMention, onEdit, onDelete, onRetry, onReply, onAddReaction, onRemoveReaction,
}: DmBubbleListProps) {
  const { data, fetchNextPage, hasNextPage, isFetchingNextPage } = useMessages(channelId)
  // В личке нет привязки к серверу — берём emoji со всех серверов пользователя,
  // чтобы `:name:` резолвился и в DM (и в баблах, и в цитатах ответов).
  const emojiMap = useAllServerEmoji()

  // Клики внутри markdown: @упоминание → профиль, внешняя ссылка → системный
  // браузер (тот же контракт, что у chat/MessageList).
  function handleContentClick(e: MouseEvent<HTMLDivElement>) {
    let node = e.target as HTMLElement | null
    while (node && node !== e.currentTarget) {
      if (node.dataset.spoiler) {
        // Спойлер: первый клик раскрывает, повторный — прячет (как в чате).
        e.preventDefault()
        node.classList.toggle('kd-spoiler-open')
        return
      }
      if (node.dataset.mention === 'user') {
        e.preventDefault()
        const id = node.dataset.id
        if (id && onMention) onMention(id)
        return
      }
      if (node.tagName === 'A') {
        const href = (node as HTMLAnchorElement).getAttribute('href')
        if (href && /^(https?:|mailto:|tel:|ftp:)/i.test(href)) {
          e.preventDefault()
          void openExternal(href)
          return
        }
      }
      node = node.parentElement
    }
  }

  const containerRef = useRef<HTMLDivElement>(null)
  const contentRef = useRef<HTMLDivElement>(null)
  const topRef = useRef<HTMLDivElement>(null)
  const bottomRef = useRef<HTMLDivElement>(null)
  // «Прилипание» к низу считаем по scroll-позиции (запас 80px), а не по
  // IntersectionObserver сентинела: при плавном скролле или пачке сообщений
  // сентинел успевает уехать из вьюпорта, и автоскролл срывался (тот же фикс,
  // что в chat/MessageList).
  const stickToBottomRef = useRef(true)
  const prevScrollHeightRef = useRef<number | null>(null)
  const initialScrolledRef = useRef(false)
  // Снимок последнего id на момент первой загрузки — входом анимируем только
  // сообщения новее него (пришедшие вживую), не начальную пачку/историю.
  const firstSeenMaxIdRef = useRef<string | null>(null)
  const sawInitialRef = useRef(false)

  const [snapshotReadAt] = useState<string | null>(() => {
    if (typeof window === 'undefined') return null
    return window.localStorage.getItem(`kd:read:${channelId}`)
  })

  const messages = useMemo<IMessage[]>(() => {
    if (!data) return []
    const result: IMessage[] = []
    for (let i = data.pages.length - 1; i >= 0; i -= 1) {
      const page = data.pages[i]
      if (page) result.push(...page.messages)
    }
    return result
  }, [data])

  // Update last-read marker, когда низ списка реально виден
  useEffect(() => {
    const node = bottomRef.current
    const container = containerRef.current
    if (!node || !container) return
    const observer = new IntersectionObserver((entries) => {
      const entry = entries[0]
      if (!entry?.isIntersecting) return
      const latest = messages[messages.length - 1]
      if (latest) {
        window.localStorage.setItem(`kd:read:${channelId}`, latest.createdAt)
      }
    }, { root: container, threshold: 0.1 })
    observer.observe(node)
    return () => observer.disconnect()
  }, [channelId, messages])

  function handleScroll() {
    const c = containerRef.current
    if (!c) return
    const stick = c.scrollHeight - c.scrollTop - c.clientHeight < 80
    stickToBottomRef.current = stick
    // Запоминаем «момент переписки»: вернувшись в чат, откроемся тут же.
    if (stick) chatScrollMemory.delete(channelId)
    else chatScrollMemory.set(channelId, c.scrollTop)
  }

  // Контент дорастает уже после рендера (картинки, GIF, превью ссылок) —
  // ResizeObserver дожимает скролл вниз, пока юзер «прилип» к низу.
  useEffect(() => {
    const content = contentRef.current
    const container = containerRef.current
    if (!content || !container) return
    const observer = new ResizeObserver(() => {
      // Во время подгрузки старых страниц позицию восстанавливает другой эффект.
      if (prevScrollHeightRef.current !== null) return
      if (stickToBottomRef.current) container.scrollTop = container.scrollHeight
    })
    observer.observe(content)
    return () => observer.disconnect()
  }, [])

  // Fetch older when top sentinel hits
  useEffect(() => {
    const node = topRef.current
    const container = containerRef.current
    if (!node || !container) return
    const observer = new IntersectionObserver((entries) => {
      const entry = entries[0]
      if (!entry?.isIntersecting) return
      if (!hasNextPage || isFetchingNextPage) return
      prevScrollHeightRef.current = container.scrollHeight
      void fetchNextPage()
    }, { root: container, rootMargin: '200px 0px 0px 0px' })
    observer.observe(node)
    return () => observer.disconnect()
  }, [channelId, hasNextPage, isFetchingNextPage, fetchNextPage])

  // Preserve visual position after older messages prepend
  useEffect(() => {
    if (prevScrollHeightRef.current === null) return
    const container = containerRef.current
    if (!container) return
    const delta = container.scrollHeight - prevScrollHeightRef.current
    container.scrollTop = delta
    prevScrollHeightRef.current = null
  }, [messages.length])

  // Auto-scroll on new content
  const lastId = messages[messages.length - 1]?.id ?? null
  const pendingCount = pending.length
  const prevPendingCountRef = useRef(0)

  useEffect(() => {
    const container = containerRef.current
    const pendingGrew = pendingCount > prevPendingCountRef.current
    prevPendingCountRef.current = pendingCount
    if (!container) return
    if (!initialScrolledRef.current && messages.length > 0) {
      // Возврат в переписку — продолжаем с запомненного места; иначе — вниз.
      const saved = chatScrollMemory.get(channelId)
      if (saved !== undefined) {
        container.scrollTop = saved
        stickToBottomRef.current = false
      } else {
        container.scrollTop = container.scrollHeight
      }
      initialScrolledRef.current = true
      return
    }
    // Своя отправка тянет вниз из любой позиции (как в Discord/Telegram).
    if (pendingGrew) {
      stickToBottomRef.current = true
      container.scrollTop = container.scrollHeight
      return
    }
    // Мгновенный прыжок вместо smooth: за время smooth-анимации позиция
    // «не у низа» и следующее сообщение ломало прилипание.
    if (stickToBottomRef.current) {
      container.scrollTop = container.scrollHeight
    }
  }, [lastId, pendingCount, messages.length, channelId])

  useEffect(() => {
    initialScrolledRef.current = false
    stickToBottomRef.current = true
    sawInitialRef.current = false
    firstSeenMaxIdRef.current = null
  }, [channelId])

  useEffect(() => {
    if (!sawInitialRef.current && messages.length > 0) {
      sawInitialRef.current = true
      firstSeenMaxIdRef.current = messages[messages.length - 1]?.id ?? null
    }
  }, [messages])

  // Deep-link `#msg:<id>` (переход из Inbox/поиска): когда сообщение
  // появляется в DOM — скроллим к нему и подсвечиваем kd-flash.
  useEffect(() => {
    function jumpToHashTarget() {
      const hash = window.location.hash
      const m = /^#msg:([0-9a-f-]+)$/i.exec(hash)
      if (!m) return false
      const el = document.querySelector(`[data-message-id="${m[1]}"]`)
      if (!el) return false
      el.scrollIntoView({ block: 'center', behavior: 'smooth' })
      setTimeout(() => {
        el.classList.add('kd-flash')
        el.addEventListener('animationend', () => el.classList.remove('kd-flash'), { once: true })
      }, 100)
      return true
    }
    if (messages.length === 0) return undefined
    jumpToHashTarget()
    const handler = () => { jumpToHashTarget() }
    window.addEventListener('hashchange', handler)
    return () => window.removeEventListener('hashchange', handler)
  }, [channelId, messages.length])

  const firstUnreadIndex = useMemo(() => {
    if (!snapshotReadAt) return -1
    // Своя отправка «прочитывает» чат — маркер «непрочитанное» убираем.
    if (pending.length > 0) return -1
    if (currentUserId !== null
      && messages.some((m) => m.authorId === currentUserId && m.createdAt > snapshotReadAt)) {
      return -1
    }
    return messages.findIndex((m) =>
      m.createdAt > snapshotReadAt && m.authorId !== currentUserId,
    )
  }, [messages, snapshotReadAt, currentUserId, pending.length])

  // Nonce'ы уже приземлившихся сообщений: pending-строку с таким nonce не
  // рендерим — WS msg.new часто обгоняет REST-ответ, и своё сообщение на
  // мгновение мигало дублем («телепорт» вниз).
  const landedNonces = useMemo(() => {
    const s = new Set<string>()
    for (const m of messages) if (m.clientNonce) s.add(m.clientNonce)
    return s
  }, [messages])

  type ItemRow =
    | { type: 'day'; label: string }
    | { type: 'unread' }
    | { type: 'system'; msg: IMessage }
    | {
        type: 'msg'
        msg: IMessage | PendingMessage
        isPending: boolean
        grouped: boolean
        tail: boolean
      }
  type MsgRow = Extract<ItemRow, { type: 'msg' }>

  const rows: ItemRow[] = []
  // prevForMsg — для day-разделителя (любое последнее сообщение); groupAnchor —
  // последнее ОБЫЧНОЕ сообщение для склейки (системные строки её разрывают).
  // lastMsgRow — строка groupAnchor'а: когда следующее сообщение к ней
  // приклеивается, снимаем с неё tail (время несёт только хвост группы).
  let prevForMsg: IMessage | PendingMessage | null = null
  let groupAnchor: IMessage | PendingMessage | null = null
  let lastMsgRow: MsgRow | null = null
  for (let i = 0; i < messages.length; i += 1) {
    const m = messages[i]!
    const dayBreak = prevForMsg === null || !sameDay(prevForMsg.createdAt, m.createdAt)
    if (dayBreak) rows.push({ type: 'day', label: formatDay(m.createdAt) })
    const unreadHere = i === firstUnreadIndex
    if (unreadHere) rows.push({ type: 'unread' })
    if ((m as IMessage).system) {
      rows.push({ type: 'system', msg: m })
      groupAnchor = null // системная строка разрывает склейку
      lastMsgRow = null
      prevForMsg = m
      continue
    }
    // Ответ-сообщение всегда начинает новую «реплику» — со своим аватаром и
    // отступом, чтобы цитата читалась.
    const hasReply = 'replyTo' in m && (m as IMessage).replyTo != null
    const grouped =
      !dayBreak && !unreadHere && !hasReply
      && groupAnchor !== null
      && groupAnchor.authorId === m.authorId
      && minutesBetween(groupAnchor.createdAt, m.createdAt) < GROUP_WINDOW_MIN
    if (grouped && lastMsgRow) lastMsgRow.tail = false
    const row: MsgRow = { type: 'msg', msg: m, isPending: false, grouped, tail: true }
    rows.push(row)
    lastMsgRow = row
    prevForMsg = m
    groupAnchor = m
  }
  for (let i = 0; i < pending.length; i += 1) {
    const p = pending[i]!
    if (landedNonces.has(p._nonce)) continue
    const grouped =
      groupAnchor !== null
      && groupAnchor.authorId === p.authorId
      && minutesBetween(groupAnchor.createdAt, p.createdAt) < GROUP_WINDOW_MIN
    if (grouped && lastMsgRow) lastMsgRow.tail = false
    const row: MsgRow = { type: 'msg', msg: p, isPending: true, grouped, tail: true }
    rows.push(row)
    lastMsgRow = row
    prevForMsg = p
    groupAnchor = p
  }

  // Карточка начала переписки (designs/final-dm.jsx): показываем, когда вся
  // история догружена (или переписка пустая).
  const historyStartReached = data !== undefined && !hasNextPage

  return (
    <div
      ref={containerRef}
      className="flex-1 overflow-y-auto min-h-0 py-2"
      onClick={handleContentClick}
      onScroll={handleScroll}
    >
      <div ref={contentRef}>
      <div ref={topRef} className="h-1" />
      {isFetchingNextPage && (
        <div className="text-center py-2 text-[10px] text-kd-text-mute font-mono">
          загружаем…
        </div>
      )}
      {historyStartReached && otherUser && (
        <div className="mx-5 my-2.5 p-3.5 bg-kd-panel-alt border border-kd-border rounded-kd flex items-center gap-3.5">
          <Avatar name={otherUser.displayName} avatarUrl={otherUser.avatarUrl} size={48} />
          <div className="flex-1 min-w-0">
            <div className="text-[13px] font-bold text-kd-text">
              {otherUser.id === currentUserId
                ? 'это ваши заметки'
                : `это начало вашей переписки с ${otherUser.displayName}`}
            </div>
            <div className="text-[11px] text-kd-text-soft mt-0.5">
              {otherUser.id === currentUserId
                ? 'кидайте сюда ссылки и файлы — они синхронизируются между компьютером и телефоном.'
                : 'личные сообщения видны только вам двоим.'}
            </div>
          </div>
        </div>
      )}
      {rows.map((row, idx) => {
        if (row.type === 'day') return <DayDivider key={`day-${idx}`} label={row.label} />
        if (row.type === 'unread') return <UnreadDivider key={`unread-${idx}`} />
        if (row.type === 'system') {
          return <SystemLine key={row.msg.id} message={row.msg} member={memberMap.get(row.msg.authorId)} />
        }
        const m = row.msg
        const key = row.isPending ? (m as PendingMessage)._nonce : m.id
        const enter = !row.isPending
          && firstSeenMaxIdRef.current !== null
          && m.id > firstSeenMaxIdRef.current
          && m.authorId !== currentUserId
        return (
          <DmBubble
            key={key}
            message={m}
            member={memberMap.get(m.authorId)}
            isOwn={m.authorId === currentUserId}
            grouped={row.grouped}
            isGroupTail={row.tail}
            currentUserId={currentUserId}
            readByPeer={
              !row.isPending
              && m.authorId === currentUserId
              && peerReadUpTo != null
              // id — uuidv7 (time-ordered), поэтому строкового сравнения хватает.
              && m.id <= peerReadUpTo
            }
            hideReceipt={otherUser !== undefined && otherUser.id === currentUserId}
            enter={enter}
            pendingStatus={row.isPending ? (m as PendingMessage)._pending : undefined}
            memberMap={memberMap}
            channelMap={channelMap}
            emojiMap={emojiMap}
            onMention={onMention}
            onEdit={onEdit}
            onDelete={onDelete}
            onRetry={row.isPending ? () => onRetry((m as PendingMessage)._nonce) : undefined}
            onReply={onReply}
            onAddReaction={onAddReaction}
            onRemoveReaction={onRemoveReaction}
          />
        )
      })}
      <div ref={bottomRef} className="h-1" />
      </div>
    </div>
  )
}
