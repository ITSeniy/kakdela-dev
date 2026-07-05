import { z } from 'zod'

import { UserSchema, ServerSchema, MessageSchema, ServerMemberSchema, ChannelSchema, LinkPreviewSchema } from './api-types.js'
import type { User, Server, Message, ServerMember, Channel, LinkPreview } from './api-types.js'

export type ServerEvent =
  | { t: 'ready'; user: User; servers: Server[] }
  | { t: 'ping' }
  | { t: 'pong' }
  | { t: 'msg.new'; channelId: string; message: Message }
  | { t: 'msg.edit'; channelId: string; messageId: string; content: string; editedAt: string }
  | { t: 'msg.delete'; channelId: string; messageId: string }
  | { t: 'msg.pin'; channelId: string; messageId: string; pinned: boolean; pinnedAt: string | null }
  // OG-превью ссылок досняты сервером — клиент патчит linkPreviews у сообщения.
  | { t: 'msg.embeds'; channelId: string; messageId: string; linkPreviews: LinkPreview[] }
  | { t: 'presence'; userId: string; status: User['status'] }
  | { t: 'typing'; channelId: string; userId: string }
  | { t: 'voice.join'; channelId: string; userId: string }
  | { t: 'voice.leave'; channelId: string; userId: string }
  | { t: 'voice.state'; channelId: string; userId: string; muted: boolean; screen: boolean }
  | { t: 'member.join'; member: ServerMember }
  | { t: 'member.leave'; serverId: string; userId: string }
  | { t: 'reaction.add'; channelId: string; messageId: string; userId: string; emoji: string }
  | { t: 'reaction.remove'; channelId: string; messageId: string; userId: string; emoji: string }
  // Голос в опросе изменился. votes — свежие счётчики по вариантам (полный
  // пересчёт на сервере, клиент просто заменяет). voterId + option позволяют
  // самому голосовавшему обновить myVote на других устройствах; option null =
  // голос снят.
  | { t: 'poll.vote'; channelId: string; messageId: string; votes: number[]; voterId: string; option: number | null }
  // RSVP на встрече изменился. going/declined — полные свежие списки userId.
  | { t: 'event.rsvp'; channelId: string; messageId: string; going: string[]; declined: string[]; voterId: string; rsvp: 'going' | 'declined' | null }
  // Напоминание о встрече за ~15 минут — targeted тем, кто ответил «пойду».
  | { t: 'event.reminder'; channelId: string; messageId: string; title: string; startsAt: string; place: string | null }
  | { t: 'dm.new'; channelId: string; withUserId: string }
  // Собеседник продвинул курсор чтения в личке — клиент обновляет галочки ✓✓
  // у своих сообщений с id <= messageId. Шлётся только второму участнику DM.
  | { t: 'dm.read'; channelId: string; userId: string; messageId: string }
  // Звонок 1:1 в личке (T-087). Адресуются КОНКРЕТНОМУ userId (broadcastToUser),
  // не всему каналу — звонок приватный. invite несёт имя/аватар звонящего для
  // тоста; cancel — инициатор отменил/таймаут; decline — собеседник отклонил.
  | { t: 'dm.call-invite'; channelId: string; fromUserId: string; fromName: string; fromAvatarUrl: string | null }
  | { t: 'dm.call-cancel'; channelId: string; fromUserId: string }
  | { t: 'dm.call-decline'; channelId: string; fromUserId: string }
  | { t: 'mention'; messageId: string; channelId: string; mentionedUserId: string; mentionType: 'user' | 'everyone' | 'here' }
  | { t: 'user.update'; userId: string; displayName: string; avatarUrl: string | null; customStatus: string | null }
  // Серверный профиль участника (per-server ник/аватар) изменился —
  // клиент инвалидирует members этого сервера.
  | { t: 'member.profile'; serverId: string; userId: string; nickname: string | null; avatarUrl: string | null }
  | { t: 'thread.new'; parentChannelId: string; parentMessageId: string; threadChannelId: string; name: string }
  | { t: 'thread.archive'; parentChannelId: string; threadChannelId: string; archivedAt: string }
  | { t: 'channel.create'; serverId: string; channel: Channel }
  | { t: 'channel.update'; serverId: string; channel: Channel }
  | { t: 'channel.delete'; serverId: string; channelId: string }
  | { t: 'category.create'; serverId: string; name: string }
  | { t: 'category.delete'; serverId: string; name: string }
  // Роли: справочник ролей сервера или назначения участникам изменились.
  | { t: 'role.update'; serverId: string }
  | { t: 'member.roles'; serverId: string; userId: string }
  // Серверная модерация голоса: админ заглушил/разглушил участника.
  | { t: 'voice.mod'; channelId: string; userId: string; muted: boolean; deafened: boolean }
  // Админ перенёс участника в другой голосовой канал — клиент сам пере-джойнится.
  | { t: 'voice.moved'; userId: string; fromChannelId: string; toChannelId: string }
  | { t: 'voice.kicked'; channelId: string; userId: string }
  // «Позвать в войс»: участник сервера зовёт конкретного юзера в голосовой
  // канал. Targeted-событие (broadcastToUser), несёт имя/аватар зовущего и
  // имя канала — клиенту хватает для тоста без дозапросов.
  | {
      t: 'voice.ring'
      channelId: string
      channelName: string
      serverId: string
      fromUserId: string
      fromName: string
      fromAvatarUrl: string | null
    }
  // Секретные чаты (Фаза 6): «тебе пришёл шифр-конверт». БЕЗ контента — клиент
  // идёт за ним в GET /api/secret/inbox и расшифровывает локально.
  | { t: 'secret.envelope'; id: string; fromUserId: string }

export type ClientEvent =
  | { t: 'hello'; token: string }
  | { t: 'ping' }
  | { t: 'pong' }
  | { t: 'typing'; channelId: string }
  | { t: 'presence'; status: 'online' | 'idle' | 'dnd' }

const uuid = z.string().uuid()

export const ServerEventSchema = z.discriminatedUnion('t', [
  z.object({ t: z.literal('ready'), user: UserSchema, servers: z.array(ServerSchema) }),
  z.object({ t: z.literal('ping') }),
  z.object({ t: z.literal('pong') }),
  z.object({ t: z.literal('msg.new'), channelId: uuid, message: MessageSchema }),
  z.object({ t: z.literal('msg.edit'), channelId: uuid, messageId: uuid, content: z.string(), editedAt: z.string() }),
  z.object({ t: z.literal('msg.delete'), channelId: uuid, messageId: uuid }),
  z.object({ t: z.literal('msg.pin'), channelId: uuid, messageId: uuid, pinned: z.boolean(), pinnedAt: z.string().nullable() }),
  z.object({ t: z.literal('msg.embeds'), channelId: uuid, messageId: uuid, linkPreviews: z.array(LinkPreviewSchema) }),
  z.object({ t: z.literal('presence'), userId: uuid, status: UserSchema.shape.status }),
  z.object({ t: z.literal('typing'), channelId: uuid, userId: uuid }),
  z.object({ t: z.literal('voice.join'), channelId: uuid, userId: uuid }),
  z.object({ t: z.literal('voice.leave'), channelId: uuid, userId: uuid }),
  z.object({ t: z.literal('voice.state'), channelId: uuid, userId: uuid, muted: z.boolean(), screen: z.boolean() }),
  z.object({ t: z.literal('member.join'), member: ServerMemberSchema }),
  z.object({ t: z.literal('member.leave'), serverId: uuid, userId: uuid }),
  z.object({ t: z.literal('reaction.add'), channelId: uuid, messageId: uuid, userId: uuid, emoji: z.string() }),
  z.object({ t: z.literal('reaction.remove'), channelId: uuid, messageId: uuid, userId: uuid, emoji: z.string() }),
  z.object({
    t: z.literal('poll.vote'),
    channelId: uuid,
    messageId: uuid,
    votes: z.array(z.number().int().nonnegative()),
    voterId: uuid,
    option: z.number().int().nullable(),
  }),
  z.object({
    t: z.literal('event.rsvp'),
    channelId: uuid,
    messageId: uuid,
    going: z.array(uuid),
    declined: z.array(uuid),
    voterId: uuid,
    rsvp: z.enum(['going', 'declined']).nullable(),
  }),
  z.object({
    t: z.literal('event.reminder'),
    channelId: uuid,
    messageId: uuid,
    title: z.string(),
    startsAt: z.string(),
    place: z.string().nullable(),
  }),
  z.object({ t: z.literal('dm.new'), channelId: uuid, withUserId: uuid }),
  z.object({ t: z.literal('dm.read'), channelId: uuid, userId: uuid, messageId: uuid }),
  z.object({
    t: z.literal('dm.call-invite'),
    channelId: uuid,
    fromUserId: uuid,
    fromName: z.string(),
    fromAvatarUrl: z.string().nullable(),
  }),
  z.object({ t: z.literal('dm.call-cancel'), channelId: uuid, fromUserId: uuid }),
  z.object({ t: z.literal('dm.call-decline'), channelId: uuid, fromUserId: uuid }),
  z.object({
    t: z.literal('mention'),
    messageId: uuid,
    channelId: uuid,
    mentionedUserId: uuid,
    mentionType: z.enum(['user', 'everyone', 'here']),
  }),
  z.object({
    t: z.literal('user.update'),
    userId: uuid,
    displayName: z.string(),
    avatarUrl: z.string().nullable(),
    customStatus: z.string().nullable(),
  }),
  z.object({
    t: z.literal('member.profile'),
    serverId: uuid,
    userId: uuid,
    nickname: z.string().nullable(),
    avatarUrl: z.string().nullable(),
  }),
  z.object({
    t: z.literal('thread.new'),
    parentChannelId: uuid,
    parentMessageId: uuid,
    threadChannelId: uuid,
    name: z.string(),
  }),
  z.object({
    t: z.literal('thread.archive'),
    parentChannelId: uuid,
    threadChannelId: uuid,
    archivedAt: z.string(),
  }),
  z.object({ t: z.literal('channel.create'), serverId: uuid, channel: ChannelSchema }),
  z.object({ t: z.literal('channel.update'), serverId: uuid, channel: ChannelSchema }),
  z.object({ t: z.literal('channel.delete'), serverId: uuid, channelId: uuid }),
  z.object({ t: z.literal('category.create'), serverId: uuid, name: z.string() }),
  z.object({ t: z.literal('category.delete'), serverId: uuid, name: z.string() }),
  z.object({ t: z.literal('role.update'), serverId: uuid }),
  z.object({ t: z.literal('member.roles'), serverId: uuid, userId: uuid }),
  z.object({ t: z.literal('voice.mod'), channelId: uuid, userId: uuid, muted: z.boolean(), deafened: z.boolean() }),
  z.object({ t: z.literal('voice.moved'), userId: uuid, fromChannelId: uuid, toChannelId: uuid }),
  z.object({ t: z.literal('voice.kicked'), channelId: uuid, userId: uuid }),
  z.object({
    t: z.literal('voice.ring'),
    channelId: uuid,
    channelName: z.string(),
    serverId: uuid,
    fromUserId: uuid,
    fromName: z.string(),
    fromAvatarUrl: z.string().nullable(),
  }),
  z.object({ t: z.literal('secret.envelope'), id: uuid, fromUserId: uuid }),
])

export const ClientEventSchema = z.discriminatedUnion('t', [
  z.object({ t: z.literal('hello'), token: z.string().min(1).max(2048) }),
  z.object({ t: z.literal('ping') }),
  z.object({ t: z.literal('pong') }),
  z.object({ t: z.literal('typing'), channelId: uuid }),
  z.object({ t: z.literal('presence'), status: z.enum(['online', 'idle', 'dnd']) }),
])
