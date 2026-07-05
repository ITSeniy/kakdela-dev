import type { EventDefinition, EventRsvp, GifEmbed, Message, MessagesPage, PinnedMessagesResponse, PollDefinition, StickerRef } from '@kakdela/ginzu/api-types'

import { apiFetch } from '../../lib/api.js'

export async function listMessages(
  channelId: string,
  opts?: { before?: string; limit?: number },
): Promise<MessagesPage> {
  const params = new URLSearchParams()
  if (opts?.before) params.set('before', opts.before)
  if (opts?.limit !== undefined) params.set('limit', String(opts.limit))
  const qs = params.toString()
  const path = `/api/channels/${channelId}/messages${qs ? '?' + qs : ''}`
  return apiFetch<MessagesPage>(path)
}

export interface SendMessageBody {
  content: string
  replyToId?: string
  clientNonce?: string
  attachments?: string[]
  spoilerAttachments?: string[]
  gif?: GifEmbed
  sticker?: StickerRef
  poll?: PollDefinition
  event?: EventDefinition
}

export async function sendMessage(channelId: string, body: SendMessageBody): Promise<Message> {
  return apiFetch<Message>(`/api/channels/${channelId}/messages`, {
    method: 'POST',
    body: JSON.stringify(body),
  })
}

export async function editMessage(id: string, content: string): Promise<Message> {
  return apiFetch<Message>(`/api/messages/${id}`, {
    method: 'PATCH',
    body: JSON.stringify({ content }),
  })
}

export async function deleteMessage(id: string): Promise<void> {
  await apiFetch<void>(`/api/messages/${id}`, { method: 'DELETE' })
}

export async function addReaction(messageId: string, emoji: string): Promise<void> {
  await apiFetch<{ ok: true }>(`/api/messages/${messageId}/reactions`, {
    method: 'POST',
    body: JSON.stringify({ emoji }),
  })
}

export async function removeReaction(messageId: string, emoji: string): Promise<void> {
  await apiFetch<void>(`/api/messages/${messageId}/reactions/${encodeURIComponent(emoji)}`, {
    method: 'DELETE',
  })
}

export async function votePoll(messageId: string, option: number): Promise<void> {
  await apiFetch<void>(`/api/messages/${messageId}/poll-vote`, {
    method: 'POST',
    body: JSON.stringify({ option }),
  })
}

export async function unvotePoll(messageId: string): Promise<void> {
  await apiFetch<void>(`/api/messages/${messageId}/poll-vote`, { method: 'DELETE' })
}

export async function rsvpEvent(messageId: string, rsvp: EventRsvp | null): Promise<void> {
  await apiFetch<void>(`/api/messages/${messageId}/event-rsvp`, {
    method: 'POST',
    body: JSON.stringify({ rsvp }),
  })
}

export async function pinMessage(id: string): Promise<Message> {
  return apiFetch<Message>(`/api/messages/${id}/pin`, { method: 'POST' })
}

export async function unpinMessage(id: string): Promise<Message> {
  return apiFetch<Message>(`/api/messages/${id}/pin`, { method: 'DELETE' })
}

export async function listPins(channelId: string): Promise<PinnedMessagesResponse> {
  return apiFetch<PinnedMessagesResponse>(`/api/channels/${channelId}/pins`)
}

export async function forwardMessage(
  id: string,
  body: { toChannelId: string; note?: string },
): Promise<Message> {
  return apiFetch<Message>(`/api/messages/${id}/forward`, {
    method: 'POST',
    body: JSON.stringify(body),
  })
}
