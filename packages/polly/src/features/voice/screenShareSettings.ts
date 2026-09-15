import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import type { ScreenCodec, ScreenContent, ScreenQuality } from './screen-share-config.js'

export { SCREEN_QUALITY_LABELS, SCREEN_QUALITY_ORDER } from './screen-share-config.js'
export type { ScreenQuality } from './screen-share-config.js'

/**
 * Источник нативного звука демки (Windows/WASAPI, T-094):
 *  • `auto` — звук приложения, чьё окно выбрано в системном пикере (заголовок
 *    окна из `track.label` матчится на pid). Выбран весь экран / матчинг не
 *    удался / нет process loopback → фолбэк на весь системный звук. Дефолт —
 *    это дискордовское «шаришь игру — слышно игру», эха нет.
 *  • `system` — весь системный звук (loopback устройства вывода). Ловит всё,
 *    включая голоса собеседников из колонок → возможно эхо.
 *  • `process` — звук одного конкретного приложения (process loopback),
 *    независимо от того, какое окно транслируется. Требует Win10 19041+
 *    (`cap.processLoopback`).
 *
 * `process` храним по ИМЕНИ exe, а не по pid: pid эфемерный (приложение
 * перезапустят — сменится), поэтому при каждом старте демо заново находим
 * живой pid по имени среди текущих аудио-сессий.
 */
export type AudioSource =
  | { kind: 'auto' }
  | { kind: 'system' }
  | { kind: 'process'; name: string }

interface ScreenShareSettingsState {
  /**
   * Включать ли захват системного звука вместе с экраном. Default true —
   * это критично для демо игр / YouTube. UI делает toggle disabled, если
   * платформа звук не отдаёт (см. `audioCaptureSupported`).
   */
  withAudio: boolean
  /**
   * Поддерживает ли платформа захват системного звука. `null` = ещё не
   * проверяли (первый запуск); `true` / `false` — кэш результата первой
   * успешной публикации. Кэш переживает рестарты, чтобы UI на «холодном»
   * входе сразу показал корректное состояние toggle'а, не дожидаясь второго
   * запуска screen share.
   *
   * T-050a — это и есть задача, в рамках которой мы выясняем реальное
   * поведение WebView2 на Win10/11. Записывается из `useScreenShare` после
   * каждой попытки startShare({ withAudio: true }).
   */
  audioCaptureSupported: boolean | null
  /**
   * Выбранный preset качества screen share. Применяется при каждом startShare
   * и при «restart» в случае смены на лету.
   */
  screenQuality: ScreenQuality
  screenContent: ScreenContent
  screenCodec: ScreenCodec
  /**
   * Источник нативного звука демки (см. {@link AudioSource}). Дефолт — весь
   * системный звук; пользователь может сузить до конкретного приложения, чтобы
   * убрать эхо. Доступно только когда платформа умеет process loopback.
   */
  audioSource: AudioSource
}

interface ScreenShareSettingsActions {
  setWithAudio(v: boolean): void
  setAudioCaptureSupported(v: boolean): void
  setScreenQuality(q: ScreenQuality): void
  setScreenContent(content: ScreenContent): void
  setScreenCodec(codec: ScreenCodec): void
  setAudioSource(s: AudioSource): void
}

export const useScreenShareSettings = create<
  ScreenShareSettingsState & ScreenShareSettingsActions
>()(
  persist(
    (set) => ({
      withAudio: true,
      audioCaptureSupported: null,
      screenQuality: 'auto',
      screenContent: 'text',
      screenCodec: 'vp9',
      audioSource: { kind: 'auto' },
      setWithAudio(v) {
        set({ withAudio: v })
      },
      setAudioCaptureSupported(v) {
        set({ audioCaptureSupported: v })
      },
      setScreenQuality(q) {
        set({ screenQuality: q })
      },
      setScreenContent(screenContent) {
        set({ screenContent })
      },
      setScreenCodec(screenCodec) {
        set({ screenCodec })
      },
      setAudioSource(s) {
        set({ audioSource: s })
      },
    }),
    {
      name: 'kd:voice:screen-share',
      version: 1,
      migrate(persisted, version) {
        // v0 → v1: появился audioSource 'auto' (звук выбранного окна) и стал
        // дефолтом. Старый 'system' был дефолтом, а не осознанным выбором —
        // переводим на 'auto'; явный выбор 'process' сохраняем.
        const state = persisted as Partial<ScreenShareSettingsState>
        if (version < 1 && state.audioSource?.kind === 'system') {
          state.audioSource = { kind: 'auto' }
        }
        return state
      },
    },
  ),
)
