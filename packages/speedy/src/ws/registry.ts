import type { Connection } from './connection.js'

class Registry {
  private readonly byUser = new Map<string, Set<Connection>>()
  private readonly byChannel = new Map<string, Set<Connection>>()
  private readonly byServer = new Map<string, Set<Connection>>()

  add(conn: Connection): void {
    this.addToMap(this.byUser, conn.userId, conn)
    for (const channelId of conn.subscribedChannels) {
      this.addToMap(this.byChannel, channelId, conn)
    }
    for (const serverId of conn.subscribedServers) {
      this.addToMap(this.byServer, serverId, conn)
    }
  }

  // Подписать существующее соединение на новый канал — используется, когда
  // у залогиненного user'а появляется новый DM-канал уже после hello.
  subscribeChannel(conn: Connection, channelId: string): void {
    if (conn.subscribedChannels.has(channelId)) return
    conn.subscribedChannels.add(channelId)
    this.addToMap(this.byChannel, channelId, conn)
  }

  // Подписать существующее соединение на сервер — используется при вступлении
  // по инвайту уже после hello, иначе новый участник не получает ни одного
  // server-события (presence, voice.*, role.update…) до реконнекта.
  subscribeServer(conn: Connection, serverId: string): void {
    if (conn.subscribedServers.has(serverId)) return
    conn.subscribedServers.add(serverId)
    this.addToMap(this.byServer, serverId, conn)
  }

  remove(conn: Connection): void {
    this.removeFromMap(this.byUser, conn.userId, conn)
    for (const channelId of conn.subscribedChannels) {
      this.removeFromMap(this.byChannel, channelId, conn)
    }
    for (const serverId of conn.subscribedServers) {
      this.removeFromMap(this.byServer, serverId, conn)
    }
  }

  /**
   * Отвязать ВСЕ соединения пользователя от сервера и его каналов
   * (leave/kick, аудит 2026-08 M-8): бывший участник не должен продолжать
   * получать msg.new/presence/voice.* , пока жив его сокет.
   */
  unsubscribeFromServer(userId: string, serverId: string, channelIds: readonly string[]): void {
    const conns = this.byUser.get(userId)
    if (!conns) return
    for (const conn of conns) {
      conn.subscribedServers.delete(serverId)
      this.removeFromMap(this.byServer, serverId, conn)
      for (const channelId of channelIds) {
        if (!conn.subscribedChannels.has(channelId)) continue
        conn.subscribedChannels.delete(channelId)
        this.removeFromMap(this.byChannel, channelId, conn)
      }
    }
  }

  /**
   * Отвязать все соединения всех подписчиков сервера (жёсткое удаление
   * сервера). Id каналов обязательны — после каскада их неоткуда взять.
   */
  dropServer(serverId: string, channelIds: readonly string[]): void {
    const conns = this.byServer.get(serverId)
    if (!conns) return
    // Копия: removeFromMap мутирует тот же set, который итерируем.
    for (const conn of [...conns]) {
      conn.subscribedServers.delete(serverId)
      this.removeFromMap(this.byServer, serverId, conn)
      for (const channelId of channelIds) {
        if (!conn.subscribedChannels.has(channelId)) continue
        conn.subscribedChannels.delete(channelId)
        this.removeFromMap(this.byChannel, channelId, conn)
      }
    }
  }

  forChannel(channelId: string): Connection[] {
    const set = this.byChannel.get(channelId)
    return set ? Array.from(set) : []
  }

  forServer(serverId: string): Connection[] {
    const set = this.byServer.get(serverId)
    return set ? Array.from(set) : []
  }

  forUser(userId: string): Connection[] {
    const set = this.byUser.get(userId)
    return set ? Array.from(set) : []
  }

  size(): number {
    let total = 0
    for (const set of this.byUser.values()) total += set.size
    return total
  }

  private addToMap(map: Map<string, Set<Connection>>, key: string, conn: Connection): void {
    let set = map.get(key)
    if (!set) {
      set = new Set()
      map.set(key, set)
    }
    set.add(conn)
  }

  private removeFromMap(map: Map<string, Set<Connection>>, key: string, conn: Connection): void {
    const set = map.get(key)
    if (!set) return
    set.delete(conn)
    if (set.size === 0) map.delete(key)
  }
}

export const registry = new Registry()
