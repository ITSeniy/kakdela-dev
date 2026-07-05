// Карточка встречи в ленте: заголовок, «сб, 12 июля · 20:00», место,
// кнопки «пойду / не пойду» (повторный клик снимает ответ) и аватары идущих.
// Живые обновления — WS event.rsvp (патч кэша в useMessages).

import { useState } from 'react'

import type { EventRsvp, EventView, MemberPublic } from '@kakdela/ginzu/api-types'

import { Avatar } from '../../components/Avatar.js'
import { Icon } from '../../components/Icon.js'
import { toast } from '../../components/toast/index.js'
import { rsvpEvent } from './api.js'

export function fmtEventTime(iso: string): string {
  const d = new Date(iso)
  const date = d.toLocaleDateString('ru', { weekday: 'short', day: 'numeric', month: 'long' })
  const time = d.toLocaleTimeString('ru', { hour: '2-digit', minute: '2-digit' })
  return `${date} · ${time}`
}

export function EventCard({
  messageId, event, memberMap,
}: {
  messageId: string
  event: EventView
  memberMap: ReadonlyMap<string, MemberPublic>
}) {
  const [busy, setBusy] = useState(false)
  const past = new Date(event.startsAt).getTime() < Date.now()

  async function onPick(rsvp: EventRsvp) {
    if (busy) return
    setBusy(true)
    try {
      // Клик по уже выбранному ответу снимает его.
      await rsvpEvent(messageId, event.myRsvp === rsvp ? null : rsvp)
    } catch {
      toast.error('не получилось ответить')
    } finally {
      setBusy(false)
    }
  }

  const goingMembers = event.going.map((id) => ({ id, member: memberMap.get(id) }))

  return (
    <div className={`mt-1 max-w-[420px] bg-kd-panel-alt border rounded-kd p-3 ${past ? 'border-kd-border opacity-75' : 'border-kd-accent/40'}`}>
      <div className="flex items-start gap-2.5">
        <span className="w-9 h-9 rounded-kd bg-kd-accent/15 border border-kd-accent/40 flex items-center justify-center shrink-0">
          <Icon.Calendar size={17} className="text-kd-accent" />
        </span>
        <div className="flex-1 min-w-0">
          <div className="text-[13px] font-bold text-kd-text break-words">{event.title}</div>
          <div className="text-[11px] font-mono text-kd-text-soft mt-0.5">
            {fmtEventTime(event.startsAt)}
            {past && ' · прошла'}
          </div>
          {event.place && (
            <div className="text-[11px] text-kd-text-mute mt-0.5 truncate">📍 {event.place}</div>
          )}
        </div>
      </div>

      {!past && (
        <div className="mt-2.5 flex items-center gap-1.5">
          <button
            type="button"
            disabled={busy}
            onClick={() => void onPick('going')}
            className={[
              'px-3 py-1.5 rounded text-[11px] font-semibold border transition-colors',
              event.myRsvp === 'going'
                ? 'bg-kd-online text-white border-transparent'
                : 'bg-kd-bg text-kd-text border-kd-border hover:border-kd-online/60',
              busy ? 'opacity-70 cursor-wait' : '',
            ].join(' ')}
          >
            пойду{event.going.length > 0 && ` · ${event.going.length}`}
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => void onPick('declined')}
            className={[
              'px-3 py-1.5 rounded text-[11px] font-semibold border transition-colors',
              event.myRsvp === 'declined'
                ? 'bg-kd-dnd text-white border-transparent'
                : 'bg-kd-bg text-kd-text-soft border-kd-border hover:border-kd-dnd/60',
              busy ? 'opacity-70 cursor-wait' : '',
            ].join(' ')}
          >
            не пойду{event.declined.length > 0 && ` · ${event.declined.length}`}
          </button>
        </div>
      )}

      {goingMembers.length > 0 && (
        <div className="mt-2.5 flex items-center gap-1">
          <div className="flex -space-x-1.5">
            {goingMembers.slice(0, 6).map(({ id, member }) => (
              <span key={id} title={member?.displayName ?? 'участник'} className="rounded-full ring-2 ring-kd-panel-alt">
                <Avatar name={member?.displayName ?? '?'} avatarUrl={member?.avatarUrl ?? null} size={20} />
              </span>
            ))}
          </div>
          <span className="text-[10px] font-mono text-kd-text-mute ml-1.5">
            {past ? 'были' : 'идут'}: {goingMembers.map(({ member }) => member?.displayName).filter(Boolean).slice(0, 4).join(', ')}
            {goingMembers.length > 4 && ` и ещё ${goingMembers.length - 4}`}
          </span>
        </div>
      )}
    </div>
  )
}
