// Общий «движок» записи заметок с устройства (T-104 голосовые, T-105 кружки):
// владеет getUserMedia-потоком, MediaRecorder и таймером. Готовая запись
// уходит наружу файлом — загрузка и отправка сообщения остаются за композером.

import { useCallback, useEffect, useRef, useState } from 'react'

// Кандидаты контейнера в порядке предпочтения. Android WebView и WebView2 —
// оба Chromium: webm (opus / vp8+opus); *_/mp4 — задел на другие движки.
const AUDIO_MIME_CANDIDATES = [
  'audio/webm;codecs=opus',
  'audio/webm',
  'audio/mp4',
] as const

const VIDEO_MIME_CANDIDATES = [
  'video/webm;codecs=vp8,opus',
  'video/webm',
  'video/mp4',
] as const

// Битрейты: 32 кбит/с opus хватает речи, ~1 Мбит/с — кружку 480p
// (минута ≈ 8 МБ при лимите вложения 25 МБ).
const AUDIO_BITS_PER_SECOND = 32_000
const VIDEO_BITS_PER_SECOND = 1_000_000

// Автостоп: голосовое — 10 минут, кружок — минута (как в Telegram; и чтобы
// не упереться в лимит размера вложения).
const MAX_VOICE_SEC = 600
const MAX_CIRCLE_SEC = 60

// Случайный тап по кнопке записи: запись короче полсекунды выбрасываем.
const MIN_RECORDING_MS = 500

// Кружок пишем с фронталки квадратным по возможности — камера всё равно
// может отдать 4:3/16:9, тогда обрезка до круга остаётся за рендером.
const CIRCLE_SIDE_PX = 480

export type NoteRecorderStatus = 'idle' | 'recording' | 'sending'

export interface NoteRecording {
  file: File
  durationSec: number
}

interface ActiveRecording {
  recorder: MediaRecorder
  stream: MediaStream
  chunks: Blob[]
  startedAt: number
  discard: boolean
}

export interface NoteRecorder {
  status: NoteRecorderStatus
  /** Целые секунды с начала записи — для таймера. */
  elapsedSec: number
  /** Живой поток записи — для превью кружка (у голосового не нужен). */
  stream: MediaStream | null
  start: () => Promise<void>
  /** Остановить и отправить (через onFinish). */
  finish: () => void
  /** Остановить и выбросить запись. */
  cancel: () => void
}

export function useNoteRecorder(opts: {
  /** false — голосовое (только микрофон), true — кружок (фронталка + звук). */
  video: boolean
  /** Готовая запись: загрузить и отправить. Пока промис висит — статус `sending`. */
  onFinish: (rec: NoteRecording) => Promise<void>
  onError: (message: string) => void
}): NoteRecorder {
  const { video } = opts
  const [status, setStatus] = useState<NoteRecorderStatus>('idle')
  const [elapsedSec, setElapsedSec] = useState(0)
  const [stream, setStream] = useState<MediaStream | null>(null)
  const activeRef = useRef<ActiveRecording | null>(null)
  const timerRef = useRef<number | null>(null)
  // Колбэки — через ref, чтобы запись не зависела от пересозданий пропсов
  // композера (onSend меняется на каждый рендер).
  const optsRef = useRef(opts)
  optsRef.current = opts

  const clearTimer = useCallback(() => {
    if (timerRef.current !== null) {
      window.clearInterval(timerRef.current)
      timerRef.current = null
    }
  }, [])

  const stop = useCallback((discard: boolean) => {
    const active = activeRef.current
    if (!active || active.recorder.state === 'inactive') return
    active.discard = discard
    active.recorder.stop() // финализация — в onstop
  }, [])

  const start = useCallback(async () => {
    if (activeRef.current) return

    let mediaStream: MediaStream
    try {
      mediaStream = await navigator.mediaDevices.getUserMedia(video
        ? {
            audio: true,
            video: {
              facingMode: 'user',
              width:  { ideal: CIRCLE_SIDE_PX },
              height: { ideal: CIRCLE_SIDE_PX },
            },
          }
        : { audio: true })
    } catch {
      optsRef.current.onError(video
        ? 'нет доступа к камере или микрофону — проверьте разрешения'
        : 'нет доступа к микрофону — проверьте разрешение')
      return
    }

    const candidates: readonly string[] = video ? VIDEO_MIME_CANDIDATES : AUDIO_MIME_CANDIDATES
    const mime = candidates.find((m) =>
      typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(m))
    if (!mime) {
      mediaStream.getTracks().forEach((t) => t.stop())
      optsRef.current.onError('запись не поддерживается на этом устройстве')
      return
    }

    const recorder = new MediaRecorder(mediaStream, {
      mimeType: mime,
      audioBitsPerSecond: AUDIO_BITS_PER_SECOND,
      ...(video ? { videoBitsPerSecond: VIDEO_BITS_PER_SECOND } : {}),
    })
    const active: ActiveRecording = { recorder, stream: mediaStream, chunks: [], startedAt: Date.now(), discard: false }
    activeRef.current = active

    recorder.ondataavailable = (e) => {
      if (e.data.size > 0) active.chunks.push(e.data)
    }
    recorder.onstop = () => {
      activeRef.current = null
      clearTimer()
      active.stream.getTracks().forEach((t) => t.stop())
      setStream(null)

      const durationMs = Date.now() - active.startedAt
      if (active.discard) {
        setStatus('idle')
        return
      }
      if (durationMs < MIN_RECORDING_MS || active.chunks.length === 0) {
        setStatus('idle')
        optsRef.current.onError('слишком короткая запись')
        return
      }

      // Тип чанков включает codecs-параметр — файлу даём чистый контейнерный
      // MIME, его же ждёт presign-whitelist.
      const isMp4 = active.recorder.mimeType.includes('/mp4')
      const container = video
        ? (isMp4 ? 'video/mp4' : 'video/webm')
        : (isMp4 ? 'audio/mp4' : 'audio/webm')
      const ext = video ? (isMp4 ? 'mp4' : 'webm') : (isMp4 ? 'm4a' : 'weba')
      const baseName = video ? 'Кружок' : 'Голосовое сообщение'
      const file = new File(active.chunks, `${baseName}.${ext}`, { type: container })
      const durationSec = Math.max(1, Math.round(durationMs / 1000))

      setStatus('sending')
      optsRef.current.onFinish({ file, durationSec })
        .catch((err: unknown) => {
          optsRef.current.onError(err instanceof Error ? err.message : 'не удалось отправить запись')
        })
        .finally(() => setStatus('idle'))
    }

    // timeslice 1s: на Android WebView без него ondataavailable может прийти
    // пустым при останове — собираем чанки по ходу записи.
    recorder.start(1000)
    setStream(mediaStream)
    setElapsedSec(0)
    setStatus('recording')
    const maxSec = video ? MAX_CIRCLE_SEC : MAX_VOICE_SEC
    timerRef.current = window.setInterval(() => {
      const sec = (Date.now() - active.startedAt) / 1000
      setElapsedSec(Math.floor(sec))
      if (sec >= maxSec) stop(false)
    }, 250)
  }, [video, clearTimer, stop])

  const finish = useCallback(() => stop(false), [stop])
  const cancel = useCallback(() => stop(true), [stop])

  // Размонтирование композера (смена канала) — глушим устройства, запись в мусор.
  useEffect(() => () => {
    clearTimer()
    const active = activeRef.current
    if (active && active.recorder.state !== 'inactive') {
      active.discard = true
      active.recorder.stop()
    }
  }, [clearTimer])

  return { status, elapsedSec, stream, start, finish, cancel }
}
