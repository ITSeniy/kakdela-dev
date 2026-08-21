import { and, desc, eq, inArray, isNotNull, isNull, lt, sql } from 'drizzle-orm'
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod'
import { z } from 'zod'

import {
  EditMessageRequestSchema,
  ErrorBodySchema,
  ForwardMessageRequestSchema,
  MessageSchema,
  MessagesPageSchema,
  PinnedMessagesResponseSchema,
  SendMessageRequestSchema,
  type Attachment,
  type ClipEmbed,
  type EventDefinition,
  type EventView,
  type ForwardedRef,
  type GifEmbed,
  type PollDefinition,
  type PollView,
  type StickerRef,
  type LinkPreview,
  type ReactionAggregate,
  type ReplyRef,
  type SystemEvent,
  type ThreadInfo,
} from '@kakdela/ginzu/api-types'
import { hasPermission } from '@kakdela/ginzu/permissions'

import { channels, dmChannels, eventRsvps, memberRoles, mentions as mentionsTable, messages, pollVotes, reactions as reactionsTable, serverMembers, serverRoles, users } from '../db/schema.js'
import { db } from '../lib/db.js'
import { env } from '../env.js'
import { resolvePreviewsForContent } from '../lib/link-preview.js'
import { extractMentions, type MentionCandidate, type ParsedMention, type RoleCandidate } from '../lib/mention-extractor.js'
import { purgeAttachmentsForMessages } from '../lib/media-gc.js'
import { assertCanAccessChannel, assertPermission, getMemberPermissions, notFound } from '../lib/permissions.js'
import { redis } from '../lib/redis.js'
import { presence } from '../presence/store.js'
import { attachFilesToMessage, loadAttachmentsForMessages } from './files.js'
import { broadcastToChannel, broadcastToUser } from '../ws/broadcast.js'

const EDIT_WINDOW_MS = 30 * 24 * 60 * 60 * 1000

const MSG_COLS = {
  id:            messages.id,
  channelId:     messages.channelId,
  authorId:      messages.authorId,
  content:       messages.content,
  replyToId:     messages.replyToId,
  clientNonce:   messages.clientNonce,
  createdAt:     messages.createdAt,
  editedAt:      messages.editedAt,
  pinnedAt:      messages.pinnedAt,
  forwardedFrom: messages.forwardedFrom,
  linkPreviews:  messages.linkPreviews,
  system:        messages.system,
  gif:           messages.gif,
  sticker:       messages.sticker,
  clip:          messages.clip,
  poll:          messages.poll,
  event:         messages.event,
}

async function resolveReplies(ids: string[]): Promise<Map<string, ReplyRef>> {
  const map = new Map<string, ReplyRef>()
  if (ids.length === 0) return map
  const rows = await db
    .select({
      id:          messages.id,
      // Серверный ник автора поверх глобального имени (в DM join пустой).
      displayName: sql<string>`COALESCE(${serverMembers.nickname}, ${users.displayName})`,
      content:     messages.content,
      deletedAt:   messages.deletedAt,
    })
    .from(messages)
    .innerJoin(users, eq(messages.authorId, users.id))
    .leftJoin(channels, eq(messages.channelId, channels.id))
    .leftJoin(serverMembers, and(
      eq(serverMembers.serverId, channels.serverId),
      eq(serverMembers.userId, messages.authorId),
    ))
    .where(inArray(messages.id, ids))
  for (const r of rows) {
    map.set(r.id, r.deletedAt !== null
      ? { id: r.id, deleted: true }
      : { id: r.id, deleted: false, authorName: r.displayName, content: r.content },
    )
  }
  return map
}

interface MentionContext {
  candidates: MentionCandidate[]
  allowBroadcast: boolean
  onlineIds: string[]
  /** Роли сервера для `@роль` (пусто в DM). */
  roleCandidates: RoleCandidate[]
  /** serverId для разворота ролей в участников (null в DM). */
  serverId: string | null
}

/**
 * Разворачивает упомянутые роли в участников сервера (для fan-out) и сливает с
 * прямыми упоминаниями. Носители ролей получают обычное user-упоминание.
 */
async function resolveMentions(
  text: string,
  authorId: string,
  ctx: MentionContext,
): Promise<ParsedMention[]> {
  const { users, roleIds } = extractMentions({
    text,
    authorId,
    candidates:     ctx.candidates,
    allowBroadcast: ctx.allowBroadcast,
    onlineIds:      ctx.onlineIds,
    roleCandidates: ctx.roleCandidates,
  })
  if (roleIds.length === 0 || !ctx.serverId) return users

  const memberRows = await db
    .select({ userId: memberRoles.userId })
    .from(memberRoles)
    .where(and(eq(memberRoles.serverId, ctx.serverId), inArray(memberRoles.roleId, roleIds)))

  const byUser = new Map(users.map((u) => [u.userId, u.type]))
  for (const r of memberRows) {
    if (r.userId === authorId) continue
    if (!byUser.has(r.userId)) byUser.set(r.userId, 'user')
  }
  return Array.from(byUser, ([userId, type]) => ({ userId, type }))
}

/**
 * Собирает контекст для `extractMentions`: кто может быть упомянут (server
 * members / DM-участники), разрешён ли @everyone / @here (только owner/admin
 * сервера), и кто сейчас онлайн (для @here).
 */
async function buildMentionContext(
  authorId: string,
  channelId: string,
): Promise<MentionContext> {
  const chRows = await db
    .select({ serverId: channels.serverId, kind: channels.kind })
    .from(channels)
    .where(eq(channels.id, channelId))
    .limit(1)
  const ch = chRows[0]
  const empty: MentionContext = { candidates: [], allowBroadcast: false, onlineIds: [], roleCandidates: [], serverId: null }
  if (!ch) return empty

  if (ch.kind === 'dm') {
    const dmRows = await db
      .select({ userAId: dmChannels.userAId, userBId: dmChannels.userBId })
      .from(dmChannels)
      .where(eq(dmChannels.channelId, channelId))
      .limit(1)
    const dm = dmRows[0]
    if (!dm) return empty
    const ids = [dm.userAId, dm.userBId]
    const userRows = await db
      .select({ id: users.id, displayName: users.displayName, username: users.username })
      .from(users)
      .where(inArray(users.id, ids))
    return { candidates: userRows, allowBroadcast: false, onlineIds: [], roleCandidates: [], serverId: null }
  }

  // server channel
  if (!ch.serverId) return empty
  const memberRows = await db
    .select({
      id:          users.id,
      displayName: users.displayName,
      username:    users.username,
      nickname:    serverMembers.nickname,
      role:        serverMembers.role,
    })
    .from(serverMembers)
    .innerJoin(users, eq(serverMembers.userId, users.id))
    .where(eq(serverMembers.serverId, ch.serverId))

  // @everyone / @here разрешены при праве MENTION_EVERYONE (owner/admin его
  // имеют через ADMINISTRATOR).
  let allowBroadcast = false
  if (ch.serverId) {
    try {
      const ctx = await getMemberPermissions(authorId, ch.serverId)
      allowBroadcast = hasPermission(ctx.permissions, 'MENTION_EVERYONE')
    } catch { allowBroadcast = false }
  }

  const presenceMap = await presence.getStatusBulk(memberRows.map((m) => m.id))
  const onlineIds = memberRows
    .filter((m) => {
      const p = presenceMap.get(m.id)?.status ?? 'offline'
      return p === 'online' || p === 'idle' || p === 'dnd'
    })
    .map((m) => m.id)

  // Роли сервера (кроме @everyone) для резолва `@роль`.
  const roleRows = await db
    .select({ id: serverRoles.id, name: serverRoles.name, mentionable: serverRoles.mentionable })
    .from(serverRoles)
    .where(and(eq(serverRoles.serverId, ch.serverId), eq(serverRoles.isEveryone, false)))

  return {
    // displayName кандидата — эффективное имя (серверный ник поверх
    // глобального): в чате все видят и пишут `@ник`, он и должен резолвиться.
    candidates: memberRows.map((m) => ({ id: m.id, displayName: m.nickname ?? m.displayName, username: m.username })),
    allowBroadcast,
    onlineIds,
    roleCandidates: roleRows,
    serverId: ch.serverId,
  }
}

async function persistMentions(opts: {
  messageId: string
  channelId: string
  parsed: ParsedMention[]
}): Promise<void> {
  if (opts.parsed.length === 0) return
  const rows = opts.parsed.map((m) => ({
    messageId:       opts.messageId,
    mentionedUserId: m.userId,
    mentionType:     m.type,
  }))
  // ON CONFLICT DO NOTHING для пары (messageId, mentionedUserId) — на случай
  // повторного запуска POST/edit-flow с теми же данными.
  await db.insert(mentionsTable).values(rows).onConflictDoNothing()
  for (const m of opts.parsed) {
    void broadcastToUser(m.userId, {
      t: 'mention',
      messageId: opts.messageId,
      channelId: opts.channelId,
      mentionedUserId: m.userId,
      mentionType: m.type,
    })
  }
}

interface MsgRow {
  id: string
  channelId: string
  authorId: string
  content: string
  replyToId: string | null
  clientNonce: string | null
  createdAt: Date
  editedAt: Date | null
  pinnedAt: Date | null
  forwardedFrom: unknown
  linkPreviews: unknown
  system: unknown
  gif: unknown
  sticker: unknown
  clip: unknown
  poll: unknown
  event: unknown
}

function serializeMessage(
  row: MsgRow,
  reactions: ReactionAggregate[] = [],
  replyTo: ReplyRef | null = null,
  attachments: Attachment[] = [],
  thread: ThreadInfo | null = null,
  poll: PollView | null = null,
  event: EventView | null = null,
) {
  return {
    id:        row.id,
    channelId: row.channelId,
    authorId:  row.authorId,
    content:   row.content,
    replyToId: row.replyToId ?? null,
    replyTo,
    // Нужен клиенту, чтобы схлопнуть pending-дубль (WS msg.new vs REST-ответ).
    clientNonce: row.clientNonce ?? null,
    createdAt: row.createdAt.toISOString(),
    editedAt:  row.editedAt?.toISOString() ?? null,
    reactions,
    attachments,
    thread,
    pinned:    row.pinnedAt !== null,
    pinnedAt:  row.pinnedAt?.toISOString() ?? null,
    // jsonb-снимок уже в форме ForwardedRef (строковые даты внутри).
    forwarded: (row.forwardedFrom as ForwardedRef | null) ?? null,
    // null (ещё не обрабатывалось) и [] (превью нет) для клиента эквивалентны.
    linkPreviews: (row.linkPreviews as LinkPreview[] | null) ?? [],
    // Системное событие (call-log); null для обычных сообщений.
    system: (row.system as SystemEvent | null) ?? null,
    // GIF-вложение (jsonb-снимок в форме GifEmbed); null — обычное сообщение.
    gif: (row.gif as GifEmbed | null) ?? null,
    // Стикер (jsonb-снимок StickerRef); null — обычное сообщение.
    sticker: (row.sticker as StickerRef | null) ?? null,
    // Клип Klipy (jsonb-снимок ClipEmbed); null — обычное сообщение.
    clip: (row.clip as ClipEmbed | null) ?? null,
    // Опрос: собранный PollView (гидрация в loadPollsForMessages).
    poll,
    // Встреча: собранный EventView (гидрация в loadEventsForMessages).
    event,
  }
}

/**
 * Асинхронно снимает OG-превью для ссылок из сообщения и, если что-то нашлось
 * (или нужно очистить после правки), сохраняет снимок в колонку и шлёт WS
 * msg.embeds. Fire-and-forget: не блокирует ответ на отправку/правку и сам
 * проглатывает ошибки (сеть/SSRF). clearIfEmpty=true (для edit) затирает старые
 * превью, если в новом тексте ссылок не осталось.
 */
async function resolveAndBroadcastPreviews(
  messageId: string,
  channelId: string,
  content: string,
  clearIfEmpty: boolean,
): Promise<void> {
  if (!env.LINK_PREVIEWS_ENABLED) return
  try {
    const previews = await resolvePreviewsForContent(content)
    if (previews.length === 0 && !clearIfEmpty) return

    const updated = await db
      .update(messages)
      .set({ linkPreviews: previews })
      .where(and(eq(messages.id, messageId), isNull(messages.deletedAt)))
      .returning({ id: messages.id })
    if (updated.length === 0) return // сообщение удалили, пока тянули превью

    void broadcastToChannel(channelId, { t: 'msg.embeds', channelId, messageId, linkPreviews: previews })
  } catch {
    /* превью — лучшее-усилие, тишина при сбое */
  }
}

/**
 * Собирает PollView для сообщений-опросов: счётчики по вариантам одним
 * GROUP BY + голос смотрящего вторым запросом (viewerId null — myVote null).
 */
async function loadPollsForMessages(
  rows: MsgRow[],
  viewerId: string | null,
): Promise<Map<string, PollView>> {
  const out = new Map<string, PollView>()
  const pollRows = rows.filter((r) => r.poll != null)
  if (pollRows.length === 0) return out
  const pollIds = pollRows.map((r) => r.id)

  const countRows = await db
    .select({
      messageId: pollVotes.messageId,
      option:    pollVotes.option,
      count:     sql<number>`count(*)::int`,
    })
    .from(pollVotes)
    .where(inArray(pollVotes.messageId, pollIds))
    .groupBy(pollVotes.messageId, pollVotes.option)
  const countsByMsg = new Map<string, Map<number, number>>()
  for (const r of countRows) {
    const m = countsByMsg.get(r.messageId) ?? new Map<number, number>()
    m.set(r.option, r.count)
    countsByMsg.set(r.messageId, m)
  }

  const myVoteByMsg = new Map<string, number>()
  if (viewerId) {
    const mine = await db
      .select({ messageId: pollVotes.messageId, option: pollVotes.option })
      .from(pollVotes)
      .where(and(inArray(pollVotes.messageId, pollIds), eq(pollVotes.userId, viewerId)))
    for (const r of mine) myVoteByMsg.set(r.messageId, r.option)
  }

  for (const r of pollRows) {
    const def = r.poll as PollDefinition
    const counts = countsByMsg.get(r.id)
    const options = def.options.map((text, i) => ({ text, votes: counts?.get(i) ?? 0 }))
    out.set(r.id, {
      question:   def.question,
      options,
      myVote:     myVoteByMsg.get(r.id) ?? null,
      totalVotes: options.reduce((sum, o) => sum + o.votes, 0),
    })
  }
  return out
}

/**
 * Собирает EventView для сообщений-встреч: RSVP-списки одним запросом,
 * myRsvp выводится из них же (viewerId).
 */
async function loadEventsForMessages(
  rows: MsgRow[],
  viewerId: string | null,
): Promise<Map<string, EventView>> {
  const out = new Map<string, EventView>()
  const eventRows = rows.filter((r) => r.event != null)
  if (eventRows.length === 0) return out
  const ids = eventRows.map((r) => r.id)

  const rsvpRows = await db
    .select({ messageId: eventRsvps.messageId, userId: eventRsvps.userId, going: eventRsvps.going })
    .from(eventRsvps)
    .where(inArray(eventRsvps.messageId, ids))
  const byMsg = new Map<string, { going: string[]; declined: string[] }>()
  for (const r of rsvpRows) {
    const entry = byMsg.get(r.messageId) ?? { going: [], declined: [] }
    ;(r.going ? entry.going : entry.declined).push(r.userId)
    byMsg.set(r.messageId, entry)
  }

  for (const r of eventRows) {
    const def = r.event as EventDefinition
    const entry = byMsg.get(r.id) ?? { going: [], declined: [] }
    out.set(r.id, {
      title:    def.title,
      startsAt: def.startsAt,
      place:    def.place ?? null,
      going:    entry.going,
      declined: entry.declined,
      myRsvp:   viewerId === null
        ? null
        : entry.going.includes(viewerId) ? 'going'
        : entry.declined.includes(viewerId) ? 'declined'
        : null,
    })
  }
  return out
}

/**
 * Догидрирует набор строк сообщений до полных DTO: реакции, цитаты ответов,
 * вложения, тред-инфо, опросы, встречи. Общий путь для GET-странички, списка
 * пинов и одиночных операций (pin / forward). viewerId нужен опросам и
 * встречам (myVote / myRsvp).
 */
async function hydrateMessages(rows: MsgRow[], viewerId: string | null = null) {
  if (rows.length === 0) return []
  const msgIds = rows.map((r) => r.id)

  const reactionsMap = new Map<string, ReactionAggregate[]>()
  const reactRows = await db
    .select({
      messageId: reactionsTable.messageId,
      emoji:     reactionsTable.emoji,
      count:     sql<number>`count(*)::int`,
      users:     sql<string[]>`array_agg(${reactionsTable.userId}::text)`,
    })
    .from(reactionsTable)
    .where(inArray(reactionsTable.messageId, msgIds))
    .groupBy(reactionsTable.messageId, reactionsTable.emoji)
  for (const r of reactRows) {
    const list = reactionsMap.get(r.messageId) ?? []
    list.push({ emoji: r.emoji, count: r.count, users: r.users })
    reactionsMap.set(r.messageId, list)
  }

  const replyIds = [...new Set(rows.map((r) => r.replyToId).filter((id): id is string => id !== null))]
  const replyMap = await resolveReplies(replyIds)
  const attachmentsMap = await loadAttachmentsForMessages(msgIds)
  const threadMap = await loadThreadInfoForMessages(msgIds)
  const pollMap = await loadPollsForMessages(rows, viewerId)
  const eventMap = await loadEventsForMessages(rows, viewerId)

  return rows.map((r) => serializeMessage(
    r,
    reactionsMap.get(r.id) ?? [],
    r.replyToId ? (replyMap.get(r.replyToId) ?? null) : null,
    attachmentsMap.get(r.id) ?? [],
    threadMap.get(r.id) ?? null,
    pollMap.get(r.id) ?? null,
    eventMap.get(r.id) ?? null,
  ))
}

/** «#имя» для серверного канала, «личные сообщения» для DM. */
async function channelLabelFor(channelId: string): Promise<string> {
  const rows = await db
    .select({ name: channels.name, kind: channels.kind })
    .from(channels)
    .where(eq(channels.id, channelId))
    .limit(1)
  const c = rows[0]
  if (!c) return 'канал'
  return c.kind === 'dm' ? 'личные сообщения' : `#${c.name}`
}

/**
 * Для каждого сообщения в страничке смотрим, есть ли тред с
 * parent_message_id == message.id, и приклеиваем агрегат
 * (messageCount, lastMessageAt). Двумя запросами:
 *   1. channels WHERE parent_message_id IN (msgIds)
 *   2. messages WHERE channel_id IN (threadIds) GROUP BY channel_id
 */
async function loadThreadInfoForMessages(messageIds: string[]): Promise<Map<string, ThreadInfo>> {
  const out = new Map<string, ThreadInfo>()
  if (messageIds.length === 0) return out

  const threadRows = await db
    .select({
      id:              channels.id,
      name:            channels.name,
      parentMessageId: channels.parentMessageId,
      archivedAt:      channels.archivedAt,
    })
    .from(channels)
    .where(inArray(channels.parentMessageId, messageIds))
  if (threadRows.length === 0) return out

  const threadIds = threadRows.map((t) => t.id)
  const aggRows = await db
    .select({
      channelId:     messages.channelId,
      count:         sql<number>`COUNT(*)::int`,
      lastCreatedAt: sql<Date>`MAX(${messages.createdAt})`,
    })
    .from(messages)
    .where(and(inArray(messages.channelId, threadIds), isNull(messages.deletedAt)))
    .groupBy(messages.channelId)
  const aggByChannel = new Map(aggRows.map((r) => [r.channelId, r]))

  for (const t of threadRows) {
    if (!t.parentMessageId) continue
    const agg = aggByChannel.get(t.id)
    out.set(t.parentMessageId, {
      channelId:     t.id,
      name:          t.name,
      messageCount:  agg?.count ?? 0,
      lastMessageAt: agg?.lastCreatedAt ? new Date(agg.lastCreatedAt).toISOString() : null,
      archivedAt:    t.archivedAt?.toISOString() ?? null,
    })
  }
  return out
}

/**
 * Медленный режим: если у канала slowModeSec > 0 и автор — не owner/admin,
 * разрешаем не чаще раза в slowModeSec секунд (счётчик в Redis, NX+EX). При
 * срабатывании — 429 slow-mode с остатком ожидания.
 */
async function enforceSlowMode(userId: string, channelId: string, serverId: string): Promise<void> {
  const rows = await db.select({ slow: channels.slowModeSec }).from(channels).where(eq(channels.id, channelId)).limit(1)
  const slow = rows[0]?.slow ?? 0
  if (slow <= 0) return

  // Управляющие сообщениями/каналами обходят медленный режим (как в Discord).
  try {
    const ctx = await getMemberPermissions(userId, serverId)
    if (hasPermission(ctx.permissions, 'MANAGE_MESSAGES') || hasPermission(ctx.permissions, 'MANAGE_CHANNELS')) return
  } catch { /* не член — пусть обычная проверка доступа отработает выше */ }

  let allowed = false
  let ttl = slow
  try {
    const set = await redis.set(`sm:${channelId}:${userId}`, '1', 'EX', slow, 'NX')
    allowed = set !== null
    if (!allowed) {
      const t = await redis.ttl(`sm:${channelId}:${userId}`)
      if (t > 0) ttl = t
    }
  } catch {
    // Redis недоступен — не блокируем отправку (медленный режим best-effort).
    return
  }
  if (!allowed) {
    const e = new Error(`медленный режим: подождите ${ttl} с`) as Error & { statusCode: number; code: string }
    e.statusCode = 429
    e.code = 'slow-mode'
    throw e
  }
}

export const messagesRoutes: FastifyPluginAsyncZod = async (app) => {
  // ───── GET /api/channels/:channelId/messages ─────
  app.get(
    '/channels/:channelId/messages',
    {
      preHandler: app.authenticate,
      schema: {
        params: z.object({ channelId: z.string().uuid() }),
        querystring: z.object({
          before: z.string().uuid().optional(),
          limit: z.coerce.number().int().min(1).max(100).default(50),
        }),
        response: {
          200: MessagesPageSchema,
          401: ErrorBodySchema,
          403: ErrorBodySchema,
          404: ErrorBodySchema,
        },
      },
    },
    async (req, reply) => {
      const { channelId } = req.params
      const { before, limit } = req.query
      const userId = req.authUser!.id

      await assertCanAccessChannel(userId, channelId)

      const conditions = [
        eq(messages.channelId, channelId),
        isNull(messages.deletedAt),
        ...(before !== undefined ? [lt(messages.id, before)] : []),
      ]

      const rows = await db
        .select(MSG_COLS)
        .from(messages)
        .where(and(...conditions))
        .orderBy(desc(messages.id))
        .limit(limit + 1)

      const hasMore = rows.length > limit
      if (hasMore) rows.pop()

      const nextCursor = hasMore ? (rows[rows.length - 1]?.id ?? null) : null

      rows.reverse()

      return reply.code(200).send({
        messages: await hydrateMessages(rows, userId),
        nextCursor,
      })
    },
  )

  // ───── POST /api/channels/:channelId/messages ─────
  app.post(
    '/channels/:channelId/messages',
    {
      preHandler: app.authenticate,
      schema: {
        params: z.object({ channelId: z.string().uuid() }),
        body: SendMessageRequestSchema,
        response: {
          201: MessageSchema,
          401: ErrorBodySchema,
          403: ErrorBodySchema,
          404: ErrorBodySchema,
        },
      },
    },
    async (req, reply) => {
      const { channelId } = req.params
      const { content, replyToId, clientNonce, attachments: attachmentIds, spoilerAttachments, gif, sticker, clip, poll, event } = req.body
      const userId = req.authUser!.id

      const access = await assertCanAccessChannel(userId, channelId)

      // Idempotency: return existing message if same nonce+author
      if (clientNonce) {
        const existing = await db
          .select(MSG_COLS)
          .from(messages)
          .where(and(eq(messages.authorId, userId), eq(messages.clientNonce, clientNonce)))
          .limit(1)
        if (existing[0]) {
          const ex = existing[0]
          const exReplyTo = ex.replyToId
            ? (await resolveReplies([ex.replyToId])).get(ex.replyToId) ?? null
            : null
          const exAttachments = (await loadAttachmentsForMessages([ex.id])).get(ex.id) ?? []
          return reply.code(201).send(serializeMessage(ex, [], exReplyTo, exAttachments))
        }
      }

      // Медленный режим (только серверные каналы; DM не троттлим).
      if (access.kind === 'server') await enforceSlowMode(userId, channelId, access.serverId)

      const inserted = await db
        .insert(messages)
        .values({
          channelId,
          authorId: userId,
          content,
          replyToId: replyToId ?? null,
          clientNonce: clientNonce ?? null,
          gif: gif ?? null,
          sticker: sticker ?? null,
          clip: clip ?? null,
          poll: poll ?? null,
          event: event ?? null,
        })
        .returning(MSG_COLS)

      const msg = inserted[0]
      if (!msg) throw new Error('insert into messages returned no rows')

      let attachedFiles: Attachment[] = []
      if (attachmentIds && attachmentIds.length > 0) {
        attachedFiles = await attachFilesToMessage({
          fileIds:   attachmentIds,
          ownerId:   userId,
          messageId: msg.id,
          spoilerFileIds: spoilerAttachments,
        })
      }

      const mentionCtx = await buildMentionContext(userId, channelId)
      const parsedMentions = await resolveMentions(content, userId, mentionCtx)
      await persistMentions({ messageId: msg.id, channelId, parsed: parsedMentions })

      const replyToData = msg.replyToId
        ? (await resolveReplies([msg.replyToId])).get(msg.replyToId) ?? null
        : null
      // Свежий опрос — нулевые счётчики, голосов ещё нет.
      const freshPoll: PollView | null = poll
        ? {
            question:   poll.question,
            options:    poll.options.map((text) => ({ text, votes: 0 })),
            myVote:     null,
            totalVotes: 0,
          }
        : null
      // Свежая встреча — пустые RSVP-списки.
      const freshEvent: EventView | null = event
        ? {
            title:    event.title,
            startsAt: event.startsAt,
            place:    event.place ?? null,
            going:    [],
            declined: [],
            myRsvp:   null,
          }
        : null
      const serialized = serializeMessage(msg, [], replyToData, attachedFiles, null, freshPoll, freshEvent)
      void broadcastToChannel(channelId, { t: 'msg.new', channelId, message: serialized })

      // OG-превью досъезжают асинхронно (WS msg.embeds) — не держим ответ.
      void resolveAndBroadcastPreviews(msg.id, channelId, content, false)

      return reply.code(201).send(serialized)
    },
  )

  // ───── PATCH /api/messages/:id ─────
  app.patch(
    '/messages/:id',
    {
      preHandler: app.authenticate,
      schema: {
        params: z.object({ id: z.string().uuid() }),
        body: EditMessageRequestSchema,
        response: {
          200: MessageSchema,
          401: ErrorBodySchema,
          403: ErrorBodySchema,
          404: ErrorBodySchema,
        },
      },
    },
    async (req, reply) => {
      const { id } = req.params
      const { content } = req.body
      const userId = req.authUser!.id

      const rows = await db
        .select({
          ...MSG_COLS,
          deletedAt: messages.deletedAt,
        })
        .from(messages)
        .where(eq(messages.id, id))
        .limit(1)
      const msg = rows[0]
      if (!msg) throw notFound('message-not-found', 'message not found')
      if (msg.deletedAt !== null) throw notFound('message-not-found', 'message not found')

      // Проверяем доступ к каналу ДО проверки авторства: участник, выгнанный
      // из сервера (или чужак), не должен ни редактировать свои старые
      // сообщения, ни даже узнавать о существовании чужих.
      await assertCanAccessChannel(userId, msg.channelId)

      if (msg.authorId !== userId) {
        return reply.code(403).send({ error: { code: 'forbidden', message: 'only the author can edit this message' } })
      }
      if (Date.now() - msg.createdAt.getTime() > EDIT_WINDOW_MS) {
        return reply.code(403).send({ error: { code: 'edit-window-expired', message: 'edit window has closed (30 days)' } })
      }

      const updated = await db
        .update(messages)
        .set({ content, editedAt: new Date() })
        .where(eq(messages.id, id))
        .returning(MSG_COLS)

      const result = updated[0]
      if (!result) throw new Error('update messages returned no rows')

      // ── diff mentions: добавляем новые, убираем удалённые. На добавленных
      //    шлём mention WS event, чтобы у нового упомянутого появился бейдж.
      const existing = await db
        .select({ mentionedUserId: mentionsTable.mentionedUserId })
        .from(mentionsTable)
        .where(eq(mentionsTable.messageId, id))
      const existingIds = new Set(existing.map((m) => m.mentionedUserId))

      const ctx = await buildMentionContext(userId, result.channelId)
      const parsed = await resolveMentions(content, userId, ctx)
      const parsedById = new Map(parsed.map((m) => [m.userId, m.type]))

      const toAdd = parsed.filter((m) => !existingIds.has(m.userId))
      const toRemove = Array.from(existingIds).filter((uid) => !parsedById.has(uid))

      if (toRemove.length > 0) {
        await db
          .delete(mentionsTable)
          .where(and(
            eq(mentionsTable.messageId, id),
            inArray(mentionsTable.mentionedUserId, toRemove),
          ))
      }
      if (toAdd.length > 0) {
        await persistMentions({ messageId: id, channelId: result.channelId, parsed: toAdd })
      }

      const editAttachments = (await loadAttachmentsForMessages([result.id])).get(result.id) ?? []
      const serialized = serializeMessage(result, [], null, editAttachments)
      void broadcastToChannel(result.channelId, {
        t: 'msg.edit',
        channelId: result.channelId,
        messageId: result.id,
        content: result.content,
        editedAt: serialized.editedAt ?? new Date().toISOString(),
      })

      // Ссылки могли измениться — пересчитываем превью (clearIfEmpty: если в
      // новом тексте ссылок нет, затираем старую карточку).
      void resolveAndBroadcastPreviews(result.id, result.channelId, content, true)

      return reply.code(200).send(serialized)
    },
  )

  // ───── DELETE /api/messages/:id ─────
  app.delete(
    '/messages/:id',
    {
      preHandler: app.authenticate,
      schema: {
        params: z.object({ id: z.string().uuid() }),
        response: {
          204: z.null(),
          401: ErrorBodySchema,
          403: ErrorBodySchema,
          404: ErrorBodySchema,
        },
      },
    },
    async (req, reply) => {
      const { id } = req.params
      const userId = req.authUser!.id

      const rows = await db
        .select({
          authorId:  messages.authorId,
          channelId: messages.channelId,
          deletedAt: messages.deletedAt,
        })
        .from(messages)
        .where(eq(messages.id, id))
        .limit(1)
      const msg = rows[0]
      if (!msg) throw notFound('message-not-found', 'message not found')
      if (msg.deletedAt !== null) throw notFound('message-not-found', 'message not found')

      // Доступ к каналу — прежде авторства и прав: кикнутый участник не может
      // удалять даже свои сообщения из каналов сервера, который его выгнал.
      const access = await assertCanAccessChannel(userId, msg.channelId)

      const isAuthor = msg.authorId === userId

      if (!isAuthor) {
        // Admins/owners can delete any message in a server channel.
        // В DM admin'ов нет — удалять может только автор.
        if (access.kind !== 'server') {
          return reply.code(403).send({ error: { code: 'forbidden', message: 'only the author can delete this message' } })
        }
        await assertPermission(userId, access.serverId, 'MANAGE_MESSAGES')
      }

      await db
        .update(messages)
        .set({ deletedAt: new Date(), content: '' })
        .where(eq(messages.id, id))

      // Вложения удаляем из MinIO сразу (аудит M-6): soft-delete не должен
      // оставлять файл доступным по прямой ссылке. Fire-and-forget, как и
      // broadcast — ответ клиенту ждать S3 не должен.
      void purgeAttachmentsForMessages([id], req.log)

      void broadcastToChannel(msg.channelId, {
        t: 'msg.delete',
        channelId: msg.channelId,
        messageId: id,
      })

      return reply.code(204).send(null)
    },
  )

  // ───── загрузка одного сообщения с проверкой доступа (для pin/forward) ─────
  async function loadAccessibleMessage(userId: string, id: string) {
    const rows = await db
      .select({ ...MSG_COLS, deletedAt: messages.deletedAt })
      .from(messages)
      .where(eq(messages.id, id))
      .limit(1)
    const msg = rows[0]
    if (!msg || msg.deletedAt !== null) throw notFound('message-not-found', 'message not found')
    const access = await assertCanAccessChannel(userId, msg.channelId)
    return { msg, access }
  }

  // Пин/откреп требует прав: в серверном канале — owner/admin, в DM —
  // достаточно быть участником (assertCanAccessChannel уже это проверил).
  async function assertCanPin(userId: string, access: Awaited<ReturnType<typeof assertCanAccessChannel>>) {
    if (access.kind === 'server') await assertPermission(userId, access.serverId, 'MANAGE_MESSAGES')
  }

  async function setPinned(req: { params: { id: string }; authUser?: { id: string } }, pinned: boolean) {
    const { id } = req.params
    const userId = req.authUser!.id
    const { msg, access } = await loadAccessibleMessage(userId, id)
    await assertCanPin(userId, access)

    const pinnedAt = pinned ? new Date() : null
    const updated = await db
      .update(messages)
      .set({ pinnedAt, pinnedBy: pinned ? userId : null })
      .where(eq(messages.id, id))
      .returning(MSG_COLS)
    const result = updated[0]
    if (!result) throw new Error('update messages returned no rows')

    void broadcastToChannel(msg.channelId, {
      t: 'msg.pin',
      channelId: msg.channelId,
      messageId: id,
      pinned,
      pinnedAt: pinnedAt?.toISOString() ?? null,
    })
    const [serialized] = await hydrateMessages([result], req.authUser!.id)
    return serialized!
  }

  // ───── POST /api/messages/:id/pin ─────
  app.post(
    '/messages/:id/pin',
    {
      preHandler: app.authenticate,
      schema: {
        params: z.object({ id: z.string().uuid() }),
        response: { 200: MessageSchema, 401: ErrorBodySchema, 403: ErrorBodySchema, 404: ErrorBodySchema },
      },
    },
    async (req, reply) => reply.code(200).send(await setPinned(req, true)),
  )

  // ───── DELETE /api/messages/:id/pin ─────
  app.delete(
    '/messages/:id/pin',
    {
      preHandler: app.authenticate,
      schema: {
        params: z.object({ id: z.string().uuid() }),
        response: { 200: MessageSchema, 401: ErrorBodySchema, 403: ErrorBodySchema, 404: ErrorBodySchema },
      },
    },
    async (req, reply) => reply.code(200).send(await setPinned(req, false)),
  )

  // ───── GET /api/channels/:channelId/pins ─────
  app.get(
    '/channels/:channelId/pins',
    {
      preHandler: app.authenticate,
      schema: {
        params: z.object({ channelId: z.string().uuid() }),
        response: { 200: PinnedMessagesResponseSchema, 401: ErrorBodySchema, 403: ErrorBodySchema, 404: ErrorBodySchema },
      },
    },
    async (req, reply) => {
      const { channelId } = req.params
      await assertCanAccessChannel(req.authUser!.id, channelId)
      const rows = await db
        .select(MSG_COLS)
        .from(messages)
        .where(and(eq(messages.channelId, channelId), isNull(messages.deletedAt), isNotNull(messages.pinnedAt)))
        .orderBy(desc(messages.pinnedAt))
        .limit(100)
      return reply.code(200).send({ messages: await hydrateMessages(rows, req.authUser!.id) })
    },
  )

  // ───── POST /api/messages/:id/forward ─────
  app.post(
    '/messages/:id/forward',
    {
      preHandler: app.authenticate,
      schema: {
        params: z.object({ id: z.string().uuid() }),
        body: ForwardMessageRequestSchema,
        response: { 201: MessageSchema, 401: ErrorBodySchema, 403: ErrorBodySchema, 404: ErrorBodySchema },
      },
    },
    async (req, reply) => {
      const { id } = req.params
      const { toChannelId, note } = req.body
      const userId = req.authUser!.id

      // Доступ и к получателю, и к оригиналу (нельзя переслать то, что не видишь).
      await assertCanAccessChannel(userId, toChannelId)
      const { msg: orig } = await loadAccessibleMessage(userId, id)

      const authorRows = await db
        .select({ displayName: users.displayName })
        .from(users)
        .where(eq(users.id, orig.authorId))
        .limit(1)
      const origAttachments = (await loadAttachmentsForMessages([orig.id])).get(orig.id) ?? []

      const forwarded: ForwardedRef = {
        messageId:    orig.id,
        channelId:    orig.channelId,
        channelLabel: await channelLabelFor(orig.channelId),
        authorId:     orig.authorId,
        authorName:   authorRows[0]?.displayName ?? '—',
        content:      orig.content,
        createdAt:    orig.createdAt.toISOString(),
        attachments:  origAttachments,
      }

      const noteContent = (note ?? '').trim()
      const inserted = await db
        .insert(messages)
        .values({ channelId: toChannelId, authorId: userId, content: noteContent, forwardedFrom: forwarded })
        .returning(MSG_COLS)
      const msg = inserted[0]
      if (!msg) throw new Error('insert into messages returned no rows')

      // @упоминания в подписи пересыла — как в обычной отправке.
      if (noteContent) {
        const ctx = await buildMentionContext(userId, toChannelId)
        const parsed = await resolveMentions(noteContent, userId, ctx)
        await persistMentions({ messageId: msg.id, channelId: toChannelId, parsed })
      }

      const [serialized] = await hydrateMessages([msg], userId)
      void broadcastToChannel(toChannelId, { t: 'msg.new', channelId: toChannelId, message: serialized! })
      return reply.code(201).send(serialized!)
    },
  )
}
