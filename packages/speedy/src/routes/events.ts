import { and, eq } from 'drizzle-orm'
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod'
import { z } from 'zod'

import { ErrorBodySchema, EventRsvpRequestSchema } from '@kakdela/ginzu/api-types'

import { eventRsvps, messages } from '../db/schema.js'
import { db } from '../lib/db.js'
import { assertCanAccessChannel, notFound } from '../lib/permissions.js'
import { broadcastToChannel } from '../ws/broadcast.js'

/** Сообщение-встреча, доступное юзеру; 404 если нет/удалено/не встреча. */
async function loadEventMessage(userId: string, messageId: string): Promise<{ channelId: string }> {
  const rows = await db
    .select({ channelId: messages.channelId, deletedAt: messages.deletedAt, event: messages.event })
    .from(messages)
    .where(eq(messages.id, messageId))
    .limit(1)
  const msg = rows[0]
  if (!msg || msg.deletedAt !== null) throw notFound('message-not-found', 'message not found')
  if (msg.event == null) throw notFound('not-an-event', 'message is not an event')

  await assertCanAccessChannel(userId, msg.channelId)
  return { channelId: msg.channelId }
}

/** Свежие полные списки RSVP — для WS event.rsvp. */
async function listRsvps(messageId: string): Promise<{ going: string[]; declined: string[] }> {
  const rows = await db
    .select({ userId: eventRsvps.userId, going: eventRsvps.going })
    .from(eventRsvps)
    .where(eq(eventRsvps.messageId, messageId))
  const going: string[] = []
  const declined: string[] = []
  for (const r of rows) (r.going ? going : declined).push(r.userId)
  return { going, declined }
}

export const eventsRoutes: FastifyPluginAsyncZod = async (app) => {
  // ───── POST /api/messages/:id/event-rsvp ─────
  // «Пойду» / «не пойду» / null (снять ответ). Один ответ на юзера — upsert.
  app.post(
    '/messages/:id/event-rsvp',
    {
      preHandler: app.authenticate,
      schema: {
        params: z.object({ id: z.string().uuid() }),
        body: EventRsvpRequestSchema,
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
      const { rsvp } = req.body
      const userId = req.authUser!.id

      const { channelId } = await loadEventMessage(userId, messageId)

      if (rsvp === null) {
        await db
          .delete(eventRsvps)
          .where(and(eq(eventRsvps.messageId, messageId), eq(eventRsvps.userId, userId)))
      } else {
        await db
          .insert(eventRsvps)
          .values({ messageId, userId, going: rsvp === 'going' })
          .onConflictDoUpdate({
            target: [eventRsvps.messageId, eventRsvps.userId],
            set: { going: rsvp === 'going' },
          })
      }

      const { going, declined } = await listRsvps(messageId)
      void broadcastToChannel(channelId, {
        t: 'event.rsvp',
        channelId,
        messageId,
        going,
        declined,
        voterId: userId,
        rsvp,
      })

      return reply.code(204).send(null)
    },
  )
}
