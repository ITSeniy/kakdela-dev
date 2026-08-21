import { randomBytes } from 'node:crypto'

import { isNotNull } from 'drizzle-orm'
import { type AnyPgColumn, customType, pgTable, pgEnum, uuid, text, timestamp, index, uniqueIndex, integer, bigint, boolean, jsonb, primaryKey } from 'drizzle-orm/pg-core'

function uuidv7(): string {
  const ms = Date.now()
  const buf = randomBytes(16)
  buf.writeUIntBE(ms, 0, 6)
  buf[6] = (buf[6]! & 0x0f) | 0x70
  buf[8] = (buf[8]! & 0x3f) | 0x80
  const h = buf.toString('hex')
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`
}

export const userStatusEnum = pgEnum('user_status', ['online', 'idle', 'dnd', 'offline'])
export const memberRoleEnum = pgEnum('member_role', ['owner', 'admin', 'member'])
export const channelKindEnum = pgEnum('channel_kind', ['text', 'voice', 'dm'])
export const fileStatusEnum = pgEnum('file_status', ['pending', 'ready', 'failed'])
export const mentionTypeEnum = pgEnum('mention_type', ['user', 'everyone', 'here'])
export const auditActionEnum = pgEnum('audit_action', [
  'channel.create', 'channel.update', 'channel.delete',
  'member.promote', 'member.demote', 'member.kick', 'member.role.set',
  'invite.create',  'invite.revoke',
  'emoji.create',   'emoji.delete',
  'role.create',    'role.update',    'role.delete',
  'server.update',  'server.transfer',
])
export const auditTargetTypeEnum = pgEnum('audit_target_type', [
  'channel', 'user', 'invite', 'emoji', 'role', 'server',
])

export const users = pgTable('users', {
  id:           uuid('id').primaryKey().defaultRandom(),
  username:     text('username').notNull().unique(),
  displayName:  text('display_name').notNull(),
  email:        text('email').notNull().unique(),
  passwordHash: text('password_hash').notNull(),
  avatarUrl:    text('avatar_url'),
  // Кастомизация профиля (T-089 + баннер): «о себе», IANA-таймзона и
  // фото-баннер вместо градиента в карточке профиля.
  about:        text('about'),
  timezone:     text('timezone'),
  // День рождения «MM-DD» (год не храним): системное поздравление в
  // default-канал + 🎂 в профиле и списке участников.
  birthday:     text('birthday'),
  bannerUrl:    text('banner_url'),
  status:       userStatusEnum('status').notNull().default('offline'),
  customStatus: text('custom_status'),
  createdAt:    timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  lastSeenAt:   timestamp('last_seen_at', { withTimezone: true }).notNull().defaultNow(),
})

export const servers = pgTable('servers', {
  id:        uuid('id').primaryKey().defaultRandom(),
  name:      text('name').notNull(),
  iconUrl:   text('icon_url'),
  // Баннер в шапке списка каналов (как в Discord). URL из /api/files.
  bannerUrl: text('banner_url'),
  ownerId:   uuid('owner_id'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
})

// Категории каналов — отдельная сущность, чтобы категория могла жить пустой
// (channels.category хранит имя как метку; consistency держат роуты).
export const channelCategories = pgTable(
  'channel_categories',
  {
    id:        uuid('id').primaryKey().defaultRandom(),
    serverId:  uuid('server_id').notNull().references(() => servers.id, { onDelete: 'cascade' }),
    name:      text('name').notNull(),
    position:  integer('position').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    serverIdIdx:    index('channel_categories_server_id_idx').on(t.serverId),
    serverNameUniq: uniqueIndex('channel_categories_server_name_unique_idx').on(t.serverId, t.name),
  }),
)

export const channels = pgTable('channels', {
  id:               uuid('id').primaryKey().defaultRandom(),
  serverId:         uuid('server_id').references(() => servers.id, { onDelete: 'cascade' }),
  name:             text('name').notNull(),
  kind:             channelKindEnum('kind').notNull().default('text'),
  category:         text('category'),
  topic:            text('topic'),
  position:         integer('position').notNull().default(0),
  // Threads (T-080): тред — это просто канал с указанием родителя. parent_channel_id
  // каскадно удаляется (нет смысла в висящих тредах), parent_message_id обнуляется
  // при soft/hard delete сообщения (тред отвязывается, но остаётся доступным).
  parentChannelId:  uuid('parent_channel_id').references((): AnyPgColumn => channels.id, { onDelete: 'cascade' }),
  parentMessageId:  uuid('parent_message_id').references((): AnyPgColumn => messages.id, { onDelete: 'set null' }),
  archivedAt:       timestamp('archived_at', { withTimezone: true }),
  // Настройки канала (эталон «настройки канала · обзор»):
  slowModeSec:      integer('slow_mode_sec').notNull().default(0),       // 0 = выкл
  autoDeleteSec:    integer('auto_delete_sec'),                           // null = выкл
  isDefault:        boolean('is_default').notNull().default(false),       // новички попадают сюда
  friendsOnly:      boolean('friends_only').notNull().default(false),     // недоступен по инвайту «друг» (флаг)
  nsfw:             boolean('nsfw').notNull().default(false),             // блюрить медиа
  threadsAllowed:   boolean('threads_allowed').notNull().default(true),   // можно отвечать веткой
  createdAt:        timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
},
(t) => ({
  serverIdIdx:        index('channels_server_id_idx').on(t.serverId),
  parentMessageIdx:   index('channels_parent_message_id_idx').on(t.parentMessageId),
  parentChannelIdx:   index('channels_parent_channel_archived_idx').on(t.parentChannelId, t.archivedAt),
}))

export const dmChannels = pgTable(
  'dm_channels',
  {
    channelId:  uuid('channel_id').primaryKey().references(() => channels.id, { onDelete: 'cascade' }),
    // Канонический порядок (userA < userB) гарантирует, что для любой пары
    // существует ровно одна запись — упрощает идемпотентный POST /dm/with.
    userAId:    uuid('user_a_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    userBId:    uuid('user_b_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    lastReadA:  uuid('last_read_a'),
    lastReadB:  uuid('last_read_b'),
    // «Закрытая» переписка скрыта из списка у этого участника до следующего
    // сообщения (как в Discord). Per-user, чтобы не влиять на собеседника.
    hiddenA:    boolean('hidden_a').notNull().default(false),
    hiddenB:    boolean('hidden_b').notNull().default(false),
    createdAt:  timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    pairUnique: uniqueIndex('dm_channels_pair_unique_idx').on(t.userAId, t.userBId),
    userAIdx:   index('dm_channels_user_a_idx').on(t.userAId),
    userBIdx:   index('dm_channels_user_b_idx').on(t.userBId),
  }),
)

export const serverMembers = pgTable(
  'server_members',
  {
    serverId: uuid('server_id').notNull().references(() => servers.id, { onDelete: 'cascade' }),
    userId:   uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    role:     memberRoleEnum('role').notNull().default('member'),
    // Серверный профиль (как в Discord): per-server ник и аватар поверх
    // глобальных. null = используется глобальное значение из users.
    nickname:  text('nickname'),
    avatarUrl: text('avatar_url'),
    joinedAt: timestamp('joined_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    pk:          primaryKey({ columns: [t.serverId, t.userId] }),
    serverIdIdx: index('server_members_server_id_idx').on(t.serverId),
    userIdIdx:   index('server_members_user_id_idx').on(t.userId),
  }),
)

// Прочитанность серверных каналов (per-user). lastReadAt — момент последнего
// прочтения; непрочитанное = есть чужие сообщения новее этого (или новее
// joinedAt, если записи нет). Личка использует свой lastReadA/B в dm_channels.
export const channelReads = pgTable(
  'channel_reads',
  {
    userId:     uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    channelId:  uuid('channel_id').notNull().references(() => channels.id, { onDelete: 'cascade' }),
    lastReadAt: timestamp('last_read_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    pk:      primaryKey({ columns: [t.userId, t.channelId] }),
    userIdx: index('channel_reads_user_idx').on(t.userId),
  }),
)

// Кастомные роли сервера с битовой маской разрешений (система ролей).
// @everyone — базовая роль (is_everyone=true), создаётся на каждый сервер,
// position=0, не удаляется. Остальные роли позиционируются выше (иерархия).
export const serverRoles = pgTable(
  'server_roles',
  {
    id:          uuid('id').primaryKey().defaultRandom(),
    serverId:    uuid('server_id').notNull().references(() => servers.id, { onDelete: 'cascade' }),
    name:        text('name').notNull(),
    color:       text('color'),                                            // #rrggbb или null
    permissions: bigint('permissions', { mode: 'number' }).notNull().default(0),
    position:    integer('position').notNull().default(0),
    hoist:       boolean('hoist').notNull().default(false),
    mentionable: boolean('mentionable').notNull().default(false),
    isEveryone:  boolean('is_everyone').notNull().default(false),
    createdAt:   timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    serverIdIdx: index('server_roles_server_id_idx').on(t.serverId),
  }),
)

// Назначения ролей участникам (многие-ко-многим). @everyone не хранится здесь —
// она применяется ко всем неявно.
export const memberRoles = pgTable(
  'member_roles',
  {
    serverId:   uuid('server_id').notNull().references(() => servers.id, { onDelete: 'cascade' }),
    userId:     uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    roleId:     uuid('role_id').notNull().references(() => serverRoles.id, { onDelete: 'cascade' }),
    assignedAt: timestamp('assigned_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    pk:              primaryKey({ columns: [t.roleId, t.userId] }),
    serverUserIdx:   index('member_roles_server_user_idx').on(t.serverId, t.userId),
  }),
)

export const invites = pgTable(
  'invites',
  {
    code:      text('code').primaryKey(),
    serverId:  uuid('server_id').notNull().references(() => servers.id, { onDelete: 'cascade' }),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    maxUses:   integer('max_uses'),
    useCount:  integer('use_count').notNull().default(0),
    revoked:   boolean('revoked').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    serverIdIdx: index('invites_server_id_idx').on(t.serverId),
  }),
)

export const messages = pgTable(
  'messages',
  {
    id:          uuid('id').primaryKey().$defaultFn(uuidv7),
    channelId:   uuid('channel_id').notNull().references(() => channels.id, { onDelete: 'cascade' }),
    authorId:    uuid('author_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    content:     text('content').notNull(),
    replyToId:   uuid('reply_to_id').references((): AnyPgColumn => messages.id, { onDelete: 'set null' }),
    clientNonce: text('client_nonce'),
    createdAt:   timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    editedAt:    timestamp('edited_at', { withTimezone: true }),
    deletedAt:   timestamp('deleted_at', { withTimezone: true }),
    // Закрепление: pinnedAt null = не закреплено; pinnedBy — кто закрепил.
    pinnedAt:    timestamp('pinned_at', { withTimezone: true }),
    pinnedBy:    uuid('pinned_by').references(() => users.id, { onDelete: 'set null' }),
    // Пересыл: денормализованный снимок оригинала (ForwardedRef), null = не пересыл.
    forwardedFrom: jsonb('forwarded_from'),
    // OG-превью ссылок (LinkPreview[]); снимаются асинхронно после отправки.
    // null = ещё не обрабатывалось; [] = ссылок без превью / превью нет.
    linkPreviews: jsonb('link_previews'),
    // Системное событие (SystemEvent), напр. итог DM-звонка (T-087). null —
    // обычное сообщение. Рендерится отдельной строкой, не «пузырём».
    system: jsonb('system'),
    // GIF-вложение (GifEmbed): {gifUrl, mp4Url, previewUrl, width, height}.
    // null — обычное сообщение. Хранится структурно, чтобы рендерить <video>.
    gif: jsonb('gif'),
    // Стикер-вложение (StickerRef-снимок): {stickerId, name, imageUrl, w, h,
    // source}. source различает кастомный стикер сервера и стикер Klipy.
    sticker: jsonb('sticker'),
    // Клип Klipy (ClipEmbed-снимок): {mp4Url, gifUrl, previewUrl, w, h, title}.
    // null — обычное сообщение. Видео СО звуком (в отличие от gif).
    clip: jsonb('clip'),
    // Опрос (PollDefinition): {question, options: string[]}. null — обычное
    // сообщение. Голоса — в poll_votes; счётчики собираются на чтении.
    poll: jsonb('poll'),
    // Встреча (EventDefinition): {title, startsAt, place}. null — обычное
    // сообщение. RSVP — в event_rsvps; списки собираются на чтении.
    event: jsonb('event'),
  },
  (t) => ({
    channelIdIdx:      index('messages_channel_id_id_idx').on(t.channelId, t.id),
    clientNonceUnique: uniqueIndex('messages_author_nonce_unique_idx')
      .on(t.authorId, t.clientNonce)
      .where(isNotNull(t.clientNonce)),
  }),
)

export const reactions = pgTable(
  'reactions',
  {
    messageId: uuid('message_id').notNull().references(() => messages.id, { onDelete: 'cascade' }),
    userId:    uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    emoji:     text('emoji').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    pk:       primaryKey({ columns: [t.messageId, t.userId, t.emoji] }),
    msgIdIdx: index('reactions_message_id_idx').on(t.messageId),
  }),
)

// RSVP на встречах: один ответ на юзера («пойду» going=true / «не пойду»
// false). Повторный ответ переносит (upsert), null в API снимает (delete).
export const eventRsvps = pgTable(
  'event_rsvps',
  {
    messageId: uuid('message_id').notNull().references(() => messages.id, { onDelete: 'cascade' }),
    userId:    uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    going:     boolean('going').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    pk:       primaryKey({ columns: [t.messageId, t.userId] }),
    msgIdIdx: index('event_rsvps_message_id_idx').on(t.messageId),
  }),
)

// Голоса в опросах: один голос на юзера в сообщении (single-choice, как в
// Telegram). Повторный голос переносит выбор (upsert), клик по своему
// варианту снимает голос (delete).
export const pollVotes = pgTable(
  'poll_votes',
  {
    messageId: uuid('message_id').notNull().references(() => messages.id, { onDelete: 'cascade' }),
    userId:    uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    option:    integer('option').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    pk:       primaryKey({ columns: [t.messageId, t.userId] }),
    msgIdIdx: index('poll_votes_message_id_idx').on(t.messageId),
  }),
)

export const files = pgTable(
  'files',
  {
    id:           uuid('id').primaryKey().$defaultFn(uuidv7),
    ownerId:      uuid('owner_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    messageId:    uuid('message_id').references((): AnyPgColumn => messages.id, { onDelete: 'cascade' }),
    key:          text('key').notNull(),
    // S3-ключ миниатюры (webp ≤480px), генерируется на finalize для картинок.
    thumbKey:     text('thumb_key'),
    originalName: text('original_name').notNull(),
    contentType:  text('content_type').notNull(),
    sizeBytes:    integer('size_bytes').notNull(),
    width:        integer('width'),
    height:       integer('height'),
    status:       fileStatusEnum('status').notNull().default('pending'),
    // Спойлер: вложение скрыто блюром до клика (помечается при отправке).
    spoiler:      boolean('spoiler').notNull().default(false),
    // Голосовое сообщение (T-104): клиент рендерит компактный плеер.
    voice:        boolean('voice').notNull().default(false),
    // Кружок (T-105): видео с фронталки, круглый inline-плеер.
    circle:       boolean('circle').notNull().default(false),
    // Длительность записи в секундах — замер клиента (webm из MediaRecorder
    // не содержит duration в метаданных).
    durationSec:  integer('duration_sec'),
    createdAt:    timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    ownerIdIdx:   index('files_owner_id_idx').on(t.ownerId),
    messageIdIdx: index('files_message_id_idx').on(t.messageId),
  }),
)

export const mentions = pgTable(
  'mentions',
  {
    id:              uuid('id').primaryKey().defaultRandom(),
    messageId:       uuid('message_id').notNull().references(() => messages.id, { onDelete: 'cascade' }),
    mentionedUserId: uuid('mentioned_user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    mentionType:     mentionTypeEnum('mention_type').notNull().default('user'),
    createdAt:       timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    readAt:          timestamp('read_at', { withTimezone: true }),
  },
  (t) => ({
    pairUnique:    uniqueIndex('mentions_message_user_unique_idx').on(t.messageId, t.mentionedUserId),
    userInboxIdx:  index('mentions_user_unread_idx').on(t.mentionedUserId, t.readAt),
  }),
)

export const auditLog = pgTable(
  'audit_log',
  {
    id:         uuid('id').primaryKey().defaultRandom(),
    serverId:   uuid('server_id').notNull().references(() => servers.id, { onDelete: 'cascade' }),
    // Actor может оказаться null если пользователь удалил аккаунт после действия —
    // запись остаётся, видна как «<удалённый>».
    actorId:    uuid('actor_id').references(() => users.id, { onDelete: 'set null' }),
    action:     auditActionEnum('action').notNull(),
    targetType: auditTargetTypeEnum('target_type').notNull(),
    // Цель тоже nullable: при delete мы сохраняем имя в metadata, а сам
    // объект уже мог быть удалён каскадом.
    targetId:   uuid('target_id'),
    metadata:   jsonb('metadata').$type<Record<string, unknown>>(),
    createdAt:  timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    // Главный индекс для пагинации: WHERE server = ? ORDER BY created_at DESC.
    serverCreatedIdx: index('audit_log_server_created_idx').on(t.serverId, t.createdAt),
  }),
)

export const emoji = pgTable(
  'emoji',
  {
    id:         uuid('id').primaryKey().defaultRandom(),
    serverId:   uuid('server_id').notNull().references(() => servers.id, { onDelete: 'cascade' }),
    name:       text('name').notNull(),
    imageUrl:   text('image_url').notNull(),
    storageKey: text('storage_key').notNull(),
    animated:   boolean('animated').notNull().default(false),
    uploadedBy: uuid('uploaded_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt:  timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    serverIdIdx:    index('emoji_server_id_idx').on(t.serverId),
    serverNameUniq: uniqueIndex('emoji_server_name_unique_idx').on(t.serverId, t.name),
  }),
)

// Стикеры сервера — крупнее эмодзи, отправляются отдельным сообщением (снимок
// StickerRef). Управление под правом MANAGE_EMOJI (общее «оформление сервера»).
export const stickers = pgTable(
  'stickers',
  {
    id:         uuid('id').primaryKey().defaultRandom(),
    serverId:   uuid('server_id').notNull().references(() => servers.id, { onDelete: 'cascade' }),
    name:       text('name').notNull(),
    imageUrl:   text('image_url').notNull(),
    storageKey: text('storage_key').notNull(),
    animated:   boolean('animated').notNull().default(false),
    width:      integer('width').notNull().default(0),
    height:     integer('height').notNull().default(0),
    uploadedBy: uuid('uploaded_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt:  timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    serverIdIdx: index('stickers_server_id_idx').on(t.serverId),
  }),
)

// Избранное пользователя — единая таблица для гифок, стикеров и эмодзи. kind
// различает тип, ref_key — ключ дедупа в рамках (user, kind), payload — данные
// для рендера/отправки (jsonb-снимок).
export const favoriteKindEnum = pgEnum('favorite_kind', ['gif', 'sticker', 'emoji'])

export const favorites = pgTable(
  'favorites',
  {
    id:        uuid('id').primaryKey().$defaultFn(uuidv7),
    userId:    uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    kind:      favoriteKindEnum('kind').notNull(),
    refKey:    text('ref_key').notNull(),
    payload:   jsonb('payload').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    userKindCreatedIdx: index('favorites_user_kind_created_idx').on(t.userId, t.kind, t.createdAt),
    userKindRefUnique:  uniqueIndex('favorites_user_kind_ref_unique_idx').on(t.userId, t.kind, t.refKey),
  }),
)

export const sessions = pgTable(
  'sessions',
  {
    id:                uuid('id').primaryKey().defaultRandom(),
    userId:            uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    refreshTokenHash:  text('refresh_token_hash').notNull().unique(),
    userAgent:         text('user_agent'),
    ipAddress:         text('ip_address'),
    createdAt:         timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    lastUsedAt:        timestamp('last_used_at', { withTimezone: true }).notNull().defaultNow(),
    expiresAt:         timestamp('expires_at', { withTimezone: true }).notNull(),
  },
  (t) => ({
    userIdIdx: index('sessions_user_id_idx').on(t.userId),
  }),
)

// ───── Secret chats (Фаза 6) ─────
// Сервер хранит ТОЛЬКО публичные ключи и непрозрачный шифртекст — расшифровать
// он не может ничего. Слепой каталог prekey'ев (T-101) + слепой релей (T-102).
// Секретные чаты device-bound: расшифрованная история живёт на устройстве,
// не здесь.

// bytea-колонка для шифртекста (drizzle pg-core не отдаёт bytea «из коробки»).
const bytea = customType<{ data: Buffer; driver: Buffer }>({
  dataType() {
    return 'bytea'
  },
})

// Тип конверта = тип ciphertext'а libsignal: 'prekey' (PreKeySignalMessage —
// первое сообщение сессии) или 'message' (обычный SignalMessage). Прикладные
// read/typing зашифрованы ВНУТРИ конверта и серверу не видны (иначе утечка
// метаданных о характере сообщений).
export const secretMsgTypeEnum = pgEnum('secret_msg_type', ['prekey', 'message'])

// Identity-ключ + текущий signed prekey устройства (один на пользователя).
// libsignal v0.96.4 — это PQXDH: помимо EC signed prekey бандл ОБЯЗАН содержать
// подписанный Kyber1024 prekey (last-resort, один на пользователя). Все ключи —
// ТОЛЬКО публичные (слепой каталог).
export const secretIdentities = pgTable('secret_identities', {
  userId:          uuid('user_id').primaryKey().references(() => users.id, { onDelete: 'cascade' }),
  identityKey:     text('identity_key').notNull(),          // base64 публичного ключа
  registrationId:  integer('registration_id').notNull(),
  signedPreKeyId:  integer('signed_pre_key_id').notNull(),
  signedPreKey:    text('signed_pre_key').notNull(),        // base64
  signedPreKeySig: text('signed_pre_key_sig').notNull(),    // base64 подпись identity-ключом
  kyberPreKeyId:   integer('kyber_pre_key_id').notNull(),
  kyberPreKey:     text('kyber_pre_key').notNull(),         // base64 публичного Kyber1024
  kyberPreKeySig:  text('kyber_pre_key_sig').notNull(),     // base64 подпись identity-ключом
  updatedAt:       timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
})

// Одноразовые prekey'и: выдаются по одному и помечаются consumed при выдаче.
export const secretOneTimePrekeys = pgTable(
  'secret_one_time_prekeys',
  {
    userId:     uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    keyId:      integer('key_id').notNull(),
    pubKey:     text('pub_key').notNull(),                  // base64
    consumedAt: timestamp('consumed_at', { withTimezone: true }),
    createdAt:  timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    pk:           primaryKey({ columns: [t.userId, t.keyId] }),
    // Выборка следующего неиспользованного ключа адресата.
    availableIdx: index('secret_one_time_prekeys_available_idx').on(t.userId, t.consumedAt),
  }),
)

// Очередь шифр-конвертов (store-and-forward). Удаляются после ack получателем;
// retention-sweeper добивает недоставленные. Колонки content/text НЕТ — только
// непрозрачный blob, чтобы его нельзя было случайно проиндексировать поиском.
export const secretEnvelopes = pgTable(
  'secret_envelopes',
  {
    id:         uuid('id').primaryKey().$defaultFn(uuidv7),
    fromUserId: uuid('from_user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    toUserId:   uuid('to_user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    ciphertext: bytea('ciphertext').notNull(),
    msgType:    secretMsgTypeEnum('msg_type').notNull(),
    createdAt:  timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    // Инбокс получателя в порядке поступления (uuidv7 ~ время).
    inboxIdx: index('secret_envelopes_to_user_id_idx').on(t.toUserId, t.id),
  }),
)
