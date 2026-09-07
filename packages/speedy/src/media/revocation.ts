import { and, eq } from 'drizzle-orm'
import type { WebhookEvent } from 'livekit-server-sdk'

import { channels, serverMembers } from '../db/schema.js'
import { db } from '../lib/db.js'
import { redis } from '../lib/redis.js'
import { listActiveVoiceChannels, listParticipants, revokeUser, userIdFromIdentity } from './guido.js'

export interface RevocationLogger { warn: (obj: object, message: string) => void }
const NOOP_LOG: RevocationLogger = { warn: () => {} }

export async function hasVoiceAccess(channelId: string, userId: string): Promise<boolean> {
  const rows = await db.select({ userId: serverMembers.userId }).from(channels)
    .innerJoin(serverMembers, eq(serverMembers.serverId, channels.serverId))
    .where(and(eq(channels.id, channelId), eq(channels.kind, 'voice'), eq(serverMembers.userId, userId))).limit(1)
  return rows.length > 0
}

async function removeAndClear(channelId: string, userId: string, log: RevocationLogger): Promise<void> {
  // Do not let an unavailable Redis cache prevent the actual SFU removal.
  await revokeUser({ channelId, userId })
  try {
    await Promise.all([
      redis.srem(`voice:channel:${channelId}:users`, userId),
      redis.hdel(`voice:channel:${channelId}:mod`, userId),
      redis.del(`voice:channel:${channelId}:participants-cache`, `voice:channel:${channelId}:screen-preview:${userId}`),
    ])
  } catch (err) { log.warn({ err, channelId, userId }, 'voice cache cleanup failed after removal') }
}

/** Immediate removal after the membership transaction commits; do not hide failures. */
export async function revokeServerVoice(userId: string, serverId: string, log: RevocationLogger = NOOP_LOG): Promise<void> {
  const rooms = await db.select({ id: channels.id }).from(channels)
    .where(and(eq(channels.serverId, serverId), eq(channels.kind, 'voice')))
  const failures: unknown[] = []
  for (const room of rooms) {
    try { await removeAndClear(room.id, userId, log) } catch (err) { failures.push(err) }
  }
  if (failures.length) throw new AggregateError(failures, 'voice revocation pending; reconciliation will retry')
}

/**
 * An absence in PostgreSQL is durable retry state, even after worker restarts.
 * Enumerate LiveKit rooms, not just database channels, so orphaned rooms are covered.
 * This is eventual removal, NOT a signaling admission gate or JWT revocation.
 */
export async function reconcileVoiceAccess(log: RevocationLogger = NOOP_LOG): Promise<void> {
  const rooms = await listActiveVoiceChannels()
  const failures: unknown[] = []
  for (const channelId of rooms) {
    try {
      const users = new Set((await listParticipants(channelId)).map((p) => p.userId))
      for (const userId of users) {
        let allowed = false
        try { allowed = await hasVoiceAccess(channelId, userId) }
        catch (err) { log.warn({ err, channelId, userId }, 'voice access unavailable; failing closed') }
        if (!allowed) {
          try { await removeAndClear(channelId, userId, log) } catch (err) { failures.push(err) }
        }
      }
    } catch (err) { failures.push(err) }
  }
  if (failures.length) throw new AggregateError(failures, 'voice access reconciliation incomplete')
}

/** Run BEFORE webhook dedup: a retry must never skip the security decision. */
export async function enforceVoiceEventAccess(event: WebhookEvent, log: RevocationLogger = NOOP_LOG): Promise<boolean> {
  if (!['participant_joined', 'track_published', 'track_unpublished'].includes(event.event)) return true
  const match = /^voice-([0-9a-f-]{36})$/i.exec(event.room?.name ?? '')
  const identity = event.participant?.identity
  if (!match?.[1] || !identity) return true // DM has a separate access model.
  const channelId = match[1], userId = userIdFromIdentity(identity)
  let allowed: boolean
  try { allowed = await hasVoiceAccess(channelId, userId) }
  catch (err) {
    await removeAndClear(channelId, userId, log)
    throw err // Request a webhook retry after the database recovers.
  }
  if (allowed) return true
  await removeAndClear(channelId, userId, log)
  return false
}

export function startVoiceAccessReconciler(log: RevocationLogger): () => void {
  let running = false, stopped = false
  const run = () => {
    if (running || stopped) return
    running = true
    void reconcileVoiceAccess(log).catch((err: unknown) => log.warn({ err }, 'voice revocation retry failed'))
      .finally(() => { running = false })
  }
  const timer = setInterval(run, 5000)
  timer.unref()
  run()
  return () => { stopped = true; clearInterval(timer) }
}
