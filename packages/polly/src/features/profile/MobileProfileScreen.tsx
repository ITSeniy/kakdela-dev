// Полноэкранный мобильный профиль (свой + чужой). Стиль 1:1 с
// designs/final-mobile.jsx (ProfileHead / MobileProfileSelf / MobileProfileOther):
// градиент-шапка с аватаром внахлёст, роли-пилюли, часовой пояс; для чужого —
// действия написать/секретный/позвонить + «вы оба в»; для своего — редактировать
// профиль + строки настроек.
//
// Данные — getUserProfile (тот же источник, что у ProfileModal). Полноэкранный
// вариант показываем только на мобиле; десктоп остаётся на модалке ProfileModal.

import { useQuery } from '@tanstack/react-query'
import { useLocation } from 'wouter'

import type { UserProfile } from '@kakdela/ginzu/api-types'

import { ApiError } from '../../lib/api.js'
import { Avatar } from '../../components/Avatar.js'
import { Icon } from '../../components/Icon.js'
import { toast } from '../../components/toast/index.js'
import { useThemeStore } from '../../lib/theme.js'
import { openDmWithUser } from '../dm/api.js'
import { joinDmCall } from '../voice/useVoiceRoom.js'
import { useVoiceStore } from '../voice/store.js'
import { getUserProfile } from './api.js'
import { fmtJoined, fmtTzNow } from './format.js'

const STATUS_LABEL: Record<UserProfile['status'], string> = {
  online:  'в сети',
  idle:    'отошёл',
  dnd:     'не беспокоить',
  offline: 'не в сети',
}

const ROLE_LABEL: Record<UserProfile['sharedServers'][number]['role'], string> = {
  owner:  'хозяин',
  admin:  'админ',
  member: 'свой',
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  return (
    <div className="text-[10px] font-mono font-bold uppercase tracking-[0.05em] text-kd-text-mute mb-2">
      {children}
    </div>
  )
}

function ProfileHead({ profile, onBack }: { profile: UserProfile; onBack: () => void }) {
  const [, navigate] = useLocation()
  const tzNow = profile.timezone ? fmtTzNow(profile.timezone) : null
  const meta = [tzNow, STATUS_LABEL[profile.status]].filter(Boolean).join(' · ')

  return (
    <div className="relative shrink-0">
      <div className="relative h-[124px] bg-gradient-to-br from-kd-profile-grad-from to-kd-profile-grad-to">
        {profile.bannerUrl && (
          <img src={profile.bannerUrl} alt="" className="absolute inset-0 w-full h-full object-cover" draggable={false} />
        )}
        <div className="relative flex justify-between items-start p-3">
          {profile.isSelf ? (
            <span />
          ) : (
            <button type="button" onClick={onBack} title="назад" className="text-white/90 active:text-white">
              <Icon.ArrowLeft size={22} />
            </button>
          )}
          {profile.isSelf && (
            <button type="button" onClick={() => navigate('/settings')} title="настройки" className="text-white/90 active:text-white">
              <Icon.Settings size={21} />
            </button>
          )}
        </div>
      </div>
      <div className="px-5 -mt-9">
        <Avatar
          name={profile.displayName}
          avatarUrl={profile.avatarUrl}
          size={76}
          ring="var(--kd-bg)"
          ringColor="var(--kd-bg)"
        />
        <div className="text-[22px] font-extrabold text-kd-text mt-2.5 tracking-[-0.02em]">{profile.displayName}</div>
        {profile.about && <div className="text-[13px] text-kd-text-soft mt-1 whitespace-pre-wrap break-words">{profile.about}</div>}
        {meta && <div className="text-[11px] text-kd-text-mute font-mono mt-1.5">{meta}</div>}
        {profile.roles.length > 0 && (
          <div className="flex flex-wrap gap-2 mt-3">
            {profile.roles.map((r) => (
              <span
                key={r.id}
                className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full border bg-kd-panel text-[11px] font-mono text-kd-text-soft"
                style={{ borderColor: r.color ? `${r.color}55` : 'var(--kd-border)' }}
              >
                <span className="w-[7px] h-[7px] rounded-full shrink-0" style={{ background: r.color ?? 'var(--kd-text-mute)' }} />
                {r.name}
              </span>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

function ActionButton({ icon, label, primary, onClick }: {
  icon: React.ReactNode; label: string; primary?: boolean; onClick: () => void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={[
        'flex-1 flex flex-col items-center gap-1.5 py-3 px-1.5 rounded-kd',
        primary ? 'bg-kd-accent text-white active:bg-kd-accent-deep' : 'bg-kd-panel border border-kd-border text-kd-text active:bg-kd-panel-hi',
      ].join(' ')}
    >
      {icon}
      <span className="text-[11px] font-semibold">{label}</span>
    </button>
  )
}

function OtherActions({ profile }: { profile: UserProfile }) {
  const [, navigate] = useLocation()
  const activeChannelId = useVoiceStore((s) => s.activeChannelId)

  // Профиль знает только userId — резолвим DM-канал (создастся, если его нет),
  // ставим звонок в voice-очередь и уходим на экран переписки: DmScreen сам
  // покажет активный звонок по callActiveHere.
  async function onCall() {
    if (activeChannelId !== null) {
      toast.info('вы уже в другом звонке')
      return
    }
    try {
      const res = await openDmWithUser(profile.id)
      navigate(`/dm/${res.channel.id}`)
      await joinDmCall(res.channel.id, {
        id: profile.id,
        name: profile.displayName,
        avatarUrl: profile.avatarUrl,
      })
    } catch (err) {
      const msg = err instanceof ApiError ? err.message : (err as Error).message
      toast.error(msg || 'не получилось позвонить')
    }
  }

  return (
    <div className="px-5 pt-5 flex gap-2.5">
      <ActionButton icon={<Icon.Send size={19} />} label="написать" onClick={() => navigate(`/dm/with/${profile.id}`)} />
      <ActionButton icon={<Icon.Lock size={19} />} label="секретный" primary onClick={() => navigate(`/secret/${profile.id}`)} />
      <ActionButton icon={<Icon.Phone size={19} />} label="позвонить" onClick={() => { void onCall() }} />
    </div>
  )
}

function SelfActions() {
  const [, navigate] = useLocation()
  return (
    <div className="px-5 pt-5 flex gap-2.5">
      <button
        type="button"
        onClick={() => navigate('/settings/profile')}
        className="flex-1 flex items-center justify-center gap-2 py-3 bg-kd-accent text-white rounded-kd text-[14px] font-bold active:bg-kd-accent-deep"
      >
        <Icon.Edit size={17} /> редактировать профиль
      </button>
      <button
        type="button"
        onClick={() => navigate('/settings')}
        title="настройки"
        className="w-12 flex items-center justify-center bg-kd-panel border border-kd-border rounded-kd text-kd-text-soft active:bg-kd-panel-hi"
      >
        <Icon.Settings size={20} />
      </button>
    </div>
  )
}

function SelfRows() {
  const [, navigate] = useLocation()
  const cycleTheme = useThemeStore((s) => s.cycleMode)
  const rows: { icon: React.ReactNode; label: string; onClick: () => void }[] = [
    { icon: <Icon.Lock size={18} />, label: 'мои ключи и safety numbers', onClick: () => navigate('/secret') },
    { icon: <Icon.Bell size={18} />, label: 'уведомления', onClick: () => navigate('/settings/notifications') },
    { icon: <Icon.Moon size={18} />, label: 'тема оформления', onClick: cycleTheme },
  ]
  return (
    <div className="px-5 pt-5">
      <div className="bg-kd-panel border border-kd-border rounded-kd overflow-hidden">
        {rows.map((r, i) => (
          <button
            key={r.label}
            type="button"
            onClick={r.onClick}
            className={`w-full flex items-center gap-3 px-3.5 py-3 text-left active:bg-kd-panel-hi ${i ? 'border-t border-kd-border' : ''}`}
          >
            <span className="text-kd-text-soft">{r.icon}</span>
            <span className="flex-1 text-[14px] text-kd-text">{r.label}</span>
            <Icon.ChevronRight size={17} className="text-kd-text-mute" />
          </button>
        ))}
      </div>
    </div>
  )
}

function SharedServers({ profile }: { profile: UserProfile }) {
  const [, navigate] = useLocation()
  if (profile.sharedServers.length === 0) return null
  return (
    <div className="px-5 pt-5">
      <SectionTitle>{profile.isSelf ? 'мои комнаты' : 'вы оба в'}</SectionTitle>
      <div className="bg-kd-panel border border-kd-border rounded-kd overflow-hidden">
        {profile.sharedServers.map((s, i) => (
          <button
            key={s.id}
            type="button"
            onClick={() => navigate(`/servers/${s.id}`)}
            className={`w-full flex items-center gap-3 px-3.5 py-3 text-left active:bg-kd-panel-hi ${i ? 'border-t border-kd-border' : ''}`}
          >
            <div className="w-[30px] h-[30px] rounded-[9px] bg-kd-accent text-white flex items-center justify-center text-[13px] font-bold shrink-0">
              {s.name.charAt(0).toUpperCase()}
            </div>
            <span className="flex-1 text-[14px] font-semibold text-kd-text truncate">{s.name}</span>
            <span className="text-[11px] font-mono text-kd-text-mute shrink-0">{ROLE_LABEL[s.role]}</span>
          </button>
        ))}
      </div>
    </div>
  )
}

export function MobileProfileScreen({ userId }: { userId: string }) {
  const [, navigate] = useLocation()
  const { data: profile, isLoading, error } = useQuery({
    queryKey: ['user-profile', userId],
    queryFn: () => getUserProfile(userId),
    staleTime: 30_000,
  })

  function onBack() {
    if (window.history.length > 1) window.history.back()
    else navigate('/dm')
  }

  if (isLoading || !profile) {
    const errorMsg = error instanceof ApiError ? error.message : (error as Error | null)?.message
    return (
      <div className="flex-1 flex items-center justify-center p-8 text-center font-mono text-[11px]">
        {errorMsg ? <span className="text-kd-danger">{errorMsg}</span> : <span className="text-kd-text-mute">загружаем…</span>}
      </div>
    )
  }

  return (
    <div className="flex-1 min-h-0 overflow-y-auto pb-6">
      <ProfileHead profile={profile} onBack={onBack} />
      {profile.isSelf ? (
        <>
          <SelfActions />
          <SelfRows />
          <SharedServers profile={profile} />
        </>
      ) : (
        <>
          <OtherActions profile={profile} />
          <SharedServers profile={profile} />
          <div className="px-5 pt-3.5 text-[11px] font-mono text-kd-text-mute">
            знакомы с {fmtJoined(profile.createdAt)}
          </div>
        </>
      )}
    </div>
  )
}
