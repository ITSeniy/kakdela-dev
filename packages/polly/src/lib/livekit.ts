import {
  ConnectionQuality,
  ConnectionState,
  LocalAudioTrack,
  LocalParticipant,
  LocalTrack,
  LocalTrackPublication,
  LocalVideoTrack,
  Participant,
  RemoteParticipant,
  RemoteTrack,
  RemoteTrackPublication,
  RemoteVideoTrack,
  Room,
  RoomEvent,
  Track,
  TrackPublication,
} from 'livekit-client'
import type { AudioCaptureOptions } from 'livekit-client'

import { playSound } from '../features/sounds/sounds.js'
import { useAudioDevices } from '../features/voice/deviceSettings.js'
import { useLocalMute } from '../features/voice/localMute.js'
import { useVoiceStore } from '../features/voice/store.js'
import { useVoiceVolumes, volumesFor } from '../features/voice/volumeSettings.js'

// «Активная» комната — на которую подписан UI. Не singleton в строгом смысле:
// возможны короткоживущие «сироты» во время гонок join/join (свежий join
// успел отменить старый раньше, чем тот успел поставить себя активным).
// Такие сироты дисконнектятся через disposeRoom(orphan) и в currentRoom не
// попадают.
let currentRoom: Room | null = null
let audioContainer: HTMLDivElement | null = null
const attachedAudioElements = new Map<string, HTMLMediaElement>()

// ───── Identity ↔ userId (мульти-девайс, аудит 2026-08 C-2) ─────
//
// LiveKit identity = `userId` или `userId:deviceId`: два устройства одного
// аккаунта — два участника комнаты, а не «второй выбил первого». Весь voice-
// store при этом ключуется ЧИСТЫМ userId — устройства одного человека
// склеиваются в один тайл, а профили/аватары/модерация матчатся как раньше.

export function userIdFromIdentity(identity: string): string {
  const i = identity.indexOf(':')
  return i === -1 ? identity : identity.slice(0, i)
}

/** Remote-participant по чистому userId (identity может иметь суффикс :deviceId). */
function findRemoteByUserId(room: Room, userId: string): RemoteParticipant | undefined {
  for (const p of room.remoteParticipants.values()) {
    if (userIdFromIdentity(p.identity) === userId) return p
  }
  return undefined
}

// ───── Буст громкости выше 100% ─────
//
// HTMLMediaElement.volume ограничен диапазоном [0,1] — присвоение вне него
// кидает IndexSizeError. Для 100-200% прогоняем сырой MediaStream через
// GainNode (гейн умеет любое значение) и отдаём результат ТОМУ ЖЕ audio-
// элементу — sink (setSinkId), уже назначенный на него, продолжает
// действовать, поэтому выбор колонок не ломается. Ниже 100% остаёмся на
// обычном el.volume — дешевле и не тратит лишний AudioContext на участника.
interface VolumeBoost {
  ctx: AudioContext
  source: MediaStreamAudioSourceNode
  gain: GainNode
  dest: MediaStreamAudioDestinationNode
  rawStream: MediaStream
}
const volumeBoosts = new Map<string, VolumeBoost>()

function teardownVolumeBoost(sid: string, el: HTMLMediaElement): void {
  const boost = volumeBoosts.get(sid)
  if (!boost) return
  volumeBoosts.delete(sid)
  el.srcObject = boost.rawStream
  void el.play().catch(() => { /* ignore */ })
  try { boost.source.disconnect(); boost.gain.disconnect() } catch { /* ignore */ }
  void boost.ctx.close().catch(() => { /* ignore */ })
}

/** Громкость 0..2 (0-200%) для audio-элемента с треком `sid`. */
function setElementVolume(sid: string, el: HTMLMediaElement, volume: number): void {
  if (volume <= 1) {
    teardownVolumeBoost(sid, el)
    el.volume = Math.max(0, volume)
    return
  }
  let boost = volumeBoosts.get(sid)
  if (!boost) {
    const rawStream = el.srcObject as MediaStream
    const ctx = new AudioContext()
    const source = ctx.createMediaStreamSource(rawStream)
    const gain = ctx.createGain()
    const dest = ctx.createMediaStreamDestination()
    source.connect(gain)
    gain.connect(dest)
    boost = { ctx, source, gain, dest, rawStream }
    volumeBoosts.set(sid, boost)
    el.srcObject = dest.stream
    el.volume = 1
    void el.play().catch(() => { /* ignore */ })
  }
  boost.gain.gain.setTargetAtTime(volume, boost.ctx.currentTime, 0.1)
}

// ───── Нативный screen-audio (T-094 Stage C) ─────
//
// Кастомный аудио-трек, опубликованный как ScreenShareAudio из нативного WASAPI-
// захвата. Держим хэндл, чтобы корректно снять трек (unpublish + стоп Rust-стрима)
// при stopShare, остановке демки из ОС-бара (LocalTrackUnpublished) и выходе из
// комнаты (disposeRoom). Живёт здесь, где владеем жизненным циклом комнаты;
// useScreenShare лишь регистрирует хэндл после публикации.
let nativeScreenAudio: { stop: () => Promise<void> } | null = null

/** Зарегистрировать активный нативный screen-audio (его stop вызовут при teardown). */
export function registerNativeScreenAudio(handle: { stop: () => Promise<void> }): void {
  nativeScreenAudio = handle
}

/** Снять нативный screen-audio, если есть. Идемпотентно. */
export async function stopNativeScreenAudio(): Promise<void> {
  const handle = nativeScreenAudio
  nativeScreenAudio = null
  if (handle) {
    try {
      await handle.stop()
    } catch (err) {
      console.warn('[livekit] native screen audio stop failed', err)
    }
  }
}

// ───── Локальный измеритель «я говорю» ─────
//
// Серверный ActiveSpeakersChanged приходит с задержкой ~300-500ms — своё
// кольцо должно загораться мгновенно. Меряем RMS прямо с локального
// мик-трека через WebAudio; замьюченный трек отдаёт тишину, так что mute
// и PTT гасят кольцо сами собой.
const SELF_SPEAKING_RMS = 0.04
const SELF_SPEAKING_HOLD_MS = 300

let speakingMeterStop: (() => void) | null = null

function startLocalSpeakingMeter(msTrack: MediaStreamTrack): void {
  stopLocalSpeakingMeter()
  let ctx: AudioContext
  try {
    ctx = new AudioContext()
  } catch {
    return // нет WebAudio — остаёмся на серверном сигнале
  }
  const source = ctx.createMediaStreamSource(new MediaStream([msTrack]))
  const analyser = ctx.createAnalyser()
  analyser.fftSize = 512
  source.connect(analyser)
  const data = new Uint8Array(analyser.fftSize)
  let raf = 0
  let lastAbove = 0
  const loop = () => {
    analyser.getByteTimeDomainData(data)
    let sum = 0
    for (let i = 0; i < data.length; i++) {
      const v = ((data[i] ?? 128) - 128) / 128
      sum += v * v
    }
    const rms = Math.sqrt(sum / data.length)
    const now = performance.now()
    if (rms > SELF_SPEAKING_RMS) lastAbove = now
    useVoiceStore.getState().setSelfSpeaking(now - lastAbove < SELF_SPEAKING_HOLD_MS)
    raf = requestAnimationFrame(loop)
  }
  raf = requestAnimationFrame(loop)
  speakingMeterStop = () => {
    cancelAnimationFrame(raf)
    try { source.disconnect() } catch { /* ignore */ }
    void ctx.close().catch(() => { /* ignore */ })
    useVoiceStore.getState().setSelfSpeaking(false)
  }
}

function stopLocalSpeakingMeter(): void {
  speakingMeterStop?.()
  speakingMeterStop = null
}

// ───── Программное усиление микрофона ─────
//
// LiveKit-процессор: source → GainNode → destination, processedTrack уходит
// в эфир. Ставится только при gain ≠ 1; слайдер обновляет узел напрямую.
let micGainNode: GainNode | null = null

function makeMicGainProcessor() {
  let ctx: AudioContext | null = null
  let src: MediaStreamAudioSourceNode | null = null
  const proc = {
    name: 'kd-mic-gain',
    processedTrack: undefined as MediaStreamTrack | undefined,
    async init(opts: { track: MediaStreamTrack; audioContext?: AudioContext }) {
      ctx = opts.audioContext ?? new AudioContext()
      src = ctx.createMediaStreamSource(new MediaStream([opts.track]))
      micGainNode = ctx.createGain()
      micGainNode.gain.value = useAudioDevices.getState().micGain
      const dest = ctx.createMediaStreamDestination()
      src.connect(micGainNode)
      micGainNode.connect(dest)
      proc.processedTrack = dest.stream.getAudioTracks()[0]
    },
    async restart(opts: { track: MediaStreamTrack; audioContext?: AudioContext }) {
      await proc.destroy()
      await proc.init(opts)
    },
    async destroy() {
      try { src?.disconnect() } catch { /* ignore */ }
      try { micGainNode?.disconnect() } catch { /* ignore */ }
      micGainNode = null
      proc.processedTrack = undefined
    },
  }
  return proc
}

/** Применяет текущее усиление к живому мик-треку: обновляет узел либо
    ставит/снимает процессор. Без поддержки setProcessor — тихий no-op. */
export async function applyMicGainLive(): Promise<void> {
  const room = currentRoom
  if (!room) return
  const track = room.localParticipant.getTrackPublication(Track.Source.Microphone)?.track
  if (!(track instanceof LocalAudioTrack)) return
  const gain = useAudioDevices.getState().micGain

  if (micGainNode) {
    if (Math.abs(gain - 1) < 0.01) {
      const stop = (track as unknown as { stopProcessor?: () => Promise<void> }).stopProcessor
      try { await stop?.call(track) } catch { /* ignore */ }
      micGainNode = null
    } else {
      micGainNode.gain.value = gain
    }
    return
  }
  if (Math.abs(gain - 1) < 0.01) return
  const setProcessor = (track as unknown as {
    setProcessor?: (p: ReturnType<typeof makeMicGainProcessor>) => Promise<void>
  }).setProcessor
  if (typeof setProcessor !== 'function') return
  try {
    await setProcessor.call(track, makeMicGainProcessor())
  } catch (err) {
    console.warn('[livekit] mic gain processor failed', err)
  }
}

// ───── Opt-in просмотр стримов ─────
//
// Демки не грузятся сами: при публикации чужого screen-трека подписка
// снимается, пока пользователь не нажмёт «смотреть стрим». Кто что смотрит —
// разлетается data-сообщениями {t:'kd-watch'} и живёт в voice store.
const dataEncoder = new TextEncoder()
const dataDecoder = new TextDecoder()

function isScreenSource(source: Track.Source): boolean {
  return source === Track.Source.ScreenShare || source === Track.Source.ScreenShareAudio
}

function applyScreenSubscription(p: RemoteParticipant): void {
  const watched = useVoiceStore.getState().watchedScreens.has(userIdFromIdentity(p.identity))
  for (const pub of p.trackPublications.values()) {
    if (!isScreenSource(pub.source)) continue
    void (pub as RemoteTrackPublication).setSubscribed(watched)
  }
}

/**
 * Временная подписка на чужую демку для hover-превью (как в Discord): тянем
 * ТОЛЬКО видео (без ScreenShareAudio — звук на наведении не нужен), не трогаем
 * watchedScreens и не рассылаем «кто смотрит». adaptiveStream сам отдаст
 * низкий layer под маленький <video>. Выключение не снимает подписку, если
 * пользователь реально смотрит этот стрим.
 */
export function setScreenPreview(userId: string, on: boolean): void {
  const room = currentRoom
  if (!room) return
  const p = findRemoteByUserId(room, userId)
  if (!p) return
  const watched = useVoiceStore.getState().watchedScreens.has(userId)
  for (const pub of p.trackPublications.values()) {
    if (pub.source !== Track.Source.ScreenShare) continue
    const rp = pub as RemoteTrackPublication
    if (on) void rp.setSubscribed(true)
    else if (!watched) void rp.setSubscribed(false)
  }
}

/** Смотреть/перестать смотреть демку участника. */
export function watchScreen(userId: string, watch: boolean): void {
  useVoiceStore.getState().setWatchedScreen(userId, watch)
  const room = currentRoom
  if (!room) return
  const p = findRemoteByUserId(room, userId)
  if (p) applyScreenSubscription(p)
  broadcastWatching(room)
}

/** Рассылает мой список просматриваемых демок (для бейджей «кто смотрит»). */
function broadcastWatching(room: Room): void {
  const watching = [...useVoiceStore.getState().watchedScreens]
  const payload = dataEncoder.encode(JSON.stringify({ t: 'kd-watch', watching }))
  void room.localParticipant.publishData(payload, { reliable: true }).catch(() => { /* ignore */ })
}

function ensureAudioContainer(): HTMLDivElement {
  if (audioContainer && audioContainer.isConnected) return audioContainer
  const div = document.createElement('div')
  div.dataset.kdRole = 'voice-audio-sink'
  div.style.cssText = 'position:absolute;width:0;height:0;overflow:hidden;'
  document.body.appendChild(div)
  audioContainer = div
  return div
}

function removeAudioContainer(): void {
  if (audioContainer) {
    audioContainer.remove()
    audioContainer = null
  }
}

function attachAudio(track: RemoteTrack): void {
  if (track.kind !== Track.Kind.Audio) return
  const sid = track.sid
  if (!sid) return
  if (attachedAudioElements.has(sid)) return
  const el = track.attach() as HTMLMediaElement
  el.autoplay = true
  el.dataset.kdTrackSid = sid
  ensureAudioContainer().appendChild(el)
  attachedAudioElements.set(sid, el)
  void applySinkTo(el)
}

/** Назначает выбранный динамик audio-элементу (setSinkId, Chromium). */
async function applySinkTo(el: HTMLMediaElement): Promise<void> {
  const speakerId = useAudioDevices.getState().speakerId
  const sink = (el as HTMLMediaElement & { setSinkId?: (id: string) => Promise<void> }).setSinkId
  if (typeof sink !== 'function') return
  try {
    await sink.call(el, speakerId === 'default' ? '' : speakerId)
  } catch (err) {
    console.warn('[livekit] setSinkId failed', err)
  }
}

/** Переназначает динамик всем уже играющим audio-элементам. */
export async function applySpeakerDevice(): Promise<void> {
  await Promise.all([...attachedAudioElements.values()].map((el) => applySinkTo(el)))
}

function detachAudio(track: RemoteTrack): void {
  if (track.kind !== Track.Kind.Audio) return
  const sid = track.sid
  if (!sid) return
  const el = attachedAudioElements.get(sid)
  if (el) {
    teardownVolumeBoost(sid, el)
    try { track.detach(el) } catch { /* SDK already detached */ }
    el.remove()
    attachedAudioElements.delete(sid)
  } else {
    try { track.detach() } catch { /* nothing was attached */ }
  }
}

function clearAllAttachedAudio(): void {
  for (const [sid, el] of attachedAudioElements) teardownVolumeBoost(sid, el)
  for (const el of attachedAudioElements.values()) el.remove()
  attachedAudioElements.clear()
}

// ───── Диагностика качества соединения ─────
//
// Чтобы при жалобах «рассыпается» не гадать «сеть / сервер / энкод» — держим
// последний ConnectionQuality по каждому участнику и умеем по запросу снять
// RTCStatsReport с локальных треков. collectVoiceStats() удобно дёрнуть прямо
// из DevTools во время реального звонка (в dev доступна как window.kdVoiceStats):
// packetsLost/jitter/rtt говорят про сеть, qualityLimitationReason —
// 'bandwidth' = упор в исходящую полосу VPS, 'cpu' = в энкодер.
const connectionQuality = new Map<string, ConnectionQuality>()

/** Последний известный ConnectionQuality участника (или свой, по identity). */
export function getConnectionQuality(identity: string): ConnectionQuality | undefined {
  return connectionQuality.get(identity)
}

export interface VoiceRtpStat {
  source: string
  kind: string
  packetsLost?: number
  jitter?: number
  roundTripTime?: number
  qualityLimitationReason?: string
}

/**
 * Снимок RTP-статистики локальных публикаций (мик + демка) для ручной
 * диагностики. По записи на трек: потери/джиттер/RTT берём из remote-inbound-rtp
 * (что реально видит получатель), qualityLimitationReason — из outbound-rtp.
 */
export async function collectVoiceStats(): Promise<VoiceRtpStat[]> {
  const room = currentRoom
  if (!room) return []
  const out: VoiceRtpStat[] = []
  for (const pub of room.localParticipant.trackPublications.values()) {
    const track = pub.track
    if (!(track instanceof LocalTrack)) continue
    const report = await track.getRTCStatsReport().catch(() => undefined)
    if (!report) continue
    const stat: VoiceRtpStat = { source: pub.source, kind: track.kind }
    report.forEach((raw) => {
      const e = raw as {
        type?: string
        qualityLimitationReason?: unknown
        packetsLost?: unknown
        jitter?: unknown
        roundTripTime?: unknown
      }
      if (e.type === 'outbound-rtp' && typeof e.qualityLimitationReason === 'string') {
        stat.qualityLimitationReason = e.qualityLimitationReason
      } else if (e.type === 'remote-inbound-rtp') {
        if (typeof e.packetsLost === 'number') stat.packetsLost = e.packetsLost
        if (typeof e.jitter === 'number') stat.jitter = e.jitter
        if (typeof e.roundTripTime === 'number') stat.roundTripTime = e.roundTripTime
      }
    })
    out.push(stat)
  }
  return out
}

export function getActiveRoom(): Room | null {
  return currentRoom
}

/**
 * Возвращает локальный screen-share video track, если мы сейчас транслируем.
 * Используется ParticipantTile для self-preview — attach к <video>.
 */
export function getLocalScreenVideoTrack(): LocalVideoTrack | null {
  if (!currentRoom) return null
  const pub = currentRoom.localParticipant.getTrackPublication(Track.Source.ScreenShare)
  const track = pub?.videoTrack
  return track instanceof LocalVideoTrack ? track : null
}

/**
 * Возвращает remote screen-share video track указанного участника (identity).
 * Дёргается из VoiceScreen при сборке tiles — null означает «он не шарит
 * или ещё не подписаны».
 */
export function getRemoteScreenVideoTrack(userId: string): RemoteVideoTrack | null {
  if (!currentRoom) return null
  const p = currentRoom.remoteParticipants.get(userId)
  if (!p) return null
  const pub = p.getTrackPublication(Track.Source.ScreenShare)
  const track = pub?.videoTrack
  return track instanceof RemoteVideoTrack ? track : null
}

/** Локальный трек веб-камеры (для self-tile), если камера включена. */
export function getLocalCameraVideoTrack(): LocalVideoTrack | null {
  if (!currentRoom) return null
  const pub = currentRoom.localParticipant.getTrackPublication(Track.Source.Camera)
  const track = pub?.videoTrack
  return track instanceof LocalVideoTrack ? track : null
}

/** Remote-трек веб-камеры участника (камера авто-подписывается, в отличие от
 *  демки). null — камера выключена или ещё не подписана. */
export function getRemoteCameraVideoTrack(userId: string): RemoteVideoTrack | null {
  if (!currentRoom) return null
  const p = currentRoom.remoteParticipants.get(userId)
  if (!p) return null
  const pub = p.getTrackPublication(Track.Source.Camera)
  const track = pub?.videoTrack
  return track instanceof RemoteVideoTrack ? track : null
}

/**
 * Создаёт и поднимает соединение с LiveKit. НЕ трогает глобальное state —
 * это «полуготовая» комната. Caller сам решает, делать её активной
 * (`installVoiceRoom`) или сразу выкинуть как сироту (`disposeRoom`).
 */
export async function createAndConnectRoom(opts: {
  url: string
  token: string
}): Promise<Room> {
  const room = new Room({
    adaptiveStream: true,
    dynacast: true,
    publishDefaults: {
      // Голос устойчивее к потерям пакетов: RED дублирует аудио-пакеты,
      // DTX шлёт comfort-noise в паузах (экономит полосу, не «булькает»).
      // Это и есть лечение «рассыпания» именно голоса — оно почти всегда от
      // packet loss, а не от нехватки полосы.
      red: true,
      dtx: true,
    },
  })
  await room.connect(opts.url, opts.token)
  return room
}

/**
 * Объявляет комнату активной: подписывает store на её события и
 * подтягивает уже существующих участников. Если до этого была другая
 * активная — её слушатели не снимаем здесь; caller должен был сначала
 * сделать `disposeRoom(prev)`.
 */
export function installVoiceRoom(room: Room): void {
  currentRoom = room
  attachListeners(room)
  // Существующих peer'ов LiveKit НЕ шлёт через ParticipantConnected — они
  // уже в `room.remoteParticipants` к моменту resolve'а `connect()`. Сидим
  // store именно отсюда (а не из REST-snapshot'а), чтобы list участников
  // был согласован с реальной комнатой.
  rebuildParticipantsFromRoom(room)
  // Мик мог быть опубликован до attachListeners (гонки re-join) — метр
  // «я говорю» тогда не получит LocalTrackPublished, цепляем вручную.
  const micPub = room.localParticipant.getTrackPublication(Track.Source.Microphone)
  const ms = micPub?.track?.mediaStreamTrack
  if (ms) startLocalSpeakingMeter(ms)
  // Чужие демки по умолчанию не смотрим + сообщаем свой watch-список.
  for (const p of room.remoteParticipants.values()) applyScreenSubscription(p)
  broadcastWatching(room)

  // Dev-доступ к диагностике: window.kdVoiceStats() в DevTools во время звонка.
  if (import.meta.env.DEV) {
    ;(window as unknown as Record<string, unknown>).kdVoiceStats = collectVoiceStats
  }
}

/**
 * Закрывает соединение с LiveKit для указанной комнаты. Если эта комната
 * была активной — также чистит глобальное state (audio elements, container).
 * Безопасно вызывать на null и на уже-закрытой комнате.
 */
export async function disposeRoom(room: Room | null): Promise<void> {
  if (!room) return
  const wasActive = currentRoom === room
  if (wasActive) {
    currentRoom = null
    stopLocalSpeakingMeter()
    clearAllAttachedAudio()
    removeAudioContainer()
    connectionQuality.clear()
    // Выходим из комнаты во время демки — гасим нативный screen-audio (важно:
    // останавливает и Rust-стрим WASAPI, иначе поток капчурил бы дальше).
    await stopNativeScreenAudio()
  }
  // removeAllListeners — иначе финальный ConnectionStateChanged → Disconnected
  // догонит и перепишет status в 'failed' уже после нашего штатного leave.
  room.removeAllListeners()
  try {
    await room.disconnect()
  } catch (err) {
    console.warn('[livekit] disconnect threw', err)
  }
}

/**
 * Совместимый со старым API алиас — закрывает текущую активную комнату.
 */
export async function disposeVoiceRoom(): Promise<void> {
  await disposeRoom(currentRoom)
}

/**
 * Жёсткий sync teardown для `beforeunload`. Не awaitable: вызывает
 * `room.disconnect()` (он внутри шлёт leave-сигнал по WS синхронно) и
 * сразу убирает DOM-элементы. Async-часть disconnect'а пусть отработает
 * на закрывающемся окне как сможет.
 */
export function disposeVoiceRoomSync(): void {
  const room = currentRoom
  currentRoom = null
  stopLocalSpeakingMeter()
  clearAllAttachedAudio()
  removeAudioContainer()
  if (!room) return
  try { room.removeAllListeners() } catch { /* ignore */ }
  try { void room.disconnect() } catch { /* ignore */ }
}

/**
 * Перезапускает локальный мик-трек с новыми audio constraints (например,
 * включить/выключить `noiseSuppression`). LiveKit под капотом дёргает
 * `getUserMedia` и заменяет underlying MediaStreamTrack через RTCRtpSender
 * — публикация и mute-state сохраняются.
 *
 * No-op, если нет активной комнаты или mic не опубликован.
 */
export async function restartMicConstraints(opts: AudioCaptureOptions): Promise<void> {
  if (!currentRoom) return
  const pub = currentRoom.localParticipant.getTrackPublication(Track.Source.Microphone)
  const track = pub?.track
  if (!(track instanceof LocalAudioTrack)) return
  try {
    await track.restartTrack(opts)
    // restartTrack подменяет underlying MediaStreamTrack — метр «я говорю»
    // держал бы мёртвый трек и молчал. Перецепляем на свежий.
    startLocalSpeakingMeter(track.mediaStreamTrack)
  } catch (err) {
    console.warn('[livekit] restartTrack with new audio constraints failed', err)
  }
}

/** Громкость (0..2, до 200%) для одного источника участника — через
 *  attachedAudioElements/setElementVolume, а не LiveKit-овский
 *  `Participant.setVolume` (тот ограничен [0,1], см. setElementVolume). */
function setSourceVolume(p: RemoteParticipant, source: Track.Source, volume: number): void {
  const sid = p.getTrackPublication(source)?.track?.sid
  if (!sid) return
  const el = attachedAudioElements.get(sid)
  if (!el) return
  setElementVolume(sid, el, volume)
}

/** Итоговая громкость участника: deafen глушит всех, локальный мьют —
 *  точечно, дальше — персональные регуляторы голоса и стрима (до 200%),
 *  умноженные на общую громкость динамика. */
function applyVolumeFor(p: RemoteParticipant, deafened: boolean): void {
  const uid = userIdFromIdentity(p.identity)
  const silenced = deafened || useLocalMute.getState().isMuted(uid)
  const master = useAudioDevices.getState().speakerVolume
  const vols = volumesFor(useVoiceVolumes.getState().volumes, uid)
  setSourceVolume(p, Track.Source.Microphone, silenced ? 0 : Math.min(2, vols.user * master))
  setSourceVolume(p, Track.Source.ScreenShareAudio, silenced ? 0 : Math.min(2, vols.stream * master))
}

/** Переприменяет громкость одного участника в активной комнате — дёргается
 *  после изменения персонального регулятора. */
export function applyParticipantVolume(userId: string): void {
  const room = currentRoom
  if (!room) return
  const p = findRemoteByUserId(room, userId)
  if (p) applyVolumeFor(p, useVoiceStore.getState().deafened)
}

/**
 * Применяет громкость ко всем уже-подписанным удалённым audio-tracks.
 * Используется при toggleDeafen — глушит всех либо восстанавливает,
 * не задевая локально замьюченных.
 */
export function applyDeafenVolume(room: Room | null, deafened: boolean): void {
  if (!room) return
  for (const participant of room.remoteParticipants.values()) {
    applyVolumeFor(participant, deafened)
  }
}

/**
 * Переключает локальный мьют участника (слышимость только у меня) и сразу
 * применяет к активной комнате. Состояние персистится в useLocalMute.
 */
export function toggleLocalParticipantMute(userId: string): boolean {
  const next = !useLocalMute.getState().isMuted(userId)
  useLocalMute.getState().setMuted(userId, next)
  const room = currentRoom
  if (room) {
    const p = findRemoteByUserId(room, userId)
    if (p) applyVolumeFor(p, useVoiceStore.getState().deafened)
  }
  return next
}

function rebuildParticipantsFromRoom(room: Room): void {
  const store = useVoiceStore.getState()
  // Сброс + перенакладка из LiveKit. Между REST-snapshot'ом и реальным
  // connect'ом могли произойти join'ы и leave'ы, поэтому переписываем
  // полностью.
  store.applySnapshot([])
  for (const p of room.remoteParticipants.values()) {
    store.upsertParticipant({
      userId: userIdFromIdentity(p.identity),
      displayName: p.name ?? userIdFromIdentity(p.identity),
      isSpeaking: false,
      isScreenSharing: hasScreenShare(p),
      isCameraOn: hasCamera(p),
      isMuted: !hasUnmutedMic(p),
    })
  }
  // Сразу подцепляем уже подписанные audio-tracks — иначе peer'ы немые,
  // пока кто-то не опубликует/перепубликует трек. Громкость — с учётом
  // deafen и персистнутых локальных мьютов.
  for (const p of room.remoteParticipants.values()) {
    for (const pub of p.audioTrackPublications.values()) {
      const track = pub.track
      if (track && track.kind === Track.Kind.Audio) {
        attachAudio(track as RemoteTrack)
      }
    }
    applyVolumeFor(p, useVoiceStore.getState().deafened)
  }
}

function attachListeners(room: Room): void {
  const store = useVoiceStore.getState

  room.on(RoomEvent.ConnectionStateChanged, (state: ConnectionState) => {
    if (currentRoom !== room) return
    switch (state) {
      case ConnectionState.Connecting:
        store().setStatus('connecting')
        break
      case ConnectionState.Connected:
        store().setStatus('connected')
        store().setError(null)
        break
      case ConnectionState.Reconnecting:
        store().setStatus('reconnecting')
        break
      case ConnectionState.Disconnected:
        // disposeRoom уже снял listeners перед штатным disconnect'ом,
        // так что мы здесь только при unexpected disconnect.
        store().setStatus('failed')
        break
    }
  })

  room.on(RoomEvent.ParticipantConnected, (p: RemoteParticipant) => {
    if (currentRoom !== room) return
    store().upsertParticipant({
      userId: userIdFromIdentity(p.identity),
      displayName: p.name ?? userIdFromIdentity(p.identity),
      isSpeaking: false,
      isScreenSharing: hasScreenShare(p),
      isCameraOn: hasCamera(p),
      isMuted: !hasUnmutedMic(p),
    })
    applyVolumeFor(p, useVoiceStore.getState().deafened)
    // Новенький не знает, чьи демки я смотрю — повторяем свой список.
    broadcastWatching(room)
    playSound('user-join')
  })

  room.on(RoomEvent.ParticipantDisconnected, (p: RemoteParticipant) => {
    if (currentRoom !== room) return
    store().removeParticipant(userIdFromIdentity(p.identity))
    playSound('user-leave')
  })

  room.on(RoomEvent.ActiveSpeakersChanged, (speakers: Participant[]) => {
    if (currentRoom !== room) return
    store().setActiveSpeakers(speakers.map((s) => userIdFromIdentity(s.identity)))
  })

  room.on(RoomEvent.ConnectionQualityChanged, (quality: ConnectionQuality, p: Participant) => {
    if (currentRoom !== room) return
    connectionQuality.set(p.identity, quality)
  })

  // Мик-трек публикуется ЛЕНИВО: кто зашёл замьюченным, не имеет publication
  // вовсе. При первом unmute прилетает TrackPublished (не TrackUnmuted!) —
  // без этого обработчика иконка «мик выключен» застревала, хотя человек
  // уже говорит. Симметрично TrackUnpublished — на случай unpublish при муте.
  room.on(RoomEvent.TrackPublished, (pub: RemoteTrackPublication, p: RemoteParticipant) => {
    if (currentRoom !== room) return
    const uid = userIdFromIdentity(p.identity)
    if (pub.source === Track.Source.Microphone) {
      store().patchParticipant(uid, { isMuted: !hasUnmutedMic(p) })
      return
    }
    if (pub.source === Track.Source.Camera) {
      store().patchParticipant(uid, { isCameraOn: true })
      return
    }
    if (isScreenSource(pub.source)) {
      // Карточка демки появляется сразу, но подписка — только по клику.
      const wasSharing = useVoiceStore.getState().participants.get(uid)?.isScreenSharing
      store().patchParticipant(uid, { isScreenSharing: true })
      applyScreenSubscription(p)
      if (!wasSharing && pub.source === Track.Source.ScreenShare) playSound('stream-start')
    }
  })

  room.on(RoomEvent.TrackUnpublished, (pub: RemoteTrackPublication, p: RemoteParticipant) => {
    if (currentRoom !== room) return
    const uid = userIdFromIdentity(p.identity)
    if (pub.source === Track.Source.Microphone) {
      store().patchParticipant(uid, { isMuted: !hasUnmutedMic(p) })
      return
    }
    if (pub.source === Track.Source.Camera) {
      store().patchParticipant(uid, { isCameraOn: hasCamera(p) })
      return
    }
    if (isScreenSource(pub.source) && !hasScreenShare(p)) {
      store().patchParticipant(uid, { isScreenSharing: false })
      // Следующий стрим этого участника снова начнётся как «не смотрю».
      store().setWatchedScreen(uid, false)
      playSound('stream-end')
    }
  })

  // «Кто смотрит чью демку» — лёгкий обмен data-сообщениями.
  room.on(RoomEvent.DataReceived, (payload: Uint8Array, participant?: RemoteParticipant) => {
    if (currentRoom !== room) return
    if (!participant) return
    try {
      const msg = JSON.parse(dataDecoder.decode(payload)) as { t?: string; watching?: string[] }
      if (msg.t === 'kd-watch' && Array.isArray(msg.watching)) {
        const watching = msg.watching.filter((x) => typeof x === 'string')
        // Звук «зритель зашёл/ушёл» — если меняется членство МОЕЙ демки.
        const myId = userIdFromIdentity(room.localParticipant.identity)
        if (useVoiceStore.getState().screenSharing) {
          const before = useVoiceStore.getState().watchingByUser.get(userIdFromIdentity(participant.identity)) ?? []
          const was = before.includes(myId)
          const now = watching.includes(myId)
          if (!was && now) playSound('viewer-join')
          else if (was && !now) playSound('viewer-leave')
        }
        store().setWatching(userIdFromIdentity(participant.identity), watching)
      }
    } catch { /* чужой формат — игнорируем */ }
  })

  // СВОЙ трек здесь не трогаем: store.muted — намерение пользователя, его
  // пишут только сами действия (toggleMuteVoice, deafen, PTT, moderationSync).
  // Админский mute глушит наш трек со стороны LiveKit, и TrackMuted прилетает
  // РАНЬШЕ, чем WS voice.mod — запись store.muted отсюда портила снапшот
  // mutedBeforeForced в moderationSync (и персистнутый тумблер), из-за чего
  // «вернуть микрофон» не возвращал мик.
  room.on(RoomEvent.TrackMuted, (pub: TrackPublication, p: Participant) => {
    if (currentRoom !== room) return
    if (pub.source !== Track.Source.Microphone) return
    if (p === room.localParticipant) return
    store().patchParticipant(userIdFromIdentity(p.identity), { isMuted: true })
  })

  room.on(RoomEvent.TrackUnmuted, (pub: TrackPublication, p: Participant) => {
    if (currentRoom !== room) return
    if (pub.source !== Track.Source.Microphone) return
    if (p === room.localParticipant) return
    store().patchParticipant(userIdFromIdentity(p.identity), { isMuted: false })
  })

  room.on(
    RoomEvent.TrackSubscribed,
    (track: RemoteTrack, pub: RemoteTrackPublication, p: RemoteParticipant) => {
      if (currentRoom !== room) return
      if (track.kind === Track.Kind.Audio) attachAudio(track)
      if (
        pub.source === Track.Source.ScreenShare ||
        pub.source === Track.Source.ScreenShareAudio
      ) {
        store().patchParticipant(userIdFromIdentity(p.identity), { isScreenSharing: true })
      }
      // Камера подписалась — трек доступен, перерисуем тайл с видео.
      if (pub.source === Track.Source.Camera) {
        store().patchParticipant(userIdFromIdentity(p.identity), { isCameraOn: true })
      }
      applyVolumeFor(p, useVoiceStore.getState().deafened)
    },
  )

  room.on(
    RoomEvent.TrackUnsubscribed,
    (track: RemoteTrack, pub: RemoteTrackPublication, p: RemoteParticipant) => {
      if (currentRoom !== room) return
      if (track.kind === Track.Kind.Audio) detachAudio(track)
      if (
        pub.source === Track.Source.ScreenShare ||
        pub.source === Track.Source.ScreenShareAudio
      ) {
        store().patchParticipant(userIdFromIdentity(p.identity), { isScreenSharing: hasScreenShare(p) })
      }
      if (pub.source === Track.Source.Camera) {
        store().patchParticipant(userIdFromIdentity(p.identity), { isCameraOn: hasCamera(p) })
      }
    },
  )

  // Локальный screen share: store.screenSharing зеркалит реальное состояние
  // публикации, а не намерение пользователя. Это важно для случая, когда user
  // остановил демо через нативный Chromium bar («Stop sharing» внизу экрана) —
  // мы НЕ узнаём об этом из своего обработчика клика, только через эти события.
  room.on(
    RoomEvent.LocalTrackPublished,
    (pub: LocalTrackPublication, p: LocalParticipant) => {
      if (currentRoom !== room) return
      if (p !== room.localParticipant) return
      if (pub.source === Track.Source.Microphone) {
        const ms = pub.track?.mediaStreamTrack
        if (ms) startLocalSpeakingMeter(ms)
        void applyMicGainLive()
        return
      }
      if (pub.source === Track.Source.Camera) {
        store().setCameraOn(true)
        return
      }
      if (pub.source !== Track.Source.ScreenShare) return
      store().setScreenSharing(true)
      playSound('stream-start')
    },
  )

  room.on(
    RoomEvent.LocalTrackUnpublished,
    (pub: LocalTrackPublication, p: LocalParticipant) => {
      if (currentRoom !== room) return
      if (p !== room.localParticipant) return
      if (pub.source === Track.Source.Microphone) {
        stopLocalSpeakingMeter()
        return
      }
      if (pub.source === Track.Source.Camera) {
        store().setCameraOn(false)
        return
      }
      if (pub.source !== Track.Source.ScreenShare) return
      store().setScreenSharing(false)
      // Демку остановили (в т.ч. из ОС-бара Chromium) — снимаем и нативный звук.
      void stopNativeScreenAudio()
      playSound('stream-end')
    },
  )
}

function hasScreenShare(p: Participant): boolean {
  for (const pub of p.videoTrackPublications.values()) {
    if (pub.source === Track.Source.ScreenShare) return true
  }
  for (const pub of p.audioTrackPublications.values()) {
    if (pub.source === Track.Source.ScreenShareAudio) return true
  }
  return false
}

function hasCamera(p: Participant): boolean {
  for (const pub of p.videoTrackPublications.values()) {
    if (pub.source === Track.Source.Camera && !pub.isMuted) return true
  }
  return false
}

function hasUnmutedMic(p: Participant): boolean {
  for (const pub of p.audioTrackPublications.values()) {
    if (pub.source === Track.Source.Microphone && !pub.isMuted) return true
  }
  return false
}
