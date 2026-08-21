// Клиент медиа-библиотеки Klipy (GIF / стикеры / клипы). Ключ и customer_id
// живут на сервере — сюда приходит уже нормализованный KlipyItem. Пагинация —
// по страницам (page, начиная с 1); nextPage=null означает конец.

import type { KlipyConfig, KlipyMediaType, KlipyResponse } from '@kakdela/ginzu/api-types'

import { apiFetch } from '../../lib/api.js'

export async function getKlipyConfig(): Promise<KlipyConfig> {
  return apiFetch<KlipyConfig>('/api/klipy/config')
}

export async function klipyTrending(
  type: KlipyMediaType,
  opts: { page?: number; perPage?: number } = {},
): Promise<KlipyResponse> {
  const p = new URLSearchParams()
  if (opts.page) p.set('page', String(opts.page))
  if (opts.perPage) p.set('per_page', String(opts.perPage))
  const qs = p.toString()
  return apiFetch<KlipyResponse>(`/api/klipy/${type}/trending${qs ? '?' + qs : ''}`)
}

export async function klipySearch(
  type: KlipyMediaType,
  q: string,
  opts: { page?: number; perPage?: number } = {},
): Promise<KlipyResponse> {
  const p = new URLSearchParams({ q })
  if (opts.page) p.set('page', String(opts.page))
  if (opts.perPage) p.set('per_page', String(opts.perPage))
  return apiFetch<KlipyResponse>(`/api/klipy/${type}/search?${p.toString()}`)
}

// Share-триггер (attribution): дёргаем при отправке элемента, ошибки глушим.
export function klipyShare(type: KlipyMediaType, slug: string): void {
  if (!slug) return
  void apiFetch<null>(`/api/klipy/${type}/share/${encodeURIComponent(slug)}`, { method: 'POST' })
    .catch(() => { /* attribution best-effort */ })
}
