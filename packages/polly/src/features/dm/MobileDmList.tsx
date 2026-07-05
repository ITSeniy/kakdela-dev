// Мобильный список чатов. Стиль 1:1 с designs/final-mobile.jsx (MobileChatList):
// крупная шапка «чаты» + поиск + круглая «+», строки с avatar(46)/статусом/превью/
// временем/unread-бейджем. Источник — те же queries, что у десктопного DmList; на
// мобиле это полноэкранный «дом», а не сайдбар.
//
// Секретные чаты держим ОТДЕЛЬНО (device-bound, см. CURRENT_PHASE.md): первой
// строкой — вход в раздел /secret, а не слитый список.

import { useEffect } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useLocation } from 'wouter'

import type { CustomEmoji, DmSummary } from '@kakdela/ginzu/api-types'

import { Avatar } from '../../components/Avatar.js'
import { useCommandPalette } from '../../components/CommandPalette.js'
import { Icon } from '../../components/Icon.js'
import { wsClient } from '../../lib/ws.js'
import { useAuthStore } from '../auth/store.js'
import { renderMarkdownInline } from '../chat/markdown.js'
import { useAllServerEmoji } from '../emoji/api.js'
import { fetchSecretPeers, secretPeersKey } from '../secret/api.js'
import { listDms } from './api.js'
import { fmtWhen, pluralRu } from './format.js'

function MobileDmRow({
  dm, currentUserId, emojiMap, onClick,
}: {
  dm: DmSummary
  currentUserId: string | null
  emojiMap: ReadonlyMap<string, CustomEmoji>
  onClick: () => void
}) {
  const lastIsMine = dm.lastMessage?.authorId === currentUserId
  const previewHtml = dm.lastMessage
    ? (lastIsMine ? 'вы: ' : '') + renderMarkdownInline(dm.lastMessage.preview, { emoji: emojiMap })
    : null
  const unread = dm.unreadCount > 0
  const offline = dm.otherUser.status === 'offline'
  return (
    <button
      type="button"
      onClick={onClick}
      className={[
        'w-full flex items-center gap-3 px-4 py-2.5 border-b border-kd-border text-left transition-colors active:bg-kd-panel-hi',
        offline && !unread ? 'opacity-[0.78]' : '',
      ].join(' ')}
    >
      <Avatar
        name={dm.otherUser.displayName}
        avatarUrl={dm.otherUser.avatarUrl}
        size={46}
        status={dm.otherUser.status}
        ringColor="var(--kd-bg)"
      />
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-1.5">
          <span className={`text-[15px] flex-1 truncate text-kd-text ${unread ? 'font-bold' : 'font-semibold'}`}>
            {dm.otherUser.displayName}
          </span>
          <span className={`text-[11px] font-mono shrink-0 ${unread ? 'text-kd-warm font-bold' : 'text-kd-text-mute'}`}>
            {fmtWhen(dm.lastMessage?.createdAt)}
          </span>
        </div>
        <div className="flex items-center gap-2 mt-0.5">
          {previewHtml !== null ? (
            <div
              className={`kd-md text-[13px] truncate flex-1 min-w-0 ${unread ? 'text-kd-text font-medium' : 'text-kd-text-soft'}`}
              dangerouslySetInnerHTML={{ __html: previewHtml }}
            />
          ) : (
            <div className="text-[13px] truncate flex-1 min-w-0 text-kd-text-soft">новый диалог</div>
          )}
          {unread && (
            <span className="bg-kd-warm text-white text-[11px] font-bold font-mono min-w-[18px] h-[18px] px-1.5 rounded-full flex items-center justify-center shrink-0">
              {dm.unreadCount}
            </span>
          )}
        </div>
      </div>
    </button>
  )
}

/** Вход в раздел секретных чатов (держим отдельно от облачных DM). */
function SecretEntryRow({ onClick }: { onClick: () => void }) {
  const { data: peers = [] } = useQuery({
    queryKey: secretPeersKey,
    queryFn: fetchSecretPeers,
    staleTime: 5_000,
  })
  return (
    <button
      type="button"
      onClick={onClick}
      className="w-full flex items-center gap-3 px-4 py-3 border-b border-kd-border text-left transition-colors active:bg-kd-panel-hi"
    >
      <div className="w-[46px] h-[46px] rounded-full bg-kd-accent-bg flex items-center justify-center shrink-0">
        <Icon.Lock size={22} className="text-kd-accent" />
      </div>
      <div className="flex-1 min-w-0">
        <div className="text-[15px] font-semibold text-kd-text">секретные чаты</div>
        <div className="text-[12px] font-mono text-kd-accent mt-0.5">
          {peers.length > 0
            ? `${peers.length} ${pluralRu(peers.length, 'переписка', 'переписки', 'переписок')} · сквозное шифрование`
            : 'сквозное шифрование · только на устройстве'}
        </div>
      </div>
      <Icon.ChevronRight size={18} className="text-kd-text-mute shrink-0" />
    </button>
  )
}

function EmptyChats({ onNew }: { onNew: () => void }) {
  return (
    <div className="flex-1 flex flex-col items-center justify-center px-10 text-center gap-3.5">
      <div className="w-16 h-16 rounded-[18px] bg-kd-panel border border-kd-border flex items-center justify-center text-kd-warm">
        <Icon.Smile size={30} />
      </div>
      <div className="text-[17px] font-bold text-kd-text">тут пока тихо</div>
      <div className="text-[13px] text-kd-text-soft leading-relaxed">
        напиши первому из своих — все, кого ты знаешь, уже здесь.
      </div>
      <button
        type="button"
        onClick={onNew}
        className="mt-1 bg-kd-accent text-white rounded-kd px-5 py-2.5 text-[14px] font-bold flex items-center gap-2 active:bg-kd-accent-deep"
      >
        <Icon.Plus size={17} /> новый чат
      </button>
    </div>
  )
}

export function MobileDmList() {
  const [, navigate] = useLocation()
  const user = useAuthStore((s) => s.user)
  const queryClient = useQueryClient()
  const togglePalette = useCommandPalette((s) => s.toggle)

  const { data: dms = [] } = useQuery({
    queryKey: ['dm-list'],
    queryFn: listDms,
    staleTime: 10_000,
  })
  const emojiMap = useAllServerEmoji()

  // «Заметки себе» — закреплённой строкой (после секретных), self-DM из
  // общего списка фильтруем, чтобы не дублировался.
  const selfDm = dms.find((d) => d.otherUser.id === user?.id)
  const visibleDms = dms.filter((d) => d.otherUser.id !== user?.id)

  useEffect(() => {
    return wsClient.on((event) => {
      if (event.t === 'msg.new' || event.t === 'msg.edit' || event.t === 'msg.delete' || event.t === 'dm.new') {
        void queryClient.invalidateQueries({ queryKey: ['dm-list'] })
      }
    })
  }, [queryClient])

  return (
    <div className="flex-1 min-h-0 flex flex-col">
      <div className="px-4 pt-2 pb-3 border-b border-kd-border bg-kd-panel-alt flex items-center gap-3 shrink-0">
        <span className="text-[24px] font-extrabold text-kd-text flex-1 tracking-[-0.02em]">чаты</span>
        <button
          type="button"
          onClick={togglePalette}
          title="поиск"
          className="text-kd-text-soft active:text-kd-text"
        >
          <Icon.Search size={22} />
        </button>
        <button
          type="button"
          onClick={() => navigate('/new')}
          title="новая переписка"
          className="w-[34px] h-[34px] rounded-full bg-kd-accent text-white flex items-center justify-center active:bg-kd-accent-deep"
        >
          <Icon.Plus size={20} />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto min-h-0 flex flex-col">
        <SecretEntryRow onClick={() => navigate('/secret')} />
        {/* «Заметки себе»: перекидывать ссылки/файлы между телефоном и ПК. */}
        <button
          type="button"
          onClick={() => navigate(selfDm ? `/dm/${selfDm.channelId}` : `/dm/with/${user?.id}`)}
          className="w-full flex items-center gap-3 px-4 py-2.5 text-left border-b border-kd-border/60 active:bg-kd-panel-alt"
        >
          <span className="w-[46px] h-[46px] rounded-full bg-kd-accent/15 border border-kd-accent/40 flex items-center justify-center shrink-0">
            <Icon.Bookmark size={21} className="text-kd-accent" />
          </span>
          <div className="flex-1 min-w-0">
            <div className="text-[15px] font-semibold text-kd-text">заметки себе</div>
            <div className="text-[12px] text-kd-text-soft truncate mt-px">
              {selfDm?.lastMessage ? selfDm.lastMessage.preview : 'ссылки и файлы для себя'}
            </div>
          </div>
        </button>
        {visibleDms.length === 0 ? (
          <EmptyChats onNew={() => navigate('/new')} />
        ) : (
          visibleDms.map((dm) => (
            <MobileDmRow
              key={dm.channelId}
              dm={dm}
              currentUserId={user?.id ?? null}
              emojiMap={emojiMap}
              onClick={() => navigate(`/dm/${dm.channelId}`)}
            />
          ))
        )}
      </div>
    </div>
  )
}
