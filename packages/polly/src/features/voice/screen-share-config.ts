import { AudioPresets, type ScreenShareCaptureOptions, type TrackPublishOptions } from 'livekit-client'

export type ScreenQuality = 'auto' | '1440p30' | '1080p60' | '1080p30' | '720p60' | '720p30' | '720p15'
export type ScreenContent = 'text' | 'motion'
export type ScreenCodec = 'vp9' | 'h264'

export const SCREEN_QUALITY_LABELS: Readonly<Record<ScreenQuality, string>> = {
  auto: '1080p · по профилю',
  '1440p30': '1440p · 30',
  '1080p60': '1080p · 60',
  '1080p30': '1080p · 30',
  '720p60': '720p · 60',
  '720p30': '720p · 30',
  '720p15': '720p · 15',
}
export const SCREEN_QUALITY_ORDER = Object.keys(SCREEN_QUALITY_LABELS) as ScreenQuality[]

// Only screen audio inherits these options; microphone defaults stay in Room.
export const SCREEN_AUDIO_PUBLISH = {
  audioPreset: AudioPresets.musicHighQualityStereo,
  forceStereo: true,
  dtx: false,
  red: true,
} satisfies TrackPublishOptions

export interface ScreenShareConfig {
  capture: ScreenShareCaptureOptions
  publish: TrackPublishOptions
}

/** Explicit capture AND sender ceilings. The SDK ignores videoEncoding for screens. */
export function configForQuality(
  quality: ScreenQuality,
  content: ScreenContent = 'text',
  codec: ScreenCodec = 'vp9',
): ScreenShareConfig {
  const presets: Record<ScreenQuality, [number, number, number, number]> = {
    auto: [1920, 1080, content === 'motion' ? 60 : 30, content === 'motion' ? 10_000_000 : 5_000_000],
    '1440p30': [2560, 1440, 30, 6_000_000],
    '1080p60': [1920, 1080, 60, 10_000_000],
    '1080p30': [1920, 1080, 30, 5_000_000],
    '720p60': [1280, 720, 60, 5_000_000],
    '720p30': [1280, 720, 30, 2_000_000],
    '720p15': [1280, 720, 15, 1_500_000],
  }
  const [width, height, frameRate, maxBitrate] = presets[quality] ?? presets.auto
  return {
    capture: {
      contentHint: content === 'text' ? 'detail' : 'motion',
      // SDK translates these to display-media constraints; actual capture is
      // reported separately because the selected source can have another ratio.
      resolution: { width, height, frameRate },
    },
    publish: {
      ...SCREEN_AUDIO_PUBLISH,
      videoCodec: codec,
      backupCodec: false,
      // One encoding for comparable VP9/H.264 measurements. In 2.19 VP9
      // screen share is L1T3 + motion (SDK workaround), NOT spatial SVC.
      simulcast: false,
      screenShareEncoding: { maxBitrate, maxFramerate: frameRate },
      degradationPreference: content === 'text' ? 'maintain-resolution' : 'maintain-framerate',
    },
  }
}

/** Relax capture only; retain codec, bitrate, fps and screen audio publication. */
export function relaxedScreenCapture(config: ScreenShareConfig): ScreenShareCaptureOptions {
  return { contentHint: config.capture.contentHint, audio: false }
}
