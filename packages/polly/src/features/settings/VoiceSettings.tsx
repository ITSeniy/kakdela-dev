import { useEffect, useRef, useState } from 'react'

import { Field } from '../../components/form/Field.js'
import { Slider } from '../../components/form/Slider.js'
import { Toggle } from '../../components/form/Toggle.js'
import {
  listAudioDevices,
  useAudioDevices,
  type AudioDeviceInfo,
} from '../voice/deviceSettings.js'
import {
  describeKey,
  useVoiceInputSettings,
  type InputMode,
} from '../voice/inputSettings.js'
import { useNoiseSettings } from '../voice/noiseSettings.js'

const SELECT_CLS =
  'w-full px-3 py-2 rounded-kd bg-kd-bg border border-kd-border text-[12px] text-kd-text outline-none focus:border-kd-accent'

/** Селекты устройств + громкости + проверка микрофона (как в Discord). */
function DeviceSettings() {
  const micId = useAudioDevices((s) => s.micId)
  const speakerId = useAudioDevices((s) => s.speakerId)
  const micGain = useAudioDevices((s) => s.micGain)
  const speakerVolume = useAudioDevices((s) => s.speakerVolume)
  const setMicId = useAudioDevices((s) => s.setMicId)
  const setSpeakerId = useAudioDevices((s) => s.setSpeakerId)
  const setMicGain = useAudioDevices((s) => s.setMicGain)
  const setSpeakerVolume = useAudioDevices((s) => s.setSpeakerVolume)

  const [mics, setMics] = useState<AudioDeviceInfo[]>([])
  const [speakers, setSpeakers] = useState<AudioDeviceInfo[]>([])
  const [testing, setTesting] = useState(false)
  const [level, setLevel] = useState(0)
  // «Слышать себя»: маршрутизируем мик обратно в динамик во время проверки.
  const [monitor, setMonitor] = useState(false)
  const stopTestRef = useRef<(() => void) | null>(null)

  useEffect(() => {
    let cancelled = false
    async function load() {
      try {
        const { mics: m, speakers: s } = await listAudioDevices()
        if (cancelled) return
        setMics(m)
        setSpeakers(s)
      } catch { /* нет mediaDevices — пустые списки */ }
    }
    void load()
    navigator.mediaDevices?.addEventListener?.('devicechange', load)
    return () => {
      cancelled = true
      navigator.mediaDevices?.removeEventListener?.('devicechange', load)
    }
  }, [])

  // Проверка микрофона: живой уровень с выбранного устройства (+ опционально
  // слышимость себя в выбранный динамик).
  async function startTest() {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: micId !== 'default' ? { deviceId: { exact: micId } } : true,
      })
      const ctx = new AudioContext()
      const src = ctx.createMediaStreamSource(stream)
      const analyser = ctx.createAnalyser()
      analyser.fftSize = 512
      src.connect(analyser)

      // Слышимость себя: src → gain(громкость динамика) → выходной поток,
      // который играем через <audio> на выбранном speakerId. Отдельный путь
      // от анализатора, поэтому индикатор уровня работает как прежде.
      let monitorEl: HTMLAudioElement | null = null
      if (monitor) {
        const gain = ctx.createGain()
        gain.gain.value = speakerVolume
        const dest = ctx.createMediaStreamDestination()
        src.connect(gain)
        gain.connect(dest)
        monitorEl = new Audio()
        monitorEl.srcObject = dest.stream
        monitorEl.autoplay = true
        const sinkable = monitorEl as unknown as { setSinkId?: (id: string) => Promise<void> }
        if (speakerId !== 'default' && sinkable.setSinkId) {
          try { await sinkable.setSinkId(speakerId) } catch { /* выход не выбираем — дефолт */ }
        }
        void monitorEl.play().catch(() => { /* ignore */ })
      }

      const data = new Uint8Array(analyser.fftSize)
      let raf = 0
      const loop = () => {
        analyser.getByteTimeDomainData(data)
        let sum = 0
        for (let i = 0; i < data.length; i++) {
          const v = ((data[i] ?? 128) - 128) / 128
          sum += v * v
        }
        // sqrt(RMS) — растягиваем низ шкалы, иначе бары еле шевелятся.
        setLevel(Math.min(1, Math.sqrt(Math.sqrt(sum / data.length)) * 1.4))
        raf = requestAnimationFrame(loop)
      }
      raf = requestAnimationFrame(loop)
      stopTestRef.current = () => {
        cancelAnimationFrame(raf)
        if (monitorEl) { monitorEl.pause(); monitorEl.srcObject = null }
        try { src.disconnect() } catch { /* ignore */ }
        void ctx.close().catch(() => { /* ignore */ })
        stream.getTracks().forEach((t) => t.stop())
        setLevel(0)
      }
      setTesting(true)
    } catch { /* нет разрешения — кнопка просто не включится */ }
  }

  function stopTest() {
    stopTestRef.current?.()
    stopTestRef.current = null
    setTesting(false)
  }

  useEffect(() => () => { stopTestRef.current?.() }, [])
  // Смена устройства или тумблера «слышать себя» во время теста —
  // перезапускаем, чтобы перестроить аудио-граф.
  useEffect(() => {
    if (!testing) return
    stopTestRef.current?.()
    void startTest()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [micId, monitor])

  const BAR_COUNT = 24
  const litBars = Math.round(level * BAR_COUNT)

  return (
    <>
      <div className="grid grid-cols-2 gap-3">
        <Field label="микрофон">
          <select value={micId} onChange={(e) => setMicId(e.target.value)} className={SELECT_CLS}>
            <option value="default">по умолчанию</option>
            {mics.map((d) => (
              <option key={d.deviceId} value={d.deviceId}>{d.label}</option>
            ))}
          </select>
        </Field>
        <Field label="динамик">
          <select value={speakerId} onChange={(e) => setSpeakerId(e.target.value)} className={SELECT_CLS}>
            <option value="default">по умолчанию</option>
            {speakers.map((d) => (
              <option key={d.deviceId} value={d.deviceId}>{d.label}</option>
            ))}
          </select>
        </Field>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <Slider
          label="громкость микрофона"
          display={`${Math.round(micGain * 100)}%`}
          value={Math.round(micGain * 100)}
          min={0}
          max={200}
          onChange={(v) => setMicGain(v / 100)}
          hint="программное усиление поверх системного"
        />
        <Slider
          label="громкость динамика"
          display={`${Math.round(speakerVolume * 100)}%`}
          value={Math.round(speakerVolume * 100)}
          min={0}
          max={100}
          onChange={(v) => setSpeakerVolume(v / 100)}
          hint="общая громкость всех в голосовом"
        />
      </div>

      <Field label="проверка микрофона" hint="скажи что-нибудь — полоски покажут уровень">
        <div className="flex flex-col gap-2.5">
          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={() => { testing ? stopTest() : void startTest() }}
              className={[
                'px-3 py-1.5 rounded-kd text-[12px] font-semibold transition-colors shrink-0',
                testing ? 'bg-kd-danger text-white hover:opacity-90' : 'bg-kd-accent text-white hover:bg-kd-accent-deep',
              ].join(' ')}
            >
              {testing ? 'хватит' : 'проверка'}
            </button>
            <div className="flex-1 flex items-center gap-[3px] h-7">
              {Array.from({ length: BAR_COUNT }, (_, i) => (
                <span
                  key={i}
                  className="flex-1 rounded-sm transition-colors"
                  style={{
                    height: '100%',
                    background: i < litBars ? 'var(--kd-accent)' : 'var(--kd-panel-hi)',
                  }}
                />
              ))}
            </div>
          </div>
          <Toggle
            on={monitor}
            onChange={setMonitor}
            label="слышать себя"
            hint="микрофон играет в динамик — лучше в наушниках, иначе будет эхо"
          />
        </div>
      </Field>
    </>
  )
}

interface ModeOption {
  mode: InputMode
  label: string
  hint: string
}

const MODES: ModeOption[] = [
  {
    mode: 'voice-activated',
    label: 'голосовая активация',
    hint: 'микрофон всегда слышит',
  },
  {
    mode: 'push-to-talk',
    label: 'push-to-talk',
    hint: 'говорите по клавише',
  },
]

// Игнорируемые клавиши при capture — иначе можно случайно повесить мик на
// Escape или Tab и заблокировать UI.
const RESERVED_KEYS = new Set(['Escape', 'Tab', 'Enter'])

function KeyCapture({
  current,
  onCancel,
  onConfirm,
}: {
  current: string
  onCancel(): void
  onConfirm(code: string): void
}) {
  useEffect(() => {
    function onKey(ev: KeyboardEvent) {
      if (ev.code === 'Escape') {
        ev.preventDefault()
        // Не отдаём Esc дальше — иначе закроется и экран настроек под нами.
        ev.stopPropagation()
        onCancel()
        return
      }
      if (RESERVED_KEYS.has(ev.code)) return
      ev.preventDefault()
      ev.stopPropagation()
      onConfirm(ev.code)
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [onCancel, onConfirm])

  return (
    <div className="flex items-center gap-2 px-3 py-2 rounded-kd border border-kd-accent bg-kd-accent-soft">
      <span className="text-[11px] text-kd-text font-semibold">нажмите клавишу…</span>
      <span className="text-[10px] font-mono text-kd-text-mute">
        текущая: {describeKey(current)} · Esc — отмена
      </span>
    </div>
  )
}

export function VoiceSettings() {
  const inputMode = useVoiceInputSettings((s) => s.inputMode)
  const pttKey = useVoiceInputSettings((s) => s.pttKey)
  const setInputMode = useVoiceInputSettings((s) => s.setInputMode)
  const setPttKey = useVoiceInputSettings((s) => s.setPttKey)
  const noiseSuppression = useNoiseSettings((s) => s.noiseSuppression)
  const setNoiseSuppression = useNoiseSettings((s) => s.setNoiseSuppression)
  const echoCancellation = useNoiseSettings((s) => s.echoCancellation)
  const setEchoCancellation = useNoiseSettings((s) => s.setEchoCancellation)
  const autoGainControl = useNoiseSettings((s) => s.autoGainControl)
  const setAutoGainControl = useNoiseSettings((s) => s.setAutoGainControl)

  const [capturing, setCapturing] = useState(false)
  // Если режим вдруг сменился во время capture (например, через другую
  // вкладку — но даже sync-load) — закрываем capture, чтобы не лишний UI.
  const lastMode = useRef(inputMode)
  useEffect(() => {
    if (lastMode.current !== inputMode) {
      lastMode.current = inputMode
      setCapturing(false)
    }
  }, [inputMode])

  return (
    <div className="flex flex-col gap-[18px]">
      <DeviceSettings />

      <Field label="режим микрофона" hint="как включается передача голоса">
        {/* сегмент-переключатель в духе блока «плотность» (designs/final-settings.jsx) */}
        <div
          role="radiogroup"
          aria-label="режим микрофона"
          className="flex bg-kd-panel border border-kd-border rounded-kd p-[3px] gap-0.5"
        >
          {MODES.map((opt) => {
            const active = opt.mode === inputMode
            return (
              <button
                key={opt.mode}
                type="button"
                role="radio"
                aria-checked={active}
                onClick={() => setInputMode(opt.mode)}
                className={[
                  'flex-1 px-2.5 py-2 rounded text-center transition-colors',
                  active ? 'bg-kd-panel-hi' : 'hover:bg-kd-panel-soft',
                ].join(' ')}
              >
                <div className={`text-[12px] font-semibold ${active ? 'text-kd-text' : 'text-kd-text-soft'}`}>
                  {opt.label}
                </div>
                <div className="text-[10px] font-mono text-kd-text-mute mt-0.5">{opt.hint}</div>
              </button>
            )
          })}
        </div>
      </Field>

      <Field label="обработка микрофона">
        <Toggle
          on={noiseSuppression}
          onChange={setNoiseSuppression}
          label="шумоподавление"
          hint={noiseSuppression
            ? 'фильтруем кулер, клавиатуру и фоновое'
            : 'микрофон передаёт всё как есть'}
        />
        <Toggle
          on={echoCancellation}
          onChange={setEchoCancellation}
          label="эхоподавление"
          hint="убирает эхо динамиков из микрофона — выключайте только в наушниках"
        />
        <Toggle
          on={autoGainControl}
          onChange={setAutoGainControl}
          label="автоусиление"
          hint="выравнивает громкость голоса автоматически (AGC)"
        />
      </Field>

      {inputMode === 'push-to-talk' && (
        <Field label="клавиша" hint="привязка к физической клавише (любая раскладка)">
          {capturing ? (
            <KeyCapture
              current={pttKey}
              onCancel={() => setCapturing(false)}
              onConfirm={(code) => {
                setPttKey(code)
                setCapturing(false)
              }}
            />
          ) : (
            <div className="flex items-center gap-2">
              <kbd className="px-2 py-1 rounded border border-kd-border bg-kd-panel-alt font-mono text-[12px] text-kd-text">
                {describeKey(pttKey)}
              </kbd>
              <button
                type="button"
                onClick={() => setCapturing(true)}
                className="text-[11px] font-semibold px-3 py-1.5 rounded border border-kd-border text-kd-text hover:bg-kd-panel-hi transition-colors"
              >
                изменить
              </button>
            </div>
          )}
        </Field>
      )}
    </div>
  )
}
