// Универсальное контекстное меню (ПКМ) — единый примитив для рельсы серверов,
// каналов, участников, личек и т.п. Без иконок (по дизайну меню — текстовые).
// Позиционирование zoom-aware (см. getUiZoom): прижимаем к краям окна и
// открываем вверх, если снизу не влезает — как в Discord.

import { useEffect, useLayoutEffect, useRef, useState } from 'react'

import { getUiZoom } from '../features/settings/appearance.js'

export type MenuEntry =
  | { kind?: 'item'; label: string; onClick: () => void; danger?: boolean; disabled?: boolean }
  | { kind: 'sep' }

const MENU_WIDTH = 180

/** Состояние позиции ПКМ-меню. open(e) — из onContextMenu, close() — закрыть. */
export function useContextMenu() {
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null)
  function open(e: React.MouseEvent) {
    e.preventDefault()
    e.stopPropagation()
    setPos({ x: e.clientX, y: e.clientY })
  }
  function close() { setPos(null) }
  return { pos, open, close }
}

function MenuItem({
  entry, onClose,
}: {
  entry: Extract<MenuEntry, { kind?: 'item' }>
  onClose: () => void
}) {
  return (
    <button
      type="button"
      disabled={entry.disabled}
      onClick={entry.disabled ? undefined : () => { entry.onClick(); onClose() }}
      // block обязателен: инлайн-блочные кнопки при shrink-to-fit ширине
      // fixed-контейнера складываются в одну строку, и меню растягивается
      // до суммы ширин всех пунктов.
      className={`block w-full text-left px-3 py-1.5 text-[12px] transition-colors
        ${entry.disabled
          ? 'text-kd-text-mute cursor-not-allowed opacity-50'
          : entry.danger
            ? 'text-kd-danger hover:bg-kd-danger/10'
            : 'text-kd-text hover:bg-kd-panel-alt'
        }`}
    >
      {entry.label}
    </button>
  )
}

export function ContextMenu({
  x, y, items, onClose,
}: {
  x: number
  y: number
  items: MenuEntry[]
  onClose: () => void
}) {
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null)

  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
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
    if (ly + h > vh - 8) ny = Math.max(8, ly - h)
    setPos({ x: nx, y: ny })
  }, [x, y])

  useEffect(() => {
    function onDown(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose()
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [onClose])

  // Пустое меню не рендерим (нечего показать).
  if (items.length === 0) return null

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
      {items.map((entry, i) =>
        entry.kind === 'sep'
          ? <div key={`sep-${i}`} className="my-1 border-t border-kd-border" />
          : <MenuItem key={`item-${i}`} entry={entry} onClose={onClose} />,
      )}
    </div>
  )
}
