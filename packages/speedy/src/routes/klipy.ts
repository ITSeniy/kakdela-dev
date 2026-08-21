// Прокси медиа-библиотеки Klipy (GIF / стикеры / клипы). Ключ и customer_id
// живут только на сервере — в клиент не отдаём. Klipy отдаёт тяжёлую форму с
// тирами (hd/md/sm/xs) и множеством форматов; мы выбираем нужное и отдаём
// плоский KlipyItem. Ответы кэшируются в Redis (тренды — 10 мин, поиск — час):
// на 15-20 друзей это почти обнуляет реальные обращения к Klipy.
//
// Attribution: Klipy требует дёргать share-триггер при отправке элемента —
// POST /klipy/:type/share/:slug делает это fire-and-forget (см. их гайдлайны).

import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod'
import { z } from 'zod'

import {
  ErrorBodySchema,
  KlipyConfigSchema,
  KlipyMediaTypeSchema,
  KlipyResponseSchema,
  type KlipyItem,
  type KlipyMediaType,
  type KlipyResponse,
} from '@kakdela/ginzu/api-types'

import { env } from '../env.js'
import { redis } from '../lib/redis.js'

const KLIPY_BASE = 'https://api.klipy.co/api/v1'
const TRENDING_TTL_S = 600    // 10 минут — тренды меняются медленно
const SEARCH_TTL_S = 3_600    // 1 час — один и тот же запрос не жжёт лимит

// ───── Сырые формы Klipy (структурная типизация, безопасный доступ) ─────

interface KlipyFormat { url?: string; width?: number; height?: number; size?: number }
type KlipyTier = Record<string, KlipyFormat | undefined>
// gif/sticker: file = { hd, md, sm, xs } каждый с форматами gif/webp/mp4/png…
// clip: file = { mp4, gif, webp } (строки-URL) + file_meta с размерами.
interface KlipyRawItem {
  id?: number | string
  slug?: string
  title?: string
  file?: Record<string, KlipyTier | string | undefined>
  file_meta?: Record<string, { width?: number; height?: number } | undefined>
}
interface KlipyRawResponse {
  result?: boolean
  data?: { data?: KlipyRawItem[]; current_page?: number; has_next?: boolean }
  errors?: { message?: string[] }
}

function firstUrl(...cands: Array<KlipyFormat | undefined>): string | null {
  for (const c of cands) if (c?.url) return c.url
  return null
}

/** Нормализация gif/sticker (тиры hd/md/sm/xs × форматы). */
function normalizeTiered(item: KlipyRawItem, type: 'gifs' | 'stickers'): KlipyItem | null {
  const file = (item.file ?? {}) as Record<string, KlipyTier | undefined>
  const hd = file.hd ?? {}, md = file.md ?? {}, sm = file.sm ?? {}, xs = file.xs ?? {}
  if (type === 'stickers') {
    // Стикеры прозрачные → предпочитаем webp/png; mp4 не нужен (рендерим <img>).
    const preview = firstUrl(sm.webp, sm.png, sm.gif, xs.webp, xs.gif)
    const main = md.webp ?? md.png ?? md.gif ?? hd.webp ?? hd.png ?? sm.webp
    const url = firstUrl(main)
    if (!preview || !url || !main?.width || !main?.height) return null
    return {
      id: String(item.id ?? item.slug ?? url),
      slug: item.slug ?? '',
      title: item.title ?? '',
      previewUrl: preview,
      url,
      mp4Url: null,
      width: main.width,
      height: main.height,
    }
  }
  // gif: превью — маленький gif/webp; основной показ — md-gif; mp4 для <video>.
  const preview = firstUrl(sm.gif, sm.webp, xs.gif)
  const main = md.gif ?? hd.gif ?? sm.gif
  const url = firstUrl(main)
  const mp4 = firstUrl(md.mp4, hd.mp4, sm.mp4)
  if (!preview || !url || !main?.width || !main?.height) return null
  return {
    id: String(item.id ?? item.slug ?? url),
    slug: item.slug ?? '',
    title: item.title ?? '',
    previewUrl: preview,
    url,
    mp4Url: mp4,
    width: main.width,
    height: main.height,
  }
}

/** Нормализация клипа (плоский file {mp4,gif,webp} + file_meta с размерами). */
function normalizeClip(item: KlipyRawItem): KlipyItem | null {
  const file = (item.file ?? {}) as Record<string, string | undefined>
  const meta = item.file_meta ?? {}
  const mp4 = typeof file.mp4 === 'string' ? file.mp4 : null
  const preview = (typeof file.gif === 'string' ? file.gif : null)
    ?? (typeof file.webp === 'string' ? file.webp : null)
  const dims = meta.mp4 ?? meta.gif ?? meta.webp
  if (!mp4 || !preview || !dims?.width || !dims?.height) return null
  return {
    id: String(item.id ?? item.slug ?? mp4),
    slug: item.slug ?? '',
    title: item.title ?? '',
    previewUrl: preview,
    url: preview,        // для грида/постера показываем gif-луп
    mp4Url: mp4,
    width: dims.width,
    height: dims.height,
  }
}

function normalize(items: KlipyRawItem[], type: KlipyMediaType): KlipyItem[] {
  const out: KlipyItem[] = []
  for (const it of items) {
    const n = type === 'clips' ? normalizeClip(it) : normalizeTiered(it, type)
    if (n) out.push(n)
  }
  return out
}

/** Запрос к Klipy с нормализацией + пагинацией по страницам. */
async function callKlipy(
  type: KlipyMediaType,
  endpoint: 'trending' | 'search',
  params: Record<string, string>,
  customerId: string,
): Promise<KlipyResponse> {
  const url = new URL(`${KLIPY_BASE}/${env.KLIPY_API_KEY!}/${type}/${endpoint}`)
  url.searchParams.set('customer_id', customerId)
  url.searchParams.set('content_filter', env.KLIPY_CONTENT_FILTER)
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v)

  let res: Response
  try {
    res = await fetch(url, { signal: AbortSignal.timeout(8_000) })
  } catch (err) {
    // Таймаут/DNS/обрыв соединения — для клиента это «внешний провайдер недоступен»,
    // а не internal-error: маппим в тот же klipy-upstream, что и HTTP-сбои.
    const e = new Error(`klipy unreachable: ${err instanceof Error ? err.message : String(err)}`) as Error & { statusCode: number; code: string }
    e.statusCode = 502; e.code = 'klipy-upstream'
    throw e
  }
  if (res.status === 429) {
    const e = new Error('klipy rate limit') as Error & { statusCode: number; code: string }
    e.statusCode = 429; e.code = 'klipy-rate-limited'
    throw e
  }
  const body = await res.json().catch(() => null) as KlipyRawResponse | null
  if (!res.ok || !body?.result || !body.data) {
    const e = new Error(`klipy ${res.status}`) as Error & { statusCode: number; code: string }
    e.statusCode = 502; e.code = 'klipy-upstream'
    throw e
  }
  const page = body.data.current_page ?? Number(params.page ?? '1')
  return {
    items: normalize(body.data.data ?? [], type),
    nextPage: body.data.has_next ? page + 1 : null,
  }
}

/** Кэш-обёртка: сначала Redis, при промахе — Klipy + запись в кэш. */
async function cached(key: string, ttl: number, build: () => Promise<KlipyResponse>): Promise<KlipyResponse> {
  try {
    const hit = await redis.get(key)
    if (hit) return JSON.parse(hit) as KlipyResponse
  } catch { /* redis недоступен — просто идём в Klipy */ }
  const fresh = await build()
  try {
    await redis.set(key, JSON.stringify(fresh), 'EX', ttl)
  } catch { /* запись в кэш не критична */ }
  return fresh
}

export const klipyRoutes: FastifyPluginAsyncZod = async (app) => {
  const enabled = Boolean(env.KLIPY_API_KEY)

  // Возможности: enabled — есть ли ключ; memes на dev-ключе закрыты (Route not
  // found) — пока false. Остальное доступно, когда ключ задан.
  app.get(
    '/klipy/config',
    { preHandler: app.authenticate, schema: { response: { 200: KlipyConfigSchema, 401: ErrorBodySchema } } },
    async (_req, reply) => reply.code(200).send({
      enabled, gifs: enabled, stickers: enabled, clips: enabled, memes: false,
    }),
  )

  function ensureEnabled(reply: { code(n: number): { send(b: unknown): unknown } }): boolean {
    if (!enabled) {
      reply.code(503).send({ error: { code: 'klipy-disabled', message: 'медиа-библиотека не настроена' } })
      return false
    }
    return true
  }

  app.get(
    '/klipy/:type/trending',
    {
      preHandler: app.authenticate,
      schema: {
        params: z.object({ type: KlipyMediaTypeSchema }),
        querystring: z.object({
          page:     z.coerce.number().int().min(1).max(200).default(1),
          per_page: z.coerce.number().int().min(1).max(50).default(24),
        }),
        response: { 200: KlipyResponseSchema, 401: ErrorBodySchema, 502: ErrorBodySchema, 503: ErrorBodySchema, 429: ErrorBodySchema },
      },
    },
    async (req, reply) => {
      if (!ensureEnabled(reply)) return reply
      const { type } = req.params
      const { page, per_page } = req.query
      const key = `klipy:${type}:trending:${env.KLIPY_CONTENT_FILTER}:${page}:${per_page}`
      const data = await cached(key, TRENDING_TTL_S, () =>
        callKlipy(type, 'trending', { page: String(page), per_page: String(per_page) }, req.authUser!.id),
      )
      return reply.code(200).send(data)
    },
  )

  app.get(
    '/klipy/:type/search',
    {
      preHandler: app.authenticate,
      schema: {
        params: z.object({ type: KlipyMediaTypeSchema }),
        querystring: z.object({
          q:        z.string().trim().min(1).max(100),
          page:     z.coerce.number().int().min(1).max(200).default(1),
          per_page: z.coerce.number().int().min(1).max(50).default(24),
        }),
        response: { 200: KlipyResponseSchema, 401: ErrorBodySchema, 502: ErrorBodySchema, 503: ErrorBodySchema, 429: ErrorBodySchema },
      },
    },
    async (req, reply) => {
      if (!ensureEnabled(reply)) return reply
      const { type } = req.params
      const { q, page, per_page } = req.query
      const key = `klipy:${type}:search:${env.KLIPY_CONTENT_FILTER}:${q.toLowerCase()}:${page}:${per_page}`
      const data = await cached(key, SEARCH_TTL_S, () =>
        callKlipy(type, 'search', { q, page: String(page), per_page: String(per_page) }, req.authUser!.id),
      )
      return reply.code(200).send(data)
    },
  )

  // Share-триггер (attribution): дёргаем Klipy при отправке элемента. Ошибки
  // глушим — это аналитика провайдера, не путь пользователя. 204 всегда.
  app.post(
    '/klipy/:type/share/:slug',
    {
      preHandler: app.authenticate,
      schema: {
        params: z.object({ type: KlipyMediaTypeSchema, slug: z.string().min(1).max(200) }),
        response: { 204: z.null(), 401: ErrorBodySchema, 503: ErrorBodySchema },
      },
    },
    async (req, reply) => {
      if (!ensureEnabled(reply)) return reply
      const { type, slug } = req.params
      const url = `${KLIPY_BASE}/${env.KLIPY_API_KEY!}/${type}/share/${encodeURIComponent(slug)}`
      void fetch(url, {
        method: 'POST',
        body: new URLSearchParams({ customer_id: req.authUser!.id }),
        signal: AbortSignal.timeout(5_000),
      }).catch(() => { /* attribution best-effort */ })
      return reply.code(204).send(null)
    },
  )
}
