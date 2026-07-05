// Второй шаг регистрации — кастомизация профиля: имя, аватар, «о себе»,
// баннер и часовой пояс. Показывается сразу после создания аккаунта
// (Router смотрит на PROFILE_SETUP_FLAG в localStorage); всё опционально,
// «пропустить» уводит в приложение без сохранения.

import { useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'

import type { PatchMeRequest } from '@kakdela/ginzu/api-types'

import { Avatar } from '../../components/Avatar.js'
import { Field } from '../../components/form/Field.js'
import { ApiError } from '../../lib/api.js'
import { uploadAttachment } from '../files/upload.js'
import { AvatarCropper } from '../profile/AvatarCropper.js'
import { BannerPicker } from '../profile/BannerPicker.js'
import { TimezoneSelect, detectTimezone } from '../profile/TimezoneSelect.js'
import { patchMe } from '../profile/api.js'
import { useAuthStore } from './store.js'

export const PROFILE_SETUP_FLAG = 'kd:profile-setup-pending'

const INPUT_CLS =
  'w-full px-3 py-2 rounded-kd bg-kd-bg border border-kd-border text-[13px] text-kd-text outline-none focus:border-kd-accent'

export function ProfileSetupScreen({ onDone }: { onDone(): void }) {
  const user = useAuthStore((s) => s.user)
  const accessToken = useAuthStore((s) => s.accessToken)
  const setSession = useAuthStore((s) => s.setSession)
  const queryClient = useQueryClient()

  const [displayName, setDisplayName] = useState(user?.displayName ?? '')
  const [avatarUrl, setAvatarUrl] = useState<string | null>(user?.avatarUrl ?? null)
  const [about, setAbout] = useState('')
  const [bannerUrl, setBannerUrl] = useState<string | null>(null)
  const [timezone, setTimezone] = useState<string | null>(detectTimezone())

  const [cropperOpen, setCropperOpen] = useState(false)
  const [avatarBusy, setAvatarBusy] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function onAvatarCropConfirm(blob: Blob) {
    setAvatarBusy(true)
    setError(null)
    try {
      const isGif = blob.type === 'image/gif'
      const file = new File([blob], `avatar-${Date.now()}.${isGif ? 'gif' : 'jpg'}`, {
        type: isGif ? 'image/gif' : 'image/jpeg',
      })
      const attachment = await uploadAttachment(file)
      setAvatarUrl(attachment.url)
      setCropperOpen(false)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'не удалось загрузить аватар')
    } finally {
      setAvatarBusy(false)
    }
  }

  async function save() {
    if (!user) return
    setSaving(true)
    setError(null)
    try {
      const updates: PatchMeRequest = {}
      const name = displayName.trim()
      if (name && name !== user.displayName) updates.displayName = name
      if (avatarUrl !== (user.avatarUrl ?? null)) updates.avatarUrl = avatarUrl
      const trimmedAbout = about.trim()
      if (trimmedAbout) updates.about = trimmedAbout
      if (bannerUrl) updates.bannerUrl = bannerUrl
      if (timezone) updates.timezone = timezone

      if (Object.keys(updates).length > 0) {
        const updated = await patchMe(updates)
        if (accessToken) setSession(updated, accessToken)
        void queryClient.invalidateQueries({ queryKey: ['user-profile', updated.id] })
        void queryClient.invalidateQueries({ queryKey: ['members'] })
      }
      onDone()
    } catch (err) {
      const msg = err instanceof ApiError ? err.message : (err as Error).message
      setError(msg || 'не получилось сохранить — попробуй ещё раз')
    } finally {
      setSaving(false)
    }
  }

  if (!user) return null

  return (
    <div className="h-full overflow-y-auto bg-kd-bg text-kd-text font-sans">
      <div className="max-w-[480px] mx-auto px-6 py-12">
        <div className="px-2 py-0.5 bg-kd-panel border border-kd-border rounded text-[10px] text-kd-text-soft font-mono inline-block mb-5">
          03 · профиль
        </div>
        <h2 className="text-[22px] font-bold tracking-[-0.02em] mb-1">оформим профиль?</h2>
        <p className="text-xs text-kd-text-soft mb-6 leading-relaxed">
          так друзья сразу узнают тебя. всё можно потом изменить в настройках.
        </p>

        {error && (
          <div className="mb-4 px-3 py-2.5 bg-kd-panel border border-kd-danger rounded-kd">
            <p className="text-xs text-kd-danger font-mono">{error}</p>
          </div>
        )}

        <div className="flex flex-col gap-[18px]">
          {/* Превью как у карточки профиля: баннер + аватар внахлёст */}
          <Field label="баннер" hint="фото сверху карточки профиля; без него — тёплый градиент">
            <BannerPicker
              value={bannerUrl}
              onChange={setBannerUrl}
              avatarUrl={avatarUrl}
              displayName={displayName || user.username}
            />
          </Field>

          <Field label="аватар" hint="jpeg / png / webp / gif до 10 МБ · gif оживает в войсе, когда говоришь">
            {cropperOpen ? (
              <AvatarCropper
                initialUrl={avatarUrl}
                onConfirm={onAvatarCropConfirm}
                onCancel={() => setCropperOpen(false)}
                allowGif
              />
            ) : (
              <div className="flex items-center gap-4">
                <Avatar name={displayName || user.username} avatarUrl={avatarUrl} size={72} animate />
                <div className="space-y-1.5">
                  <button
                    type="button"
                    onClick={() => setCropperOpen(true)}
                    disabled={avatarBusy}
                    className="px-3 py-1.5 rounded border border-kd-border text-[11px] font-mono text-kd-text hover:bg-kd-panel-hi disabled:opacity-50"
                  >
                    {avatarBusy ? 'грузим…' : avatarUrl ? 'изменить' : 'загрузить'}
                  </button>
                  {avatarUrl && (
                    <button
                      type="button"
                      onClick={() => setAvatarUrl(null)}
                      className="block px-3 py-1.5 rounded border border-kd-border text-[11px] font-mono text-kd-danger hover:bg-kd-panel-hi"
                    >
                      убрать
                    </button>
                  )}
                </div>
              </div>
            )}
          </Field>

          <Field label="как тебя звать" hint="видно всем вместо @ника">
            <input
              type="text"
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              maxLength={64}
              placeholder="Аня Котова"
              className={INPUT_CLS}
            />
          </Field>

          <Field label={`о себе · ${about.length}/512`} hint="чем живёшь, что любишь">
            <textarea
              value={about}
              onChange={(e) => setAbout(e.target.value.slice(0, 512))}
              rows={3}
              placeholder="пью какао, играю в инди и собираю кактусы 🌵"
              className={`${INPUT_CLS} resize-none font-sans`}
            />
          </Field>

          <Field label="часовой пояс" hint="друзья увидят, который у тебя час">
            <TimezoneSelect value={timezone} onChange={setTimezone} />
          </Field>
        </div>

        <button
          type="button"
          onClick={() => void save()}
          disabled={saving}
          className="mt-7 w-full flex items-center justify-center gap-2 px-4 py-[11px] rounded-kd bg-kd-accent text-white text-[13px] font-bold transition-colors hover:bg-kd-accent-deep disabled:opacity-60"
        >
          {saving ? 'сохраняем…' : 'готово, погнали ⏵'}
        </button>
        <button
          type="button"
          onClick={onDone}
          className="mt-3 w-full text-center text-[11px] font-mono text-kd-text-mute hover:text-kd-text-soft transition-colors"
        >
          пропустить — настрою потом
        </button>
      </div>
    </div>
  )
}
