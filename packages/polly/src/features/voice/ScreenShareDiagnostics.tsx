import { useState, type RefObject } from 'react'
import { screenQualityLabel, type ScreenStatsSample } from './screen-share-stats.js'

const metric = (value: number | undefined, unit = '') => value === undefined ? '—' : `${value.toFixed(1)}${unit}`

export function ScreenShareDiagnostics({ sample, history }: {
  sample: ScreenStatsSample | null
  history: RefObject<ScreenStatsSample[]>
}) {
  const [expanded, setExpanded] = useState(false)
  const [copyStatus, setCopyStatus] = useState('')
  const stream = sample?.rtp[0]
  async function copy() {
    try {
      await navigator.clipboard.writeText(JSON.stringify({ schema: 1, transport: 'livekit-sfu', samples: history.current }, null, 2))
      setCopyStatus('скопировано')
    } catch {
      setCopyStatus('не удалось скопировать')
    }
  }
  return (
    <div
      className="absolute left-1.5 top-1.5 max-w-[calc(100%_-_12px)] rounded font-mono bg-kd-overlay-strong text-kd-stage-text text-[10px]"
      onClick={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => e.stopPropagation()}
    >
      <button type="button" aria-expanded={expanded} onClick={() => { setExpanded(!expanded); setCopyStatus('') }} className="px-1.5 py-1 text-left" title="показатели демонстрации">
        {sample ? screenQualityLabel(sample) : 'статистика недоступна'}
      </button>
      {expanded && (
        <div className="px-2 pb-2 space-y-1 max-h-[220px] overflow-y-auto">
          <p>{stream?.codec ?? 'кодек —'} · {metric(stream?.mbps, ' Мбит/с')}</p>
          {sample?.capture && <p>Захват: {sample.capture.width ?? '—'}×{sample.capture.height ?? '—'} · настройка {metric(sample.capture.requestedFps, ' fps')}</p>}
          <p>{sample?.side === 'sender' ? 'Локальное превью' : 'Показ видео'}: {metric(sample?.display.fps, ' fps')} · пропущено {sample?.display.droppedFrames ?? '—'}</p>
          <p>{sample?.side === 'sender' ? 'Кодирование' : 'Декодирование'}: {metric(stream?.processingMs, ' мс/кадр')}</p>
          <p>Ограничение: {stream?.limitation ?? '—'} · {stream?.implementation ?? 'обработчик —'}</p>
          <p>RTT до SFU: {metric(stream?.rttMs ?? stream?.route?.rttMs, ' мс')} · jitter {metric(stream?.jitterMs, ' мс')}</p>
          <p>Потеряно пакетов: {stream?.packetsLost ?? '—'} · NACK {stream?.nackCount ?? '—'} · PLI {stream?.pliCount ?? '—'}</p>
          <p>Замирания: {stream?.freezeCount ?? '—'} · буфер {metric(stream?.jitterBufferMs, ' мс')}</p>
          <p>Путь до SFU: {stream?.route?.protocol ?? '—'} · {stream?.route?.localType ?? '—'} / {stream?.route?.remoteType ?? '—'} {stream?.route?.relayProtocol ?? ''}</p>
          <p className="opacity-70">Счётчики — с начала трека. RTT не равен задержке картинки.</p>
          <button type="button" onClick={() => void copy()} className="underline text-kd-warm">копировать последние 5 минут</button>
          <span role="status" className="ml-2">{copyStatus}</span>
        </div>
      )}
    </div>
  )
}
