// Настройки канала «по эталону»: модалка с левым сайдбаром и панелью «обзор»
// (название, тип, тема, медленный режим, автоудаление, тумблеры). Сохранение
// явное: считаем дифф черновика против канала и шлём только изменённые поля.
// Разделы без бэкенда (права, вебхуки, интеграции…) сознательно выпилены —
// закреплённые живут в PinnedPanel чата, инвайты — на уровне сервера.

import { useMemo, useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'

import type { Channel, PatchChannelRequest } from '@kakdela/ginzu/api-types'

import { confirmDialog } from '../../components/ConfirmDialog.js'
import { Toggle } from '../../components/form/Toggle.js'
import { Icon } from '../../components/Icon.js'
import { Modal } from '../../components/Modal.js'
import { toast } from '../../components/toast/index.js'
import { ApiError } from '../../lib/api.js'
import { deleteChannel, patchChannel } from '../servers/api.js'

interface ChannelSettingsModalProps {
  channel: Channel
  onClose(): void
  /** Вызывается после удаления канала — родитель уводит с него. */
  onDeleted?(): void
}

const SLOW_MODE_OPTIONS: { value: number; label: string }[] = [
  { value: 0,    label: 'выкл' },
  { value: 5,    label: '5 секунд' },
  { value: 10,   label: '10 секунд' },
  { value: 15,   label: '15 секунд' },
  { value: 30,   label: '30 секунд' },
  { value: 60,   label: '1 минута' },
  { value: 120,  label: '2 минуты' },
  { value: 300,  label: '5 минут' },
  { value: 600,  label: '10 минут' },
  { value: 900,  label: '15 минут' },
  { value: 3600, label: '1 час' },
]

const AUTO_DELETE_OPTIONS: { value: number | null; label: string }[] = [
  { value: null,     label: 'выкл' },
  { value: 3600,     label: 'через 1 час' },
  { value: 86400,    label: 'через 24 часа' },
  { value: 259200,   label: 'через 3 дня' },
  { value: 604800,   label: 'через 7 дней' },
  { value: 2592000,  label: 'через 30 дней' },
  { value: 7776000,  label: 'через 90 дней' },
]

interface Draft {
  name: string
  kind: 'text' | 'voice'
  topic: string
  slowModeSec: number
  autoDeleteSec: number | null
  isDefault: boolean
  friendsOnly: boolean
  nsfw: boolean
  threadsAllowed: boolean
}

function draftFromChannel(c: Channel): Draft {
  return {
    name:           c.name,
    kind:           c.kind === 'voice' ? 'voice' : 'text',
    topic:          c.topic ?? '',
    slowModeSec:    c.slowModeSec ?? 0,
    autoDeleteSec:  c.autoDeleteSec ?? null,
    isDefault:      c.isDefault ?? false,
    friendsOnly:    c.friendsOnly ?? false,
    nsfw:           c.nsfw ?? false,
    threadsAllowed: c.threadsAllowed ?? true,
  }
}

/** Поля черновика, отличающиеся от канала, — то, что отправим в PATCH. */
function diff(orig: Draft, next: Draft): PatchChannelRequest {
  const patch: PatchChannelRequest = {}
  if (next.name.trim() !== orig.name) patch.name = next.name.trim()
  if (next.kind !== orig.kind) patch.kind = next.kind
  if (next.topic !== orig.topic) patch.topic = next.topic.trim() || null
  if (next.slowModeSec !== orig.slowModeSec) patch.slowModeSec = next.slowModeSec
  if (next.autoDeleteSec !== orig.autoDeleteSec) patch.autoDeleteSec = next.autoDeleteSec
  if (next.isDefault !== orig.isDefault) patch.isDefault = next.isDefault
  if (next.friendsOnly !== orig.friendsOnly) patch.friendsOnly = next.friendsOnly
  if (next.nsfw !== orig.nsfw) patch.nsfw = next.nsfw
  if (next.threadsAllowed !== orig.threadsAllowed) patch.threadsAllowed = next.threadsAllowed
  return patch
}

const FIELD_LABEL = 'text-[10px] font-mono text-kd-text-mute uppercase tracking-wider'
const SELECT_CLS = 'w-full bg-kd-bg border border-kd-border rounded px-2.5 py-2 text-[12px] text-kd-text outline-none focus:border-kd-accent appearance-none cursor-pointer'

export function ChannelSettingsModal({ channel, onClose, onDeleted }: ChannelSettingsModalProps) {
  const queryClient = useQueryClient()
  const orig = useMemo(() => draftFromChannel(channel), [channel])
  const [draft, setDraft] = useState<Draft>(orig)

  const patch = useMemo(() => diff(orig, draft), [orig, draft])
  const changedCount = Object.keys(patch).length
  const dirty = changedCount > 0

  function set<K extends keyof Draft>(key: K, value: Draft[K]) {
    setDraft((d) => ({ ...d, [key]: value }))
  }

  const saveMutation = useMutation({
    mutationFn: () => patchChannel(channel.id, patch),
    onSuccess: () => {
      if (channel.serverId) void queryClient.invalidateQueries({ queryKey: ['server', channel.serverId] })
      void queryClient.invalidateQueries({ queryKey: ['channel', channel.id] })
      toast.success('настройки канала сохранены')
      onClose()
    },
    onError: (err) => {
      toast.error(err instanceof ApiError ? err.message : 'не удалось сохранить')
    },
  })

  async function handleDelete() {
    const ok = await confirmDialog({
      title: `удалить #${channel.name}?`,
      body: 'канал и все его сообщения исчезнут безвозвратно.',
      confirmLabel: 'удалить канал',
      danger: true,
    })
    if (!ok) return
    try {
      await deleteChannel(channel.id)
      if (channel.serverId) void queryClient.invalidateQueries({ queryKey: ['server', channel.serverId] })
      onClose()
      onDeleted?.()
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'не удалось удалить канал')
    }
  }

  function onKeyDown(e: React.KeyboardEvent) {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter' && dirty) {
      e.preventDefault()
      saveMutation.mutate()
    }
  }

  return (
    <Modal onClose={onClose} width={780} className="h-[580px]" closeOnBackdrop={!dirty}>
      <div className="flex flex-col h-full" onKeyDown={onKeyDown}>
        {/* header */}
        <div className="px-5 py-3 border-b border-kd-border bg-kd-panel-alt flex items-center gap-2 shrink-0">
          <Icon.Hash size={14} className="text-kd-text-soft" />
          <span className="text-[13px] font-bold text-kd-text">{channel.name}</span>
          <span className="text-[11px] text-kd-text-mute">· настройки канала</span>
          <div className="flex-1" />
          <button
            type="button"
            onClick={onClose}
            className="px-2.5 py-1 rounded bg-kd-bg/60 hover:bg-kd-bg text-kd-text-soft text-[10px] font-mono"
          >
            esc ✕
          </button>
        </div>

        {/* body: sidebar + content */}
        <div className="flex flex-1 min-h-0">
          {/* sidebar */}
          <div className="w-[200px] shrink-0 border-r border-kd-border bg-kd-panel-alt/50 flex flex-col">
            <nav className="flex-1 overflow-y-auto py-3 px-2.5 flex flex-col gap-0.5">
              <span className="text-left px-2.5 py-1.5 rounded text-[12px] bg-kd-accent/15 text-kd-accent font-semibold">
                обзор
              </span>
              <div className="h-px bg-kd-border my-2 mx-1" />
              <button
                type="button"
                onClick={() => void handleDelete()}
                className="text-left px-2.5 py-1.5 rounded text-[12px] text-kd-danger hover:bg-kd-danger/10 transition-colors"
              >
                удалить канал
              </button>
            </nav>
            <div className="px-3.5 py-3 border-t border-kd-border text-[9px] font-mono text-kd-text-mute leading-relaxed">
              <div>канал · #{channel.id.slice(0, 8)}</div>
              <div className="mt-0.5">{channel.kind === 'voice' ? 'голосовой' : 'текстовый'}</div>
            </div>
          </div>

          {/* content */}
          <div className="flex-1 min-w-0 overflow-y-auto px-6 py-5">
            <div className="flex flex-col gap-4">
              <div className="text-[14px] font-bold text-kd-text">обзор</div>

              <div className="grid grid-cols-2 gap-3">
                <div className="flex flex-col gap-1.5">
                  <label className={FIELD_LABEL}>название</label>
                  <div className="flex items-center bg-kd-bg border border-kd-border rounded px-2.5 focus-within:border-kd-accent">
                    <span className="text-kd-text-mute text-[13px]">#</span>
                    <input
                      type="text"
                      value={draft.name}
                      onChange={(e) => set('name', e.target.value.slice(0, 64))}
                      className="flex-1 bg-transparent px-1.5 py-2 text-[13px] text-kd-text outline-none min-w-0"
                    />
                  </div>
                </div>
                <div className="flex flex-col gap-1.5">
                  <label className={FIELD_LABEL}>тип канала</label>
                  <select
                    value={draft.kind}
                    onChange={(e) => set('kind', e.target.value as 'text' | 'voice')}
                    className={SELECT_CLS}
                  >
                    <option value="text">текстовый</option>
                    <option value="voice">голосовой</option>
                  </select>
                </div>
              </div>

              <div className="flex flex-col gap-1.5">
                <label className={FIELD_LABEL}>о чём канал</label>
                <input
                  type="text"
                  value={draft.topic}
                  onChange={(e) => set('topic', e.target.value.slice(0, 256))}
                  placeholder="как ты сегодня? расскажи в двух словах"
                  className="bg-kd-bg border border-kd-border rounded px-2.5 py-2 text-[13px] text-kd-text outline-none focus:border-kd-accent placeholder:text-kd-text-mute"
                />
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div className="flex flex-col gap-1.5">
                  <label className={FIELD_LABEL}>медленный режим</label>
                  <select
                    value={draft.slowModeSec}
                    onChange={(e) => set('slowModeSec', Number(e.target.value))}
                    className={SELECT_CLS}
                  >
                    {SLOW_MODE_OPTIONS.map((o) => (
                      <option key={o.value} value={o.value}>{o.label}</option>
                    ))}
                  </select>
                </div>
                <div className="flex flex-col gap-1.5">
                  <label className={FIELD_LABEL}>автоудаление сообщений</label>
                  <select
                    value={draft.autoDeleteSec === null ? '' : String(draft.autoDeleteSec)}
                    onChange={(e) => set('autoDeleteSec', e.target.value === '' ? null : Number(e.target.value))}
                    className={SELECT_CLS}
                  >
                    {AUTO_DELETE_OPTIONS.map((o) => (
                      <option key={o.label} value={o.value === null ? '' : o.value}>{o.label}</option>
                    ))}
                  </select>
                </div>
              </div>

              <div className="flex flex-col gap-2 mt-1">
                <Toggle
                  on={draft.isDefault}
                  onChange={(v) => set('isDefault', v)}
                  label="канал по умолчанию"
                  hint="новые участники автоматически попадают сюда"
                />
                <Toggle
                  on={draft.friendsOnly}
                  onChange={(v) => set('friendsOnly', v)}
                  label="только для своих"
                  hint="недоступен по приглашению «друг»"
                />
                <Toggle
                  on={draft.nsfw}
                  onChange={(v) => set('nsfw', v)}
                  label="NSFW · 18+"
                  hint="скрывать превью и блюрить медиа"
                />
                <Toggle
                  on={draft.threadsAllowed}
                  onChange={(v) => set('threadsAllowed', v)}
                  label="треды разрешены"
                  hint="можно ответить веткой на любое сообщение"
                />
              </div>

              <div className="mt-1 px-3 py-2 rounded bg-kd-bg/60 border border-kd-border/60 text-[10px] font-mono text-kd-text-mute leading-relaxed">
                {dirty
                  ? <>&gt; {changedCount} {changedCount === 1 ? 'изменение' : 'изменений'} · сохрани ⌘⏎ или закрой окно для отмены</>
                  : <>&gt; всё сохранено</>}
              </div>
            </div>
          </div>
        </div>

        {/* footer */}
        <div className="px-5 py-3 border-t border-kd-border bg-kd-panel-alt flex items-center gap-3 shrink-0">
          <span className={`text-[11px] font-mono ${dirty ? 'text-kd-warm' : 'text-kd-text-mute'}`}>
            {dirty ? `не сохранено · ${changedCount} ${changedCount === 1 ? 'изменение' : 'изменений'}` : 'сохранено'}
          </span>
          <div className="flex-1" />
          <button
            type="button"
            onClick={onClose}
            className="px-3 py-1.5 rounded bg-kd-panel border border-kd-border text-[11px] font-mono text-kd-text-soft hover:bg-kd-panel-hi"
          >
            отмена
          </button>
          <button
            type="button"
            disabled={!dirty || saveMutation.isPending}
            onClick={() => saveMutation.mutate()}
            className="px-3.5 py-1.5 rounded bg-kd-accent text-white text-[11px] font-bold font-mono hover:bg-kd-accent-deep disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {saveMutation.isPending ? '…' : 'сохранить ⌘⏎'}
          </button>
        </div>
      </div>
    </Modal>
  )
}
