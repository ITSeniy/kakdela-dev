import { useEffect, useRef, useState, type RefObject } from 'react'
import type { LocalVideoTrack, RemoteVideoTrack } from 'livekit-client'
import { createScreenStatsSampler, type ScreenStatsSample } from './screen-share-stats.js'

export function useScreenShareStats(
  track: LocalVideoTrack | RemoteVideoTrack,
  video: RefObject<HTMLVideoElement | null>,
  isSelf: boolean,
  enabled: boolean,
) {
  const [sample, setSample] = useState<ScreenStatsSample | null>(null)
  const history = useRef<ScreenStatsSample[]>([])
  useEffect(() => {
    setSample(null)
    history.current = []
    if (!enabled) return
    let stopped = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const sampleRtp = createScreenStatsSampler()
    let previousDisplay: { at: number; frames: number } | undefined
    async function read() {
      try {
        const report = await track.getRTCStatsReport()
        const el = video.current
        if (stopped || !el) return
        const settings = track.mediaStreamTrack.getSettings()
        const quality = el.getVideoPlaybackQuality?.()
        const at = performance.now()
        const frames = quality ? quality.totalVideoFrames - quality.droppedVideoFrames : undefined
        const fps = frames !== undefined && previousDisplay && at > previousDisplay.at && frames >= previousDisplay.frames
          ? (frames - previousDisplay.frames) * 1000 / (at - previousDisplay.at) : undefined
        previousDisplay = frames === undefined ? undefined : { at, frames }
        const next: ScreenStatsSample = {
          at: new Date().toISOString(),
          side: isSelf ? 'sender' : 'viewer',
          capture: isSelf ? { width: settings.width, height: settings.height, requestedFps: settings.frameRate, contentHint: track.mediaStreamTrack.contentHint } : undefined,
          display: { width: el.videoWidth, height: el.videoHeight, fps, droppedFrames: quality?.droppedVideoFrames },
          rtp: report ? sampleRtp(report) : [],
        }
        const cutoff = Date.now() - 5 * 60_000
        history.current = [...history.current.filter((entry) => Date.parse(entry.at) >= cutoff).slice(-149), next]
        setSample(next)
      } catch {
        // A replaced/disconnected track may reject getStats. Never keep a stale badge.
        if (!stopped) setSample(null)
      } finally {
        // No overlapping getStats calls; cleanup also guards late promises.
        if (!stopped) timer = setTimeout(() => void read(), 2000)
      }
    }
    void read()
    return () => {
      stopped = true
      clearTimeout(timer)
    }
  }, [track, video, isSelf, enabled])
  return { sample, history }
}
