import type { FastifyInstance, FastifyServerOptions } from 'fastify'
import { env } from '../env.js'

export function safeRequestUrl(raw: string | undefined): string | undefined {
  if (!raw) return raw
  // Drop all query strings, including percent-encoded keys and unknown routes.
  // URL query logging is not needed to diagnose route/status failures.
  return raw.split('?')[0]
}

interface LogRequest {
  method?: string
  url?: string
  hostname?: string
  ip?: string
  socket?: { remotePort?: number }
}

/** Fastify's default 404 logs the raw URL inside msg, outside req serialization. */
export function installSafeNotFound(app: FastifyInstance): void {
  app.setNotFoundHandler((_req, reply) => {
    return reply.code(404).send({ error: { code: 'not-found', message: 'route not found' } })
  })
}

export function makeLoggerOptions(): FastifyServerOptions['logger'] {
  const options = {
    level: env.SPEEDY_LOG_LEVEL,
    redact: { paths: ['req.headers.authorization', 'req.headers.cookie'], censor: '[REDACTED]' },
    serializers: {
      req: (req: LogRequest) => ({
        method: req.method,
        url: safeRequestUrl(req.url),
        hostname: req.hostname,
        remoteAddress: req.ip,
        remotePort: req.socket?.remotePort,
      }),
    },
  }
  return env.NODE_ENV === 'development'
    ? { ...options, transport: { target: 'pino-pretty' } }
    : options
}
