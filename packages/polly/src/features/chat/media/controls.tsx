// Презентационные примитивы плееров: кнопка play/pause, перемотка/громкость
// (один Seekbar на оба), иконочная кнопка, формат времени. Две «тональности»:
// panel — на тёплой панели чата (токены темы), stage — поверх тёмной сцены
// лайтбокса (бело-альфа, не зависит от темы).

import { useEffect, useRef, useState } from 'react'

import { Icon } from '../../../components/Icon.js'

export type Tone = 'panel' | 'stage'

const ICON_BTN: Record<Tone, string> = {
  panel: 'text-kd-text-mute hover:text-kd-text',
  stage: 'text-white/70 hover:text-white',
}

const SEEK: Record<Tone, { track: string; buffer: string; progress: string; thumb: string }> = {
  panel: { track: 'bg-kd-bg-deep', buffer: 'bg-kd-panel-hi', progress: 'bg-kd-accent', thumb: 'bg-kd-accent' },
  stage: { track: 'bg-white/15', buffer: 'bg-white/30', progress: 'bg-kd-accent', thumb: 'bg-white' },
}

export function fmtTime(sec: number): string {
  const s = Number.isFinite(sec) && sec > 0 ? Math.floor(sec) : 0
  const hh = Math.floor(s / 3600)
  const mm = Math.floor(s / 60) % 60
  const ss = s % 60
  const pad = (n: number) => String(n).padStart(2, '0')
  return hh > 0 ? `${hh}:${pad(mm)}:${pad(ss)}` : `${mm}:${pad(ss)}`
}

export function PlayPauseButton({ playing, onToggle }: { playing: boolean; onToggle: () => void }) {
  return (
    <button
      type="button"
      onClick={onToggle}
      title={playing ? 'пауза' : 'играть'}
      className="shrink-0 w-8 h-8 rounded-full bg-kd-accent text-white flex items-center justify-center hover:bg-kd-accent-deep transition-colors"
    >
      {playing ? <Icon.Pause size={15} /> : <Icon.Play size={15} />}
    </button>
  )
}

export function IconButton({
  tone, title, onClick, children,
}: {
  tone: Tone
  title: string
  onClick: () => void
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      className={`shrink-0 flex items-center justify-center transition-colors ${ICON_BTN[tone]}`}
    >
      {children}
    </button>
  )
}

/** Полоса перемотки. Используется и как seek (с буфером), и как громкость. */
export function Seekbar({
  fraction, buffered = 0, onSeek, tone, className,
}: {
  fraction: number
  buffered?: number
  onSeek: (f: number) => void
  tone: Tone
  className?: string
}) {
  const ref = useRef<HTMLDivElement>(null)
  const [hover, setHover] = useState(false)
  const [dragging, setDragging] = useState(false)
  const c = SEEK[tone]

  const fracFrom = (clientX: number) => {
    const el = ref.current
    if (!el) return 0
    const r = el.getBoundingClientRect()
    return r.width ? Math.max(0, Math.min(1, (clientX - r.left) / r.width)) : 0
  }

  // Pointer-события вместо mouse: на тачах (мобильный клиент, T-104) drag
  // по полосе иначе не работает. touch-none гасит скролл во время перемотки.
  const onDown = (e: React.PointerEvent) => {
    e.preventDefault()
    setDragging(true)
    onSeek(fracFrom(e.clientX))
  }

  useEffect(() => {
    if (!dragging) return
    const move = (e: PointerEvent) => onSeek(fracFrom(e.clientX))
    const up = () => setDragging(false)
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
    window.addEventListener('pointercancel', up)
    return () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      window.removeEventListener('pointercancel', up)
    }
  }, [dragging, onSeek])

  const pct = `${Math.max(0, Math.min(1, fraction)) * 100}%`
  const buf = `${Math.max(0, Math.min(1, buffered)) * 100}%`

  return (
    <div
      ref={ref}
      onPointerDown={onDown}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      className={`relative h-3 flex items-center cursor-pointer select-none touch-none ${className ?? ''}`}
    >
      <div className={`relative w-full h-1 rounded-full overflow-hidden ${c.track}`}>
        <div className={`absolute inset-y-0 left-0 ${c.buffer}`} style={{ width: buf }} />
        <div className={`absolute inset-y-0 left-0 ${c.progress}`} style={{ width: pct }} />
      </div>
      <div
        className={`absolute top-1/2 -translate-y-1/2 -translate-x-1/2 w-2.5 h-2.5 rounded-full ${c.thumb} transition-opacity ${hover || dragging ? 'opacity-100' : 'opacity-0'}`}
        style={{ left: pct }}
      />
    </div>
  )
}
