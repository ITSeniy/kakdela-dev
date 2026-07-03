// Нативный захват системного/процессного звука для демонстрации (T-094):
// возможности ОС, живой список звучащих приложений/окон и стрим PCM, который
// мостится в LiveKit как отдельный ScreenShareAudio-трек (см. nativeAudioTrack.ts
// и useScreenShare.ts). На web/не-Tauri — «не поддерживается»: нативный захват
// возможен только в Windows-сборке.

export type AudioCaptureMode = 'unsupported' | 'system-loopback' | 'process-loopback'

export interface AudioCaptureCapability {
  /** Высшая доступная ступень захвата. */
  mode: AudioCaptureMode
  /** Доступен ли захват всего системного звука (устройство вывода). */
  systemLoopback: boolean
  /** Доступен ли per-process захват (звук одного приложения). */
  processLoopback: boolean
  /** Номер билда Windows (0 — не Windows / не определён). */
  buildNumber: number
}

const UNSUPPORTED: AudioCaptureCapability = {
  mode: 'unsupported',
  systemLoopback: false,
  processLoopback: false,
  buildNumber: 0,
}

function isTauri(): boolean {
  if (typeof window === 'undefined') return false
  return '__TAURI__' in window || '__TAURI_INTERNALS__' in window
}

/** Что умеет ОС по части нативного захвата звука. На web — «не поддерживается». */
export async function getAudioCaptureCapability(): Promise<AudioCaptureCapability> {
  if (!isTauri()) return UNSUPPORTED
  try {
    const mod = await import('@tauri-apps/api/core')
    return await mod.invoke<AudioCaptureCapability>('audio_capture_capability')
  } catch (err) {
    console.warn('[audioCapture] capability probe failed', err)
    return UNSUPPORTED
  }
}

/** Приложение с аудио-сессией на устройстве вывода (для пикера источника звука). */
export interface AudioSessionEntry {
  pid: number
  name: string
  /** Играет ли прямо сейчас (хоть одна сессия активна). */
  active: boolean
}

/**
 * Список «звучащих» приложений (аудио-сессии устройства вывода) — то, что реально
 * способно дать звук в демку. Источник для пользовательского пикера. На web — пусто.
 */
export async function listAudioSessions(): Promise<AudioSessionEntry[]> {
  if (!isTauri()) return []
  const mod = await import('@tauri-apps/api/core')
  return mod.invoke<AudioSessionEntry[]>('audio_list_sessions')
}

/** Видимое окно для автопривязки звука: pid + заголовок + имя exe. */
export interface CaptureWindowEntry {
  pid: number
  title: string
  name: string
}

/**
 * Список видимых top-level окон с заголовками. Нужен автопривязке звука демки
 * (audioSource 'auto'): заголовок выбранного в системном пикере окна
 * (`track.label` в Chromium) матчится на pid → process loopback именно этого
 * приложения. На web — пусто.
 */
export async function listCaptureWindows(): Promise<CaptureWindowEntry[]> {
  if (!isTauri()) return []
  const mod = await import('@tauri-apps/api/core')
  return mod.invoke<CaptureWindowEntry[]>('audio_list_windows')
}

/** Параметры активного стрима + способ его остановить. */
export interface AudioStreamInfo {
  sampleRate: number
  channels: number
}
export interface ActiveAudioStream extends AudioStreamInfo {
  stop(): Promise<void>
}

/**
 * Stage C: запускает непрерывный стрим PCM (48к/16/стерео) и зовёт `onPcm` на
 * каждый чанк — ArrayBuffer сырых интерливленных i16 LE (без re-encode). `pid`
 * не задан → весь системный звук. Только Windows-сборка.
 */
export async function startAudioStream(
  opts: { pid?: number },
  onPcm: (chunk: ArrayBuffer) => void,
): Promise<ActiveAudioStream> {
  if (!isTauri()) throw new Error('audio stream is Windows-only')
  const mod = await import('@tauri-apps/api/core')
  const channel = new mod.Channel<ArrayBuffer>()
  channel.onmessage = onPcm
  const info = await mod.invoke<AudioStreamInfo>('audio_stream_start', {
    pid: opts.pid ?? null,
    onPcm: channel,
  })
  return {
    ...info,
    async stop() {
      await mod.invoke('audio_stream_stop')
    },
  }
}
