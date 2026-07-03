import { useCallback } from 'react'
import {
  LocalAudioTrack,
  ScreenSharePresets,
  Track,
  type Room,
  type ScreenShareCaptureOptions,
  type TrackPublishOptions,
  type VideoPreset,
} from 'livekit-client'

import {
  getAudioCaptureCapability,
  listAudioSessions,
  listCaptureWindows,
  type AudioCaptureCapability,
} from '../../lib/host/audioCapture.js'
import {
  getActiveRoom,
  registerNativeScreenAudio,
  stopNativeScreenAudio,
} from '../../lib/livekit.js'
import { createNativeAudioTrack } from './nativeAudioTrack.js'
import {
  useScreenShareSettings,
  type AudioSource,
  type ScreenQuality,
} from './screenShareSettings.js'
import { useVoiceStore } from './store.js'

export interface UseScreenShare {
  /**
   * Запросить системный picker и начать публикацию screen track. Резолвится
   * после успешной публикации; store.screenSharing проставится из
   * LocalTrackPublished listener'а, а не отсюда — это держит state
   * согласованным с реальной комнатой даже при остановке через нативный bar.
   *
   * Если `withAudio` опущен — берём пользовательскую настройку из
   * `useScreenShareSettings`. На платформах, где захват системного звука
   * не работает (см. T-050a), `audioCaptureSupported` останется/станет
   * false после первой попытки.
   */
  startShare(opts?: { withAudio?: boolean }): Promise<void>
  stopShare(): Promise<void>
}

interface ResolvedQuality {
  capture: ScreenShareCaptureOptions
  publish?: TrackPublishOptions
}

// Демку всегда публикуем VP9 + SVC. Для текста/кода/резких краёв VP9 даёт
// заметно лучше качество-на-битрейт, чем дефолтный VP8, а спатиальные слои SVC
// обеспечивают плавную деградацию у слабых зрителей БЕЗ отдельных simulcast-
// слоёв (их роль берёт scalabilityMode VP9, LiveKit включает его сам).
//
// backupCodec выключаем: все наши клиенты — Chromium (WebView2 на desktop) или
// современные браузеры (web), они декодируют VP9 нативно; дублирующий VP8-энкод
// только зря грузил бы CPU у того, кто шарит.
const SCREEN_PUBLISH_BASE = {
  videoCodec: 'vp9',
  backupCodec: false,
} as const satisfies Partial<TrackPublishOptions>

// contentHint='detail' просит энкодер жертвовать частотой кадров ради чёткости —
// правильный выбор для статичного контента (IDE, документы, дашборды), который
// и составляет почти все демонстрации.
const SCREEN_CONTENT_HINT = 'detail' as const

function presetToConfig(preset: VideoPreset): ResolvedQuality {
  return {
    capture: {
      contentHint: SCREEN_CONTENT_HINT,
      resolution: {
        width: preset.width,
        height: preset.height,
        frameRate: preset.encoding.maxFramerate,
      },
    },
    publish: {
      ...SCREEN_PUBLISH_BASE,
      videoEncoding: {
        maxBitrate: preset.encoding.maxBitrate,
        maxFramerate: preset.encoding.maxFramerate,
      },
    },
  }
}

/**
 * Маппит наш user-facing preset в `ScreenShareCaptureOptions` (resolution +
 * contentHint) и `TrackPublishOptions` (кодек VP9, bitrate). Bitrate важно
 * тащить явно — resolution-only в Chromium может отдать поток на ~3 Mbps даже
 * для 720p, пока ему явно не сказано иначе.
 */
function configForQuality(q: ScreenQuality): ResolvedQuality {
  switch (q) {
    case 'auto':
      // VP9 SVC: захват в дефолтном (до 1080p) разрешении, SFU сам срезает
      // спатиальные/темпоральные слои под каждого зрителя — отдельные
      // simulcast-слои тут не нужны.
      return {
        capture: { contentHint: SCREEN_CONTENT_HINT },
        publish: { ...SCREEN_PUBLISH_BASE },
      }
    case '1080p30':
      return presetToConfig(ScreenSharePresets.h1080fps30)
    case '720p30':
      return presetToConfig(ScreenSharePresets.h720fps30)
    case '720p15':
      return presetToConfig(ScreenSharePresets.h720fps15)
  }
}

/**
 * По выбранному источнику ({@link AudioSource}) находит живой pid среди текущих
 * аудио-сессий. Возвращает `undefined` → захват всего системного звука:
 *  • источник = «вся система»;
 *  • платформа не умеет process loopback;
 *  • выбранное приложение сейчас закрыто / не звучит (его нет в сессиях).
 * Хранение по имени exe + резолв здесь делает выбор устойчивым к перезапуску
 * приложения (pid меняется, имя — нет).
 */
async function resolveNativeAudioPid(
  source: AudioSource,
  cap: AudioCaptureCapability,
): Promise<number | undefined> {
  if (source.kind !== 'process' || !cap.processLoopback) return undefined
  try {
    const want = source.name.toLowerCase()
    const matches = (await listAudioSessions()).filter(
      (s) => s.name.toLowerCase() === want,
    )
    if (matches.length === 0) return undefined
    // Предпочитаем сессию, которая реально играет; иначе — любую совпавшую.
    return (matches.find((s) => s.active) ?? matches[0])?.pid
  } catch (err) {
    console.warn('[voice] resolve native audio pid failed', err)
    return undefined
  }
}

/**
 * Автопривязка (audioSource 'auto'): по опубликованному видео-треку демки понять,
 * ЧЬЁ окно транслируется, и вернуть pid этого приложения для process loopback —
 * дискордовское «шаришь игру — слышно игру». Возвращает `undefined` → весь
 * системный звук:
 *  • транслируется весь экран (displaySurface 'monitor') — системный звук и
 *    есть корректное поведение;
 *  • Chromium отдал opaque-ID вместо заголовка окна в `track.label`;
 *  • заголовок не сматчился ни с одним видимым окном.
 */
async function resolveAutoAudioPid(room: Room): Promise<number | undefined> {
  const pub = room.localParticipant.getTrackPublication(Track.Source.ScreenShare)
  const track = pub?.track?.mediaStreamTrack
  if (!track) return undefined

  const surface = (
    track.getSettings() as MediaTrackSettings & { displaySurface?: string }
  ).displaySurface
  if (surface && surface !== 'window') return undefined

  const label = track.label
  // Форматы вида "window:12345:0" / "screen:0:0" — опаковые ID Chromium, не
  // заголовок. Матчить нечем — честно откатываемся на весь системный звук.
  if (!label || /^(?:screen|window|web-contents-media-stream):/i.test(label)) {
    console.info('[voice] auto audio: opaque track label, using system loopback:', label)
    return undefined
  }

  try {
    const windows = await listCaptureWindows()
    const want = label.toLowerCase()
    const exact = windows.find((w) => w.title.toLowerCase() === want)
    // Chromium может обрезать/дополнить название окна — принимаем и вложение
    // строк, но только достаточно длинных, чтобы «a» не сматчилась со всем.
    const candidate =
      exact ??
      windows
        .filter((w) => {
          const t = w.title.toLowerCase()
          if (Math.min(t.length, want.length) < 5) return false
          return t.includes(want) || want.includes(t)
        })
        .sort((a, b) => b.title.length - a.title.length)[0]
    if (!candidate) {
      console.info('[voice] auto audio: no window matched label, using system loopback:', label)
      return undefined
    }
    console.info(
      `[voice] auto audio: "${label}" -> ${candidate.name} (pid ${candidate.pid})`,
    )
    return candidate.pid
  } catch (err) {
    console.warn('[voice] auto audio match failed', err)
    return undefined
  }
}

/**
 * Публикует нативно захваченный звук (WASAPI) как ScreenShareAudio-трек той же
 * демки (T-094 Stage C). `pid` задан → звук одного приложения (без эха), иначе —
 * весь системный звук. Хэндл регистрируется в lib/livekit, чтобы трек корректно
 * снимался при stopShare / остановке из ОС-бара / выходе из комнаты. Не
 * критично: при ошибке демка остаётся, просто без звука.
 */
async function publishNativeScreenAudio(room: Room, pid?: number): Promise<void> {
  try {
    const native = await createNativeAudioTrack(pid !== undefined ? { pid } : {})
    // userProvidedTrack=true: трек наш (из MSTG), LiveKit не управляет его
    // жизненным циклом и не пытается рестартить через getUserMedia.
    const localTrack = new LocalAudioTrack(native.track, undefined, true)
    await room.localParticipant.publishTrack(localTrack, {
      source: Track.Source.ScreenShareAudio,
      name: 'screen-audio',
    })
    registerNativeScreenAudio({
      stop: async () => {
        try {
          await room.localParticipant.unpublishTrack(localTrack)
        } catch {
          /* комната могла уже отключиться — не страшно */
        }
        await native.stop()
      },
    })
  } catch (err) {
    console.warn('[voice] native screen audio publish failed', err)
  }
}

/**
 * LiveKit прячет `getDisplayMedia` за `setScreenShareEnabled` — НЕ вызывай
 * MediaDevices напрямую. В WebView2 на Windows picker откроется внутри окна
 * (как в Chromium), на проде — нативный системный chooser. Поведение
 * одинаково с точки зрения нашего кода.
 */
export function useScreenShare(): UseScreenShare {
  const startShare = useCallback(
    async (opts: { withAudio?: boolean } = {}): Promise<void> => {
      const room = getActiveRoom()
      if (!room) return

      const settings = useScreenShareSettings.getState()
      const wantsAudio = opts.withAudio ?? settings.withAudio
      // Нативный WASAPI-захват (Windows) — надёжная замена getDisplayMedia-аудио
      // (T-050a). Если он доступен, видео берём БЕЗ audio-constraint, а звук
      // публикуем отдельным ScreenShareAudio-треком ниже (publishNativeScreenAudio).
      const cap = await getAudioCaptureCapability()
      const useNativeAudio = wantsAudio && cap.systemLoopback
      // getDisplayMedia-аудио — только когда нативного пути нет (не-Windows и т.п.).
      // Если уже известно, что оно не поддерживается — не запрашиваем вовсе.
      const withAudio = !useNativeAudio && wantsAudio && settings.audioCaptureSupported !== false
      const quality = configForQuality(settings.screenQuality)

      try {
        await room.localParticipant.setScreenShareEnabled(
          true,
          { ...quality.capture, audio: withAudio },
          quality.publish,
        )
      } catch (err) {
        const name = err instanceof Error ? err.name : ''

        // user закрыл picker (Esc / «Cancel») — это штатный выход, не ошибка.
        // Никаких toast'ов, кнопка просто возвращается в idle.
        if (name === 'NotAllowedError') return

        if (name === 'NotReadableError') {
          useVoiceStore.getState().setError('screen-source-busy')
          return
        }

        // Браузер не смог удовлетворить наши hints. Если просили audio —
        // в первую очередь подозреваем audio constraint (T-050a: на ряде
        // WebView2-сборок Win10/11 audio capture проблемный). Снимаем audio
        // и пробуем снова; в случае успеха помечаем платформу как не
        // поддерживающую захват системного звука.
        if (name === 'OverconstrainedError' || name === 'NotSupportedError') {
          if (withAudio) {
            try {
              await room.localParticipant.setScreenShareEnabled(
                true,
                { ...quality.capture, audio: false },
                quality.publish,
              )
              useScreenShareSettings.getState().setAudioCaptureSupported(false)
              return
            } catch (retryErr) {
              console.warn('[voice] screen share audio-fallback failed', retryErr)
              useVoiceStore.getState().setError('screen-share-failed')
              return
            }
          }
          // Без audio тоже не получилось — пробуем без всяких constraints,
          // чтобы хотя бы что-то опубликовалось (resolution preset'а мог
          // не подойти конкретному дисплею).
          try {
            await room.localParticipant.setScreenShareEnabled(true)
            return
          } catch (retryErr) {
            console.warn('[voice] screen share fallback failed', retryErr)
            useVoiceStore.getState().setError('screen-share-failed')
            return
          }
        }

        console.warn('[voice] screen share failed', err)
        useVoiceStore.getState().setError('screen-share-failed')
        return
      }

      if (useNativeAudio) {
        // Нативный путь: видео уже опубликовано, теперь публикуем нативный звук
        // отдельным ScreenShareAudio-треком. Источник: 'auto' — приложение
        // выбранного окна (по видео-треку), 'process' — выбранное в пикере,
        // 'system' — весь звук. Не критично — если упадёт, демка остаётся
        // (просто без звука).
        const pid =
          settings.audioSource.kind === 'auto'
            ? cap.processLoopback
              ? await resolveAutoAudioPid(room)
              : undefined
            : await resolveNativeAudioPid(settings.audioSource, cap)
        await publishNativeScreenAudio(room, pid)
      } else if (withAudio) {
        // Capability-зонд getDisplayMedia: попросили audio, успешно опубликовались
        // — проверяем, приехал ли ScreenShareAudio. В Chromium на некоторых
        // источниках (окно без воспроизведения, Linux webkit2gtk) audio молча НЕ
        // публикуется без ошибки. Если так — кэшируем флаг, чтобы UI не врал.
        const audioPub = room.localParticipant.getTrackPublication(
          Track.Source.ScreenShareAudio,
        )
        useScreenShareSettings.getState().setAudioCaptureSupported(!!audioPub)
      }
    },
    [],
  )

  const stopShare = useCallback(async (): Promise<void> => {
    const room = getActiveRoom()
    if (!room) return
    // Сначала снимаем нативный звук (unpublish + стоп Rust-стрима), потом видео.
    await stopNativeScreenAudio()
    try {
      await room.localParticipant.setScreenShareEnabled(false)
    } catch (err) {
      // Stop редко падает (LiveKit просто unpublish'ит), но если — лог и
      // ничего больше: store обновится из LocalTrackUnpublished когда трек
      // действительно отвалится.
      console.warn('[voice] screen stop failed', err)
    }
  }, [])

  return { startShare, stopShare }
}
