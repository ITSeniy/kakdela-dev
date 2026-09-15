// Пикер демонстрации (T-094) — модал перед стартом эфира, по-дискордовски:
// источник звука плитками + качество + «в эфир». Видео-источник выбирается
// СЛЕДОМ в системном пикере: WebView2 не даёт выбрать его программно (нет
// аналога desktopCapturer из Electron), поэтому наш модал отвечает за всё
// остальное, а «звук окна» (auto) довязывается к выбранному окну уже после
// системного пикера (см. resolveAutoAudioPid в useScreenShare).

import { useEffect, useMemo, useState, type ReactNode } from 'react'

import { Icon } from '../../components/Icon.js'
import { Modal, ModalHeader } from '../../components/Modal.js'
import {
  listAudioSessions,
  type AudioSessionEntry,
} from '../../lib/host/audioCapture.js'
import {
  SCREEN_QUALITY_LABELS,
  SCREEN_QUALITY_ORDER,
  useScreenShareSettings,
} from './screenShareSettings.js'
import { useAudioCaptureCapability } from './useAudioCaptureCapability.js'
import { configForQuality } from './screen-share-config.js'

interface ScreenSharePickerProps {
  onClose(): void
  /** «В эфир»: модал закрыт, дальше startShare → системный выбор окна/экрана. */
  onGoLive(): void
}

/** «chrome.exe» → «chrome» — на плитке расширение только шумит. */
function displayName(exe: string): string {
  return exe.replace(/\.exe$/i, '')
}

function SectionLabel({ children }: { children: ReactNode }) {
  return (
    <div className="text-[9px] font-mono font-bold uppercase tracking-wider text-kd-text-mute">
      {children}
    </div>
  )
}

/** Плитка выбора звука: иконка + подпись + (опц.) точка «играет сейчас». */
function SoundTile({
  icon,
  label,
  selected,
  playing,
  disabled,
  hint,
  onClick,
}: {
  icon: ReactNode
  label: string
  selected: boolean
  playing?: boolean
  disabled?: boolean
  hint?: string
  onClick(): void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={hint ?? label}
      className={[
        'relative flex flex-col items-center justify-center gap-1.5 px-2 py-3 rounded-kd border text-[11px] font-semibold transition-colors min-w-0',
        selected
          ? 'border-kd-accent bg-kd-accent/10 text-kd-text'
          : 'border-kd-border bg-kd-panel-alt/40 text-kd-text-soft hover:bg-kd-panel-alt hover:text-kd-text',
        disabled ? 'opacity-50 cursor-not-allowed hover:bg-kd-panel-alt/40' : '',
      ].join(' ')}
    >
      {playing && (
        <span
          className="absolute top-1.5 right-1.5 w-1.5 h-1.5 rounded-full bg-kd-accent"
          title="играет сейчас"
        />
      )}
      {icon}
      <span className="w-full truncate text-center">{label}</span>
    </button>
  )
}

export function ScreenSharePicker({ onClose, onGoLive }: ScreenSharePickerProps) {
  const cap = useAudioCaptureCapability()
  const withAudio = useScreenShareSettings((s) => s.withAudio)
  const setWithAudio = useScreenShareSettings((s) => s.setWithAudio)
  const audioCaptureSupported = useScreenShareSettings((s) => s.audioCaptureSupported)
  const audioSource = useScreenShareSettings((s) => s.audioSource)
  const setAudioSource = useScreenShareSettings((s) => s.setAudioSource)
  const screenQuality = useScreenShareSettings((s) => s.screenQuality)
  const setScreenQuality = useScreenShareSettings((s) => s.setScreenQuality)
  const screenContent = useScreenShareSettings((s) => s.screenContent)
  const setScreenContent = useScreenShareSettings((s) => s.setScreenContent)
  const screenCodec = useScreenShareSettings((s) => s.screenCodec)
  const setScreenCodec = useScreenShareSettings((s) => s.setScreenCodec)
  const config = configForQuality(screenQuality, screenContent, screenCodec)

  const native = cap?.systemLoopback === true
  const [sessions, setSessions] = useState<AudioSessionEntry[]>([])

  // Живой список звучащих приложений, пока модал открыт: приложения запускаются
  // и замолкают, пикер должен это отражать (по-дискордовски), а enumeration
  // дешёвая (COM на blocking-потоке).
  useEffect(() => {
    if (!native || !cap?.processLoopback) return
    let alive = true
    const load = async () => {
      try {
        const list = await listAudioSessions()
        if (alive) setSessions(list)
      } catch (err) {
        console.warn('[voice] list audio sessions failed', err)
      }
    }
    void load()
    const timer = setInterval(() => void load(), 2000)
    return () => {
      alive = false
      clearInterval(timer)
    }
  }, [native, cap?.processLoopback])

  // Один exe может держать несколько pid-сессий (chrome) — на плитках дедуп
  // по имени, «играет» агрегируем по OR.
  const apps = useMemo(() => {
    const byName = new Map<string, { name: string; active: boolean }>()
    for (const s of sessions) {
      const key = s.name.toLowerCase()
      const prev = byName.get(key)
      byName.set(key, { name: s.name, active: (prev?.active ?? false) || s.active })
    }
    return [...byName.values()]
  }, [sessions])

  const selectedApp =
    withAudio && audioSource.kind === 'process' ? audioSource.name : null
  // Выбранное приложение сейчас не звучит/закрыто — держим его плиткой с
  // пометкой, чтобы выбор не пропадал из виду (при старте упадём на систему).
  const selectedAppMissing =
    selectedApp !== null &&
    !apps.some((a) => a.name.toLowerCase() === selectedApp.toLowerCase())

  const soundHint = !withAudio
    ? 'зрители не услышат звук'
    : !native
      ? audioCaptureSupported === false
        ? 'на вашей системе браузер не отдаёт системный звук'
        : 'звук — как отдаст браузер (обычно только вкладка/экран)'
      : audioSource.kind === 'auto'
        ? 'звук приложения, чьё окно вы выберете; весь экран — весь системный звук'
        : audioSource.kind === 'system'
          ? 'весь звук системы; голоса собеседников из колонок могут дать эхо'
          : `только ${displayName(audioSource.name)} — что бы вы ни транслировали`

  return (
    <Modal onClose={onClose} width={460}>
      <ModalHeader title="демонстрация экрана" onClose={onClose} />

      <div className="p-5 space-y-4 overflow-y-auto">
        {cap !== null && (
          <div className="space-y-2">
            <SectionLabel>звук</SectionLabel>
            <div className="grid grid-cols-3 gap-1.5">
              <SoundTile
                icon={<Icon.SpeakerOff size={16} />}
                label="без звука"
                selected={!withAudio}
                onClick={() => setWithAudio(false)}
              />
              {native ? (
                <>
                  {cap.processLoopback && (
                    <SoundTile
                      icon={<Icon.Sparkle size={16} />}
                      label="звук окна"
                      hint="автоматически: звук приложения, чьё окно транслируется"
                      selected={withAudio && audioSource.kind === 'auto'}
                      onClick={() => {
                        setWithAudio(true)
                        setAudioSource({ kind: 'auto' })
                      }}
                    />
                  )}
                  <SoundTile
                    icon={<Icon.Speaker size={16} />}
                    label="вся система"
                    hint="весь системный звук — возможно эхо"
                    selected={withAudio && audioSource.kind === 'system'}
                    onClick={() => {
                      setWithAudio(true)
                      setAudioSource({ kind: 'system' })
                    }}
                  />
                  {selectedApp !== null && selectedAppMissing && (
                    <SoundTile
                      icon={<Icon.Alert size={16} />}
                      label={displayName(selectedApp)}
                      hint="сейчас не запущено — при старте возьмём весь системный звук"
                      selected
                      onClick={() => {}}
                    />
                  )}
                  {cap.processLoopback &&
                    apps.map((a) => (
                      <SoundTile
                        key={a.name.toLowerCase()}
                        icon={<Icon.Speaker size={16} />}
                        label={displayName(a.name)}
                        hint={`только звук ${a.name}`}
                        playing={a.active}
                        selected={
                          selectedApp !== null &&
                          selectedApp.toLowerCase() === a.name.toLowerCase()
                        }
                        onClick={() => {
                          setWithAudio(true)
                          setAudioSource({ kind: 'process', name: a.name })
                        }}
                      />
                    ))}
                </>
              ) : (
                // Web/не-Windows: нативного захвата нет, звук — что отдаст
                // getDisplayMedia. Если уже выяснили, что ничего, — disabled.
                <SoundTile
                  icon={<Icon.Speaker size={16} />}
                  label="со звуком"
                  selected={withAudio && audioCaptureSupported !== false}
                  disabled={audioCaptureSupported === false}
                  hint={
                    audioCaptureSupported === false
                      ? 'на вашей системе недоступно — браузер не отдаёт системный звук'
                      : undefined
                  }
                  onClick={() => setWithAudio(true)}
                />
              )}
            </div>
            <div className="text-[10px] text-kd-text-mute leading-snug">{soundHint}</div>
          </div>
        )}

        <div className="space-y-2">
          <SectionLabel>содержимое</SectionLabel>
          <div className="flex gap-3 text-[11px] text-kd-text">
            {(['text', 'motion'] as const).map((content) => (
              <label key={content} className="flex items-center gap-1.5 cursor-pointer">
                <input type="radio" name="screen-content" checked={screenContent === content} onChange={() => setScreenContent(content)} />
                {content === 'text' ? 'текст и работа' : 'игры и видео'}
              </label>
            ))}
          </div>
          <p className="text-[10px] text-kd-text-mute">
            {screenContent === 'text' ? 'При нехватке скорости сохраняем детали изображения.' : 'При нехватке скорости сохраняем плавность движения.'}
          </p>
        </div>

        <div className="space-y-2">
          <SectionLabel>качество</SectionLabel>
          <div className="grid grid-cols-3 gap-1.5">
            {SCREEN_QUALITY_ORDER.map((q) => (
              <button
                key={q}
                type="button"
                aria-pressed={q === screenQuality}
                onClick={() => setScreenQuality(q)}
                className={[
                  'px-2 py-2 rounded-kd border text-[11px] font-mono font-semibold transition-colors',
                  q === screenQuality
                    ? 'border-kd-accent bg-kd-accent/10 text-kd-text'
                    : 'border-kd-border bg-kd-panel-alt/40 text-kd-text-soft hover:bg-kd-panel-alt hover:text-kd-text',
                ].join(' ')}
              >
                {SCREEN_QUALITY_LABELS[q]}
              </button>
            ))}
          </div>
          <p className="text-[10px] text-kd-text-mute">
            До {config.capture.resolution?.height}p · {config.publish.screenShareEncoding?.maxFramerate} кадров/с · {Number(config.publish.screenShareEncoding?.maxBitrate) / 1_000_000} Мбит/с.
            {' '}Фактическое качество зависит от источника, устройства и сети.
          </p>
          <details className="text-[10px] text-kd-text-soft">
            <summary className="cursor-pointer">дополнительные настройки</summary>
            <label className="flex items-center gap-2 mt-2">
              Кодек видео
              <select value={screenCodec} onChange={(e) => setScreenCodec(e.target.value === 'h264' ? 'h264' : 'vp9')} className="rounded-kd border border-kd-border bg-kd-panel px-2 py-1">
                <option value="vp9">VP9</option>
                <option value="h264">H.264</option>
              </select>
            </label>
            <p className="mt-1">Если видео тормозит, сравните кодеки на своём устройстве.</p>
          </details>
        </div>
      </div>

      <div className="px-5 py-3 border-t border-kd-border bg-kd-panel-alt flex items-center gap-2 shrink-0">
        <span className="flex-1 min-w-0 truncate text-[10px] font-mono text-kd-text-mute">
          дальше — системный выбор окна или экрана
        </span>
        <button
          type="button"
          onClick={onClose}
          className="px-3 py-1.5 rounded-kd border border-kd-border text-kd-text-soft text-[11px] font-semibold hover:bg-kd-panel-hi/20 transition-colors"
        >
          отмена
        </button>
        <button
          type="button"
          onClick={onGoLive}
          className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-kd bg-kd-accent text-white text-[11px] font-semibold hover:opacity-90 transition-colors"
        >
          <Icon.Monitor size={13} />
          в эфир
        </button>
      </div>
    </Modal>
  )
}
