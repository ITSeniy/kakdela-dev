import { and, eq, sql } from 'drizzle-orm'
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod'
import { z } from 'zod'

import { ErrorBodySchema, PollVoteRequestSchema, type PollDefinition } from '@kakdela/ginzu/api-types'

import { messages, pollVotes } from '../db/schema.js'
import { db } from '../lib/db.js'
import { assertCanAccessChannel, notFound } from '../lib/permissions.js'
import { broadcastToChannel } from '../ws/broadcast.js'

interface PollMessage {
  id: string
  channelId: string
  def: PollDefinition
}

/** Сообщение-опрос, доступное юзеру; 404 если нет/удалено/не опрос. */
async function loadPollMessage(userId: string, messageId: string): Promise<PollMessage> {
  const rows = await db
    .select({ channelId: messages.channelId, deletedAt: messages.deletedAt, poll: messages.poll })
    .from(messages)
    .where(eq(messages.id, messageId))
    .limit(1)
  const msg = rows[0]
  if (!msg || msg.deletedAt !== null) throw notFound('message-not-found', 'message not found')
  if (msg.poll == null) throw notFound('not-a-poll', 'message is not a poll')

  await assertCanAccessChannel(userId, msg.channelId)
  return { id: messageId, channelId: msg.channelId, def: msg.poll as PollDefinition }
}

/** Свежие счётчики по вариантам (полный пересчёт — для WS poll.vote). */
async function countVotes(messageId: string, optionCount: number): Promise<number[]> {
  const rows = await db
    .select({ option: pollVotes.option, count: sql<number>`count(*)::int` })
    .from(pollVotes)
    .where(eq(pollVotes.messageId, messageId))
    .groupBy(pollVotes.option)
  const votes = Array.from({ length: optionCount }, () => 0)
  for (const r of rows) {
    if (r.option >= 0 && r.option < optionCount) votes[r.option] = r.count
  }
  return votes
}

export const pollsRoutes: FastifyPluginAsyncZod = async (app) => {
  // ───── POST /api/messages/:id/poll-vote ─────
  // Голос за вариант. Повторный голос за другой вариант переносит выбор
  // (upsert по PK message+user) — single-choice, как в Telegram.
  app.post(
    '/messages/:id/poll-vote',
    {
      preHandler: app.authenticate,
      schema: {
        params: z.object({ id: z.string().uuid() }),
        body: PollVoteRequestSchema,
        response: {
          204: z.null(),
          400: ErrorBodySchema,
          401: ErrorBodySchema,
          403: ErrorBodySchema,
          404: ErrorBodySchema,
        },
      },
    },
    async (req, reply) => {
      const { id: messageId } = req.params
      const { option } = req.body
      const userId = req.authUser!.id

      const poll = await loadPollMessage(userId, messageId)
      if (option >= poll.def.options.length) {
        return reply.code(400).send({
          error: { code: 'bad-option', message: 'option index out of range' },
        })
      }

      await db
        .insert(pollVotes)
        .values({ messageId, userId, option })
        .onConflictDoUpdate({
          target: [pollVotes.messageId, pollVotes.userId],
          set: { option },
        })

      const votes = await countVotes(messageId, poll.def.options.length)
      void broadcastToChannel(poll.channelId, {
        t: 'poll.vote',
        channelId: poll.channelId,
        messageId,
        votes,
        voterId: userId,
        option,
      })

      return reply.code(204).send(null)
    },
  )

  // ───── DELETE /api/messages/:id/poll-vote ─────
  // Снять свой голос (клик по уже выбранному варианту).
  app.delete(
    '/messages/:id/poll-vote',
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
      const { id: messageId } = req.params
      const userId = req.authUser!.id

      const poll = await loadPollMessage(userId, messageId)

      await db
        .delete(pollVotes)
        .where(and(eq(pollVotes.messageId, messageId), eq(pollVotes.userId, userId)))

      const votes = await countVotes(messageId, poll.def.options.length)
      void broadcastToChannel(poll.channelId, {
        t: 'poll.vote',
        channelId: poll.channelId,
        messageId,
        votes,
        voterId: userId,
        option: null,
      })

      return reply.code(204).send(null)
    },
  )
}
