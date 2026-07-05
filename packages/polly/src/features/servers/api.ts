import type {
  Channel,
  ChannelCategory,
  CreateChannelRequest,
  CreateInviteResponse,
  CreateServerRequest,
  InvitePublic,
  InviteSummary,
  InvitesListResponse,
  MemberProfileResponse,
  MemberPublic,
  ServerUnreadResponse,
  PatchChannelRequest,
  PatchMemberProfileRequest,
  PatchServerRequest,
  Server,
} from '@kakdela/ginzu/api-types'

import { apiFetch } from '../../lib/api.js'

export async function listServers(): Promise<Server[]> {
  const data = await apiFetch<{ servers: Server[] }>('/api/servers')
  return data.servers
}

export interface ServerDetail {
  server: Server
  channels: Channel[]
  categories: ChannelCategory[]
  memberCount: number
}

export async function getServerDetail(serverId: string): Promise<ServerDetail> {
  return apiFetch<ServerDetail>(`/api/servers/${serverId}`)
}

export async function listMembers(serverId: string): Promise<MemberPublic[]> {
  const data = await apiFetch<{ members: MemberPublic[] }>(`/api/servers/${serverId}/members`)
  return data.members
}

// ───── T-083 ─────

export async function createServer(body: CreateServerRequest): Promise<Server> {
  return apiFetch<Server>('/api/servers', {
    method: 'POST',
    body: JSON.stringify(body),
  })
}

export async function patchServer(serverId: string, body: PatchServerRequest): Promise<Server> {
  return apiFetch<Server>(`/api/servers/${serverId}`, {
    method: 'PATCH',
    body: JSON.stringify(body),
  })
}

export async function deleteServer(serverId: string): Promise<void> {
  await apiFetch<void>(`/api/servers/${serverId}`, { method: 'DELETE' })
}

export async function createChannel(serverId: string, body: CreateChannelRequest): Promise<Channel> {
  return apiFetch<Channel>(`/api/servers/${serverId}/channels`, {
    method: 'POST',
    body: JSON.stringify(body),
  })
}

export async function createCategory(serverId: string, name: string): Promise<ChannelCategory> {
  return apiFetch<ChannelCategory>(`/api/servers/${serverId}/categories`, {
    method: 'POST',
    body: JSON.stringify({ name }),
  })
}

export async function deleteCategory(serverId: string, name: string): Promise<void> {
  await apiFetch<void>(
    `/api/servers/${serverId}/categories/${encodeURIComponent(name)}`,
    { method: 'DELETE' },
  )
}

export async function patchChannel(channelId: string, body: PatchChannelRequest): Promise<Channel> {
  return apiFetch<Channel>(`/api/channels/${channelId}`, {
    method: 'PATCH',
    body: JSON.stringify(body),
  })
}

export async function deleteChannel(channelId: string): Promise<void> {
  await apiFetch<void>(`/api/channels/${channelId}`, { method: 'DELETE' })
}

export async function getChannelStats(channelId: string): Promise<{ messageCount: number }> {
  return apiFetch<{ messageCount: number }>(`/api/channels/${channelId}/stats`)
}

/** Серверный профиль: свой per-server ник/аватар. null = сброс к глобальному. */
export async function patchMyMemberProfile(
  serverId: string,
  body: PatchMemberProfileRequest,
): Promise<MemberProfileResponse> {
  return apiFetch<MemberProfileResponse>(`/api/servers/${serverId}/members/me`, {
    method: 'PATCH',
    body: JSON.stringify(body),
  })
}

export async function leaveServer(serverId: string): Promise<void> {
  await apiFetch<void>(`/api/servers/${serverId}/members/me`, { method: 'DELETE' })
}

/** Передать владение сервером другому участнику (текущий owner → admin). */
export async function transferOwnership(serverId: string, userId: string): Promise<void> {
  await apiFetch<void>(`/api/servers/${serverId}/transfer`, {
    method: 'POST',
    body: JSON.stringify({ userId }),
  })
}

/** Выгнать участника с сервера (нужно право KICK_MEMBERS + старшинство). */
export async function kickMember(serverId: string, userId: string): Promise<void> {
  await apiFetch<void>(`/api/servers/${serverId}/members/${userId}`, { method: 'DELETE' })
}

/** Пометить канал прочитанным (lastReadAt = now). */
export async function markChannelRead(channelId: string): Promise<void> {
  await apiFetch<void>(`/api/channels/${channelId}/read`, { method: 'POST' })
}

/** id каналов сервера с непрочитанными сообщениями. */
export async function getServerUnread(serverId: string): Promise<string[]> {
  const res = await apiFetch<ServerUnreadResponse>(`/api/servers/${serverId}/unread`)
  return res.channelIds
}

/** Пометить весь сервер прочитанным. */
export async function markServerRead(serverId: string): Promise<void> {
  await apiFetch<void>(`/api/servers/${serverId}/read`, { method: 'POST' })
}

export async function listInvites(serverId: string): Promise<InviteSummary[]> {
  const data = await apiFetch<InvitesListResponse>(`/api/servers/${serverId}/invites`)
  return data.invites
}

export async function createInvite(
  serverId: string,
  body: { expiresInDays?: number; maxUses?: number },
): Promise<CreateInviteResponse> {
  return apiFetch<CreateInviteResponse>(`/api/servers/${serverId}/invites`, {
    method: 'POST',
    body: JSON.stringify(body),
  })
}

export async function revokeInvite(code: string): Promise<void> {
  await apiFetch<void>(`/api/invites/${encodeURIComponent(code)}`, { method: 'DELETE' })
}

export async function acceptInvite(code: string): Promise<{ serverId: string }> {
  return apiFetch<{ serverId: string }>(`/api/invites/${encodeURIComponent(code)}/accept`, {
    method: 'POST',
  })
}

export async function getInvitePublic(code: string): Promise<InvitePublic> {
  return apiFetch<InvitePublic>(`/api/invites/${encodeURIComponent(code)}`)
}
