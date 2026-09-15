import { useCallback } from 'react'
import {
  LocalAudioTrack,
  Track,
  type Room,
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
import { createNativeAudioTrack, type NativeAudioTrack } from './nativeAudioTrack.js'
import {
  useScreenShareSettings,
  type AudioSource,
} from './screenShareSettings.js'
import { configForQuality, SCREEN_AUDIO_PUBLISH } from './screen-share-config.js'
import { enableScreenShare } from './screen-share-start.js'
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
  const screen = room.localParticipant.getTrackPublication(Track.Source.ScreenShare)?.track
  if (!screen) return
  const stillSharing = () => getActiveRoom() === room && room.localParticipant.getTrackPublication(Track.Source.ScreenShare)?.track === screen
  let native: NativeAudioTrack | undefined
  let registered = false
  try {
    native = await createNativeAudioTrack(pid !== undefined ? { pid } : {})
    const capture = native
    if (!stillSharing()) return
    // userProvidedTrack=true: трек наш (из MSTG), LiveKit не управляет его
    // жизненным циклом и не пытается рестартить через getUserMedia.
    const localTrack = new LocalAudioTrack(native.track, undefined, true)
    await room.localParticipant.publishTrack(localTrack, {
      ...SCREEN_AUDIO_PUBLISH,
      source: Track.Source.ScreenShareAudio,
      name: 'screen-audio',
    })
    if (!stillSharing()) {
      await room.localParticipant.unpublishTrack(localTrack)
      return
    }
    registerNativeScreenAudio({
      stop: async () => {
        try {
          await room.localParticipant.unpublishTrack(localTrack)
        } catch {
          /* комната могла уже отключиться — не страшно */
        }
        await capture.stop()
      },
    })
    registered = true
  } catch (err) {
    console.warn('[voice] native screen audio publish failed', err)
  } finally {
    // Failed publication or a stopped/replaced screen must not leave WASAPI running.
    if (native && !registered) await native.stop().catch(() => undefined)
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
      const quality = configForQuality(settings.screenQuality, settings.screenContent, settings.screenCodec)

      try {
        const result = await enableScreenShare(room.localParticipant, quality, withAudio)
        if (withAudio && !result.audioRequested) {
          useScreenShareSettings.getState().setAudioCaptureSupported(false)
        }
      } catch (err) {
        const name = err instanceof Error ? err.name : ''
        if (name === 'NotAllowedError' || name === 'AbortError') return
        console.warn('[voice] screen share failed', err)
        useVoiceStore.getState().setError(name === 'NotReadableError' ? 'screen-source-busy' : 'screen-share-failed')
        return
      }

      // The picker can outlive the room or the user can stop sharing meanwhile.
      const screen = room.localParticipant.getTrackPublication(Track.Source.ScreenShare)?.track
      if (getActiveRoom() !== room || !screen) return

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
        if (getActiveRoom() === room && room.localParticipant.getTrackPublication(Track.Source.ScreenShare)?.track === screen) {
          await publishNativeScreenAudio(room, pid)
        }
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
