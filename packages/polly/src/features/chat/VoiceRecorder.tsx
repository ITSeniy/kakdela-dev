// Панель записи голосового (T-104), замещает строку композера на время
// записи. Сам «движок» записи — общий useNoteRecorder (он же пишет кружки).

import { Icon } from '../../components/Icon.js'
import { fmtTime } from './media/controls.js'
import type { NoteRecorder } from './useNoteRecorder.js'

/** Полоса записи вместо строки композера: отмена · красная точка · таймер · отправить. */
export function VoiceRecorderBar({ recorder }: { recorder: NoteRecorder }) {
  const sending = recorder.status === 'sending'
  return (
    <div className="bg-kd-panel rounded-kd border border-kd-border flex items-center gap-2.5 px-3 py-2">
      <button
        type="button"
        onClick={recorder.cancel}
        disabled={sending}
        title="отменить запись"
        className="text-kd-text-mute hover:text-kd-danger transition-colors shrink-0 disabled:opacity-50"
      >
        <Icon.Trash size={15} />
      </button>
      <span className="w-2 h-2 rounded-full bg-kd-danger animate-pulse shrink-0" />
      <span className="text-[12px] font-mono text-kd-text shrink-0">{fmtTime(recorder.elapsedSec)}</span>
      <span className="flex-1 text-[11px] text-kd-text-mute truncate">
        {sending ? 'отправка…' : 'идёт запись'}
      </span>
      <button
        type="button"
        onClick={recorder.finish}
        disabled={sending}
        title="отправить голосовое"
        className="w-9 h-9 rounded-full bg-kd-accent text-white flex items-center justify-center hover:bg-kd-accent-deep transition-colors disabled:opacity-50 shrink-0"
      >
        <Icon.Send size={17} />
      </button>
    </div>
  )
}
