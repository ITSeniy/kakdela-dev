// Профиль участника. Источник паттерна: designs/final-profile.jsx —
// шапка-баннер (фото или градиент) без ModalHeader, аватар 70 с ring
// внахлёст, секции panel-alt: о себе, статус + часовой пояс, общие комнаты.

import { useEffect, useRef, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useLocation } from 'wouter'

import type { MemberPublic, Role, UserProfile } from '@kakdela/ginzu/api-types'
import { hasPermission } from '@kakdela/ginzu/permissions'

import { ApiError } from '../../lib/api.js'
import { Avatar } from '../../components/Avatar.js'
import { Icon } from '../../components/Icon.js'
import { Modal } from '../../components/Modal.js'
import { toast } from '../../components/toast/index.js'
import { useAuthStore } from '../auth/store.js'
import { listRoles, setMemberRoles } from '../roles/api.js'
import { listMembers } from '../servers/api.js'
import { useSettingsUi } from '../settings/store.js'
import { StartSecretChat } from '../secret/StartSecretChat.js'
import { getUserProfile } from './api.js'
import { fmtJoined, fmtTzNow } from './format.js'
import { useProfileUi } from './store.js'

// Позиция участника в иерархии ролей (зеркало lib/permissions.ts на сервере):
// owner — выше всех, admin — выше любых кастомных, иначе — максимум позиций
// своих кастомных ролей.
function memberTopPosition(m: MemberPublic): number {
  if (m.role === 'owner') return Number.POSITIVE_INFINITY
  if (m.role === 'admin') return 1_000_000_000
  let p = -1
  for (const r of m.roles) if (r.position > p) p = r.position
  return p
}

const STATUS_LABEL: Record<UserProfile['status'], string> = {
  online:  'в сети',
  idle:    'отошёл',
  dnd:     'не беспокоить',
  offline: 'не в сети',
}

const STATUS_DOT: Record<UserProfile['status'], string> = {
  online:  'bg-kd-online',
  idle:    'bg-kd-idle',
  dnd:     'bg-kd-dnd',
  offline: 'bg-kd-text-mute',
}

const ROLE_LABEL: Record<UserProfile['sharedServers'][number]['role'], string> = {
  owner:  'хозяин',
  admin:  'админ',
  member: 'свой',
}

/** Label секции профиля: mono uppercase 10px (designs/final-profile.jsx). */
function SectionTitle({ children }: { children: React.ReactNode }) {
  return (
    <div className="text-[10px] font-mono font-bold uppercase tracking-[0.05em] text-kd-text-mute mb-1.5">
      {children}
    </div>
  )
}

function ReadView({ profile }: { profile: UserProfile }) {
  const [location, navigate] = useLocation()
  const close = useProfileUi((s) => s.close)
  const openSettings = useSettingsUi((s) => s.open)

  // Сервер-контекст для назначения ролей: профиль открыли, находясь в сервере.
  // Назначение всегда server-scoped, поэтому «+» работает в пределах этого id.
  const activeServerId = /^\/servers\/([0-9a-f-]{36})/.exec(location)?.[1] ?? null

  function openDm() {
    close()
    navigate(`/dm/with/${profile.id}`)
  }

  // Редактирование живёт в полноэкранных настройках («аккаунт → мой профиль»).
  function openProfileSettings() {
    close()
    openSettings('profile')
  }

  const tzNow = profile.timezone ? fmtTzNow(profile.timezone) : null

  return (
    <div className="px-[18px] pb-4">
      {/* аватар внахлёст на баннер; -mt-6 (не -7) + leading-none — иначе
          колонка имени (прижатая к низу items-end) верхом упиралась в баннер */}
      <div className="flex items-end gap-3 -mt-6 mb-3">
        <Avatar
          name={profile.displayName}
          avatarUrl={profile.avatarUrl}
          size={70}
          status={profile.status}
          ring="var(--kd-accent)"
          ringColor="var(--kd-panel)"
        />
        <div className="flex-1 min-w-0 pb-1">
          <div className="text-[18px] leading-none font-bold text-kd-text tracking-[-0.01em] truncate">
            {profile.displayName}
          </div>
          <div className="text-[11px] leading-none mt-1 text-kd-text-mute font-mono truncate">
            @{profile.username} · с нами с {fmtJoined(profile.createdAt)}
          </div>
        </div>
        {profile.isSelf ? (
          <button
            type="button"
            onClick={openProfileSettings}
            className="px-2.5 py-[5px] mb-1 rounded bg-kd-panel-alt border border-kd-border text-[11px] font-mono font-semibold text-kd-text hover:bg-kd-panel-hi shrink-0"
          >
            ⚙ настройки
          </button>
        ) : (
          <button
            type="button"
            onClick={openDm}
            className="px-2.5 py-[5px] mb-1 rounded bg-kd-accent text-white text-[11px] font-mono font-semibold hover:bg-kd-accent-deep shrink-0"
          >
            написать ⏎
          </button>
        )}
      </div>

      {/* секретный чат — только на мобиле, только для чужого профиля (T-103) */}
      {!profile.isSelf && <StartSecretChat userId={profile.id} />}

      {/* о себе */}
      {profile.about && (
        <div className="p-3 rounded-kd bg-kd-panel-alt border border-kd-border mb-2.5">
          <SectionTitle>о себе</SectionTitle>
          <div className="text-[13px] text-kd-text leading-relaxed whitespace-pre-wrap break-words">
            {profile.about}
          </div>
        </div>
      )}

      {/* статус + часовой пояс в один ряд */}
      <div className="flex gap-2 mb-2.5">
        <div className="flex-1 min-w-0 px-2.5 py-2 rounded-kd bg-kd-panel-alt border border-kd-border flex items-center gap-2">
          <span className={`w-2 h-2 rounded-full shrink-0 ${STATUS_DOT[profile.status]}`} />
          <div className="min-w-0">
            <div className="text-[11px] font-mono text-kd-text-mute">статус</div>
            <div className="text-[12px] font-semibold text-kd-text truncate">
              {profile.customStatus ?? STATUS_LABEL[profile.status]}
            </div>
          </div>
        </div>
        {tzNow && (
          <div className="flex-1 min-w-0 px-2.5 py-2 rounded-kd bg-kd-panel-alt border border-kd-border">
            <div className="text-[11px] font-mono text-kd-text-mute">часовой пояс</div>
            <div className="text-[12px] font-semibold text-kd-text truncate" title={profile.timezone ?? undefined}>
              {tzNow}
            </div>
          </div>
        )}
      </div>

      {/* роли — цветные пилюли + «+» для тех, кто вправе назначать (по концепту
          секция ниже статуса/часового пояса) */}
      <RolesSection profile={profile} activeServerId={activeServerId} />

      {profile.sharedServers.length > 0 && (
        <div>
          <SectionTitle>
            {profile.isSelf ? 'мои комнаты' : 'общие комнаты'} · {profile.sharedServers.length}
          </SectionTitle>
          <div className="flex flex-col gap-1">
            {profile.sharedServers.map((s) => (
              <button
                key={s.id}
                type="button"
                onClick={() => { close(); navigate(`/servers/${s.id}`) }}
                className="flex items-center gap-2.5 px-2 py-1.5 rounded hover:bg-kd-panel-hi transition-colors text-left"
              >
                <div className="w-[26px] h-[26px] rounded bg-kd-accent text-white flex items-center justify-center text-[11px] font-bold shrink-0">
                  {s.name.charAt(0).toUpperCase()}
                </div>
                <div className="flex-1 min-w-0">
                  <div className="text-[12px] font-semibold text-kd-text truncate">{s.name}</div>
                  <div className="text-[10px] text-kd-text-mute font-mono">{ROLE_LABEL[s.role]}</div>
                </div>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

/**
 * Цветная пилюля роли (designs/final-profile.jsx). Если передан `onRemove` —
 * на наведение показывается «×», снимающий роль (для тех, кто вправе её
 * убирать). Место под «×» зарезервировано, чтобы чип не дёргался.
 */
function RoleChip({
  name, color, onRemove, busy,
}: {
  name: string
  color: string | null
  onRemove?: () => void
  busy?: boolean
}) {
  return (
    <span
      className={[
        'group inline-flex items-center gap-1.5 py-0.5 rounded-full border bg-kd-panel-alt text-[11px] font-mono text-kd-text',
        onRemove ? 'pl-2 pr-1' : 'px-2',
      ].join(' ')}
      style={{ borderColor: color ? `${color}55` : 'var(--kd-border)' }}
    >
      <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ background: color ?? 'var(--kd-text-mute)' }} />
      {name}
      {onRemove && (
        <button
          type="button"
          disabled={busy}
          onClick={onRemove}
          title="убрать роль"
          className="shrink-0 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 focus:opacity-100 text-kd-text-mute hover:text-kd-danger transition-opacity disabled:opacity-50"
        >
          <Icon.X size={11} />
        </button>
      )}
    </span>
  )
}

/**
 * Секция «роли» с пилюлями и кнопкой «+» для назначения. «+» виден, только
 * если профиль открыт в контексте сервера, у меня есть MANAGE_ROLES там, и я
 * по иерархии выше цели (или это я сам). Кандидаты — роли сервера ниже моей
 * позиции, ещё не выданные. Сами правила дублирует и проверяет сервер.
 */
function RolesSection({ profile, activeServerId }: { profile: UserProfile; activeServerId: string | null }) {
  const me = useAuthStore((s) => s.user)
  const queryClient = useQueryClient()
  const [pickerOpen, setPickerOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  const { data: members = [] } = useQuery({
    queryKey: ['members', activeServerId],
    queryFn: () => listMembers(activeServerId!),
    enabled: activeServerId !== null,
    staleTime: 60_000,
  })

  const meMember = me ? members.find((m) => m.id === me.id) : undefined
  const targetMember = members.find((m) => m.id === profile.id)
  const myPosition = meMember ? memberTopPosition(meMember) : -1
  const targetPosition = targetMember ? memberTopPosition(targetMember) : -1
  const canManageRoles = hasPermission(meMember?.permissions ?? 0, 'MANAGE_ROLES')
  const canAct = profile.isSelf || myPosition > targetPosition
  const canAdd = activeServerId !== null && canManageRoles && canAct

  const { data: serverRoles = [] } = useQuery({
    queryKey: ['roles', activeServerId],
    queryFn: () => listRoles(activeServerId!),
    enabled: canAdd,
    staleTime: 30_000,
  })

  const targetRoleIds = new Set((targetMember?.roles ?? []).map((r) => r.id))
  const candidates = serverRoles
    .filter((r) => !r.isEveryone && !targetRoleIds.has(r.id) && myPosition > r.position)
    .sort((a, b) => b.position - a.position)
  const showPlus = canAdd && candidates.length > 0

  useEffect(() => {
    if (!pickerOpen) return undefined
    function onDown(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setPickerOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [pickerOpen])

  async function assign(role: Role) {
    if (!activeServerId || busy) return
    setBusy(true)
    // Шлём только управляемое подмножество (роли ниже меня) + новую; роли выше
    // меня сервер сохранит сам (lockedKeep в PUT-роуте).
    const manageable = (targetMember?.roles ?? []).filter((r) => myPosition > r.position).map((r) => r.id)
    const next = [...new Set([...manageable, role.id])]
    try {
      await setMemberRoles(activeServerId, profile.id, next)
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['user-profile', profile.id] }),
        queryClient.invalidateQueries({ queryKey: ['members', activeServerId] }),
      ])
      setPickerOpen(false)
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'не удалось назначить роль')
    } finally {
      setBusy(false)
    }
  }

  async function removeRole(roleId: string) {
    if (!activeServerId || busy) return
    setBusy(true)
    // Снимаем из управляемого подмножества; роли выше меня (locked) PUT-роут
    // сохранит сам, поэтому их не трогаем.
    const next = (targetMember?.roles ?? [])
      .filter((r) => myPosition > r.position && r.id !== roleId)
      .map((r) => r.id)
    try {
      await setMemberRoles(activeServerId, profile.id, next)
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['user-profile', profile.id] }),
        queryClient.invalidateQueries({ queryKey: ['members', activeServerId] }),
      ])
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'не удалось убрать роль')
    } finally {
      setBusy(false)
    }
  }

  // Снять можно роль, которую я вправе менять: в этом сервере, ниже моей позиции.
  const canRemove = (roleId: string, position: number): boolean =>
    canManageRoles && canAct && targetRoleIds.has(roleId) && myPosition > position

  if (profile.roles.length === 0 && !showPlus) return null

  return (
    <div className="mb-2.5">
      <SectionTitle>роли · {profile.roles.length}</SectionTitle>
      <div className="flex flex-wrap items-center gap-1.5">
        {profile.roles.map((r) => (
          <RoleChip
            key={r.id}
            name={r.name}
            color={r.color}
            busy={busy}
            onRemove={canRemove(r.id, r.position) ? () => void removeRole(r.id) : undefined}
          />
        ))}
        {showPlus && (
          <div className="relative" ref={ref}>
            <button
              type="button"
              onClick={() => setPickerOpen((o) => !o)}
              title="добавить роль"
              className={[
                'inline-flex items-center justify-center w-6 h-6 rounded-full border border-dashed text-[14px] leading-none transition-colors',
                pickerOpen
                  ? 'border-kd-accent text-kd-accent'
                  : 'border-kd-border text-kd-text-mute hover:border-kd-text-mute hover:text-kd-text',
              ].join(' ')}
            >
              +
            </button>
            {pickerOpen && (
              <div className="absolute left-0 top-full mt-1 z-20 min-w-[180px] max-h-[180px] overflow-y-auto bg-kd-panel border border-kd-border rounded-kd shadow-lg py-1">
                {candidates.map((r) => (
                  <button
                    key={r.id}
                    type="button"
                    disabled={busy}
                    onClick={() => void assign(r)}
                    className="w-full flex items-center gap-2 px-3 py-1.5 text-left text-[12px] text-kd-text hover:bg-kd-panel-alt transition-colors disabled:opacity-50"
                  >
                    <span className="w-2 h-2 rounded-full shrink-0" style={{ background: r.color ?? 'var(--kd-text-mute)' }} />
                    <span className="truncate">{r.name}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

/** «···» в шапке: скопировать ник, для своего профиля — настройки. */
function HeaderMenu({ profile, onClose }: { profile: UserProfile; onClose(): void }) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const openSettings = useSettingsUi((s) => s.open)

  useEffect(() => {
    if (!open) return
    function onDown(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [open])

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="px-2 py-1 rounded bg-kd-overlay-soft text-kd-stage-text text-[10px] font-mono transition-opacity hover:opacity-80"
      >
        · · ·
      </button>
      {open && (
        <div className="absolute right-0 top-full mt-1 z-10 min-w-[170px] bg-kd-panel border border-kd-border rounded-kd shadow-lg py-1">
          <button
            type="button"
            onClick={() => {
              if (navigator.clipboard) void navigator.clipboard.writeText(`@${profile.username}`)
              setOpen(false)
            }}
            className="block w-full text-left px-3 py-1.5 text-[12px] text-kd-text hover:bg-kd-panel-alt transition-colors"
          >
            скопировать @ник
          </button>
          {profile.isSelf && (
            <button
              type="button"
              onClick={() => {
                setOpen(false)
                onClose()
                openSettings('profile')
              }}
              className="block w-full text-left px-3 py-1.5 text-[12px] text-kd-text hover:bg-kd-panel-alt transition-colors"
            >
              настройки профиля
            </button>
          )}
        </div>
      )}
    </div>
  )
}

export function ProfileModal() {
  const openUserId = useProfileUi((s) => s.openUserId)
  const close = useProfileUi((s) => s.close)

  const enabled = openUserId !== null
  const { data: profile, isLoading, error } = useQuery({
    queryKey: ['user-profile', openUserId],
    queryFn: () => getUserProfile(openUserId!),
    enabled,
    staleTime: 30_000,
  })

  if (!enabled) return null

  const errorMsg = error instanceof ApiError ? error.message : (error as Error | null)?.message

  return (
    <Modal onClose={close} width={460}>
      {/* единый скролл-контейнер: шапка + контент, чтобы -mt-7 аватара не клипался */}
      <div className="overflow-y-auto min-h-0">
        <div className="relative h-20 bg-gradient-to-br from-kd-profile-grad-from to-kd-profile-grad-to">
          {profile?.bannerUrl && (
            <img
              src={profile.bannerUrl}
              alt=""
              className="absolute inset-0 w-full h-full object-cover"
              draggable={false}
            />
          )}
          <div className="absolute top-2 right-2.5 flex gap-1">
            {profile && <HeaderMenu profile={profile} onClose={close} />}
            <button
              type="button"
              onClick={close}
              title="esc"
              className="px-2 py-1 rounded bg-kd-overlay-soft text-kd-stage-text text-[10px] font-mono transition-opacity hover:opacity-80"
            >
              esc ✕
            </button>
          </div>
        </div>
        {isLoading && (
          <div className="p-8 text-center text-kd-text-mute font-mono text-[11px]">загружаем…</div>
        )}
        {errorMsg && !profile && (
          <div className="p-8 text-center text-kd-danger font-mono text-[11px]">{errorMsg}</div>
        )}
        {profile && <ReadView profile={profile} />}
      </div>
    </Modal>
  )
}
