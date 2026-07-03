import { useMemo, useState } from 'react'
import { type InfiniteData, useQuery, useQueryClient } from '@tanstack/react-query'

import type {
  Attachment,
  Channel,
  GifEmbed,
  MemberPublic,
  Message,
  MessagesPage,
  StickerRef,
} from '@kakdela/ginzu/api-types'

import { confirmDialog } from '../../components/ConfirmDialog.js'
import { Icon } from '../../components/Icon.js'
import { toast } from '../../components/toast/index.js'
import { useAuthStore } from '../auth/store.js'
import { addReaction, deleteMessage, editMessage, removeReaction, sendMessage } from '../chat/api.js'
import { Composer } from '../chat/Composer.js'
import { MessageList } from '../chat/MessageList.js'
import type { PendingMessage } from '../chat/types.js'
import { useServerEmoji } from '../emoji/api.js'
import { useProfileUi } from '../profile/store.js'
import { listRoles } from '../roles/api.js'
import { listMembers } from '../servers/api.js'
import { archiveThread, listThreads } from './api.js'
import { useThreadUi } from './store.js'

type MsgCache = InfiniteData<MessagesPage, string | undefined>

interface ThreadPanelProps {
  threadId: string
  parentChannelId: string
  serverId: string | null
}

function HeaderBranchIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" width={14} height={14}>
      <path d="M6 3v12" />
      <circle cx="18" cy="6" r="3" />
      <circle cx="6" cy="18" r="3" />
      <path d="M18 9a9 9 0 0 1-9 9" />
    </svg>
  )
}

export function ThreadPanel({ threadId, parentChannelId, serverId }: ThreadPanelProps) {
  const queryClient = useQueryClient()
  const user = useAuthStore((s) => s.user)
  const close = useThreadUi((s) => s.close)
  const openProfile = useProfileUi((s) => s.open)

  const [pending, setPending] = useState<PendingMessage[]>([])
  const [replyTo, setReplyTo] = useState<Message | null>(null)

  // Тред идёт по тому же endpoint'у /api/channels/:id/threads — каждая
  // запись содержит channel + parentMessageId; берём только нужный
  // (TanStack дедуплицирует по queryKey с ThreadList).
  const { data: threads = [] } = useQuery({
    queryKey: ['threads', parentChannelId],
    queryFn: () => listThreads(parentChannelId, true),
    staleTime: 30_000,
  })
  const summary = threads.find((t) => t.channel.id === threadId)
  const channelInfo = summary?.channel

  const { data: members = [] } = useQuery({
    queryKey: ['members', serverId],
    queryFn: () => listMembers(serverId!),
    enabled: serverId !== null,
    staleTime: 60_000,
  })

  const memberMap = useMemo(() => {
    const m = new Map<string, MemberPublic>()
    for (const x of members) m.set(x.id, x)
    return m
  }, [members])

  const emptyChannelMap = useMemo(() => new Map<string, Channel>(), [])

  const { emoji: serverEmoji, byName: emojiMap } = useServerEmoji(serverId)

  const { data: allRoles = [] } = useQuery({
    queryKey: ['roles', serverId],
    queryFn: () => listRoles(serverId!),
    enabled: serverId !== null,
    staleTime: 30_000,
  })
  const roles = useMemo(() => allRoles.filter((r) => !r.isEveryone), [allRoles])

  async function handleSend(content: string, attachments: Attachment[] = [], gif?: GifEmbed, sticker?: StickerRef) {
    if (!user) return
    const nonce = crypto.randomUUID()
    const replyId = replyTo?.id ?? null
    const optimistic: PendingMessage = {
      id: `pending:${nonce}`,
      channelId: threadId,
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
      const sent = await sendMessage(threadId, {
        content,
        ...(replyId ? { replyToId: replyId } : {}),
        clientNonce: nonce,
        ...(attachments.length > 0 ? { attachments: attachments.map((a) => a.id) } : {}),
        ...(gif ? { gif } : {}),
        ...(sticker ? { sticker } : {}),
      })
      queryClient.setQueryData<MsgCache>(['messages', threadId], (old) => {
        if (!old || old.pages.length === 0) return old
        const first = old.pages[0]
        if (!first || first.messages.some((m) => m.id === sent.id)) return old
        const pages = [...old.pages]
        pages[0] = { ...first, messages: [...first.messages, sent] }
        return { ...old, pages }
      })
      setPending((p) => p.filter((x) => x._nonce !== nonce))
      // Бейдж на parent сообщении / список тредов — обновить счётчик.
      void queryClient.invalidateQueries({ queryKey: ['messages', parentChannelId] })
      void queryClient.invalidateQueries({ queryKey: ['threads', parentChannelId] })
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
    const snapshot = queryClient.getQueryData<MsgCache>(['messages', threadId])
    queryClient.setQueryData<MsgCache>(['messages', threadId], (old) => {
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
      if (snapshot) queryClient.setQueryData(['messages', threadId], snapshot)
      toast.error('не удалось сохранить правку')
      console.error('[thread] edit failed', err)
    }
  }

  function handleDelete(id: string) {
    // Подтверждение уже показано (см. Message.confirmDelete) — тут только
    // оптимистичное удаление с откатом при ошибке, без окна «отменить».
    const snapshot = queryClient.getQueryData<MsgCache>(['messages', threadId])
    queryClient.setQueryData<MsgCache>(['messages', threadId], (old) => {
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
      if (snapshot) queryClient.setQueryData(['messages', threadId], snapshot)
      toast.error('не удалось удалить сообщение')
      console.error('[thread] delete failed', err)
    })
  }

  async function handleAddReaction(messageId: string, emoji: string) {
    try {
      await addReaction(messageId, emoji)
    } catch (err) {
      toast.error('не удалось поставить реакцию')
      console.error('[thread] add reaction failed', err)
    }
  }
  async function handleRemoveReaction(messageId: string, emoji: string) {
    try {
      await removeReaction(messageId, emoji)
    } catch (err) {
      toast.error('не удалось убрать реакцию')
      console.error('[thread] remove reaction failed', err)
    }
  }

  async function onArchive() {
    if (!(await confirmDialog({
      title: 'архивировать тред?',
      body: 'тред останется в списке «архив», его можно будет вернуть.',
      confirmLabel: 'архивировать',
    }))) return
    await archiveThread(threadId, true)
    void queryClient.invalidateQueries({ queryKey: ['threads', parentChannelId] })
    void queryClient.invalidateQueries({ queryKey: ['messages', parentChannelId] })
    close()
  }

  const isArchived = channelInfo?.archivedAt != null
  const titleName = channelInfo?.name ?? 'тред'

  return (
    <aside className="bg-kd-panel border-l border-kd-border flex flex-col min-h-0">
      <div className="px-3 py-2 border-b border-kd-border bg-kd-panel-alt flex items-center gap-2 shrink-0">
        <span className="text-kd-text-mute"><HeaderBranchIcon /></span>
        <div className="min-w-0 flex-1">
          <div className="text-[13px] font-bold text-kd-text truncate">{titleName}</div>
          <div className="text-[10px] text-kd-text-mute font-mono">
            тред{isArchived ? ' · архив' : ''}
            {summary && <> · {summary.messageCount} {summary.messageCount === 1 ? 'сообщ.' : 'сообщ.'}</>}
          </div>
        </div>
        {!isArchived && (
          <button
            type="button"
            onClick={() => void onArchive()}
            title="архивировать"
            className="text-kd-text-mute hover:text-kd-text transition-colors p-1"
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" width={13} height={13}>
              <polyline points="21 8 21 21 3 21 3 8" />
              <rect x="1" y="3" width="22" height="5" />
              <line x1="10" y1="12" x2="14" y2="12" />
            </svg>
          </button>
        )}
        <button
          type="button"
          onClick={close}
          title="закрыть · esc"
          className="text-kd-text-mute hover:text-kd-text px-1"
        >
          <Icon.X size={13} />
        </button>
      </div>
      <MessageList
        serverId={serverId ?? ''}
        channelId={threadId}
        currentUserId={user?.id ?? null}
        memberMap={memberMap}
        channelMap={emptyChannelMap}
        emojiMap={emojiMap}
        roles={roles}
        pending={pending}
        threadsAllowed={false}
        onMention={openProfile}
        onEdit={handleEdit}
        onDelete={handleDelete}
        onRetry={handleRetry}
        onReply={setReplyTo}
        onAddReaction={handleAddReaction}
        onRemoveReaction={handleRemoveReaction}
      />
      {isArchived ? (
        <div className="px-4 py-3 text-[11px] text-kd-text-mute font-mono border-t border-kd-border bg-kd-panel-alt shrink-0">
          этот тред заархивирован — отправка отключена.
        </div>
      ) : (
        <Composer
          channelName={`тред: ${titleName}`}
          customEmoji={serverEmoji}
          roles={roles}
          channelId={threadId}
          memberMap={memberMap}
          allowBroadcast
          replyTo={replyTo}
          replyAuthor={replyTo ? memberMap.get(replyTo.authorId)?.displayName : undefined}
          onCancelReply={() => setReplyTo(null)}
          onSend={handleSend}
        />
      )}
    </aside>
  )
}
