// Серверный профиль (как в Discord): свой ник и аватар для КОНКРЕТНОГО
// сервера поверх глобального профиля. Открывается из меню действий сервера.

import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'

import { Avatar } from '../../components/Avatar.js'
import { Modal, ModalHeader } from '../../components/Modal.js'
import { ApiError } from '../../lib/api.js'
import { useAuthStore } from '../auth/store.js'
import { uploadAttachment } from '../files/upload.js'
import { AvatarCropper } from '../profile/AvatarCropper.js'
import { listMembers, patchMyMemberProfile } from './api.js'

interface ServerProfileModalProps {
  serverId: string
  serverName: string
  onClose(): void
}

export function ServerProfileModal({ serverId, serverName, onClose }: ServerProfileModalProps) {
  const queryClient = useQueryClient()
  const user = useAuthStore((s) => s.user)

  const { data: members = [] } = useQuery({
    queryKey: ['members', serverId],
    queryFn: () => listMembers(serverId),
    staleTime: 60_000,
  })
  const me = members.find((m) => m.id === user?.id)

  // undefined = ещё не трогали (берём текущее с сервера), дальше — локальный драфт.
  const [nicknameDraft, setNicknameDraft] = useState<string | null>(null)
  const [avatarDraft, setAvatarDraft] = useState<string | null | undefined>(undefined)
  const [cropperOpen, setCropperOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const globalName = user?.displayName ?? ''
  const globalAvatar = user?.avatarUrl ?? null

  const currentNickname = me?.nickname ?? null
  const currentAvatar = me?.serverAvatarUrl ?? null

  const nickname = nicknameDraft ?? currentNickname ?? ''
  const serverAvatar = avatarDraft === undefined ? currentAvatar : avatarDraft

  // Что реально уедет на сервер (пустой ник = сброс к глобальному имени).
  const nextNickname = nickname.trim() === '' || nickname.trim() === globalName
    ? null
    : nickname.trim().slice(0, 64)
  const dirty = nextNickname !== currentNickname || serverAvatar !== currentAvatar

  const previewName = nextNickname ?? globalName
  const previewAvatar = serverAvatar ?? globalAvatar

  async function onAvatarCropConfirm(blob: Blob) {
    setBusy(true)
    setError(null)
    try {
      const isGif = blob.type === 'image/gif'
      const file = new File([blob], `server-avatar-${Date.now()}.${isGif ? 'gif' : 'jpg'}`, {
        type: isGif ? 'image/gif' : 'image/jpeg',
      })
      const attachment = await uploadAttachment(file)
      setAvatarDraft(attachment.url)
      setCropperOpen(false)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'не удалось загрузить аватар')
    } finally {
      setBusy(false)
    }
  }

  async function save() {
    setSaving(true)
    setError(null)
    try {
      await patchMyMemberProfile(serverId, {
        ...(nextNickname !== currentNickname ? { nickname: nextNickname } : {}),
        ...(serverAvatar !== currentAvatar ? { avatarUrl: serverAvatar } : {}),
      })
      void queryClient.invalidateQueries({ queryKey: ['members', serverId] })
      onClose()
    } catch (err) {
      const msg = err instanceof ApiError ? err.message : (err as Error).message
      setError(msg || 'ошибка сохранения')
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal onClose={onClose} width={440}>
      <ModalHeader title={`профиль на сервере · ${serverName}`} onClose={onClose} />
      <div className="p-5 space-y-4 overflow-y-auto">
        <p className="text-[11px] text-kd-text-soft leading-relaxed">
          ник и аватар только для этого сервера — в других местах остаётся
          глобальный профиль. пустое поле = как в профиле.
        </p>

        {cropperOpen ? (
          <AvatarCropper
            initialUrl={previewAvatar}
            onConfirm={onAvatarCropConfirm}
            onCancel={() => setCropperOpen(false)}
            allowGif
          />
        ) : (
          <div className="flex items-center gap-4">
            <Avatar name={previewName || '?'} avatarUrl={previewAvatar} size={72} animate />
            <div className="space-y-1.5">
              <button
                type="button"
                onClick={() => setCropperOpen(true)}
                disabled={busy}
                className="px-3 py-1.5 rounded border border-kd-border text-[11px] font-mono text-kd-text hover:bg-kd-panel-hi disabled:opacity-50"
              >
                {busy ? 'грузим…' : serverAvatar ? 'изменить' : 'свой аватар для сервера'}
              </button>
              {serverAvatar && (
                <button
                  type="button"
                  onClick={() => setAvatarDraft(null)}
                  className="block px-3 py-1.5 rounded border border-kd-border text-[11px] font-mono text-kd-danger hover:bg-kd-panel-hi"
                >
                  как в профиле
                </button>
              )}
            </div>
          </div>
        )}

        <div>
          <div className="text-[10px] font-mono text-kd-text-mute mb-1.5 uppercase tracking-wide">
            ник на сервере
          </div>
          <input
            type="text"
            value={nickname}
            onChange={(e) => setNicknameDraft(e.target.value)}
            maxLength={64}
            placeholder={globalName}
            className="w-full px-3 py-2 rounded-kd bg-kd-bg border border-kd-border text-[13px] text-kd-text outline-none focus:border-kd-accent"
          />
          {currentNickname && (
            <div className="mt-1 text-[10px] text-kd-text-mute font-mono">
              он же {globalName}
            </div>
          )}
        </div>

        {error && (
          <div className="px-3 py-2 rounded-kd bg-kd-danger/10 text-kd-danger text-[12px] font-mono">
            {error}
          </div>
        )}

        <div className="flex items-center justify-end gap-2 pt-2 border-t border-kd-border">
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-1.5 rounded border border-kd-border text-[12px] font-mono text-kd-text-soft hover:text-kd-text"
          >
            отмена
          </button>
          <button
            type="button"
            onClick={() => void save()}
            disabled={saving || busy || !dirty}
            className="px-4 py-1.5 rounded bg-kd-accent text-white text-[12px] font-mono font-bold hover:bg-kd-accent-deep disabled:opacity-50"
          >
            {saving ? 'сохраняем…' : 'сохранить'}
          </button>
        </div>
      </div>
    </Modal>
  )
}
