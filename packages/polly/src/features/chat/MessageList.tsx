import { type MouseEvent, useEffect, useMemo, useRef, useState } from 'react'
import { useLocation } from 'wouter'

import type { Channel, CustomEmoji, MemberPublic, Message as IMessage, RoleRef } from '@kakdela/ginzu/api-types'

import { DayDivider } from '../../components/DayDivider.js'
import { openExternal } from '../../lib/host/shell.js'
import { GreetingBanner } from './GreetingBanner.js'
import { Message } from './Message.js'
import { chatScrollMemory } from './scrollMemory.js'
import { useMessages } from './useMessages.js'
import type { PendingMessage } from './types.js'

interface MessageListProps {
  serverId: string
  channelId: string
  currentUserId: string | null
  memberMap: Map<string, MemberPublic>
  channelMap: Map<string, Channel>
  /** Map name → custom emoji для рендера `:name:` в markdown. */
  emojiMap?: ReadonlyMap<string, CustomEmoji>
  /** Роли сервера для рендера `@роль`. */
  roles?: ReadonlyArray<RoleRef>
  pending: PendingMessage[]
  /** Когда false — пункт «начать тред» в контекстном меню скрывается. */
  threadsAllowed?: boolean
  /** Может ли пользователь закреплять (server: admin/owner). */
  canPin?: boolean
  /** NSFW-канал: блюрить медиа в сообщениях. */
  nsfw?: boolean
  onEdit: (id: string, content: string) => void
  onDelete: (id: string) => void
  onRetry: (nonce: string) => void
  onMention?: (userId: string) => void
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

// Системная строка по центру (вступление участника, день рождения) —
// приглушённая, не «пузырь».

// Потолок авто-подгрузки истории при deep-link #msg: (~40 страниц × 50
// сообщений): чужой/удалённый id не должен гонять пагинацию вечно.
const MAX_HASH_WALK_PAGES = 40

function SystemLine({ message, name }: { message: IMessage; name: string }) {
  if (message.system?.kind === 'birthday') {
    return (
      <div className="px-4 py-1.5 flex items-center justify-center gap-1.5 text-[11px] select-none">
        <span>🎂</span>
        <span className="text-kd-text-soft">
          сегодня день рождения у <span className="font-semibold text-kd-text">{name}</span> — поздравьте!
        </span>
        <span>🎉</span>
      </div>
    )
  }
  const suffix = message.system?.kind === 'join' ? 'присоединился к серверу' : message.content
  return (
    <div className="px-4 py-1 flex items-center justify-center gap-1.5 text-[11px] text-kd-text-mute select-none">
      <span className="text-kd-text-soft">→</span>
      <span><span className="font-semibold text-kd-text-soft">{name}</span> {suffix}</span>
    </div>
  )
}

export function MessageList({
  serverId, channelId, currentUserId, memberMap, channelMap, emojiMap, roles,
  pending, threadsAllowed = true, canPin = false, nsfw = false,
  onEdit, onDelete, onRetry, onMention, onReply, onAddReaction, onRemoveReaction,
}: MessageListProps) {
  const [, navigate] = useLocation()
  const { data, fetchNextPage, hasNextPage, isFetchingNextPage } = useMessages(channelId)

  function handleContentClick(e: MouseEvent<HTMLDivElement>) {
    let node = e.target as HTMLElement | null
    while (node && node !== e.currentTarget) {
      // Спойлер: первый клик раскрывает, повторный — прячет обратно.
      if (node.dataset.spoiler) {
        e.preventDefault()
        node.classList.toggle('kd-spoiler-open')
        return
      }
      const mention = node.dataset.mention
      if (mention === 'user') {
        e.preventDefault()
        const id = node.dataset.id
        if (id && onMention) onMention(id)
        return
      }
      if (mention === 'channel') {
        e.preventDefault()
        const id = node.dataset.id
        if (id) navigate(`/servers/${serverId}/channels/${id}`)
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
  // сентинел успевает уехать из вьюпорта, и автоскролл срывался.
  const stickToBottomRef = useRef(true)
  const prevScrollHeightRef = useRef<number | null>(null)
  const initialScrolledRef = useRef(false)
  // Снимок «последний id на момент первой загрузки канала»: анимируем входом
  // только сообщения новее него (т.е. пришедшие в реальном времени), но не
  // начальную пачку и не подгрузку истории вверх. null до первой загрузки.
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
    // Запоминаем «момент переписки»: вернувшись в канал, откроемся тут же.
    if (stick) chatScrollMemory.delete(channelId)
    else chatScrollMemory.set(channelId, c.scrollTop)
  }

  // Контент дорастает уже после рендера (картинки, custom emoji, превью) —
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
      // Возврат в канал — продолжаем с запомненного места; иначе — в самый низ.
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
    // Своя отправка тянет вниз из любой позиции (как в Discord/Telegram) —
    // сообщение появляется у низа, оставаться наверху бессмысленно.
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
    // Сбрасываем снимок входа: у нового канала свой «нулевой» момент.
    sawInitialRef.current = false
    firstSeenMaxIdRef.current = null
  }, [channelId])

  // Фиксируем максимальный id после первой непустой загрузки канала — всё
  // новее этого считается «пришедшим вживую» и анимируется.
  useEffect(() => {
    if (!sawInitialRef.current && messages.length > 0) {
      sawInitialRef.current = true
      firstSeenMaxIdRef.current = messages[messages.length - 1]?.id ?? null
    }
  }, [messages])

  // Deep-link `#msg:<id>` (переход из Inbox/поиска/тостов). Если сообщения
  // ещё нет в DOM — идём назад по страницам истории, пока не найдём
  // (аудит M-6; потолок MAX_HASH_WALK_PAGES, чтобы чужой/удалённый id не
  // гонял пагинацию вечно). После успешного прыжка хеш стираем — иначе
  // каждое новое сообщение снова уносило бы скролл к цели.
  const hashWalkRef = useRef({ channelId: '', remaining: MAX_HASH_WALK_PAGES })
  useEffect(() => {
    function jumpToHashTarget(): boolean {
      const m = /^#msg:([0-9a-f-]+)$/i.exec(window.location.hash)
      if (!m) return false
      const el = document.querySelector(`[data-message-id="${m[1]}"]`)
      if (!el) return false
      el.scrollIntoView({ block: 'center', behavior: 'smooth' })
      setTimeout(() => {
        el.classList.add('kd-flash')
        el.addEventListener('animationend', () => el.classList.remove('kd-flash'), { once: true })
      }, 100)
      history.replaceState(null, '', window.location.pathname + window.location.search)
      return true
    }
    if (messages.length === 0) return undefined

    const tryJumpOrWalk = () => {
      if (!/^#msg:[0-9a-f-]+$/i.test(window.location.hash)) return
      if (jumpToHashTarget()) return
      // Цели нет в загруженных страницах — подгружаем историю назад.
      if (hashWalkRef.current.remaining <= 0) return
      hashWalkRef.current.remaining -= 1
      if (hasNextPage && !isFetchingNextPage) void fetchNextPage()
    }
    // Смена канала сбрасывает бюджет прохода: хеш мог остаться от прошлого.
    if (hashWalkRef.current.channelId !== channelId) {
      hashWalkRef.current = { channelId, remaining: MAX_HASH_WALK_PAGES }
    }

    tryJumpOrWalk()
    const handler = () => { tryJumpOrWalk() }
    window.addEventListener('hashchange', handler)
    return () => window.removeEventListener('hashchange', handler)
  }, [channelId, messages.length, hasNextPage, isFetchingNextPage, fetchNextPage])

  const firstUnreadIndex = useMemo(() => {
    if (!snapshotReadAt) return -1
    // Своя отправка «прочитывает» канал: как только в ленте (или в pending)
    // появилось наше сообщение новее снимка — маркер убираем, иначе он
    // оставался и подсвечивался при каждой следующей отправке.
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
        prev: IMessage | PendingMessage | null
        isPending: boolean
      }

  const rows: ItemRow[] = []
  // prevForMsg — только для day-разделителя; groupAnchor — «prev» для склейки.
  // Системные строки, day-разделитель и «непрочитанное» склейку разрывают:
  // иначе первое сообщение автора после его «присоединился к серверу»
  // рендерилось без аватара и имени (system-сообщение несёт тот же authorId).
  let prevForMsg: IMessage | PendingMessage | null = null
  let groupAnchor: IMessage | PendingMessage | null = null
  for (let i = 0; i < messages.length; i += 1) {
    const m = messages[i]!
    if (prevForMsg === null || !sameDay(prevForMsg.createdAt, m.createdAt)) {
      rows.push({ type: 'day', label: formatDay(m.createdAt) })
      groupAnchor = null
    }
    if (i === firstUnreadIndex) {
      rows.push({ type: 'unread' })
      groupAnchor = null
    }
    // Системное сообщение (вступление участника) — строка по центру, не «пузырь»
    // и не склеивается с соседями.
    if (m.system) {
      rows.push({ type: 'system', msg: m })
      prevForMsg = m
      groupAnchor = null
      continue
    }
    rows.push({ type: 'msg', msg: m, prev: groupAnchor, isPending: false })
    prevForMsg = m
    groupAnchor = m
  }
  for (let i = 0; i < pending.length; i += 1) {
    const p = pending[i]!
    if (landedNonces.has(p._nonce)) continue
    rows.push({ type: 'msg', msg: p, prev: groupAnchor, isPending: true })
    groupAnchor = p
  }

  // Фокус на composer того же экрана (он — сосед скролл-контейнера
  // внутри колонки чата; работает и в ChatScreen, и в ThreadPanel, и в DM).
  function focusComposer() {
    const ta = containerRef.current?.parentElement?.querySelector('textarea')
    ta?.focus()
  }

  const isEmpty = data !== undefined && rows.length === 0
  const channelName = channelMap.get(channelId)?.name
  const userName = currentUserId ? memberMap.get(currentUserId)?.displayName : undefined

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
      {isEmpty && (
        <GreetingBanner
          userName={userName}
          subtitle={
            channelName
              ? `в #${channelName} пока тихо · 0 сообщений · стань первым`
              : 'здесь пока тихо · 0 сообщений · стань первым'
          }
          cta={{ label: 'написать ⏵', onClick: focusComposer }}
        />
      )}
      {rows.map((row, idx) => {
        if (row.type === 'day') return <DayDivider key={`day-${idx}`} label={row.label} />
        if (row.type === 'unread') return <UnreadDivider key={`unread-${idx}`} />
        if (row.type === 'system') {
          return (
            <SystemLine
              key={row.msg.id}
              message={row.msg}
              name={memberMap.get(row.msg.authorId)?.displayName ?? 'кто-то'}
            />
          )
        }
        const m = row.msg
        const key = row.isPending ? (m as PendingMessage)._nonce : m.id
        // Вход анимируем только у чужих сообщений новее снимка: свои отправки
        // должны ощущаться мгновенными (без «доезжания» оптимистичной строки).
        const enter = !row.isPending
          && firstSeenMaxIdRef.current !== null
          && m.id > firstSeenMaxIdRef.current
          && m.authorId !== currentUserId
        return (
          <Message
            key={key}
            message={m}
            prev={row.prev}
            member={memberMap.get(m.authorId)}
            isOwn={m.authorId === currentUserId}
            currentUserId={currentUserId}
            pendingStatus={row.isPending ? (m as PendingMessage)._pending : undefined}
            memberMap={memberMap}
            channelMap={channelMap}
            emojiMap={emojiMap}
            roles={roles}
            enter={enter}
            threadsAllowed={threadsAllowed}
            canPin={canPin}
            nsfw={nsfw}
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
