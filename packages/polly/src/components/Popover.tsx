// Портал-всплывашка около якоря (кнопки): рендерится в document.body с
// position:fixed, поэтому её не режут overflow-контейнеры (лента сообщений
// клипает absolute-потомков и по горизонтали — пикер у края чата обрезался).
// Позиция: по вертикали предпочитаем «над якорем», при нехватке места — под;
// по горизонтали прижимаем к краю якоря и клампим во вьюпорт. ResizeObserver
// перемеряет после ленивой загрузки контента (Suspense-fallback меньше),
// scroll в capture-фазе держит всплывашку у якоря при прокрутке ленты.
//
// Масштаб интерфейса — CSS `zoom` на <html> (дефолт 125%). getBoundingClientRect
// и innerWidth остаются «визуальными» CSS-px, а left/top у fixed-элемента внутри
// зумнутого <html> — ЛОКАЛЬНЫЕ. Считаем всё в локальных px (визуальные делим на
// zoom, offsetWidth уже локальный), иначе на 125/150% всплывашка уезжает от
// якоря (та же поправка, что в clampFixed для ContextMenu).

import { type ReactNode, useLayoutEffect, useRef } from 'react'
import { createPortal } from 'react-dom'

import { getUiZoom } from '../features/settings/appearance.js'

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
      const z = getUiZoom()
      const a = anchor.getBoundingClientRect()
      // rect / innerWidth — «визуальные» px; приводим к локальным (÷z). offsetWidth
      // уже локальный, left/top тоже задаём в локальных.
      const aLeft = a.left / z
      const aRight = a.right / z
      const aTop = a.top / z
      const aBottom = a.bottom / z
      const vw = window.innerWidth / z
      const vh = window.innerHeight / z
      const w = el.offsetWidth
      const h = el.offsetHeight
      let x = align === 'start' ? aLeft : aRight - w
      x = Math.min(x, vw - MARGIN - w)
      x = Math.max(x, MARGIN)
      const fitsAbove = aTop - GAP - h >= MARGIN
      const fitsBelow = aBottom + GAP + h <= vh - MARGIN
      let y = fitsAbove || !fitsBelow ? aTop - GAP - h : aBottom + GAP
      y = Math.max(y, MARGIN)
      y = Math.min(y, vh - MARGIN - h)
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
