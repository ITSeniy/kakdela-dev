import { AccessToken } from 'livekit-server-sdk'
import { TrackSource } from '@livekit/protocol'

import { env } from '../env.js'
import { getRoomService } from './guido.js'
import type { Admission } from './admission-token.js'

const SOURCES: Record<string, TrackSource> = {
  camera: TrackSource.CAMERA,
  microphone: TrackSource.MICROPHONE,
  screen_share: TrackSource.SCREEN_SHARE,
  screen_share_audio: TrackSource.SCREEN_SHARE_AUDIO,
}

/** Never expose this token to the client. There are NO usable media grants. */
export async function createBootstrapToken(admission: Admission): Promise<string> {
  const token = new AccessToken(env.LIVEKIT_API_KEY, env.LIVEKIT_API_SECRET, {
    identity: admission.identity,
    name: admission.name,
    metadata: JSON.stringify({ userId: admission.userId }),
    ttl: 30,
  })
  token.addGrant({
    roomJoin: true,
    room: admission.room,
    canPublish: false,
    canSubscribe: false,
    canPublishData: false,
    canUpdateOwnMetadata: false,
  })
  return token.toJwt()
}

export async function elevateParticipant(admission: Admission) {
  return getRoomService().updateParticipant(admission.room, admission.identity, {
    permission: {
      canPublish: admission.canPublish,
      canSubscribe: admission.canSubscribe,
      canPublishData: admission.canPublishData,
      canUpdateMetadata: false,
      canPublishSources: admission.canPublishSources
        .map((s) => SOURCES[s]!)
        .filter((s) => s !== undefined),
    },
  })
}
