// Модалка создания встречи: название + дата/время + место. Отправляется
// отдельным сообщением с event-полем (как опрос) — в ленту прилетит
// собственным WS msg.new.

import { useState } from 'react'

import { Icon } from '../../components/Icon.js'
import { Modal } from '../../components/Modal.js'
import { toast } from '../../components/toast/index.js'
import { ApiError } from '../../lib/api.js'
import { sendMessage } from './api.js'

const INPUT_CLS = 'w-full bg-kd-bg border border-kd-border rounded px-2.5 py-2 text-[13px] text-kd-text outline-none focus:border-kd-accent placeholder:text-kd-text-mute'

/** Дефолт: сегодня 20:00, а если уже поздно — завтра 20:00 (когда собираемся). */
function defaultStart(): { date: string; time: string } {
  const d = new Date()
  if (d.getHours() >= 19) d.setDate(d.getDate() + 1)
  const iso = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  return { date: iso, time: '20:00' }
}

export function CreateEventModal({ channelId, onClose }: { channelId: string; onClose(): void }) {
  const init = defaultStart()
  const [title, setTitle] = useState('')
  const [date, setDate] = useState(init.date)
  const [time, setTime] = useState(init.time)
  const [place, setPlace] = useState('')
  const [sending, setSending] = useState(false)

  const startsAtMs = new Date(`${date}T${time}`).getTime()
  const valid = title.trim().length > 0 && Number.isFinite(startsAtMs)
  const inPast = Number.isFinite(startsAtMs) && startsAtMs < Date.now()
  const canSend = valid && !inPast && !sending

  async function submit() {
    if (!canSend) return
    setSending(true)
    try {
      await sendMessage(channelId, {
        content: '',
        event: {
          title: title.trim(),
          startsAt: new Date(startsAtMs).toISOString(),
          place: place.trim() || null,
        },
      })
      onClose()
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'не получилось создать встречу')
      setSending(false)
    }
  }

  function onKeyDown(e: React.KeyboardEvent) {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      e.preventDefault()
      void submit()
    }
  }

  return (
    <Modal onClose={onClose} width={440}>
      <div className="p-5 flex flex-col gap-4" onKeyDown={onKeyDown}>
        <div className="flex items-center gap-2">
          <Icon.Calendar size={16} className="text-kd-accent" />
          <span className="text-[14px] font-bold text-kd-text">новая встреча</span>
        </div>

        <div className="flex flex-col gap-1.5">
          <label className="text-[10px] font-mono text-kd-text-mute uppercase tracking-wider">что делаем</label>
          <input
            type="text"
            autoFocus
            value={title}
            onChange={(e) => setTitle(e.target.value.slice(0, 200))}
            placeholder="катаем Deep Rock"
            className={INPUT_CLS}
          />
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div className="flex flex-col gap-1.5">
            <label className="text-[10px] font-mono text-kd-text-mute uppercase tracking-wider">дата</label>
            <input type="date" value={date} onChange={(e) => setDate(e.target.value)} className={INPUT_CLS} />
          </div>
          <div className="flex flex-col gap-1.5">
            <label className="text-[10px] font-mono text-kd-text-mute uppercase tracking-wider">время</label>
            <input type="time" value={time} onChange={(e) => setTime(e.target.value)} className={INPUT_CLS} />
          </div>
        </div>

        <div className="flex flex-col gap-1.5">
          <label className="text-[10px] font-mono text-kd-text-mute uppercase tracking-wider">где (необязательно)</label>
          <input
            type="text"
            value={place}
            onChange={(e) => setPlace(e.target.value.slice(0, 200))}
            placeholder="голосовой «игровая» / у Пети"
            className={INPUT_CLS}
          />
        </div>

        {inPast && (
          <div className="text-[11px] font-mono text-kd-dnd">это время уже прошло</div>
        )}

        <div className="flex items-center gap-2 justify-end">
          <button
            type="button"
            onClick={onClose}
            className="px-3 py-1.5 rounded text-[12px] text-kd-text-soft hover:bg-kd-panel-hi transition-colors"
          >
            отмена
          </button>
          <button
            type="button"
            disabled={!canSend}
            onClick={() => void submit()}
            className="px-3.5 py-1.5 rounded bg-kd-accent text-white text-[12px] font-semibold hover:bg-kd-accent-deep transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {sending ? 'создаём…' : 'создать встречу'}
          </button>
        </div>
      </div>
    </Modal>
  )
}
