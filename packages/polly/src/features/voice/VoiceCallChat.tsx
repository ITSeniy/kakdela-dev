import { useMemo, useState } from 'react'
import { type InfiniteData, useQuery, useQueryClient } from '@tanstack/react-query'

import type { Attachment, Channel, GifEmbed, MemberPublic, Message, MessagesPage, StickerRef } from '@kakdela/ginzu/api-types'

import { Icon } from '../../components/Icon.js'
import { toast } from '../../components/toast/index.js'
import { useAuthStore } from '../auth/store.js'
import { Composer } from '../chat/Composer.js'
import { MessageList } from '../chat/MessageList.js'
import { addReaction, deleteMessage, editMessage, removeReaction, sendMessage } from '../chat/api.js'
import type { PendingMessage } from '../chat/types.js'
import { useServerEmoji } from '../emoji/api.js'
import { useProfileUi } from '../profile/store.js'
import { getServerDetail, listMembers } from '../servers/api.js'
import { useCallChatUi } from './callChatUi.js'

type MsgCache = InfiniteData<MessagesPage, string | undefined>

interface VoiceCallChatProps {
  serverId: string
  /** id голосового канала — у voice-канала тот же id, сообщения ходят
      через обычный chat API. */
  channelId: string
}

/**
 * Правая колонка «чат звонка» на голосовом экране (designs/final-voice.jsx,
 * KD_VoiceCallChat). Переиспользует MessageList/Composer из features/chat;
 * handlers — 1:1 паттерн из ChatScreen.tsx.
 */
export function VoiceCallChat({ serverId, channelId }: VoiceCallChatProps) {
  const queryClient = useQueryClient()
  const user = useAuthStore((s) => s.user)
  const openProfile = useProfileUi((s) => s.open)
  const width = useCallChatUi((s) => s.width)
  const setOpen = useCallChatUi((s) => s.setOpen)

  const [pending, setPending] = useState<PendingMessage[]>([])
  const [replyTo, setReplyTo] = useState<Message | null>(null)

  // Ресайз за левую кромку: глобальные listeners живут только на время drag.
  function startResize(e: React.MouseEvent) {
    e.preventDefault()
    const startX = e.clientX
    const startW = width
    const prevCursor = document.body.style.cursor
    const prevSelect = document.body.style.userSelect
    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'
    function onMove(ev: MouseEvent) {
      useCallChatUi.getState().setWidth(startW + (startX - ev.clientX))
    }
    function onUp() {
      document.body.style.cursor = prevCursor
      document.body.style.userSelect = prevSelect
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
    }
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
  }

  // Тот же queryKey, что в ChatScreen/Shell — TanStack Query отдаст из кэша.
  const { data: members = [] } = useQuery({
    queryKey: ['members', serverId],
    queryFn: () => listMembers(serverId),
    staleTime: 60_000,
  })

  const memberMap = useMemo(() => {
    const m = new Map<string, MemberPublic>()
    for (const x of members) m.set(x.id, x)
    return m
  }, [members])

  const { data: serverDetail } = useQuery({
    queryKey: ['server', serverId],
    queryFn: () => getServerDetail(serverId),
    staleTime: 30_000,
  })

  const channel = serverDetail?.channels.find((c) => c.id === channelId)

  const channelMap = useMemo(() => {
    const m = new Map<string, Channel>()
    for (const c of serverDetail?.channels ?? []) m.set(c.id, c)
    return m
  }, [serverDetail?.channels])

  const { emoji: serverEmoji, byName: emojiMap } = useServerEmoji(serverId)

  async function handleSend(content: string, attachments: Attachment[] = [], gif?: GifEmbed, sticker?: StickerRef) {
    if (!user) return
    const nonce = crypto.randomUUID()
    const replyId = replyTo?.id ?? null
    const optimistic: PendingMessage = {
      id: `pending:${nonce}`,
      channelId,
      authorId: user.id,
      content,
      replyToId: replyId,
      createdAt: new Date().toISOString(),
      editedAt: null,
      attachments,
      gif: gif ?? null,
      sticker: sticker ?? null,
      _pending: 'sending',
      _nonce: nonce,
    }
    setPending((p) => [...p, optimistic])
    setReplyTo(null)

    try {
      const sent = await sendMessage(channelId, {
        content,
        ...(replyId ? { replyToId: replyId } : {}),
        clientNonce: nonce,
        ...(attachments.length > 0 ? { attachments: attachments.map((a) => a.id) } : {}),
        ...(gif ? { gif } : {}),
        ...(sticker ? { sticker } : {}),
      })
      queryClient.setQueryData<MsgCache>(
        ['messages', channelId],
        (old) => {
          if (!old || old.pages.length === 0) return old
          const first = old.pages[0]
          if (!first || first.messages.some((m) => m.id === sent.id)) return old
          const pages = [...old.pages]
          pages[0] = { ...first, messages: [...first.messages, sent] }
          return { ...old, pages }
        },
      )
      setPending((p) => p.filter((x) => x._nonce !== nonce))
    } catch {
      setPending((p) =>
        p.map((x) => (x._nonce === nonce ? { ...x, _pending: 'error' as const } : x)),
      )
    }
  }

  function handleRetry(nonce: string) {
    const target = pending.find((p) => p._nonce === nonce)
    if (!target) return
    setPending((p) => p.filter((x) => x._nonce !== nonce))
    void handleSend(target.content, target.attachments)
  }

  async function handleEdit(id: string, newContent: string) {
    const snapshot = queryClient.getQueryData<MsgCache>(['messages', channelId])

    queryClient.setQueryData<MsgCache>(['messages', channelId], (old) => {
      if (!old) return old
      return {
        ...old,
        pages: old.pages.map((page) => ({
          ...page,
          messages: page.messages.map((m) =>
            m.id === id ? { ...m, content: newContent, editedAt: new Date().toISOString() } : m,
          ),
        })),
      }
    })

    try {
      await editMessage(id, newContent)
    } catch (err) {
      if (snapshot) queryClient.setQueryData(['messages', channelId], snapshot)
      toast.error('не удалось сохранить правку')
      console.error('[voice-chat] edit failed', err)
    }
  }

  function handleDelete(id: string) {
    // Подтверждение уже показано (см. Message.confirmDelete) — тут только
    // оптимистичное удаление с откатом при ошибке, без окна «отменить».
    const snapshot = queryClient.getQueryData<MsgCache>(['messages', channelId])
    queryClient.setQueryData<MsgCache>(['messages', channelId], (old) => {
      if (!old) return old
      return {
        ...old,
        pages: old.pages.map((page) => ({
          ...page,
          messages: page.messages.filter((m) => m.id !== id),
        })),
      }
    })
    deleteMessage(id).catch((err) => {
      if (snapshot) queryClient.setQueryData(['messages', channelId], snapshot)
      toast.error('не удалось удалить сообщение')
      console.error('[voice-chat] delete failed', err)
    })
  }

  async function handleAddReaction(messageId: string, emoji: string) {
    try {
      await addReaction(messageId, emoji)
    } catch (err) {
      toast.error('не удалось поставить реакцию')
      console.error('[voice-chat] add reaction failed', err)
    }
  }

  async function handleRemoveReaction(messageId: string, emoji: string) {
    try {
      await removeReaction(messageId, emoji)
    } catch (err) {
      toast.error('не удалось убрать реакцию')
      console.error('[voice-chat] remove reaction failed', err)
    }
  }

  return (
    <div
      className="relative shrink-0 min-h-0 flex flex-col bg-kd-panel border-l border-kd-border"
      style={{ width }}
    >
      {/* Ручка ресайза — невидимая полоса по левой кромке. */}
      <div
        onMouseDown={startResize}
        title="потяните, чтобы изменить ширину"
        className="absolute left-0 inset-y-0 w-1.5 -ml-0.5 cursor-col-resize z-10 hover:bg-kd-accent/40 transition-colors"
      />
      <div className="px-3 py-2 border-b border-kd-border flex items-center gap-1.5 shrink-0">
        <Icon.Hash size={12} className="text-kd-text-soft shrink-0" />
        <span className="text-[11px] font-bold text-kd-text truncate">чат звонка</span>
        <div className="flex-1" />
        <button
          type="button"
          onClick={() => setOpen(false)}
          title="скрыть чат"
          className="px-1.5 py-0.5 rounded text-[10px] font-mono text-kd-text-mute hover:text-kd-text hover:bg-kd-panel-hi transition-colors"
        >
          ✕
        </button>
      </div>
      <MessageList
        serverId={serverId}
        channelId={channelId}
        currentUserId={user?.id ?? null}
        memberMap={memberMap}
        channelMap={channelMap}
        emojiMap={emojiMap}
        pending={pending}
        onEdit={handleEdit}
        onDelete={handleDelete}
        onRetry={handleRetry}
        onReply={setReplyTo}
        onAddReaction={handleAddReaction}
        onRemoveReaction={handleRemoveReaction}
        onMention={openProfile}
      />
      <Composer
        channelName={channel?.name ?? ''}
        customEmoji={serverEmoji}
        channelId={channelId}
        memberMap={memberMap}
        allowBroadcast
        replyTo={replyTo}
        replyAuthor={replyTo ? memberMap.get(replyTo.authorId)?.displayName : undefined}
        onCancelReply={() => setReplyTo(null)}
        onSend={handleSend}
      />
    </div>
  )
}
