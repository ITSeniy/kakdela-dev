import { create } from 'zustand'

import type { User } from '@kakdela/ginzu'

export type AuthStatus = 'idle' | 'loading' | 'authed' | 'unauthed'

interface AuthState {
  user: User | null
  accessToken: string | null
  status: AuthStatus
  generation: number
}

interface AuthActions {
  setSession(user: User, accessToken: string): void
  clear(): void
  setStatus(s: AuthStatus): void
}

export const useAuthStore = create<AuthState & AuthActions>()((set) => ({
  user: null,
  accessToken: null,
  status: 'idle',
  generation: 0,

  setSession(user, accessToken) {
    set((state) => ({ user, accessToken, status: 'authed', generation: state.generation + (state.user?.id === user.id ? 0 : 1) }))
  },

  clear() {
    set((state) => ({ user: null, accessToken: null, status: 'unauthed', generation: state.generation + 1 }))
  },

  setStatus(status) {
    set({ status })
  },
}))
