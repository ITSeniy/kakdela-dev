// Плеер голосового сообщения (T-104): компактнее AudioPlayer — без имени
// файла и громкости, только play/перемотка/время. Особенность формата: webm
// из MediaRecorder не содержит duration в метаданных (в <audio> это Infinity
// до полной перемотки), поэтому длительность берём из attachment.durationSec,
// замеренной при записи, а перемотку при Infinity делаем прямым currentTime.

import { useCallback, useRef } from 'react'

import type { Attachment } from '@kakdela/ginzu/api-types'

import { Icon } from '../../../components/Icon.js'
import { PlayPauseButton, Seekbar, fmtTime } from './controls.js'
import { useMediaPlayer } from './useMediaPlayer.js'

export function VoiceMessage({ attachment }: { attachment: Attachment }) {
  const p = useMediaPlayer<HTMLAudioElement>()
  const elRef = useRef<HTMLAudioElement | null>(null)

  const setRef = useCallback((node: HTMLAudioElement | null) => {
    elRef.current = node
    p.setRef(node)
  }, [p.setRef]) // eslint-disable-line react-hooks/exhaustive-deps -- setRef стабилен

  // useMediaPlayer маппит нефинитную duration в 0 — тогда берём замер записи.
  const duration = p.duration > 0 ? p.duration : (attachment.durationSec ?? 0)
  const frac = duration > 0 ? Math.min(1, p.currentTime / duration) : 0
  const buffered = duration > 0 ? Math.min(1, p.buffered / duration) : 0

  const seek = useCallback((f: number) => {
    const el = elRef.current
    if (!el) return
    if (Number.isFinite(el.duration) && el.duration > 0) {
      p.seekFraction(f)
      return
    }
    // duration = Infinity (webm без метаданных) — целимся по известной длине.
    if (duration > 0) el.currentTime = Math.max(0, Math.min(1, f)) * duration
  }, [p.seekFraction, duration]) // eslint-disable-line react-hooks/exhaustive-deps

  // В простое показываем полную длительность, при прослушивании — позицию.
  const timeLabel = p.playing || p.currentTime > 0 ? fmtTime(p.currentTime) : fmtTime(duration)

  return (
    <div className="pl-2 pr-3.5 py-2 bg-kd-panel-alt rounded-kd border border-kd-border flex items-center gap-2.5 w-[280px] max-w-full">
      <audio ref={setRef} preload="none" src={attachment.url} className="hidden" />
      <PlayPauseButton playing={p.playing} onToggle={p.toggle} />
      <div className="flex-1 min-w-0">
        <Seekbar fraction={frac} buffered={buffered} onSeek={seek} tone="panel" />
        <div className="mt-0.5 flex items-center gap-1 text-kd-text-mute">
          <Icon.Mic size={10} />
          <span className="text-[10px] font-mono">{timeLabel}</span>
        </div>
      </div>
    </div>
  )
}
