// Самописный пикер эмодзи. Раньше стоял @emoji-mart/react — он сильно лагал на
// скролле (тяжёлые внутренние observer'ы + компонент на каждую эмодзи) и не
// ложился в дизайн КакДела. Здесь — лёгкий рендерер поверх ДАННЫХ emoji-mart
// (это просто JSON, не он тормозил).
//
// Производительность (1870 эмодзи держим плавно):
//   • один onClick/onMouseOver на контейнер (event delegation) — кнопки-эмодзи
//     становятся дешёвыми DOM-нодами с data-атрибутами, без 1870 обработчиков;
//   • ЛЕНИВЫЙ МОНТАЖ секций через IntersectionObserver — на холодном открытии
//     монтируется только первый экран (+запас), остальные категории заполняются
//     по мере подкрутки и остаются смонтированными. Это убирает синхронный
//     монтаж 1870 кнопок при открытии (главный тормоз) и сглаживает скролл;
//   • индекс поиска строится ЛЕНИВО при первом вводе, не на старте;
//   • сетка секций мемоизирована — скролл-spy меняет активную вкладку, но не
//     перерисовывает ячейки.
//
// Контракт пропсов 1:1 со старым компонентом (drop-in): onSelect(token) +
// опциональный customEmoji. Тема берётся из CSS-токенов (--kd-*), читать
// data-theme не нужно — всё переключается само.

import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import rawData from '@emoji-mart/data'
import type { EmojiMartData } from '@emoji-mart/data'

import type { CustomEmoji, EmojiFavoritePayload } from '@kakdela/ginzu/api-types'

import { Icon } from '../../components/Icon.js'
import { useFavorites } from '../favorites/api.js'

const DATA = rawData as EmojiMartData

const COLS = 8
const ROW = 38 // шаг ряда (ячейка + gap) — для резерва высоты несмонтированных секций
const HEADER_H = 30 // высота sticky-заголовка категории, px
const MAX_SEARCH = 90 // потолок результатов поиска, чтобы сетка оставалась лёгкой
const PREFETCH = 700 // px: сколько контента монтируем сверх первого экрана
const FREQ_KEY = 'kd:emoji:frequent'
const FREQ_MAX = 24 // 3 ряда по 8

// Русские подписи + эмодзи-иконки вкладок. Эмодзи как иконка — без новых
// зависимостей и читается понятнее абстрактного глифа.
const CATEGORY_META: Record<string, { label: string; icon: string }> = {
  frequent: { label: 'Недавние', icon: '🕓' },
  people:   { label: 'Смайлики', icon: '😀' },
  nature:   { label: 'Природа',  icon: '🐶' },
  foods:    { label: 'Еда',      icon: '🍔' },
  activity: { label: 'Занятия',  icon: '⚽' },
  places:   { label: 'Места',    icon: '✈️' },
  objects:  { label: 'Объекты',  icon: '💡' },
  symbols:  { label: 'Символы',  icon: '❤️' },
  flags:    { label: 'Флаги',    icon: '🏁' },
}

// Универсальная ячейка: token — что вставится в composer, imageUrl задан только
// у кастомных серверных эмодзи (рендерим <img>), у нативных — рисуем сам символ.
interface RenderEntry {
  token: string
  name: string
  imageUrl?: string
}

interface RenderSection {
  id: string
  label: string
  entries: RenderEntry[]
}

interface Tab {
  id: string
  label: string
  icon: string
  imageUrl?: string
}

// --- Статический индекс (строится один раз при импорте чанка) ----------------
// Весь пикер лениво подгружается (React.lazy во всех местах вызова), так что эта
// работа и сам JSON попадают в отдельный чанк, а не в основной бандл. Держим её
// лёгкой — только token+name, без конкатенации строк поиска.

const NATIVE_SECTIONS: { id: string; emojis: RenderEntry[] }[] = DATA.categories.map((cat) => ({
  id: cat.id,
  emojis: cat.emojis.flatMap((eid) => {
    const e = DATA.emojis[eid]
    const native = e?.skins[0]?.native
    return e && native ? [{ token: native, name: e.name }] : []
  }),
}))

const NATIVE_NAME_BY_TOKEN = new Map<string, string>()
for (const s of NATIVE_SECTIONS) for (const e of s.emojis) NATIVE_NAME_BY_TOKEN.set(e.token, e.name)

// Индекс поиска строим ЛЕНИВО (первый ввод), чтобы не лопатить 1870 строк с
// keyword'ами на холодном открытии пикера.
interface SearchItem { token: string; name: string; hay: string }
let SEARCH_INDEX: SearchItem[] | null = null
function getSearchIndex(): SearchItem[] {
  if (SEARCH_INDEX) return SEARCH_INDEX
  const out: SearchItem[] = []
  for (const cat of DATA.categories) {
    for (const eid of cat.emojis) {
      const e = DATA.emojis[eid]
      const native = e?.skins[0]?.native
      if (e && native) out.push({ token: native, name: e.name, hay: `${e.id} ${e.name} ${e.keywords.join(' ')}`.toLowerCase() })
    }
  }
  SEARCH_INDEX = out
  return out
}

// --- localStorage: недавно использованные --------------------------------------

function loadFrequent(): string[] {
  try {
    const raw = localStorage.getItem(FREQ_KEY)
    if (!raw) return []
    const arr: unknown = JSON.parse(raw)
    if (!Array.isArray(arr)) return []
    return arr.filter((x): x is string => typeof x === 'string').slice(0, FREQ_MAX)
  } catch {
    return []
  }
}

// Пишем без setState: «недавние» должны быть свежими к СЛЕДУЮЩЕМУ открытию
// пикера, а текущий обычно закрывается сразу после выбора.
function saveFrequent(token: string): void {
  try {
    const next = [token, ...loadFrequent().filter((t) => t !== token)].slice(0, FREQ_MAX)
    localStorage.setItem(FREQ_KEY, JSON.stringify(next))
  } catch {
    // приватный режим / web без доступа к localStorage — «недавние» просто не копятся
  }
}

// --- Презентационные подкомпоненты ---------------------------------------------

function Grid({ entries }: { entries: RenderEntry[] }) {
  return (
    <div className="grid gap-0.5" style={{ gridTemplateColumns: `repeat(${COLS}, minmax(0, 1fr))` }}>
      {entries.map((e) => (
        <button
          key={e.token}
          type="button"
          data-token={e.token}
          data-name={e.name}
          data-img={e.imageUrl}
          title={e.name}
          className="h-[36px] flex items-center justify-center rounded-md text-[21px] leading-none hover:bg-kd-hover transition-colors"
        >
          {e.imageUrl
            ? <img src={e.imageUrl} alt="" loading="lazy" draggable={false} className="w-[22px] h-[22px] object-contain" />
            : e.token}
        </button>
      ))}
    </div>
  )
}

interface SectionProps {
  section: RenderSection
  scrollRef: React.RefObject<HTMLDivElement | null>
  registerSection: (id: string, el: HTMLDivElement | null) => void
  defaultShown: boolean
}

// Ленивая секция: пока не попала в зону видимости (+запас PREFETCH) — рендерит
// только заголовок и распорку нужной высоты (скроллбар не прыгает). Как только
// смонтировалась — остаётся (скролл назад мгновенный, без ремонтирования).
function SectionBlock({ section, scrollRef, registerSection, defaultShown }: SectionProps) {
  const [shown, setShown] = useState(defaultShown)
  const ref = useRef<HTMLDivElement | null>(null)

  const setRef = useCallback((el: HTMLDivElement | null) => {
    ref.current = el
    registerSection(section.id, el)
  }, [registerSection, section.id])

  useEffect(() => {
    if (shown) return
    const el = ref.current
    if (!el) return
    const io = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting) {
          setShown(true)
          io.disconnect()
        }
      },
      { root: scrollRef.current, rootMargin: `${PREFETCH}px 0px` },
    )
    io.observe(el)
    return () => io.disconnect()
  }, [shown, scrollRef])

  const rows = Math.ceil(section.entries.length / COLS)
  return (
    <div ref={setRef}>
      <div className="sticky top-0 z-10 bg-kd-panel px-1 pt-2 pb-1 text-[10px] font-mono uppercase tracking-wider text-kd-text-mute select-none">
        {section.label}
      </div>
      {shown
        ? <Grid entries={section.entries} />
        : <div style={{ height: rows * ROW }} aria-hidden />}
    </div>
  )
}

interface ScrollProps {
  scrollRef: React.RefObject<HTMLDivElement | null>
  sections: RenderSection[]
  eagerCount: number
  search: RenderEntry[] | null
  onPick: (e: React.MouseEvent) => void
  onHover: (e: React.MouseEvent) => void
  onContext: (e: React.MouseEvent) => void
  registerSection: (id: string, el: HTMLDivElement | null) => void
}

// Мемоизирован: при скролле родитель меняет активную вкладку и перерисовывается,
// но сюда приходят те же ссылки на пропсы → React.memo пропускает рендер. А
// мемоизация sectionNodes гарантирует, что ввод в поиск не перетряхивает сетку
// категорий (прячем её через display:none, ноды остаются в DOM).
const EmojiScroll = memo(function EmojiScroll({
  scrollRef,
  sections,
  eagerCount,
  search,
  onPick,
  onHover,
  onContext,
  registerSection,
}: ScrollProps) {
  const sectionNodes = useMemo(
    () => sections.map((s, i) => (
      <SectionBlock
        key={s.id}
        section={s}
        scrollRef={scrollRef}
        registerSection={registerSection}
        defaultShown={i < eagerCount}
      />
    )),
    [sections, scrollRef, registerSection, eagerCount],
  )

  return (
    <div
      ref={scrollRef}
      onClick={onPick}
      onMouseOver={onHover}
      onContextMenu={onContext}
      className="relative flex-1 min-h-0 overflow-y-auto overflow-x-hidden px-1.5 py-1"
    >
      <div className={search !== null ? 'hidden' : undefined}>{sectionNodes}</div>

      {search !== null && (
        search.length === 0
          ? <div className="absolute inset-0 flex items-center justify-center text-[11px] font-mono text-kd-text-mute">ничего не нашлось</div>
          : (
            <div>
              <div className="sticky top-0 z-10 bg-kd-panel px-1 pt-2 pb-1 text-[10px] font-mono uppercase tracking-wider text-kd-text-mute select-none">
                Результаты
              </div>
              <Grid entries={search} />
            </div>
          )
      )}
    </div>
  )
})

function TabBar({
  tabs,
  activeId,
  onTab,
}: {
  tabs: Tab[]
  activeId: string
  onTab: (id: string) => void
}) {
  return (
    <div className="flex items-center gap-0.5 px-1.5 py-1 border-b border-kd-border bg-kd-panel-alt shrink-0 overflow-x-auto">
      {tabs.map((t) => (
        <button
          key={t.id}
          type="button"
          onClick={() => onTab(t.id)}
          title={t.label}
          className={`shrink-0 w-7 h-7 flex items-center justify-center rounded text-[15px] leading-none transition-colors ${
            activeId === t.id ? 'bg-kd-accent-bg text-kd-accent' : 'text-kd-text-soft hover:bg-kd-hover'
          }`}
        >
          {t.imageUrl
            ? <img src={t.imageUrl} alt="" draggable={false} className="w-4 h-4 object-contain" />
            : t.icon}
        </button>
      ))}
    </div>
  )
}

// --- Основной компонент ---------------------------------------------------------

interface EmojiPickerProps {
  /** Native unicode emoji (`😀`) → строка-emoji; custom (`:name:`) → текст-токен. */
  onSelect: (token: string) => void
  /** Если задан — добавляется первая категория «Сервер» с этими emoji. */
  customEmoji?: ReadonlyArray<CustomEmoji>
  /** Внутри вкладки общего пикера — без своей рамки/размера/поп-ина. */
  embedded?: boolean
}

export function EmojiPicker({ onSelect, customEmoji, embedded = false }: EmojiPickerProps) {
  const [query, setQuery] = useState('')
  const [activeCat, setActiveCat] = useState('people')

  const scrollRef = useRef<HTMLDivElement>(null)
  const previewImgRef = useRef<HTMLImageElement>(null)
  const previewGlyphRef = useRef<HTMLSpanElement>(null)
  const previewNameRef = useRef<HTMLSpanElement>(null)
  const sectionEls = useRef(new Map<string, HTMLDivElement>())
  // «Недавние» фиксируем на момент открытия — не дёргаем стейт при выборе.
  const [frequentTokens] = useState(loadFrequent)

  // Избранное эмодзи (бэкенд). favRef держим для стабильного onContext —
  // иначе мемоизированный EmojiScroll ререндерился бы на каждое изменение fav.
  const fav = useFavorites('emoji')
  const favRef = useRef(fav)
  favRef.current = fav

  const customMap = useMemo(() => {
    const m = new Map<string, CustomEmoji>()
    for (const e of customEmoji ?? []) m.set(e.name, e)
    return m
  }, [customEmoji])

  const favoriteEntries = useMemo<RenderEntry[]>(() => {
    return fav.favorites.map((f) => {
      const p = f.payload as EmojiFavoritePayload
      const name = p.imageUrl
        ? p.token.replace(/^:|:$/g, '')
        : (NATIVE_NAME_BY_TOKEN.get(p.token) ?? p.token)
      return { token: p.token, name, imageUrl: p.imageUrl ?? undefined }
    })
  }, [fav.favorites])

  const customEntries = useMemo<RenderEntry[]>(
    () => (customEmoji ?? []).map((e) => ({ token: `:${e.name}:`, name: e.name, imageUrl: e.imageUrl })),
    [customEmoji],
  )

  const frequentEntries = useMemo<RenderEntry[]>(() => {
    const out: RenderEntry[] = []
    for (const token of frequentTokens) {
      if (token.startsWith(':') && token.endsWith(':')) {
        const ce = customMap.get(token.slice(1, -1))
        // кастом с чужого сервера не резолвится — пропускаем, чтобы не было битой плитки
        if (ce) out.push({ token, name: ce.name, imageUrl: ce.imageUrl })
      } else {
        out.push({ token, name: NATIVE_NAME_BY_TOKEN.get(token) ?? token })
      }
    }
    return out
  }, [frequentTokens, customMap])

  const sections = useMemo<RenderSection[]>(() => {
    const out: RenderSection[] = []
    if (favoriteEntries.length) out.push({ id: 'kd-fav', label: 'Избранное', entries: favoriteEntries })
    if (customEntries.length) out.push({ id: 'kd-server', label: 'Сервер', entries: customEntries })
    if (frequentEntries.length) out.push({ id: 'frequent', label: CATEGORY_META.frequent!.label, entries: frequentEntries })
    for (const s of NATIVE_SECTIONS) {
      out.push({ id: s.id, label: CATEGORY_META[s.id]?.label ?? s.id, entries: s.emojis })
    }
    return out
  }, [favoriteEntries, customEntries, frequentEntries])

  // Сколько секций смонтировать сразу (первый экран + запас), чтобы при открытии
  // не было пустых распорок, но и не монтировать все 1870 кнопок синхронно.
  const eagerCount = useMemo(() => {
    let acc = 0
    let n = 0
    for (const s of sections) {
      acc += HEADER_H + Math.ceil(s.entries.length / COLS) * ROW
      n += 1
      if (acc > PREFETCH) break
    }
    return Math.max(n, 1)
  }, [sections])

  const tabs = useMemo<Tab[]>(() => {
    const out: Tab[] = []
    if (favoriteEntries.length) out.push({ id: 'kd-fav', label: 'Избранное', icon: '★' })
    if (customEntries.length) out.push({ id: 'kd-server', label: 'Сервер', icon: '⭐', imageUrl: customEntries[0]?.imageUrl })
    if (frequentEntries.length) out.push({ id: 'frequent', label: CATEGORY_META.frequent!.label, icon: CATEGORY_META.frequent!.icon })
    for (const s of NATIVE_SECTIONS) {
      out.push({ id: s.id, label: CATEGORY_META[s.id]?.label ?? s.id, icon: CATEGORY_META[s.id]?.icon ?? '•' })
    }
    return out
  }, [favoriteEntries, customEntries, frequentEntries])

  const q = query.trim().toLowerCase()
  const searching = q.length > 0

  const search = useMemo<RenderEntry[] | null>(() => {
    if (!q) return null
    const terms = q.split(/\s+/)
    const match = (hay: string) => terms.every((t) => hay.includes(t))
    const out: RenderEntry[] = []
    for (const e of customEntries) if (match(e.name.toLowerCase())) out.push(e)
    for (const e of getSearchIndex()) {
      if (match(e.hay)) {
        out.push(e)
        if (out.length >= MAX_SEARCH) break
      }
    }
    return out
  }, [q, customEntries])

  const registerSection = useCallback((id: string, el: HTMLDivElement | null) => {
    if (el) sectionEls.current.set(id, el)
    else sectionEls.current.delete(id)
  }, [])

  const onPick = useCallback((e: React.MouseEvent) => {
    const btn = (e.target as HTMLElement).closest<HTMLButtonElement>('button[data-token]')
    const token = btn?.dataset.token
    if (!token) return
    saveFrequent(token)
    onSelect(token)
  }, [onSelect])

  // ПКМ по эмодзи — добавить/убрать из избранного (стабильно через favRef).
  const onContext = useCallback((e: React.MouseEvent) => {
    const btn = (e.target as HTMLElement).closest<HTMLButtonElement>('button[data-token]')
    const token = btn?.dataset.token
    if (!token) return
    e.preventDefault()
    const f = favRef.current
    const existing = f.byRef.get(token)
    if (existing) f.remove.mutate(existing.id)
    else f.add.mutate({ refKey: token, payload: { token, imageUrl: btn!.dataset.img ?? null } })
  }, [])

  // Превью наведённой эмодзи обновляем императивно через ref — иначе hover по
  // сетке дёргал бы setState на каждое движение мыши и перерисовывал бы её.
  // Для кастомных эмодзи показываем картинку (data-img), для нативных — глиф.
  const onHover = useCallback((e: React.MouseEvent) => {
    const btn = (e.target as HTMLElement).closest<HTMLButtonElement>('button[data-token]')
    if (!btn) return
    const img = previewImgRef.current
    const glyph = previewGlyphRef.current
    const url = btn.dataset.img
    if (url) {
      if (img) { img.src = url; img.classList.remove('hidden') }
      if (glyph) glyph.textContent = ''
    } else {
      if (img) img.classList.add('hidden')
      if (glyph) glyph.textContent = btn.dataset.token ?? ''
    }
    if (previewNameRef.current) previewNameRef.current.textContent = btn.dataset.name ?? ''
  }, [])

  const onTab = useCallback((id: string) => {
    setQuery('')
    setActiveCat(id)
    // двойной rAF: даём React закоммитить (если уходили из поиска) до scrollTo
    requestAnimationFrame(() => requestAnimationFrame(() => {
      const el = sectionEls.current.get(id)
      const root = scrollRef.current
      if (el && root) root.scrollTo({ top: el.offsetTop })
    }))
  }, [])

  // Скролл-spy: подсвечиваем вкладку секции, чья граница ближе всего сверху.
  // Меняет только activeCat (дешёвый TabBar); мемоизированный EmojiScroll не
  // трогается. При активном поиске секций нет — пропускаем.
  useEffect(() => {
    const root = scrollRef.current
    if (!root || searching) return
    let raf = 0
    const onScroll = () => {
      if (raf) return
      raf = requestAnimationFrame(() => {
        raf = 0
        const top = root.scrollTop + 4
        let current = tabs[0]?.id ?? 'people'
        for (const t of tabs) {
          const el = sectionEls.current.get(t.id)
          if (el && el.offsetTop <= top) current = t.id
          else break // секции идут в DOM-порядке
        }
        setActiveCat((prev) => (prev === current ? prev : current))
      })
    }
    root.addEventListener('scroll', onScroll, { passive: true })
    onScroll()
    return () => {
      root.removeEventListener('scroll', onScroll)
      if (raf) cancelAnimationFrame(raf)
    }
  }, [tabs, searching])

  return (
    <div
      className={embedded
        ? 'flex-1 min-h-0 flex flex-col overflow-hidden'
        : 'w-[352px] h-[380px] bg-kd-panel border border-kd-border rounded-kd shadow-kd-modal flex flex-col overflow-hidden kd-pop-in'}
    >
      <div className="px-2 py-2 border-b border-kd-border bg-kd-panel-alt shrink-0">
        <div className="flex items-center gap-2 px-2 py-1.5 rounded bg-kd-bg border border-kd-border">
          <Icon.Search size={13} className="text-kd-text-mute shrink-0" />
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Escape' && query) { e.stopPropagation(); setQuery('') } }}
            placeholder="искать эмодзи…"
            autoFocus
            className="flex-1 min-w-0 bg-transparent outline-none text-[12px] text-kd-text placeholder:text-kd-text-mute"
          />
          {query && (
            <button type="button" onClick={() => setQuery('')} title="очистить" className="shrink-0 text-kd-text-mute hover:text-kd-text">
              <Icon.X size={13} />
            </button>
          )}
        </div>
      </div>

      <TabBar tabs={tabs} activeId={searching ? '' : activeCat} onTab={onTab} />

      <EmojiScroll
        scrollRef={scrollRef}
        sections={sections}
        eagerCount={eagerCount}
        search={search}
        onPick={onPick}
        onHover={onHover}
        onContext={onContext}
        registerSection={registerSection}
      />

      <div className="px-2.5 h-[30px] flex items-center gap-2 border-t border-kd-border bg-kd-panel-alt shrink-0">
        <img ref={previewImgRef} alt="" draggable={false} className="w-[18px] h-[18px] object-contain hidden" />
        <span ref={previewGlyphRef} className="text-[18px] leading-none" />
        <span ref={previewNameRef} className="text-[11px] font-mono text-kd-text-mute truncate">выбери эмодзи</span>
        <span className="ml-auto shrink-0 text-[9px] font-mono text-kd-text-mute select-none">ПКМ — ★</span>
      </div>
    </div>
  )
}

export default EmojiPicker
