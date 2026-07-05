// Модалка создания опроса: вопрос + 2–8 вариантов. Отправляется отдельным
// сообщением с poll-полем (без текста) напрямую через sendMessage — в ленту
// сообщение прилетит собственным WS msg.new, оптимистичный pending не нужен.

import { useState } from 'react'

import { Icon } from '../../components/Icon.js'
import { Modal } from '../../components/Modal.js'
import { toast } from '../../components/toast/index.js'
import { ApiError } from '../../lib/api.js'
import { sendMessage } from './api.js'

const MAX_OPTIONS = 8
const INPUT_CLS = 'w-full bg-kd-bg border border-kd-border rounded px-2.5 py-2 text-[13px] text-kd-text outline-none focus:border-kd-accent placeholder:text-kd-text-mute'

export function CreatePollModal({ channelId, onClose }: { channelId: string; onClose(): void }) {
  const [question, setQuestion] = useState('')
  const [options, setOptions] = useState<string[]>(['', ''])
  const [sending, setSending] = useState(false)

  const filled = options.map((o) => o.trim()).filter((o) => o.length > 0)
  const canSend = question.trim().length > 0 && filled.length >= 2 && !sending

  function setOption(i: number, value: string) {
    setOptions((prev) => prev.map((o, idx) => (idx === i ? value : o)))
  }

  function removeOption(i: number) {
    setOptions((prev) => (prev.length > 2 ? prev.filter((_, idx) => idx !== i) : prev))
  }

  async function submit() {
    if (!canSend) return
    setSending(true)
    try {
      await sendMessage(channelId, {
        content: '',
        poll: { question: question.trim(), options: filled },
      })
      onClose()
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'не получилось создать опрос')
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
          <Icon.BarChart size={16} className="text-kd-accent" />
          <span className="text-[14px] font-bold text-kd-text">новый опрос</span>
        </div>

        <div className="flex flex-col gap-1.5">
          <label className="text-[10px] font-mono text-kd-text-mute uppercase tracking-wider">вопрос</label>
          <input
            type="text"
            autoFocus
            value={question}
            onChange={(e) => setQuestion(e.target.value.slice(0, 300))}
            placeholder="во что катаем в пятницу?"
            className={INPUT_CLS}
          />
        </div>

        <div className="flex flex-col gap-1.5">
          <label className="text-[10px] font-mono text-kd-text-mute uppercase tracking-wider">варианты</label>
          {options.map((o, i) => (
            <div key={i} className="flex items-center gap-1.5">
              <input
                type="text"
                value={o}
                onChange={(e) => setOption(i, e.target.value.slice(0, 100))}
                placeholder={`вариант ${i + 1}`}
                className={INPUT_CLS}
              />
              {options.length > 2 && (
                <button
                  type="button"
                  onClick={() => removeOption(i)}
                  title="убрать вариант"
                  className="shrink-0 text-kd-text-mute hover:text-kd-danger transition-colors"
                >
                  <Icon.X size={14} />
                </button>
              )}
            </div>
          ))}
          {options.length < MAX_OPTIONS && (
            <button
              type="button"
              onClick={() => setOptions((prev) => [...prev, ''])}
              className="self-start text-[11px] font-mono text-kd-accent hover:underline"
            >
              + добавить вариант
            </button>
          )}
        </div>

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
            {sending ? 'создаём…' : 'создать опрос'}
          </button>
        </div>
      </div>
    </Modal>
  )
}
