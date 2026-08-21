import { beforeEach, describe, expect, it, vi } from 'vitest'
import { TrackSource } from 'livekit-server-sdk'
import type { WebhookEvent } from 'livekit-server-sdk'

const mocks = vi.hoisted(() => ({
  sadd: vi.fn(),
  srem: vi.fn(),
  del: vi.fn(),
  set: vi.fn(),
  get: vi.fn(),
  hdel: vi.fn(),
  channelLookup: vi.fn(),
  insertReturning: vi.fn(),
  broadcastToServer: vi.fn(),
  broadcastToChannel: vi.fn(),
  listDmParticipants: vi.fn(),
  listParticipants: vi.fn(),
}))

// guido тащит livekit-server-sdk + env — мокаем только то, что использует
// webhook (listDmParticipants / listParticipants как источник истины
// «кто сейчас в комнате?»). userIdFromIdentity — чистая функция, берём
// настоящую реализацию (identity в тестах без device-суффиксов).
vi.mock('./guido.js', async () => {
  const actual = await vi.importActual<typeof import('./guido.js')>('./guido.js')
  return {
    listDmParticipants: mocks.listDmParticipants,
    listParticipants: mocks.listParticipants,
    userIdFromIdentity: actual.userIdFromIdentity,
  }
})

vi.mock('../lib/redis.js', () => ({
  redis: {
    sadd: mocks.sadd,
    srem: mocks.srem,
    del: mocks.del,
    set: mocks.set,
    get: mocks.get,
    hdel: mocks.hdel,
  },
}))

vi.mock('../lib/db.js', () => {
  // Достаточно lightweight цепочки, которая возвращает то, что вернёт lookup mock.
  const select = () => ({
    from: () => ({
      where: () => ({
        limit: () => mocks.channelLookup() as unknown,
      }),
    }),
  })
  const insert = () => ({
    values: () => ({
      returning: () => mocks.insertReturning() as unknown,
    }),
  })
  return { db: { select, insert } }
})

vi.mock('../ws/broadcast.js', () => ({
  broadcastToServer: mocks.broadcastToServer,
  broadcastToChannel: mocks.broadcastToChannel,
  wireBrokerToRegistry: vi.fn(),
}))

const {
  alreadyProcessed,
  handleWebhookEvent,
  parseChannelIdFromRoom,
  parseDmChannelIdFromRoom,
} = await import('./webhook.js')

const CHANNEL_ID = '11111111-1111-1111-1111-111111111111'
const SERVER_ID = '22222222-2222-2222-2222-222222222222'
const USER_ID = '33333333-3333-3333-3333-333333333333'

function voiceChannelOk() {
  mocks.channelLookup.mockResolvedValueOnce([{ serverId: SERVER_ID, kind: 'voice' }])
}

function buildEvent(partial: Partial<WebhookEvent> & { event: string }): WebhookEvent {
  // Webhook handler читает только узкое подмножество полей,
  // поэтому проще собрать обычный объект, чем мутировать настоящий Message.
  return {
    id: 'evt-1',
    createdAt: 0n,
    numDropped: 0,
    ...partial,
  } as unknown as WebhookEvent
}

function buildParticipant(
  tracks: Array<{ source: TrackSource; muted?: boolean }> = [],
  identity: string = USER_ID,
) {
  return {
    identity,
    name: 'Alice',
    isPublisher: true,
    joinedAt: 0n,
    joinedAtMs: 1_700_000_000_000n,
    tracks: tracks.map((t) => ({ source: t.source, muted: t.muted ?? false })),
  } as unknown as NonNullable<WebhookEvent['participant']>
}

function buildRoom(channelId = CHANNEL_ID) {
  return { name: `voice-${channelId}` } as unknown as NonNullable<WebhookEvent['room']>
}

function buildDmRoom(channelId = CHANNEL_ID, numParticipants = 0) {
  return { name: `dm-${channelId}`, numParticipants } as unknown as NonNullable<WebhookEvent['room']>
}

const DM_CALL_KEY = `dm:call:${CHANNEL_ID}:log`

beforeEach(() => {
  for (const m of Object.values(mocks)) m.mockReset()
})

describe('parseChannelIdFromRoom', () => {
  it('returns channelId for voice-<id> names', () => {
    expect(parseChannelIdFromRoom('voice-abc')).toBe('abc')
  })
  it('returns null for non-voice rooms', () => {
    expect(parseChannelIdFromRoom('chat-abc')).toBeNull()
    expect(parseChannelIdFromRoom(undefined)).toBeNull()
    expect(parseChannelIdFromRoom('voice-')).toBeNull()
  })
  it('does not match dm- rooms (those go through the DM branch)', () => {
    expect(parseChannelIdFromRoom('dm-abc')).toBeNull()
  })
})

describe('parseDmChannelIdFromRoom', () => {
  it('returns channelId for dm-<id> names', () => {
    expect(parseDmChannelIdFromRoom('dm-abc')).toBe('abc')
  })
  it('returns null for non-dm rooms', () => {
    expect(parseDmChannelIdFromRoom('voice-abc')).toBeNull()
    expect(parseDmChannelIdFromRoom(undefined)).toBeNull()
    expect(parseDmChannelIdFromRoom('dm-')).toBeNull()
  })
})

describe('alreadyProcessed', () => {
  it('returns false on first occurrence and true on subsequent ones', async () => {
    mocks.set.mockResolvedValueOnce('OK')
    expect(await alreadyProcessed('evt-id-1')).toBe(false)
    expect(mocks.set).toHaveBeenCalledWith(
      'livekit:webhook:seen:evt-id-1',
      '1',
      'EX',
      60 * 60,
      'NX',
    )

    mocks.set.mockResolvedValueOnce(null)
    expect(await alreadyProcessed('evt-id-1')).toBe(true)
  })

  it('does not call Redis when id is empty', async () => {
    expect(await alreadyProcessed('')).toBe(false)
    expect(mocks.set).not.toHaveBeenCalled()
  })
})

describe('handleWebhookEvent', () => {
  it('participant_joined → voice.join + voice.state, sadd, cache invalidated', async () => {
    voiceChannelOk()
    // voice.state берётся из живого LiveKit, а не из снапшота события —
    // вебхуки не упорядочены, снапшот бывает устаревшим.
    mocks.listParticipants.mockResolvedValueOnce([
      { userId: USER_ID, isMuted: false, isScreenSharing: true },
    ])
    await handleWebhookEvent(
      buildEvent({
        event: 'participant_joined',
        room: buildRoom(),
        participant: buildParticipant([
          { source: TrackSource.MICROPHONE, muted: true }, // stale-снапшот игнорируется
        ]),
      }),
    )
    expect(mocks.sadd).toHaveBeenCalledWith(
      `voice:channel:${CHANNEL_ID}:users`,
      USER_ID,
    )
    expect(mocks.del).toHaveBeenCalledWith(
      `voice:channel:${CHANNEL_ID}:participants-cache`,
    )
    expect(mocks.broadcastToServer).toHaveBeenCalledWith(SERVER_ID, {
      t: 'voice.join',
      channelId: CHANNEL_ID,
      userId: USER_ID,
    })
    expect(mocks.broadcastToServer).toHaveBeenCalledWith(SERVER_ID, {
      t: 'voice.state',
      channelId: CHANNEL_ID,
      userId: USER_ID,
      muted: false,
      screen: true,
    })
  })

  it('participant_left → voice.leave + srem + cache invalidated', async () => {
    voiceChannelOk()
    mocks.listParticipants.mockResolvedValueOnce([]) // юзера в комнате уже нет
    await handleWebhookEvent(
      buildEvent({
        event: 'participant_left',
        room: buildRoom(),
        participant: buildParticipant(),
      }),
    )
    expect(mocks.srem).toHaveBeenCalledWith(
      `voice:channel:${CHANNEL_ID}:users`,
      USER_ID,
    )
    expect(mocks.broadcastToServer).toHaveBeenCalledWith(SERVER_ID, {
      t: 'voice.leave',
      channelId: CHANNEL_ID,
      userId: USER_ID,
    })
  })

  it('stale participant_left (user re-joined) is ignored, cache still invalidated', async () => {
    voiceChannelOk()
    // LiveKit говорит, что юзер снова в комнате — left относится к старой
    // сессии и пришёл с опозданием: не выкидываем живого участника.
    mocks.listParticipants.mockResolvedValueOnce([{ userId: USER_ID }])
    await handleWebhookEvent(
      buildEvent({
        event: 'participant_left',
        room: buildRoom(),
        participant: buildParticipant(),
      }),
    )
    expect(mocks.srem).not.toHaveBeenCalled()
    expect(mocks.broadcastToServer).not.toHaveBeenCalled()
    expect(mocks.del).toHaveBeenCalledWith(
      `voice:channel:${CHANNEL_ID}:participants-cache`,
    )
  })

  it('participant_connection_aborted treated the same as participant_left', async () => {
    voiceChannelOk()
    mocks.listParticipants.mockResolvedValueOnce([])
    await handleWebhookEvent(
      buildEvent({
        event: 'participant_connection_aborted',
        room: buildRoom(),
        participant: buildParticipant(),
      }),
    )
    expect(mocks.broadcastToServer).toHaveBeenCalledWith(SERVER_ID, {
      t: 'voice.leave',
      channelId: CHANNEL_ID,
      userId: USER_ID,
    })
  })

  it('track_published recomputes muted/screen from live LiveKit state', async () => {
    voiceChannelOk()
    mocks.listParticipants.mockResolvedValueOnce([
      { userId: USER_ID, isMuted: true, isScreenSharing: false },
    ])
    await handleWebhookEvent(
      buildEvent({
        event: 'track_published',
        room: buildRoom(),
        participant: buildParticipant([
          { source: TrackSource.MICROPHONE, muted: true },
        ]),
      }),
    )
    expect(mocks.broadcastToServer).toHaveBeenCalledWith(SERVER_ID, {
      t: 'voice.state',
      channelId: CHANNEL_ID,
      userId: USER_ID,
      muted: true,
      screen: false,
    })
    expect(mocks.sadd).not.toHaveBeenCalled()
  })

  it('track_published for user already gone → no voice.state, cache invalidated', async () => {
    voiceChannelOk()
    mocks.listParticipants.mockResolvedValueOnce([])
    await handleWebhookEvent(
      buildEvent({
        event: 'track_published',
        room: buildRoom(),
        participant: buildParticipant([
          { source: TrackSource.MICROPHONE, muted: false },
        ]),
      }),
    )
    expect(mocks.broadcastToServer).not.toHaveBeenCalled()
    expect(mocks.del).toHaveBeenCalledWith(
      `voice:channel:${CHANNEL_ID}:participants-cache`,
    )
  })

  it('room_finished clears Redis state, no broadcast', async () => {
    await handleWebhookEvent(
      buildEvent({ event: 'room_finished', room: buildRoom() }),
    )
    expect(mocks.del).toHaveBeenCalledWith(`voice:channel:${CHANNEL_ID}:users`)
    expect(mocks.del).toHaveBeenCalledWith(
      `voice:channel:${CHANNEL_ID}:participants-cache`,
    )
    expect(mocks.broadcastToServer).not.toHaveBeenCalled()
  })

  it('non-voice room names are ignored (no DB lookup, no broadcast)', async () => {
    await handleWebhookEvent(
      buildEvent({
        event: 'participant_joined',
        room: { name: 'chat-something' } as unknown as NonNullable<WebhookEvent['room']>,
        participant: buildParticipant(),
      }),
    )
    expect(mocks.channelLookup).not.toHaveBeenCalled()
    expect(mocks.broadcastToServer).not.toHaveBeenCalled()
  })

  it('channel lookup miss (deleted/text channel) → no broadcast', async () => {
    mocks.channelLookup.mockResolvedValueOnce([]) // nothing in DB
    await handleWebhookEvent(
      buildEvent({
        event: 'participant_joined',
        room: buildRoom(),
        participant: buildParticipant(),
      }),
    )
    expect(mocks.broadcastToServer).not.toHaveBeenCalled()
  })

  it('text channel masquerading as voice room → ignored', async () => {
    mocks.channelLookup.mockResolvedValueOnce([{ serverId: SERVER_ID, kind: 'text' }])
    await handleWebhookEvent(
      buildEvent({
        event: 'participant_joined',
        room: buildRoom(),
        participant: buildParticipant(),
      }),
    )
    expect(mocks.broadcastToServer).not.toHaveBeenCalled()
  })

  it('egress/ingress events are explicit no-ops (no warn)', async () => {
    const warn = vi.fn()
    for (const type of [
      'egress_started',
      'egress_updated',
      'egress_ended',
      'ingress_started',
      'ingress_ended',
      'room_started',
    ] as const) {
      await handleWebhookEvent(
        buildEvent({ event: type, room: buildRoom() }),
        { debug: () => {}, warn },
      )
    }
    expect(warn).not.toHaveBeenCalled()
    expect(mocks.broadcastToServer).not.toHaveBeenCalled()
  })

  it('truly unknown event type triggers a warn (so we catch SDK drift)', async () => {
    const warn = vi.fn()
    await handleWebhookEvent(
      buildEvent({ event: 'something_brand_new', room: buildRoom() }),
      { debug: () => {}, warn },
    )
    expect(warn).toHaveBeenCalled()
  })
})

describe('handleWebhookEvent — DM call-log (T-087)', () => {
  const OTHER_ID = '44444444-4444-4444-4444-444444444444'

  function parseMetaArg(): { initiator: string; startedAt: number; answered: boolean } {
    const call = mocks.set.mock.calls.find((c) => c[0] === DM_CALL_KEY)
    if (!call) throw new Error('redis.set was not called for the dm call-log key')
    return JSON.parse(call[1] as string) as { initiator: string; startedAt: number; answered: boolean }
  }

  it('first participant in a dm room records the initiator (answered=false)', async () => {
    mocks.get.mockResolvedValueOnce(null)
    await handleWebhookEvent(
      buildEvent({
        event: 'participant_joined',
        room: buildDmRoom(CHANNEL_ID, 1),
        participant: buildParticipant([], USER_ID),
      }),
    )
    const meta = parseMetaArg()
    expect(meta.initiator).toBe(USER_ID)
    expect(meta.answered).toBe(false)
    // DM-комнаты не трогают серверный voice-presence.
    expect(mocks.sadd).not.toHaveBeenCalled()
    expect(mocks.broadcastToServer).not.toHaveBeenCalled()
  })

  it('the other party joining flips answered=true', async () => {
    mocks.get.mockResolvedValueOnce(
      JSON.stringify({ initiator: USER_ID, startedAt: 1_000, answered: false }),
    )
    await handleWebhookEvent(
      buildEvent({
        event: 'participant_joined',
        room: buildDmRoom(CHANNEL_ID, 2),
        participant: buildParticipant([], OTHER_ID),
      }),
    )
    expect(parseMetaArg().answered).toBe(true)
  })

  it('last participant leaving an answered call posts the call-log immediately', async () => {
    mocks.listDmParticipants.mockResolvedValueOnce([]) // комната опустела
    mocks.get.mockResolvedValueOnce(
      JSON.stringify({ initiator: USER_ID, startedAt: Date.now() - 5_000, answered: true }),
    )
    mocks.channelLookup.mockResolvedValueOnce([{ kind: 'dm' }])
    mocks.insertReturning.mockResolvedValueOnce([{ id: 'sys-1', createdAt: new Date() }])
    await handleWebhookEvent(
      buildEvent({
        event: 'participant_left',
        room: buildDmRoom(CHANNEL_ID, 0),
        participant: buildParticipant([], OTHER_ID),
      }),
    )
    expect(mocks.del).toHaveBeenCalledWith(DM_CALL_KEY)
    expect(mocks.broadcastToChannel).toHaveBeenCalledWith(
      CHANNEL_ID,
      expect.objectContaining({
        t: 'msg.new',
        channelId: CHANNEL_ID,
        message: expect.objectContaining({ system: { kind: 'call', durationSec: expect.any(Number) } }),
      }),
    )
  })

  it('participant_left with peers still present does not finalize', async () => {
    mocks.listDmParticipants.mockResolvedValueOnce([{ userId: USER_ID }]) // ещё кто-то в комнате
    await handleWebhookEvent(
      buildEvent({
        event: 'participant_left',
        room: buildDmRoom(CHANNEL_ID, 1),
        participant: buildParticipant([], OTHER_ID),
      }),
    )
    expect(mocks.get).not.toHaveBeenCalled()
    expect(mocks.broadcastToChannel).not.toHaveBeenCalled()
  })

  it('an unanswered (never-picked-up) call is not logged', async () => {
    mocks.listDmParticipants.mockResolvedValueOnce([]) // комната опустела
    mocks.get.mockResolvedValueOnce(
      JSON.stringify({ initiator: USER_ID, startedAt: Date.now() - 5_000, answered: false }),
    )
    await handleWebhookEvent(
      buildEvent({
        event: 'participant_left',
        room: buildDmRoom(CHANNEL_ID, 0),
        participant: buildParticipant([], USER_ID),
      }),
    )
    expect(mocks.del).toHaveBeenCalledWith(DM_CALL_KEY)
    expect(mocks.broadcastToChannel).not.toHaveBeenCalled()
  })

  it('room_finished after the room already emptied is a no-op (dedup via del)', async () => {
    mocks.get.mockResolvedValueOnce(null) // ключ уже забрал participant_left
    await handleWebhookEvent(
      buildEvent({ event: 'room_finished', room: buildDmRoom(CHANNEL_ID, 0) }),
    )
    expect(mocks.broadcastToChannel).not.toHaveBeenCalled()
  })
})
