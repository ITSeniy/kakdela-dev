import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { LocalParticipant } from 'livekit-client'

// Regression against the installed SDK, not a reimplementation of its rules.
import { computeVideoEncodings } from '../node_modules/livekit-client/src/room/participant/publishUtils.ts'
import { publishDefaults } from '../node_modules/livekit-client/src/room/defaults.ts'
import { screenCaptureToDisplayMediaStreamOptions } from '../node_modules/livekit-client/src/room/track/utils.ts'
import { configForQuality, SCREEN_QUALITY_ORDER } from '../src/features/voice/screen-share-config.ts'
import { enableScreenShare } from '../src/features/voice/screen-share-start.ts'
import { createScreenStatsSampler, screenQualityLabel } from '../src/features/voice/screen-share-stats.ts'

test('installed SDK sends the selected ceiling for every profile/codec, including 30 and 60 fps', () => {
  for (const quality of SCREEN_QUALITY_ORDER) {
    for (const content of ['text', 'motion'] as const) {
      for (const codec of ['vp9', 'h264'] as const) {
        const config = configForQuality(quality, content, codec)
        const { width, height, frameRate } = config.capture.resolution!
        const encodings = computeVideoEncodings(true, width, height, {
          ...publishDefaults,
          ...config.publish,
          ...(codec === 'vp9' ? { scalabilityMode: 'L1T3' } : {}),
        })
        assert.equal(encodings.length, 1)
        assert.equal(encodings[0]?.maxFramerate, frameRate, `${quality}/${content}/${codec}`)
        assert.equal(encodings[0]?.maxBitrate, config.publish.screenShareEncoding?.maxBitrate)
        const constraints = screenCaptureToDisplayMediaStreamOptions(config.capture).video as MediaTrackConstraints
        assert.equal(constraints.frameRate, frameRate)
      }
    }
  }
  assert.equal(configForQuality('1080p30').publish.screenShareEncoding?.maxBitrate, 5_000_000)
  assert.equal(configForQuality('auto', 'motion').publish.screenShareEncoding?.maxFramerate, 60)
  assert.equal(configForQuality('auto', 'text').publish.degradationPreference, 'maintain-resolution')
  assert.equal(configForQuality('auto', 'motion').publish.degradationPreference, 'maintain-framerate')
})

test('both screen audio paths explicitly request stereo music without changing microphone defaults', () => {
  const config = configForQuality('1080p30')
  assert.equal(config.publish.audioPreset?.maxBitrate, 128_000)
  assert.equal(config.publish.forceStereo, true)
  assert.equal(config.publish.dtx, false)
  assert.equal(publishDefaults.forceStereo, false)
  assert.equal(publishDefaults.dtx, true)
})

function failed(name: string) { return Object.assign(new Error(name), { name }) }
function participant(errors: Error[]) {
  const calls: Parameters<LocalParticipant['setScreenShareEnabled']>[] = []
  return {
    calls,
    async setScreenShareEnabled(...args: Parameters<LocalParticipant['setScreenShareEnabled']>) {
      calls.push(args)
      const error = errors.shift()
      if (error) throw error
      return undefined
    },
  }
}

test('audio and capture retries retain sender options, success continues the caller', async () => {
  const config = configForQuality('1080p60', 'motion', 'h264')
  const peer = participant([failed('NotSupportedError'), failed('OverconstrainedError')])
  assert.deepEqual(await enableScreenShare(peer, config, true), { audioRequested: false })
  assert.equal(peer.calls.length, 3)
  for (const call of peer.calls) assert.deepEqual(call[2], config.publish)
  assert.equal(peer.calls[1]?.[1]?.audio, false)
  assert.equal(peer.calls[2]?.[1]?.resolution, undefined)
})

test('video-only fallback succeeds and retains encoding; audio-only fallback retains resolution', async () => {
  const config = configForQuality('1440p30')
  const peer = participant([failed('OverconstrainedError')])
  assert.deepEqual(await enableScreenShare(peer, config, false), { audioRequested: false })
  assert.equal(peer.calls.length, 2)
  assert.deepEqual(peer.calls[1]?.[2], config.publish)
  const audio = participant([failed('NotSupportedError')])
  await enableScreenShare(audio, config, true)
  assert.deepEqual(audio.calls[1]?.[1]?.resolution, config.capture.resolution)
})

test('cancel, busy and transport errors never reopen the picker, including on retry', async () => {
  for (const name of ['NotAllowedError', 'AbortError', 'NotReadableError', 'NetworkError']) {
    const peer = participant([failed(name)])
    await assert.rejects(enableScreenShare(peer, configForQuality('auto'), true), { name })
    assert.equal(peer.calls.length, 1)
    const retry = participant([failed('OverconstrainedError'), failed(name)])
    await assert.rejects(enableScreenShare(retry, configForQuality('auto'), true), { name })
    assert.equal(retry.calls.length, 2)
  }
})

function report(...rows: Record<string, unknown>[]): RTCStatsReport {
  return new Map(rows.map((row) => [row.id, row])) as unknown as RTCStatsReport
}
const codec = { id: 'codec', type: 'codec', mimeType: 'video/VP9' }
const base = { id: 'stream', type: 'outbound-rtp', kind: 'video', codecId: 'codec', remoteId: 'remote', transportId: 'transport' }

test('stats use interval bitrate/fps/encode time, link remote loss and selected ICE; exports omit private data', () => {
  const sample = createScreenStatsSampler()
  assert.equal(sample(report(codec, { ...base, timestamp: 1000, bytesSent: 1000, framesEncoded: 100, totalEncodeTime: 1 }))[0]?.mbps, undefined)
  const result = sample(report(codec,
    { ...base, timestamp: 3000, bytesSent: 1_251_000, framesEncoded: 220, totalEncodeTime: 1.6, frameWidth: 1920, frameHeight: 1080, qualityLimitationReason: 'cpu' },
    { id: 'remote', type: 'remote-inbound-rtp', packetsLost: 2, jitter: 0.01, roundTripTime: 0.05 },
    { id: 'transport', type: 'transport', selectedCandidatePairId: 'pair' },
    { id: 'pair', type: 'candidate-pair', localCandidateId: 'local', remoteCandidateId: 'peer', currentRoundTripTime: 0.04 },
    { id: 'local', type: 'local-candidate', protocol: 'udp', candidateType: 'relay', relayProtocol: 'tls', address: 'PRIVATE_ADDRESS', usernameFragment: 'PRIVATE_CREDENTIAL' },
    { id: 'peer', type: 'remote-candidate', candidateType: 'host', address: 'PRIVATE_ADDRESS' },
  ))
  assert.equal(result[0]?.mbps, 5)
  assert.equal(result[0]?.fps, 60)
  assert.ok(Math.abs(result[0]!.processingMs! - 5) < 0.001)
  assert.equal(result[0]?.rttMs, 50)
  assert.equal(result[0]?.jitterMs, 10)
  assert.equal(result[0]?.packetsLost, 2)
  assert.equal(result[0]?.route?.localType, 'relay')
  assert.equal(result[0]?.route?.relayProtocol, 'tls')
  assert.equal(JSON.stringify(result).includes('PRIVATE_'), false)
})

test('viewer reports actual decoded FPS, jitter buffer and freezes; excludes audio/RTX', () => {
  const sample = createScreenStatsSampler()
  const inbound = { id: 'video', type: 'inbound-rtp', kind: 'video', codecId: 'codec', frameWidth: 2560, frameHeight: 1440 }
  sample(report(codec, { ...inbound, timestamp: 1000, bytesReceived: 0, framesDecoded: 10, totalDecodeTime: 0.1, jitterBufferDelay: 1, jitterBufferEmittedCount: 10 }))
  const result = sample(report(codec,
    { ...inbound, timestamp: 2000, bytesReceived: 250_000, framesDecoded: 40, totalDecodeTime: 0.16, jitterBufferDelay: 1.9, jitterBufferEmittedCount: 40, freezeCount: 1, packetsLost: 3 },
    { id: 'audio', type: 'inbound-rtp', kind: 'audio' },
    { id: 'rtx-codec', type: 'codec', mimeType: 'video/rtx' },
    { ...inbound, id: 'rtx', codecId: 'rtx-codec' },
  ))
  assert.equal(result.length, 1)
  assert.equal(result[0]?.fps, 30)
  assert.equal(result[0]?.mbps, 2)
  assert.ok(Math.abs(result[0]!.jitterBufferMs! - 30) < 0.001)
  assert.equal(result[0]?.freezeCount, 1)
  assert.equal(screenQualityLabel({ at: '', side: 'viewer', display: { width: 2560, height: 1440 }, rtp: result }), 'приём: 2560×1440 · 30 fps')
})

test('missing fields are unknown, stalled stream is zero, reset counters do not yield negative rates', () => {
  const sample = createScreenStatsSampler()
  const row = { ...base, timestamp: 1000, bytesSent: 1000, framesEncoded: 20 }
  sample(report(row))
  const stalled = sample(report({ ...row, timestamp: 2000 }))[0]
  assert.equal(stalled?.fps, 0)
  assert.equal(stalled?.mbps, 0)
  assert.equal(stalled?.packetsLost, undefined)
  const reset = sample(report({ ...row, timestamp: 3000, bytesSent: 5, framesEncoded: 1 }))[0]
  assert.equal(reset?.mbps, undefined)
  assert.equal(reset?.fps, undefined)
  assert.equal(reset?.route, undefined)
  assert.deepEqual(sample(report()), [])
})
