// Валидация переменных окружения. Падаем сразу с понятным сообщением,
// если что-то не задано.
import { z } from 'zod'

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  SPEEDY_PORT: z.coerce.number().default(3001),
  SPEEDY_HOST: z.string().default('0.0.0.0'),
  SPEEDY_LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),

  // Explicit IP/CIDR list of reverse proxies; no blanket header trust.
  TRUST_PROXY: z.string().default('false'),

  DATABASE_URL: z.string().min(1, 'нужен DATABASE_URL'),
  REDIS_URL: z.string().min(1, 'нужен REDIS_URL'),

  JWT_ACCESS_SECRET: z.string().min(32, 'JWT_ACCESS_SECRET — минимум 32 символа'),
  JWT_REFRESH_SECRET: z.string().min(32, 'JWT_REFRESH_SECRET — минимум 32 символа'),
  JWT_ACCESS_TTL: z.string().default('15m'),
  JWT_REFRESH_TTL: z.string().default('30d'),

  LIVEKIT_URL: z.string().url().default('ws://localhost:3001/livekit').refine((value) => {
    const url = new URL(value)
    return ['ws:', 'wss:'].includes(url.protocol) && url.pathname === '/livekit' && !url.search && !url.hash && !url.username && !url.password
  }, 'LIVEKIT_URL must be the public ws(s)://host/livekit gateway, not direct SFU'),
  // Admin-API (twirp, RoomServiceClient). LIVEKIT_URL — публичный signaling
  // для клиентов; speedy же должен ходить в LiveKit напрямую: на VPS это
  // http://livekit:7880 по docker-сети (через публичный домен изнутри
  // контейнера hairpin обычно не проходит). Dev fallback: http://127.0.0.1:7880.
  LIVEKIT_ADMIN_URL: z.string().url().refine((value) => ['http:', 'https:'].includes(new URL(value).protocol), 'LIVEKIT_ADMIN_URL must use HTTP(S)').optional(),
  LIVEKIT_API_KEY: z.string().default('devkey'),
  LIVEKIT_API_SECRET: z.string(),

  S3_ENDPOINT: z.string(),
  // Endpoint, который видят КЛИЕНТЫ (presigned PUT, public GET). На VPS speedy
  // ходит в MinIO по docker-сети (http://minio:9000), а браузеру/Tauri нужен
  // публичный https-адрес (https://s3.<домен>). Не задан → равен S3_ENDPOINT.
  S3_PUBLIC_ENDPOINT: z.string().optional(),
  S3_REGION: z.string().default('us-east-1'),
  S3_BUCKET: z.string().default('kakdela'),
  S3_EMOJI_BUCKET: z.string().default('kakdela-emoji'),
  S3_ACCESS_KEY: z.string(),
  S3_SECRET_KEY: z.string(),

  EMOJI_PER_SERVER: z.coerce.number().int().positive().default(50),

  // Медиа-библиотека Klipy (GIF / стикеры / клипы). Ключ живёт только на
  // сервере (в клиент не отдаём). Не задан → фича выключена, кнопки скрыты.
  // Dev-ключ ограничен, поэтому ответы кэшируются в Redis.
  KLIPY_API_KEY: z.string().optional(),
  // Фильтр контента Klipy: off / low / medium / high. Для дружеского сервера —
  // medium (мягкий дефолт, как прежний pg-13 у GIPHY).
  KLIPY_CONTENT_FILTER: z.enum(['off', 'low', 'medium', 'high']).default('medium'),

  // Превью ссылок (OG-метаданные). Сервер делает исходящие HTTP-запросы к
  // доменам из сообщений — кому это не нужно (приватность/закрытый периметр),
  // ставит 'false', и фича выключается целиком.
  LINK_PREVIEWS_ENABLED: z.enum(['true', 'false']).default('true').transform((v) => v === 'true'),

  PUBLIC_ORIGIN: z.string().url().default('http://localhost:1420'),
}).superRefine((value, context) => {
  if (value.NODE_ENV === 'production' && !value.LIVEKIT_ADMIN_URL) {
    context.addIssue({ code: 'custom', path: ['LIVEKIT_ADMIN_URL'], message: 'production requires a private SFU upstream URL' })
  }
})

export type Env = z.infer<typeof EnvSchema>

const parsed = EnvSchema.safeParse(process.env)
if (!parsed.success) {
  // eslint-disable-next-line no-console
  console.error('[env] invalid config:\n' + JSON.stringify(parsed.error.flatten().fieldErrors, null, 2))
  process.exit(1)
}

export const env: Env = parsed.data
