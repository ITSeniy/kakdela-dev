import { useCallback } from 'react'
import { Track } from 'livekit-client'
import type { Room } from 'livekit-client'

import type { VoiceParticipantsResponse } from '@kakdela/ginzu/api-types'

import { ApiError } from '../../lib/api.js'
import {
  applyDeafenVolume,
  createAndConnectRoom,
  disposeRoom,
  disposeVoiceRoom,
  getActiveRoom,
  installVoiceRoom,
} from '../../lib/livekit.js'
import { queryClient } from '../../lib/query.js'
import { useAuthStore } from '../auth/store.js'
import { playSound } from '../sounds/sounds.js'
import { joinDmVoice, joinVoiceChannel, leaveDmVoice, leaveVoiceChannel, reportVoiceState } from './api.js'
import { useVoiceInputSettings } from './inputSettings.js'
import { audioCaptureOptions } from './noiseSettings.js'
import { useVoiceStore } from './store.js'

export interface DmCallPeer {
  id: string
  name: string
  avatarUrl: string | null
}

export interface UseVoiceRoom {
  join(channelId: string): Promise<void>
  joinDm(channelId: string, peer: DmCallPeer): Promise<void>
  leave(): Promise<void>
  toggleMute(): Promise<void>
  toggleDeafen(): Promise<void>
}

// Куда подключаемся: серверный голос-канал или личный звонок (T-087). От этого
// зависят join/leave-эндпоинты и контекст в store (шапка/док/тост).
// silent — не играть 'voice-join' по подключении: у программных переходов
// (админ перенёс) свой звук, и они смешивались.
type JoinTarget =
  | { kind: 'channel'; channelId: string; silent?: boolean }
  | { kind: 'dm'; channelId: string; peer: DmCallPeer }

function leaveForTarget(target: JoinTarget): Promise<void> {
  return target.kind === 'dm'
    ? leaveDmVoice(target.channelId)
    : leaveVoiceChannel(target.channelId)
}

// Все mutating-операции с комнатой (join/leave) проходят через один queue
// и нумеруются последовательно. Это даёт два свойства:
//   1) `join(A)` и `join(B)` не запускают параллельные `room.connect` —
//      они стоят в очереди.
//   2) Любая «устаревшая» операция (joinSeq уже двинулся вперёд из-за
//      нового join/leave) на каждом checkpoint бросает работу и убирает
//      за собой свою in-flight Room, не трогая глобальные.
// Toggle-actions (mute/deafen) идемпотентны и не вызывают сетевых
// операций — их сериализовать не нужно.
let joinSequence = 0
let opQueue: Promise<void> = Promise.resolve()

function enqueueVoiceOp(action: () => Promise<void>): Promise<void> {
  opQueue = opQueue.catch(() => {}).then(action)
  return opQueue
}

/**
 * Голосовая сессия должна переживать переключение текстовых каналов в шелле,
 * поэтому хук — это просто связка экшенов без собственного эффекта. Можно
 * вызывать из любого компонента, они все увидят один Room и один store.
 *
 * Подключение явное — VoiceScreen рендерит CTA «Подключиться», который дёргает
 * join(channelId). Авто-джойн на смену URL'а сломал бы UX (пользователь зашёл
 * посмотреть, кто там — и сразу попал в эфир).
 */
/**
 * Подключение к голосовому каналу без React-контекста — для voice.moved
 * (админ перенёс) и прочих программных переходов. Та же очередь, что у
 * hook-версии join.
 */
export function joinVoiceRoom(channelId: string, opts?: { silent?: boolean }): Promise<void> {
  // Бампаем seq СИНХРОННО — чтобы любая уже-стоящая в очереди операция
  // прочитала актуальный «победитель», ещё не дойдя до своей работы.
  const seq = ++joinSequence
  return enqueueVoiceOp(() => runJoin({ kind: 'channel', channelId, silent: opts?.silent }, seq))
}

/** Подключиться к личному звонку (T-087) — та же очередь, что у join канала. */
export function joinDmCall(channelId: string, peer: DmCallPeer): Promise<void> {
  const seq = ++joinSequence
  return enqueueVoiceOp(() => runJoin({ kind: 'dm', channelId, peer }, seq))
}

export function useVoiceRoom(): UseVoiceRoom {
  const join = useCallback((channelId: string) => joinVoiceRoom(channelId), [])
  const joinDm = useCallback(
    (channelId: string, peer: DmCallPeer) => joinDmCall(channelId, peer),
    [],
  )
  const leave = useCallback(() => leaveVoiceRoom(), [])
  const toggleMute = useCallback(() => toggleMuteVoice(), [])
  const toggleDeafen = useCallback(() => toggleDeafenVoice(), [])
  return { join, joinDm, leave, toggleMute, toggleDeafen }
}

/** Fire-and-forget репорт своего mute-тумблера серверу — для иконок в
    сайдбаре у тех, кто вне канала (в DM-звонке некому вещать). */
export function reportSelfMuted(muted: boolean): void {
  const { activeChannelId, activeContext } = useVoiceStore.getState()
  if (!activeChannelId || activeContext === 'dm') return
  reportVoiceState(activeChannelId, muted).catch(() => {})
}

/**
 * Тоггл микрофона без React-контекста — кнопки UI и горячие клавиши
 * (features/voice/hotkeys.ts) дёргают одну и ту же функцию.
 */
export async function toggleMuteVoice(): Promise<void> {
  // В PTT режиме mute-кнопка отключена — мик управляется только клавишей,
  // чтобы поведение было предсказуемым (см. T-035 hint).
  if (useVoiceInputSettings.getState().inputMode === 'push-to-talk') return
  // Серверный мьют снимает только админ.
  if (useVoiceStore.getState().forcedMuted) return

  const room = getActiveRoom()
  const { muted, deafened, setMuted, setDeafened } = useVoiceStore.getState()
  const nextMuted = !muted
  setMuted(nextMuted)
  reportSelfMuted(nextMuted)
  playSound(nextMuted ? 'mute-on' : 'mute-off')
  if (deafened && !nextMuted) {
    setDeafened(false)
    applyDeafenVolume(room, false)
  }
  if (room) {
    try {
      await room.localParticipant.setMicrophoneEnabled(!nextMuted, audioCaptureOptions())
    } catch (err) {
      const name = err instanceof Error ? err.name : ''
      const code = name === 'NotAllowedError' ? 'no-mic-permission' : 'mic-toggle-failed'
      useVoiceStore.getState().setError(code)
    }
  }
}

/** Тоггл наушников (deafen) без React-контекста — см. toggleMuteVoice. */
export async function toggleDeafenVoice(): Promise<void> {
  // Серверный deafen снимает только админ.
  if (useVoiceStore.getState().forcedDeafened) return
  const room = getActiveRoom()
  const {
    deafened, muted, mutedBeforeDeafen,
    setDeafened, setMuted, setMutedBeforeDeafen,
  } = useVoiceStore.getState()
  const nextDeafened = !deafened
  setDeafened(nextDeafened)
  playSound(nextDeafened ? 'deafen-on' : 'deafen-off')
  applyDeafenVolume(room, nextDeafened)
  if (nextDeafened) {
    // Запоминаем, был ли мик заглушен ДО deafen: un-deafen вернёт как было.
    setMutedBeforeDeafen(muted)
    if (!muted) {
      setMuted(true)
      reportSelfMuted(true)
      if (room) {
        try {
          await room.localParticipant.setMicrophoneEnabled(false)
        } catch (err) {
          console.warn('[voice] mic disable failed on deafen', err)
        }
      }
    }
  } else if (
    !mutedBeforeDeafen && muted
    // В PTT миком управляет только клавиша — un-deafen его не трогает.
    && useVoiceInputSettings.getState().inputMode !== 'push-to-talk'
  ) {
    // Глушили только наушниками — включаем мик обратно. Если мик был
    // заглушен отдельно до deafen — оставляем заглушенным.
    setMuted(false)
    reportSelfMuted(false)
    if (room) {
      try {
        await room.localParticipant.setMicrophoneEnabled(true, audioCaptureOptions())
      } catch (err) {
        const name = err instanceof Error ? err.name : ''
        const code = name === 'NotAllowedError' ? 'no-mic-permission' : 'mic-toggle-failed'
        useVoiceStore.getState().setError(code)
      }
    }
  }
}

/**
 * Завершает голосовую сессию из любого места приложения — logout, навигация,
 * `beforeunload`. Не требует React-контекста. Идёт через ту же очередь, что
 * и `join`, поэтому надёжно прерывает любой in-flight join.
 */
export function leaveVoiceRoom(): Promise<void> {
  joinSequence += 1
  return enqueueVoiceOp(() => runLeave())
}

/**
 * Повторная попытка опубликовать микрофон — используется из MicPermission
 * диалога после того, как пользователь дал разрешение в системных
 * настройках. Возвращает true если удалось, иначе сохраняет error и
 * возвращает false (диалог остаётся открытым).
 */
export async function retryMicrophone(): Promise<boolean> {
  const room = getActiveRoom()
  if (!room) {
    useVoiceStore.getState().setError('no-active-room')
    return false
  }
  try {
    await room.localParticipant.setMicrophoneEnabled(true, audioCaptureOptions())
    useVoiceStore.getState().setMuted(false)
    reportSelfMuted(false)
    useVoiceStore.getState().setError(null)
    return true
  } catch (err) {
    const name = err instanceof Error ? err.name : ''
    const code = name === 'NotAllowedError' ? 'no-mic-permission' : 'mic-publish-failed'
    useVoiceStore.getState().setError(code)
    return false
  }
}

async function runJoin(target: JoinTarget, seq: number): Promise<void> {
  if (seq !== joinSequence) return

  const { channelId } = target

  // Если до нас была активная комната — закрываем перед новым подключением.
  if (useVoiceStore.getState().activeChannelId) {
    await teardownActive()
    if (seq !== joinSequence) return
  }

  const s = useVoiceStore.getState()
  s.setActiveChannelId(channelId)
  s.setActiveContext(target.kind)
  s.setActiveDmPeer(target.kind === 'dm' ? target.peer : null)
  s.setStatus('connecting')
  s.setError(null)

  let joinResponse
  try {
    joinResponse = target.kind === 'dm'
      ? await joinDmVoice(channelId)
      : await joinVoiceChannel(channelId)
  } catch (err) {
    if (seq === joinSequence) {
      const code =
        err instanceof ApiError ? err.code : err instanceof Error ? err.message : 'join-failed'
      useVoiceStore.getState().setError(code)
      useVoiceStore.getState().setStatus('failed')
      useVoiceStore.getState().setActiveChannelId(null)
    }
    return
  }
  if (seq !== joinSequence) {
    void leaveForTarget(target).catch(() => {})
    return
  }

  // Предварительный snapshot — чтобы UI показал peer'ов до того, как
  // LiveKit договорится handshake. После install мы пересоберём список
  // из room.remoteParticipants (это уже после `room.connect()` resolve'а).
  useVoiceStore.getState().applySnapshot(joinResponse.participants)

  // Сидируем и кэш сайдбара (['voiceParticipants']): свой voice.join придёт
  // только через вебхук LiveKit → speedy → WS, а до/без него зашедший не
  // видел бы ни себя, ни остальных под каналом. Снапшот из ответа /join
  // свежий (сервер берёт его напрямую из LiveKit), себя дописываем сами —
  // на момент запроса мы к LiveKit ещё не подключены.
  if (target.kind === 'channel') {
    const me = useAuthStore.getState().user
    const participants = joinResponse.participants.filter((p) => p.userId !== me?.id)
    if (me) {
      participants.push({
        userId: me.id,
        displayName: me.displayName,
        isScreenSharing: false,
        isMuted: useVoiceStore.getState().muted,
        serverMuted: false,
        serverDeafened: false,
      })
    }
    queryClient.setQueryData<VoiceParticipantsResponse>(
      ['voiceParticipants', channelId],
      { participants },
    )
  }

  let room: Room
  try {
    room = await createAndConnectRoom({
      url: joinResponse.url,
      token: joinResponse.token,
    })
  } catch (err) {
    if (seq === joinSequence) {
      const code = err instanceof Error ? err.message : 'connect-failed'
      useVoiceStore.getState().setError(code)
      useVoiceStore.getState().setStatus('failed')
    }
    return
  }
  if (seq !== joinSequence) {
    // Поздно — успели отменить. Аккуратно сворачиваем эту orphan-комнату,
    // не трогая глобальное state (мы там и не успели стать «активными»).
    await disposeRoom(room)
    void leaveForTarget(target).catch(() => {})
    return
  }

  installVoiceRoom(room)

  const { muted, deafened } = useVoiceStore.getState()
  const { inputMode } = useVoiceInputSettings.getState()
  // PTT режим: всё равно публикуем mic-трек, чтобы unmute по клавише
  // занимал ~10ms, а не ~100ms re-publish. Сразу выключаем — пользователь
  // включит через зажатие.
  const shouldPublish = inputMode === 'push-to-talk' || (!muted && !deafened)
  if (shouldPublish) {
    try {
      await room.localParticipant.setMicrophoneEnabled(true, audioCaptureOptions())
    } catch (err) {
      const name = err instanceof Error ? err.name : ''
      const code = name === 'NotAllowedError' ? 'no-mic-permission' : 'mic-publish-failed'
      useVoiceStore.getState().setError(code)
      useVoiceStore.getState().setMuted(true)
    }
  }
  if (inputMode === 'push-to-talk') {
    await muteMicPublication(room)
    useVoiceStore.getState().setMuted(true)
    useVoiceStore.getState().setPttHolding(false)
  }
  // Всегда: deafen глушит всех, а ещё применяются персистнутые локальные мьюты.
  applyDeafenVolume(room, deafened)

  // Между mic-publish'ом и сюда тоже могли отменить — финальный check.
  if (seq !== joinSequence) {
    await disposeRoom(room)
    void leaveForTarget(target).catch(() => {})
    return
  }

  useVoiceStore.getState().setStatus('connected')
  if (!(target.kind === 'channel' && target.silent)) playSound('voice-join')
}

async function runLeave(): Promise<void> {
  const wasConnected = useVoiceStore.getState().activeChannelId !== null
  await teardownActive()
  if (wasConnected) playSound('voice-leave')
}

async function teardownActive(): Promise<void> {
  const { activeChannelId, activeContext } = useVoiceStore.getState()
  await disposeVoiceRoom()
  useVoiceStore.getState().reset()
  if (activeChannelId) {
    // Мгновенно убираем себя из сайдбар-кэша покинутого канала. voice.leave
    // придёт вебхуком LiveKit, но он может опоздать или потеряться (напр.,
    // clock-skew docker-VM) — тогда под старым каналом остаётся призрак.
    if (activeContext !== 'dm') {
      const me = useAuthStore.getState().user
      if (me) {
        queryClient.setQueryData<VoiceParticipantsResponse>(
          ['voiceParticipants', activeChannelId],
          (old) => old
            ? { participants: old.participants.filter((p) => p.userId !== me.id) }
            : old,
        )
      }
    }
    const leave = activeContext === 'dm'
      ? leaveDmVoice(activeChannelId)
      : leaveVoiceChannel(activeChannelId)
    leave.catch(() => {})
  }
}

async function muteMicPublication(room: Room): Promise<void> {
  const pub = room.localParticipant.getTrackPublication(Track.Source.Microphone)
  if (pub?.track) {
    try { await pub.mute() } catch (err) { console.warn('[voice] mic mute failed', err) }
  }
}
