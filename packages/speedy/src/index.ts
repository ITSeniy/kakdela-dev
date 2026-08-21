import Fastify, { type FastifyError } from 'fastify'
import { ZodTypeProvider, serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod'
import cookie from '@fastify/cookie'
import cors from '@fastify/cors'
import rateLimit from '@fastify/rate-limit'

import { env } from './env.js'
import { startAutoDeleteSweeper } from './lib/auto-delete.js'
import { startBirthdaySweeper } from './lib/birthdays.js'
import { startEventReminders } from './lib/event-reminders.js'
import { startSecretEnvelopeSweeper } from './lib/secret-sweeper.js'
import { makeLoggerOptions } from './lib/logger.js'
import { startMediaGcSweeper } from './lib/media-gc.js'
import { redis } from './lib/redis.js'
import { presence } from './presence/store.js'
import { healthRoutes } from './routes/health.js'
import { auditRoutes } from './routes/audit.js'
import { authRoutes } from './routes/auth.js'
import { channelsRoutes } from './routes/channels.js'
import { dmRoutes } from './routes/dm.js'
import { keysRoutes } from './routes/keys.js'
import { secretChatRoutes } from './routes/secret-chat.js'
import { emojiRoutes } from './routes/emoji.js'
import { filesRoutes } from './routes/files.js'
import { inboxRoutes } from './routes/inbox.js'
import { klipyRoutes } from './routes/klipy.js'
import { favoritesRoutes } from './routes/favorites.js'
import { stickersRoutes } from './routes/stickers.js'
import { searchRoutes } from './routes/search.js'
import { threadsRoutes } from './routes/threads.js'
import { usersRoutes } from './routes/users.js'
import { internalRoutes } from './routes/internal.js'
import { invitesRoutes } from './routes/invites.js'
import { eventsRoutes } from './routes/events.js'
import { messagesRoutes } from './routes/messages.js'
import { pollsRoutes } from './routes/polls.js'
import { reactionsRoutes } from './routes/reactions.js'
import { rolesRoutes } from './routes/roles.js'
import { serversRoutes } from './routes/servers.js'
import { voiceRoutes } from './routes/voice.js'
import { voiceDebugRoutes } from './routes/voice-debug.js'
import { authPlugin } from './auth/middleware.js'
import { wsPlugin } from './ws/server.js'

async function main() {
  // TRUST_PROXY='auto' → доверять X-Forwarded-For только в production
  // (за Caddy). См. комментарий в env.ts.
  const trustProxy =
    env.TRUST_PROXY === 'auto'
      ? env.NODE_ENV === 'production'
      : env.TRUST_PROXY === 'true'

  const app = Fastify({ logger: makeLoggerOptions(), trustProxy }).withTypeProvider<ZodTypeProvider>()

  app.setValidatorCompiler(validatorCompiler)
  app.setSerializerCompiler(serializerCompiler)

  // Кроме PUBLIC_ORIGIN (web-клиент) разрешаем origin'ы Tauri-webview:
  // в собранном desktop-клиенте страница живёт не на нашем домене, а на
  // http://tauri.localhost (Windows) / tauri://localhost (macOS, Linux).
  await app.register(cors, {
    origin: [env.PUBLIC_ORIGIN, 'http://tauri.localhost', 'tauri://localhost'],
    credentials: true,
  })
  await app.register(cookie)
  await app.register(rateLimit, {
    global: false,
    redis,
    nameSpace: 'rl:',
    // Единый формат ошибок по конвенции { error: { code, message } }
    // вместо дефолтного тела плагина.
    errorResponseBuilder: () => ({
      error: { code: 'rate-limited', message: 'too many requests, slow down' },
    }),
  })
  await app.register(authPlugin)

  app.setErrorHandler((error: FastifyError, _req, reply) => {
    const statusCode = error.statusCode ?? 500
    const code = error.code && !error.code.startsWith('FST_ERR_')
      ? error.code
      : 'internal-error'
    app.log.error(error)
    // Текст внутренних ошибок наружу не отдаём (фрагменты SQL, имена
    // констрейнтов и т.п.); детали — в логе.
    const message = statusCode >= 500 ? 'internal server error' : error.message
    void reply.code(statusCode).send({
      error: { code, message },
    })
  })

  await app.register(healthRoutes)
  await app.register(authRoutes, { prefix: '/api' })
  await app.register(auditRoutes, { prefix: '/api' })
  await app.register(invitesRoutes, { prefix: '/api' })
  await app.register(serversRoutes, { prefix: '/api' })
  await app.register(rolesRoutes, { prefix: '/api' })
  await app.register(channelsRoutes, { prefix: '/api' })
  await app.register(messagesRoutes, { prefix: '/api' })
  await app.register(pollsRoutes, { prefix: '/api' })
  await app.register(eventsRoutes, { prefix: '/api' })
  await app.register(reactionsRoutes, { prefix: '/api' })
  await app.register(filesRoutes, { prefix: '/api' })
  await app.register(emojiRoutes, { prefix: '/api' })
  await app.register(dmRoutes, { prefix: '/api' })
  await app.register(keysRoutes, { prefix: '/api' })
  await app.register(secretChatRoutes, { prefix: '/api' })
  await app.register(inboxRoutes, { prefix: '/api' })
  await app.register(searchRoutes, { prefix: '/api' })
  await app.register(klipyRoutes, { prefix: '/api' })
  await app.register(favoritesRoutes, { prefix: '/api' })
  await app.register(stickersRoutes, { prefix: '/api' })
  await app.register(threadsRoutes, { prefix: '/api' })
  await app.register(usersRoutes, { prefix: '/api' })
  await app.register(voiceRoutes, { prefix: '/api' })
  await app.register(internalRoutes, { prefix: '/api' })
  if (env.NODE_ENV === 'development') {
    await app.register(voiceDebugRoutes, { prefix: '/api' })
  }
  await app.register(wsPlugin)

  const shutdown = async () => {
    app.log.info('shutting down')
    await app.close()
    process.exit(0)
  }
  process.on('SIGTERM', () => { void shutdown() })
  process.on('SIGINT', () => { void shutdown() })

  // Осиротевшие после рестарта/краша счётчики presence → все offline;
  // живые клиенты переподключатся и снова станут online. До listen, чтобы
  // первый же addConnection не потёрся сбросом.
  await presence.resetAll()

  await app.listen({ host: env.SPEEDY_HOST, port: env.SPEEDY_PORT })

  // Автоудаление сообщений в каналах с заданным сроком (настройки канала).
  startAutoDeleteSweeper(app.log)
  startBirthdaySweeper(app.log)
  startEventReminders(app.log)
  // Retention недоставленных секретных конвертов (T-102): чистим старше 30 дней.
  startSecretEnvelopeSweeper(app.log)
  // GC вложений MinIO: soft-deleted сообщения, заброшенные pending/unattached
  // (аудит M-6). S3-объекты не каскадятся вместе со строками files.
  startMediaGcSweeper(app.log)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
