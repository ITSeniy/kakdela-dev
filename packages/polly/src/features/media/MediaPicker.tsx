// Единый пикер медиа для композера: вкладки Эмодзи · GIF · Стикеры · Клипы
// (мемы — позже, когда откроют Meme API на ключе). Раньше это были три
// отдельные кнопки/поповера — теперь одно окно с табами.
//
// Эмодзи — встроенный EmojiPicker (свой поиск/категории/★). GIF/Стикеры/Клипы —
// общий KlipyGrid с ОБЩИМ полем поиска сверху (ищет по активной вкладке).
// «Стикеры» = серверные (наши, MinIO) сверху + библиотека Klipy снизу. Маппинг
// KlipyItem → эмбед и share-триггер (attribution) — здесь же.

import { useMemo, useRef, useState } from 'react'

import type {
  ClipEmbed, CustomEmoji, GifEmbed, GifFavoritePayload, KlipyConfig, KlipyItem, Sticker, StickerRef,
} from '@kakdela/ginzu/api-types'

import { Icon } from '../../components/Icon.js'
import { EmojiPicker } from '../chat/EmojiPicker.js'
import { useFavorites } from '../favorites/api.js'
import { klipyShare } from '../klipy/api.js'
import { KlipyGrid } from './KlipyGrid.js'

type Tab = 'emoji' | 'gifs' | 'stickers' | 'clips'

interface MediaPickerProps {
  customEmoji?: ReadonlyArray<CustomEmoji>
  serverStickers: Sticker[]
  klipy: KlipyConfig
  /** С какой вкладки открыть (например, из мобильного AttachSheet). */
  initialTab?: Tab
  /** Вставка эмодзи-токена — пикер остаётся открытым (можно набрать несколько). */
  onEmoji: (token: string) => void
  /** Отправка gif/стикера/клипа — пикер закрывается (это делает вызывающий). */
  onGif: (gif: GifEmbed) => void
  onSticker: (sticker: StickerRef) => void
  onClip: (clip: ClipEmbed) => void
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div className="px-1 pt-1 pb-1.5 text-[10px] font-mono uppercase tracking-wider text-kd-text-mute select-none">
      {children}
    </div>
  )
}

export function MediaPicker({
  customEmoji, serverStickers, klipy, initialTab, onEmoji, onGif, onSticker, onClip,
}: MediaPickerProps) {
  const [q, setQ] = useState('')
  const scrollRef = useRef<HTMLDivElement>(null)

  const tabs = useMemo(() => {
    const out: Array<{ id: Tab; label: string }> = [{ id: 'emoji', label: 'Эмодзи' }]
    if (klipy.gifs) out.push({ id: 'gifs', label: 'GIF' })
    if (klipy.stickers || serverStickers.length > 0) out.push({ id: 'stickers', label: 'Стикеры' })
    if (klipy.clips) out.push({ id: 'clips', label: 'Клипы' })
    return out
  }, [klipy, serverStickers.length])

  const [wantTab, setTab] = useState<Tab>(initialTab ?? 'emoji')
  // Клампим на случай, если запрошенная вкладка недоступна (нет ключа/прав).
  const tab: Tab = tabs.some((t) => t.id === wantTab) ? wantTab : 'emoji'

  const serverFiltered = useMemo(() => {
    const term = q.trim().toLowerCase()
    if (!term) return serverStickers
    return serverStickers.filter((s) => s.name.toLowerCase().includes(term))
  }, [serverStickers, q])

  // Избранные гифки (per-user, бэкенд). refKey = url гифки; снимок payload
  // переживает изменения в Klipy.
  const gifFav = useFavorites('gif')
  function gifIsFav(it: KlipyItem) { return gifFav.byRef.has(it.url) }
  function toggleGifFav(it: KlipyItem) {
    const existing = gifFav.byRef.get(it.url)
    if (existing) gifFav.remove.mutate(existing.id)
    else gifFav.add.mutate({
      refKey: it.url,
      payload: { gifUrl: it.url, mp4Url: it.mp4Url, previewUrl: it.previewUrl, width: it.width, height: it.height, title: it.title },
    })
  }
  function sendFavGif(p: GifFavoritePayload) {
    onGif({ gifUrl: p.gifUrl, mp4Url: p.mp4Url, previewUrl: p.previewUrl, width: p.width, height: p.height })
  }

  function pickGif(it: KlipyItem) {
    klipyShare('gifs', it.slug)
    onGif({ gifUrl: it.url, mp4Url: it.mp4Url, previewUrl: it.previewUrl, width: it.width, height: it.height })
  }
  function pickClip(it: KlipyItem) {
    if (!it.mp4Url) return
    klipyShare('clips', it.slug)
    onClip({ mp4Url: it.mp4Url, gifUrl: it.url, previewUrl: it.previewUrl, width: it.width, height: it.height, title: it.title })
  }
  function pickKlipySticker(it: KlipyItem) {
    klipyShare('stickers', it.slug)
    onSticker({ stickerId: it.slug || it.id, name: it.title, imageUrl: it.url, width: it.width, height: it.height, source: 'klipy' })
  }
  function pickServerSticker(s: Sticker) {
    onSticker({ stickerId: s.id, name: s.name, imageUrl: s.imageUrl, width: s.width, height: s.height, source: 'server' })
  }

  return (
    <div className="w-[360px] h-[440px] bg-kd-panel border border-kd-border rounded-kd shadow-kd-modal flex flex-col overflow-hidden kd-pop-in">
      {/* Табы */}
      <div className="flex items-center gap-0.5 px-1.5 pt-1.5 shrink-0 border-b border-kd-border">
        {tabs.map((t) => (
          <button
            key={t.id}
            type="button"
            onClick={() => setTab(t.id)}
            className={`px-2.5 py-1.5 rounded-t text-[11px] font-mono font-semibold transition-colors ${
              tab === t.id ? 'bg-kd-accent-bg text-kd-accent' : 'text-kd-text-mute hover:bg-kd-hover'
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {tab === 'emoji' ? (
        <EmojiPicker embedded customEmoji={customEmoji} onSelect={onEmoji} />
      ) : (
        <>
          {/* Общий поиск (GIF/Стикеры/Клипы) */}
          <div className="px-2.5 py-2 border-b border-kd-border bg-kd-panel-alt shrink-0">
            <div className="flex items-center gap-2 px-2 py-1.5 rounded bg-kd-bg border border-kd-border">
              <Icon.Search size={13} className="text-kd-text-mute shrink-0" />
              <input
                type="text"
                value={q}
                onChange={(e) => setQ(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Escape' && q) { e.stopPropagation(); setQ('') } }}
                placeholder={tab === 'gifs' ? 'искать гифки…' : tab === 'clips' ? 'искать клипы…' : 'искать стикеры…'}
                autoFocus
                className="flex-1 min-w-0 bg-transparent outline-none text-[12px] text-kd-text placeholder:text-kd-text-mute"
              />
              {q && (
                <button type="button" onClick={() => setQ('')} title="очистить" className="shrink-0 text-kd-text-mute hover:text-kd-text">
                  <Icon.X size={13} />
                </button>
              )}
              {/* Атрибуция Klipy в строке поиска (требование лицензии). */}
              <span className="shrink-0 text-[9px] font-mono uppercase tracking-wide text-kd-text-mute select-none" title="поиск по библиотеке Klipy">
                Klipy
              </span>
            </div>
          </div>

          <div ref={scrollRef} className="flex-1 overflow-y-auto min-h-0 p-2">
            {tab === 'gifs' && (
              <>
                {/* «★ Избранное» — над трендами, только когда не ищем. */}
                {q === '' && gifFav.favorites.length > 0 && (
                  <div className="mb-2">
                    <SectionLabel>★ Избранное</SectionLabel>
                    <div className="columns-2 gap-1.5 [column-fill:_balance]">
                      {gifFav.favorites.map((f) => {
                        const p = f.payload as GifFavoritePayload
                        return (
                          <div key={f.id} className="group relative mb-1.5 break-inside-avoid">
                            <button
                              type="button"
                              onClick={() => sendFavGif(p)}
                              title={p.title || undefined}
                              className="relative block w-full overflow-hidden rounded bg-kd-panel-alt hover:ring-2 hover:ring-kd-accent transition-shadow"
                              style={{ aspectRatio: `${p.width} / ${p.height}` }}
                            >
                              <img src={p.previewUrl} alt={p.title} loading="lazy" className="w-full h-full object-cover" draggable={false} />
                            </button>
                            <button
                              type="button"
                              onClick={(e) => { e.stopPropagation(); gifFav.remove.mutate(f.id) }}
                              title="убрать из избранного"
                              className="absolute top-1 right-1 w-6 h-6 flex items-center justify-center rounded text-[13px] leading-none bg-kd-overlay-strong text-kd-warm opacity-0 group-hover:opacity-100 focus:opacity-100 transition-opacity"
                            >
                              ★
                            </button>
                          </div>
                        )
                      })}
                    </div>
                  </div>
                )}
                {q === '' && gifFav.favorites.length > 0 && <SectionLabel>Тренды</SectionLabel>}
                <KlipyGrid type="gifs" query={q} scrollRef={scrollRef} onPick={pickGif} isFav={gifIsFav} onToggleFav={toggleGifFav} />
              </>
            )}
            {tab === 'clips' && <KlipyGrid type="clips" query={q} scrollRef={scrollRef} onPick={pickClip} />}
            {tab === 'stickers' && (
              <>
                {serverFiltered.length > 0 && (
                  <div className="mb-2">
                    <SectionLabel>Сервер</SectionLabel>
                    <div className="grid grid-cols-3 gap-2">
                      {serverFiltered.map((s) => (
                        <button
                          key={s.id}
                          type="button"
                          onClick={() => pickServerSticker(s)}
                          title={s.name}
                          className="w-full aspect-square rounded-kd bg-kd-panel-alt hover:bg-kd-panel-hi border border-transparent hover:border-kd-accent flex items-center justify-center p-2 transition-colors"
                        >
                          <img src={s.imageUrl} alt={s.name} loading="lazy" draggable={false} className="max-w-full max-h-full object-contain" />
                        </button>
                      ))}
                    </div>
                  </div>
                )}
                {klipy.stickers && (
                  <>
                    {serverFiltered.length > 0 && <SectionLabel>Klipy</SectionLabel>}
                    <KlipyGrid type="stickers" query={q} scrollRef={scrollRef} onPick={pickKlipySticker} />
                  </>
                )}
                {!klipy.stickers && serverFiltered.length === 0 && (
                  <div className="py-8 text-center px-6 text-[11px] font-mono text-kd-text-mute">
                    {q ? 'ничего не нашлось' : 'добавь стикеры в настройках сервера'}
                  </div>
                )}
              </>
            )}
          </div>

          <div className="px-2.5 py-1.5 border-t border-kd-border bg-kd-panel-alt shrink-0 text-[9px] font-mono text-kd-text-mute select-none text-right">
            Powered by Klipy
          </div>
        </>
      )}
    </div>
  )
}

export default MediaPicker
