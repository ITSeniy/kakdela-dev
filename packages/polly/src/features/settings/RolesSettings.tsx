// Управление ролями сервера (как в Discord): список ролей слева, редактор
// справа — имя, цвет, hoist, упоминаемость, чекбоксы разрешений и назначение
// участникам. @everyone — базовая роль: правится только маска прав.

import { useEffect, useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'

import type { MemberPublic, Role } from '@kakdela/ginzu/api-types'
import { PERMISSION_META, Permissions, type PermissionFlag } from '@kakdela/ginzu/permissions'

import { Avatar } from '../../components/Avatar.js'
import { confirmDialog } from '../../components/ConfirmDialog.js'
import { Toggle } from '../../components/form/Toggle.js'
import { toast } from '../../components/toast/index.js'
import { ApiError } from '../../lib/api.js'
import { wsClient } from '../../lib/ws.js'
import { createRole, deleteRole, listRoles, patchRole, setMemberRoles } from '../roles/api.js'
import { listMembers } from '../servers/api.js'

const DEFAULT_COLORS = ['#d68b6c', '#c97b9b', '#7b9bc9', '#6cb38b', '#c9a96c', '#9b7bc9', '#a0a0a0']

interface Draft {
  name: string
  color: string | null
  permissions: number
  hoist: boolean
  mentionable: boolean
}

function draftOf(r: Role): Draft {
  return { name: r.name, color: r.color, permissions: r.permissions, hoist: r.hoist, mentionable: r.mentionable }
}

export function RolesSettings({ serverId }: { serverId: string }) {
  const queryClient = useQueryClient()
  const { data: roles = [], isLoading } = useQuery({
    queryKey: ['roles', serverId],
    queryFn: () => listRoles(serverId),
    staleTime: 30_000,
  })
  const { data: members = [] } = useQuery({
    queryKey: ['members', serverId],
    queryFn: () => listMembers(serverId),
    staleTime: 60_000,
  })

  const [selectedId, setSelectedId] = useState<string | null>(null)
  const selected = useMemo(() => roles.find((r) => r.id === selectedId) ?? null, [roles, selectedId])
  const [draft, setDraft] = useState<Draft | null>(null)

  // Выбор первой роли по загрузке + синк черновика при смене выбранной.
  useEffect(() => {
    if (!selectedId && roles.length > 0) setSelectedId(roles[0]!.id)
  }, [roles, selectedId])
  useEffect(() => {
    setDraft(selected ? draftOf(selected) : null)
  }, [selected])

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ['roles', serverId] })
    void queryClient.invalidateQueries({ queryKey: ['members', serverId] })
  }

  // Чужие правки ролей (другой админ, другое окно) — обновляем список,
  // пока настройки открыты; иначе редактор живёт на устаревшем срезе.
  useEffect(() => {
    return wsClient.on((event) => {
      if ((event.t === 'role.update' || event.t === 'member.roles') && event.serverId === serverId) {
        void queryClient.invalidateQueries({ queryKey: ['roles', serverId] })
        void queryClient.invalidateQueries({ queryKey: ['members', serverId] })
      }
    })
  }, [serverId, queryClient])

  const createMut = useMutation({
    mutationFn: () => createRole(serverId, { name: 'новая роль', color: DEFAULT_COLORS[0] }),
    onSuccess: (role) => { invalidate(); setSelectedId(role.id) },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : 'не удалось создать роль'),
  })

  const saveMut = useMutation({
    mutationFn: () => {
      if (!selected || !draft) throw new Error('no role')
      // @everyone — только права; остальным шлём всё.
      const body = selected.isEveryone
        ? { permissions: draft.permissions }
        : { name: draft.name.trim() || 'роль', color: draft.color, permissions: draft.permissions, hoist: draft.hoist, mentionable: draft.mentionable }
      return patchRole(selected.id, body)
    },
    onSuccess: () => { invalidate(); toast.success('роль сохранена') },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : 'не удалось сохранить'),
  })

  const reorderMut = useMutation({
    mutationFn: ({ id, position }: { id: string; position: number }) => patchRole(id, { position }),
    onSuccess: invalidate,
    onError: (e) => toast.error(e instanceof ApiError ? e.message : 'не удалось переместить'),
  })

  async function handleDelete() {
    if (!selected || selected.isEveryone) return
    const ok = await confirmDialog({
      title: `удалить роль «${selected.name}»?`,
      body: 'она исчезнет у всех участников.',
      confirmLabel: 'удалить',
      danger: true,
    })
    if (!ok) return
    try {
      await deleteRole(selected.id)
      setSelectedId(null)
      invalidate()
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : 'не удалось удалить роль')
    }
  }

  function toggleMemberRole(member: MemberPublic, has: boolean) {
    if (!selected) return
    const current = member.roles.map((r) => r.id)
    const next = has ? current.filter((id) => id !== selected.id) : [...current, selected.id]
    setMemberRoles(serverId, member.id, next)
      .then(invalidate)
      .catch((e) => toast.error(e instanceof ApiError ? e.message : 'не удалось изменить роли участника'))
  }

  function setPerm(flag: PermissionFlag, on: boolean) {
    setDraft((d) => {
      if (!d) return d
      const bit = Permissions[flag]
      return { ...d, permissions: on ? d.permissions | bit : d.permissions & ~bit }
    })
  }

  const dirty = useMemo(() => {
    if (!selected || !draft) return false
    const o = draftOf(selected)
    return o.name !== draft.name || o.color !== draft.color || o.permissions !== draft.permissions
      || o.hoist !== draft.hoist || o.mentionable !== draft.mentionable
  }, [selected, draft])

  if (isLoading) {
    return <div className="py-8 text-center text-kd-text-mute font-mono text-[11px]">загружаем…</div>
  }

  // Роли отсортированы сервером по position desc. @everyone — последняя.
  const orderable = roles.filter((r) => !r.isEveryone)

  return (
    <div className="flex gap-4 min-h-[420px]">
      {/* список ролей */}
      <div className="w-[220px] shrink-0 flex flex-col gap-1">
        <button
          type="button"
          onClick={() => createMut.mutate()}
          disabled={createMut.isPending}
          className="mb-1 px-3 py-1.5 rounded-kd bg-kd-accent text-white text-[11px] font-bold font-mono hover:bg-kd-accent-deep disabled:opacity-50"
        >
          + создать роль
        </button>
        {roles.map((r) => {
          const idx = orderable.indexOf(r)
          return (
            <div
              key={r.id}
              className={[
                'group flex items-center gap-2 px-2.5 py-1.5 rounded-kd border text-left transition-colors cursor-pointer',
                r.id === selectedId ? 'bg-kd-panel-hi border-kd-accent' : 'bg-kd-panel border-kd-border hover:bg-kd-panel-hi',
              ].join(' ')}
              onClick={() => setSelectedId(r.id)}
            >
              <span className="w-2.5 h-2.5 rounded-full shrink-0" style={{ background: r.color ?? 'var(--kd-text-mute)' }} />
              <span className="flex-1 min-w-0 truncate text-[12px] text-kd-text">{r.name}</span>
              {!r.isEveryone && (
                <span className="flex flex-col opacity-0 group-hover:opacity-100 transition-opacity shrink-0">
                  <button
                    type="button"
                    title="выше"
                    onClick={(e) => { e.stopPropagation(); const above = orderable[idx - 1]; if (above) reorderMut.mutate({ id: r.id, position: above.position }) }}
                    disabled={idx <= 0}
                    className="text-[8px] leading-none text-kd-text-mute hover:text-kd-text disabled:opacity-30"
                  >▲</button>
                  <button
                    type="button"
                    title="ниже"
                    onClick={(e) => { e.stopPropagation(); const below = orderable[idx + 1]; if (below) reorderMut.mutate({ id: r.id, position: below.position }) }}
                    disabled={idx >= orderable.length - 1}
                    className="text-[8px] leading-none text-kd-text-mute hover:text-kd-text disabled:opacity-30"
                  >▼</button>
                </span>
              )}
            </div>
          )
        })}
      </div>

      {/* редактор */}
      <div className="flex-1 min-w-0">
        {!selected || !draft ? (
          <div className="h-full flex items-center justify-center text-[12px] text-kd-text-mute font-mono">
            выбери роль слева
          </div>
        ) : (
          <div className="flex flex-col gap-4">
            {!selected.isEveryone ? (
              <>
                <div className="flex flex-col gap-1.5">
                  <label className="text-[10px] font-mono text-kd-text-mute uppercase tracking-wider">название</label>
                  <input
                    type="text"
                    value={draft.name}
                    onChange={(e) => setDraft({ ...draft, name: e.target.value.slice(0, 32) })}
                    className="bg-kd-bg border border-kd-border rounded px-2.5 py-2 text-[13px] text-kd-text outline-none focus:border-kd-accent"
                  />
                </div>
                <div className="flex flex-col gap-1.5">
                  <label className="text-[10px] font-mono text-kd-text-mute uppercase tracking-wider">цвет</label>
                  <div className="flex items-center gap-1.5 flex-wrap">
                    {DEFAULT_COLORS.map((c) => (
                      <button
                        key={c}
                        type="button"
                        onClick={() => setDraft({ ...draft, color: c })}
                        className={`w-6 h-6 rounded-full border-2 ${draft.color === c ? 'border-kd-text' : 'border-transparent'}`}
                        style={{ background: c }}
                      />
                    ))}
                    <input
                      type="color"
                      value={draft.color ?? '#a0a0a0'}
                      onChange={(e) => setDraft({ ...draft, color: e.target.value })}
                      className="w-6 h-6 rounded bg-transparent border border-kd-border cursor-pointer"
                      title="свой цвет"
                    />
                    {draft.color && (
                      <button type="button" onClick={() => setDraft({ ...draft, color: null })} className="text-[10px] font-mono text-kd-text-mute hover:text-kd-danger ml-1">без цвета</button>
                    )}
                  </div>
                </div>
                <Toggle on={draft.hoist} onChange={(v) => setDraft({ ...draft, hoist: v })} label="отдельная группа" hint="показывать носителей отдельно в списке участников" />
                <Toggle on={draft.mentionable} onChange={(v) => setDraft({ ...draft, mentionable: v })} label="можно упоминать" hint="разрешить @роль кому угодно" />
              </>
            ) : (
              <div className="text-[12px] text-kd-text-soft">
                <span className="font-semibold">@everyone</span> — базовая роль всех участников. Здесь задаются права по умолчанию.
              </div>
            )}

            {/* разрешения */}
            <div className="flex flex-col gap-1.5">
              <label className="text-[10px] font-mono text-kd-text-mute uppercase tracking-wider">разрешения</label>
              <div className="flex flex-col gap-1">
                {PERMISSION_META.map((p) => {
                  const on = (draft.permissions & Permissions[p.flag]) !== 0
                  return (
                    <Toggle
                      key={p.flag}
                      on={on}
                      onChange={(v) => setPerm(p.flag, v)}
                      label={p.label}
                      hint={p.hint}
                    />
                  )
                })}
              </div>
            </div>

            {/* участники с ролью (не для @everyone) */}
            {!selected.isEveryone && (
              <div className="flex flex-col gap-1.5">
                <label className="text-[10px] font-mono text-kd-text-mute uppercase tracking-wider">
                  участники с ролью
                </label>
                <div className="max-h-[200px] overflow-y-auto flex flex-col gap-0.5 border border-kd-border rounded-kd p-1.5 bg-kd-bg">
                  {members.map((m) => {
                    const has = m.roles.some((r) => r.id === selected.id)
                    return (
                      <button
                        key={m.id}
                        type="button"
                        onClick={() => toggleMemberRole(m, has)}
                        className="flex items-center gap-2 px-2 py-1 rounded hover:bg-kd-panel-hi text-left transition-colors"
                      >
                        <span className={`w-3.5 h-3.5 rounded border flex items-center justify-center text-[9px] shrink-0 ${has ? 'bg-kd-accent border-kd-accent text-white' : 'border-kd-border'}`}>
                          {has ? '✓' : ''}
                        </span>
                        <Avatar name={m.displayName} avatarUrl={m.avatarUrl} size={20} />
                        <span className="flex-1 min-w-0 truncate text-[12px] text-kd-text">{m.displayName}</span>
                      </button>
                    )
                  })}
                </div>
              </div>
            )}

            <div className="flex items-center gap-2 pt-1">
              <button
                type="button"
                disabled={!dirty || saveMut.isPending}
                onClick={() => saveMut.mutate()}
                className="px-3.5 py-1.5 rounded bg-kd-accent text-white text-[11px] font-bold font-mono hover:bg-kd-accent-deep disabled:opacity-50"
              >
                {saveMut.isPending ? '…' : 'сохранить'}
              </button>
              {!selected.isEveryone && (
                <button
                  type="button"
                  onClick={() => void handleDelete()}
                  className="px-3 py-1.5 rounded border border-kd-border text-[11px] font-mono text-kd-danger hover:bg-kd-danger/10"
                >
                  удалить роль
                </button>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
