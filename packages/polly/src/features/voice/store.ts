import { create } from 'zustand'
import { persist } from 'zustand/middleware'

import type { VoiceParticipantPublic } from '@kakdela/ginzu/api-types'

export type VoiceStatus = 'idle' | 'connecting' | 'connected' | 'reconnecting' | 'failed'

export interface ParticipantState {
  userId: string
  displayName: string
  isSpeaking: boolean
  isScreenSharing: boolean
  // Включена веб-камера (Track.Source.Camera). Состояние чисто из LiveKit —
  // сервер про камеру не знает.
  isCameraOn: boolean
  isMuted: boolean
  // Серверная модерация (admin mute/deafen) — приходит по WS voice.mod.
  serverMuted: boolean
  serverDeafened: boolean
}

interface VoiceState {
  activeChannelId: string | null
  /** Сервер активного голосового канала — для VoiceDock (имя/телепорт). */
  activeServerId: string | null
  // Контекст активной сессии: серверный голос-канал или личный звонок (T-087).
  activeContext: 'channel' | 'dm'
  // Собеседник активного DM-звонка — для шапки звонка, дока и тоста.
  activeDmUserId: string | null
  activeDmUserName: string | null
  activeDmAvatarUrl: string | null
  status: VoiceStatus
  muted: boolean
  deafened: boolean
  // Был ли мик заглушен отдельно ДО deafen. Un-deafen возвращает мик в это
  // состояние: глушили только наушниками — мик включится обратно, глушили
  // мик отдельно — останется заглушенным (Discord-семантика).
  mutedBeforeDeafen: boolean
  // Меня заглушил админ (серверная модерация): свои тумблеры заблокированы,
  // пока админ не снимет. Не персистится — состояние живёт на сервере.
  forcedMuted: boolean
  forcedDeafened: boolean
  // Был ли мик заглушен САМИМ клиентом до того, как админ форсировал мьют.
  // Снятие форс-мьюта возвращает мик именно в это состояние, а не всегда
  // «включено» — иначе админский unmute стирал бы собственный self-mute.
  mutedBeforeForced: boolean
  screenSharing: boolean
  // Моя веб-камера включена (зеркалит реальную публикацию Camera-трека).
  cameraOn: boolean
  // PTT — пользователь сейчас удерживает hotkey. Только в memory: при
  // перезапуске сам по себе не «зажат».
  pttHolding: boolean
  // Я сейчас говорю — по ЛОКАЛЬНОМУ анализу микрофона (см. lib/livekit.ts,
  // startLocalSpeakingMeter). Серверный ActiveSpeakers приходит с задержкой
  // ~300-500ms; своё кольцо должно загораться мгновенно.
  selfSpeaking: boolean
  participants: Map<string, ParticipantState>
  activeSpeakers: Set<string>
  // Чьи демки Я смотрю (opt-in подписка на screen-треки).
  watchedScreens: Set<string>
  // Кто что смотрит: watcherId → список streamerId (из data-сообщений).
  watchingByUser: Map<string, string[]>
  // identity того участника, чей screen share «закреплён» в фокусе. Не
  // персистится — пин живёт только в текущей сессии театрального режима.
  pinnedScreenUserId: string | null
  error: string | null
}

interface VoiceActions {
  reset(): void
  setStatus(status: VoiceStatus): void
  setError(err: string | null): void
  setActiveChannelId(id: string | null): void
  setActiveServerId(id: string | null): void
  setActiveContext(ctx: 'channel' | 'dm'): void
  setActiveDmPeer(peer: { id: string; name: string; avatarUrl: string | null } | null): void
  setMuted(muted: boolean): void
  setDeafened(deafened: boolean): void
  setMutedBeforeDeafen(m: boolean): void
  setMutedBeforeForced(m: boolean): void
  setForced(muted: boolean, deafened: boolean): void
  setScreenSharing(s: boolean): void
  setCameraOn(on: boolean): void
  setPinnedScreenUserId(id: string | null): void
  setPttHolding(holding: boolean): void
  setSelfSpeaking(speaking: boolean): void
  setWatchedScreen(userId: string, watch: boolean): void
  setWatching(watcherId: string, streamerIds: string[]): void
  setActiveSpeakers(ids: Iterable<string>): void
  upsertParticipant(p: Partial<ParticipantState> & { userId: string; displayName: string }): void
  patchParticipant(userId: string, patch: Partial<Omit<ParticipantState, 'userId'>>): void
  removeParticipant(userId: string): void
  applySnapshot(items: VoiceParticipantPublic[]): void
}

const initialState: VoiceState = {
  activeChannelId: null,
  activeServerId: null,
  activeContext: 'channel',
  activeDmUserId: null,
  activeDmUserName: null,
  activeDmAvatarUrl: null,
  status: 'idle',
  muted: false,
  deafened: false,
  mutedBeforeDeafen: false,
  forcedMuted: false,
  forcedDeafened: false,
  mutedBeforeForced: false,
  screenSharing: false,
  cameraOn: false,
  pttHolding: false,
  selfSpeaking: false,
  participants: new Map(),
  activeSpeakers: new Set(),
  watchedScreens: new Set(),
  watchingByUser: new Map(),
  pinnedScreenUserId: null,
  error: null,
}

// LiveKit убирает участника из ActiveSpeakers сразу же, как только звук стих —
// даже на коротких паузах между словами. Чтобы кольцо вокруг тайла не моргало,
// мы откладываем «погасание» на 500ms; если за это время участник снова заго-
// ворит, таймер отменяется. Таймеры держим в модуле, чтобы не сериализовать
// их вместе со state.
const SPEAKER_OFF_DELAY_MS = 500
const pendingSpeakerOff = new Map<string, ReturnType<typeof setTimeout>>()

function cancelSpeakerOff(userId: string): void {
  const t = pendingSpeakerOff.get(userId)
  if (t) {
    clearTimeout(t)
    pendingSpeakerOff.delete(userId)
  }
}

function cancelAllSpeakerOffs(): void {
  for (const t of pendingSpeakerOff.values()) clearTimeout(t)
  pendingSpeakerOff.clear()
}

export const useVoiceStore = create<VoiceState & VoiceActions>()(persist((set) => ({
  ...initialState,

  reset() {
    cancelAllSpeakerOffs()
    // Не сохраняем error/lastChannel — это идеальная очистка после leave.
    // muted/deafened — пользовательские тумблеры (UserBar/VoiceControls),
    // они переживают сессию как в Discord: заглушился — останешься
    // заглушённым и в следующем звонке.
    set((state) => ({
      ...initialState,
      muted: state.muted,
      deafened: state.deafened,
      mutedBeforeDeafen: state.mutedBeforeDeafen,
      participants: new Map(),
      activeSpeakers: new Set(),
      watchedScreens: new Set(),
      watchingByUser: new Map(),
    }))
  },

  setStatus(status) {
    set({ status })
  },

  setError(err) {
    set({ error: err })
  },

  setActiveChannelId(id) {
    set({ activeChannelId: id })
  },

  setActiveServerId(id) {
    set({ activeServerId: id })
  },

  setActiveContext(ctx) {
    set({ activeContext: ctx })
  },

  setActiveDmPeer(peer) {
    set({
      activeDmUserId: peer?.id ?? null,
      activeDmUserName: peer?.name ?? null,
      activeDmAvatarUrl: peer?.avatarUrl ?? null,
    })
  },

  setMuted(muted) {
    set({ muted })
  },

  setDeafened(deafened) {
    set({ deafened })
  },

  setMutedBeforeDeafen(m) {
    set({ mutedBeforeDeafen: m })
  },

  setMutedBeforeForced(m) {
    set({ mutedBeforeForced: m })
  },

  setForced(muted, deafened) {
    set({ forcedMuted: muted, forcedDeafened: deafened })
  },

  setScreenSharing(s) {
    set({ screenSharing: s })
  },

  setCameraOn(on) {
    set({ cameraOn: on })
  },

  setPinnedScreenUserId(id) {
    set({ pinnedScreenUserId: id })
  },

  setPttHolding(holding) {
    set({ pttHolding: holding })
  },

  setSelfSpeaking(speaking) {
    set((state) => (state.selfSpeaking === speaking ? state : { selfSpeaking: speaking }))
  },

  setWatchedScreen(userId, watch) {
    set((state) => {
      if (state.watchedScreens.has(userId) === watch) return state
      const next = new Set(state.watchedScreens)
      if (watch) next.add(userId)
      else next.delete(userId)
      return { watchedScreens: next }
    })
  },

  setWatching(watcherId, streamerIds) {
    set((state) => {
      const next = new Map(state.watchingByUser)
      if (streamerIds.length === 0) next.delete(watcherId)
      else next.set(watcherId, streamerIds)
      return { watchingByUser: next }
    })
  },

  setActiveSpeakers(ids) {
    const incoming = new Set(ids)
    set((state) => {
      const next = new Set(state.activeSpeakers)
      // Появление участника в эфире — применяем сразу и сбрасываем
      // pending-off если был.
      for (const id of incoming) {
        cancelSpeakerOff(id)
        next.add(id)
      }
      // Отсутствие — ставим таймер на 500ms. При следующем setActiveSpeakers
      // с этим же id таймер отменится в первой ветке выше.
      for (const id of state.activeSpeakers) {
        if (incoming.has(id)) continue
        if (pendingSpeakerOff.has(id)) continue
        const timer = setTimeout(() => {
          pendingSpeakerOff.delete(id)
          set((s) => {
            if (!s.activeSpeakers.has(id)) return s
            const cleaned = new Set(s.activeSpeakers)
            cleaned.delete(id)
            return { activeSpeakers: cleaned }
          })
        }, SPEAKER_OFF_DELAY_MS)
        pendingSpeakerOff.set(id, timer)
      }
      return { activeSpeakers: next }
    })
  },

  upsertParticipant(p) {
    set((state) => {
      const existing = state.participants.get(p.userId)
      const next = new Map(state.participants)
      next.set(p.userId, {
        userId: p.userId,
        displayName: p.displayName,
        isSpeaking: p.isSpeaking ?? existing?.isSpeaking ?? false,
        isScreenSharing: p.isScreenSharing ?? existing?.isScreenSharing ?? false,
        isCameraOn: p.isCameraOn ?? existing?.isCameraOn ?? false,
        isMuted: p.isMuted ?? existing?.isMuted ?? false,
        serverMuted: p.serverMuted ?? existing?.serverMuted ?? false,
        serverDeafened: p.serverDeafened ?? existing?.serverDeafened ?? false,
      })
      return { participants: next }
    })
  },

  patchParticipant(userId, patch) {
    set((state) => {
      const existing = state.participants.get(userId)
      if (!existing) return state
      const next = new Map(state.participants)
      next.set(userId, { ...existing, ...patch })
      return { participants: next }
    })
  },

  removeParticipant(userId) {
    cancelSpeakerOff(userId)
    set((state) => {
      if (!state.participants.has(userId)) return state
      const next = new Map(state.participants)
      next.delete(userId)
      const speakers = new Set(state.activeSpeakers)
      speakers.delete(userId)
      // Ушёл — чистим и его watch-список, и его демку из моих просмотров.
      const watchedScreens = new Set(state.watchedScreens)
      watchedScreens.delete(userId)
      const watchingByUser = new Map(state.watchingByUser)
      watchingByUser.delete(userId)
      // Если ушёл pinned-демонстрирующий — снимаем пин, чтобы focus не
      // ушёл в пустоту в театральном режиме. computeLayout сам бы тоже
      // отработал корректно, но явная очистка экономит лишний фолбэк.
      const pinnedScreenUserId =
        state.pinnedScreenUserId === userId ? null : state.pinnedScreenUserId
      return { participants: next, activeSpeakers: speakers, pinnedScreenUserId, watchedScreens, watchingByUser }
    })
  },

  applySnapshot(items) {
    // Снапшот = новая комната или ре-джойн. Любые висящие debounce-таймеры
    // от предыдущей сессии больше не актуальны.
    cancelAllSpeakerOffs()
    const next = new Map<string, ParticipantState>()
    for (const item of items) {
      next.set(item.userId, {
        userId: item.userId,
        displayName: item.displayName,
        isSpeaking: false,
        isScreenSharing: item.isScreenSharing,
        isCameraOn: false,
        isMuted: item.isMuted,
        serverMuted: item.serverMuted,
        serverDeafened: item.serverDeafened,
      })
    }
    set({ participants: next, activeSpeakers: new Set() })
  },
}), {
  name: 'kd:voice:prefs',
  // Персистим только пользовательские тумблеры — остальное session-state
  // (Map/Set участников всё равно несериализуемы).
  partialize: (s) => ({
    muted: s.muted,
    deafened: s.deafened,
    mutedBeforeDeafen: s.mutedBeforeDeafen,
  }),
}))
