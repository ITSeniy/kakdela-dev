import { revokeServerVoice, type RevocationLogger } from '../media/revocation.js'
import { revokeConnection } from '../ws/access.js'
import { broadcastToServer } from '../ws/broadcast.js'
import { registry } from '../ws/registry.js'

/** Call only after membership removal commits. No client acknowledgement is trusted. */
export async function finishMemberRevocation(userId: string, serverId: string, log: RevocationLogger): Promise<boolean> {
  for (const conn of registry.forUser(userId)) revokeConnection(conn, registry, [serverId])
  // Broker delivery is an optimization. Every worker also checks PostgreSQL on send.
  void broadcastToServer(serverId, { t: 'member.leave', serverId, userId })
    .catch((err: unknown) => log.warn({ err, serverId, userId }, 'membership event publish failed; authoritative checks remain active'))
  try { await revokeServerVoice(userId, serverId, log) }
  catch (err) {
    log.warn({ err, serverId, userId }, 'membership removed; media revocation pending')
    return false
  }
  return true
}
