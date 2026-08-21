import { createHash } from 'node:crypto'

import { WebhookEvent } from 'livekit-server-sdk'
import { jwtVerify } from 'jose'
import type { FastifyPluginAsync } from 'fastify'

import { env } from '../env.js'
import { alreadyProcessed, handleWebhookEvent } from '../media/webhook.js'

// Проверяем подпись вебхука сами, а не через WebhookReceiver.receive: тот
// зовёт jwtVerify без clockTolerance, а часы docker-VM (WSL2) после сна
// Windows дрейфуют вперёд — LiveKit подписывает nbf «из будущего», и speedy
// отбрасывал ВСЕ вебхуки с JWTClaimValidationFailed («nbf claim timestamp
// check failed»), теряя voice.join/leave. Допуск 5 минут покрывает типичный
// дрейф; sha256-хэш тела по-прежнему обязан совпадать байт в байт.
const WEBHOOK_CLOCK_TOLERANCE = '5 minutes'

async function verifyAndParseWebhook(body: string, authHeader: string): Promise<WebhookEvent> {
  const secret = new TextEncoder().encode(env.LIVEKIT_API_SECRET)
  const { payload } = await jwtVerify(authHeader, secret, {
    issuer: env.LIVEKIT_API_KEY,
    clockTolerance: WEBHOOK_CLOCK_TOLERANCE,
  })
  const bodyHash = createHash('sha256').update(body).digest('base64')
  if (payload['sha256'] !== bodyHash) {
    throw new Error('webhook body hash mismatch')
  }
  return WebhookEvent.fromJson(JSON.parse(body), { ignoreUnknownFields: true })
}

// Внутренние эндпоинты — вызываются другими сервисами (сейчас только LiveKit),
// не пользовательскими клиентами. Живут под `/api/internal/*`; на проде Caddy
// отвечает на этот префикс 404 (см. ops/caddy/Caddyfile.prod), а LiveKit ходит
// напрямую по docker-сети (http://speedy:3001, см. livekit.prod.yaml → webhook).
export const internalRoutes: FastifyPluginAsync = async (app) => {
  // LiveKit подписывает webhook'и JWT-токеном, в `sha256`-клейме которого
  // лежит хэш ровно того body, что прилетел. Чтобы валидация сработала,
  // нам нужен оригинальный текст тела — не parsed JSON. Парсер
  // переопределён только для этого плагина (encapsulation Fastify).
  // Актуальный livekit-server шлёт `application/webhook+json`, старые
  // версии — `application/json`; без парсера на оба Fastify отвечает 415
  // (FST_ERR_CTP_INVALID_MEDIA_TYPE) ещё до нашего хендлера.
  const rawString = (_req: unknown, body: string, done: (err: null, body: string) => void) => {
    done(null, body)
  }
  app.addContentTypeParser('application/json', { parseAs: 'string' }, rawString)
  app.addContentTypeParser('application/webhook+json', { parseAs: 'string' }, rawString)

  app.post('/internal/livekit-webhook', async (req, reply) => {
    const body = req.body
    if (typeof body !== 'string') {
      return reply.code(400).send({
        error: { code: 'bad-body', message: 'expected raw json body' },
      })
    }

    // Разные версии LiveKit использовали "Authorization" и "Authorize" —
    // Node lowercas'ит заголовки, проверяем оба.
    const authHeader =
      (req.headers['authorization'] as string | undefined) ??
      (req.headers['authorize'] as string | undefined)
    if (!authHeader) {
      return reply.code(401).send({
        error: { code: 'missing-auth', message: 'webhook auth header missing' },
      })
    }

    let event
    try {
      event = await verifyAndParseWebhook(body, authHeader)
    } catch (err) {
      app.log.warn({ err }, 'livekit-webhook: invalid signature')
      return reply.code(401).send({
        error: { code: 'invalid-signature', message: 'webhook signature invalid' },
      })
    }

    if (await alreadyProcessed(event.id)) {
      return reply.code(200).send({ ok: true, dedup: true })
    }

    try {
      await handleWebhookEvent(event, app.log)
    } catch (err) {
      app.log.error(
        { err, eventId: event.id, type: event.event },
        'livekit-webhook: handler failed',
      )
      // Возвращаем 200, чтобы LiveKit не ретраил вечно: вебхуки — best-effort
      // presence, ничего необратимого тут не происходит, всё пересчитается
      // следующим событием или GET /participants.
      return reply.code(200).send({ ok: false })
    }

    return reply.code(200).send({ ok: true })
  })
}
