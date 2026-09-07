// Жизненный цикл WS-подписок участника на сервер (аудит 2026-08, M-7/8/9).
//
// Подписки выдаются на hello из членства в БД. Для событий ПОСЛЕ hello нужен
// hot-attach (вступление/создание сервера), а при выходе/кике/удалении —
// обратная операция: без неё бывший участник продолжает получать msg.new,
// presence и voice.* сервера, пока жив его сокет.

import { eq } from 'drizzle-orm'

import { channels } from '../db/schema.js'
import { db } from '../lib/db.js'
import { registry } from './registry.js'
import { withUserAccess } from './access.js'

export async function serverChannelIds(serverId: string): Promise<string[]> {
  const rows = await db
    .select({ id: channels.id })
    .from(channels)
    .where(eq(channels.serverId, serverId))
  return rows.map((r) => r.id)
}

/**
 * Hot-attach живых соединений пользователя на сервер и все его каналы.
 * Вызывается при вступлении по инвайту и при СОЗДАНИИ сервера (создатель —
 * тоже участник, его сокет стоит в очереди до hello).
 */
export async function attachUserToServer(userId: string, serverId: string): Promise<void> {
  const conns = registry.forUser(userId)
  if (conns.length === 0) return
  const channelIds = await serverChannelIds(serverId)
  await withUserAccess([userId], (snapshots) => {
    const access = snapshots.get(userId)
    if (!access?.exists || !access.servers.has(serverId)) return
    for (const conn of registry.forUser(userId)) {
      if (!conn.isActive) continue
      registry.subscribeServer(conn, serverId)
      for (const channelId of channelIds) {
        if (access.channels.has(channelId)) registry.subscribeChannel(conn, channelId)
      }
    }
  })
}

/**
 * Отвязать все соединения пользователя от сервера и его каналов (leave/kick).
 * Звать ДО/сразу после удаления membership — каналы сервера ещё существуют,
 * так что список id достаётся из БД самостоятельно.
 */
export async function detachUserFromServer(userId: string, serverId: string): Promise<void> {
  const channelIds = await serverChannelIds(serverId)
  registry.unsubscribeFromServer(userId, serverId, channelIds)
}

/**
 * Отвязать ВСЕ соединения всех подписчиков (жёсткое удаление сервера).
 * Id каналов обязательны: после каскада их уже не достать из БД — передавайте
 * то, что собрал `serverChannelIds` ДО удаления.
 */
export function dropServerSubscriptions(serverId: string, channelIds: readonly string[]): void {
  registry.dropServer(serverId, channelIds)
}
