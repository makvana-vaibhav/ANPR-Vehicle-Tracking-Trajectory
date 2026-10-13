/**
 * Light and dark.
 *
 * The console was dark-only, which suits a control-room wall and fails a
 * bright office or a laptop by a window. The operator chooses Light, Dark or
 * System (the default, following the operating system); the choice is kept in
 * this browser only.
 *
 * The theme is one attribute on <html> — `data-theme="light|dark"` — and every
 * colour in the product is a CSS variable that reads it (styles/index.css).
 * index.html sets the attribute before the first paint, so a light-theme
 * operator never sees a dark flash on load. Map paint cannot read CSS
 * variables, so maps take their colours from `mapPalette()` and repaint when
 * the theme changes (`useTheme`).
 */

import { useSyncExternalStore } from 'react'

export type ThemeChoice = 'system' | 'light' | 'dark'
export type ResolvedTheme = 'light' | 'dark'

export const THEME_STORAGE_KEY = 'contrail.theme'

/** The stored choice. Storage can be absent or throw (private windows, blocked
 *  site data) — the answer is then "system", never an error. */
export function readThemeChoice(): ThemeChoice {
  try {
    const value = window.localStorage.getItem(THEME_STORAGE_KEY)
    return value === 'light' || value === 'dark' ? value : 'system'
  } catch {
    return 'system'
  }
}

function writeThemeChoice(choice: ThemeChoice): void {
  try {
    if (choice === 'system') window.localStorage.removeItem(THEME_STORAGE_KEY)
    else window.localStorage.setItem(THEME_STORAGE_KEY, choice)
  } catch {
    /* the choice still applies for this page; it just is not remembered */
  }
}

function systemQuery(): MediaQueryList | null {
  try {
    return typeof window !== 'undefined' && typeof window.matchMedia === 'function'
      ? window.matchMedia('(prefers-color-scheme: light)')
      : null
  } catch {
    return null
  }
}

export function systemTheme(): ResolvedTheme {
  return systemQuery()?.matches ? 'light' : 'dark'
}

export function resolveTheme(choice: ThemeChoice): ResolvedTheme {
  return choice === 'system' ? systemTheme() : choice
}

/** Put the theme on the document. */
export function applyTheme(theme: ResolvedTheme): void {
  const root = document.documentElement
  root.dataset.theme = theme
  root.classList.toggle('dark', theme === 'dark')
  root.style.colorScheme = theme
}

// ── A tiny store, so every component that cares re-renders together ──

interface ThemeState {
  choice: ThemeChoice
  resolved: ResolvedTheme
}

let state: ThemeState | null = null
const listeners = new Set<() => void>()

function current(): ThemeState {
  if (state === null) {
    const choice = readThemeChoice()
    state = { choice, resolved: resolveTheme(choice) }
  }
  return state
}

function emit(next: ThemeState): void {
  state = next
  applyTheme(next.resolved)
  for (const listener of listeners) listener()
}

export function setThemeChoice(choice: ThemeChoice): void {
  writeThemeChoice(choice)
  emit({ choice, resolved: resolveTheme(choice) })
}

let watchingSystem = false
function watchSystem(): void {
  if (watchingSystem) return
  const query = systemQuery()
  if (!query) return
  watchingSystem = true
  const onChange = () => {
    const now = current()
    if (now.choice === 'system') emit({ choice: 'system', resolved: systemTheme() })
  }
  if (typeof query.addEventListener === 'function') query.addEventListener('change', onChange)
}

function subscribe(listener: () => void): () => void {
  watchSystem()
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** For tests: forget the cached state so the next read starts fresh. */
export function resetThemeForTests(): void {
  state = null
}

export function useTheme(): ThemeState & { setChoice: (choice: ThemeChoice) => void } {
  const snapshot = useSyncExternalStore(subscribe, current, current)
  return { ...snapshot, setChoice: setThemeChoice }
}

/** Apply the stored choice once, at start-up (main.tsx). index.html has
 *  usually done this already; doing it again is harmless. */
export function initTheme(): void {
  applyTheme(current().resolved)
  watchSystem()
}

// ── Map colours, by theme ─────────────────────────────────────────────

export interface MapPalette {
  /** Behind everything (sea, outside the districts). */
  ground: string
  /** Land: the district fill. */
  land: string
  /** District and road outlines. */
  boundary: string
  /** Roads on the offline route map. */
  road: string
  /** The trail colour, as an [r, g, b] triple for gradients. */
  trailRgb: readonly [number, number, number]
  trail: string
  critical: string
  /** A camera or a stop on the map. */
  place: string
}

const DARK_MAP: MapPalette = {
  ground: '#0A0E13',
  land: '#0F1620',
  boundary: '#1F2A36',
  road: '#2A3644',
  trailRgb: [92, 200, 255],
  trail: '#5CC8FF',
  critical: '#FF5C55',
  place: '#C9D3DD',
}

const LIGHT_MAP: MapPalette = {
  ground: '#DCE4EC',
  land: '#F7F9FB',
  boundary: '#B9C5D1',
  road: '#C5D0DB',
  trailRgb: [7, 117, 176],
  trail: '#0775B0',
  critical: '#C62828',
  place: '#3D4B5C',
}

export function mapPalette(theme: ResolvedTheme): MapPalette {
  return theme === 'light' ? LIGHT_MAP : DARK_MAP
}
