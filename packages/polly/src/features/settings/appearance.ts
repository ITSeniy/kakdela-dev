// Внешний вид: акцентный цвет (designs/final-settings.jsx, блок «акцентный
// цвет»). Значения персистятся локально и применяются inline-переменными на
// <html>, перекрывая tokens.css.
//
// Акценты заданы одним hex'ом (база светлой темы); варианты для тёмной темы
// и производные (deep/soft/bg) выводятся через HSL. Дефолтный «мох» не ставит
// override'ов вовсе — остаются вручную подобранные значения из tokens.css.

import { create } from 'zustand'
import { persist } from 'zustand/middleware'

import { effectiveTheme, useThemeStore } from '../../lib/theme.js'

export interface AccentDef {
  id: string
  label: string
  /** Базовый цвет (значение --kd-accent светлой темы). */
  color: string
}

export const ACCENTS: AccentDef[] = [
  { id: 'moss',       label: 'мох',      color: '#5d6f4c' },
  { id: 'terracotta', label: 'терракот', color: '#c87a3a' },
  { id: 'chestnut',   label: 'каштан',   color: '#8a6e4d' },
  { id: 'walnut',     label: 'орех',     color: '#7d6e4d' },
  { id: 'sand',       label: 'песок',    color: '#9c7f5e' },
  { id: 'forest',     label: 'лесной',   color: '#6e6856' },
]

export const DEFAULT_ACCENT_ID = 'moss'

// Масштаб интерфейса — CSS zoom на <html> (Chromium: и WebView2, и браузер).
// «Маленький» — прежний 100%, дефолт — 125%.
export type UiScale = 'small' | 'medium' | 'large'

export const UI_SCALES: Array<{ id: UiScale; label: string; pct: number }> = [
  { id: 'small',  label: 'маленький', pct: 100 },
  { id: 'medium', label: 'средний',   pct: 125 },
  { id: 'large',  label: 'большой',   pct: 150 },
]

export const DEFAULT_UI_SCALE: UiScale = 'medium'

// CSS `zoom` на <html> масштабирует и слой position:fixed, но clientX/clientY
// курсора и window.innerWidth остаются в «визуальных» CSS-px. Поэтому любую
// координату, которую мы кладём в left/top fixed-меню, надо поделить на zoom —
// иначе на 125/150% меню уезжает от курсора (см. ContextMenu и пр.).
export function getUiZoom(): number {
  const { uiScale } = useAppearance.getState()
  const pct = UI_SCALES.find((s) => s.id === uiScale)?.pct ?? 100
  return pct / 100
}

/**
 * Пересчитывает визуальную координату (clientX/clientY, rect.right…) в
 * координату для left/top элемента с position:fixed и кламповит её в видимую
 * область. `size` и `visualViewport` — в CSS-px (innerWidth/innerHeight).
 */
export function clampFixed(
  visualCoord: number,
  size: number,
  visualViewport: number,
  pad = 8,
): number {
  const z = getUiZoom()
  const local = visualCoord / z
  const max = visualViewport / z - size - pad
  return Math.max(pad, Math.min(local, max))
}

interface AppearanceState {
  accentId: string
  /** Заливка строки под курсором (сообщения, участники голосовых). */
  hoverHighlight: boolean
  /** Ручное «уменьшить движение» поверх системного prefers-reduced-motion. */
  reduceMotion: boolean
  uiScale: UiScale
  setAccent(id: string): void
  setHoverHighlight(on: boolean): void
  setReduceMotion(on: boolean): void
  setUiScale(scale: UiScale): void
}

export const useAppearance = create<AppearanceState>()(
  persist(
    (set) => ({
      accentId: DEFAULT_ACCENT_ID,
      hoverHighlight: true,
      reduceMotion: false,
      uiScale: DEFAULT_UI_SCALE,
      setAccent: (accentId) => set({ accentId }),
      setHoverHighlight: (hoverHighlight) => set({ hoverHighlight }),
      setReduceMotion: (reduceMotion) => set({ reduceMotion }),
      setUiScale: (uiScale) => set({ uiScale }),
    }),
    { name: 'kd:appearance' },
  ),
)

// ───── HSL-математика для производных оттенков ─────

interface Hsl { h: number; s: number; l: number }

function hexToRgb(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16)
  return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff]
}

function hexToHsl(hex: string): Hsl {
  const [r8, g8, b8] = hexToRgb(hex)
  const r = r8 / 255, g = g8 / 255, b = b8 / 255
  const max = Math.max(r, g, b), min = Math.min(r, g, b)
  const l = (max + min) / 2
  if (max === min) return { h: 0, s: 0, l }
  const d = max - min
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min)
  let h: number
  if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6
  else if (max === g) h = ((b - r) / d + 2) / 6
  else h = ((r - g) / d + 4) / 6
  return { h, s, l }
}

function hslToHex({ h, s, l }: Hsl): string {
  function f(n: number): number {
    const k = (n + h * 12) % 12
    const a = s * Math.min(l, 1 - l)
    return l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1))
  }
  const to = (v: number) => Math.round(v * 255).toString(16).padStart(2, '0')
  return `#${to(f(0))}${to(f(8))}${to(f(4))}`
}

function lightness(base: Hsl, delta: number): Hsl {
  return { ...base, l: Math.min(0.92, Math.max(0.08, base.l + delta)) }
}

// ───── Применение к документу ─────

const ACCENT_VARS = ['--kd-accent', '--kd-accent-deep', '--kd-accent-soft', '--kd-accent-bg']

export function applyAppearance(): void {
  if (typeof document === 'undefined') return
  const root = document.documentElement
  const { accentId, uiScale, reduceMotion } = useAppearance.getState()

  if (reduceMotion) root.setAttribute('data-reduce-motion', 'true')
  else root.removeAttribute('data-reduce-motion')

  const pct = UI_SCALES.find((s) => s.id === uiScale)?.pct ?? 125
  if (pct === 100) root.style.removeProperty('zoom')
  else root.style.setProperty('zoom', `${pct}%`)

  const accent = ACCENTS.find((a) => a.id === accentId)
  if (!accent || accent.id === DEFAULT_ACCENT_ID) {
    for (const v of ACCENT_VARS) root.style.removeProperty(v)
    return
  }

  const dark = effectiveTheme(useThemeStore.getState().mode) === 'dark'
  const base = hexToHsl(accent.color)
  // Соотношения сняты с пары мох-светлый (#5d6f4c) ↔ мох-тёмный (#9bb083):
  // в тёмной теме акцент светлее базы на ~22 п.п., deep на ~10; soft — это
  // светлая «подложка» в light и тёмная в dark. Потолок светлоты 0.62 —
  // иначе изначально светлые базы (терракот, песок) уходят в пастель.
  const main = dark ? { ...base, l: Math.min(0.62, base.l + 0.22) } : base
  const deep = dark ? lightness(main, -0.12) : lightness(base, -0.10)
  const soft = dark ? lightness(base, -0.10) : lightness(base, 0.30)
  const [r, g, b] = hexToRgb(hslToHex(main))

  root.style.setProperty('--kd-accent', hslToHex(main))
  root.style.setProperty('--kd-accent-deep', hslToHex(deep))
  root.style.setProperty('--kd-accent-soft', hslToHex(soft))
  root.style.setProperty('--kd-accent-bg', `rgba(${r}, ${g}, ${b}, ${dark ? 0.14 : 0.12})`)
}

// Применяем при загрузке и на каждое изменение внешнего вида или темы —
// inline-переменные перекрывают обе темы, поэтому при смене light/dark
// акцент надо пересчитать.
if (typeof window !== 'undefined') {
  applyAppearance()
  useAppearance.subscribe(applyAppearance)
  useThemeStore.subscribe(applyAppearance)
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', applyAppearance)
}
