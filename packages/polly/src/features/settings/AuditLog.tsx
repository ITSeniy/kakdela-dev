import { useMemo, useState } from 'react'
import { useInfiniteQuery } from '@tanstack/react-query'

import type { AuditAction, AuditEntry } from '@kakdela/ginzu/api-types'

import { Avatar } from '../../components/Avatar.js'
import { listAuditEntries } from '../audit/api.js'

interface AuditLogProps {
  serverId: string
}

const ACTION_LABEL: Record<AuditAction, string> = {
  'channel.create':   'создал канал',
  'channel.update':   'изменил канал',
  'channel.delete':   'удалил канал',
  'member.promote':   'повысил',
  'member.demote':    'понизил',
  'member.kick':      'выгнал',
  'member.role.set':  'назначил роли',
  'invite.create':    'создал инвайт',
  'invite.revoke':    'отозвал инвайт',
  'emoji.create':     'добавил эмодзи',
  'emoji.delete':     'удалил эмодзи',
  'role.create':      'создал роль',
  'role.update':      'изменил роль',
  'role.delete':      'удалил роль',
  'server.update':    'изменил сервер',
  'server.transfer':  'передал владение сервером',
}

const ALL_ACTIONS = Object.keys(ACTION_LABEL) as AuditAction[]

function strOrNull(v: unknown): string | null {
  return typeof v === 'string' ? v : null
}

/**
 * Краткое имя цели для строки лога. Извлекаем из metadata, потому что
 * сам объект мог быть удалён вместе с serverId-каскадом.
 */
function describeTarget(entry: AuditEntry): string {
  const m = entry.metadata ?? {}
  switch (entry.action) {
    case 'channel.create':
    case 'channel.delete':
      return `#${strOrNull(m.name) ?? '?'}`
    case 'channel.update': {
      const after = (m.after ?? {}) as Record<string, unknown>
      const before = (m.before ?? {}) as Record<string, unknown>
      const beforeName = strOrNull(before.name)
      const afterName = strOrNull(after.name)
      if (beforeName && afterName && beforeName !== afterName) {
        return `#${beforeName} → #${afterName}`
      }
      return `#${afterName ?? beforeName ?? '?'}`
    }
    case 'invite.create':
    case 'invite.revoke':
      return strOrNull(m.code) ?? '?'
    case 'emoji.create':
    case 'emoji.delete':
      return `:${strOrNull(m.name) ?? '?'}:`
    case 'member.promote':
    case 'member.demote':
    case 'member.kick':
    case 'member.role.set':
      return strOrNull(m.displayName) ?? '?'
    case 'role.create':
    case 'role.update':
    case 'role.delete':
      return strOrNull(m.name) ?? '?'
    case 'server.update': {
      const changed = Array.isArray(m.changed) ? m.changed.filter((v): v is string => typeof v === 'string') : []
      return changed.length > 0 ? changed.join(', ') : '?'
    }
    case 'server.transfer':
      return strOrNull(m.displayName) ?? '?'
  }
}

function fmtAbsolute(iso: string): string {
  return new Date(iso).toLocaleString('ru', {
    day:    '2-digit',
    month:  '2-digit',
    year:   '2-digit',
    hour:   '2-digit',
    minute: '2-digit',
  })
}

function fmtRelative(iso: string, now: number): string {
  const diff = (now - new Date(iso).getTime()) / 1000
  if (diff < 60) return 'только что'
  if (diff < 3600) return `${Math.floor(diff / 60)} мин назад`
  if (diff < 86400) return `${Math.floor(diff / 3600)} ч назад`
  if (diff < 7 * 86400) return `${Math.floor(diff / 86400)} дн назад`
  return fmtAbsolute(iso)
}

export function AuditLog({ serverId }: AuditLogProps) {
  const [actionFilter, setActionFilter] = useState<AuditAction | 'all'>('all')

  const query = useInfiniteQuery({
    queryKey:    ['audit', serverId],
    queryFn:     ({ pageParam }) => listAuditEntries(serverId, { before: pageParam, limit: 50 }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    staleTime: 10_000,
  })

  const allEntries = useMemo(() => {
    const out: AuditEntry[] = []
    for (const page of query.data?.pages ?? []) out.push(...page.entries)
    return out
  }, [query.data])

  const filtered = useMemo(() => {
    if (actionFilter === 'all') return allEntries
    return allEntries.filter((e) => e.action === actionFilter)
  }, [allEntries, actionFilter])

  // Шапка времени обновляется при каждом ререндере — для fmtRelative этого
  // достаточно, поскольку модал недолго живёт.
  const now = Date.now()

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-2 flex-wrap">
        <span className="text-[10px] text-kd-text-mute font-mono uppercase tracking-wider mr-1">
          фильтр ·
        </span>
        <button
          type="button"
          onClick={() => setActionFilter('all')}
          className={[
            'px-2 py-0.5 rounded-kd text-[10px] font-mono border transition-colors',
            actionFilter === 'all'
              ? 'bg-kd-accent-soft border-kd-accent text-kd-accent-deep'
              : 'bg-kd-panel-alt border-kd-border text-kd-text-soft hover:border-kd-text-mute',
          ].join(' ')}
        >
          всё
        </button>
        {ALL_ACTIONS.map((a) => (
          <button
            key={a}
            type="button"
            onClick={() => setActionFilter(a)}
            className={[
              'px-2 py-0.5 rounded-kd text-[10px] font-mono border transition-colors',
              actionFilter === a
                ? 'bg-kd-accent-soft border-kd-accent text-kd-accent-deep'
                : 'bg-kd-panel-alt border-kd-border text-kd-text-soft hover:border-kd-text-mute',
            ].join(' ')}
          >
            {a}
          </button>
        ))}
      </div>

      {query.isLoading && (
        <div className="text-center text-kd-text-mute font-mono text-[11px] py-6">
          загружаем…
        </div>
      )}

      {!query.isLoading && filtered.length === 0 && (
        <div className="text-center text-kd-text-mute font-mono text-[11px] py-6">
          {allEntries.length === 0 ? 'пока тишина' : 'нет записей с этим фильтром'}
        </div>
      )}

      {filtered.length > 0 && (
        <table className="w-full border-collapse">
          <thead>
            <tr className="text-left">
              <th className="py-1.5 pr-3 text-[9px] font-mono font-bold uppercase tracking-[0.05em] text-kd-text-mute">
                когда
              </th>
              <th className="py-1.5 pr-3 text-[9px] font-mono font-bold uppercase tracking-[0.05em] text-kd-text-mute">
                кто
              </th>
              <th className="py-1.5 pr-3 text-[9px] font-mono font-bold uppercase tracking-[0.05em] text-kd-text-mute">
                действие
              </th>
              <th className="py-1.5 text-[9px] font-mono font-bold uppercase tracking-[0.05em] text-kd-text-mute">
                цель
              </th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((e) => (
              <tr key={e.id} className="border-t border-kd-border-soft hover:bg-kd-panel-soft">
                <td
                  className="py-1.5 pr-3 text-[10px] font-mono text-kd-text-mute whitespace-nowrap align-top"
                  title={`${fmtAbsolute(e.createdAt)} · ${e.action}`}
                >
                  {fmtRelative(e.createdAt, now)}
                </td>
                <td className="py-1.5 pr-3 align-top">
                  <div className="flex items-center gap-1.5 min-w-0">
                    {e.actor ? (
                      <Avatar name={e.actor.displayName} avatarUrl={e.actor.avatarUrl} size={18} />
                    ) : (
                      <div className="w-[18px] h-[18px] rounded-full bg-kd-panel-alt border border-kd-border shrink-0" />
                    )}
                    <span className="text-[11px] font-semibold text-kd-text truncate">
                      {e.actor?.displayName ?? 'удалённый'}
                    </span>
                  </div>
                </td>
                <td className="py-1.5 pr-3 text-[11px] text-kd-text-soft whitespace-nowrap align-top">
                  {ACTION_LABEL[e.action]}
                </td>
                <td className="py-1.5 text-[11px] font-mono text-kd-text align-top">
                  {describeTarget(e)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {query.hasNextPage && (
        <button
          type="button"
          onClick={() => void query.fetchNextPage()}
          disabled={query.isFetchingNextPage}
          className="mx-auto px-3 py-1 rounded bg-kd-panel-alt border border-kd-border text-[11px] font-mono text-kd-text-soft hover:bg-kd-panel-hi disabled:opacity-50"
        >
          {query.isFetchingNextPage ? 'грузим…' : 'показать ещё'}
        </button>
      )}
    </div>
  )
}
