// Грид элементов Klipy для одного типа (gifs / stickers / clips). Рендерится
// ИНЛАЙНОМ — скролл-контейнер и его ref даёт родитель (MediaPicker), чтобы на
// вкладке «Стикеры» серверная секция и Klipy-секция жили в одном скролле.
// query — контролируемый (поле поиска в шапке пикера общее на все вкладки).
//
// Лейаут по типу: gif/клип — masonry в 2 колонки (широкие превью), стикеры —
// сетка 3×N квадратами (прозрачные). Клип помечаем значком ▶/звука.

import { useEffect, useMemo, useRef } from 'react'
import { useInfiniteQuery } from '@tanstack/react-query'

import type { KlipyItem, KlipyMediaType } from '@kakdela/ginzu/api-types'

import { ApiError } from '../../lib/api.js'
import { klipySearch, klipyTrending } from '../klipy/api.js'

const PER_PAGE = 24

interface KlipyGridProps {
  type: KlipyMediaType
  query: string
  scrollRef: React.RefObject<HTMLDivElement | null>
  onPick: (item: KlipyItem) => void
  /** Если заданы — на masonry-тайлах (gif/клип) показываем звёздочку избранного
   *  ПО НАВЕДЕНИЮ (не висит постоянно). */
  isFav?: (item: KlipyItem) => boolean
  onToggleFav?: (item: KlipyItem) => void
}

/** Звёздочка избранного поверх тайла — видна только на hover (group-hover). */
function FavStar({ faved, onToggle }: { faved: boolean; onToggle: () => void }) {
  return (
    <button
      type="button"
      onClick={(e) => { e.stopPropagation(); onToggle() }}
      title={faved ? 'убрать из избранного' : 'в избранное'}
      className={`absolute top-1 right-1 w-6 h-6 flex items-center justify-center rounded text-[13px] leading-none bg-kd-overlay-strong opacity-0 group-hover:opacity-100 focus:opacity-100 transition-opacity ${faved ? 'text-kd-warm' : 'text-white'}`}
    >
      {faved ? '★' : '☆'}
    </button>
  )
}

export function KlipyGrid({ type, query, scrollRef, onPick, isFav, onToggleFav }: KlipyGridProps) {
  const q = query.trim()
  const isClip = type === 'clips'

  const query$ = useInfiniteQuery({
    queryKey: ['klipy', type, q],
    queryFn: ({ pageParam }) =>
      q ? klipySearch(type, q, { page: pageParam, perPage: PER_PAGE })
        : klipyTrending(type, { page: pageParam, perPage: PER_PAGE }),
    initialPageParam: 1,
    getNextPageParam: (last) => last.nextPage ?? undefined,
    staleTime: 5 * 60_000,
  })

  const items = useMemo(() => query$.data?.pages.flatMap((p) => p.items) ?? [], [query$.data])

  // Бесконечная подгрузка. Observer создаём один раз на (type+q), живые значения
  // читаем из ref — иначе пересоздание дёргало бы initial-callback и жгло лимит.
  const sentinelRef = useRef<HTMLDivElement>(null)
  const fetchNextRef = useRef(query$.fetchNextPage)
  const canFetchRef = useRef(false)
  fetchNextRef.current = query$.fetchNextPage
  canFetchRef.current = query$.hasNextPage === true && !query$.isFetchingNextPage

  useEffect(() => {
    const el = sentinelRef.current
    const root = scrollRef.current
    if (!el || !root) return
    const obs = new IntersectionObserver((entries) => {
      if (entries[0]?.isIntersecting && canFetchRef.current) void fetchNextRef.current()
    }, { root, rootMargin: '160px' })
    obs.observe(el)
    return () => obs.disconnect()
  }, [type, q, scrollRef])

  const errCode = query$.error instanceof ApiError ? query$.error.code : null
  const errMsg = query$.error instanceof ApiError ? query$.error.message : 'не удалось загрузить'

  if (query$.isError) {
    return (
      <div className="py-8 text-center px-4">
        <span className={`text-[11px] font-mono ${errCode === 'klipy-rate-limited' ? 'text-kd-warm' : 'text-kd-text-mute'}`}>
          {errCode === 'klipy-disabled' ? 'медиа-библиотека не настроена' : errMsg}
        </span>
      </div>
    )
  }
  if (query$.isLoading) {
    return <div className="py-8 text-center text-[11px] font-mono text-kd-text-mute">загружаем…</div>
  }
  if (items.length === 0) {
    return (
      <div className="py-8 text-center px-6 text-[11px] font-mono text-kd-text-mute">
        {q ? `по запросу «${q}» ничего не нашлось` : 'ничего не нашлось'}
      </div>
    )
  }

  return (
    <>
      {type === 'stickers' ? (
        <div className="grid grid-cols-3 gap-2">
          {items.map((it) => (
            <button
              key={it.id}
              type="button"
              onClick={() => onPick(it)}
              title={it.title || undefined}
              className="w-full aspect-square rounded-kd bg-kd-panel-alt hover:bg-kd-panel-hi border border-transparent hover:border-kd-accent flex items-center justify-center p-2 transition-colors"
            >
              <img src={it.previewUrl} alt={it.title} loading="lazy" draggable={false} className="max-w-full max-h-full object-contain" />
            </button>
          ))}
        </div>
      ) : (
        <div className="columns-2 gap-1.5 [column-fill:_balance]">
          {items.map((it) => (
            <div key={it.id} className="group relative mb-1.5 break-inside-avoid">
              <button
                type="button"
                onClick={() => onPick(it)}
                title={it.title || undefined}
                className="relative block w-full overflow-hidden rounded bg-kd-panel-alt hover:ring-2 hover:ring-kd-accent transition-shadow"
                style={{ aspectRatio: `${it.width} / ${it.height}` }}
              >
                <img src={it.previewUrl} alt={it.title} loading="lazy" className="w-full h-full object-cover" draggable={false} />
                {isClip && (
                  <span className="absolute left-1 bottom-1 px-1 py-0.5 rounded bg-kd-overlay-strong text-white text-[9px] font-mono font-bold leading-none select-none">
                    ▶ 🔊
                  </span>
                )}
              </button>
              {onToggleFav && <FavStar faved={isFav?.(it) ?? false} onToggle={() => onToggleFav(it)} />}
            </div>
          ))}
        </div>
      )}
      <div ref={sentinelRef} className="h-1 w-full" />
      {query$.isFetchingNextPage && (
        <div className="py-2 text-center text-[10px] font-mono text-kd-text-mute">…</div>
      )}
    </>
  )
}
