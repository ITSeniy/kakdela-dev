// ПКМ-меню участника голосового канала: персональная громкость (голос и
// стрим), локальный мьют; для админа — серверный mute/deafen и кик.
// Используется и в дереве участников (ChannelList), и на карточках сцены
// (VoiceScreen) — поэтому самодостаточно: свои мутации и click-outside.

import { useEffect, useRef } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'

import { Icon } from '../../components/Icon.js'
import { toast } from '../../components/toast/index.js'
import { applyParticipantVolume, toggleLocalParticipantMute } from '../../lib/livekit.js'
import { clampFixed } from '../settings/appearance.js'
import { moderateVoice } from './api.js'
import { useLocalMute } from './localMute.js'
import { useVoiceVolumes, volumesFor } from './volumeSettings.js'

export interface VoiceUserMenuTarget {
  channelId: string
  userId: string
  name: string
  /** Транслирует ли экран — показывает слайдер громкости стрима. */
  live: boolean
  serverMuted: boolean
  serverDeafened: boolean
}

interface VoiceUserMenuProps {
  x: number
  y: number
  target: VoiceUserMenuTarget
  canManage: boolean
  onClose(): void
}

export function VoiceUserMenu({ x, y, target, canManage, onClose }: VoiceUserMenuProps) {
  const ref = useRef<HTMLDivElement>(null)
  const queryClient = useQueryClient()
  const voiceVolumes = useVoiceVolumes((s) => s.volumes)
  const setVoiceVolume = useVoiceVolumes((s) => s.setVolume)
  const locallyMuted = useLocalMute((s) => s.mutedUserIds.includes(target.userId))

  useEffect(() => {
    function onDown(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose()
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [onClose])

  const moderate = useMutation({
    mutationFn: (vars: { action: 'mute' | 'unmute' | 'deafen' | 'undeafen' | 'kick' }) =>
      moderateVoice(target.channelId, { userId: target.userId, action: vars.action }),
    onError: (err) => {
      toast.error(`не получилось: ${(err as Error).message}`)
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: ['voiceParticipants', target.channelId] })
    },
  })

  const vols = volumesFor(voiceVolumes, target.userId)

  return (
    <div
      ref={ref}
      className="fixed z-50 min-w-[190px] bg-kd-panel border border-kd-border rounded-kd shadow-kd-modal py-1 select-none"
      style={{
        left: clampFixed(x, 198, window.innerWidth),
        top: clampFixed(y, 260, window.innerHeight),
      }}
    >
      <div className="px-3 py-1.5 text-[11px] font-bold text-kd-text truncate border-b border-kd-border mb-1">
        {target.name}
      </div>
      {/* Персональная громкость: голос всегда, стрим — когда транслирует.
          Меню при перетаскивании ползунка не закрывается. */}
      <div className="px-3 py-1.5 flex flex-col gap-0.5">
        <label className="text-[10px] font-mono text-kd-text-mute flex items-center justify-between">
          <span>громкость</span>
          <span>{Math.round(vols.user * 100)}%</span>
        </label>
        <input
          type="range"
          min={0}
          max={200}
          value={Math.round(vols.user * 100)}
          onChange={(e) => {
            setVoiceVolume(target.userId, 'user', Number(e.target.value) / 100)
            applyParticipantVolume(target.userId)
          }}
          className="w-full h-1 accent-kd-accent cursor-pointer"
        />
      </div>
      {target.live && (
        <div className="px-3 py-1.5 flex flex-col gap-0.5">
          <label className="text-[10px] font-mono text-kd-text-mute flex items-center justify-between">
            <span>громкость стрима</span>
            <span>{Math.round(vols.stream * 100)}%</span>
          </label>
          <input
            type="range"
            min={0}
            max={200}
            value={Math.round(vols.stream * 100)}
            onChange={(e) => {
              setVoiceVolume(target.userId, 'stream', Number(e.target.value) / 100)
              applyParticipantVolume(target.userId)
            }}
            className="w-full h-1 accent-kd-accent cursor-pointer"
          />
        </div>
      )}
      <button
        type="button"
        onClick={() => {
          toggleLocalParticipantMute(target.userId)
          onClose()
        }}
        className="w-full text-left px-3 py-1 text-[12px] leading-tight flex items-center gap-2 text-kd-text hover:bg-kd-panel-hi transition-colors"
      >
        {locallyMuted ? (
          <><Icon.Speaker size={12} className="text-kd-text-mute" /> слышать снова</>
        ) : (
          <><Icon.MicOff size={12} className="text-kd-text-mute" /> заглушить локально</>
        )}
      </button>
      {canManage && (
        <>
          <div className="my-1 h-px bg-kd-border mx-2" />
          <button
            type="button"
            onClick={() => {
              moderate.mutate({ action: target.serverMuted ? 'unmute' : 'mute' })
              onClose()
            }}
            className="w-full text-left px-3 py-1 text-[12px] leading-tight flex items-center gap-2 text-kd-text hover:bg-kd-panel-hi transition-colors"
          >
            <Icon.MicOff size={12} className="text-kd-warm" />
            {target.serverMuted ? 'вернуть микрофон' : 'заглушить микрофон'}
          </button>
          <button
            type="button"
            onClick={() => {
              moderate.mutate({ action: target.serverDeafened ? 'undeafen' : 'deafen' })
              onClose()
            }}
            className="w-full text-left px-3 py-1 text-[12px] leading-tight flex items-center gap-2 text-kd-text hover:bg-kd-panel-hi transition-colors"
          >
            <Icon.HeadphonesOff size={12} className="text-kd-warm" />
            {target.serverDeafened ? 'вернуть звук' : 'выключить звук'}
          </button>
          <div className="my-1 h-px bg-kd-border mx-2" />
          <button
            type="button"
            onClick={() => {
              moderate.mutate({ action: 'kick' })
              onClose()
            }}
            className="w-full text-left px-3 py-1 text-[12px] leading-tight flex items-center gap-2 text-kd-danger hover:bg-kd-danger/10 transition-colors"
          >
            <Icon.PhoneOff size={12} />
            отключить от канала
          </button>
        </>
      )}
    </div>
  )
}
