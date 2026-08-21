import { useEffect, useRef } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useLocation, useRoute } from 'wouter'

import { useCommandPalette } from '../components/CommandPalette.js'

import { ChatScreen } from '../features/chat/ChatScreen.js'
import { ChannelList } from '../features/channels/ChannelList.js'
import { DmHome } from '../features/dm/DmHome.js'
import { DmList } from '../features/dm/DmList.js'
import { DmOpener } from '../features/dm/DmOpener.js'
import { DmScreen } from '../features/dm/DmScreen.js'
import { listDms } from '../features/dm/api.js'
import { InboxScreen } from '../features/inbox/InboxScreen.js'
import { MemberList } from '../features/members/MemberList.js'
import { useRecents } from '../features/navigation/recents.js'
import { WelcomeScreen } from '../features/onboarding/WelcomeScreen.js'
import { SearchScreen } from '../features/search/SearchScreen.js'
import { ServerRail } from '../features/servers/ServerRail.js'
import { getChannel, getServerDetail, listServers } from '../features/servers/api.js'
import { ThreadPanel } from '../features/threads/ThreadPanel.js'
import { useThreadUi } from '../features/threads/store.js'
import { useNotifyTriggers } from '../features/notify/triggers.js'
import { useUnreadIndicators } from '../features/notify/unread.js'
import { useAutoIdle } from '../features/presence/useAutoIdle.js'
import { useDesktopIntegration } from '../features/desktop/useDesktopIntegration.js'
import { useKickWatcher } from '../features/servers/useKickWatcher.js'
import { VoiceScreen } from '../features/voice/VoiceScreen.js'
import { useAudioDeviceSync } from '../features/voice/deviceSettings.js'
import { useNoiseSuppressionSync } from '../features/voice/noiseSettings.js'
import { useHotkeys } from '../features/voice/hotkeys.js'
import { useVoicePingSampler } from '../features/voice/pingStats.js'
import { usePushToTalk } from '../features/voice/usePushToTalk.js'

const LAST_CHANNEL_KEY = 'kd:last-channel'
// Память «где я был»: последний открытый канал на КАЖДОМ сервере и последняя
// переписка в личке — клик по рельсе возвращает в тот же чат, а не в дефолтный.
const LAST_SERVER_CHANNEL_PREFIX = 'kd:last-channel:'
const LAST_DM_KEY = 'kd:last-dm'

export function Shell() {
  usePushToTalk()
  useHotkeys()
  useNoiseSuppressionSync()
  useNotifyTriggers()
  useUnreadIndicators()
  useAutoIdle()
  useDesktopIntegration()
  useKickWatcher()
  useVoicePingSampler()
  useAudioDeviceSync()
  const [location, navigate] = useLocation()
  const [, channelParams] = useRoute<{ serverId: string; channelId: string }>(
    '/servers/:serverId/channels/:channelId',
  )
  const [, serverParams] = useRoute<{ serverId: string }>('/servers/:serverId')
  const [, dmChannelParams] = useRoute<{ channelId: string }>('/dm/:channelId')
  const [, dmWithParams] = useRoute<{ userId: string }>('/dm/with/:userId')
  const [, dmHome] = useRoute('/dm')
  const [, inboxRoute] = useRoute('/inbox')
  const [, searchRoute] = useRoute('/search')
  const [, welcomeRoute] = useRoute('/welcome')

  const inDmMode = Boolean(dmChannelParams || dmWithParams || dmHome)
  const inInboxMode = Boolean(inboxRoute)
  const inSearchMode = Boolean(searchRoute)
  const inWelcomeMode = Boolean(welcomeRoute)
  const inSidebarMode = inDmMode || inInboxMode || inSearchMode || inWelcomeMode
  const serverId = inSidebarMode ? null : (channelParams?.serverId ?? serverParams?.serverId ?? null)
  const channelId = inSidebarMode ? null : (channelParams?.channelId ?? null)

  // Глобальный Ctrl+K / Cmd+K → командная палитра (designs/final-extras.jsx,
  // FinalPalette). Полноэкранный поиск остаётся доступен с рельсы и из палитры.
  const togglePalette = useCommandPalette((s) => s.toggle)
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.ctrlKey || e.metaKey) && (e.key === 'k' || e.key === 'K')) {
        e.preventDefault()
        togglePalette()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [togglePalette])

  const { data: servers } = useQuery({
    queryKey: ['servers'],
    queryFn: listServers,
    staleTime: 30_000,
  })

  const { data: serverDetail } = useQuery({
    queryKey: ['server', serverId],
    queryFn: () => getServerDetail(serverId!),
    enabled: serverId !== null,
    staleTime: 30_000,
  })

  // Root → last channel from localStorage, else first server, else welcome.
  useEffect(() => {
    if (location !== '/' && location !== '') return
    if (!servers) return
    const last = localStorage.getItem(LAST_CHANNEL_KEY)
    if (last && (last.startsWith('/servers/') || last.startsWith('/dm'))) {
      navigate(last, { replace: true })
      return
    }
    const first = servers[0]
    if (first) {
      navigate(`/servers/${first.id}`, { replace: true })
      return
    }
    // Нет серверов вообще (kick'нули отовсюду или fresh-инстанс без инвайта) —
    // показываем welcome с тремя картами выбора (T-083 п.7).
    navigate('/welcome', { replace: true })
  }, [location, servers, navigate])

  // /servers/:id (no channel) → канал, где были в прошлый раз, иначе дефолтный.
  useEffect(() => {
    if (!serverParams || channelParams) return
    if (!serverDetail) return
    const lastId = localStorage.getItem(LAST_SERVER_CHANNEL_PREFIX + serverDetail.server.id)
    // Восстанавливаем только текстовый (возврат в голосовой канал — сюрприз);
    // канал могли удалить — тогда фолбэк на дефолт.
    const last = lastId
      ? serverDetail.channels.find((c) => c.id === lastId && c.kind === 'text')
      : undefined
    // «Канал по умолчанию» (настройки канала) имеет приоритет; иначе — первый
    // текстовый по позиции.
    const target = last
      ?? serverDetail.channels.find((c) => c.kind === 'text' && c.isDefault)
      ?? serverDetail.channels.find((c) => c.kind === 'text')
    if (target) {
      navigate(`/servers/${serverDetail.server.id}/channels/${target.id}`, { replace: true })
    }
  }, [serverParams, channelParams, serverDetail, navigate])

  // /dm (домик без выбранной переписки) → последняя открытая переписка.
  const { data: dmsForHome } = useQuery({
    queryKey: ['dm-list'],
    queryFn: listDms,
    staleTime: 30_000,
    enabled: Boolean(dmHome),
  })
  useEffect(() => {
    if (!dmHome || !dmsForHome) return
    const last = localStorage.getItem(LAST_DM_KEY)
    if (last && dmsForHome.some((d) => d.channelId === last)) {
      navigate(`/dm/${last}`, { replace: true })
    }
  }, [dmHome, dmsForHome, navigate])

  // Remember last open channel (both server and DM routes).
  useEffect(() => {
    if (channelParams || dmChannelParams) localStorage.setItem(LAST_CHANNEL_KEY, location)
    if (channelParams) {
      localStorage.setItem(LAST_SERVER_CHANNEL_PREFIX + channelParams.serverId, channelParams.channelId)
    }
    if (dmChannelParams) localStorage.setItem(LAST_DM_KEY, dmChannelParams.channelId)
  }, [location, channelParams, dmChannelParams])

  // «Недавнее» для палитры: фиксируем посещённые каналы и личные чаты.
  useEffect(() => {
    const push = useRecents.getState().push
    if (channelParams) {
      push({ kind: 'channel', id: channelParams.channelId, serverId: channelParams.serverId })
    } else if (dmChannelParams) {
      push({ kind: 'dm', id: dmChannelParams.channelId })
    }
  }, [channelParams, dmChannelParams])

  const openThreadId = useThreadUi((s) => s.openThreadId)
  const threadParentId = useThreadUi((s) => s.parentChannelId)
  const closeThread = useThreadUi((s) => s.close)

  // Тред-панель имеет смысл только когда мы в server-канале и parent совпадает.
  const showThreadPanel = !inSidebarMode && openThreadId !== null
    && threadParentId !== null && channelId !== null
    && threadParentId === channelId

  // Если тред был открыт но мы ушли с его parent-канала — закрыть.
  useEffect(() => {
    if (openThreadId === null) return
    if (channelId === null || (threadParentId !== null && threadParentId !== channelId)) {
      closeThread()
    }
  }, [channelId, openThreadId, threadParentId, closeThread])

  // В голосовом канале правая колонка участников не нужна — у звонка свой
  // состав в сетке карточек и свой чат (VoiceCallChat).
  const inVoiceChannel =
    channelId !== null
    && serverDetail?.channels.find((c) => c.id === channelId)?.kind === 'voice'

  const showMemberList = !inSidebarMode && !showThreadPanel && !inVoiceChannel

  // На больших экранах мы держим колонку справа постоянно — она показывает
  // либо MemberList, либо ThreadPanel. На малых экранах MemberList скрыт,
  // а ThreadPanel — overlay (см. ниже отдельный layout).
  // Ширины колонок — из designs/final-chrome.jsx: рельса 56, каналы 216,
  // участники 220. DM-список — 256 (final-dm.jsx). Тред-панель остаётся 360.
  // grid-rows-[minmax(0,1fr)] обязателен: без него единственный implicit-ряд
  // растёт по контенту, и при переполнении (длинный чат) вся вёрстка уезжает
  // за вьюпорт вместо скролла внутри колонок.
  const gridBase =
    'h-full grid grid-rows-[minmax(0,1fr)] bg-kd-bg text-kd-text font-sans overflow-hidden'
  const gridClass = inSidebarMode
    ? inDmMode
      ? `${gridBase} grid-cols-[56px_256px_1fr]`
      : `${gridBase} grid-cols-[56px_216px_1fr]`
    : showThreadPanel
      ? `${gridBase} grid-cols-[56px_216px_1fr_360px]`
      : inVoiceChannel
        ? `${gridBase} grid-cols-[56px_216px_1fr]`
        : `${gridBase} grid-cols-[56px_216px_1fr] lg:grid-cols-[56px_216px_1fr_220px]`

  return (
    <div className={gridClass}>
      <ServerRail
        activeServerId={serverId}
        inDmMode={inDmMode}
        inInboxMode={inInboxMode}
        inSearchMode={inSearchMode}
      />
      {inWelcomeMode
        ? <WelcomeScreen />
        : inSearchMode
          ? <SearchScreen />
          : inInboxMode
            ? <InboxScreen />
            : inDmMode
              ? <>
                  <DmList activeChannelId={dmChannelParams?.channelId ?? null} />
                  <DmArea
                    dmChannelId={dmChannelParams?.channelId ?? null}
                    dmWithUserId={dmWithParams?.userId ?? null}
                    isHome={Boolean(dmHome)}
                  />
                </>
              : <>
                  <ChannelList serverId={serverId} activeChannelId={channelId} />
                  <ChannelArea
                    serverId={serverId}
                    channelId={channelId}
                    memberListVisible={showMemberList}
                  />
                </>
      }
      {showMemberList && (
        <MemberList serverId={serverId} channelId={channelId} className="hidden lg:flex" />
      )}
      {showThreadPanel && openThreadId && threadParentId && (
        <ThreadPanel
          threadId={openThreadId}
          parentChannelId={threadParentId}
          serverId={serverId}
        />
      )}
    </div>
  )
}

function DmArea({
  dmChannelId,
  dmWithUserId,
  isHome,
}: {
  dmChannelId: string | null
  dmWithUserId: string | null
  isHome: boolean
}) {
  if (dmWithUserId) return <DmOpener userId={dmWithUserId} />
  if (dmChannelId) return <DmScreen channelId={dmChannelId} />
  if (isHome) return <DmHome />
  return <DmHome />
}

function ChannelArea({
  serverId,
  channelId,
  memberListVisible,
}: {
  serverId: string | null
  channelId: string | null
  memberListVisible: boolean
}) {
  const [, navigate] = useLocation()
  // ChannelArea отдельным компонентом — `useQuery` принимает `enabled`, но мы
  // ещё хотим избегать сборки JSX без нужды; так оба условия в одном месте.
  const { data: detail } = useQuery({
    queryKey: ['server', serverId],
    queryFn: () => getServerDetail(serverId!),
    enabled: serverId !== null,
    staleTime: 30_000,
  })

  // Неизвестный для detail канал — это тред (тред-каналы в сайдбар не
  // попадают). Deep-link из инбокса/поиска/тоста на сообщение треда
  // редиректим в родительский канал с открытой панелью треда, сохраняя
  // #msg:-хеш (аудит M-3). Один запрос метаданных на пару сервер:канал.
  const threadTriedRef = useRef<string | null>(null)
  useEffect(() => {
    if (!serverId || !channelId || !detail) return
    if (detail.channels.some((c) => c.id === channelId)) return
    const key = `${serverId}:${channelId}`
    if (threadTriedRef.current === key) return
    threadTriedRef.current = key
    let cancelled = false
    getChannel(channelId)
      .then((ch) => {
        if (cancelled) return
        if (ch.serverId !== serverId || ch.kind !== 'text' || !ch.parentChannelId) return
        useThreadUi.getState().open(channelId, ch.parentChannelId)
        navigate(`/servers/${serverId}/channels/${ch.parentChannelId}${window.location.hash}`, { replace: true })
      })
      .catch(() => { /* канал удалён — остаёмся на заглушке */ })
    return () => { cancelled = true }
  }, [serverId, channelId, detail, navigate])

  if (!serverId || !channelId) {
    return (
      <div className="flex items-center justify-center text-kd-text-mute font-mono text-xs">
        {serverId ? 'загружаем канал…' : 'выбери сервер'}
      </div>
    )
  }

  const channel = detail?.channels.find((c) => c.id === channelId)
  if (!channel) {
    return (
      <div className="flex items-center justify-center text-kd-text-mute font-mono text-xs">
        загружаем канал…
      </div>
    )
  }

  if (channel.kind === 'voice') {
    return <VoiceScreen serverId={serverId} channel={channel} />
  }
  return <ChatScreen serverId={serverId} channelId={channelId} memberListVisible={memberListVisible} />
}
