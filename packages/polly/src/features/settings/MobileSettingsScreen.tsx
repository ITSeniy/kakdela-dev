// Мобильные настройки. Стиль 1:1 с designs/final-mobile.jsx (MobileSettings):
// топ-бар + секции-карточки (аккаунт / уведомления / безопасность / о приложении),
// быстрый тумблер тёмной темы.
//
// Подстраницы (профиль/внешний вид/уведомления/голос/звуки) переиспользуют те же
// компоненты, что и десктопный SettingsScreen — отдельной логики не вводим, на
// мобиле они открываются полноэкранным стеком через /settings/:page (десктопный
// оверлей SettingsScreen рассчитан на серверную рельсу и на телефоне непригоден).

import { useLocation } from 'wouter'

import { Icon } from '../../components/Icon.js'
import { effectiveTheme, useThemeStore } from '../../lib/theme.js'
import { AppearanceSettings } from './AppearanceSettings.js'
import { NotificationSettings } from './NotificationSettings.js'
import { ProfileSettings } from './ProfileSettings.js'
import { SoundSettings } from './SoundSettings.js'
import { VoiceSettings } from './VoiceSettings.js'

const APP_VERSION = 'v0.0.1'

const SUB: Record<string, { title: string; render: () => React.ReactNode }> = {
  profile:       { title: 'мой профиль',   render: () => <ProfileSettings /> },
  appearance:    { title: 'внешний вид',   render: () => <AppearanceSettings /> },
  notifications: { title: 'уведомления',   render: () => <NotificationSettings /> },
  voice:         { title: 'голос и видео', render: () => <VoiceSettings /> },
  sounds:        { title: 'звуки',         render: () => <SoundSettings /> },
}

function TopBar({ title, onBack }: { title: string; onBack: () => void }) {
  return (
    <div className="px-3 py-2.5 flex items-center gap-2.5 border-b border-kd-border bg-kd-panel-alt shrink-0">
      <button type="button" onClick={onBack} title="назад" className="-ml-1 text-kd-text-soft active:text-kd-text">
        <Icon.ArrowLeft size={22} />
      </button>
      <span className="text-[17px] font-bold text-kd-text">{title}</span>
    </div>
  )
}

const Chevron = <Icon.ChevronRight size={17} className="text-kd-text-mute shrink-0" />

function Switch({ on }: { on: boolean }) {
  return (
    <div aria-hidden className={`w-10 h-[23px] rounded-full p-0.5 shrink-0 transition-colors ${on ? 'bg-kd-accent' : 'bg-kd-panel-hi'}`}>
      <div className={`w-[19px] h-[19px] rounded-full bg-white transition-transform ${on ? 'translate-x-[17px]' : ''}`} />
    </div>
  )
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="mb-[18px]">
      <div className="text-[10px] font-mono font-bold uppercase tracking-[0.05em] text-kd-text-mute mb-2 px-1">{title}</div>
      <div className="bg-kd-panel border border-kd-border rounded-kd overflow-hidden">{children}</div>
    </div>
  )
}

function Row({ icon, label, right, danger, first, onClick }: {
  icon: React.ReactNode
  label: string
  right?: React.ReactNode
  danger?: boolean
  first?: boolean
  onClick?: () => void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`w-full flex items-center gap-3 px-3.5 py-3 text-left active:bg-kd-panel-hi ${first ? '' : 'border-t border-kd-border'}`}
    >
      <span className={danger ? 'text-kd-danger' : 'text-kd-text-soft'}>{icon}</span>
      <span className={`flex-1 text-[14px] ${danger ? 'text-kd-danger font-semibold' : 'text-kd-text'}`}>{label}</span>
      {right}
    </button>
  )
}

export function MobileSettingsScreen({ page }: { page?: string }) {
  const [, navigate] = useLocation()
  const mode = useThemeStore((s) => s.mode)
  const setMode = useThemeStore((s) => s.setMode)
  const isDark = effectiveTheme(mode) === 'dark'

  const sub = page ? SUB[page] : undefined
  if (sub) {
    return (
      <>
        <TopBar title={sub.title} onBack={() => navigate('/settings')} />
        <div className="flex-1 overflow-y-auto min-h-0">
          <div className="px-4 py-4">{sub.render()}</div>
        </div>
      </>
    )
  }

  return (
    <>
      <TopBar
        title="настройки"
        onBack={() => { if (window.history.length > 1) window.history.back(); else navigate('/profile') }}
      />
      <div className="flex-1 overflow-y-auto min-h-0 p-4">
        <Section title="— аккаунт">
          <Row first icon={<Icon.Users size={18} />} label="профиль" right={Chevron} onClick={() => navigate('/settings/profile')} />
          <Row icon={<Icon.Sparkle size={18} />} label="внешний вид" right={Chevron} onClick={() => navigate('/settings/appearance')} />
          <Row icon={<Icon.Moon size={18} />} label="тёмная тема" right={<Switch on={isDark} />} onClick={() => setMode(isDark ? 'light' : 'dark')} />
        </Section>

        <Section title="— уведомления">
          <Row first icon={<Icon.Bell size={18} />} label="уведомления" right={Chevron} onClick={() => navigate('/settings/notifications')} />
          <Row icon={<Icon.Mic size={18} />} label="голос и видео" right={Chevron} onClick={() => navigate('/settings/voice')} />
          <Row icon={<Icon.Speaker size={18} />} label="звуки" right={Chevron} onClick={() => navigate('/settings/sounds')} />
        </Section>

        <Section title="— безопасность">
          <Row first icon={<Icon.Lock size={18} />} label="управление ключами" right={Chevron} onClick={() => navigate('/secret')} />
          <Row icon={<Icon.ShieldCheck size={18} />} label="мои safety numbers" right={Chevron} onClick={() => navigate('/secret')} />
        </Section>

        <Section title="— о приложении">
          <Row
            first
            icon={<Icon.Smile size={18} />}
            label="о КакДела"
            right={<span className="text-[11px] font-mono text-kd-text-mute">{APP_VERSION}</span>}
          />
        </Section>
      </div>
    </>
  )
}
