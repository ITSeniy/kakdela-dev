import { useEffect, useMemo, useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'

import type { Channel, MemberPublic } from '@kakdela/ginzu/api-types'
import type { LocalVideoTrack, RemoteVideoTrack } from 'livekit-client'

import { Badge } from '../../components/Badge.js'
import { Icon } from '../../components/Icon.js'
import {
  getLocalCameraVideoTrack,
  getLocalScreenVideoTrack,
  getRemoteCameraVideoTrack,
  getRemoteScreenVideoTrack,
  watchScreen,
} from '../../lib/livekit.js'
import { useAuthStore } from '../auth/store.js'
import { sendMessage } from '../chat/api.js'
import { uploadBlob } from '../files/upload.js'
import { listMembers } from '../servers/api.js'
import { MicPermissionDialog } from './MicPermission.js'
import { ParticipantTile } from './ParticipantTile.js'
import { ScreenTile } from './ScreenTile.js'
import { VoiceCallChat } from './VoiceCallChat.js'
import { VoiceControls } from './VoiceControls.js'
import { VoiceUserMenu, type VoiceUserMenuTarget } from './VoiceUserMenu.js'
import { useCallChatUi } from './callChatUi.js'
import { snapshotTrack } from './snapshot.js'
import { useCamera } from './useCamera.js'
import { useScreenShare } from './useScreenShare.js'
import { useVoiceRoom } from './useVoiceRoom.js'
import { useVoiceStore, type ParticipantState } from './store.js'

interface VoiceScreenProps {
  serverId: string
  channel: Channel
}

/**
 * Карточка на сцене — либо «лицо» участника, либо его демка (отдельной
 * карточкой, как в Discord). Клик по любой разворачивает её на всю область,
 * остальные уезжают в нижнюю полосу.
 */
interface CardData {
  id: string // userId для лица, `screen:<userId>` для демки
  kind: 'face' | 'screen'
  userId: string
  displayName: string
  avatarUrl: string | null
  muted: boolean
  speaking: boolean
  isSelf: boolean
  serverMuted: boolean
  serverDeafened: boolean
  screenTrack: LocalVideoTrack | RemoteVideoTrack | null
  cameraTrack: LocalVideoTrack | RemoteVideoTrack | null
}

// Секундомер звонка — чисто локальный (от момента join на этом клиенте).
function formatElapsed(totalSeconds: number): string {
  const h = Math.floor(totalSeconds / 3600)
  const m = Math.floor((totalSeconds % 3600) / 60)
  const s = totalSeconds % 60
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${pad(h)}:${pad(m)}:${pad(s)}`
}

// Шапка по designs/final-voice.jsx: Speaker-иконка + имя + LIVE + таймер,
// справа — счётчики эфира и тоггл чата звонка.
function Header({
  channel,
  connected,
  callSeconds,
  peopleCount,
  screenCount,
}: {
  channel: Channel
  connected: boolean
  callSeconds: number
  peopleCount: number
  screenCount: number
}) {
  const chatOpen = useCallChatUi((s) => s.open)
  const toggleChat = useCallChatUi((s) => s.toggle)
  return (
    <div className="px-4 py-2 border-b border-kd-border bg-kd-panel-alt flex items-center gap-2.5 shrink-0">
      <Icon.Speaker size={14} className="text-kd-accent shrink-0" />
      <span className="text-[13px] font-bold text-kd-text shrink-0">{channel.name}</span>
      {connected && <Badge variant="live">LIVE</Badge>}
      {connected && (
        <span className="text-[11px] text-kd-text-soft font-mono shrink-0">
          {formatElapsed(callSeconds)}
        </span>
      )}
      {channel.topic && (
        <>
          <div className="w-px h-3.5 bg-kd-border shrink-0" />
          <span className="text-[11px] text-kd-text-soft truncate">{channel.topic}</span>
        </>
      )}
      <div className="flex-1" />
      <span className="text-[10px] text-kd-text-mute font-mono shrink-0">
        {peopleCount} в эфире
        {screenCount > 0 && ` · ${screenCount} ${screenCount === 1 ? 'экран' : 'экрана'}`}
      </span>
      {connected && (
        <button
          type="button"
          onClick={toggleChat}
          title={chatOpen ? 'скрыть чат звонка' : 'показать чат звонка'}
          className={[
            'inline-flex items-center gap-1 px-2 py-1 rounded text-[10px] font-mono transition-colors border',
            chatOpen
              ? 'bg-kd-panel-hi text-kd-text border-transparent'
              : 'text-kd-text-soft border-kd-border hover:text-kd-text hover:bg-kd-panel-hi',
          ].join(' ')}
        >
          <Icon.Hash size={11} />
          чат
        </button>
      )}
    </div>
  )
}

function JoinCta({ channelName, onJoin, status }: {
  channelName: string
  onJoin(): void
  status: ReturnType<typeof useVoiceStore.getState>['status']
}) {
  const busy = status === 'connecting'
  return (
    <div className="flex-1 flex flex-col items-center justify-center gap-4 px-6">
      <div className="text-kd-text-mute font-mono text-[11px]">голосовой канал</div>
      <div className="text-kd-text text-2xl font-bold">{channelName}</div>
      <button
        type="button"
        onClick={onJoin}
        disabled={busy}
        className={[
          'mt-2 px-6 py-2.5 rounded-kd text-[13px] font-semibold transition-colors',
          busy
            ? 'bg-kd-panel-hi text-kd-text-soft cursor-wait'
            : 'bg-kd-accent text-white hover:opacity-90',
        ].join(' ')}
      >
        {busy ? 'подключаемся…' : 'подключиться'}
      </button>
    </div>
  )
}

const TILE_GAP = 10
const TILE_ASPECT = 16 / 9

/**
 * Подбор раскладки как в Discord: карточки всегда 16:9, перебираем число
 * колонок и берём вариант с максимальной шириной карточки, влезающей в
 * доступную область. Сами карточки центрируются flex-wrap'ом.
 */
function bestTileSize(n: number, areaW: number, areaH: number): { w: number; h: number } {
  let bestW = 0
  for (let cols = 1; cols <= n; cols++) {
    const rows = Math.ceil(n / cols)
    const cellW = (areaW - TILE_GAP * (cols - 1)) / cols
    const cellH = (areaH - TILE_GAP * (rows - 1)) / rows
    if (cellW <= 0 || cellH <= 0) continue
    const w = Math.min(cellW, cellH * TILE_ASPECT)
    if (w > bestW) bestW = w
  }
  if (bestW <= 0) bestW = 160
  return { w: Math.floor(bestW), h: Math.floor(bestW / TILE_ASPECT) }
}

/** Заглушка непросматриваемой демки: тёмная карточка с кнопкой
    «смотреть стрим» (и «смотреть все», если их несколько). */
function UnwatchedStreamTile({
  displayName, compact, othersCount, onWatch, onWatchAll,
}: {
  displayName: string
  compact?: boolean
  othersCount: number
  onWatch(): void
  onWatchAll(): void
}) {
  return (
    <div
      className={`relative w-full h-full rounded-lg overflow-hidden bg-kd-stage flex items-center justify-center ${compact ? 'min-h-[72px]' : 'min-h-[120px]'}`}
      style={{ boxShadow: 'var(--kd-shadow-tile)', background: 'color-mix(in srgb, var(--kd-stage), var(--kd-stage-text) 4%)' }}
    >
      {compact ? (
        <button
          type="button"
          onClick={onWatch}
          title={`смотреть стрим · ${displayName}`}
          className="text-[14px] text-kd-stage-text opacity-70 hover:opacity-100"
        >
          ▶
        </button>
      ) : (
        <div className="flex items-center gap-1.5">
          <button
            type="button"
            onClick={onWatch}
            className="px-3 py-1.5 rounded-kd bg-white/[0.08] hover:bg-white/[0.16] text-kd-stage-text text-[12px] font-semibold transition-colors"
          >
            ▶ смотреть стрим
          </button>
          {othersCount > 0 && (
            <button
              type="button"
              onClick={onWatchAll}
              title={`смотреть все стримы (+${othersCount})`}
              className="w-8 h-8 rounded-kd bg-white/[0.08] hover:bg-white/[0.16] text-kd-stage-text text-[14px] font-mono transition-colors"
            >
              +
            </button>
          )}
        </div>
      )}
      <div className="absolute left-1.5 bottom-1.5 flex items-center gap-1 px-1.5 py-0.5 rounded font-mono bg-kd-overlay-strong text-kd-stage-text max-w-[85%]">
        <span className="text-[10px] font-semibold truncate">{displayName}</span>
        <span className="text-[9px] font-bold text-kd-warm shrink-0">· LIVE</span>
      </div>
    </div>
  )
}

function Card({
  card, compact, focused, snapshotBusy, avatarSize, watchers, unwatchedOthers,
  onClick, onSnapshot, onWatchAll,
}: {
  card: CardData
  compact?: boolean
  focused?: boolean
  snapshotBusy?: boolean
  avatarSize?: number
  watchers?: Array<{ name: string; avatarUrl: string | null }>
  unwatchedOthers?: number
  onClick(): void
  onSnapshot?(): void
  onWatchAll?(): void
}) {
  if (card.kind === 'screen') {
    if (!card.screenTrack) {
      return (
        <UnwatchedStreamTile
          displayName={card.displayName}
          compact={compact}
          othersCount={unwatchedOthers ?? 0}
          onWatch={() => watchScreen(card.userId, true)}
          onWatchAll={() => onWatchAll?.()}
        />
      )
    }
    return (
      <ScreenTile
        displayName={card.displayName}
        isSelf={card.isSelf}
        focused={focused}
        compact={compact}
        busy={snapshotBusy}
        watchers={watchers}
        onClick={onClick}
        onSnapshot={onSnapshot}
        onStopWatching={card.isSelf ? undefined : () => watchScreen(card.userId, false)}
        screenTrack={card.screenTrack}
      />
    )
  }
  return (
    <ParticipantTile
      displayName={card.displayName}
      avatarUrl={card.avatarUrl}
      muted={card.muted}
      speaking={card.speaking}
      isSelf={card.isSelf}
      compact={compact}
      avatarSize={avatarSize}
      cameraTrack={card.cameraTrack}
      onClick={onClick}
    />
  )
}

export function VoiceScreen({ serverId, channel }: VoiceScreenProps) {
  const me = useAuthStore((s) => s.user)
  const { join, leave, toggleMute, toggleDeafen } = useVoiceRoom()
  const { startShare, stopShare } = useScreenShare()
  const { startCamera, stopCamera } = useCamera()

  const activeChannelId = useVoiceStore((s) => s.activeChannelId)
  const status = useVoiceStore((s) => s.status)
  const muted = useVoiceStore((s) => s.muted)
  const screenSharing = useVoiceStore((s) => s.screenSharing)
  const cameraOn = useVoiceStore((s) => s.cameraOn)
  const participants = useVoiceStore((s) => s.participants)
  const activeSpeakers = useVoiceStore((s) => s.activeSpeakers)
  const selfSpeaking = useVoiceStore((s) => s.selfSpeaking)
  const watchedScreens = useVoiceStore((s) => s.watchedScreens)
  const watchingByUser = useVoiceStore((s) => s.watchingByUser)
  const error = useVoiceStore((s) => s.error)
  const setError = useVoiceStore((s) => s.setError)
  const chatOpen = useCallChatUi((s) => s.open)
  const openChat = useCallChatUi((s) => s.setOpen)

  const connectedToThis =
    activeChannelId === channel.id && (status === 'connected' || status === 'reconnecting')

  // VoiceDock'у нужен сервер активного ГС (имя + телепорт). Move между
  // каналами не меняет сервер (бэк валидирует same-server), так что
  // обновление отсюда покрывает все случаи.
  useEffect(() => {
    if (connectedToThis) useVoiceStore.getState().setActiveServerId(serverId)
  }, [connectedToThis, serverId])

  const { data: members = [] } = useQuery({
    queryKey: ['members', serverId],
    queryFn: () => listMembers(serverId),
    staleTime: 60_000,
  })

  const [snapshotBusyId, setSnapshotBusyId] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  // Развёрнутая карточка (id из CardData). null — обычная сетка.
  const [focusedId, setFocusedId] = useState<string | null>(null)
  // ПКМ по карточке — то же меню, что в дереве участников слева.
  const [userMenu, setUserMenu] = useState<
    { x: number; y: number; target: VoiceUserMenuTarget } | null
  >(null)

  // Размер сцены для подбора раскладки 16:9 карточек (см. bestTileSize).
  const stageRef = useRef<HTMLDivElement | null>(null)
  const [stageSize, setStageSize] = useState<{ w: number; h: number } | null>(null)
  useEffect(() => {
    if (!connectedToThis) return
    const el = stageRef.current
    if (!el) return
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0]
      if (entry) setStageSize({ w: entry.contentRect.width, h: entry.contentRect.height })
    })
    observer.observe(el)
    return () => observer.disconnect()
    // focusedId в deps: сетка размонтируется в фокус-режиме, при возврате
    // ref указывает на новый элемент и его надо пере-наблюдать.
  }, [connectedToThis, focusedId])

  // Секундомер звонка: тикаем раз в секунду, пока подключены к этому каналу.
  // connectedToThis покрывает и 'reconnecting' — таймер не сбрасывается на
  // кратких реконнектах.
  const [callSeconds, setCallSeconds] = useState(0)
  useEffect(() => {
    if (!connectedToThis) {
      setCallSeconds(0)
      return
    }
    const startedAt = Date.now()
    setCallSeconds(0)
    const t = setInterval(() => {
      setCallSeconds(Math.floor((Date.now() - startedAt) / 1000))
    }, 1000)
    return () => clearInterval(t)
  }, [connectedToThis])

  useEffect(() => {
    if (!notice) return
    const t = setTimeout(() => setNotice(null), 3000)
    return () => clearTimeout(t)
  }, [notice])

  const memberMap = useMemo(() => {
    const m = new Map<string, MemberPublic>()
    for (const x of members) m.set(x.id, x)
    return m
  }, [members])

  const cards = useMemo<CardData[]>(() => {
    if (!connectedToThis || !me) return []
    const result: CardData[] = []
    const pushBoth = (base: Omit<CardData, 'id' | 'kind'>, streaming: boolean) => {
      // Лицо — всегда; демка — отдельной карточкой следом (как в Discord).
      // У непросматриваемой демки screenTrack null — карточка-заглушка.
      result.push({ ...base, id: base.userId, kind: 'face', screenTrack: null })
      if (streaming) {
        result.push({ ...base, id: `screen:${base.userId}`, kind: 'screen' })
      }
    }
    // Self всегда первый — пользователю важно видеть, что он в эфире.
    // Своё кольцо — ТОЛЬКО локальный измеритель: серверный сигнал (плюс наш
    // 500мс-дебаунс) гаснет на секунды позже и кольцо «залипало».
    // Имя/аватар — из members (серверный профиль, T-107), auth store — только
    // фолбэк: там глобальный профиль без учёта ника на этом сервере.
    const meMember = memberMap.get(me.id)
    pushBoth({
      userId: me.id,
      displayName: meMember?.displayName ?? me.displayName,
      avatarUrl: meMember?.avatarUrl ?? me.avatarUrl ?? null,
      muted,
      speaking: selfSpeaking,
      isSelf: true,
      serverMuted: false,
      serverDeafened: false,
      screenTrack: screenSharing ? getLocalScreenVideoTrack() : null,
      cameraTrack: cameraOn ? getLocalCameraVideoTrack() : null,
    }, screenSharing)
    for (const p of participants.values() as IterableIterator<ParticipantState>) {
      if (p.userId === me.id) continue
      const member = memberMap.get(p.userId)
      pushBoth({
        userId: p.userId,
        // members первичны: LiveKit-имя — снимок на момент джойна и протухает,
        // если участник сменил серверный профиль посреди звонка.
        displayName: member?.displayName || p.displayName || 'участник',
        avatarUrl: member?.avatarUrl ?? null,
        muted: p.isMuted,
        speaking: activeSpeakers.has(p.userId),
        isSelf: false,
        serverMuted: p.serverMuted,
        serverDeafened: p.serverDeafened,
        screenTrack: p.isScreenSharing && watchedScreens.has(p.userId)
          ? getRemoteScreenVideoTrack(p.userId)
          : null,
        cameraTrack: p.isCameraOn ? getRemoteCameraVideoTrack(p.userId) : null,
      }, p.isScreenSharing)
    }
    return result
  }, [connectedToThis, me, muted, screenSharing, cameraOn, participants, activeSpeakers, selfSpeaking, watchedScreens, memberMap])

  // Кто смотрит чью демку: для бейджа на карточке стрима.
  const watchersOf = useMemo(() => {
    const map = new Map<string, Array<{ name: string; avatarUrl: string | null }>>()
    const add = (streamerId: string, watcherId: string) => {
      const m = memberMap.get(watcherId)
      const list = map.get(streamerId) ?? []
      list.push({ name: m?.displayName ?? '?', avatarUrl: m?.avatarUrl ?? null })
      map.set(streamerId, list)
    }
    for (const [watcherId, streamers] of watchingByUser) {
      for (const sid of streamers) add(sid, watcherId)
    }
    if (me) for (const sid of watchedScreens) add(sid, me.id)
    return map
  }, [watchingByUser, watchedScreens, memberMap, me])

  const unwatchedStreamUserIds = useMemo(
    () => cards.filter((c) => c.kind === 'screen' && !c.screenTrack && !c.isSelf).map((c) => c.userId),
    [cards],
  )

  const watchAllStreams = (): void => {
    for (const uid of unwatchedStreamUserIds) watchScreen(uid, true)
  }

  // Если развёрнутая карточка исчезла (вышел / прекратил демо) — в сетку.
  useEffect(() => {
    if (focusedId && !cards.some((c) => c.id === focusedId)) setFocusedId(null)
  }, [cards, focusedId])

  const focusedCard = focusedId ? cards.find((c) => c.id === focusedId) ?? null : null
  const screenCount = useMemo(
    () => cards.reduce((n, c) => (c.kind === 'screen' ? n + 1 : n), 0),
    [cards],
  )

  const onToggleScreenShare = (): void => {
    if (screenSharing) {
      void stopShare()
    } else {
      // `withAudio` берётся внутри startShare из useScreenShareSettings.
      void startShare()
    }
  }

  const onToggleCamera = (): void => {
    if (cameraOn) void stopCamera()
    else void startCamera()
  }

  const onSnapshot = async (card: CardData): Promise<void> => {
    if (!card.screenTrack) return
    // Гонка: пока висит upload — игнорируем повторные клики по этой карточке.
    if (snapshotBusyId === card.id) return
    setSnapshotBusyId(card.id)
    try {
      const blob = await snapshotTrack(card.screenTrack)
      const { publicUrl } = await uploadBlob(blob)
      const alt = `снимок демо · ${card.displayName}`
      // Снимок уходит в чат этого же звонка — он рядом и виден всем в канале.
      await sendMessage(channel.id, {
        content: `![${alt}](${publicUrl})`,
      })
      openChat(true)
      setNotice('снимок отправлен в чат звонка')
    } catch (err) {
      console.warn('[voice] snapshot failed', err)
      setNotice('не удалось отправить снимок')
    } finally {
      setSnapshotBusyId(null)
    }
  }

  const toggleFocus = (id: string): void => {
    setFocusedId((cur) => (cur === id ? null : id))
  }

  const myRole = me ? memberMap.get(me.id)?.role : undefined
  const canManage = myRole === 'owner' || myRole === 'admin'

  const openCardMenu = (e: React.MouseEvent, card: CardData): void => {
    // На себе меню не открываем — свои тумблеры в панели управления.
    if (card.isSelf) return
    e.preventDefault()
    e.stopPropagation()
    const streaming = cards.some((c) => c.kind === 'screen' && c.userId === card.userId)
    setUserMenu({
      x: e.clientX,
      y: e.clientY,
      target: {
        channelId: channel.id,
        userId: card.userId,
        name: card.displayName,
        live: streaming,
        serverMuted: card.serverMuted,
        serverDeafened: card.serverDeafened,
      },
    })
  }

  return (
    <div className="relative flex-1 min-w-0 min-h-0 flex flex-col bg-kd-bg">
      <Header
        channel={channel}
        connected={connectedToThis}
        callSeconds={callSeconds}
        peopleCount={connectedToThis ? cards.filter((c) => c.kind === 'face').length : 0}
        screenCount={connectedToThis ? screenCount : 0}
      />
      {connectedToThis ? (
        <>
          <div className="flex-1 flex min-h-0">
            <div className="flex-1 min-w-0 flex flex-col gap-2 p-3 min-h-0 bg-kd-stage">
              {focusedCard ? (
                <>
                  {/* Развёрнутая карточка занимает всю область */}
                  <div
                    className="flex-1 min-h-0 grid grid-cols-1 grid-rows-1"
                    onContextMenu={(e) => openCardMenu(e, focusedCard)}
                  >
                    <Card
                      card={focusedCard}
                      focused
                      snapshotBusy={snapshotBusyId === focusedCard.id}
                      watchers={focusedCard.kind === 'screen' ? watchersOf.get(focusedCard.userId) : undefined}
                      unwatchedOthers={unwatchedStreamUserIds.length - (focusedCard.screenTrack ? 0 : 1)}
                      onWatchAll={watchAllStreams}
                      onClick={() => toggleFocus(focusedCard.id)}
                      onSnapshot={
                        focusedCard.kind === 'screen'
                          ? () => { void onSnapshot(focusedCard) }
                          : undefined
                      }
                    />
                  </div>
                  {/* Остальные — в нижней полосе */}
                  {cards.length > 1 && (
                    /* p-[3px] — чтобы speaking-кольцо не резалось скролл-боксом */
                    <div className="flex gap-2 shrink-0 overflow-x-auto h-[82px] p-[3px]">
                      {cards.filter((c) => c.id !== focusedCard.id).map((c) => (
                        <div
                          key={c.id}
                          className="w-[132px] shrink-0"
                          onContextMenu={(e) => openCardMenu(e, c)}
                        >
                          <Card card={c} compact onClick={() => toggleFocus(c.id)} />
                        </div>
                      ))}
                    </div>
                  )}
                </>
              ) : (
                <div
                  ref={stageRef}
                  // Без overflow-hidden: speaking-кольцо (box-shadow) рисуется
                  // на 2px снаружи карточки и резалось на краях сетки.
                  className="flex-1 min-h-0 flex flex-wrap content-center justify-center"
                  style={{ gap: TILE_GAP }}
                >
                  {(() => {
                    // −6px с каждой стороны — запас под кольцо.
                    const size = stageSize
                      ? bestTileSize(cards.length, stageSize.w - 6, stageSize.h - 6)
                      : { w: 320, h: 180 }
                    const avatarSize = Math.max(36, Math.min(88, Math.round(size.h * 0.42)))
                    return cards.map((c) => (
                      <div
                        key={c.id}
                        style={{ width: size.w, height: size.h }}
                        onContextMenu={(e) => openCardMenu(e, c)}
                      >
                        <Card
                          card={c}
                          avatarSize={avatarSize}
                          snapshotBusy={snapshotBusyId === c.id}
                          watchers={c.kind === 'screen' ? watchersOf.get(c.userId) : undefined}
                          unwatchedOthers={
                            c.kind === 'screen' && !c.screenTrack
                              ? unwatchedStreamUserIds.length - 1
                              : 0
                          }
                          onWatchAll={watchAllStreams}
                          onClick={() => toggleFocus(c.id)}
                          onSnapshot={
                            c.kind === 'screen' ? () => { void onSnapshot(c) } : undefined
                          }
                        />
                      </div>
                    ))
                  })()}
                </div>
              )}
            </div>
            {chatOpen && <VoiceCallChat serverId={serverId} channelId={channel.id} />}
          </div>
          <VoiceControls
            onToggleMute={() => { void toggleMute() }}
            onToggleDeafen={() => { void toggleDeafen() }}
            onToggleCamera={onToggleCamera}
            onToggleScreenShare={onToggleScreenShare}
            onLeave={() => { void leave() }}
          />
        </>
      ) : (
        <JoinCta
          channelName={channel.name}
          status={status}
          onJoin={() => { void join(channel.id) }}
        />
      )}
      {error === 'no-mic-permission' && (
        <MicPermissionDialog onDismiss={() => setError(null)} />
      )}
      {notice && (
        <div className="absolute left-1/2 -translate-x-1/2 bottom-16 px-3 py-1.5 rounded-kd text-[12px] font-medium bg-kd-accent text-white shadow-kd-tile">
          {notice}
        </div>
      )}
      {userMenu && (
        <VoiceUserMenu
          x={userMenu.x}
          y={userMenu.y}
          target={userMenu.target}
          canManage={canManage}
          onClose={() => setUserMenu(null)}
        />
      )}
    </div>
  )
}
