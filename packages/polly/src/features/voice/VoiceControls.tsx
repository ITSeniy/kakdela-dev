import { useState, type ReactNode } from 'react'

import { Icon } from '../../components/Icon.js'
import { describeKey, useVoiceInputSettings } from './inputSettings.js'
import { ScreenSharePicker } from './ScreenSharePicker.js'
import { useVoiceStore } from './store.js'

interface VoiceControlsProps {
  onToggleMute(): void
  onToggleDeafen(): void
  onToggleCamera(): void
  onToggleScreenShare(): void
  onLeave(): void
}

// Кнопка-капсула из designs/final-voice.jsx (KD_VCtrl). Панель лежит на
// bg-kd-stage, поэтому «обычный» тон — прозрачная капсула со stage-текстом.
// Тоны: mute (выключенный микро/звук) — dnd, warn (идёт демо) — warm,
// hot (вы в эфире) — accent, danger (выйти) — danger.
function ctrlCls(tone: 'default' | 'mute' | 'warn' | 'hot' | 'danger' | undefined, active?: boolean): string {
  return tone === 'danger'
    ? 'bg-kd-danger text-white border border-transparent hover:opacity-90'
    : tone === 'mute'
      ? 'bg-kd-dnd text-white border border-transparent hover:opacity-90'
      : tone === 'warn'
        ? 'bg-kd-warm text-white border border-transparent hover:opacity-90'
        : tone === 'hot'
          ? 'bg-kd-accent text-white border border-transparent hover:opacity-90'
          : active
            ? 'bg-kd-panel-hi text-kd-text border border-transparent'
            : 'bg-transparent text-kd-stage-text border border-kd-border hover:bg-kd-panel-hi/20'
}

function CtrlButton({
  children, label, onClick, active, disabled, tone, title,
}: {
  children: ReactNode
  label: string
  onClick?: () => void
  active?: boolean
  disabled?: boolean
  tone?: 'default' | 'mute' | 'warn' | 'hot' | 'danger'
  title?: string
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      className={[
        'inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-kd text-[11px] font-semibold transition-colors',
        ctrlCls(tone, active),
        disabled ? 'opacity-50 cursor-not-allowed' : '',
      ].join(' ')}
    >
      {children}
      {label}
    </button>
  )
}

/** Кнопка «демо»: не шарим → Discord-style пикер (звук + качество, затем
    системный выбор окна/экрана); шарим → немедленный стоп. */
function ScreenShareButton({ onToggleScreenShare }: { onToggleScreenShare(): void }) {
  const screenSharing = useVoiceStore((s) => s.screenSharing)
  const [pickerOpen, setPickerOpen] = useState(false)

  return (
    <>
      <CtrlButton
        label="демо"
        tone={screenSharing ? 'warn' : 'default'}
        title={screenSharing ? 'остановить демонстрацию экрана' : 'начать демонстрацию экрана'}
        onClick={() => {
          if (screenSharing) onToggleScreenShare()
          else setPickerOpen(true)
        }}
      >
        <Icon.Monitor size={13} />
      </CtrlButton>

      {pickerOpen && (
        <ScreenSharePicker
          onClose={() => setPickerOpen(false)}
          onGoLive={() => {
            setPickerOpen(false)
            onToggleScreenShare()
          }}
        />
      )}
    </>
  )
}

export function VoiceControls({
  onToggleMute,
  onToggleDeafen,
  onToggleCamera,
  onToggleScreenShare,
  onLeave,
}: VoiceControlsProps) {
  const muted = useVoiceStore((s) => s.muted)
  const deafened = useVoiceStore((s) => s.deafened)
  const cameraOn = useVoiceStore((s) => s.cameraOn)
  const status = useVoiceStore((s) => s.status)
  const error = useVoiceStore((s) => s.error)
  const pttHolding = useVoiceStore((s) => s.pttHolding)
  const screenSharing = useVoiceStore((s) => s.screenSharing)
  const inputMode = useVoiceInputSettings((s) => s.inputMode)
  const pttKey = useVoiceInputSettings((s) => s.pttKey)

  const isPtt = inputMode === 'push-to-talk'
  const micButton = isPtt
    ? (
      <CtrlButton
        // В PTT мик-кнопка не интерактивна — это индикатор. onClick=undefined
        // и disabled, чтобы у пользователя не возникло желания на неё жать.
        label={pttHolding ? 'вы говорите' : `зажмите ${describeKey(pttKey)}`}
        disabled
        tone={pttHolding ? 'hot' : 'default'}
      >
        {pttHolding ? <Icon.Mic size={13} /> : <Icon.MicOff size={13} />}
      </CtrlButton>
    )
    : (
      <CtrlButton
        label={muted ? 'микро (выкл)' : 'микро'}
        onClick={onToggleMute}
        active={!muted}
        tone={muted ? 'mute' : 'hot'}
      >
        {muted ? <Icon.MicOff size={13} /> : <Icon.Mic size={13} />}
      </CtrlButton>
    )

  return (
    <div className="px-4 py-2 border-t border-kd-border bg-kd-stage flex items-center gap-1.5 shrink-0">
      {/* Пинг убран — переедет в другое место. Статус показываем только
          когда соединение нестабильно. */}
      {(status === 'reconnecting' || status === 'connecting') && (
        <span className="text-[10px] font-mono mr-2 text-kd-text-mute">
          ● {status === 'reconnecting' ? 'переподключение…' : 'подключение…'}
        </span>
      )}

      {micButton}

      <CtrlButton
        label={deafened ? 'звук (выкл)' : 'звук'}
        onClick={onToggleDeafen}
        active={!deafened}
        tone={deafened ? 'mute' : 'default'}
      >
        <Icon.Headphones size={13} />
      </CtrlButton>

      <CtrlButton
        label={cameraOn ? 'камера' : 'камера (выкл)'}
        onClick={onToggleCamera}
        active={cameraOn}
        tone={cameraOn ? 'hot' : 'default'}
        title={cameraOn ? 'выключить веб-камеру' : 'включить веб-камеру'}
      >
        <Icon.Video size={13} />
      </CtrlButton>

      <ScreenShareButton onToggleScreenShare={onToggleScreenShare} />

      {screenSharing && (
        <span className="text-[10px] font-mono px-1.5 py-0.5 rounded text-kd-warm bg-kd-overlay-strong border border-kd-border">
          вы транслируете
        </span>
      )}

      <div className="flex-1" />

      {error && (
        <span className="text-[10px] font-mono mr-2 text-kd-dnd">
          {error}
        </span>
      )}

      <CtrlButton label="выйти" onClick={onLeave} tone="danger">
        <Icon.PhoneOff size={13} />
      </CtrlButton>
    </div>
  )
}
