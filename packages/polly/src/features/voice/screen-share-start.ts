import type { LocalParticipant } from 'livekit-client'
import { relaxedScreenCapture, type ScreenShareConfig } from './screen-share-config.js'

function canRelax(error: unknown): boolean {
  return error instanceof Error && (error.name === 'OverconstrainedError' || error.name === 'NotSupportedError')
}

/** Cancel/busy/network errors propagate; only unsupported constraints are retried. */
export async function enableScreenShare(
  participant: Pick<LocalParticipant, 'setScreenShareEnabled'>,
  config: ScreenShareConfig,
  audio: boolean,
): Promise<{ audioRequested: boolean }> {
  try {
    await participant.setScreenShareEnabled(true, { ...config.capture, audio }, config.publish)
    return { audioRequested: audio }
  } catch (error) {
    if (!canRelax(error)) throw error
  }
  if (audio) {
    try {
      await participant.setScreenShareEnabled(true, { ...config.capture, audio: false }, config.publish)
      return { audioRequested: false }
    } catch (error) {
      if (!canRelax(error)) throw error
    }
  }
  await participant.setScreenShareEnabled(true, relaxedScreenCapture(config), config.publish)
  return { audioRequested: false }
}
