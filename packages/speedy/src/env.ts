// Валидация переменных окружения. Падаем сразу с понятным сообщением,
// если что-то не задано.
import { z } from 'zod'

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  SPEEDY_PORT: z.coerce.number().default(3001),
  SPEEDY_HOST: z.string().default('0.0.0.0'),
  SPEEDY_LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),

  DATABASE_URL: z.string().min(1, 'нужен DATABASE_URL'),
  REDIS_URL: z.string().min(1, 'нужен REDIS_URL'),

  JWT_ACCESS_SECRET: z.string().min(32, 'JWT_ACCESS_SECRET — минимум 32 символа'),
  JWT_REFRESH_SECRET: z.string().min(32, 'JWT_REFRESH_SECRET — минимум 32 символа'),
  JWT_ACCESS_TTL: z.string().default('15m'),
  JWT_REFRESH_TTL: z.string().default('30d'),

  LIVEKIT_URL: z.string().default('ws://localhost:7880'),
  // Admin-API (twirp, RoomServiceClient). LIVEKIT_URL — публичный signaling
  // для клиентов; speedy же должен ходить в LiveKit напрямую: на VPS это
  // http://livekit:7880 по docker-сети (через публичный домен изнутри
  // контейнера hairpin обычно не проходит). Не задан → выводится из
  // LIVEKIT_URL заменой ws→http (достаточно для dev).
  LIVEKIT_ADMIN_URL: z.string().optional(),
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
})

export type Env = z.infer<typeof EnvSchema>

const parsed = EnvSchema.safeParse(process.env)
if (!parsed.success) {
  // eslint-disable-next-line no-console
  console.error('[env] invalid config:\n' + JSON.stringify(parsed.error.flatten().fieldErrors, null, 2))
  process.exit(1)
}

export const env: Env = parsed.data
