// «Тебя зовут в войс»: лёгкий тост в углу (по образцу IncomingCall, но без
// popup-окна и зацикленного звука — это приглашение, а не звонок). «Зайти» —
// join голосового канала + переход к нему; ✕ или 20 секунд тишины — снятие.

import { useEffect, useState } from 'react'
import { useLocation } from 'wouter'

import { Avatar } from '../../components/Avatar.js'
import { Icon } from '../../components/Icon.js'
import { wsClient } from '../../lib/ws.js'
import { useAuthStore } from '../auth/store.js'
import { playSound } from '../sounds/sounds.js'
import { joinVoiceRoom } from './useVoiceRoom.js'
import { useVoiceStore } from './store.js'

interface Ring {
  channelId: string
  channelName: string
  serverId: string
  fromUserId: string
  fromName: string
  fromAvatarUrl: string | null
}

const AUTO_DISMISS_MS = 20_000

export function IncomingRing() {
  const [, navigate] = useLocation()
  const userId = useAuthStore((s) => s.user?.id ?? null)
  const [ring, setRing] = useState<Ring | null>(null)

  useEffect(() => {
    if (!userId) return undefined
    return wsClient.on((event) => {
      if (event.t !== 'voice.ring') return
      // Уже в этом канале — зов не нужен.
      if (useVoiceStore.getState().activeChannelId === event.channelId) return
      setRing({
        channelId: event.channelId,
        channelName: event.channelName,
        serverId: event.serverId,
        fromUserId: event.fromUserId,
        fromName: event.fromName,
        fromAvatarUrl: event.fromAvatarUrl,
      })
    })
  }, [userId])

  useEffect(() => {
    if (!ring) return undefined
    playSound('ring')
    const dismiss = setTimeout(() => setRing(null), AUTO_DISMISS_MS)
    return () => clearTimeout(dismiss)
  }, [ring])

  if (!ring) return null
  const r = ring

  function accept() {
    setRing(null)
    navigate(`/servers/${r.serverId}/channels/${r.channelId}`)
    void joinVoiceRoom(r.channelId)
  }

  return (
    <div className="fixed z-[70] bottom-4 right-4 left-4 sm:left-auto sm:w-[320px] kd-safe-bottom">
      <div className="bg-kd-panel border border-kd-border rounded-kd shadow-kd-modal p-3.5 flex items-center gap-3 kd-call-pop">
        <span className="relative shrink-0">
          <Avatar name={r.fromName} avatarUrl={r.fromAvatarUrl} size={44} />
          <span className="absolute -bottom-1 -right-1 w-5 h-5 rounded-full bg-kd-accent flex items-center justify-center border-2 border-kd-panel">
            <Icon.Speaker size={11} className="text-white" />
          </span>
        </span>
        <div className="flex-1 min-w-0">
          <div className="text-[13px] font-bold text-kd-text truncate">{r.fromName}</div>
          <div className="text-[10px] font-mono text-kd-text-soft truncate">
            зовёт в «{r.channelName}»
          </div>
        </div>
        <div className="flex items-center gap-1.5 shrink-0">
          <button
            type="button"
            onClick={() => setRing(null)}
            title="не сейчас"
            className="w-9 h-9 rounded-full bg-kd-panel-alt border border-kd-border text-kd-text-soft flex items-center justify-center hover:bg-kd-panel-hi transition-colors"
          >
            <Icon.X size={14} />
          </button>
          <button
            type="button"
            onClick={accept}
            title="зайти в голосовой"
            className="px-3.5 h-9 rounded-full bg-kd-accent text-white text-[12px] font-bold flex items-center gap-1.5 hover:opacity-90 transition-opacity"
          >
            <Icon.Speaker size={14} />
            зайти
          </button>
        </div>
      </div>
    </div>
  )
}
