import { beforeEach, describe, expect, it, vi } from 'vitest'
import { jwtVerify } from 'jose'
import { TrackSource } from 'livekit-server-sdk'

// vi.mock-фабрика хостится в самый верх файла, до объявления `const`,
// поэтому моки должны жить в vi.hoisted-блоке.
const mocks = vi.hoisted(() => ({
  listParticipants: vi.fn(),
  removeParticipant: vi.fn(),
}))

// Подменяем только RoomServiceClient — AccessToken должен остаться настоящим,
// чтобы тест JWT проверял реальную имплементацию.
vi.mock('livekit-server-sdk', async () => {
  const actual =
    await vi.importActual<typeof import('livekit-server-sdk')>('livekit-server-sdk')
  class FakeRoomServiceClient {
    listParticipants = mocks.listParticipants
    removeParticipant = mocks.removeParticipant
  }
  return {
    ...actual,
    RoomServiceClient: FakeRoomServiceClient,
  }
})

const { issueToken, listParticipants, voiceRoomName, livekitIdentity, userIdFromIdentity } =
  await import('./guido.js')

const secret = () => new TextEncoder().encode(process.env.LIVEKIT_API_SECRET!)

beforeEach(() => {
  mocks.listParticipants.mockReset()
  mocks.removeParticipant.mockReset()
})

describe('voiceRoomName', () => {
  it('uses a stable voice-<channelId> shape', () => {
    expect(voiceRoomName('chan-abc')).toBe('voice-chan-abc')
  })
})

describe('issueToken', () => {
  it('produces a JWT with the expected video grants, identity, name, and metadata', async () => {
    const before = Math.floor(Date.now() / 1000)
    const result = await issueToken({
      userId: 'user-123',
      channelId: 'chan-abc',
      displayName: 'Alice',
    })

    expect(result.room).toBe('voice-chan-abc')
    expect(result.url).toBe(process.env.LIVEKIT_URL)
    expect(typeof result.token).toBe('string')

    const { payload } = await jwtVerify(result.token, secret())
    // LiveKit пишет identity в стандартный `sub`-клейм JWT.
    expect(payload.sub).toBe('user-123')
    expect(payload.name).toBe('Alice')
    expect(payload.metadata).toBe(JSON.stringify({ userId: 'user-123' }))

    const video = payload.video as Record<string, unknown>
    expect(video).toMatchObject({
      roomJoin: true,
      room: 'voice-chan-abc',
      canPublish: true,
      canSubscribe: true,
      canPublishData: true,
    })

    // TTL = 6h. Проверяем относительно текущего времени, потому что
    // livekit-server-sdk не обязан выставлять iat.
    expect(payload.exp).toBeDefined()
    const remaining = (payload.exp ?? 0) - before
    expect(remaining).toBeGreaterThanOrEqual(60 * 60 * 5)
    expect(remaining).toBeLessThanOrEqual(60 * 60 * 7)
  })

  it('honours permission overrides', async () => {
    const result = await issueToken({
      userId: 'user-2',
      channelId: 'chan-xyz',
      displayName: 'Bob',
      canPublish: false,
      canPublishData: false,
    })
    const { payload } = await jwtVerify(result.token, secret())
    const video = payload.video as Record<string, unknown>
    expect(video.canPublish).toBe(false)
    expect(video.canPublishData).toBe(false)
    expect(video.canSubscribe).toBe(true)
  })

  it('suffixed identity with deviceId (multi-device, C-2)', async () => {
    const result = await issueToken({
      userId: 'user-123',
      channelId: 'chan-abc',
      displayName: 'Alice',
      deviceId: 'abc123def456',
    })
    const { payload } = await jwtVerify(result.token, secret())
    // identity = userId:deviceId — два устройства одного аккаунта не
    // выбивают друг друга из комнаты.
    expect(payload.sub).toBe('user-123:abc123def456')
    // metadata по-прежнему несёт чистый userId.
    expect(payload.metadata).toBe(JSON.stringify({ userId: 'user-123' }))
  })
})

describe('identity mapping', () => {
  it('livekitIdentity appends :deviceId only when given', () => {
    expect(livekitIdentity('u1', 'dev')).toBe('u1:dev')
    expect(livekitIdentity('u1')).toBe('u1')
    expect(livekitIdentity('u1', undefined)).toBe('u1')
  })

  it('userIdFromIdentity strips the device suffix', () => {
    expect(userIdFromIdentity('user-1')).toBe('user-1')
    expect(userIdFromIdentity('user-1:abc123def456')).toBe('user-1')
  })

  it('listParticipants maps device-suffixed identities to pure userIds', async () => {
    mocks.listParticipants.mockResolvedValueOnce([
      {
        identity: 'user-1:abc123def456',
        name: 'Alice (phone)',
        joinedAt: 0n,
        joinedAtMs: 1_700_000_000_000n,
        isPublisher: true,
        tracks: [{ source: TrackSource.MICROPHONE }],
      },
    ])
    const out = await listParticipants('chan-xyz')
    expect(out[0]?.userId).toBe('user-1')
  })
})

describe('listParticipants', () => {
  it('returns [] when LiveKit reports the room as not-found', async () => {
    const notFound = Object.assign(new Error('requested room does not exist'), {
      code: 'not_found',
    })
    mocks.listParticipants.mockRejectedValueOnce(notFound)
    await expect(listParticipants('chan-no-room')).resolves.toEqual([])
    expect(mocks.listParticipants).toHaveBeenCalledWith('voice-chan-no-room')
  })

  it('maps ParticipantInfo and flags participants sharing a screen', async () => {
    mocks.listParticipants.mockResolvedValueOnce([
      {
        identity: 'user-1',
        name: 'Alice',
        joinedAt: 0n,
        joinedAtMs: 1_700_000_000_000n,
        isPublisher: true,
        tracks: [{ source: TrackSource.SCREEN_SHARE }],
      },
      {
        identity: 'user-2',
        name: 'Bob',
        joinedAt: 1_700_000_000n,
        joinedAtMs: 0n,
        isPublisher: false,
        tracks: [{ source: TrackSource.MICROPHONE }],
      },
    ])

    const out = await listParticipants('chan-xyz')
    expect(out).toEqual([
      {
        userId: 'user-1',
        displayName: 'Alice',
        joinedAt: new Date(1_700_000_000_000).toISOString(),
        isPublishing: true,
        isScreenSharing: true,
        // мик-трека нет вовсе → считается замьюченным
        isMuted: true,
      },
      {
        userId: 'user-2',
        displayName: 'Bob',
        joinedAt: new Date(1_700_000_000_000).toISOString(),
        isPublishing: false,
        isScreenSharing: false,
        isMuted: false,
      },
    ])
  })

  it('propagates unexpected errors (not silently swallowing real failures)', async () => {
    const boom = new Error('lost battle with the server')
    mocks.listParticipants.mockRejectedValueOnce(boom)
    await expect(listParticipants('chan-broken')).rejects.toThrow('lost battle')
  })
})
