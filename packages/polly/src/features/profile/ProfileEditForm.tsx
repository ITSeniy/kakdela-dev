import { useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'

import type { User, UserProfile } from '@kakdela/ginzu/api-types'

import { ApiError } from '../../lib/api.js'
import { useAuthStore } from '../auth/store.js'
import { uploadAttachment } from '../files/upload.js'
import { Avatar } from '../../components/Avatar.js'
import { Field } from '../../components/form/Field.js'
import { AvatarCropper } from './AvatarCropper.js'
import { BannerPicker } from './BannerPicker.js'
import { BirthdaySelect } from './BirthdaySelect.js'
import { TimezoneSelect } from './TimezoneSelect.js'
import { patchMe } from './api.js'

interface ProfileEditFormProps {
  profile: UserProfile
  onSaved: (user: User) => void
  /** Без onCancel кнопка «отмена» не рендерится (страница настроек). */
  onCancel?: () => void
}

const INPUT_CLS =
  'w-full px-3 py-2 rounded-kd bg-kd-bg border border-kd-border text-[13px] text-kd-text outline-none focus:border-kd-accent'

export function ProfileEditForm({ profile, onSaved, onCancel }: ProfileEditFormProps) {
  const queryClient = useQueryClient()
  const updateSession = useAuthStore((s) => s.setSession)
  const accessToken = useAuthStore((s) => s.accessToken)

  const [displayName, setDisplayName] = useState(profile.displayName)
  const [customStatus, setCustomStatus] = useState(profile.customStatus ?? '')
  const [avatarUrl, setAvatarUrl] = useState<string | null>(profile.avatarUrl)
  const [about, setAbout] = useState(profile.about ?? '')
  const [timezone, setTimezone] = useState<string | null>(profile.timezone)
  const [birthday, setBirthday] = useState<string | null>(profile.birthday)
  const [bannerUrl, setBannerUrl] = useState<string | null>(profile.bannerUrl)
  const [cropperOpen, setCropperOpen] = useState(false)
  const [avatarBusy, setAvatarBusy] = useState(false)

  const [currentPassword, setCurrentPassword] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')

  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  const dirty =
    displayName !== profile.displayName
    || (customStatus || null) !== (profile.customStatus ?? null)
    || (about.trim() || null) !== (profile.about ?? null)
    || timezone !== profile.timezone
    || birthday !== profile.birthday
    || bannerUrl !== profile.bannerUrl
    || newPassword !== ''

  // Аватар сохраняется СРАЗУ (тестеры жали «сохранить» в кроппере и считали
  // дело сделанным, а страница ждала второго «сохранить» внизу). Поэтому он
  // не участвует ни в dirty, ни в общем save().
  async function saveAvatar(url: string | null) {
    const updated = await patchMe({ avatarUrl: url })
    setAvatarUrl(url)
    if (accessToken) updateSession(updated, accessToken)
    void queryClient.invalidateQueries({ queryKey: ['user-profile', updated.id] })
    void queryClient.invalidateQueries({ queryKey: ['members'] })
  }

  async function onAvatarCropConfirm(blob: Blob) {
    setAvatarBusy(true)
    setError(null)
    try {
      const isGif = blob.type === 'image/gif'
      const file = new File([blob], `avatar-${Date.now()}.${isGif ? 'gif' : 'jpg'}`, {
        type: isGif ? 'image/gif' : 'image/jpeg',
      })
      const attachment = await uploadAttachment(file)
      await saveAvatar(attachment.url)
      setCropperOpen(false)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'не удалось загрузить аватар')
    } finally {
      setAvatarBusy(false)
    }
  }

  async function onAvatarRemove() {
    setAvatarBusy(true)
    setError(null)
    try {
      await saveAvatar(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'не удалось убрать аватар')
    } finally {
      setAvatarBusy(false)
    }
  }

  async function save() {
    setError(null)
    if (newPassword) {
      if (newPassword.length < 6) {
        setError('новый пароль — минимум 6 символов')
        return
      }
      if (newPassword !== confirmPassword) {
        setError('пароль и подтверждение не совпадают')
        return
      }
      if (!currentPassword) {
        setError('введите текущий пароль для смены')
        return
      }
    }

    setSaving(true)
    try {
      const updates: Parameters<typeof patchMe>[0] = {}
      if (displayName !== profile.displayName) updates.displayName = displayName
      const nextStatus = customStatus.trim() === '' ? null : customStatus
      if (nextStatus !== (profile.customStatus ?? null)) updates.customStatus = nextStatus
      const nextAbout = about.trim() === '' ? null : about.trim()
      if (nextAbout !== (profile.about ?? null)) updates.about = nextAbout
      if (timezone !== profile.timezone) updates.timezone = timezone
      if (birthday !== profile.birthday) updates.birthday = birthday
      if (bannerUrl !== profile.bannerUrl) updates.bannerUrl = bannerUrl
      if (newPassword) {
        updates.currentPassword = currentPassword
        updates.newPassword = newPassword
      }

      const updated = await patchMe(updates)

      // Auth store ожидает (user, accessToken). Текущий access всё ещё валиден —
      // PATCH /me не ротирует access-токен. Refresh уйдёт на следующем тике.
      if (accessToken) updateSession(updated, accessToken)
      void queryClient.invalidateQueries({ queryKey: ['user-profile', updated.id] })
      void queryClient.invalidateQueries({ queryKey: ['members'] })

      onSaved(updated)
    } catch (err) {
      const msg = err instanceof ApiError ? err.message : (err as Error).message
      setError(msg || 'ошибка сохранения')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="flex flex-col gap-[18px]">
      <Field label="аватар" hint="jpeg / png / webp / gif до 10 МБ · gif оживает в войсе · сохраняется сразу">
        {cropperOpen ? (
          <AvatarCropper
            initialUrl={avatarUrl}
            onConfirm={onAvatarCropConfirm}
            onCancel={() => setCropperOpen(false)}
            allowGif
          />
        ) : (
          <div className="flex items-center gap-4">
            <Avatar name={displayName} avatarUrl={avatarUrl} size={72} animate />
            <div className="space-y-1.5">
              <button
                type="button"
                onClick={() => setCropperOpen(true)}
                disabled={avatarBusy}
                className="px-3 py-1.5 rounded border border-kd-border text-[11px] font-mono text-kd-text hover:bg-kd-panel-hi disabled:opacity-50"
              >
                {avatarBusy ? 'сохраняем…' : 'изменить'}
              </button>
              {avatarUrl && (
                <button
                  type="button"
                  onClick={() => void onAvatarRemove()}
                  disabled={avatarBusy}
                  className="block px-3 py-1.5 rounded border border-kd-border text-[11px] font-mono text-kd-danger hover:bg-kd-panel-hi disabled:opacity-50"
                >
                  убрать
                </button>
              )}
            </div>
          </div>
        )}
      </Field>

      <Field label="баннер" hint="фото сверху карточки профиля; без него — тёплый градиент">
        <BannerPicker value={bannerUrl} onChange={setBannerUrl} avatarUrl={avatarUrl} displayName={displayName} />
      </Field>

      <Field label="отображаемое имя">
        <input
          type="text"
          value={displayName}
          onChange={(e) => setDisplayName(e.target.value)}
          maxLength={64}
          autoComplete="off"
          className={INPUT_CLS}
        />
      </Field>
      <Field label={`статус · ${customStatus.length}/128`}>
        <input
          type="text"
          value={customStatus}
          onChange={(e) => setCustomStatus(e.target.value.slice(0, 128))}
          maxLength={128}
          placeholder="пьёт какао ☕"
          autoComplete="off"
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

      <Field label="день рождения" hint="в этот день в чат прилетит поздравление 🎂 (год не указывается)">
        <BirthdaySelect value={birthday} onChange={setBirthday} />
      </Field>

      <Field label="смена пароля" hint="требуется текущий пароль; смена сбрасывает все сессии">
        <div className="flex flex-col gap-2.5">
          {/* Decoy-«логин» для менеджера паролей: без него Chrome в web-режиме
              назначал «логином» ближайший текстовый input выше (поле статуса)
              и заливал туда сохранённый email. autoComplete="off" на текстовых
              полях Chrome для логин-пар игнорирует — нужен явный якорь. */}
          <input
            type="text"
            autoComplete="username"
            defaultValue=""
            tabIndex={-1}
            aria-hidden="true"
            className="absolute w-px h-px opacity-0 pointer-events-none -z-10"
          />
          <input
            type="password"
            autoComplete="current-password"
            placeholder="текущий пароль"
            value={currentPassword}
            onChange={(e) => setCurrentPassword(e.target.value)}
            className={INPUT_CLS}
          />
          <input
            type="password"
            autoComplete="new-password"
            placeholder="новый пароль (мин. 6)"
            value={newPassword}
            onChange={(e) => setNewPassword(e.target.value)}
            className={INPUT_CLS}
          />
          <input
            type="password"
            autoComplete="new-password"
            placeholder="повторите пароль"
            value={confirmPassword}
            onChange={(e) => setConfirmPassword(e.target.value)}
            className={INPUT_CLS}
          />
        </div>
      </Field>

      {error && (
        <div className="px-3 py-2 rounded-kd bg-kd-danger/10 text-kd-danger text-[12px] font-mono">
          {error}
        </div>
      )}

      <div className="flex items-center justify-end gap-2 pt-2 border-t border-kd-border">
        {onCancel && (
          <button
            type="button"
            onClick={onCancel}
            className="px-4 py-1.5 rounded border border-kd-border text-[12px] font-mono text-kd-text-soft hover:text-kd-text"
          >
            отмена
          </button>
        )}
        <button
          type="button"
          onClick={() => void save()}
          disabled={saving || !dirty}
          className="px-4 py-1.5 rounded bg-kd-accent text-white text-[12px] font-mono font-bold hover:bg-kd-accent-deep disabled:opacity-50"
        >
          {saving ? 'сохраняем…' : 'сохранить'}
        </button>
      </div>
    </div>
  )
}
