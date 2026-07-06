// Портал-всплывашка около якоря (кнопки): рендерится в document.body с
// position:fixed, поэтому её не режут overflow-контейнеры (лента сообщений
// клипает absolute-потомков и по горизонтали — пикер у края чата обрезался).
// Позиция: по вертикали предпочитаем «над якорем», при нехватке места — под;
// по горизонтали прижимаем к краю якоря и клампим во вьюпорт. ResizeObserver
// перемеряет после ленивой загрузки контента (Suspense-fallback меньше),
// scroll в capture-фазе держит всплывашку у якоря при прокрутке ленты.

import { type ReactNode, useLayoutEffect, useRef } from 'react'
import { createPortal } from 'react-dom'

const MARGIN = 8
const GAP = 4

interface PopoverProps {
  /** Элемент-якорь; рендерить Popover только когда он есть (`open && ref.current`). */
  anchor: HTMLElement
  /** Какой край всплывашки совмещать с якорем по X. По умолчанию — правый. */
  align?: 'start' | 'end'
  onClose: () => void
  children: ReactNode
}

export function Popover({ anchor, align = 'end', onClose, children }: PopoverProps) {
  const ref = useRef<HTMLDivElement>(null)

  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return undefined

    const place = () => {
      const a = anchor.getBoundingClientRect()
      const w = el.offsetWidth
      const h = el.offsetHeight
      let x = align === 'start' ? a.left : a.right - w
      x = Math.min(x, window.innerWidth - MARGIN - w)
      x = Math.max(x, MARGIN)
      const fitsAbove = a.top - GAP - h >= MARGIN
      const fitsBelow = a.bottom + GAP + h <= window.innerHeight - MARGIN
      let y = fitsAbove || !fitsBelow ? a.top - GAP - h : a.bottom + GAP
      y = Math.max(y, MARGIN)
      y = Math.min(y, window.innerHeight - MARGIN - h)
      el.style.left = `${x}px`
      el.style.top = `${y}px`
    }

    place()
    const observer = new ResizeObserver(place)
    observer.observe(el)
    window.addEventListener('resize', place)
    document.addEventListener('scroll', place, true)
    return () => {
      observer.disconnect()
      window.removeEventListener('resize', place)
      document.removeEventListener('scroll', place, true)
    }
  }, [anchor, align])

  useLayoutEffect(() => {
    function onMouseDown(e: MouseEvent) {
      const t = e.target as Node
      if (ref.current?.contains(t) || anchor.contains(t)) return
      onClose()
    }
    document.addEventListener('mousedown', onMouseDown)
    return () => document.removeEventListener('mousedown', onMouseDown)
  }, [anchor, onClose])

  return createPortal(
    // Стартуем за экраном: place() в layout-фазе поставит настоящие координаты
    // до отрисовки кадра — без вспышки в левом верхнем углу.
    <div ref={ref} className="fixed z-50 shadow-lg" style={{ left: -9999, top: -9999 }}>
      {children}
    </div>,
    document.body,
  )
}
