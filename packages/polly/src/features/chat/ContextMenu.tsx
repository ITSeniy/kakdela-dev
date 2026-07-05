import { useEffect, useLayoutEffect, useRef, useState } from 'react'

import { getUiZoom } from '../settings/appearance.js'
import { reminderPresets } from '../reminders/store.js'

interface ContextMenuProps {
  x: number
  y: number
  isOwn: boolean
  canDelete: boolean
  editDisabled: boolean
  /** Не отображать «начать тред» — для DM-каналов и для самих тредов. */
  hideStartThread?: boolean
  /** Закреплено ли сообщение сейчас (для «закрепить» / «открепить»). */
  pinned?: boolean
  /** Может ли текущий пользователь закреплять (server: admin/owner; dm: да). */
  canPin?: boolean
  /** Быстрые реакции строкой над меню (если задано) — главный путь на тач. */
  onPickReaction?: (emoji: string) => void
  onReply: () => void
  onStartThread?: () => void
  onForward?: () => void
  /** «Напомнить об этом» — вызывается с моментом срабатывания (epoch ms). */
  onRemind?: (dueAt: number, label: string) => void
  onPin?: () => void
  onUnpin?: () => void
  onEdit: () => void
  onDelete: () => void
  onCopyText: () => void
  onCopyLink: () => void
  onClose: () => void
}

const MENU_WIDTH = 172

// Быстрые реакции — частые эмодзи строкой над пунктами меню (Telegram-style).
const QUICK_REACTIONS = ['👍', '❤️', '😂', '😮', '😢', '🔥']

function Item({
  onClick, danger, disabled, children,
}: {
  onClick: () => void
  danger?: boolean
  disabled?: boolean
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={disabled ? undefined : onClick}
      className={`w-full text-left px-3 py-1.5 text-[12px] flex items-center gap-2 transition-colors
        ${disabled
          ? 'text-kd-text-mute cursor-not-allowed opacity-50'
          : danger
            ? 'text-kd-danger hover:bg-kd-danger/10'
            : 'text-kd-text hover:bg-kd-panel-alt'
        }`}
    >
      {children}
    </button>
  )
}

export function ContextMenu({
  x, y, isOwn, canDelete, editDisabled, hideStartThread, pinned, canPin, onPickReaction,
  onReply, onStartThread, onForward, onRemind, onPin, onUnpin, onEdit, onDelete, onCopyText, onCopyLink, onClose,
}: ContextMenuProps) {
  const ref = useRef<HTMLDivElement>(null)
  // «Напомнить» раскрывает пресеты прямо в меню (вложенных меню у нас нет).
  const [remindOpen, setRemindOpen] = useState(false)
  // Позиция после измерения реального размера меню: пока null — рендерим
  // невидимо в точке клика, после measure прижимаем к краям окна (а если
  // снизу не влезает — открываем вверх от курсора, как в Discord).
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null)

  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    // Всё считаем в zoom-локальном пространстве (см. getUiZoom): rect и
    // innerWidth/Height — визуальные px, делим на z, иначе на 125/150%
    // меню уезжает от курсора.
    const z = getUiZoom()
    const rect = el.getBoundingClientRect()
    const w = rect.width / z
    const h = rect.height / z
    const vw = window.innerWidth / z
    const vh = window.innerHeight / z
    const lx = x / z
    const ly = y / z
    const nx = Math.max(8, Math.min(lx, vw - w - 8))
    let ny = ly
    if (ly + h > vh - 8) {
      ny = Math.max(8, ly - h)
    }
    setPos({ x: nx, y: ny })
  }, [x, y])

  useEffect(() => {
    function handleMouseDown(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose()
    }
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('mousedown', handleMouseDown)
    document.addEventListener('keydown', handleKeyDown)
    return () => {
      document.removeEventListener('mousedown', handleMouseDown)
      document.removeEventListener('keydown', handleKeyDown)
    }
  }, [onClose])

  return (
    <div
      ref={ref}
      className={`fixed z-50 bg-kd-panel border border-kd-border rounded-kd shadow-lg py-1 select-none ${pos ? 'kd-pop-in' : ''}`}
      style={{
        left: pos?.x ?? x,
        top: pos?.y ?? y,
        minWidth: MENU_WIDTH,
        visibility: pos ? 'visible' : 'hidden',
      }}
    >
      {onPickReaction && (
        <>
          <div className="flex items-center gap-1 px-2 py-1.5">
            {QUICK_REACTIONS.map((emoji) => (
              <button
                key={emoji}
                type="button"
                onClick={() => { onPickReaction(emoji); onClose() }}
                className="flex-1 flex items-center justify-center text-[18px] rounded py-1 hover:bg-kd-panel-alt transition-colors"
              >
                {emoji}
              </button>
            ))}
          </div>
          <div className="my-1 border-t border-kd-border" />
        </>
      )}
      <Item onClick={() => { onReply(); onClose() }}>Ответить</Item>
      {!hideStartThread && onStartThread && (
        <Item onClick={() => { onStartThread(); onClose() }}>Начать тред</Item>
      )}
      <Item onClick={() => { onCopyText(); onClose() }}>Копировать текст</Item>
      <Item onClick={() => { onCopyLink(); onClose() }}>Копировать ссылку</Item>
      {onForward && (
        <Item onClick={() => { onForward(); onClose() }}>Переслать</Item>
      )}
      {onRemind && (
        remindOpen ? (
          reminderPresets().map((p) => (
            <Item key={p.label} onClick={() => { onRemind(p.dueAt, p.label); onClose() }}>
              <span className="pl-3">{p.label}</span>
            </Item>
          ))
        ) : (
          <Item onClick={() => setRemindOpen(true)}>Напомнить ▸</Item>
        )
      )}
      {canPin && (pinned
        ? <Item onClick={() => { onUnpin?.(); onClose() }}>Открепить</Item>
        : <Item onClick={() => { onPin?.(); onClose() }}>Закрепить</Item>
      )}
      {isOwn && (
        <Item
          onClick={() => { onEdit(); onClose() }}
          disabled={editDisabled}
        >
          {editDisabled ? 'Изменить (окно закрыто)' : 'Изменить'}
        </Item>
      )}
      {canDelete && (
        <>
          <div className="my-1 border-t border-kd-border" />
          <Item onClick={() => { onDelete(); onClose() }} danger>
            Удалить
          </Item>
        </>
      )}
    </div>
  )
}
