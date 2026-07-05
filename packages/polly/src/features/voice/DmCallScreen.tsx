// Экран DM-звонка (T-087). Лёгкая 1:1-версия VoiceScreen: переиспользует
// voice-store / LiveKit-инфраструктуру, но без серверного контекста (нет
// member-списка, модерации, theater-режима). Состояния: «звоним…» (один в
// комнате, ждём ответа) и активный звонок (собеседник зашёл) — сетка тайлов
// + панель управления. Демо экрана и камера работают как в серверном канале.

import { useEffect, useMemo, useRef, useState } from 'react'

import type { LocalVideoTrack, RemoteVideoTrack } from 'livekit-client'

import { Avatar } from '../../components/Avatar.js'
import { Badge } from '../../components/Badge.js'
import { Icon } from '../../components/Icon.js'
import { toast } from '../../components/toast/index.js'
import {
  getLocalCameraVideoTrack,
  getLocalScreenVideoTrack,
  getRemoteCameraVideoTrack,
  getRemoteScreenVideoTrack,
  watchScreen,
} from '../../lib/livekit.js'
import { wsClient } from '../../lib/ws.js'
import { useAuthStore } from '../auth/store.js'
import { ParticipantTile } from './ParticipantTile.js'
import { ScreenTile } from './ScreenTile.js'
import { VoiceControls } from './VoiceControls.js'
import { useCamera } from './useCamera.js'
import { useScreenShare } from './useScreenShare.js'
import { useVoiceRoom, type DmCallPeer } from './useVoiceRoom.js'
import { useVoiceStore, type ParticipantState } from './store.js'

interface DmCallScreenProps {
  channelId: string
  peer: DmCallPeer | undefined
  /** Свернуть звонок (вернуться к списку/чату) — звонок продолжается в фоне. */
  onMinimize?: () => void
}

interface Tile {
  key: string
  kind: 'face' | 'screen'
  userId: string
  displayName: string
  avatarUrl: string | null
  muted: boolean
  speaking: boolean
  isSelf: boolean
  screenTrack: LocalVideoTrack | RemoteVideoTrack | null
  cameraTrack: LocalVideoTrack | RemoteVideoTrack | null
}

function formatElapsed(total: number): string {
  const m = Math.floor(total / 60)
  const s = total % 60
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
}

export function DmCallScreen({ channelId, peer, onMinimize }: DmCallScreenProps) {
  const me = useAuthStore((s) => s.user)
  const { leave, toggleMute, toggleDeafen } = useVoiceRoom()
  const { startShare, stopShare } = useScreenShare()
  const { startCamera, stopCamera } = useCamera()

  const status = useVoiceStore((s) => s.status)
  const muted = useVoiceStore((s) => s.muted)
  const screenSharing = useVoiceStore((s) => s.screenSharing)
  const cameraOn = useVoiceStore((s) => s.cameraOn)
  const participants = useVoiceStore((s) => s.participants)
  const activeSpeakers = useVoiceStore((s) => s.activeSpeakers)
  const selfSpeaking = useVoiceStore((s) => s.selfSpeaking)
  const watchedScreens = useVoiceStore((s) => s.watchedScreens)
  const error = useVoiceStore((s) => s.error)

  const peerName = useVoiceStore((s) => s.activeDmUserName) ?? peer?.name ?? 'собеседник'
  const peerAvatar = useVoiceStore((s) => s.activeDmAvatarUrl) ?? peer?.avatarUrl ?? null

  const peerList = useMemo(
    () =>
      [...participants.values()].filter(
        (p): p is ParticipantState => p.userId !== me?.id,
      ),
    [participants, me?.id],
  )
  const peerPresent = peerList.length > 0
  const connected = status === 'connected' || status === 'reconnecting'
  // «Звоним…» — мы подключились к комнате, но собеседник ещё не зашёл.
  const ringing = !peerPresent

  // Собеседник был в звонке и вышел → звонок ЗАВЕРШЁН (а не «снова звоним»).
  // Без этого после ухода второй стороны экран ошибочно откатывался в дозвон.
  const everConnectedRef = useRef(false)
  useEffect(() => {
    if (peerPresent) {
      everConnectedRef.current = true
    } else if (everConnectedRef.current) {
      toast.info('звонок завершён')
      void leave()
    }
  }, [peerPresent, leave])

  // 1:1: чужую демку смотрим автоматически (без bandwidth-страхов нескольких
  // стримеров серверного канала).
  useEffect(() => {
    for (const p of peerList) {
      if (p.isScreenSharing && !watchedScreens.has(p.userId)) watchScreen(p.userId, true)
    }
  }, [peerList, watchedScreens])

  // Сигналинг окончания звонка (звоним → не дозвонились/отклонили). Сервер
  // шлёт инициатору `dm.call-cancel` по 30-сек таймауту и `dm.call-decline`,
  // если собеседник нажал «отклонить». Оба завершают наш экран.
  useEffect(() => {
    return wsClient.on((event) => {
      if (event.t === 'dm.call-decline' && event.channelId === channelId) {
        toast.info(`${peerName} отклонил звонок`)
        void leave()
      } else if (event.t === 'dm.call-cancel' && event.channelId === channelId) {
        toast.info(`${peerName} не ответил`)
        void leave()
      }
    })
  }, [channelId, peerName, leave])

  // Секундомер — от момента, когда собеседник зашёл.
  const [callSeconds, setCallSeconds] = useState(0)
  useEffect(() => {
    if (!peerPresent) {
      setCallSeconds(0)
      return undefined
    }
    const startedAt = Date.now()
    const t = setInterval(() => setCallSeconds(Math.floor((Date.now() - startedAt) / 1000)), 1000)
    return () => clearInterval(t)
  }, [peerPresent])

  const tiles = useMemo<Tile[]>(() => {
    if (!me) return []
    const result: Tile[] = []
    result.push({
      key: me.id,
      kind: 'face',
      userId: me.id,
      displayName: me.displayName,
      avatarUrl: me.avatarUrl ?? null,
      muted,
      speaking: selfSpeaking,
      isSelf: true,
      screenTrack: null,
      cameraTrack: cameraOn ? getLocalCameraVideoTrack() : null,
    })
    if (screenSharing) {
      const track = getLocalScreenVideoTrack()
      if (track) {
        result.push({
          key: `screen:${me.id}`, kind: 'screen', userId: me.id,
          displayName: me.displayName, avatarUrl: me.avatarUrl ?? null,
          muted, speaking: false, isSelf: true, screenTrack: track, cameraTrack: null,
        })
      }
    }
    for (const p of peerList) {
      result.push({
        key: p.userId,
        kind: 'face',
        userId: p.userId,
        displayName: p.displayName || peerName,
        avatarUrl: peerAvatar,
        muted: p.isMuted,
        speaking: activeSpeakers.has(p.userId),
        isSelf: false,
        screenTrack: null,
        cameraTrack: p.isCameraOn ? getRemoteCameraVideoTrack(p.userId) : null,
      })
      if (p.isScreenSharing) {
        const track = getRemoteScreenVideoTrack(p.userId)
        if (track) {
          result.push({
            key: `screen:${p.userId}`, kind: 'screen', userId: p.userId,
            displayName: p.displayName || peerName, avatarUrl: peerAvatar,
            muted: false, speaking: false, isSelf: false, screenTrack: track, cameraTrack: null,
          })
        }
      }
    }
    return result
  }, [me, muted, selfSpeaking, screenSharing, cameraOn, peerList, peerName, peerAvatar, activeSpeakers, watchedScreens])

  const onToggleScreenShare = (): void => {
    if (screenSharing) void stopShare()
    else void startShare()
  }

  return (
    <div className="flex-1 min-w-0 min-h-0 flex flex-col bg-kd-bg">
      {/* шапка */}
      <div className="px-4 py-2 border-b border-kd-border bg-kd-panel-alt flex items-center gap-3 shrink-0">
        {onMinimize && (
          <button
            type="button"
            onClick={onMinimize}
            title="свернуть звонок"
            className="-ml-1 shrink-0 text-kd-text-soft hover:text-kd-text transition-colors"
          >
            <Icon.ArrowLeft size={20} />
          </button>
        )}
        <Avatar name={peerName} avatarUrl={peerAvatar} size={30} />
        <div className="flex-1 min-w-0">
          <div className="text-[13px] font-bold text-kd-text truncate">{peerName}</div>
          <div className="text-[10px] font-mono text-kd-text-soft flex items-center gap-1.5">
            {ringing ? (
              <span className="text-kd-idle">● {connected ? 'звоним…' : 'соединение…'}</span>
            ) : (
              <>
                <Badge variant="live">LIVE</Badge>
                <span>{formatElapsed(callSeconds)}</span>
              </>
            )}
          </div>
        </div>
      </div>

      {ringing ? (
        // ── Состояние дозвона ──
        <div className="flex-1 flex flex-col items-center justify-center gap-5 px-6 bg-kd-stage">
          <div className="kd-ring-pulse rounded-full">
            <Avatar name={peerName} avatarUrl={peerAvatar} size={96} />
          </div>
          <div className="text-center">
            <div className="text-kd-text text-xl font-bold">{peerName}</div>
            <div className="text-kd-text-soft font-mono text-[12px] mt-1">
              {connected ? 'звоним…' : 'соединение…'}
            </div>
          </div>
          <button
            type="button"
            onClick={() => { void leave() }}
            title="отменить звонок"
            className="mt-2 w-14 h-14 rounded-full bg-kd-danger text-white flex items-center justify-center hover:opacity-90 transition-opacity"
          >
            <Icon.PhoneOff size={22} />
          </button>
        </div>
      ) : (
        // ── Активный звонок ──
        <>
          <div className="flex-1 min-h-0 flex flex-wrap gap-2 items-center justify-center content-center p-3 bg-kd-stage overflow-y-auto">
            {tiles.map((t) => (
              <div key={t.key} className="flex-1 min-w-[200px] max-w-[460px] aspect-video">
                {t.kind === 'screen' && t.screenTrack ? (
                  <ScreenTile
                    displayName={t.displayName}
                    isSelf={t.isSelf}
                    screenTrack={t.screenTrack}
                  />
                ) : (
                  <ParticipantTile
                    displayName={t.displayName}
                    avatarUrl={t.avatarUrl}
                    muted={t.muted}
                    speaking={t.speaking}
                    isSelf={t.isSelf}
                    cameraTrack={t.cameraTrack}
                  />
                )}
              </div>
            ))}
          </div>
          <VoiceControls
            onToggleMute={() => { void toggleMute() }}
            onToggleDeafen={() => { void toggleDeafen() }}
            onToggleCamera={() => { if (cameraOn) void stopCamera(); else void startCamera() }}
            onToggleScreenShare={onToggleScreenShare}
            onLeave={() => { void leave() }}
          />
        </>
      )}

      {error && !ringing && (
        <div className="px-4 py-1 text-center text-[10px] font-mono text-kd-dnd bg-kd-stage border-t border-kd-border">
          {error}
        </div>
      )}
    </div>
  )
}
