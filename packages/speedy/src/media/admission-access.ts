import { and, eq, sql as sqlQuery } from 'drizzle-orm'

import { channels, dmChannels, serverMembers } from '../db/schema.js'
import { db } from '../lib/db.js'
import type { Admission } from './admission-token.js'

export class AdmissionDenied extends Error {
  constructor() {
    super('media access denied')
  }
}

/**
 * SFU elevation takes place under these locks. Kick/leave already lock/delete
 * the same membership row. Release buffered signaling only AFTER commit succeeds.
 * The caller must check socket liveness before/after the asynchronous SFU RPC.
 * No SDP or other client frames may reach the SFU before this callback succeeds.
 */
export async function withMediaAccess<T>(
  admission: Admission,
  activate: (serverId: string | null) => Promise<T>,
): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(sqlQuery`SET LOCAL statement_timeout = '3000ms'`)
    await tx.execute(sqlQuery`SET LOCAL idle_in_transaction_session_timeout = '10000ms'`)
    const [channel] = await tx
      .select({ kind: channels.kind, serverId: channels.serverId })
      .from(channels)
      .where(eq(channels.id, admission.channelId))
      .for('share')
    if (!channel || channel.kind !== admission.kind) throw new AdmissionDenied()
    if (admission.kind === 'voice') {
      if (!channel.serverId) throw new AdmissionDenied()
      const [member] = await tx
        .select({ userId: serverMembers.userId })
        .from(serverMembers)
        .where(
          and(
            eq(serverMembers.serverId, channel.serverId),
            eq(serverMembers.userId, admission.userId),
          ),
        )
        .for('share')
      if (!member) throw new AdmissionDenied()
    } else {
      const [dm] = await tx
        .select()
        .from(dmChannels)
        .where(eq(dmChannels.channelId, admission.channelId))
        .for('share')
      if (!dm || (dm.userAId !== admission.userId && dm.userBId !== admission.userId))
        throw new AdmissionDenied()
    }
    return activate(channel.serverId)
  })
}
