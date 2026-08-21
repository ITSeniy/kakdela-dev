// Превью ссылок: достаём Open-Graph / meta-теги со страниц, на которые ссылаются
// сообщения. Сервер ходит по ПРОИЗВОЛЬНЫМ URL из пользовательского текста, так
// что главная забота тут — SSRF: запрещаем приватные/служебные IP, пинуем
// проверенный адрес на само TCP-соединение (через кастомный lookup — это
// закрывает DNS-rebinding), ограничиваем редиректы, размер тела и время.
//
// Никаких внешних зависимостей: только node-встроенные http/https/dns/net/zlib.
// Результаты кэшируются в Redis по URL (одна и та же ссылка не перевыкачивается).

import dns from 'node:dns'
import http from 'node:http'
import https from 'node:https'
import net from 'node:net'
import { Buffer } from 'node:buffer'
import zlib from 'node:zlib'

import type { LinkPreview } from '@kakdela/ginzu/api-types'

import { redis } from './redis.js'

const MAX_PREVIEWS = 3              // не больше 3 карточек на сообщение
const MAX_BYTES = 512 * 1024       // читаем максимум 512 КБ HTML (нам нужен <head>)
const TIMEOUT_MS = 6_000           // на каждый хоп
const MAX_REDIRECTS = 4
// Браузероподобный UA: часть сайтов (в т.ч. YouTube) отдают пустую/консентную
// страницу без OG-тегов «голым» ботам. Имитируем десктопный Chrome.
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36'

// Кэш бампаем до v2 — поменялась логика (YouTube-embed, новый UA), старые
// записи v1 не должны «залипнуть» негативным результатом по YouTube.
const CACHE_PREFIX = 'lp:v2:'
const CACHE_TTL_OK_S = 24 * 3_600  // успешное превью — сутки
const CACHE_TTL_MISS_S = 3_600     // «превью нет» — час (чтобы не долбить впустую)

// ───────────────────────── SSRF: блок приватных адресов ─────────────────────

function ipv4ToOctets(ip: string): number[] | null {
  const parts = ip.split('.')
  if (parts.length !== 4) return null
  const out: number[] = []
  for (const p of parts) {
    const n = Number(p)
    if (!Number.isInteger(n) || n < 0 || n > 255) return null
    out.push(n)
  }
  return out
}

function isPrivateV4(ip: string): boolean {
  const o = ipv4ToOctets(ip)
  if (!o) return true
  const [a, b, c] = o as [number, number, number]
  if (a === 0) return true                          // 0.0.0.0/8
  if (a === 10) return true                          // 10/8
  if (a === 127) return true                         // loopback
  if (a === 100 && b >= 64 && b <= 127) return true  // CGNAT 100.64/10
  if (a === 169 && b === 254) return true            // link-local
  if (a === 172 && b >= 16 && b <= 31) return true   // 172.16/12
  if (a === 192 && b === 168) return true            // 192.168/16
  if (a === 192 && b === 0 && c === 0) return true   // 192.0.0/24 (IETF)
  if (a === 198 && (b === 18 || b === 19)) return true // benchmarking
  if (a >= 224) return true                          // multicast + reserved 224-255
  return false
}

function isPrivateV6(ip: string): boolean {
  const addr = (ip.split('%')[0] ?? '').toLowerCase()
  if (addr === '::1' || addr === '::') return true
  const mapped = /^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(addr)
  if (mapped?.[1]) return isPrivateV4(mapped[1])
  if (/^f[cd]/.test(addr)) return true               // ULA fc00::/7
  if (/^fe[89ab]/.test(addr)) return true            // link-local fe80::/10
  // IPv6 transition-механизмы: IPv4 зашит внутрь адреса, и через шлюз
  // NAT64/6to4 пакет может уехать в интранет мимо v4-блок-листа.
  if (/^64:ff9b(:|$)/.test(addr)) return true        // NAT64 64:ff9b::/96 (+ :1::/48)
  if (/^2002:/.test(addr)) return true               // 6to4 2002::/16
  if (/^2001:/.test(addr)) {                         // Teredo 2001::/32
    const second = addr.split(':')[1] ?? ''
    if (second === '' || /^0+$/.test(second)) return true
  }
  return false
}

/** true → адрес приватный/служебный, ходить туда нельзя (SSRF-защита). */
export function isBlockedIp(ip: string): boolean {
  const fam = net.isIP(ip)
  if (fam === 4) return isPrivateV4(ip)
  if (fam === 6) return isPrivateV6(ip)
  return true
}

// Кастомный lookup: резолвим хост, валидируем ВСЕ адреса (защита от того, что
// один из A-records — приватный), и отдаём ядру уже проверенный адрес. Так как
// тот же адрес идёт на connect(), DNS-rebinding не проходит. Сигнатура должна
// совпадать с node-типом lookup (Node 20+ при Happy-Eyeballs зовёт с all:true и
// ждёт массив адресов в колбэке).
const safeLookup: NonNullable<http.RequestOptions['lookup']> = (hostname, options, cb) => {
  dns.lookup(hostname, { all: true, verbatim: true }, (err, addresses) => {
    if (err) { cb(err, '', 0); return }
    if (!addresses || addresses.length === 0) { cb(new Error('no-dns-records') as NodeJS.ErrnoException, '', 0); return }
    for (const a of addresses) {
      if (isBlockedIp(a.address)) { cb(new Error('blocked-ip') as NodeJS.ErrnoException, '', 0); return }
    }
    const wantsAll = typeof options === 'object' && options !== null && (options as dns.LookupAllOptions).all === true
    if (wantsAll) { cb(null, addresses); return }
    const first = addresses[0]!
    cb(null, first.address, first.family)
  })
}

// ───────────────────────── низкоуровневый фетч одного хопа ──────────────────

interface HopResult {
  status: number
  location?: string
  contentType: string
  body: Buffer
}

function fetchHop(target: string): Promise<HopResult> {
  return new Promise((resolve, reject) => {
    let u: URL
    try { u = new URL(target) } catch { reject(new Error('bad-url')); return }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') { reject(new Error('bad-protocol')); return }

    const mod = u.protocol === 'https:' ? https : http
    let settled = false
    const done = (fn: () => void) => { if (!settled) { settled = true; fn() } }

    const req = mod.request(
      u,
      {
        method: 'GET',
        lookup: safeLookup,
        timeout: TIMEOUT_MS,
        headers: {
          'user-agent': UA,
          accept: 'text/html,application/xhtml+xml,image/*;q=0.8,*/*;q=0.5',
          'accept-encoding': 'gzip, deflate, br',
          'accept-language': 'ru,en;q=0.8',
        },
      },
      (res) => {
        const status = res.statusCode ?? 0
        const contentType = String(res.headers['content-type'] ?? '')

        // Редирект — не читаем тело, отдаём Location наверх (там ревалидация хопа).
        if (status >= 300 && status < 400 && res.headers.location) {
          res.resume()
          done(() => resolve({ status, location: String(res.headers.location), contentType, body: Buffer.alloc(0) }))
          return
        }
        // Прямая картинка: тело не качаем (может быть тяжёлым) — превью = сам URL.
        if (status === 200 && contentType.startsWith('image/')) {
          res.resume()
          done(() => resolve({ status, contentType, body: Buffer.alloc(0) }))
          return
        }
        if (status !== 200 || !/\b(text\/html|xhtml|text\/xml|application\/xml)\b/i.test(contentType)) {
          res.resume()
          done(() => resolve({ status, contentType, body: Buffer.alloc(0) }))
          return
        }

        // Распаковка по content-encoding.
        const enc = String(res.headers['content-encoding'] ?? '').toLowerCase()
        let stream: NodeJS.ReadableStream = res
        if (enc === 'gzip') stream = res.pipe(zlib.createGunzip())
        else if (enc === 'deflate') stream = res.pipe(zlib.createInflate())
        else if (enc === 'br') stream = res.pipe(zlib.createBrotliDecompress())

        const chunks: Buffer[] = []
        let total = 0
        stream.on('data', (c: Buffer) => {
          total += c.length
          chunks.push(c)
          if (total >= MAX_BYTES) {
            req.destroy()
            done(() => resolve({ status, contentType, body: Buffer.concat(chunks).subarray(0, MAX_BYTES) }))
          }
        })
        stream.on('end', () => done(() => resolve({ status, contentType, body: Buffer.concat(chunks) })))
        stream.on('error', (e) => done(() => {
          // обрыв из-за нашего же req.destroy() при достижении лимита — не ошибка
          if (chunks.length > 0) resolve({ status, contentType, body: Buffer.concat(chunks).subarray(0, MAX_BYTES) })
          else reject(e)
        }))
      },
    )

    req.on('timeout', () => { req.destroy(new Error('timeout')) })
    req.on('error', (e) => done(() => reject(e)))
    req.end()
  })
}

/** Следуем за редиректами, ревалидируя каждый хоп (IP проверяется в lookup). */
async function fetchFollowing(startUrl: string): Promise<{ finalUrl: string; res: HopResult } | null> {
  let current = startUrl
  for (let i = 0; i <= MAX_REDIRECTS; i += 1) {
    const res = await fetchHop(current)
    if (res.status >= 300 && res.status < 400 && res.location) {
      let next: string
      try { next = new URL(res.location, current).toString() } catch { return null }
      current = next
      continue
    }
    return { finalUrl: current, res }
  }
  return null // слишком много редиректов
}

// ───────────────────────── парсинг meta/OG ──────────────────────────────────

function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0*39;|&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, d: string) => { try { return String.fromCodePoint(Number(d)) } catch { return '' } })
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h: string) => { try { return String.fromCodePoint(parseInt(h, 16)) } catch { return '' } })
}

function tagAttr(tag: string, name: string): string | null {
  const re = new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s"'>]+))`, 'i')
  const m = re.exec(tag)
  if (!m) return null
  return m[2] ?? m[3] ?? m[4] ?? null
}

interface ParsedMeta {
  props: Record<string, string>
  htmlTitle: string | null
}

function parseHead(html: string): ParsedMeta {
  // Ограничиваемся <head> — там все нужные мета-теги, и не тратим время на body.
  const headEnd = html.search(/<\/head>/i)
  const head = headEnd >= 0 ? html.slice(0, headEnd) : html.slice(0, 200_000)

  const props: Record<string, string> = {}
  const metaRe = /<meta\b[^>]*>/gi
  let m: RegExpExecArray | null
  while ((m = metaRe.exec(head)) !== null) {
    const tag = m[0]
    const key = (tagAttr(tag, 'property') ?? tagAttr(tag, 'name'))?.toLowerCase()
    const content = tagAttr(tag, 'content')
    if (key && content != null && !(key in props)) props[key] = decodeEntities(content).trim()
  }
  const titleM = /<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(head)
  const htmlTitle = titleM?.[1] ? decodeEntities(titleM[1]).replace(/\s+/g, ' ').trim() : null
  return { props, htmlTitle }
}

function clamp(s: string, max: number): string {
  const t = s.replace(/\s+/g, ' ').trim()
  return t.length > max ? t.slice(0, max - 1).trimEnd() + '…' : t
}

function buildPreview(finalUrl: string, parsed: ParsedMeta): LinkPreview | null {
  const p = parsed.props
  const title = p['og:title'] ?? p['twitter:title'] ?? parsed.htmlTitle ?? null
  const description = p['og:description'] ?? p['twitter:description'] ?? p['description'] ?? null
  const siteName = p['og:site_name'] ?? null

  let image = p['og:image:secure_url'] ?? p['og:image:url'] ?? p['og:image'] ?? p['twitter:image'] ?? p['twitter:image:src'] ?? null
  if (image) {
    try { image = new URL(image, finalUrl).toString() } catch { image = null }
    if (image && !/^https?:\/\//i.test(image)) image = null
  }

  let canonical = finalUrl
  if (p['og:url']) {
    try { canonical = new URL(p['og:url'], finalUrl).toString() } catch { /* оставляем finalUrl */ }
  }
  if (!/^https?:\/\//i.test(canonical)) canonical = finalUrl

  // Без заголовка и без картинки карточка бессмысленна.
  if (!title && !image) return null

  return {
    url:         canonical,
    kind:        'link',
    siteName:    siteName ? clamp(siteName, 100) : null,
    title:       title ? clamp(title, 200) : null,
    description: description ? clamp(description, 400) : null,
    imageUrl:    image,
  }
}

// ───────────────────────── YouTube (встраиваемый плеер) ─────────────────────

/** Извлекает videoId из ссылки YouTube (watch, youtu.be, shorts, embed). */
function youtubeId(url: string): string | null {
  let u: URL
  try { u = new URL(url) } catch { return null }
  const host = u.hostname.replace(/^www\./, '').toLowerCase()
  if (host === 'youtu.be') {
    const id = u.pathname.slice(1).split('/')[0]
    return /^[\w-]{11}$/.test(id ?? '') ? id! : null
  }
  if (host === 'youtube.com' || host === 'm.youtube.com' || host === 'youtube-nocookie.com') {
    const v = u.searchParams.get('v')
    if (v && /^[\w-]{11}$/.test(v)) return v
    const m = /^\/(?:shorts|embed|v)\/([\w-]{11})/.exec(u.pathname)
    if (m?.[1]) return m[1]
  }
  return null
}

/**
 * Превью YouTube через oEmbed (без скрейпинга — надёжно, не блокируется
 * консентом). Возвращает video-карточку со встраиваемым плеером.
 */
async function youtubePreview(url: string, videoId: string): Promise<LinkPreview | null> {
  const watchUrl = `https://www.youtube.com/watch?v=${videoId}`
  const thumb = `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`
  let title: string | null = null
  let author: string | null = null
  try {
    const res = await fetch(
      `https://www.youtube.com/oembed?url=${encodeURIComponent(watchUrl)}&format=json`,
      { signal: AbortSignal.timeout(TIMEOUT_MS), headers: { 'user-agent': UA } },
    )
    if (res.ok) {
      const data = await res.json() as { title?: string; author_name?: string }
      title = data.title ?? null
      author = data.author_name ?? null
    }
  } catch { /* oEmbed недоступен — отдадим карточку без названия */ }

  return {
    url:         watchUrl,
    kind:        'video',
    siteName:    'YouTube',
    title:       title ? clamp(title, 200) : 'YouTube',
    description: author ? clamp(author, 100) : null,
    imageUrl:    thumb,
    embedUrl:    `https://www.youtube-nocookie.com/embed/${videoId}`,
  }
}

// ───────────────────────── публичный API ────────────────────────────────────

/**
 * Извлекает из текста сообщения ссылки, для которых имеет смысл превью.
 * Пропускает: код (``` и `inline`), markdown-картинки `![](url)` (это уже
 * гифки/скриншоты), а также Discord-подавление `<https://…>`. Дедуп + лимит.
 */
export function extractPreviewableUrls(content: string): string[] {
  let text = content
  text = text.replace(/```[\s\S]*?```/g, ' ')          // fenced code
  text = text.replace(/`[^`]*`/g, ' ')                  // inline code
  text = text.replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')     // markdown-картинки
  text = text.replace(/<https?:\/\/[^>\s]+>/gi, ' ')    // <url> — подавление

  const found = text.match(/\bhttps?:\/\/[^\s<>()"'`]+/gi) ?? []
  const seen = new Set<string>()
  const out: string[] = []
  for (const raw of found) {
    const url = raw.replace(/[.,;:!?»"')\]]+$/, '') // обрезаем хвостовую пунктуацию
    if (url.length < 12 || url.length > 2_000) continue
    if (seen.has(url)) continue
    seen.add(url)
    out.push(url)
    if (out.length >= MAX_PREVIEWS) break
  }
  return out
}

/** Одна ссылка → превью или null. С кэшем в Redis (в т.ч. негативным). */
export async function fetchLinkPreview(url: string): Promise<LinkPreview | null> {
  const key = CACHE_PREFIX + url
  try {
    const hit = await redis.get(key)
    if (hit !== null) return hit === '' ? null : (JSON.parse(hit) as LinkPreview)
  } catch { /* redis недоступен — идём в сеть */ }

  let preview: LinkPreview | null = null
  try {
    // YouTube — особый путь: встраиваемый плеер через oEmbed (скрейпинг
    // watch-страницы часто упирается в консент-редирект и даёт пустоту).
    const ytId = youtubeId(url)
    if (ytId) {
      preview = await youtubePreview(url, ytId)
    } else {
      const r = await fetchFollowing(url)
      if (r) {
        if (r.res.status === 200 && r.res.contentType.startsWith('image/')) {
          preview = { url: r.finalUrl, kind: 'image', siteName: null, title: null, description: null, imageUrl: r.finalUrl }
        } else if (r.res.body.length > 0) {
          preview = buildPreview(r.finalUrl, parseHead(r.res.body.toString('utf8')))
        }
      }
    }
  } catch { /* сетевые/SSRF-ошибки → негативный кэш */ }

  try {
    if (preview) await redis.set(key, JSON.stringify(preview), 'EX', CACHE_TTL_OK_S)
    else await redis.set(key, '', 'EX', CACHE_TTL_MISS_S)
  } catch { /* запись в кэш не критична */ }

  return preview
}

/** Достаёт превью для всех ссылок сообщения (параллельно, с лимитом). */
export async function resolvePreviewsForContent(content: string): Promise<LinkPreview[]> {
  const urls = extractPreviewableUrls(content)
  if (urls.length === 0) return []
  const results = await Promise.all(urls.map((u) => fetchLinkPreview(u)))
  return results.filter((p): p is LinkPreview => p !== null)
}
