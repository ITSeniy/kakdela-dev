import type {
  VoiceJoinResponse,
  VoiceModerateRequest,
  VoiceParticipantsResponse,
  VoicePreviewResponse,
} from '@kakdela/ginzu/api-types'

import { apiFetch } from '../../lib/api.js'

export async function joinVoiceChannel(channelId: string): Promise<VoiceJoinResponse> {
  return apiFetch<VoiceJoinResponse>(`/api/voice/${channelId}/join`, { method: 'POST' })
}

export async function leaveVoiceChannel(channelId: string): Promise<void> {
  await apiFetch<void>(`/api/voice/${channelId}/leave`, { method: 'POST' })
}

// ───── DM-звонки (T-087) ─────

/** Подключиться к DM-звонку. Первый зашедший = инициатор, сервер зовёт второго. */
export async function joinDmVoice(channelId: string): Promise<VoiceJoinResponse> {
  return apiFetch<VoiceJoinResponse>(`/api/voice/dm/${channelId}/join`, { method: 'POST' })
}

/** Выйти из DM-звонка (и отменить инвайт, если ещё не приняли). */
export async function leaveDmVoice(channelId: string): Promise<void> {
  await apiFetch<void>(`/api/voice/dm/${channelId}/leave`, { method: 'POST' })
}

/** Отклонить входящий DM-звонок. */
export async function declineDmCall(channelId: string): Promise<void> {
  await apiFetch<void>(`/api/voice/dm/${channelId}/decline`, { method: 'POST' })
}

export async function listVoiceParticipants(
  channelId: string,
): Promise<VoiceParticipantsResponse> {
  return apiFetch<VoiceParticipantsResponse>(`/api/voice/${channelId}/participants`)
}

/** Само-репорт mute-тумблера — LiveKit не шлёт вебхуков на mute трека,
    без репорта зрители вне канала не видят переключение до рефетча. */
export async function reportVoiceState(channelId: string, muted: boolean): Promise<void> {
  await apiFetch<void>(`/api/voice/${channelId}/state`, {
    method: 'POST',
    body: JSON.stringify({ muted }),
  })
}

/** Залить кадр своей демки для hover-превью (base64 без data:-префикса). */
export async function uploadScreenPreview(channelId: string, dataBase64: string): Promise<void> {
  await apiFetch<void>(`/api/voice/${channelId}/screen-preview`, {
    method: 'POST',
    body: JSON.stringify({ dataBase64 }),
  })
}

/** Последний кадр демки участника (data-URL) или null, если превью нет. */
export async function fetchScreenPreview(channelId: string, userId: string): Promise<string | null> {
  const res = await apiFetch<VoicePreviewResponse>(
    `/api/voice/${channelId}/screen-preview/${userId}`,
  )
  return res.dataUrl
}

/** Админская модерация участника ГС: mute/deafen/kick/move. */
export async function moderateVoice(
  channelId: string,
  body: VoiceModerateRequest,
): Promise<void> {
  await apiFetch<void>(`/api/voice/${channelId}/moderate`, {
    method: 'POST',
    body: JSON.stringify(body),
  })
}
