// Действия канала (закреплённые · входящие · поиск) — вынесены из шапки чата в
// отдельный самодостаточный компонент, чтобы их можно было показывать там, где
// просторнее: в шапке панели участников (на широком экране), а в узком/тред-
// режиме — обратно в шапке чата (см. ChatScreen.Header + MemberList.header).
//
// Компонент сам тянет всё нужное из кэша react-query (детали сервера, участники,
// эмодзи) — вызывающему достаточно передать serverId + channelId, лишних
// пропсов и дублирования логики нет. Все query шарят ключи с ChatScreen/
// MemberList, так что новых сетевых запросов это не создаёт.

import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useLocation } from 'wouter'

import type { MemberPublic } from '@kakdela/ginzu/api-types'

import { Icon } from '../../components/Icon.js'
import { useAuthStore } from '../auth/store.js'
import { useServerEmoji } from '../emoji/api.js'
import { useViewScope } from '../navigation/viewScope.js'
import { getServerDetail, listMembers } from '../servers/api.js'
import { ServerSearchOverlay } from '../search/ServerSearchOverlay.js'
import { PinnedPanel } from './PinnedPanel.js'

interface ChannelHeaderActionsProps {
  serverId: string
  channelId: string
  /** Доп. классы на обёртку (например `lg:hidden` / `ml-auto`). */
  className?: string
}

export function ChannelHeaderActions({ serverId, channelId, className }: ChannelHeaderActionsProps) {
  const [, navigate] = useLocation()
  const setScope = useViewScope((s) => s.setScope)
  const meId = useAuthStore((s) => s.user?.id)
  const [showPins, setShowPins] = useState(false)
  const [showSearch, setShowSearch] = useState(false)

  const { data: detail } = useQuery({
    queryKey: ['server', serverId],
    queryFn: () => getServerDetail(serverId),
    staleTime: 30_000,
  })
  const { data: members = [] } = useQuery({
    queryKey: ['members', serverId],
    queryFn: () => listMembers(serverId),
    staleTime: 60_000,
  })
  const { byName: emojiMap } = useServerEmoji(serverId)

  const serverName = detail?.server.name ?? ''
  const memberMap = useMemo(() => {
    const m = new Map<string, MemberPublic>()
    for (const x of members) m.set(x.id, x)
    return m
  }, [members])
  // Закреплять могут owner/admin (зеркало ChatScreen.canPin).
  const myRole = meId ? members.find((m) => m.id === meId)?.role : undefined
  const canPin = myRole === 'owner' || myRole === 'admin'

  function openServerInbox() {
    setScope(serverId, serverName)
    navigate('/inbox')
  }

  return (
    <div className={['flex items-center gap-2.5 text-kd-text-mute shrink-0', className].filter(Boolean).join(' ')}>
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
