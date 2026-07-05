// Оверлей записи кружка (T-105): полноэкранная подложка с живым круглым
// превью фронталки, таймером и кнопками отмена/отправить. «Движок» записи —
// общий useNoteRecorder (video: true).

import { useEffect, useRef } from 'react'

import { Icon } from '../../components/Icon.js'
import { fmtTime } from './media/controls.js'
import type { NoteRecorder } from './useNoteRecorder.js'

export function VideoNoteOverlay({ recorder }: { recorder: NoteRecorder }) {
  const videoRef = useRef<HTMLVideoElement>(null)
  const sending = recorder.status === 'sending'

  useEffect(() => {
    const el = videoRef.current
    if (!el || !recorder.stream) return
    el.srcObject = recorder.stream
    void el.play().catch(() => { /* autoplay muted-превью не должен падать */ })
    return () => { el.srcObject = null }
  }, [recorder.stream])

  return (
    <div className="fixed inset-0 z-[70] bg-kd-overlay-strong flex flex-col items-center justify-center gap-5">
      <div className="w-[260px] h-[260px] rounded-full overflow-hidden border-2 border-kd-accent bg-kd-stage shadow-kd-modal">
        {/* Зеркалим только превью (как фронталка в Telegram) — сама запись
            остаётся незеркальной. */}
        <video
          ref={videoRef}
          muted
          playsInline
          className="w-full h-full object-cover -scale-x-100"
        />
      </div>
      <div className="flex items-center gap-2">
        <span className="w-2 h-2 rounded-full bg-kd-danger animate-pulse" />
        <span className="text-[13px] font-mono text-kd-stage-text">{fmtTime(recorder.elapsedSec)}</span>
        <span className="text-[11px] text-kd-stage-text opacity-70">{sending ? '· отправка…' : '· кружок'}</span>
      </div>
      <div className="flex items-center gap-6">
        <button
          type="button"
          onClick={recorder.cancel}
          disabled={sending}
          title="отменить запись"
          className="w-11 h-11 rounded-full bg-kd-overlay-soft text-kd-stage-text flex items-center justify-center hover:text-kd-danger transition-colors disabled:opacity-50"
        >
          <Icon.Trash size={17} />
        </button>
        <button
          type="button"
          onClick={recorder.finish}
          disabled={sending}
          title="отправить кружок"
          className="w-14 h-14 rounded-full bg-kd-accent text-white flex items-center justify-center hover:bg-kd-accent-deep transition-colors disabled:opacity-50"
        >
          <Icon.Send size={22} />
        </button>
      </div>
    </div>
  )
}
