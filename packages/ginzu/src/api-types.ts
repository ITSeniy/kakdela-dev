import { z } from 'zod'

export const UserSchema = z.object({
  id: z.string().uuid(),
  username: z.string().min(2).max(32),
  displayName: z.string().max(64),
  avatarUrl: z.string().url().nullable(),
  status: z.enum(['online', 'idle', 'dnd', 'offline']),
  customStatus: z.string().max(128).nullable().optional(),
})
export type User = z.infer<typeof UserSchema>

export const ServerSchema = z.object({
  id: z.string().uuid(),
  name: z.string().min(1).max(64),
  iconUrl: z.string().url().nullable().optional(),
  /** Баннер в шапке списка каналов (как в Discord). */
  bannerUrl: z.string().url().nullable().optional(),
})
export type Server = z.infer<typeof ServerSchema>

export const ChannelSchema = z.object({
  id: z.string().uuid(),
  serverId: z.string().uuid().nullable(),
  name: z.string().min(1).max(100),
  kind: z.enum(['text', 'voice', 'dm']),
  category: z.string().max(64).nullable().optional(),
  topic: z.string().max(256).nullable().optional(),
  position: z.number().int().nonnegative(),
  parentChannelId: z.string().uuid().nullable().optional(),
  parentMessageId: z.string().uuid().nullable().optional(),
  archivedAt: z.string().nullable().optional(),
  // Настройки канала («обзор»). Дефолты совпадают с колонками БД.
  slowModeSec:    z.number().int().nonnegative().default(0),
  autoDeleteSec:  z.number().int().positive().nullable().optional(),
  isDefault:      z.boolean().default(false),
  friendsOnly:    z.boolean().default(false),
  nsfw:           z.boolean().default(false),
  threadsAllowed: z.boolean().default(true),
})
export type Channel = z.infer<typeof ChannelSchema>

export const ReplyRefSchema = z.union([
  z.object({ id: z.string().uuid(), deleted: z.literal(true) }),
  z.object({ id: z.string().uuid(), deleted: z.literal(false), authorName: z.string(), content: z.string() }),
])
export type ReplyRef = z.infer<typeof ReplyRefSchema>

export const ReactionAggregateSchema = z.object({
  emoji: z.string(),
  count: z.number().int().nonnegative(),
  users: z.array(z.string().uuid()),
})
export type ReactionAggregate = z.infer<typeof ReactionAggregateSchema>

export const AttachmentKindSchema = z.enum(['image', 'video', 'audio', 'pdf', 'text', 'archive', 'other'])
export type AttachmentKind = z.infer<typeof AttachmentKindSchema>

export const AttachmentSchema = z.object({
  id: z.string().uuid(),
  url: z.string().url(),
  /** Серверная миниатюра (webp ≤480px) для превью в чате; null у gif,
      мелких картинок и не-изображений. Оригинал — всегда в url. */
  thumbUrl: z.string().url().nullable().optional(),
  kind: AttachmentKindSchema,
  contentType: z.string(),
  originalName: z.string(),
  sizeBytes: z.number().int().nonnegative(),
  width: z.number().int().positive().nullable().optional(),
  height: z.number().int().positive().nullable().optional(),
  /** Вложение помечено спойлером — клиент блюрит его до клика. */
  spoiler: z.boolean().default(false),
  /** Голосовое сообщение (T-104): audio-вложение, записанное с микрофона.
      Клиент рендерит компактный плеер вместо карточки аудиофайла. */
  voice: z.boolean().default(false),
  /** Кружок (T-105): video-вложение с фронталки, как в Telegram.
      Клиент рендерит круглый inline-плеер вместо видео-тайла. */
  circle: z.boolean().default(false),
  /** Длительность в секундах, замеренная при записи. Нужна отдельно от
      метаданных файла: webm из MediaRecorder не содержит duration
      (в <audio>/<video> это Infinity до полной перемотки). */
  durationSec: z.number().int().positive().nullable().optional(),
})
export type Attachment = z.infer<typeof AttachmentSchema>

export const ThreadInfoSchema = z.object({
  channelId:     z.string().uuid(),
  name:          z.string(),
  messageCount:  z.number().int().nonnegative(),
  lastMessageAt: z.string().nullable(),
  archivedAt:    z.string().nullable(),
})
export type ThreadInfo = z.infer<typeof ThreadInfoSchema>

// Снимок пересланного сообщения: денормализуем автора/текст/вложения на момент
// пересыла, чтобы карточка рендерилась даже если получатель не имеет доступа к
// исходному каналу или оригинал потом изменили/удалили. messageId/channelId —
// для перехода к оригиналу, когда он доступен.
export const ForwardedRefSchema = z.object({
  messageId:    z.string().uuid().nullable(),
  channelId:    z.string().uuid().nullable(),
  channelLabel: z.string(),
  authorId:     z.string().uuid(),
  authorName:   z.string(),
  content:      z.string(),
  createdAt:    z.string(),
  attachments:  z.array(AttachmentSchema).default([]),
})
export type ForwardedRef = z.infer<typeof ForwardedRefSchema>

// Превью ссылки (Open Graph / oEmbed-метаданные). Снимок снимается сервером
// асинхронно после отправки и денормализуется в сообщение, поэтому карточка
// переживает перезагрузку и не зависит от доступности исходного сайта.
// kind='image' — прямая ссылка на картинку (рендерим только изображение,
// без «обвязки» карточки). kind='link' — обычная OG-карточка.
export const LinkPreviewSchema = z.object({
  /** Канонический URL (og:url или итоговый после редиректов). */
  url:         z.string().url(),
  // 'link' — обычная OG-карточка, 'image' — прямая картинка,
  // 'video' — встраиваемый плеер (YouTube и т.п.; см. embedUrl).
  kind:        z.enum(['link', 'image', 'video']).default('link'),
  siteName:    z.string().nullable().optional(),
  title:       z.string().nullable().optional(),
  description: z.string().nullable().optional(),
  imageUrl:    z.string().url().nullable().optional(),
  /** Для kind='video': URL для <iframe> (например, youtube-nocookie embed). */
  embedUrl:    z.string().url().nullable().optional(),
})
export type LinkPreview = z.infer<typeof LinkPreviewSchema>

// Системное событие в ленте (не «пузырь»): итог DM-звонка (T-087) или
// присоединение участника к серверу. Дискриминируется по полю kind.
export const SystemEventSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('call'), durationSec: z.number().int().nonnegative() }),
  z.object({ kind: z.literal('join') }),
  // День рождения автора сообщения — строка «🎂 сегодня день рождения у X».
  z.object({ kind: z.literal('birthday') }),
])
export type SystemEvent = z.infer<typeof SystemEventSchema>

// GIF-вложение сообщения. Хранится структурно (jsonb), а не как markdown
// `![](url)` — чтобы рендерить как <video> (mp4, без перезагрузки кадров) и
// открывать в лайтбоксе. mp4Url null у загруженных .gif (без перекодирования) —
// такие рендерятся обычным <img>.
export const GifEmbedSchema = z.object({
  gifUrl:     z.string().url(),
  mp4Url:     z.string().url().nullable(),
  previewUrl: z.string().url(),
  width:      z.number().int().positive(),
  height:     z.number().int().positive(),
})
export type GifEmbed = z.infer<typeof GifEmbedSchema>

// Клип-вложение (Klipy Clip): короткое видео СО звуком. В отличие от gif —
// рендерится плеером с контролами/звуком (не muted-loop). previewUrl — постер,
// gifUrl — беззвучный луп-фолбэк, mp4Url — основное видео со звуком.
export const ClipEmbedSchema = z.object({
  mp4Url:     z.string().url(),
  gifUrl:     z.string().url().nullable(),
  previewUrl: z.string().url(),
  width:      z.number().int().positive(),
  height:     z.number().int().positive(),
  title:      z.string().default(''),
})
export type ClipEmbed = z.infer<typeof ClipEmbedSchema>

// Стикер-вложение сообщения: денормализованный снимок стикера на момент
// отправки (как ForwardedRef). Переживает удаление стикера из набора сервера —
// уже отправленные сообщения продолжают рендериться. Источник — кастомный
// стикер сервера (MinIO) или внешняя библиотека Klipy.
export const StickerRefSchema = z.object({
  /** uuid стикера сервера, либо slug/id стикера Klipy (source='klipy'). */
  stickerId: z.string(),
  name:      z.string(),
  imageUrl:  z.string().url(),
  width:     z.number().int().positive(),
  height:    z.number().int().positive(),
  source:    z.enum(['server', 'klipy']).default('server'),
})
export type StickerRef = z.infer<typeof StickerRefSchema>

// ───── Polls (опросы) ─────

// Статическая часть опроса — хранится в messages.poll (jsonb): вопрос и
// варианты. Голоса живут отдельной таблицей poll_votes (один голос на юзера,
// повторный голос переносит выбор, клик по своему варианту — снимает голос).
export const PollDefinitionSchema = z.object({
  question: z.string().min(1).max(300),
  options:  z.array(z.string().min(1).max(100)).min(2).max(8),
})
export type PollDefinition = z.infer<typeof PollDefinitionSchema>

// Опрос в DTO сообщения: определение + живые счётчики + мой голос.
export const PollViewSchema = z.object({
  question: z.string(),
  options: z.array(z.object({
    text:  z.string(),
    votes: z.number().int().nonnegative(),
  })),
  /** Индекс варианта, за который голосовал текущий юзер; null — не голосовал. */
  myVote:     z.number().int().nullable(),
  totalVotes: z.number().int().nonnegative(),
})
export type PollView = z.infer<typeof PollViewSchema>

export const PollVoteRequestSchema = z.object({
  option: z.number().int().min(0).max(7),
})
export type PollVoteRequest = z.infer<typeof PollVoteRequestSchema>

// ───── Events (встречи) ─────

// Статическая часть встречи — в messages.event (jsonb). RSVP — отдельной
// таблицей event_rsvps («пойду»/«не пойду», один ответ на юзера).
export const EventDefinitionSchema = z.object({
  title:    z.string().min(1).max(200),
  /** ISO-момент начала. */
  startsAt: z.string().datetime({ offset: true }),
  place:    z.string().max(200).nullable(),
})
export type EventDefinition = z.infer<typeof EventDefinitionSchema>

export const EventRsvpSchema = z.enum(['going', 'declined'])
export type EventRsvp = z.infer<typeof EventRsvpSchema>

// Встреча в DTO сообщения: определение + списки идущих/отказавшихся + мой ответ.
export const EventViewSchema = z.object({
  title:    z.string(),
  startsAt: z.string(),
  place:    z.string().nullable(),
  going:    z.array(z.string().uuid()),
  declined: z.array(z.string().uuid()),
  myRsvp:   EventRsvpSchema.nullable(),
})
export type EventView = z.infer<typeof EventViewSchema>

export const EventRsvpRequestSchema = z.object({
  /** null = снять свой ответ. */
  rsvp: EventRsvpSchema.nullable(),
})
export type EventRsvpRequest = z.infer<typeof EventRsvpRequestSchema>

export const MessageSchema = z.object({
  id: z.string().uuid(),
  channelId: z.string().uuid(),
  authorId: z.string().uuid(),
  content: z.string().max(4000),
  /** Системное событие (call-log и т.п.); null/absent — обычное сообщение. */
  system: SystemEventSchema.nullable().optional(),
  replyToId: z.string().uuid().nullable().optional(),
  replyTo: ReplyRefSchema.nullable().optional(),
  createdAt: z.string(),
  editedAt: z.string().nullable().optional(),
  reactions: z.array(ReactionAggregateSchema).default([]),
  attachments: z.array(AttachmentSchema).default([]),
  thread: ThreadInfoSchema.nullable().optional(),
  /** Закреплено в канале (pinnedAt — момент закрепления). */
  pinned: z.boolean().default(false),
  pinnedAt: z.string().nullable().optional(),
  /** Пересланное сообщение — снимок оригинала. */
  forwarded: ForwardedRefSchema.nullable().optional(),
  /** OG-превью ссылок из текста. Подъезжают асинхронно (WS msg.embeds). */
  linkPreviews: z.array(LinkPreviewSchema).default([]),
  /** GIF-вложение (Klipy или загруженный .gif); null — обычное сообщение. */
  gif: GifEmbedSchema.nullable().optional(),
  /** Стикер сервера/Klipy (снимок); null — обычное сообщение. */
  sticker: StickerRefSchema.nullable().optional(),
  /** Клип Klipy (видео со звуком); null — обычное сообщение. */
  clip: ClipEmbedSchema.nullable().optional(),
  /** Опрос (определение + счётчики + мой голос); null — обычное сообщение. */
  poll: PollViewSchema.nullable().optional(),
  /** Встреча (определение + RSVP + мой ответ); null — обычное сообщение. */
  event: EventViewSchema.nullable().optional(),
  /**
   * Nonce отправителя (из SendMessageRequest): клиент по нему матчит своё
   * оптимистичное pending-сообщение с настоящим — иначе, пока REST-ответ в
   * пути, WS msg.new успевает добавить сообщение и оно мигает дублем.
   */
  clientNonce: z.string().max(64).nullable().optional(),
})
export type Message = z.infer<typeof MessageSchema>

export const ServerMemberSchema = z.object({
  serverId: z.string().uuid(),
  userId: z.string().uuid(),
  role: z.enum(['owner', 'admin', 'member']),
  joinedAt: z.string(),
})
export type ServerMember = z.infer<typeof ServerMemberSchema>

// ───── Roles (система ролей с разрешениями) ─────

const roleColorSchema = z.string().regex(/^#[0-9a-fA-F]{6}$/, 'цвет: #rrggbb').nullable()
const roleNameSchema = z.string().min(1).max(32)

export const RoleSchema = z.object({
  id:          z.string().uuid(),
  serverId:    z.string().uuid(),
  name:        z.string(),
  color:       z.string().nullable(),
  /** Битовая маска разрешений (см. @kakdela/ginzu/permissions). */
  permissions: z.number().int().nonnegative(),
  /** Чем выше — тем старше; @everyone = 0. Определяет иерархию. */
  position:    z.number().int(),
  /** Показывать носителей отдельной группой в списке участников. */
  hoist:       z.boolean(),
  mentionable: z.boolean(),
  /** Базовая роль @everyone — её нельзя удалить/переименовать/переместить. */
  isEveryone:  z.boolean(),
})
export type Role = z.infer<typeof RoleSchema>

/** Краткая роль для бейджей в профиле / списке участников. */
export const RoleRefSchema = z.object({
  id:       z.string().uuid(),
  name:     z.string(),
  color:    z.string().nullable(),
  position: z.number().int(),
  hoist:    z.boolean(),
})
export type RoleRef = z.infer<typeof RoleRefSchema>

export const RolesListResponseSchema = z.object({
  roles: z.array(RoleSchema),
})
export type RolesListResponse = z.infer<typeof RolesListResponseSchema>

export const CreateRoleRequestSchema = z.object({
  name:        roleNameSchema,
  color:       roleColorSchema.optional(),
  permissions: z.number().int().nonnegative().optional(),
  hoist:       z.boolean().optional(),
  mentionable: z.boolean().optional(),
})
export type CreateRoleRequest = z.infer<typeof CreateRoleRequestSchema>

export const PatchRoleRequestSchema = z.object({
  name:        roleNameSchema.optional(),
  color:       roleColorSchema.optional(),
  permissions: z.number().int().nonnegative().optional(),
  position:    z.number().int().nonnegative().optional(),
  hoist:       z.boolean().optional(),
  mentionable: z.boolean().optional(),
})
export type PatchRoleRequest = z.infer<typeof PatchRoleRequestSchema>

export const SetMemberRolesRequestSchema = z.object({
  roleIds: z.array(z.string().uuid()).max(50),
})
export type SetMemberRolesRequest = z.infer<typeof SetMemberRolesRequestSchema>

// ───── Auth ─────

const usernameSchema = z
  .string()
  .min(2)
  .max(32)
  .regex(/^[a-z0-9_]+$/, 'username: только a-z, 0-9, _')

const passwordSchema = z.string().min(6).max(200)

export const RegisterRequestSchema = z.object({
  inviteCode: z.string().min(4).max(32),
  username: usernameSchema,
  // Имя задаётся на втором шаге регистрации (оформление профиля);
  // без него сервер подставляет username.
  displayName: z.string().min(1).max(64).optional(),
  email: z.string().email().max(254),
  password: passwordSchema,
})
export type RegisterRequest = z.infer<typeof RegisterRequestSchema>

export const LoginRequestSchema = z.object({
  email: z.string().email().max(254),
  password: z.string().min(1).max(200),
})
export type LoginRequest = z.infer<typeof LoginRequestSchema>

export const RefreshRequestSchema = z.object({
  refreshToken: z.string().min(1).optional(),
})
export type RefreshRequest = z.infer<typeof RefreshRequestSchema>

export const AuthResponseSchema = z.object({
  accessToken: z.string(),
  user: UserSchema,
  /** Только для нативных клиентов (заголовок X-KD-Client: tauri): их WebView
      живёт на tauri.localhost, и SameSite-cookie до API не доезжает — refresh
      уезжает в body и хранится в шифрованном сторе клиента. Web-клиент
      same-origin и остаётся на httpOnly-cookie (поле отсутствует). */
  refreshToken: z.string().optional(),
})
export type AuthResponse = z.infer<typeof AuthResponseSchema>

export const InvitePublicSchema = z.object({
  serverId: z.string().uuid(),
  serverName: z.string(),
  serverIcon: z.string().url().nullable(),
  memberCount: z.number().int().nonnegative(),
  expiresAt: z.string().nullable(),
})
export type InvitePublic = z.infer<typeof InvitePublicSchema>

export const CreateInviteResponseSchema = z.object({
  code: z.string(),
  url: z.string(),
})
export type CreateInviteResponse = z.infer<typeof CreateInviteResponseSchema>

export const SendMessageRequestSchema = z.object({
  content: z.string().max(4000),
  replyToId: z.string().uuid().optional(),
  clientNonce: z.string().max(64).optional(),
  attachments: z.array(z.string().uuid()).max(10).optional(),
  /** Подмножество attachments, которые нужно пометить спойлером. */
  spoilerAttachments: z.array(z.string().uuid()).max(10).optional(),
  /** GIF-вложение (отправка из пикера/избранного). */
  gif: GifEmbedSchema.optional(),
  /** Стикер (отправка из пикера/избранного). */
  sticker: StickerRefSchema.optional(),
  /** Клип Klipy (видео со звуком). */
  clip: ClipEmbedSchema.optional(),
  /** Опрос: вопрос + варианты (сообщение-опрос может быть без текста). */
  poll: PollDefinitionSchema.optional(),
  /** Встреча: заголовок + время + место (сообщение может быть без текста). */
  event: EventDefinitionSchema.optional(),
}).refine(
  (v) => v.content.trim().length > 0 || (v.attachments && v.attachments.length > 0) || v.gif !== undefined || v.sticker !== undefined || v.clip !== undefined || v.poll !== undefined || v.event !== undefined,
  { message: 'message must have content, attachments, a gif, a sticker, a clip, a poll or an event', path: ['content'] },
)
export type SendMessageRequest = z.infer<typeof SendMessageRequestSchema>

export const EditMessageRequestSchema = z.object({
  content: z.string().min(1).max(4000),
})
export type EditMessageRequest = z.infer<typeof EditMessageRequestSchema>

export const MessagesPageSchema = z.object({
  messages: z.array(MessageSchema),
  nextCursor: z.string().uuid().nullable(),
})
export type MessagesPage = z.infer<typeof MessagesPageSchema>

export const ForwardMessageRequestSchema = z.object({
  toChannelId: z.string().uuid(),
  /** Необязательная подпись от пересылающего над карточкой оригинала. */
  note: z.string().max(4000).optional(),
})
export type ForwardMessageRequest = z.infer<typeof ForwardMessageRequestSchema>

export const PinnedMessagesResponseSchema = z.object({
  messages: z.array(MessageSchema),
})
export type PinnedMessagesResponse = z.infer<typeof PinnedMessagesResponseSchema>

// ───── Медиа-библиотека Klipy (GIF / стикеры / клипы; мемы — позже) ─────
//
// Сервер проксирует Klipy (ключ и customer_id не уходят клиенту), выбирает
// нужные тиры/форматы и отдаёт плоский нормализованный элемент — один и тот же
// для грида пикера и сборки вложения на отправку. type различает поведение.

export const KlipyMediaTypeSchema = z.enum(['gifs', 'stickers', 'clips'])
export type KlipyMediaType = z.infer<typeof KlipyMediaTypeSchema>

export const KlipyItemSchema = z.object({
  id: z.string(),
  /** slug Klipy — нужен для share-триггера (attribution) и report. */
  slug: z.string(),
  title: z.string(),
  /** Маленькое превью для грида пикера. */
  previewUrl: z.string().url(),
  /** Основной показ: gif/webp (или gif-луп клипа). */
  url: z.string().url(),
  /** mp4: у gif — muted-версия, у клипа — со звуком; null у стикеров. */
  mp4Url: z.string().url().nullable(),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
})
export type KlipyItem = z.infer<typeof KlipyItemSchema>

export const KlipyResponseSchema = z.object({
  items: z.array(KlipyItemSchema),
  /** Номер следующей страницы или null, если результаты кончились. */
  nextPage: z.number().int().positive().nullable(),
})
export type KlipyResponse = z.infer<typeof KlipyResponseSchema>

// Флаги возможностей: enabled — есть ли ключ; по типам — что реально доступно
// на текущем тарифе ключа (memes на dev-ключе закрыт).
export const KlipyConfigSchema = z.object({
  enabled: z.boolean(),
  gifs: z.boolean(),
  stickers: z.boolean(),
  clips: z.boolean(),
  memes: z.boolean(),
})
export type KlipyConfig = z.infer<typeof KlipyConfigSchema>

// ───── Избранное (единое: гифки / стикеры / эмодзи, per-user, на бэкенде) ─────
//
// Одна таблица + один набор роутов. kind различает тип, refKey — ключ дедупа в
// рамках (user, kind), payload — данные для рендера/отправки/вставки. Payload
// типизирован объединением по kind; клиент сужает по полю kind.

export const FavoriteKindSchema = z.enum(['gif', 'sticker', 'emoji'])
export type FavoriteKind = z.infer<typeof FavoriteKindSchema>

// gif: тот же набор полей, что и GifEmbed + заголовок (refKey = gifUrl).
export const GifFavoritePayloadSchema = z.object({
  gifUrl:     z.string().url(),
  mp4Url:     z.string().url().nullable(),
  previewUrl: z.string().url(),
  width:      z.number().int().positive(),
  height:     z.number().int().positive(),
  title:      z.string().default(''),
})
export type GifFavoritePayload = z.infer<typeof GifFavoritePayloadSchema>

// sticker: снимок стикера (refKey = stickerId).
export const StickerFavoritePayloadSchema = z.object({
  stickerId: z.string().uuid(),
  name:      z.string(),
  imageUrl:  z.string().url(),
  width:     z.number().int().positive(),
  height:    z.number().int().positive(),
})
export type StickerFavoritePayload = z.infer<typeof StickerFavoritePayloadSchema>

// emoji: token = '😀' (unicode) или ':name:' (кастом); imageUrl у кастомных.
// refKey = token.
export const EmojiFavoritePayloadSchema = z.object({
  token:    z.string().min(1).max(64),
  imageUrl: z.string().url().nullable(),
})
export type EmojiFavoritePayload = z.infer<typeof EmojiFavoritePayloadSchema>

export const FavoritePayloadSchema = z.union([
  GifFavoritePayloadSchema,
  StickerFavoritePayloadSchema,
  EmojiFavoritePayloadSchema,
])
export type FavoritePayload = z.infer<typeof FavoritePayloadSchema>

export const FavoriteSchema = z.object({
  id:        z.string().uuid(),
  kind:      FavoriteKindSchema,
  refKey:    z.string(),
  payload:   FavoritePayloadSchema,
  createdAt: z.string(),
})
export type Favorite = z.infer<typeof FavoriteSchema>

export const FavoritesResponseSchema = z.object({
  favorites: z.array(FavoriteSchema),
})
export type FavoritesResponse = z.infer<typeof FavoritesResponseSchema>

export const AddFavoriteRequestSchema = z.object({
  kind:    FavoriteKindSchema,
  refKey:  z.string().min(1).max(512),
  payload: FavoritePayloadSchema,
})
export type AddFavoriteRequest = z.infer<typeof AddFavoriteRequestSchema>

export const MemberPublicSchema = z.object({
  id: z.string().uuid(),
  // ЭФФЕКТИВНОЕ имя: серверный ник (если задан) поверх глобального
  // displayName. Клиент рендерит как есть — резолвить ничего не нужно.
  displayName: z.string().max(64),
  // Логин-ник (@username) — нужен для упоминаний `@ник`. Optional, чтобы
  // не ломать старые места, где участник собирается без него.
  username: z.string().optional(),
  // ЭФФЕКТИВНЫЙ аватар: серверный (если задан) поверх глобального.
  avatarUrl: z.string().url().nullable(),
  // Сырые override'ы серверного профиля — для UI редактирования и подписи
  // «он же <глобальное имя>». null/absent = не переопределено.
  nickname: z.string().max(64).nullable().optional(),
  serverAvatarUrl: z.string().url().nullable().optional(),
  status: z.enum(['online', 'idle', 'dnd', 'offline']),
  customStatus: z.string().max(128).nullable().optional(),
  /** День рождения «MM-DD» — для 🎂 в списке участников. */
  birthday: z.string().nullable().optional(),
  role: z.enum(['owner', 'admin', 'member']),
  // Назначенные кастомные роли (без @everyone), от старшей к младшей.
  roles: z.array(RoleRefSchema).default([]),
  // Эффективная маска прав участника (builtin role ∪ @everyone ∪ кастомные).
  permissions: z.number().int().nonnegative().default(0),
})
export type MemberPublic = z.infer<typeof MemberPublicSchema>

export const ChannelCategorySchema = z.object({
  name: z.string().min(1).max(64),
  position: z.number().int().nonnegative(),
})
export type ChannelCategory = z.infer<typeof ChannelCategorySchema>

export const ServerDetailSchema = z.object({
  server: ServerSchema,
  channels: z.array(ChannelSchema),
  categories: z.array(ChannelCategorySchema),
  memberCount: z.number().int().nonnegative(),
})
export type ServerDetail = z.infer<typeof ServerDetailSchema>

// ───── Server lifecycle (T-083) ─────

export const CreateServerRequestSchema = z.object({
  name:    z.string().min(2).max(64),
  iconUrl: z.string().url().nullable().optional(),
})
export type CreateServerRequest = z.infer<typeof CreateServerRequestSchema>

export const PatchServerRequestSchema = z.object({
  name:      z.string().min(2).max(64).optional(),
  iconUrl:   z.string().url().nullable().optional(),
  bannerUrl: z.string().url().nullable().optional(),
})
export type PatchServerRequest = z.infer<typeof PatchServerRequestSchema>

export const InviteSummarySchema = z.object({
  code:      z.string(),
  url:       z.string(),
  createdBy: z.string().uuid().nullable(),
  expiresAt: z.string().nullable(),
  maxUses:   z.number().int().positive().nullable(),
  useCount:  z.number().int().nonnegative(),
  revoked:   z.boolean(),
  createdAt: z.string(),
})
export type InviteSummary = z.infer<typeof InviteSummarySchema>

export const InvitesListResponseSchema = z.object({
  invites: z.array(InviteSummarySchema),
})
export type InvitesListResponse = z.infer<typeof InvitesListResponseSchema>

// Непрочитанные серверные каналы (per-channel read-state). channelIds — каналы,
// где есть чужие сообщения новее последнего прочтения.
export const ServerUnreadResponseSchema = z.object({
  channelIds: z.array(z.string().uuid()),
})
export type ServerUnreadResponse = z.infer<typeof ServerUnreadResponseSchema>

export const CreateChannelRequestSchema = z.object({
  name: z.string().min(1).max(64),
  kind: z.enum(['text', 'voice']),
  category: z.string().max(64).optional(),
  topic: z.string().max(256).optional(),
})
export type CreateChannelRequest = z.infer<typeof CreateChannelRequestSchema>

export const CreateCategoryRequestSchema = z.object({
  name: z.string().min(1).max(64),
})
export type CreateCategoryRequest = z.infer<typeof CreateCategoryRequestSchema>

// Допустимые значения для селектов «обзора» (значения — секунды).
export const SLOW_MODE_MAX_SEC = 6 * 60 * 60        // 6 часов
export const AUTO_DELETE_MAX_SEC = 365 * 24 * 60 * 60 // год

export const PatchChannelRequestSchema = z.object({
  name: z.string().min(1).max(64).optional(),
  topic: z.string().max(256).nullable().optional(),
  position: z.number().int().nonnegative().optional(),
  // null = убрать канал из категории (категория — просто метка на канале).
  category: z.string().max(64).nullable().optional(),
  // text↔voice: смена типа уже созданного канала.
  kind: z.enum(['text', 'voice']).optional(),
  // Настройки «обзора». null у autoDeleteSec = выключить автоудаление.
  slowModeSec:    z.number().int().min(0).max(SLOW_MODE_MAX_SEC).optional(),
  autoDeleteSec:  z.number().int().positive().max(AUTO_DELETE_MAX_SEC).nullable().optional(),
  isDefault:      z.boolean().optional(),
  friendsOnly:    z.boolean().optional(),
  nsfw:           z.boolean().optional(),
  threadsAllowed: z.boolean().optional(),
})
export type PatchChannelRequest = z.infer<typeof PatchChannelRequestSchema>

// ───── Threads ─────

export const ThreadSummarySchema = z.object({
  channel:          ChannelSchema,
  parentMessageId:  z.string().uuid().nullable(),
  messageCount:     z.number().int().nonnegative(),
  lastMessageAt:    z.string().nullable(),
})
export type ThreadSummary = z.infer<typeof ThreadSummarySchema>

export const CreateThreadRequestSchema = z.object({
  name:         z.string().min(1).max(100).optional(),
  firstMessage: z.string().min(1).max(4000).optional(),
})
export type CreateThreadRequest = z.infer<typeof CreateThreadRequestSchema>

export const CreateThreadResponseSchema = z.object({
  thread:       ChannelSchema,
  firstMessage: MessageSchema.nullable(),
})
export type CreateThreadResponse = z.infer<typeof CreateThreadResponseSchema>

export const ThreadListResponseSchema = z.object({
  threads: z.array(ThreadSummarySchema),
})
export type ThreadListResponse = z.infer<typeof ThreadListResponseSchema>

// ───── DM ─────

export const DmLastMessagePreviewSchema = z.object({
  id:        z.string().uuid(),
  authorId:  z.string().uuid(),
  preview:   z.string(),
  createdAt: z.string(),
})
export type DmLastMessagePreview = z.infer<typeof DmLastMessagePreviewSchema>

export const DmSummarySchema = z.object({
  channelId:   z.string().uuid(),
  otherUser:   MemberPublicSchema.omit({ role: true }),
  lastMessage: DmLastMessagePreviewSchema.nullable(),
  unreadCount: z.number().int().nonnegative(),
  /** Последнее сообщение, прочитанное СОБЕСЕДНИКОМ (его lastRead-курсор).
      Мои сообщения с id <= этого — «прочитаны» (галочки ✓✓). */
  peerLastReadMessageId: z.string().uuid().nullable(),
})
export type DmSummary = z.infer<typeof DmSummarySchema>

export const DmListResponseSchema = z.object({
  dms: z.array(DmSummarySchema),
})
export type DmListResponse = z.infer<typeof DmListResponseSchema>

export const DmOpenResponseSchema = z.object({
  channel:   ChannelSchema,
  otherUser: MemberPublicSchema.omit({ role: true }),
  created:   z.boolean(),
})
export type DmOpenResponse = z.infer<typeof DmOpenResponseSchema>

export const DmMarkReadRequestSchema = z.object({
  messageId: z.string().uuid(),
})
export type DmMarkReadRequest = z.infer<typeof DmMarkReadRequestSchema>

// ───── User profile ─────

export const SharedServerSchema = z.object({
  id:       z.string().uuid(),
  name:     z.string(),
  iconUrl:  z.string().url().nullable(),
  role:     z.enum(['owner', 'admin', 'member']),
  joinedAt: z.string(),
})
export type SharedServer = z.infer<typeof SharedServerSchema>

export const UserProfileSchema = z.object({
  id:           z.string().uuid(),
  username:     z.string(),
  displayName:  z.string(),
  avatarUrl:    z.string().url().nullable(),
  customStatus: z.string().nullable(),
  status:       z.enum(['online', 'idle', 'dnd', 'offline']),
  about:        z.string().max(512).nullable(),
  timezone:     z.string().max(64).nullable(),
  /** День рождения «MM-DD» (без года — возраст не палим). */
  birthday:     z.string().regex(/^\d{2}-\d{2}$/).nullable(),
  bannerUrl:    z.string().url().nullable(),
  createdAt:    z.string(),
  sharedServers: z.array(SharedServerSchema),
  // Кастомные роли по общим с запрашивающим серверам (цветные пилюли).
  roles:        z.array(RoleRefSchema).default([]),
  isSelf:       z.boolean(),
})
export type UserProfile = z.infer<typeof UserProfileSchema>

export const PatchMeRequestSchema = z.object({
  displayName:     z.string().min(1).max(64).optional(),
  customStatus:    z.string().max(128).nullable().optional(),
  avatarUrl:       z.string().url().nullable().optional(),
  about:           z.string().max(512).nullable().optional(),
  timezone:        z.string().max(64).nullable().optional(),
  /** «MM-DD»; валидность дня в месяце проверяет сервер. null = убрать. */
  birthday:        z.string().regex(/^(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/).nullable().optional(),
  bannerUrl:       z.string().url().nullable().optional(),
  currentPassword: z.string().min(1).max(200).optional(),
  newPassword:     z.string().min(6).max(200).optional(),
}).refine(
  (v) => (v.newPassword === undefined) === (v.currentPassword === undefined),
  { message: 'newPassword requires currentPassword (and vice versa)', path: ['newPassword'] },
)
export type PatchMeRequest = z.infer<typeof PatchMeRequestSchema>

// ───── Серверный профиль (per-server ник и аватар, как в Discord) ─────

// PATCH /api/servers/:serverId/members/me. null = сбросить к глобальному.
export const PatchMemberProfileRequestSchema = z.object({
  nickname:  z.string().trim().min(1).max(64).nullable().optional(),
  avatarUrl: z.string().url().nullable().optional(),
}).refine(
  (v) => v.nickname !== undefined || v.avatarUrl !== undefined,
  { message: 'nothing to update', path: ['nickname'] },
)
export type PatchMemberProfileRequest = z.infer<typeof PatchMemberProfileRequestSchema>

export const MemberProfileResponseSchema = z.object({
  nickname:  z.string().nullable(),
  avatarUrl: z.string().url().nullable(),
})
export type MemberProfileResponse = z.infer<typeof MemberProfileResponseSchema>

// ───── Search ─────

export const SearchSortSchema = z.enum(['rank', 'recent'])
export type SearchSort = z.infer<typeof SearchSortSchema>

export const SearchRequestSchema = z.object({
  q:         z.string().min(1).max(200),
  channelId: z.string().uuid().optional(),
  /** Ограничить поиск каналами одного сервера (иконка поиска в шапке канала). */
  serverId:  z.string().uuid().optional(),
  authorId:  z.string().uuid().optional(),
  before:    z.string().datetime().optional(),
  after:     z.string().datetime().optional(),
  limit:     z.coerce.number().int().min(1).max(100).optional().default(50),
  sort:      SearchSortSchema.optional().default('rank'),
})
export type SearchRequest = z.infer<typeof SearchRequestSchema>

export const SearchResultItemSchema = z.object({
  messageId:        z.string().uuid(),
  channelId:        z.string().uuid(),
  channelName:      z.string(),
  channelKind:      z.enum(['text', 'voice', 'dm']),
  serverId:         z.string().uuid().nullable(),
  serverName:       z.string().nullable(),
  authorId:         z.string().uuid(),
  authorName:       z.string(),
  authorAvatarUrl:  z.string().url().nullable(),
  content:          z.string(),
  /** ts_headline-generated HTML-safe markup with <mark>matched</mark> spans. */
  headline:         z.string(),
  createdAt:        z.string(),
  rank:             z.number(),
})
export type SearchResultItem = z.infer<typeof SearchResultItemSchema>

export const SearchResponseSchema = z.object({
  results: z.array(SearchResultItemSchema),
  total:   z.number().int().nonnegative(),
  query:   z.string(),
})
export type SearchResponse = z.infer<typeof SearchResponseSchema>

// ───── Inbox / mentions ─────

export const MentionTypeSchema = z.enum(['user', 'everyone', 'here'])
export type MentionType = z.infer<typeof MentionTypeSchema>

export const InboxMentionSchema = z.object({
  messageId:   z.string().uuid(),
  channelId:   z.string().uuid(),
  channelName: z.string(),
  channelKind: z.enum(['text', 'voice', 'dm']),
  serverId:    z.string().uuid().nullable(),
  serverName:  z.string().nullable(),
  authorId:    z.string().uuid(),
  authorName:  z.string(),
  authorAvatarUrl: z.string().url().nullable(),
  content:     z.string(),
  createdAt:   z.string(),
  mentionType: MentionTypeSchema,
  readAt:      z.string().nullable(),
})
export type InboxMention = z.infer<typeof InboxMentionSchema>

export const InboxMentionsResponseSchema = z.object({
  mentions:   z.array(InboxMentionSchema),
  nextCursor: z.string().uuid().nullable(),
  unreadTotal: z.number().int().nonnegative(),
})
export type InboxMentionsResponse = z.infer<typeof InboxMentionsResponseSchema>

export const InboxMarkReadRequestSchema = z.object({
  messageIds: z.array(z.string().uuid()).min(1).max(200),
})
export type InboxMarkReadRequest = z.infer<typeof InboxMarkReadRequestSchema>

// ───── Voice ─────

export const VoiceParticipantPublicSchema = z.object({
  userId: z.string(),
  displayName: z.string(),
  isScreenSharing: z.boolean(),
  // Микрофон замьючен (нет ни одной не-замьюченной mic-дорожки).
  isMuted: z.boolean().default(true),
  // Серверная модерация (админ заглушил микрофон/наушники).
  serverMuted: z.boolean().default(false),
  serverDeafened: z.boolean().default(false),
})
export type VoiceParticipantPublic = z.infer<typeof VoiceParticipantPublicSchema>

export const VoiceModerateRequestSchema = z.object({
  userId: z.string().uuid(),
  action: z.enum(['mute', 'unmute', 'deafen', 'undeafen', 'kick', 'move']),
  // Только для action=move: целевой голосовой канал того же сервера.
  toChannelId: z.string().uuid().optional(),
})
export type VoiceModerateRequest = z.infer<typeof VoiceModerateRequestSchema>

// Само-репорт mute-тумблера участником ГС. LiveKit не шлёт вебхуков на
// mute/unmute уже опубликованного трека — без репорта зрители вне канала
// не узнают о переключении до рефетча.
export const VoiceSelfStateRequestSchema = z.object({
  muted: z.boolean(),
})
export type VoiceSelfStateRequest = z.infer<typeof VoiceSelfStateRequestSchema>

// Hover-превью демки (как в Discord): стример периодически заливает
// маленький JPEG-кадр своего экрана, сервер держит его в Redis с коротким
// TTL. Нужен тем, кто НЕ в комнате (живая LiveKit-подписка им недоступна).
// dataBase64 — без `data:`-префикса. 384 КБ base64 ≈ 288 КБ JPEG — с запасом
// для кадра 480px.
export const VOICE_PREVIEW_MAX_BASE64 = 384 * 1024

export const VoicePreviewUploadRequestSchema = z.object({
  dataBase64: z.string().min(1).max(VOICE_PREVIEW_MAX_BASE64),
})
export type VoicePreviewUploadRequest = z.infer<typeof VoicePreviewUploadRequestSchema>

export const VoicePreviewResponseSchema = z.object({
  /** data:image/jpeg;base64,… или null, если превью (ещё) нет. */
  dataUrl: z.string().nullable(),
})
export type VoicePreviewResponse = z.infer<typeof VoicePreviewResponseSchema>

/**
 * Тело POST /voice/:channelId/join и /voice/dm/:channelId/join.
 * deviceId — стабильный id устройства клиента: LiveKit identity станет
 * `userId:deviceId`, чтобы два устройства одного аккаунта не выбивали друг
 * друга из комнаты (аудит 2026-08, C-2). Не передан → identity = userId
 * (совместимость со старыми клиентами).
 */
export const VoiceJoinRequestSchema = z.object({
  deviceId: z
    .string()
    .min(8)
    .max(64)
    .regex(/^[A-Za-z0-9_-]+$/, 'deviceId must be [A-Za-z0-9_-]')
    .optional(),
})
export type VoiceJoinRequest = z.infer<typeof VoiceJoinRequestSchema>

export const VoiceJoinResponseSchema = z.object({
  token: z.string(),
  url: z.string(),
  room: z.string(),
  participants: z.array(VoiceParticipantPublicSchema),
})
export type VoiceJoinResponse = z.infer<typeof VoiceJoinResponseSchema>

export const VoiceParticipantsResponseSchema = z.object({
  participants: z.array(VoiceParticipantPublicSchema),
})
export type VoiceParticipantsResponse = z.infer<typeof VoiceParticipantsResponseSchema>

// ───── Files / uploads ─────

export const PRESIGN_ALLOWED_CONTENT_TYPES = [
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif',
  'video/mp4',
  'video/webm',
  'video/quicktime',
  'audio/mpeg',
  'audio/ogg',
  'audio/wav',
  'audio/flac',
  'audio/mp4',
  'audio/webm',
  'application/pdf',
  'text/plain',
  'application/zip',
  'application/x-7z-compressed',
  'application/x-rar-compressed',
  'application/gzip',
] as const

export const MAX_ATTACHMENT_SIZE = 25 * 1024 * 1024

export const PresignRequestSchema = z.object({
  contentType: z.enum(PRESIGN_ALLOWED_CONTENT_TYPES),
  size: z.number().int().positive().max(MAX_ATTACHMENT_SIZE),
  originalName: z.string().min(1).max(255).optional(),
  /** Голосовое сообщение (T-104) — только для audio/*. */
  voice: z.boolean().optional(),
  /** Кружок (T-105) — только для video/*. */
  circle: z.boolean().optional(),
  /** Длительность записи в секундах (замер на клиенте, максимум час). */
  durationSec: z.number().int().positive().max(3600).optional(),
})
export type PresignRequest = z.infer<typeof PresignRequestSchema>

export const PresignResponseSchema = z.object({
  fileId: z.string().uuid(),
  uploadUrl: z.string().url(),
  publicUrl: z.string().url(),
})
export type PresignResponse = z.infer<typeof PresignResponseSchema>

export const FinalizeResponseSchema = z.object({
  attachment: AttachmentSchema,
})
export type FinalizeResponse = z.infer<typeof FinalizeResponseSchema>

// ───── Audit log (T-082) ─────

export const AUDIT_ACTIONS = [
  'channel.create', 'channel.update', 'channel.delete',
  'member.promote', 'member.demote', 'member.kick', 'member.role.set',
  'invite.create',  'invite.revoke',
  'emoji.create',   'emoji.delete',
  'role.create',    'role.update',    'role.delete',
  'server.update',  'server.transfer',
] as const

export const AuditActionSchema = z.enum(AUDIT_ACTIONS)
export type AuditAction = z.infer<typeof AuditActionSchema>

export const AuditTargetTypeSchema = z.enum([
  'channel', 'user', 'invite', 'emoji', 'role', 'server',
])
export type AuditTargetType = z.infer<typeof AuditTargetTypeSchema>

// Actor может быть null если пользователь удалил аккаунт после действия.
export const AuditActorSchema = z.object({
  id:          z.string().uuid(),
  displayName: z.string(),
  avatarUrl:   z.string().url().nullable(),
}).nullable()
export type AuditActor = z.infer<typeof AuditActorSchema>

export const AuditEntrySchema = z.object({
  id:         z.string().uuid(),
  serverId:   z.string().uuid(),
  actor:      AuditActorSchema,
  action:     AuditActionSchema,
  targetType: AuditTargetTypeSchema,
  targetId:   z.string().uuid().nullable(),
  // jsonb — храним произвольную diff-структуру (before/after, name, code и т.д.)
  metadata:   z.record(z.unknown()).nullable(),
  createdAt:  z.string(),
})
export type AuditEntry = z.infer<typeof AuditEntrySchema>

export const AuditEntriesResponseSchema = z.object({
  entries:    z.array(AuditEntrySchema),
  // ISO timestamp следующей страницы; null когда страниц больше нет.
  nextCursor: z.string().nullable(),
})
export type AuditEntriesResponse = z.infer<typeof AuditEntriesResponseSchema>

// ───── Custom emoji (T-081) ─────

export const CUSTOM_EMOJI_MAX_BYTES = 256 * 1024
export const CUSTOM_EMOJI_MAX_DIMENSION = 128
export const CUSTOM_EMOJI_ALLOWED_CONTENT_TYPES = ['image/png', 'image/gif'] as const

// :name: должно совпадать с тем же лексером, что используется в markdown.
// Сам символ `:` запрещён, как и пробелы — иначе при подстановке в текст
// сообщения парсер не найдёт границу токена.
export const customEmojiNameSchema = z
  .string()
  .min(2)
  .max(32)
  .regex(/^[a-z0-9_]+$/, 'имя: только a-z, 0-9, _')

export const CustomEmojiSchema = z.object({
  id:        z.string().uuid(),
  serverId:  z.string().uuid(),
  name:      z.string(),
  imageUrl:  z.string().url(),
  animated:  z.boolean(),
  createdAt: z.string(),
})
export type CustomEmoji = z.infer<typeof CustomEmojiSchema>

export const EmojiListResponseSchema = z.object({
  emoji: z.array(CustomEmojiSchema),
})
export type EmojiListResponse = z.infer<typeof EmojiListResponseSchema>

export const CreateEmojiRequestSchema = z.object({
  name:        customEmojiNameSchema,
  contentType: z.enum(CUSTOM_EMOJI_ALLOWED_CONTENT_TYPES),
  // Base64-encoded image data (no `data:` prefix). 256 KB raw maps to ~340 KB
  // base64, which is still well within Fastify's default 1 MB body limit.
  dataBase64:  z.string().min(1).max(512 * 1024),
})
export type CreateEmojiRequest = z.infer<typeof CreateEmojiRequestSchema>

// ───── Стикеры (server-scoped, крупнее эмодзи; отправляются сообщением) ─────

export const STICKER_MAX_BYTES = 512 * 1024
export const STICKER_MAX_DIMENSION = 320
export const STICKER_ALLOWED_CONTENT_TYPES = ['image/png', 'image/gif', 'image/webp'] as const

// Имя стикера — просто ярлык (показывается в пикере), не токен. 1–40 символов.
export const stickerNameSchema = z.string().trim().min(1).max(40)

export const StickerSchema = z.object({
  id:        z.string().uuid(),
  serverId:  z.string().uuid(),
  name:      z.string(),
  imageUrl:  z.string().url(),
  animated:  z.boolean(),
  width:     z.number().int().positive(),
  height:    z.number().int().positive(),
  createdAt: z.string(),
})
export type Sticker = z.infer<typeof StickerSchema>

export const StickerListResponseSchema = z.object({
  stickers: z.array(StickerSchema),
})
export type StickerListResponse = z.infer<typeof StickerListResponseSchema>

export const CreateStickerRequestSchema = z.object({
  name:        stickerNameSchema,
  contentType: z.enum(STICKER_ALLOWED_CONTENT_TYPES),
  // 512 KB raw → ~680 KB base64; держим лимит с запасом под Fastify 1 MB body.
  dataBase64:  z.string().min(1).max(1024 * 1024),
})
export type CreateStickerRequest = z.infer<typeof CreateStickerRequestSchema>

export const ErrorBodySchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
  }),
})
export type ErrorBody = z.infer<typeof ErrorBodySchema>

// ───── Secret chats: ключи (T-101) и транспорт (T-102) ─────
//
// Сервер видит ТОЛЬКО публичные ключи и непрозрачный шифртекст: расшифровать
// он не может ничего (слепой каталог prekey'ев + слепой релей). Все base64-поля
// валидируем как непустые строки — формат задаёт libsignal на клиенте.

const base64Key = z.string().min(1).max(8192)

// --- Prekey directory (T-101) ---

export const SignedPrekeySchema = z.object({
  keyId:     z.number().int().nonnegative(),
  pubKey:    base64Key,
  signature: base64Key,
})
export type SignedPrekey = z.infer<typeof SignedPrekeySchema>

// Kyber1024 prekey (PQXDH, libsignal v0.96.4). Публичный ключ ~1.5КБ base64 —
// укладывается в base64Key (≤8192). Подписан identity-ключом, как signed prekey.
export const KyberPrekeySchema = z.object({
  keyId:     z.number().int().nonnegative(),
  pubKey:    base64Key,
  signature: base64Key,
})
export type KyberPrekey = z.infer<typeof KyberPrekeySchema>

export const OneTimePrekeySchema = z.object({
  keyId:  z.number().int().nonnegative(),
  pubKey: base64Key,
})
export type OneTimePrekey = z.infer<typeof OneTimePrekeySchema>

export const PublishKeysRequestSchema = z.object({
  identityKey:    base64Key,
  registrationId: z.number().int().nonnegative(),
  signedPrekey:   SignedPrekeySchema,
  kyberPrekey:    KyberPrekeySchema,
  oneTimePrekeys: z.array(OneTimePrekeySchema).max(200),
})
export type PublishKeysRequest = z.infer<typeof PublishKeysRequestSchema>

export const TopupPrekeysRequestSchema = z.object({
  identityKey: base64Key,
  oneTimePrekeys: z.array(OneTimePrekeySchema).min(1).max(200),
})
export type TopupPrekeysRequest = z.infer<typeof TopupPrekeysRequestSchema>

// Бандл для старта X3DH-сессии. oneTimePrekey = null, если у адресата кончились
// одноразовые ключи (libsignal допускает сессию и без него, с меньшим FS).
export const PrekeyBundleResponseSchema = z.object({
  userId:         z.string().uuid(),
  identityKey:    base64Key,
  registrationId: z.number().int().nonnegative(),
  signedPrekey:   SignedPrekeySchema,
  kyberPrekey:    KyberPrekeySchema,
  oneTimePrekey:  OneTimePrekeySchema.nullable(),
})
export type PrekeyBundleResponse = z.infer<typeof PrekeyBundleResponseSchema>

export const PrekeyCountResponseSchema = z.object({
  identityKey: base64Key.nullable().optional(),
  oneTimePrekeys: z.number().int().nonnegative(),
})
export type PrekeyCountResponse = z.infer<typeof PrekeyCountResponseSchema>

// --- Envelope queue (T-102) ---

// Тип конверта = тип ciphertext'а libsignal. Прикладные read/typing зашифрованы
// ВНУТРИ и серверу не видны (это не значения этого enum).
export const SecretMsgTypeSchema = z.enum(['prekey', 'message'])
export type SecretMsgType = z.infer<typeof SecretMsgTypeSchema>

export const SecretSendRequestSchema = z.object({
  toUserId:   z.string().uuid(),
  // base64 шифртекста (полезная нагрузка + ratchet-заголовок). Сервер не парсит.
  ciphertext: z.string().min(1).max(64 * 1024),
  msgType:    SecretMsgTypeSchema,
})
export type SecretSendRequest = z.infer<typeof SecretSendRequestSchema>

export const SecretSendResponseSchema = z.object({
  id: z.string().uuid(),
})
export type SecretSendResponse = z.infer<typeof SecretSendResponseSchema>

export const SecretEnvelopeSchema = z.object({
  id:         z.string().uuid(),
  fromUserId: z.string().uuid(),
  ciphertext: z.string(),
  msgType:    SecretMsgTypeSchema,
  createdAt:  z.string(),
})
export type SecretEnvelope = z.infer<typeof SecretEnvelopeSchema>

export const SecretInboxResponseSchema = z.object({
  nextCursor: z.string().uuid().nullable().optional(),
  envelopes: z.array(SecretEnvelopeSchema),
})
export type SecretInboxResponse = z.infer<typeof SecretInboxResponseSchema>

export const SecretAckRequestSchema = z.object({
  ids: z.array(z.string().uuid()).min(1).max(500),
})
export type SecretAckRequest = z.infer<typeof SecretAckRequestSchema>

// --- Secret control frame (T-102) ---
//
// Внутренний plaintext конверта: то, что клиент шифрует крипто-ядром и кладёт в
// `ciphertext`. Сервер этого НЕ видит (всё внутри E2EE). Прикладной вид сообщения
// (текст / read-receipt / typing) живёт ЗДЕСЬ, а не в серверном msgType — иначе
// сервер видел бы характер трафика. JSON этой структуры ↔ crypto_encrypt/decrypt.
export const SecretFrameSchema = z.discriminatedUnion('kind', [
  // Текстовое сообщение. `ts` — время отправки (epoch ms) по часам отправителя.
  z.object({ kind: z.literal('text'), body: z.string().min(1).max(16 * 1024), ts: z.number().int() }),
  // Read-receipt: «я прочитал твои сообщения вплоть до ts». Двигает галочки ✓✓.
  z.object({ kind: z.literal('read'), ts: z.number().int() }),
  // Печатает. Эфемерно, в историю не пишется.
  z.object({ kind: z.literal('typing'), ts: z.number().int() }),
])
export type SecretFrame = z.infer<typeof SecretFrameSchema>
