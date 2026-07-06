import { type ChangeEvent, useEffect, useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useLocation } from 'wouter'

import { confirmDialog } from '../../components/ConfirmDialog.js'
import { Field } from '../../components/form/Field.js'
import { ApiError } from '../../lib/api.js'
import { useAuthStore } from '../auth/store.js'
import { isSupportedType, uploadAttachment, UploadError } from '../files/upload.js'
import {
  deleteServer,
  getServerDetail,
  leaveServer,
  listMembers,
  patchServer,
  transferOwnership,
} from '../servers/api.js'
import { useSettingsUi } from './store.js'

interface GeneralSettingsProps {
  serverId: string
}

export function GeneralSettings({ serverId }: GeneralSettingsProps) {
  const queryClient = useQueryClient()
  const closeSettings = useSettingsUi((s) => s.close)
  const [, navigate] = useLocation()
  const userId = useAuthStore((s) => s.user?.id)

  const { data: detail } = useQuery({
    queryKey: ['server', serverId],
    queryFn:  () => getServerDetail(serverId),
    staleTime: 30_000,
  })
  const { data: members = [] } = useQuery({
    queryKey: ['members', serverId],
    queryFn:  () => listMembers(serverId),
    staleTime: 60_000,
  })

  const role = userId ? members.find((m) => m.id === userId)?.role : undefined
  const isOwner = role === 'owner'

  const [name, setName] = useState('')
  const [iconUrl, setIconUrl] = useState<string | null>(null)
  const [bannerUrl, setBannerUrl] = useState<string | null>(null)
  const [uploading, setUploading] = useState(false)
  const [uploadingBanner, setUploadingBanner] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const bannerFileRef = useRef<HTMLInputElement>(null)

  // Гидратируем форму из detail каждый раз, когда серверный кеш обновляется.
  useEffect(() => {
    if (detail?.server) {
      setName(detail.server.name)
      setIconUrl(detail.server.iconUrl ?? null)
      setBannerUrl(detail.server.bannerUrl ?? null)
    }
  }, [detail?.server.name, detail?.server.iconUrl, detail?.server.bannerUrl, detail?.server])

  const dirty =
    detail !== undefined
    && (name.trim() !== detail.server.name
      || (iconUrl ?? null) !== (detail.server.iconUrl ?? null)
      || (bannerUrl ?? null) !== (detail.server.bannerUrl ?? null))

  const saveMutation = useMutation({
    mutationFn: () =>
      patchServer(serverId, {
        ...(detail && name.trim() !== detail.server.name ? { name: name.trim() } : {}),
        ...(detail && (iconUrl ?? null) !== (detail.server.iconUrl ?? null) ? { iconUrl: iconUrl ?? null } : {}),
        ...(detail && (bannerUrl ?? null) !== (detail.server.bannerUrl ?? null) ? { bannerUrl: bannerUrl ?? null } : {}),
      }),
    onSuccess: (server) => {
      void queryClient.invalidateQueries({ queryKey: ['server', serverId] })
      void queryClient.invalidateQueries({ queryKey: ['servers'] })
      setError(null)
      // Локально подтягиваем имя из ответа — пока не пришёл свежий detail.
      setName(server.name)
      setIconUrl(server.iconUrl ?? null)
      setBannerUrl(server.bannerUrl ?? null)
    },
    onError: (err) => setError(err instanceof ApiError ? err.message : (err as Error).message),
  })

  const deleteMutation = useMutation({
    mutationFn: () => deleteServer(serverId),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['servers'] })
      closeSettings()
      navigate('/')
    },
    onError: (err) => setError(err instanceof ApiError ? err.message : (err as Error).message),
  })

  const leaveMutation = useMutation({
    mutationFn: () => leaveServer(serverId),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['servers'] })
      closeSettings()
      navigate('/')
    },
    onError: (err) => setError(err instanceof ApiError ? err.message : (err as Error).message),
  })

  const [transferTo, setTransferTo] = useState('')
  const transferMutation = useMutation({
    mutationFn: (targetId: string) => transferOwnership(serverId, targetId),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['members', serverId] })
      setTransferTo('')
      setError(null)
    },
    onError: (err) => setError(err instanceof ApiError ? err.message : (err as Error).message),
  })

  async function confirmTransfer() {
    if (!detail || !transferTo) return
    const target = members.find((m) => m.id === transferTo)
    const ok = await confirmDialog({
      title: `передать «${detail.server.name}» участнику ${target?.displayName ?? ''}?`,
      body: 'этот участник станет владельцем сервера, а вы — администратором. отменить сможет только новый владелец.',
      confirmLabel: 'передать',
      danger: true,
    })
    if (ok) transferMutation.mutate(transferTo)
  }

  async function pickIcon(file: File) {
    setError(null)
    if (!file.type.startsWith('image/') || !isSupportedType(file.type)) {
      setError('нужна картинка (jpg/png/gif/webp)')
      return
    }
    setUploading(true)
    try {
      const att = await uploadAttachment(file)
      setIconUrl(att.url)
    } catch (err) {
      setError(err instanceof UploadError ? err.message : (err as Error).message)
    } finally {
      setUploading(false)
    }
  }
  function onFile(e: ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0]
    if (f) void pickIcon(f)
    e.target.value = ''
  }

  async function pickBanner(file: File) {
    setError(null)
    if (!file.type.startsWith('image/') || !isSupportedType(file.type)) {
      setError('нужна картинка (jpg/png/gif/webp)')
      return
    }
    setUploadingBanner(true)
    try {
      const att = await uploadAttachment(file)
      setBannerUrl(att.url)
    } catch (err) {
      setError(err instanceof UploadError ? err.message : (err as Error).message)
    } finally {
      setUploadingBanner(false)
    }
  }
  function onBannerFile(e: ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0]
    if (f) void pickBanner(f)
    e.target.value = ''
  }

  async function confirmDelete() {
    if (!detail) return
    const ok = await confirmDialog({
      title: `удалить «${detail.server.name}»?`,
      body: 'сервер удалится вместе со всеми каналами и сообщениями. это необратимо.',
      confirmLabel: 'удалить навсегда',
      danger: true,
      requireText: detail.server.name,
    })
    if (!ok) return
    deleteMutation.mutate()
  }

  async function confirmLeave() {
    if (!detail) return
    const ok = await confirmDialog({
      title: `выйти из «${detail.server.name}»?`,
      confirmLabel: 'выйти',
      danger: true,
    })
    if (!ok) return
    leaveMutation.mutate()
  }

  if (!detail) {
    return <div className="py-8 text-center text-kd-text-mute font-mono text-[11px]">загружаем…</div>
  }

  return (
    <div className="flex flex-col gap-[18px]">
      <Field label="имя и иконка" hint="иконку видно в рельсе слева, имя — в шапке списка каналов">
        <div className="flex gap-4">
          <div
            onClick={() => isOwner && fileRef.current?.click()}
            className={[
              'w-20 h-20 rounded-kd flex items-center justify-center shrink-0 overflow-hidden bg-kd-panel',
              isOwner ? 'cursor-pointer border-2 border-dashed border-kd-border hover:border-kd-text-mute' : 'border border-kd-border',
            ].join(' ')}
            title={isOwner ? 'нажми, чтобы загрузить иконку' : undefined}
          >
            {iconUrl ? (
              <img src={iconUrl} alt="иконка" className="w-full h-full object-cover" />
            ) : (
              <span className="text-[10px] font-mono text-kd-text-mute text-center px-1 leading-tight">
                {uploading ? '…' : 'иконка'}
              </span>
            )}
          </div>
          <input ref={fileRef} type="file" accept="image/*" className="hidden" onChange={onFile} />
          <div className="flex-1 min-w-0 flex flex-col gap-1.5">
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value.slice(0, 64))}
              disabled={!isOwner && role !== 'admin'}
              aria-label="имя сервера"
              className="w-full px-3 py-2 rounded-kd bg-kd-bg border border-kd-border text-[13px] text-kd-text outline-none focus:border-kd-accent disabled:opacity-60"
            />
            <div className="text-[10px] font-mono text-kd-text-mute">{name.length}/64</div>
          </div>
        </div>
      </Field>

      <Field label="баннер" hint="картинка в шапке списка каналов, как в Discord; лучше всего ~600×240">
        <div className="flex flex-col gap-1.5">
          <div
            onClick={() => (isOwner || role === 'admin') && bannerFileRef.current?.click()}
            className={[
              'relative w-full aspect-[5/2] rounded-kd flex items-center justify-center overflow-hidden bg-kd-panel',
              isOwner || role === 'admin'
                ? 'cursor-pointer border-2 border-dashed border-kd-border hover:border-kd-text-mute'
                : 'border border-kd-border',
            ].join(' ')}
            title={isOwner || role === 'admin' ? 'нажми, чтобы загрузить баннер' : undefined}
          >
            {bannerUrl ? (
              <img src={bannerUrl} alt="баннер" className="absolute inset-0 w-full h-full object-cover" />
            ) : (
              <span className="text-[10px] font-mono text-kd-text-mute">
                {uploadingBanner ? '…' : 'без баннера'}
              </span>
            )}
          </div>
          <input ref={bannerFileRef} type="file" accept="image/*" className="hidden" onChange={onBannerFile} />
          {bannerUrl && (isOwner || role === 'admin') && (
            <button
              type="button"
              onClick={() => setBannerUrl(null)}
              className="self-start text-[10px] font-mono text-kd-text-mute hover:text-kd-danger transition-colors"
            >
              убрать баннер
            </button>
          )}
        </div>
      </Field>

      {error && <div className="text-[11px] text-kd-danger font-mono">{error}</div>}

      <div className="flex justify-end gap-2">
        <button
          type="button"
          disabled={!dirty || saveMutation.isPending}
          onClick={() => saveMutation.mutate()}
          className="px-3.5 py-1.5 rounded bg-kd-accent text-white text-[11px] font-bold font-mono hover:bg-kd-accent-deep disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {saveMutation.isPending ? '…' : 'сохранить'}
        </button>
      </div>

      <div className="h-px bg-kd-border" />

      {isOwner && members.length > 1 && (
        <Field
          label="передать сервер"
          hint="новый владелец получит полный контроль; вы станете администратором"
        >
          <div className="flex gap-2">
            <select
              value={transferTo}
              onChange={(e) => setTransferTo(e.target.value)}
              aria-label="новый владелец"
              className="flex-1 min-w-0 px-3 py-2 rounded-kd bg-kd-bg border border-kd-border text-[12px] text-kd-text outline-none focus:border-kd-accent"
            >
              <option value="">— выбери участника —</option>
              {members
                .filter((m) => m.role !== 'owner')
                .map((m) => (
                  <option key={m.id} value={m.id}>{m.displayName}</option>
                ))}
            </select>
            <button
              type="button"
              disabled={!transferTo || transferMutation.isPending}
              onClick={() => void confirmTransfer()}
              className="px-3.5 py-1.5 rounded bg-kd-panel border border-kd-warm text-kd-warm text-[11px] font-bold font-mono hover:bg-kd-warm hover:text-white disabled:opacity-50 shrink-0 transition-colors"
            >
              {transferMutation.isPending ? '…' : 'передать'}
            </button>
          </div>
        </Field>
      )}

      <Field
        label="опасная зона"
        hint={isOwner
          ? 'сервер удалится вместе со всеми каналами и сообщениями'
          : 'выход из сервера — без удаления данных'}
      >
        {isOwner ? (
          <button
            type="button"
            onClick={confirmDelete}
            disabled={deleteMutation.isPending}
            className="px-3.5 py-1.5 rounded bg-kd-danger text-white text-[11px] font-bold font-mono hover:opacity-90 disabled:opacity-60"
          >
            {deleteMutation.isPending ? '…' : 'удалить сервер'}
          </button>
        ) : (
          <button
            type="button"
            onClick={confirmLeave}
            disabled={leaveMutation.isPending}
            className="px-3.5 py-1.5 rounded bg-kd-panel border border-kd-danger text-kd-danger text-[11px] font-bold font-mono hover:bg-kd-danger hover:text-white disabled:opacity-60"
          >
            {leaveMutation.isPending ? '…' : 'покинуть сервер'}
          </button>
        )}
      </Field>
    </div>
  )
}
