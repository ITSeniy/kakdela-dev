import { useEffect, useMemo, useState } from 'react'
import { type InfiniteData, useQuery, useQueryClient } from '@tanstack/react-query'
import { useLocation } from 'wouter'

import type { Attachment, Channel, CustomEmoji, GifEmbed, MemberPublic, Message, MessagesPage, StickerRef } from '@kakdela/ginzu/api-types'

type MsgCache = InfiniteData<MessagesPage, string | undefined>

import { Badge } from '../../components/Badge.js'
import { Icon } from '../../components/Icon.js'
import { toast } from '../../components/toast/index.js'
import { ApiError } from '../../lib/api.js'
import { wsClient } from '../../lib/ws.js'
import { useAuthStore } from '../auth/store.js'
import { useViewScope } from '../navigation/viewScope.js'
import { useServerEmoji } from '../emoji/api.js'
import { useProfileUi } from '../profile/store.js'
import { listRoles } from '../roles/api.js'
import { getChannelStats, getServerDetail, listMembers, markChannelRead } from '../servers/api.js'
import { ServerSearchOverlay } from '../search/ServerSearchOverlay.js'
import { Composer } from './Composer.js'
import { MessageList } from './MessageList.js'
import { useNsfwGate } from './nsfwGate.js'
import { PinnedPanel } from './PinnedPanel.js'
import { addReaction, deleteMessage, editMessage, removeReaction, sendMessage } from './api.js'
import type { PendingMessage } from './types.js'

interface ChatScreenProps {
  serverId: string
  channelId: string
}

// Шапка канала по designs/final-chrome.jsx (KD_ChannelHeader): panelAlt,
// иконка + имя + вертикальный разделитель + topic, справа mono-stats и иконки.
function Header({ channel, channelId, serverId, serverName, memberCount, canPin, memberMap, emojiMap }: {
  channel: Channel | undefined
  channelId: string
  serverId: string
  serverName: string
  memberCount: number
  canPin: boolean
  memberMap: ReadonlyMap<string, MemberPublic>
  emojiMap?: ReadonlyMap<string, CustomEmoji>
}) {
  const [, navigate] = useLocation()
  const setScope = useViewScope((s) => s.setScope)
  const [showPins, setShowPins] = useState(false)
  const [showSearch, setShowSearch] = useState(false)
  const { data: stats } = useQuery({
    queryKey: ['channel-stats', channelId],
    queryFn: () => getChannelStats(channelId),
    staleTime: 30_000,
  })

  // Входящие шапки = серверная версия глобальных, ограниченная этим сервером
  // (scope подхватит InboxScreen). Поиск же открываем оверлеем-палитрой прямо
  // здесь — без ухода на полноэкранный /search.
  function openServerInbox() {
    setScope(serverId, serverName)
    navigate('/inbox')
  }
  return (
    <div className="px-4 h-12 border-b border-kd-border bg-kd-panel-alt flex items-center gap-2.5 shrink-0">
      <Icon.Hash size={14} className="text-kd-text-soft shrink-0" />
      <span className="text-[13px] font-bold text-kd-text shrink-0">{channel?.name ?? '—'}</span>
      {channel?.nsfw && <Badge variant="nsfw">18+</Badge>}
      {channel?.topic && (
        <>
          <div className="w-px h-3.5 bg-kd-border shrink-0" />
          <span className="text-[11px] text-kd-text-soft truncate">{channel.topic}</span>
        </>
      )}
      <div className="flex-1" />
      <span className="text-[10px] text-kd-text-mute font-mono shrink-0">
        {stats ? `${stats.messageCount.toLocaleString('ru-RU')} сообщ. · ` : ''}{memberCount} подп.
      </span>
      <div className="flex items-center gap-2.5 text-kd-text-mute shrink-0">
        <div className="relative">
          <button
            type="button"
            title="закреплённые"
            onClick={() => setShowPins((v) => !v)}
            className={`transition-colors ${showPins ? 'text-kd-warm' : 'hover:text-kd-text-soft'}`}
          >
            <Icon.Pin size={14} />
          </button>
          {showPins && (
            <PinnedPanel
              channelId={channelId}
              canPin={canPin}
              memberMap={memberMap}
              emojiMap={emojiMap}
              onClose={() => setShowPins(false)}
            />
          )}
        </div>
        <button
          type="button"
          title={`входящие · ${serverName}`}
          onClick={openServerInbox}
          className="hover:text-kd-text-soft transition-colors"
        >
          <Icon.Inbox size={14} />
        </button>
        <button
          type="button"
          title={`поиск в ${serverName}`}
          onClick={() => setShowSearch(true)}
          className={`transition-colors ${showSearch ? 'text-kd-warm' : 'hover:text-kd-text-soft'}`}
        >
          <Icon.Search size={14} />
        </button>
      </div>
      {showSearch && (
        <ServerSearchOverlay
          serverId={serverId}
          serverName={serverName}
          onClose={() => setShowSearch(false)}
        />
      )}
    </div>
  )
}

// Заслонка 18+ при первом входе в NSFW-канал (designs — предупреждение по
// центру). Подтверждение запоминается per-channel (useNsfwGate).
function NsfwGate({ channelName, onContinue }: { channelName: string; onContinue: () => void }) {
  return (
    <div className="flex-1 min-h-0 flex flex-col items-center justify-center px-6 text-center">
      <Badge variant="nsfw">18+</Badge>
      <div className="mt-3 text-[15px] font-bold text-kd-text">
        {channelName ? `#${channelName}` : 'этот канал'} помечен как «для взрослых»
      </div>
      <div className="mt-1.5 text-[12px] text-kd-text-soft max-w-[360px] leading-relaxed">
        здесь может быть контент 18+. заходи, только если тебе есть 18 и ты не против такого.
      </div>
      <div className="mt-4 flex items-center gap-2">
        <button
          type="button"
          onClick={() => window.history.back()}
          className="px-3.5 py-2 rounded-kd bg-kd-panel border border-kd-border text-[12px] font-semibold text-kd-text hover:bg-kd-panel-hi transition-colors"
        >
          назад
        </button>
        <button
          type="button"
          onClick={onContinue}
          className="px-3.5 py-2 rounded-kd bg-kd-accent text-white text-[12px] font-semibold hover:bg-kd-accent-deep transition-colors"
        >
          продолжить
        </button>
      </div>
    </div>
  )
}

export function ChatScreen({ serverId, channelId }: ChatScreenProps) {
  const queryClient = useQueryClient()
  const user = useAuthStore((s) => s.user)
  const openProfile = useProfileUi((s) => s.open)
  const nsfwAccepted = useNsfwGate((s) => Boolean(s.accepted[channelId]))
  const acceptNsfw = useNsfwGate((s) => s.accept)

  const [pending, setPending] = useState<PendingMessage[]>([])
  const [replyTo, setReplyTo] = useState<Message | null>(null)

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

  // Авто-«прочитано»: открыли канал или пришло новое сообщение, пока смотрим —
  // помечаем прочитанным и освежаем точки непрочитанного в списке каналов.
  useEffect(() => {
    if (!channelId) return undefined
    const markRead = () => {
      void markChannelRead(channelId).then(() =>
        queryClient.invalidateQueries({ queryKey: ['unread', serverId] }),
      )
    }
    markRead()
    return wsClient.on((e) => {
      if (e.t === 'msg.new' && e.channelId === channelId) markRead()
    })
  }, [serverId, channelId, queryClient])

  // Закреплять в серверном канале могут owner/admin (T-пин).
  const myRole = user ? members.find((m) => m.id === user.id)?.role : undefined
  const canPin = myRole === 'owner' || myRole === 'admin'

  const channelMap = useMemo(() => {
    const m = new Map<string, Channel>()
    for (const c of serverDetail?.channels ?? []) m.set(c.id, c)
    return m
  }, [serverDetail?.channels])

  const { emoji: serverEmoji, byName: emojiMap } = useServerEmoji(serverId)

  // Роли сервера (без @everyone) — для рендера/автокомплита `@роль`.
  const { data: allRoles = [] } = useQuery({
    queryKey: ['roles', serverId],
    queryFn: () => listRoles(serverId),
    staleTime: 30_000,
  })
  const roles = useMemo(() => allRoles.filter((r) => !r.isEveryone), [allRoles])

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
      const spoilerIds = attachments.filter((a) => a.spoiler).map((a) => a.id)
      const sent = await sendMessage(channelId, {
        content,
        ...(replyId ? { replyToId: replyId } : {}),
        clientNonce: nonce,
        ...(attachments.length > 0 ? { attachments: attachments.map((a) => a.id) } : {}),
        ...(spoilerIds.length > 0 ? { spoilerAttachments: spoilerIds } : {}),
        ...(gif ? { gif } : {}),
        ...(sticker ? { sticker } : {}),
      })
      queryClient.setQueryData<InfiniteData<MessagesPage, string | undefined>>(
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
    } catch (err) {
      // Медленный режим (429) и прочие отказы сервера — показываем причину,
      // а оптимистичное сообщение убираем (оно не отправилось).
      if (err instanceof ApiError && err.code === 'slow-mode') {
        toast.info(err.message)
        setPending((p) => p.filter((x) => x._nonce !== nonce))
        return
      }
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
      console.error('[chat] edit failed', err)
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
      console.error('[chat] delete failed', err)
    })
  }

  async function handleAddReaction(messageId: string, emoji: string) {
    try {
      await addReaction(messageId, emoji)
    } catch (err) {
      toast.error('не удалось поставить реакцию')
      console.error('[chat] add reaction failed', err)
    }
  }

  async function handleRemoveReaction(messageId: string, emoji: string) {
    try {
      await removeReaction(messageId, emoji)
    } catch (err) {
      toast.error('не удалось убрать реакцию')
      console.error('[chat] remove reaction failed', err)
    }
  }

  return (
    <div className="flex-1 min-w-0 min-h-0 flex flex-col bg-kd-bg">
      <Header
        channel={channel}
        channelId={channelId}
        serverId={serverId}
        serverName={serverDetail?.server.name ?? ''}
        memberCount={serverDetail?.memberCount ?? 0}
        canPin={canPin}
        memberMap={memberMap}
        emojiMap={emojiMap}
      />
      {(channel?.nsfw ?? false) && !nsfwAccepted ? (
        <NsfwGate channelName={channel?.name ?? ''} onContinue={() => acceptNsfw(channelId)} />
      ) : (
        <>
          <MessageList
            serverId={serverId}
            channelId={channelId}
            currentUserId={user?.id ?? null}
            memberMap={memberMap}
            channelMap={channelMap}
            emojiMap={emojiMap}
            roles={roles}
            pending={pending}
            canPin={canPin}
            threadsAllowed={channel?.threadsAllowed ?? true}
            nsfw={channel?.nsfw ?? false}
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
            roles={roles}
            channelId={channelId}
            memberMap={memberMap}
            allowBroadcast
            replyTo={replyTo}
            replyAuthor={replyTo ? memberMap.get(replyTo.authorId)?.displayName : undefined}
            onCancelReply={() => setReplyTo(null)}
            onSend={handleSend}
          />
        </>
      )}
    </div>
  )
}
