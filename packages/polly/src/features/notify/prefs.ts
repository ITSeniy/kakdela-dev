// Локальные предпочтения нативных уведомлений. Гейтят триггеры в triggers.ts;
// tray-badge и инбокс работают всегда — выключаются только всплывашки ОС.
// Мьюты каналов/серверов — тоже локальные (per-device): глушат тосты, звук и
// unread-точку канала, но НЕ бейджи @упоминаний — они личные и важные.

import { create } from 'zustand'
import { persist } from 'zustand/middleware'

/** «Навсегда» для мьюта: JSON-сериализуемый суррогат бесконечности. */
export const MUTE_FOREVER = Number.MAX_SAFE_INTEGER

/** Пресеты длительности мьюта для меню (label → мс от «сейчас»). */
export const MUTE_PRESETS: { label: string; ms: number }[] = [
  { label: 'на 1 час',   ms: 3_600_000 },
  { label: 'на 8 часов', ms: 8 * 3_600_000 },
  { label: 'на 24 часа', ms: 24 * 3_600_000 },
  { label: 'навсегда',   ms: MUTE_FOREVER },
]

interface NotifyPrefs {
  /** Уведомлять при @упоминании. */
  mentions: boolean
  /** Уведомлять о новых личных сообщениях. */
  dms: boolean
  /** Серверы с подпиской «все сообщения»: serverId → true. По умолчанию для
      серверов приходят только упоминания; здесь — каждое сообщение. */
  serverAll: Record<string, boolean>
  /** Замьюченные каналы (и DM-диалоги): channelId → epoch-мс окончания
      (MUTE_FOREVER = бессрочно). Истёкшие записи чистятся лениво при мутациях. */
  mutedChannels: Record<string, number>
  /** Замьюченные сервера целиком: serverId → epoch-мс окончания. */
  mutedServers: Record<string, number>
  setMentions(on: boolean): void
  setDms(on: boolean): void
  setServerAll(serverId: string, on: boolean): void
  muteChannel(channelId: string, untilMs: number): void
  unmuteChannel(channelId: string): void
  muteServer(serverId: string, untilMs: number): void
  unmuteServer(serverId: string): void
}

function withoutExpired(map: Record<string, number>): Record<string, number> {
  const now = Date.now()
  const next: Record<string, number> = {}
  for (const [id, until] of Object.entries(map)) {
    if (until > now) next[id] = until
  }
  return next
}

export const useNotifyPrefs = create<NotifyPrefs>()(
  persist(
    (set) => ({
      mentions: true,
      dms: true,
      serverAll: {},
      mutedChannels: {},
      mutedServers: {},
      setMentions: (mentions) => set({ mentions }),
      setDms: (dms) => set({ dms }),
      setServerAll: (serverId, on) =>
        set((s) => {
          const next = { ...s.serverAll }
          if (on) next[serverId] = true
          else delete next[serverId]
          return { serverAll: next }
        }),
      muteChannel: (channelId, untilMs) =>
        set((s) => ({ mutedChannels: { ...withoutExpired(s.mutedChannels), [channelId]: untilMs } })),
      unmuteChannel: (channelId) =>
        set((s) => {
          const next = withoutExpired(s.mutedChannels)
          delete next[channelId]
          return { mutedChannels: next }
        }),
      muteServer: (serverId, untilMs) =>
        set((s) => ({ mutedServers: { ...withoutExpired(s.mutedServers), [serverId]: untilMs } })),
      unmuteServer: (serverId) =>
        set((s) => {
          const next = withoutExpired(s.mutedServers)
          delete next[serverId]
          return { mutedServers: next }
        }),
    }),
    { name: 'kd:notify:prefs' },
  ),
)

/** Активен ли мьют прямо сейчас (запись есть и не истекла). */
export function isMuteActive(until: number | undefined): boolean {
  return until !== undefined && until > Date.now()
}

export function isChannelMuted(channelId: string): boolean {
  return isMuteActive(useNotifyPrefs.getState().mutedChannels[channelId])
}

export function isServerMuted(serverId: string): boolean {
  return isMuteActive(useNotifyPrefs.getState().mutedServers[serverId])
}

/** Момент окончания мьюта из пресета: «навсегда» не суммируем с Date.now(). */
export function muteUntilFromPreset(presetMs: number): number {
  return presetMs === MUTE_FOREVER ? MUTE_FOREVER : Date.now() + presetMs
}

/** Подпись «мьют до …» для меню. */
export function muteUntilLabel(until: number): string {
  if (until === MUTE_FOREVER) return 'навсегда'
  const d = new Date(until)
  const hh = String(d.getHours()).padStart(2, '0')
  const mm = String(d.getMinutes()).padStart(2, '0')
  return `до ${hh}:${mm}`
}
