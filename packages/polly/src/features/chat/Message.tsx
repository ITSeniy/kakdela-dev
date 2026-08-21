import { Suspense, lazy, useEffect, useMemo, useRef, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'

import type { Channel, CustomEmoji, MemberPublic, Message as IMessage, RoleRef } from '@kakdela/ginzu/api-types'

import { Avatar } from '../../components/Avatar.js'
import { Badge } from '../../components/Badge.js'
import { confirmDialog } from '../../components/ConfirmDialog.js'
import { Icon } from '../../components/Icon.js'
import { toast } from '../../components/toast/index.js'
import { Popover } from '../../components/Popover.js'
import { memberNameColor } from '../members/MemberList.js'
import { useProfileUi } from '../profile/store.js'
import { useAppearance } from '../settings/appearance.js'
import { formatClock, useChatPrefs } from '../settings/chatPrefs.js'
import { useThreadUi } from '../threads/store.js'
import { pinMessage, unpinMessage } from './api.js'
import { AttachmentList } from './AttachmentView.js'
import { addReminder } from '../reminders/store.js'
import { EventCard } from './EventCard.js'
import { ClipEmbed } from './ClipEmbed.js'
import { GifEmbed } from './GifEmbed.js'
import { PollCard } from './PollCard.js'
import { StickerEmbed } from './StickerEmbed.js'
import { useChatDisplaySettings } from './displaySettings.js'
import { ContextMenu } from './ContextMenu.js'
import { ForwardedCard } from './ForwardedCard.js'
import { InviteEmbeds, isInviteOnlyContent } from './InviteCard.js'
import { LinkPreviews } from './LinkPreviewCard.js'
import { MessagePreview } from './MessagePreview.js'
import { useForwardUi } from './forwardStore.js'
import { Reactions } from './Reactions.js'
import { renderMarkdown, renderMarkdownInline } from './markdown.js'
import type { PendingMessage } from './types.js'

const LazyEmojiPicker = lazy(() => import('./EmojiPicker.js'))

interface MessageProps {
  message: IMessage | PendingMessage
  prev: IMessage | PendingMessage | null
  member: MemberPublic | undefined
  isOwn: boolean
  currentUserId: string | null
  pendingStatus?: 'sending' | 'error'
  memberMap: ReadonlyMap<string, MemberPublic>
  channelMap: ReadonlyMap<string, Channel>
  emojiMap?: ReadonlyMap<string, CustomEmoji>
  /** Роли сервера для рендера `@роль` (пусто/нет в DM). */
  roles?: ReadonlyArray<RoleRef>
  /** В DM и внутри самого треда «начать тред» прятать. */
  threadsAllowed?: boolean
  /** Может ли текущий пользователь закреплять (server: admin/owner). */
  canPin?: boolean
  /** NSFW-канал: блюрить медиа до клика. */
  nsfw?: boolean
  /** Проиграть анимацию входа — для сообщений, пришедших после первого рендера. */
  enter?: boolean
  onEdit: (id: string, content: string) => void
  onDelete: (id: string) => void
  onRetry?: () => void
  onReply: (message: IMessage) => void
  onAddReaction: (messageId: string, emoji: string) => void
  onRemoveReaction: (messageId: string, emoji: string) => void
}

function minutesBetween(a: string, b: string): number {
  return Math.abs(new Date(a).getTime() - new Date(b).getTime()) / 60_000
}

const ROLE_TAG: Record<string, string> = {
  owner: 'хоз',
  admin: 'адм',
}

const EDIT_WINDOW_MS = 30 * 24 * 60 * 60 * 1000

function CopyIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" width={13} height={13}>
      <rect x="9" y="9" width="13" height="13" rx="2" />
      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
    </svg>
  )
}

function Actions({
  isOwn, canDelete, editDisabled, pendingStatus, customEmoji, onReply, onCopy, onEdit, onDelete, onPickReaction,
}: {
  isOwn: boolean
  canDelete: boolean
  editDisabled: boolean
  pendingStatus: 'sending' | 'error' | undefined
  customEmoji?: ReadonlyArray<CustomEmoji>
  onReply: () => void
  onCopy: () => void
  onEdit: () => void
  /** skipConfirm = true при shift-клике — удалить без подтверждения. */
  onDelete: (skipConfirm: boolean) => void
  onPickReaction: (emoji: string) => void
}) {
  const [pickerOpen, setPickerOpen] = useState(false)
  const pickerBtnRef = useRef<HTMLButtonElement>(null)

  if (pendingStatus) return null
  return (
    // Плавающий тулбар: абсолютом в правом-верхнем углу сообщения, с подложкой —
    // не толкает контент по ширине и читается даже поверх медиа (как в Discord).
    <div className={`absolute top-1 right-3 z-20 ${pickerOpen ? 'opacity-100' : 'opacity-0'} group-hover:opacity-100 focus-within:opacity-100 transition-opacity flex items-center gap-0.5 px-0.5 py-0.5 bg-kd-panel border border-kd-border rounded-kd shadow-kd-tile text-kd-text-mute`}>
      <button ref={pickerBtnRef} type="button" onClick={() => setPickerOpen((o) => !o)} title="добавить реакцию" className="hover:text-kd-text p-1 block">
        <Icon.Smile size={13} />
      </button>
      {pickerOpen && pickerBtnRef.current && (
        <Popover anchor={pickerBtnRef.current} onClose={() => setPickerOpen(false)}>
          <Suspense fallback={<div className="p-3 text-[11px] text-kd-text-mute bg-kd-panel rounded-kd border border-kd-border">…</div>}>
            <LazyEmojiPicker
              customEmoji={customEmoji}
              onSelect={(emoji) => {
                onPickReaction(emoji)
                setPickerOpen(false)
              }}
            />
          </Suspense>
        </Popover>
      )}
      <button type="button" onClick={onReply} title="ответить" className="hover:text-kd-text p-1">
        <Icon.Reply size={13} />
      </button>
      <button type="button" onClick={onCopy} title="копировать" className="hover:text-kd-text p-1">
        <CopyIcon />
      </button>
      {isOwn && !editDisabled && (
        <button type="button" onClick={onEdit} title="изменить" className="hover:text-kd-text p-1">
          <Icon.Edit size={13} />
        </button>
      )}
      {canDelete && (
        <button
          type="button"
          onClick={(e) => onDelete(e.shiftKey)}
          title="удалить (shift — без подтверждения)"
          className="hover:text-kd-danger p-1"
        >
          <Icon.Trash size={13} />
        </button>
      )}
    </div>
  )
}

function scrollToMessage(id: string) {
  const el = document.querySelector(`[data-message-id="${id}"]`)
  if (!el) return
  el.scrollIntoView({ block: 'center', behavior: 'smooth' })
  setTimeout(() => {
    el.classList.add('kd-flash')
    el.addEventListener('animationend', () => el.classList.remove('kd-flash'), { once: true })
  }, 100)
}

export function Message({
  message, prev, member, isOwn, currentUserId, pendingStatus,
  memberMap, channelMap, emojiMap, roles, threadsAllowed = true, canPin = false, nsfw = false, enter = false,
  onEdit, onDelete, onRetry, onReply, onAddReaction, onRemoveReaction,
}: MessageProps) {
  const enterCls = enter ? 'kd-msg-in' : ''
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(message.content)
  const editRef = useRef<HTMLTextAreaElement>(null)
  const [menuPos, setMenuPos] = useState<{ x: number; y: number } | null>(null)
  const openProfile = useProfileUi((s) => s.open)
  const openThread = useThreadUi((s) => s.open)
  const startCreateThread = useThreadUi((s) => s.startCreate)
  const openForward = useForwardUi((s) => s.open)
  const queryClient = useQueryClient()

  // Пин/откреп — self-contained: дергаем API, обновление прилетит по WS msg.pin
  // (useMessages патчит pinned), список пинов в шапке инвалидируем тут же.
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
    () => renderMarkdown(message.content, { members: memberMap, channels: channelMap, emoji: emojiMap, roles }),
    [message.content, memberMap, channelMap, emojiMap, roles],
  )

  const messageReactions = 'reactions' in message ? (message.reactions ?? []) : []
  const msgReplyTo = 'replyTo' in message ? (message.replyTo ?? null) : null
  const msgAttachments = 'attachments' in message ? (message.attachments ?? []) : []
  const msgThread = 'thread' in message ? (message.thread ?? null) : null
  const msgGif = message.gif ?? null
  const msgSticker = message.sticker ?? null
  const msgClip = message.clip ?? null
  const msgPoll = 'poll' in message ? (message.poll ?? null) : null
  const pollEl = msgPoll ? <PollCard messageId={message.id} poll={msgPoll} /> : null
  const msgEvent = 'event' in message ? (message.event ?? null) : null
  const eventEl = msgEvent ? <EventCard messageId={message.id} event={msgEvent} memberMap={memberMap} /> : null

  // Цитата ответа — инлайном: эмодзи `:name:` и базовое форматирование.
  const replyHtml = useMemo(
    () => (msgReplyTo && !msgReplyTo.deleted
      ? renderMarkdownInline(msgReplyTo.content, { members: memberMap, channels: channelMap, emoji: emojiMap, roles })
      : null),
    [msgReplyTo, memberMap, channelMap, emojiMap, roles],
  )

  const previewForThread =
    message.content.length > 60 ? message.content.slice(0, 57) + '…' : message.content

  function handleStartThread() {
    startCreateThread(message.channelId, message.id, previewForThread)
  }
  function handleOpenThread() {
    if (msgThread) openThread(msgThread.channelId, message.channelId)
  }

  const currentUserRole = currentUserId ? memberMap.get(currentUserId)?.role : undefined
  const canDelete = isOwn || currentUserRole === 'admin' || currentUserRole === 'owner'
  const editDisabled = Date.now() - new Date(message.createdAt).getTime() > EDIT_WINDOW_MS

  async function confirmDelete(skipConfirm: boolean) {
    if (!skipConfirm) {
      const ok = await confirmDialog({
        title: 'удалить сообщение?',
        body: 'это действие необратимо — вложения тоже удалятся.',
        preview: (
          <div className="flex gap-2.5 items-start">
            <Avatar name={name} avatarUrl={member?.avatarUrl ?? null} size={32} />
            <div className="flex-1 min-w-0">
              <div className="flex items-baseline gap-1.5 flex-wrap">
                <span className="text-[13px] font-bold text-kd-text" style={nameStyle}>{name}</span>
                {role && <Badge variant="role">{role}</Badge>}
                <span className="text-[10px] text-kd-text-mute font-mono">{time}</span>
              </div>
              <div className="mt-0.5">
                <MessagePreview
                  message={message as IMessage}
                  memberMap={memberMap}
                  channelMap={channelMap}
                  emojiMap={emojiMap}
                />
              </div>
            </div>
          </div>
        ),
        confirmLabel: 'удалить',
        danger: true,
      })
      if (!ok) return
    }
    onDelete(message.id)
  }

  // Плотность как в Discord. compact — всё в одну строку (включая реплаи:
  // цитата строкой выше). cozy — первое сообщение группы с аватаркой,
  // продолжения (тот же автор, < 5 минут, не реплай) — без аватарки и имени,
  // время появляется на ховере в левой колонке.
  const density = useChatDisplaySettings((s) => s.density)
  const compact = density === 'compact'
  // Заливка строки под курсором — отключаемая в настройках внешнего вида.
  // --kd-hover, а не panel-alt/NN: kd-цвета в tailwind-конфиге без
  // <alpha-value>, и модификатор прозрачности на них молча не работает.
  const hoverCls = useAppearance((s) => s.hoverHighlight) ? 'hover:bg-kd-hover' : ''
  const timeFormat = useChatPrefs((s) => s.timeFormat)
  const showLinkPreviews = useChatPrefs((s) => s.showLinkPreviews)
  const grouped =
    prev !== null &&
    prev.authorId === message.authorId &&
    minutesBetween(message.createdAt, prev.createdAt) < 5 &&
    !message.replyToId

  const name = member?.displayName ?? 'неизвестно'
  // Цвет имени — старшая цветная роль (как в Discord); без неё — обычный
  // text-kd-text из класса.
  const nameColor = member ? memberNameColor(member) : null
  const nameStyle = nameColor ? { color: nameColor } : undefined
  const role = member ? ROLE_TAG[member.role] ?? null : null
  const time = formatClock(message.createdAt, timeFormat)
  const opacityCls = pendingStatus === 'sending' ? 'opacity-60' : ''

  // Контекст для шапки лайтбокса: кто, где и когда отправил картинку.
  const lightboxContext = {
    authorName: name,
    authorAvatarUrl: member?.avatarUrl ?? null,
    channelName: channelMap.get(message.channelId)?.name,
    messageId: message.id,
    createdAt: message.createdAt,
  }

  function copyContent() {
    if (navigator.clipboard) void navigator.clipboard.writeText(message.content)
  }

  function copyLink() {
    if (!navigator.clipboard) return
    // Используем текущий path — он уже включает /servers/.../channels/...
    // или /dm/..., плюс hash #msg:<id> для jump-to-message (тот же формат,
    // что использует InboxScreen).
    const url = `${window.location.origin}${window.location.pathname}#msg:${message.id}`
    void navigator.clipboard.writeText(url)
  }

  function openContextMenu(e: React.MouseEvent) {
    if (pendingStatus) return
    e.preventDefault()
    setMenuPos({ x: e.clientX, y: e.clientY })
  }

  const contextMenuEl = menuPos && !pendingStatus ? (
    <ContextMenu
      x={menuPos.x}
      y={menuPos.y}
      isOwn={isOwn}
      canDelete={canDelete}
      editDisabled={editDisabled}
      hideStartThread={!threadsAllowed || msgThread !== null}
      pinned={(message as IMessage).pinned}
      canPin={canPin}
      onReply={() => onReply(message as IMessage)}
      onStartThread={handleStartThread}
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
      onDelete={() => void confirmDelete(false)}
      onCopyText={copyContent}
      onCopyLink={copyLink}
      onClose={() => setMenuPos(null)}
    />
  ) : null

  const fwd = (message as IMessage).forwarded
  const forwardedEl = fwd ? (
    <ForwardedCard fwd={fwd} memberMap={memberMap} channelMap={channelMap} emojiMap={emojiMap} />
  ) : null
  const linkPreviewsEl = showLinkPreviews
    ? <LinkPreviews previews={(message as IMessage).linkPreviews} />
    : null
  const inviteEmbedsEl = <InviteEmbeds content={message.content} />
  // Сообщение из одной инвайт-ссылки: сырой URL прячем, его смысл несёт
  // карточка приглашения (inviteEmbedsEl).
  const showContent = Boolean(message.content) && !isInviteOnlyContent(message.content)
  const pinnedTag = (message as IMessage).pinned ? (
    <div className="flex items-center gap-1 text-[10px] text-kd-warm font-mono mb-0.5 select-none">📌 закреплено</div>
  ) : null

  function ThreadBadge() {
    if (!msgThread) return null
    return (
      <button
        type="button"
        onClick={handleOpenThread}
        className="mt-1 inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full border border-kd-border bg-kd-panel-alt hover:bg-kd-panel-hi text-[11px] text-kd-text-soft transition-colors"
        title={msgThread.archivedAt ? 'архивный тред' : 'открыть тред'}
      >
        <span className="text-kd-accent">↳</span>
        <span className="font-semibold text-kd-text">{msgThread.name}</span>
        <span className="font-mono text-[10px] text-kd-text-mute">
          {msgThread.messageCount} {msgThread.messageCount === 1 ? 'сообщ.' : 'сообщ.'}
        </span>
        {msgThread.archivedAt && (
          <span className="font-mono text-[9px] text-kd-text-mute uppercase">архив</span>
        )}
      </button>
    )
  }

  // Цитата реплая. indent выравнивает её с колонкой текста:
  // cozy — аватар 32px + gap 10px, compact — время 36px + gap 8px.
  function ReplyQuote({ indent }: { indent: string }) {
    if (!msgReplyTo) return null
    return (
      <button
        type="button"
        className={`flex items-center gap-1.5 mb-0.5 ${indent} w-full text-left text-[10px] text-kd-text-mute hover:opacity-80 transition-opacity min-w-0`}
        onClick={() => scrollToMessage(msgReplyTo.id)}
      >
        <span
          aria-hidden
          className="shrink-0 w-2.5 h-1.5 border-t border-l border-kd-text-mute rounded-tl-[3px]"
        />
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
    )
  }

  const reactionsEl = !pendingStatus && messageReactions.length > 0 ? (
    <Reactions
      messageId={message.id}
      reactions={messageReactions}
      currentUserId={currentUserId}
      memberMap={memberMap}
      emojiMap={emojiMap}
      onAdd={onAddReaction}
      onRemove={onRemoveReaction}
    />
  ) : null

  const customEmojiList = useMemo(
    () => (emojiMap && emojiMap.size > 0 ? [...emojiMap.values()] : undefined),
    [emojiMap],
  )

  const actionsEl = (
    <Actions
      isOwn={isOwn}
      canDelete={canDelete}
      editDisabled={editDisabled}
      pendingStatus={pendingStatus}
      customEmoji={customEmojiList}
      onReply={() => onReply(message as IMessage)}
      onCopy={copyContent}
      onEdit={() => setEditing(true)}
      onDelete={(skipConfirm) => void confirmDelete(skipConfirm)}
      onPickReaction={(emoji) => onAddReaction(message.id, emoji)}
    />
  )

  if (editing) {
    return (
      <div className="flex gap-2.5 px-4 py-1.5 items-start" data-message-id={message.id}>
        <div className="w-8 shrink-0" />
        <div className="flex-1 min-w-0">
          <textarea
            ref={editRef}
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

  if (compact) {
    return (
      <div
        className={`group relative px-4 py-[2px] ${hoverCls} ${opacityCls} ${enterCls}`}
        data-message-id={message.id}
        onContextMenu={openContextMenu}
      >
        {contextMenuEl}
        {actionsEl}
        <ReplyQuote indent="pl-11" />
        <div className="flex gap-2 items-baseline">
          <span className="text-[10px] text-kd-text-mute font-mono w-9 shrink-0 text-right">
            {time}
          </span>
          <button
            type="button"
            onClick={() => openProfile(message.authorId)}
            className="text-[13px] font-bold text-kd-text hover:underline shrink-0"
            style={nameStyle}
          >
            {name}
          </button>
          <div className="flex-1 min-w-0">
            {pinnedTag}
            {showContent && (
              <span className="text-[13px] text-kd-text leading-snug break-words">
                <span className="kd-md inline" dangerouslySetInnerHTML={{ __html: html }} />
                {message.editedAt && (
                  <span className="text-[9px] text-kd-text-mute font-mono ml-1">(изм.)</span>
                )}
              </span>
            )}
            {forwardedEl}
            {linkPreviewsEl}
          {inviteEmbedsEl}
            {pendingStatus === 'error' && onRetry && (
              <button type="button" onClick={onRetry} className="text-[9px] text-kd-danger font-mono hover:underline ml-1">
                ошибка · повторить?
              </button>
            )}
          </div>
        </div>
        {(msgAttachments.length > 0 || msgGif !== null || msgSticker !== null || msgClip !== null || msgPoll !== null || msgEvent !== null || msgThread !== null || reactionsEl !== null) && (
          <div className="pl-11">
            {msgAttachments.length > 0 && <AttachmentList attachments={msgAttachments} lightboxContext={lightboxContext} blur={nsfw} />}
            {msgGif && <GifEmbed gif={msgGif} />}
            {msgSticker && <StickerEmbed sticker={msgSticker} />}
            {msgClip && <ClipEmbed clip={msgClip} />}
            {pollEl}
            {eventEl}
            <ThreadBadge />
            {reactionsEl}
          </div>
        )}
      </div>
    )
  }

  if (grouped) {
    return (
      <div
        className={`group relative flex gap-2.5 px-4 py-[2px] items-start ${hoverCls} ${opacityCls} ${enterCls}`}
        data-message-id={message.id}
        onContextMenu={openContextMenu}
      >
        {contextMenuEl}
        <span className="w-8 shrink-0 text-right text-[9px] text-kd-text-mute font-mono opacity-0 group-hover:opacity-100 transition-opacity pt-1 select-none">
          {time}
        </span>
        <div className="flex-1 min-w-0">
          {pinnedTag}
          {showContent && (
            <div className="text-[13px] text-kd-text leading-relaxed break-words min-w-0">
              <div className="kd-md" dangerouslySetInnerHTML={{ __html: html }} />
              {message.editedAt && (
                <span className="text-[9px] text-kd-text-mute font-mono ml-1">(изм.)</span>
              )}
            </div>
          )}
          {forwardedEl}
          {linkPreviewsEl}
          {inviteEmbedsEl}
          {pendingStatus === 'error' && onRetry && (
            <button type="button" onClick={onRetry} className="text-[9px] text-kd-danger font-mono hover:underline">
              ошибка · повторить?
            </button>
          )}
          {msgAttachments.length > 0 && <AttachmentList attachments={msgAttachments} lightboxContext={lightboxContext} blur={nsfw} />}
          {msgGif && <GifEmbed gif={msgGif} />}
          {msgSticker && <StickerEmbed sticker={msgSticker} />}
          {msgClip && <ClipEmbed clip={msgClip} />}
          {pollEl}
          {eventEl}
          <ThreadBadge />
          {reactionsEl}
        </div>
        {actionsEl}
      </div>
    )
  }

  return (
    // pb меньше pt: снизу «доливают» py-[2px] склеенных продолжений, и при
    // симметричном py-1 зазор голова→первое продолжение был шире, чем между
    // продолжениями (6px против 4px).
    <div
      className={`group relative px-4 pt-1 pb-[2px] ${hoverCls} ${opacityCls} ${enterCls}`}
      data-message-id={message.id}
      onContextMenu={openContextMenu}
    >
      {contextMenuEl}
      {actionsEl}
      <ReplyQuote indent="pl-[42px]" />
      <div className="flex gap-2.5 items-start">
        <button
          type="button"
          onClick={() => openProfile(message.authorId)}
          title="открыть профиль"
          className="shrink-0"
        >
          <Avatar name={name} avatarUrl={member?.avatarUrl ?? null} size={32} />
        </button>
        <div className="flex-1 min-w-0">
          <div className="flex items-baseline gap-1.5 flex-wrap">
            <button
              type="button"
              onClick={() => openProfile(message.authorId)}
              className="text-[13px] font-bold text-kd-text hover:underline"
              style={nameStyle}
            >
              {name}
            </button>
            {role && <Badge variant="role">{role}</Badge>}
            <span className="text-[10px] text-kd-text-mute font-mono">{time}</span>
            {pendingStatus === 'sending' && (
              <span className="text-[9px] text-kd-text-mute font-mono">отправляется…</span>
            )}
            {pendingStatus === 'error' && onRetry && (
              <button type="button" onClick={onRetry} className="text-[9px] text-kd-danger font-mono hover:underline">
                ошибка · повторить?
              </button>
            )}
          </div>
          {pinnedTag}
          {showContent && (
            <div className="text-[13px] text-kd-text leading-relaxed mt-0.5 break-words min-w-0">
              <div className="kd-md" dangerouslySetInnerHTML={{ __html: html }} />
              {message.editedAt && (
                <span className="text-[9px] text-kd-text-mute font-mono ml-1">(изм.)</span>
              )}
            </div>
          )}
          {forwardedEl}
          {linkPreviewsEl}
          {inviteEmbedsEl}
          {msgAttachments.length > 0 && <AttachmentList attachments={msgAttachments} lightboxContext={lightboxContext} blur={nsfw} />}
          {msgGif && <GifEmbed gif={msgGif} />}
          {msgSticker && <StickerEmbed sticker={msgSticker} />}
          {msgClip && <ClipEmbed clip={msgClip} />}
          {pollEl}
          {eventEl}
          <ThreadBadge />
          {reactionsEl}
        </div>
      </div>
    </div>
  )
}
