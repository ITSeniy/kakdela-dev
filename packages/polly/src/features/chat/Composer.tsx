import React, { type ClipboardEvent, type DragEvent, type KeyboardEvent, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'

import type { Attachment, ClipEmbed, CustomEmoji, GifEmbed, MemberPublic, Message, Role, StickerRef } from '@kakdela/ginzu/api-types'

import { Avatar } from '../../components/Avatar.js'
import { Icon } from '../../components/Icon.js'
import { useIsMobile } from '../../app/useIsMobile.js'
import { wsClient } from '../../lib/ws.js'
import { useAuthStore } from '../auth/store.js'
import { useChatPrefs } from '../settings/chatPrefs.js'
import { getKlipyConfig } from '../klipy/api.js'
import { useAllServerStickers } from '../stickers/api.js'
import {
  MAX_ATTACHMENT_SIZE,
  UploadError,
  FILE_PICKER_ACCEPT,
  FILE_PICKER_TYPES,
  isSupportedType,
  uploadAttachment,
  type FilePickerCategory,
} from '../files/upload.js'
import { type DeviceMediaItem, readMediaAsFile } from '../../lib/host/media.js'
import { AttachSheet } from './AttachSheet.js'
import { Attachments, type PendingAttachment } from './Attachments.js'
import { CreateEventModal } from './CreateEventModal.js'
import { CreatePollModal } from './CreatePollModal.js'
import { VideoNoteOverlay } from './VideoNoteRecorder.js'
import { VoiceRecorderBar } from './VoiceRecorder.js'
import { useNoteRecorder } from './useNoteRecorder.js'

const LazyMediaPicker = React.lazy(() => import('../media/MediaPicker.js'))

const MAX_ATTACHMENTS = 10

// Кнопки всплывашки форматирования (Discord-style). wrap — маркеры по краям
// выделения, block — префикс каждой выделенной строки.
const FORMAT_ACTIONS: Array<
  | { id: string; label: React.ReactNode; title: string; kind: 'wrap'; marker: string }
  | { id: string; label: React.ReactNode; title: string; kind: 'block'; prefix: string }
> = [
  { id: 'bold',    label: <b>B</b>,            title: 'жирный · **',        kind: 'wrap', marker: '**' },
  { id: 'italic',  label: <i>I</i>,            title: 'курсив · _',         kind: 'wrap', marker: '_' },
  { id: 'under',   label: <u>U</u>,            title: 'подчёркнутый · __',  kind: 'wrap', marker: '__' },
  { id: 'strike',  label: <s>S</s>,            title: 'зачёркнутый · ~~',   kind: 'wrap', marker: '~~' },
  { id: 'quote',   label: <span>“</span>,      title: 'цитата · >',         kind: 'block', prefix: '> ' },
  { id: 'code',    label: <span>&lt;&gt;</span>, title: 'код · `',          kind: 'wrap', marker: '`' },
  { id: 'spoiler', label: <span>◉</span>,      title: 'спойлер · ||',       kind: 'wrap', marker: '||' },
]

interface ComposerProps {
  channelName: string
  customEmoji?: ReadonlyArray<CustomEmoji>
  /** Роли сервера для автокомплита `@роль` (нет в DM). */
  roles?: ReadonlyArray<Role>
  replyTo: Message | null
  replyAuthor: string | undefined
  /** id канала — для индикатора «кто печатает» и отправки typing-событий. */
  channelId?: string
  /** Участники — для автокомплита @упоминаний и имён печатающих. */
  memberMap?: ReadonlyMap<string, MemberPublic>
  /** Показывать ли @everyone / @here в автокомплите (серверные каналы). */
  allowBroadcast?: boolean
  onCancelReply: () => void
  onSend: (content: string, attachments: Attachment[], gif?: GifEmbed, sticker?: StickerRef, clip?: ClipEmbed) => void
}

const TYPING_THROTTLE_MS = 3_000
const TYPING_TTL_MS = 8_000

/** «Аня печатает…» вместо подсказки про shift+⏎, пока кто-то печатает. */
function TypingLine({ channelId, memberMap, mobile }: {
  channelId: string
  memberMap?: ReadonlyMap<string, MemberPublic>
  /** На мобиле в простое не показываем десктопную подсказку про shift+⏎. */
  mobile?: boolean
}) {
  const meId = useAuthStore((s) => s.user?.id)
  const showTyping = useChatPrefs((s) => s.showTyping)
  const sendKey = useChatPrefs((s) => s.sendKey)
  const [typers, setTypers] = useState<Map<string, number>>(new Map())

  useEffect(() => {
    setTypers(new Map())
    const unsub = wsClient.on((event) => {
      // Пришло сообщение — автор больше не «печатает». Убираем его сразу, не
      // дожидаясь TTL (раньше индикатор висел все 8 секунд после отправки).
      if (event.t === 'msg.new' && event.channelId === channelId) {
        setTypers((m) => {
          if (!m.has(event.message.authorId)) return m
          const next = new Map(m)
          next.delete(event.message.authorId)
          return next
        })
        return
      }
      if (event.t !== 'typing' || event.channelId !== channelId) return
      if (event.userId === meId) return
      setTypers((m) => {
        const next = new Map(m)
        next.set(event.userId, Date.now() + TYPING_TTL_MS)
        return next
      })
    })
    const prune = setInterval(() => {
      setTypers((m) => {
        const now = Date.now()
        let changed = false
        const next = new Map(m)
        for (const [id, exp] of next) {
          if (exp <= now) { next.delete(id); changed = true }
        }
        return changed ? next : m
      })
    }, 1000)
    return () => { unsub(); clearInterval(prune) }
  }, [channelId, meId])

  const hint = sendKey === 'ctrl-enter' ? 'ctrl+⏎ — отправить' : 'shift+⏎ — новая строка'
  const names = showTyping
    ? [...typers.keys()].map((id) => memberMap?.get(id)?.displayName ?? 'кто-то')
    : []
  if (names.length === 0) return mobile ? null : <span>{hint}</span>
  const label = names.length === 1
    ? `${names[0]} печатает`
    : names.length === 2
      ? `${names[0]} и ${names[1]} печатают`
      : 'несколько человек печатают'
  return <span className="text-kd-accent font-semibold animate-pulse">{label}…</span>
}

interface MentionOption {
  key: string
  label: string
  /** Что вставить в текст (без завершающего пробела). */
  insert: string
  sub?: string
  avatarUrl?: string | null
  broadcast?: boolean
  /** Опция-роль — рисуем цветную точку вместо аватара. */
  role?: boolean
  roleColor?: string | null
}

/** Токен для текста: предпочитаем username (`@ник`) — он уникален и без
    пробелов; fallback — первое слово displayName (его extractor тоже матчит). */
function mentionToken(m: MemberPublic): string {
  if (m.username) return '@' + m.username
  return '@' + (m.displayName.split(/\s+/)[0] ?? m.displayName)
}

function makeLocalId(): string {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36)
}

export function Composer({
  channelName, customEmoji, roles, replyTo, replyAuthor,
  channelId, memberMap, allowBroadcast,
  onCancelReply, onSend,
}: ComposerProps) {
  const [text, setText] = useState('')
  const [attachments, setAttachments] = useState<PendingAttachment[]>([])
  // localId вложений, помеченных спойлером (блюр до клика у получателя).
  const [spoilered, setSpoilered] = useState<Set<string>>(() => new Set())
  const [isDragOver, setIsDragOver] = useState(false)
  const [warning, setWarning] = useState<string | null>(null)
  // Единый пикер медиа (эмодзи · gif · стикеры · клипы). mediaTab — с какой
  // вкладки открыть (мобильный «+» может сразу вести на gif/стикеры).
  const [mediaOpen, setMediaOpen] = useState(false)
  const [mediaTab, setMediaTab] = useState<'emoji' | 'gifs' | 'stickers' | 'clips'>('emoji')
  const [pollOpen, setPollOpen] = useState(false)
  const [eventOpen, setEventOpen] = useState(false)
  // Мобильный bottom-sheet вложений: «+» на мобиле открывает его, а не пикер.
  const [attachOpen, setAttachOpen] = useState(false)
  // Всплывашка форматирования — пока в textarea есть выделение.
  const [hasSelection, setHasSelection] = useState(false)
  // @упоминание под курсором: позиция '@' и набранный кусок имени.
  const [mention, setMention] = useState<{ start: number; query: string } | null>(null)
  const [mentionIdx, setMentionIdx] = useState(0)
  const meId = useAuthStore((s) => s.user?.id)
  const isMobile = useIsMobile()
  const sendKey = useChatPrefs((s) => s.sendKey)
  const sendTyping = useChatPrefs((s) => s.sendTyping)
  const lastTypingSentRef = useRef(0)

  const taRef = useRef<HTMLTextAreaElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)

  // «Ответить» из ленты — сразу фокус в поле ввода: ответ почти всегда
  // печатают немедленно, лишний клик по композеру раздражал.
  useEffect(() => {
    if (replyTo) taRef.current?.focus()
  }, [replyTo?.id])

  const mediaContainerRef = useRef<HTMLDivElement>(null)
  const dragCounter = useRef(0)

  // Возможности Klipy (есть ли ключ, какие типы доступны). Спрашиваем раз.
  const { data: klipy } = useQuery({
    queryKey: ['klipy-config'],
    queryFn: getKlipyConfig,
    staleTime: Infinity,
  })
  const klipyConfig = klipy ?? { enabled: false, gifs: false, stickers: false, clips: false, memes: false }
  // Кастомные стикеры сервера (для секции «Сервер» на вкладке стикеров).
  const { stickers: serverStickers } = useAllServerStickers()

  function sendGif(gif: GifEmbed) {
    // Discord-style: гифка уходит сразу отдельным сообщением структурным
    // embed'ом (рендерится как <video>/<img>, кликабельна в лайтбокс). Текст
    // композера не трогаем.
    onSend('', [], gif)
    setMediaOpen(false)
  }

  function sendSticker(sticker: StickerRef) {
    // Стикер уходит отдельным сообщением (снимок StickerRef). Текст не трогаем.
    onSend('', [], undefined, sticker)
    setMediaOpen(false)
  }

  function sendClip(clip: ClipEmbed) {
    // Клип (видео со звуком) уходит отдельным сообщением. Текст не трогаем.
    onSend('', [], undefined, undefined, clip)
    setMediaOpen(false)
  }

  function openMedia(tab: 'emoji' | 'gifs' | 'stickers' | 'clips') {
    setMediaTab(tab)
    setMediaOpen(true)
  }
  const attachmentsRef = useRef<PendingAttachment[]>([])
  attachmentsRef.current = attachments

  useEffect(() => {
    if (!mediaOpen) return
    function handleMouseDown(e: MouseEvent) {
      if (mediaContainerRef.current && !mediaContainerRef.current.contains(e.target as Node)) {
        setMediaOpen(false)
      }
    }
    document.addEventListener('mousedown', handleMouseDown)
    return () => document.removeEventListener('mousedown', handleMouseDown)
  }, [mediaOpen])

  // Вставляем emoji-токен на позицию курсора (или в конец, если фокус
  // потерян). Native unicode emoji приходят как `😀`, custom — как `:name:`.
  function insertEmoji(token: string) {
    const ta = taRef.current
    if (!ta) {
      setText((prev) => prev + token)
      return
    }
    const start = ta.selectionStart ?? text.length
    const end = ta.selectionEnd ?? start
    const next = text.slice(0, start) + token + text.slice(end)
    setText(next)
    // Возвращаем фокус и курсор сразу после вставки.
    requestAnimationFrame(() => {
      ta.focus()
      const caret = start + token.length
      ta.setSelectionRange(caret, caret)
    })
  }

  useEffect(() => {
    const el = taRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = Math.min(el.scrollHeight, 200) + 'px'
  }, [text])

  function syncSelection() {
    const ta = taRef.current
    if (!ta) return
    setHasSelection(ta.selectionStart !== ta.selectionEnd)
  }

  /** Ищем `@кусок` непосредственно перед кареткой. */
  function syncMention(nextText: string, caret: number) {
    if (!memberMap) return
    const before = nextText.slice(0, caret)
    const m = /(^|[\s(])@([\p{L}\p{N}_-]*)$/u.exec(before)
    if (m) {
      const query = m[2] ?? ''
      setMention({ start: caret - query.length - 1, query })
      setMentionIdx(0)
    } else {
      setMention(null)
    }
  }

  const mentionOptions = useMemo<MentionOption[]>(() => {
    if (!mention || !memberMap) return []
    const q = mention.query.toLowerCase()
    const list: MentionOption[] = []
    if (allowBroadcast) {
      if ('everyone'.startsWith(q)) {
        list.push({ key: 'everyone', label: '@everyone', insert: '@everyone', sub: 'уведомить всех', broadcast: true })
      }
      if ('here'.startsWith(q)) {
        list.push({ key: 'here', label: '@here', insert: '@here', sub: 'уведомить тех, кто в сети', broadcast: true })
      }
    }
    for (const m of memberMap.values()) {
      if (m.id === meId) continue
      const byName = m.displayName.toLowerCase().includes(q)
      const byNick = m.username ? m.username.toLowerCase().includes(q) : false
      if (q && !byName && !byNick) continue
      list.push({
        key: m.id,
        label: m.displayName,
        insert: mentionToken(m),
        ...(m.username ? { sub: '@' + m.username } : {}),
        avatarUrl: m.avatarUrl,
      })
      if (list.length >= 8) break
    }
    // Роли: упоминаемые — всем; неупоминаемые — только при праве на @everyone.
    for (const r of roles ?? []) {
      if (list.length >= 8) break
      if (!r.mentionable && !allowBroadcast) continue
      if (q && !r.name.toLowerCase().includes(q)) continue
      list.push({ key: `role:${r.id}`, label: r.name, insert: '@' + r.name, sub: 'роль', role: true, roleColor: r.color })
    }
    return list.slice(0, 8)
  }, [mention, memberMap, allowBroadcast, meId, roles])

  function pickMention(opt: MentionOption) {
    if (!mention) return
    const ta = taRef.current
    const end = mention.start + 1 + mention.query.length
    const next = text.slice(0, mention.start) + opt.insert + ' ' + text.slice(end)
    setText(next)
    setMention(null)
    const caret = mention.start + opt.insert.length + 1
    requestAnimationFrame(() => {
      ta?.focus()
      ta?.setSelectionRange(caret, caret)
    })
  }

  function handleTextChange(e: React.ChangeEvent<HTMLTextAreaElement>) {
    const next = e.target.value
    setText(next)
    syncMention(next, e.target.selectionStart ?? next.length)
    // Сигнал «печатаю» — не чаще раза в TYPING_THROTTLE_MS; можно выключить
    // в настройках приватности (тогда свой статус печати не отправляем).
    if (sendTyping && channelId && next.trim()) {
      const now = Date.now()
      if (now - lastTypingSentRef.current > TYPING_THROTTLE_MS) {
        lastTypingSentRef.current = now
        wsClient.send({ t: 'typing', channelId })
      }
    }
  }

  /** Обернуть выделение маркерами; повторное применение снимает их. */
  function applyWrap(marker: string) {
    const ta = taRef.current
    if (!ta) return
    const start = ta.selectionStart
    const end = ta.selectionEnd
    if (start === end) return
    const selected = text.slice(start, end)
    const before = text.slice(0, start)
    const after = text.slice(end)

    const alreadyWrapped =
      before.endsWith(marker) && after.startsWith(marker)
    let next: string
    let selStart: number
    let selEnd: number
    if (alreadyWrapped) {
      next = before.slice(0, -marker.length) + selected + after.slice(marker.length)
      selStart = start - marker.length
      selEnd = end - marker.length
    } else if (selected.startsWith(marker) && selected.endsWith(marker) && selected.length >= marker.length * 2) {
      const inner = selected.slice(marker.length, -marker.length)
      next = before + inner + after
      selStart = start
      selEnd = start + inner.length
    } else {
      next = before + marker + selected + marker + after
      selStart = start + marker.length
      selEnd = end + marker.length
    }
    setText(next)
    requestAnimationFrame(() => {
      ta.focus()
      ta.setSelectionRange(selStart, selEnd)
    })
  }

  /** Префикс каждой выделенной строки (цитата). */
  function applyBlock(prefix: string) {
    const ta = taRef.current
    if (!ta) return
    const start = ta.selectionStart
    const end = ta.selectionEnd
    if (start === end) return
    // Расширяем до границ строк, чтобы префикс встал в начале каждой.
    const lineStart = text.lastIndexOf('\n', start - 1) + 1
    const lineEndRaw = text.indexOf('\n', end)
    const lineEnd = lineEndRaw === -1 ? text.length : lineEndRaw
    const block = text.slice(lineStart, lineEnd)
    const lines = block.split('\n')
    const allPrefixed = lines.every((l) => l.startsWith(prefix))
    const nextBlock = lines
      .map((l) => (allPrefixed ? l.slice(prefix.length) : prefix + l))
      .join('\n')
    const next = text.slice(0, lineStart) + nextBlock + text.slice(lineEnd)
    setText(next)
    requestAnimationFrame(() => {
      ta.focus()
      ta.setSelectionRange(lineStart, lineStart + nextBlock.length)
    })
  }

  useEffect(() => {
    if (!warning) return
    const t = window.setTimeout(() => setWarning(null), 4000)
    return () => window.clearTimeout(t)
  }, [warning])

  function updateAttachment(localId: string, next: PendingAttachment) {
    setAttachments((arr) => arr.map((a) => (a.localId === localId ? next : a)))
  }

  const startUpload = useCallback((file: File) => {
    const localId = makeLocalId()
    const abort = new AbortController()
    const initial: PendingAttachment = { localId, file, status: 'uploading', pct: 0, abort }
    setAttachments((arr) => [...arr, initial])

    void (async () => {
      try {
        const attachment = await uploadAttachment(file, {
          signal: abort.signal,
          onProgress: (pct) => {
            const current = attachmentsRef.current.find((a) => a.localId === localId)
            if (current && current.status === 'uploading') {
              updateAttachment(localId, { ...current, pct })
            }
          },
        })
        const current = attachmentsRef.current.find((a) => a.localId === localId)
        if (!current) return // removed mid-flight
        updateAttachment(localId, { localId, file, status: 'ready', attachment })
      } catch (err) {
        if (err instanceof UploadError && err.code === 'aborted') return
        const message = err instanceof UploadError ? err.message : (err as Error).message || 'upload failed'
        const current = attachmentsRef.current.find((a) => a.localId === localId)
        if (!current) return
        updateAttachment(localId, { localId, file, status: 'error', message })
      }
    })()
  }, [])

  const addFiles = useCallback((files: File[]) => {
    const slotsAvailable = MAX_ATTACHMENTS - attachmentsRef.current.length
    if (slotsAvailable <= 0) {
      setWarning(`можно прикрепить не больше ${MAX_ATTACHMENTS} файлов`)
      return
    }
    let skipped = 0
    let added = 0
    for (const file of files) {
      if (added >= slotsAvailable) {
        skipped += 1
        continue
      }
      if (file.size > MAX_ATTACHMENT_SIZE) {
        setWarning(`«${file.name}» больше 25 МБ — не загружаем`)
        continue
      }
      if (!isSupportedType(file.type)) {
        setWarning(`«${file.name}» — неподдерживаемый формат`)
        continue
      }
      startUpload(file)
      added += 1
    }
    if (skipped > 0) {
      setWarning(`можно прикрепить не больше ${MAX_ATTACHMENTS} файлов, пропущено ${skipped}`)
    }
  }, [startUpload])

  function removeAttachment(localId: string) {
    const item = attachmentsRef.current.find((a) => a.localId === localId)
    if (item && item.status === 'uploading') item.abort.abort()
    setAttachments((arr) => arr.filter((a) => a.localId !== localId))
    setSpoilered((prev) => {
      if (!prev.has(localId)) return prev
      const next = new Set(prev)
      next.delete(localId)
      return next
    })
  }

  async function pickFiles() {
    // showOpenFilePicker (Chromium, есть и в WebView2) умеет именованные
    // категории в выпадашке фильтров — `<input accept>` даёт лишь один
    // смешанный фильтр. API вне lib.dom — типизируем структурно.
    const picker = (window as Window & {
      showOpenFilePicker?: (opts: {
        multiple?: boolean
        excludeAcceptAllOption?: boolean
        types?: FilePickerCategory[]
      }) => Promise<Array<{ getFile(): Promise<File> }>>
    }).showOpenFilePicker
    if (picker) {
      try {
        const handles = await picker({
          multiple: true,
          excludeAcceptAllOption: false,
          types: FILE_PICKER_TYPES,
        })
        const files = await Promise.all(handles.map((h) => h.getFile()))
        if (files.length > 0) addFiles(files)
        return
      } catch (err) {
        // Отмена пользователем — тишина; всё прочее — fallback на input.
        if (err instanceof DOMException && err.name === 'AbortError') return
        console.warn('[composer] showOpenFilePicker failed, using input', err)
      }
    }
    fileInputRef.current?.click()
  }

  function handleFileInput(e: React.ChangeEvent<HTMLInputElement>) {
    const files = e.target.files
    if (files && files.length > 0) addFiles(Array.from(files))
    e.target.value = ''
  }

  /** Выбор из галереи устройства (AttachSheet). Чтение файла — синхронный
      вызов JS-моста, поэтому между файлами уступаем кадр. */
  async function attachDeviceMedia(items: DeviceMediaItem[]) {
    setAttachOpen(false)
    const files: File[] = []
    for (const item of items) {
      try {
        files.push(readMediaAsFile(item))
      } catch (err) {
        setWarning(`«${item.name}»: ${(err as Error).message}`)
      }
      await new Promise((r) => setTimeout(r, 0))
    }
    if (files.length > 0) addFiles(files)
  }

  function handleDragEnter(e: DragEvent) {
    if (!e.dataTransfer.types.includes('Files')) return
    e.preventDefault()
    dragCounter.current += 1
    setIsDragOver(true)
  }
  function handleDragOver(e: DragEvent) {
    if (!e.dataTransfer.types.includes('Files')) return
    e.preventDefault()
    e.dataTransfer.dropEffect = 'copy'
  }
  function handleDragLeave() {
    dragCounter.current = Math.max(0, dragCounter.current - 1)
    if (dragCounter.current === 0) setIsDragOver(false)
  }
  function handleDrop(e: DragEvent) {
    e.preventDefault()
    dragCounter.current = 0
    setIsDragOver(false)
    const files = Array.from(e.dataTransfer.files ?? [])
    if (files.length > 0) addFiles(files)
  }

  function handlePaste(e: ClipboardEvent<HTMLTextAreaElement>) {
    const items = e.clipboardData.items
    const files: File[] = []
    for (let i = 0; i < items.length; i += 1) {
      const item = items[i]
      if (!item) continue
      if (item.kind === 'file') {
        const f = item.getAsFile()
        if (f) files.push(f)
      }
    }
    if (files.length > 0) {
      e.preventDefault()
      addFiles(files)
    }
  }

  function send() {
    const trimmed = text.trim()
    // Спойлер-флаг проставляем прямо на Attachment — он уезжает и в оптимистичный
    // рендер, и в запрос (ChatScreen достанет spoilerAttachments из этого поля).
    const ready: Attachment[] = attachments.flatMap((a) =>
      a.status === 'ready' ? [{ ...a.attachment, spoiler: spoilered.has(a.localId) }] : [],
    )
    const stillUploading = attachments.some((a) => a.status === 'uploading')
    if (stillUploading) return
    if (!trimmed && ready.length === 0) return
    onSend(trimmed, ready)
    setText('')
    setAttachments([])
    setSpoilered(new Set())
    setMention(null)
  }

  function toggleSpoiler(localId: string) {
    setSpoilered((prev) => {
      const next = new Set(prev)
      if (next.has(localId)) next.delete(localId)
      else next.add(localId)
      return next
    })
  }

  function handleKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    // Автокомплит упоминаний перехватывает навигацию, пока открыт.
    if (mention && mentionOptions.length > 0) {
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setMentionIdx((i) => (i + 1) % mentionOptions.length)
        return
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault()
        setMentionIdx((i) => (i - 1 + mentionOptions.length) % mentionOptions.length)
        return
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault()
        const opt = mentionOptions[mentionIdx] ?? mentionOptions[0]
        if (opt) pickMention(opt)
        return
      }
      if (e.key === 'Escape') {
        setMention(null)
        return
      }
    }
    if (e.key === 'Enter') {
      // ctrl-enter: отправка по Ctrl/Cmd+Enter, голый Enter — перенос строки.
      // enter (дефолт): Enter отправляет, Shift+Enter — перенос.
      if (sendKey === 'ctrl-enter') {
        if (e.ctrlKey || e.metaKey) { e.preventDefault(); send() }
      } else if (!e.shiftKey) {
        e.preventDefault()
        send()
      }
    }
    if (e.key === 'Escape' && replyTo) onCancelReply()
  }

  const placeholder = channelName ? `сообщение в #${channelName}…` : 'сообщение…'

  const hasUploading = attachments.some((a) => a.status === 'uploading')
  const hasReady = attachments.some((a) => a.status === 'ready')
  const sendDisabled = hasUploading || (!text.trim() && !hasReady)

  // Записи с устройства: на мобиле пустой композер показывает кружок+микрофон
  // вместо send. Готовая запись сразу загружается и уходит отдельным сообщением.
  const voice = useNoteRecorder({
    video: false,
    onFinish: async ({ file, durationSec }) => {
      const attachment = await uploadAttachment(file, { voice: true, durationSec })
      onSend('', [attachment])
    },
    onError: setWarning,
  })
  const circle = useNoteRecorder({
    video: true,
    onFinish: async ({ file, durationSec }) => {
      const attachment = await uploadAttachment(file, { circle: true, durationSec })
      onSend('', [attachment])
    },
    onError: setWarning,
  })
  const showMic = isMobile && !text.trim() && attachments.length === 0

  return (
    <div
      className="px-4 pb-3.5 pt-2 shrink-0 relative"
      onDragEnter={handleDragEnter}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {isDragOver && (
        <div className="absolute inset-2 z-20 pointer-events-none rounded-kd border-2 border-dashed border-kd-accent bg-kd-accent-soft/60 flex items-center justify-center">
          <span className="text-[12px] font-bold text-kd-accent-deep font-mono">
            отпустите файл здесь
          </span>
        </div>
      )}
      <input
        ref={fileInputRef}
        type="file"
        multiple
        accept={FILE_PICKER_ACCEPT}
        className="hidden"
        onChange={handleFileInput}
      />
      {replyTo && (
        <div className="flex items-center gap-2 px-3 py-2 mb-2 bg-kd-panel rounded-kd border border-kd-border text-[11px]">
          <span className="text-kd-text-mute">↳ отвечаете на</span>
          <b className="text-kd-text font-mono">{replyAuthor ?? '???'}</b>
          <span className="text-kd-text-soft truncate flex-1">{replyTo.content}</span>
          <button
            type="button"
            onClick={onCancelReply}
            className="text-kd-text-mute hover:text-kd-danger px-1"
            title="отменить ответ (esc)"
          >
            <Icon.X size={12} />
          </button>
        </div>
      )}
      <Attachments items={attachments} spoilered={spoilered} onRemove={removeAttachment} onToggleSpoiler={toggleSpoiler} />
      {warning && (
        <div className="mb-1.5 text-[10px] text-kd-danger font-mono">{warning}</div>
      )}
      {circle.status !== 'idle' && <VideoNoteOverlay recorder={circle} />}
      {voice.status !== 'idle' ? <VoiceRecorderBar recorder={voice} /> : (
      <div className="bg-kd-panel rounded-kd border border-kd-border flex items-center gap-2.5 px-3 py-2 relative">
        {/* Всплывашка форматирования над полем — пока есть выделение.
            onMouseDown+preventDefault: клик не должен снимать выделение. */}
        {hasSelection && (
          <div
            className="absolute bottom-full left-2 mb-1.5 z-40 flex items-center gap-px bg-kd-panel border border-kd-border rounded-kd shadow-kd-modal px-1 py-0.5 select-none"
            onMouseDown={(e) => e.preventDefault()}
          >
            {FORMAT_ACTIONS.map((a) => (
              <button
                key={a.id}
                type="button"
                title={a.title}
                onClick={() => (a.kind === 'wrap' ? applyWrap(a.marker) : applyBlock(a.prefix))}
                className="w-7 h-7 rounded flex items-center justify-center text-[13px] text-kd-text-soft hover:text-kd-text hover:bg-kd-panel-hi transition-colors"
              >
                {a.label}
              </button>
            ))}
          </div>
        )}
        <button
          type="button"
          onClick={() => (isMobile ? setAttachOpen(true) : void pickFiles())}
          title="прикрепить"
          className="text-kd-text-mute hover:text-kd-text-soft transition-colors shrink-0"
        >
          <Icon.Plus size={isMobile ? 20 : 15} />
        </button>
        {/* Автокомплит @упоминаний — над полем, выше панели форматирования. */}
        {mention && mentionOptions.length > 0 && (
          <div
            className="absolute bottom-full left-2 right-2 mb-1.5 z-50 bg-kd-panel border border-kd-border rounded-kd shadow-kd-modal py-1 select-none max-h-[260px] overflow-y-auto"
            onMouseDown={(e) => e.preventDefault()}
          >
            {mentionOptions.map((opt, i) => (
              <button
                key={opt.key}
                type="button"
                onClick={() => pickMention(opt)}
                onMouseEnter={() => setMentionIdx(i)}
                className={[
                  'w-full text-left px-3 py-1.5 flex items-center gap-2 transition-colors',
                  i === mentionIdx ? 'bg-kd-panel-hi' : '',
                ].join(' ')}
              >
                {opt.broadcast ? (
                  <span className="w-5 h-5 rounded-full bg-kd-warm-bg text-kd-warm flex items-center justify-center text-[11px] font-bold shrink-0">@</span>
                ) : opt.role ? (
                  <span className="w-5 h-5 rounded-full bg-kd-accent-bg flex items-center justify-center shrink-0">
                    <span className="w-2 h-2 rounded-full" style={{ background: opt.roleColor ?? 'var(--kd-accent)' }} />
                  </span>
                ) : (
                  <Avatar name={opt.label} avatarUrl={opt.avatarUrl ?? null} size={20} />
                )}
                <span className="text-[12px] font-semibold text-kd-text truncate">{opt.label}</span>
                {opt.sub && (
                  <span className="ml-auto text-[10px] font-mono text-kd-text-mute shrink-0">{opt.sub}</span>
                )}
              </button>
            ))}
          </div>
        )}
        <textarea
          ref={taRef}
          value={text}
          onChange={handleTextChange}
          onKeyDown={handleKeyDown}
          onKeyUp={syncSelection}
          onPaste={handlePaste}
          onSelect={syncSelection}
          onMouseUp={syncSelection}
          onBlur={() => {
            // Микро-задержка: клик по кнопке всплывашки не должен убить её
            // раньше, чем сработает onClick (mousedown уже preventDefault'ится,
            // но blur по другим причинам — гасим выделение).
            setTimeout(syncSelection, 0)
          }}
          placeholder={placeholder}
          rows={1}
          className={`flex-1 bg-transparent resize-none ${isMobile ? 'text-[14px]' : 'text-[12px]'} text-kd-text outline-none placeholder:text-kd-text-mute leading-relaxed font-sans`}
          style={{ maxHeight: 200 }}
        />
        <div className="flex items-center gap-2 text-kd-text-mute shrink-0">
          {!isMobile && <span className="flex items-center h-5 text-[10px] font-mono opacity-70 select-none">md</span>}
          {channelId && !isMobile && (
            <>
              <button
                type="button"
                title="создать опрос"
                onClick={() => { setPollOpen(true); setMediaOpen(false) }}
                className={`inline-flex items-center justify-center h-5 w-5 transition-colors ${pollOpen ? 'text-kd-accent' : 'hover:text-kd-text-soft'}`}
              >
                <Icon.BarChart size={15} />
              </button>
              <button
                type="button"
                title="назначить встречу"
                onClick={() => { setEventOpen(true); setMediaOpen(false) }}
                className={`inline-flex items-center justify-center h-5 w-5 transition-colors ${eventOpen ? 'text-kd-accent' : 'hover:text-kd-text-soft'}`}
              >
                <Icon.Calendar size={15} />
              </button>
            </>
          )}
          {/* Единый пикер: эмодзи · гифки · стикеры · клипы (Klipy). Раньше это
              были три отдельные кнопки/поповера — теперь одно окно с вкладками. */}
          <div className="relative" ref={mediaContainerRef}>
            <button
              type="button"
              title="эмодзи · гифки · стикеры · клипы"
              onClick={() => setMediaOpen((o) => !o)}
              className={`inline-flex items-center justify-center transition-colors ${isMobile ? '' : 'h-5 w-5'} ${mediaOpen ? 'text-kd-accent' : 'hover:text-kd-text-soft'}`}
            >
              <Icon.Smile size={isMobile ? 20 : 15} />
            </button>
            {mediaOpen && (
              <div className={isMobile ? 'absolute bottom-full right-0 mb-2 z-50 shadow-lg' : 'absolute bottom-8 right-0 z-50 shadow-lg'}>
                <Suspense fallback={<div className="p-3 text-[11px] text-kd-text-mute bg-kd-panel rounded-kd border border-kd-border">…</div>}>
                  <LazyMediaPicker
                    customEmoji={customEmoji}
                    serverStickers={serverStickers}
                    klipy={klipyConfig}
                    initialTab={mediaTab}
                    onEmoji={insertEmoji}
                    onGif={sendGif}
                    onSticker={sendSticker}
                    onClip={sendClip}
                  />
                </Suspense>
              </div>
            )}
          </div>
        </div>
        {showMic ? (
          <>
            <button
              type="button"
              onClick={() => void circle.start()}
              title="записать кружок"
              className="w-9 h-9 rounded-full border border-kd-border text-kd-text-soft hover:text-kd-text flex items-center justify-center transition-colors shrink-0"
            >
              <Icon.Video size={17} />
            </button>
            <button
              type="button"
              onClick={() => void voice.start()}
              title="записать голосовое"
              className="w-9 h-9 rounded-full bg-kd-accent text-white flex items-center justify-center hover:bg-kd-accent-deep transition-colors shrink-0"
            >
              <Icon.Mic size={17} />
            </button>
          </>
        ) : (
          <button
            type="button"
            onClick={send}
            disabled={sendDisabled}
            title={hasUploading ? 'ждём загрузку…' : undefined}
            className={isMobile
              ? 'w-9 h-9 rounded-full bg-kd-accent text-white flex items-center justify-center hover:bg-kd-accent-deep transition-colors disabled:opacity-50 disabled:cursor-not-allowed shrink-0'
              : 'inline-flex items-center justify-center gap-1 h-6 px-2.5 bg-kd-accent text-white text-[11px] font-semibold font-mono leading-none rounded hover:bg-kd-accent-deep transition-colors disabled:opacity-50 disabled:cursor-not-allowed shrink-0'}
          >
            {isMobile ? <Icon.Send size={17} /> : 'send ⏎'}
          </button>
        )}
      </div>
      )}
      <div className="mt-1.5 px-1 text-[10px] text-kd-text-mute flex items-center gap-2.5 empty:hidden">
        {channelId
          ? <TypingLine channelId={channelId} memberMap={memberMap} mobile={isMobile} />
          : (!isMobile && <span>shift+⏎ — новая строка</span>)}
        {!isMobile && (
          <>
            <div className="flex-1" />
            <span className="font-mono">**жирный** _курсив_ ~~зачёркнутый~~ `код` ||спойлер||</span>
          </>
        )}
      </div>
      {attachOpen && (
        <AttachSheet
          gifEnabled={klipyConfig.gifs}
          showPollEvent={Boolean(channelId)}
          maxSelect={Math.max(0, MAX_ATTACHMENTS - attachments.length)}
          onClose={() => setAttachOpen(false)}
          onPickMedia={(items) => void attachDeviceMedia(items)}
          onPickFile={() => { setAttachOpen(false); void pickFiles() }}
          onGif={() => { setAttachOpen(false); openMedia('gifs') }}
          onSticker={() => { setAttachOpen(false); openMedia('stickers') }}
          onPoll={() => { setAttachOpen(false); setPollOpen(true) }}
          onEvent={() => { setAttachOpen(false); setEventOpen(true) }}
        />
      )}
      {pollOpen && channelId && (
        <CreatePollModal channelId={channelId} onClose={() => setPollOpen(false)} />
      )}
      {eventOpen && channelId && (
        <CreateEventModal channelId={channelId} onClose={() => setEventOpen(false)} />
      )}
    </div>
  )
}
