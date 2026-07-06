import { useEffect } from 'react'
import { type InfiniteData, useInfiniteQuery, useQueryClient } from '@tanstack/react-query'

import type { MessagesPage } from '@kakdela/ginzu/api-types'

import { wsClient } from '../../lib/ws.js'
import { useAuthStore } from '../auth/store.js'
import { listMessages } from './api.js'

const PAGE_SIZE = 50

type Cache = InfiniteData<MessagesPage, string | undefined>

export function useMessages(channelId: string | null) {
  const queryClient = useQueryClient()
  const selfId = useAuthStore((s) => s.user?.id ?? null)

  const query = useInfiniteQuery({
    queryKey: ['messages', channelId],
    enabled: channelId !== null,
    queryFn: ({ pageParam }) => listMessages(channelId!, { before: pageParam, limit: PAGE_SIZE }),
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
    initialPageParam: undefined as string | undefined,
    staleTime: 30_000,
  })

  useEffect(() => {
    if (!channelId) return undefined
    return wsClient.on((event) => {
      if (event.t === 'msg.new' && event.channelId === channelId) {
        queryClient.setQueryData<Cache>(['messages', channelId], (old) => {
          if (!old || old.pages.length === 0) return old
          const first = old.pages[0]
          if (!first || first.messages.some((m) => m.id === event.message.id)) return old
          const pages = [...old.pages]
          pages[0] = { ...first, messages: [...first.messages, event.message] }
          return { ...old, pages }
        })
        return
      }
      if (event.t === 'msg.edit' && event.channelId === channelId) {
        queryClient.setQueryData<Cache>(['messages', channelId], (old) => {
          if (!old) return old
          const pages = old.pages.map((page) => ({
            ...page,
            messages: page.messages.map((m) =>
              m.id === event.messageId
                ? { ...m, content: event.content, editedAt: event.editedAt }
                : m,
            ),
          }))
          return { ...old, pages }
        })
        return
      }
      if (event.t === 'msg.delete' && event.channelId === channelId) {
        queryClient.setQueryData<Cache>(['messages', channelId], (old) => {
          if (!old) return old
          const pages = old.pages.map((page) => ({
            ...page,
            messages: page.messages.filter((m) => m.id !== event.messageId),
          }))
          return { ...old, pages }
        })
        return
      }
      if (event.t === 'msg.pin' && event.channelId === channelId) {
        queryClient.setQueryData<Cache>(['messages', channelId], (old) => {
          if (!old) return old
          const pages = old.pages.map((page) => ({
            ...page,
            messages: page.messages.map((m) =>
              m.id === event.messageId ? { ...m, pinned: event.pinned, pinnedAt: event.pinnedAt } : m,
            ),
          }))
          return { ...old, pages }
        })
        // Список закреплённых в шапке держим свежим.
        void queryClient.invalidateQueries({ queryKey: ['pins', channelId] })
        return
      }
      // OG-превью досняты сервером — патчим linkPreviews у сообщения.
      if (event.t === 'msg.embeds' && event.channelId === channelId) {
        queryClient.setQueryData<Cache>(['messages', channelId], (old) => {
          if (!old) return old
          const pages = old.pages.map((page) => ({
            ...page,
            messages: page.messages.map((m) =>
              m.id === event.messageId ? { ...m, linkPreviews: event.linkPreviews } : m,
            ),
          }))
          return { ...old, pages }
        })
        return
      }
      if (event.t === 'reaction.add' && event.channelId === channelId) {
        queryClient.setQueryData<Cache>(['messages', channelId], (old) => {
          if (!old) return old
          const pages = old.pages.map((page) => ({
            ...page,
            messages: page.messages.map((m) => {
              if (m.id !== event.messageId) return m
              const cur = m.reactions ?? []
              const existing = cur.find((r) => r.emoji === event.emoji)
              // Идемпотентно: useMessages с одним queryKey монтируется в
              // нескольких компонентах (DmScreen + DmBubbleList), и каждый
              // экземпляр применяет событие к общему кэшу — повторное
              // применение не должно дублировать реакцию.
              if (existing?.users.includes(event.userId)) return m
              if (existing) {
                return {
                  ...m,
                  reactions: cur.map((r) =>
                    r.emoji === event.emoji
                      ? { ...r, count: r.count + 1, users: [...r.users, event.userId] }
                      : r,
                  ),
                }
              }
              return { ...m, reactions: [...cur, { emoji: event.emoji, count: 1, users: [event.userId] }] }
            }),
          }))
          return { ...old, pages }
        })
        return
      }
      if (event.t === 'reaction.remove' && event.channelId === channelId) {
        queryClient.setQueryData<Cache>(['messages', channelId], (old) => {
          if (!old) return old
          const pages = old.pages.map((page) => ({
            ...page,
            messages: page.messages.map((m) => {
              if (m.id !== event.messageId) return m
              const cur = m.reactions ?? []
              // Идемпотентно (см. reaction.add): второй экземпляр обработчика
              // не должен списать реакцию ещё раз.
              const existing = cur.find((r) => r.emoji === event.emoji)
              if (!existing || !existing.users.includes(event.userId)) return m
              const reactions = cur
                .map((r) => {
                  if (r.emoji !== event.emoji) return r
                  const users = r.users.filter((u) => u !== event.userId)
                  if (users.length === 0) return null
                  return { ...r, count: users.length, users }
                })
                .filter((r): r is NonNullable<typeof r> => r !== null)
              return { ...m, reactions }
            }),
          }))
          return { ...old, pages }
        })
        return
      }
      // Голос в опросе: заменяем счётчики свежими (полный пересчёт сервера),
      // myVote патчим только для собственных голосов (другие устройства).
      if (event.t === 'poll.vote' && event.channelId === channelId) {
        queryClient.setQueryData<Cache>(['messages', channelId], (old) => {
          if (!old) return old
          const pages = old.pages.map((page) => ({
            ...page,
            messages: page.messages.map((m) => {
              if (m.id !== event.messageId || !m.poll) return m
              const options = m.poll.options.map((o, i) => ({ ...o, votes: event.votes[i] ?? 0 }))
              return {
                ...m,
                poll: {
                  ...m.poll,
                  options,
                  totalVotes: event.votes.reduce((sum, v) => sum + v, 0),
                  myVote: event.voterId === selfId ? event.option : m.poll.myVote,
                },
              }
            }),
          }))
          return { ...old, pages }
        })
        return
      }
      // RSVP на встрече: заменяем списки свежими; myRsvp — только свой.
      if (event.t === 'event.rsvp' && event.channelId === channelId) {
        queryClient.setQueryData<Cache>(['messages', channelId], (old) => {
          if (!old) return old
          const pages = old.pages.map((page) => ({
            ...page,
            messages: page.messages.map((m) => {
              if (m.id !== event.messageId || !m.event) return m
              return {
                ...m,
                event: {
                  ...m.event,
                  going: event.going,
                  declined: event.declined,
                  myRsvp: event.voterId === selfId ? event.rsvp : m.event.myRsvp,
                },
              }
            }),
          }))
          return { ...old, pages }
        })
        return
      }
      // Тред создан/архивирован на сообщении в этом канале — рефетчим, чтобы
      // у parent message обновился бейдж «N сообщений».
      if (event.t === 'thread.new' && event.parentChannelId === channelId) {
        void queryClient.invalidateQueries({ queryKey: ['messages', channelId] })
        return
      }
      if (event.t === 'thread.archive' && event.parentChannelId === channelId) {
        void queryClient.invalidateQueries({ queryKey: ['messages', channelId] })
      }
    })
  }, [channelId, queryClient, selfId])

  return query
}
