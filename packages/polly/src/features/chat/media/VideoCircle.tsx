// Плеер кружка (T-105): круглое видео inline в ленте, тап — play/pause,
// прогресс — кольцо вокруг круга (как в Telegram). Перемотки нет — кружок
// короткий (≤1 мин). Как и у голосовых, webm из MediaRecorder не содержит
// duration в метаданных — длительность берём из attachment.durationSec.

import { useCallback, useRef } from 'react'

import type { Attachment } from '@kakdela/ginzu/api-types'

import { fmtTime } from './controls.js'
import { useMediaPlayer } from './useMediaPlayer.js'

const SIZE = 240
const RING_WIDTH = 3

export function VideoCircle({ attachment }: { attachment: Attachment }) {
  const p = useMediaPlayer<HTMLVideoElement>()
  const elRef = useRef<HTMLVideoElement | null>(null)

  const setRef = useCallback((node: HTMLVideoElement | null) => {
    elRef.current = node
    p.setRef(node)
  }, [p.setRef]) // eslint-disable-line react-hooks/exhaustive-deps -- setRef стабилен

  // useMediaPlayer маппит нефинитную duration в 0 — тогда берём замер записи.
  const duration = p.duration > 0 ? p.duration : (attachment.durationSec ?? 0)
  const frac = duration > 0 ? Math.min(1, p.currentTime / duration) : 0

  const r = SIZE / 2 - RING_WIDTH / 2
  const circumference = 2 * Math.PI * r
  const timeLabel = p.playing || p.currentTime > 0
    ? fmtTime(duration > 0 ? Math.max(0, duration - p.currentTime) : p.currentTime)
    : fmtTime(duration)

  return (
    <button
      type="button"
      onClick={p.toggle}
      title={p.playing ? 'пауза' : 'смотреть кружок'}
      className="relative block rounded-full select-none"
      style={{ width: SIZE, height: SIZE, maxWidth: '100%' }}
    >
      {/* preload=metadata рисует первый кадр без скачивания всего файла */}
      <video
        ref={setRef}
        src={attachment.url}
        preload="metadata"
        playsInline
        className="w-full h-full rounded-full object-cover bg-kd-stage pointer-events-none"
      />
      {/* Кольцо прогресса воспроизведения */}
      <svg
        className="absolute inset-0 pointer-events-none -rotate-90"
        width={SIZE}
        height={SIZE}
        viewBox={`0 0 ${SIZE} ${SIZE}`}
      >
        <circle
          cx={SIZE / 2} cy={SIZE / 2} r={r}
          fill="none" stroke="var(--kd-border)" strokeWidth={RING_WIDTH}
        />
        <circle
          cx={SIZE / 2} cy={SIZE / 2} r={r}
          fill="none" stroke="var(--kd-accent)" strokeWidth={RING_WIDTH}
          strokeLinecap="round"
          strokeDasharray={circumference}
          strokeDashoffset={circumference * (1 - frac)}
        />
      </svg>
      {!p.playing && (
        <span className="absolute inset-0 flex items-center justify-center pointer-events-none">
          <span className="w-11 h-11 rounded-full bg-kd-overlay-strong text-kd-stage-text flex items-center justify-center text-[16px] pl-0.5">
            ▶
          </span>
        </span>
      )}
      <span className="absolute left-1/2 -translate-x-1/2 bottom-3 px-1.5 py-0.5 rounded bg-kd-overlay-strong text-kd-stage-text text-[10px] font-mono pointer-events-none">
        {timeLabel}
      </span>
    </button>
  )
}
