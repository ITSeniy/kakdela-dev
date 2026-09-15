/** Allowlisted stats only: never export raw reports, SDP, candidates or identities. */
type Stat = Record<string, unknown>
export interface ScreenRtpSample {
  direction: 'send' | 'receive'
  codec?: string
  width?: number
  height?: number
  fps?: number
  mbps?: number
  processingMs?: number
  packetsLost?: number
  jitterMs?: number
  rttMs?: number
  nackCount?: number
  pliCount?: number
  freezeCount?: number
  freezeSeconds?: number
  jitterBufferMs?: number
  limitation?: string
  implementation?: string
  powerEfficient?: boolean
  route?: { protocol?: string; localType?: string; remoteType?: string; relayProtocol?: string; rttMs?: number }
}

export interface ScreenStatsSample {
  at: string
  side: 'sender' | 'viewer'
  capture?: { width?: number; height?: number; requestedFps?: number; contentHint?: string }
  display: { width: number; height: number; fps?: number; droppedFrames?: number }
  rtp: ScreenRtpSample[]
}

function number(s: Stat | undefined, key: string): number | undefined {
  const value = s?.[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}
function string(s: Stat | undefined, key: string): string | undefined {
  return typeof s?.[key] === 'string' ? s[key] : undefined
}
function milliseconds(value: number | undefined): number | undefined {
  return value === undefined ? undefined : value * 1000
}

function delta(current: Stat, previous: Stat | undefined, key: string): number | undefined {
  const a = number(current, key)
  const b = number(previous, key)
  return a !== undefined && b !== undefined && a >= b ? a - b : undefined
}

/** One instance per track; counters are matched by stats ID across samples. */
export function createScreenStatsSampler() {
  let previous = new Map<string, Stat>()
  return (report: RTCStatsReport): ScreenRtpSample[] => {
    const rows = new Map<string, Stat>()
    report.forEach((raw) => rows.set(raw.id, raw as Stat))
    const result: ScreenRtpSample[] = []
    const linked = (s: Stat | undefined, key: string) => {
      const id = string(s, key)
      return id === undefined ? undefined : rows.get(id)
    }
    for (const [id, stat] of rows) {
      if (stat.type !== 'outbound-rtp' && stat.type !== 'inbound-rtp') continue
      if ((stat.kind ?? stat.mediaType) !== 'video') continue
      const codec = string(linked(stat, 'codecId'), 'mimeType')
      if (codec && /\/(rtx|red|ulpfec|flexfec)/i.test(codec)) continue
      const outbound = stat.type === 'outbound-rtp'
      const old = previous.get(id)
      const elapsed = delta(stat, old, 'timestamp')
      const bytes = delta(stat, old, outbound ? 'bytesSent' : 'bytesReceived')
      const frames = delta(stat, old, outbound ? 'framesEncoded' : 'framesDecoded')
      const processing = delta(stat, old, outbound ? 'totalEncodeTime' : 'totalDecodeTime')
      const bufferTime = delta(stat, old, 'jitterBufferDelay')
      const bufferCount = delta(stat, old, 'jitterBufferEmittedCount')
      const remote = linked(stat, 'remoteId')
      const pair = linked(linked(stat, 'transportId'), 'selectedCandidatePairId')
      const local = linked(pair, 'localCandidateId')
      const peer = linked(pair, 'remoteCandidateId')
      const power = stat[outbound ? 'powerEfficientEncoder' : 'powerEfficientDecoder']
      result.push({
        direction: outbound ? 'send' : 'receive',
        codec,
        width: number(stat, 'frameWidth'),
        height: number(stat, 'frameHeight'),
        fps: elapsed && frames !== undefined ? frames * 1000 / elapsed : number(stat, 'framesPerSecond'),
        mbps: elapsed && bytes !== undefined ? bytes * 8 / elapsed / 1000 : undefined,
        processingMs: frames && processing !== undefined ? processing * 1000 / frames : undefined,
        packetsLost: number(outbound ? remote : stat, 'packetsLost'),
        jitterMs: milliseconds(number(outbound ? remote : stat, 'jitter')),
        rttMs: milliseconds(number(remote, 'roundTripTime')),
        nackCount: number(stat, 'nackCount'),
        pliCount: number(stat, 'pliCount'),
        freezeCount: number(stat, 'freezeCount'),
        freezeSeconds: number(stat, 'totalFreezesDuration'),
        jitterBufferMs: bufferCount && bufferTime !== undefined ? bufferTime * 1000 / bufferCount : undefined,
        limitation: string(stat, 'qualityLimitationReason'),
        implementation: string(stat, outbound ? 'encoderImplementation' : 'decoderImplementation'),
        powerEfficient: typeof power === 'boolean' ? power : undefined,
        route: pair ? {
          protocol: string(local, 'protocol'),
          localType: string(local, 'candidateType'),
          remoteType: string(peer, 'candidateType'),
          relayProtocol: string(local, 'relayProtocol'),
          rttMs: milliseconds(number(pair, 'currentRoundTripTime')),
        } : undefined,
      })
    }
    previous = rows
    return result
  }
}

export function screenQualityLabel(sample: ScreenStatsSample): string {
  const stream = sample.rtp[0]
  const direction = sample.side === 'sender' ? 'отправка' : 'приём'
  if (!stream) return `${direction}: нет статистики`
  const resolution = stream.width && stream.height ? `${stream.width}×${stream.height}` : '—'
  const fps = stream.fps === undefined ? '—' : Math.round(stream.fps)
  return `${direction}: ${resolution} · ${fps} fps`
}
