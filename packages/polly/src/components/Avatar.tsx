import { useEffect, useMemo, useRef, useState } from 'react'

import { pickAvatarColor } from './palette.js'
import { type Status } from './StatusDot.js'

const STATUS_VAR: Record<Status, string> = {
  online:  'var(--kd-online)',
  idle:    'var(--kd-idle)',
  dnd:     'var(--kd-dnd)',
  offline: 'var(--kd-text-mute)',
}

/** GIF-аватар: файловый пайплайн всегда кладёт объект с расширением по MIME. */
export function isGifUrl(url: string): boolean {
  return /\.gif($|[?#])/i.test(url)
}

/**
 * Статичный первый кадр GIF-аватара. drawImage анимированной картинки по
 * спеке берёт первый кадр — рисуем его в canvas и показываем canvas вместо
 * <img>. Canvas может быть tainted (файлы с другого origin без CORS) — нам
 * не важно, readback не делаем. При ошибке загрузки падаем на живой <img>.
 */
function GifPoster({ src, size, ringShadow }: { src: string; size: number; ringShadow?: string }) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    let cancelled = false
    const img = new Image()
    img.onload = () => {
      if (cancelled) return
      const canvas = canvasRef.current
      const ctx = canvas?.getContext('2d')
      if (!canvas || !ctx) return
      // object-cover: центрированный квадратный кроп исходника.
      const side = Math.min(img.naturalWidth, img.naturalHeight)
      if (side === 0) { setFailed(true); return }
      const sx = (img.naturalWidth - side) / 2
      const sy = (img.naturalHeight - side) / 2
      ctx.clearRect(0, 0, canvas.width, canvas.height)
      ctx.drawImage(img, sx, sy, side, side, 0, 0, canvas.width, canvas.height)
    }
    img.onerror = () => { if (!cancelled) setFailed(true) }
    img.src = src
    return () => { cancelled = true }
    // size: смена размера пересоздаёт canvas-буфер пустым — кадр нужно перерисовать.
  }, [src, size])

  if (failed) {
    return (
      <img
        src={src}
        alt=""
        className="w-full h-full rounded-full object-cover"
        style={{ boxShadow: ringShadow }}
      />
    )
  }
  // ×2 к CSS-размеру — чтобы кадр не мылился на hi-dpi.
  const px = Math.max(2, Math.round(size * 2))
  return (
    <canvas
      ref={canvasRef}
      width={px}
      height={px}
      className="w-full h-full rounded-full"
      style={{ boxShadow: ringShadow }}
    />
  )
}

function initialsOf(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean)
  const first = parts[0]?.[0] ?? '?'
  const second = parts[1]?.[0] ?? ''
  return (first + second).toUpperCase()
}

interface AvatarProps {
  name: string
  avatarUrl?: string | null
  size?: number
  status?: Status
  className?: string
  /** Цвет подложки статус-точки (фон, на котором лежит аватар). */
  ringColor?: string
  /** Цвет кольца выделения вокруг аватара (speaking/active), как в common.jsx. */
  ring?: string
  /**
   * Проигрывать GIF-аватар. По умолчанию GIF показывается статичным первым
   * кадром; в войсе тайл передаёт speaking — аватар «оживает», пока человек
   * говорит. На не-GIF аватары флаг не влияет.
   */
  animate?: boolean
}

export function Avatar({ name, avatarUrl, size = 32, status, className, ringColor, ring, animate }: AvatarProps) {
  const color = useMemo(() => pickAvatarColor(name), [name])
  const initials = useMemo(() => initialsOf(name), [name])
  // Компактная статус-точка с тонкой обводкой под цвет фона
  // (designs/final-chrome.jsx, KD_MemberList: 9px с border 2px на аватаре 24).
  const dotSize = Math.min(10, Math.max(8, Math.round(size * 0.34)))
  const ringShadow = ring
    ? `0 0 0 2px ${ringColor ?? 'var(--kd-panel)'}, 0 0 0 4px ${ring}`
    : undefined

  return (
    <div
      className={`relative shrink-0 ${className ?? ''}`}
      style={{ width: size, height: size }}
    >
      {avatarUrl ? (
        isGifUrl(avatarUrl) && !animate ? (
          <GifPoster src={avatarUrl} size={size} ringShadow={ringShadow} />
        ) : (
          <img
            src={avatarUrl}
            alt=""
            className="w-full h-full rounded-full object-cover"
            style={{ boxShadow: ringShadow }}
          />
        )
      ) : (
        <div
          className="w-full h-full rounded-full flex items-center justify-center text-kd-stage-text font-semibold select-none"
          style={{ background: color, fontSize: size * 0.4, letterSpacing: '-0.02em', boxShadow: ringShadow }}
        >
          {initials}
        </div>
      )}
      {status && (
        <span
          className="absolute rounded-full"
          style={{
            bottom: -1, right: -1,
            width: dotSize, height: dotSize,
            background: STATUS_VAR[status],
            border: `2px solid ${ringColor ?? 'var(--kd-panel)'}`,
          }}
        />
      )}
    </div>
  )
}
