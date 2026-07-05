// Карточка опроса в ленте (Telegram-style): вопрос, варианты с прогресс-
// барами и живыми счётчиками. Клик по варианту — голос; повторный клик по
// своему варианту — снимает голос; клик по другому — переносит. Обновления
// приходят по WS poll.vote (патч кэша в useMessages), поэтому локального
// состояния нет — только optimistic-блокировка на время запроса.

import { useState } from 'react'

import type { PollView } from '@kakdela/ginzu/api-types'

import { Icon } from '../../components/Icon.js'
import { toast } from '../../components/toast/index.js'
import { unvotePoll, votePoll } from './api.js'

function pluralVotes(n: number): string {
  const mod10 = n % 10
  const mod100 = n % 100
  if (mod10 === 1 && mod100 !== 11) return 'голос'
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return 'голоса'
  return 'голосов'
}

export function PollCard({ messageId, poll }: { messageId: string; poll: PollView }) {
  const [busy, setBusy] = useState(false)

  async function onPick(idx: number) {
    if (busy) return
    setBusy(true)
    try {
      if (poll.myVote === idx) await unvotePoll(messageId)
      else await votePoll(messageId, idx)
    } catch {
      toast.error('не получилось проголосовать')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="mt-1 max-w-[420px] bg-kd-panel-alt border border-kd-border rounded-kd p-3">
      <div className="flex items-start gap-2">
        <Icon.BarChart size={14} className="text-kd-accent shrink-0 mt-0.5" />
        <div className="text-[13px] font-bold text-kd-text whitespace-pre-wrap break-words">
          {poll.question}
        </div>
      </div>
      <div className="mt-2.5 flex flex-col gap-1.5">
        {poll.options.map((o, i) => {
          const mine = poll.myVote === i
          const pct = poll.totalVotes > 0 ? Math.round((o.votes / poll.totalVotes) * 100) : 0
          return (
            <button
              key={i}
              type="button"
              disabled={busy}
              onClick={() => void onPick(i)}
              title={mine ? 'снять голос' : 'проголосовать'}
              className={[
                'relative w-full text-left rounded px-2.5 py-1.5 border transition-colors overflow-hidden',
                mine
                  ? 'border-kd-accent bg-kd-accent/10'
                  : 'border-kd-border bg-kd-bg hover:border-kd-accent/50',
                busy ? 'opacity-70 cursor-wait' : '',
              ].join(' ')}
            >
              {/* Прогресс-полоса под содержимым. */}
              <span
                className={`absolute inset-y-0 left-0 ${mine ? 'bg-kd-accent/20' : 'bg-kd-panel-hi'} transition-[width] duration-300`}
                style={{ width: `${pct}%` }}
              />
              <span className="relative flex items-center gap-2">
                <span className="flex-1 text-[12px] text-kd-text break-words min-w-0">
                  {mine && <Icon.Check size={11} className="inline mr-1 text-kd-accent" />}
                  {o.text}
                </span>
                <span className="shrink-0 text-[10px] font-mono text-kd-text-mute">
                  {o.votes > 0 ? `${o.votes} · ${pct}%` : pct > 0 ? `${pct}%` : ''}
                </span>
              </span>
            </button>
          )
        })}
      </div>
      <div className="mt-2 text-[10px] font-mono text-kd-text-mute">
        {poll.totalVotes > 0
          ? `${poll.totalVotes} ${pluralVotes(poll.totalVotes)}`
          : 'пока никто не голосовал'}
      </div>
    </div>
  )
}
