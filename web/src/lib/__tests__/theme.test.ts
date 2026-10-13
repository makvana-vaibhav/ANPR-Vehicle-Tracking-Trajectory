/**
 * Light and dark: the choice is the operator's, defaults to the system's,
 * survives a reload, and never breaks the page when storage is unavailable.
 */

import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  mapPalette,
  readThemeChoice,
  resetThemeForTests,
  resolveTheme,
  setThemeChoice,
  THEME_STORAGE_KEY,
  useTheme,
} from '@/lib/theme'

function systemPrefers(light: boolean) {
  vi.stubGlobal(
    'matchMedia',
    vi.fn((query: string) => ({
      matches: light && query.includes('light'),
      media: query,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })),
  )
}

/** jsdom here does not always expose localStorage, so give it one. */
function memoryStorage(): Storage {
  const data = new Map<string, string>()
  return {
    get length() {
      return data.size
    },
    clear: () => data.clear(),
    getItem: (key: string) => data.get(key) ?? null,
    key: (index: number) => [...data.keys()][index] ?? null,
    removeItem: (key: string) => void data.delete(key),
    setItem: (key: string, value: string) => void data.set(key, String(value)),
  }
}

beforeEach(() => {
  Object.defineProperty(window, 'localStorage', { value: memoryStorage(), configurable: true })
  resetThemeForTests()
  delete document.documentElement.dataset.theme
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('theme choice', () => {
  it('follows the system when nothing is stored', () => {
    systemPrefers(true)
    expect(readThemeChoice()).toBe('system')
    expect(resolveTheme('system')).toBe('light')
    systemPrefers(false)
    expect(resolveTheme('system')).toBe('dark')
  })

  it('is stored, applied to the document, and read back', () => {
    systemPrefers(false)
    setThemeChoice('light')
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe('light')
    expect(document.documentElement.dataset.theme).toBe('light')
    expect(document.documentElement.classList.contains('dark')).toBe(false)
    expect(readThemeChoice()).toBe('light')

    setThemeChoice('dark')
    expect(document.documentElement.dataset.theme).toBe('dark')
    expect(document.documentElement.classList.contains('dark')).toBe(true)

    // "System" forgets the stored choice rather than storing the word.
    setThemeChoice('system')
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBeNull()
  })

  it('survives storage that throws', () => {
    systemPrefers(true)
    const blocked = () => {
      throw new Error('blocked')
    }
    Object.defineProperty(window, 'localStorage', {
      value: { ...memoryStorage(), getItem: blocked, setItem: blocked, removeItem: blocked },
      configurable: true,
    })
    expect(readThemeChoice()).toBe('system')
    expect(() => setThemeChoice('dark')).not.toThrow()
    expect(document.documentElement.dataset.theme).toBe('dark')
  })

  it('ignores a stored value it does not know', () => {
    window.localStorage.setItem(THEME_STORAGE_KEY, 'sepia')
    expect(readThemeChoice()).toBe('system')
  })
})

describe('useTheme', () => {
  it('re-renders every user when the choice changes', () => {
    systemPrefers(false)
    const { result } = renderHook(() => useTheme())
    expect(result.current.choice).toBe('system')
    expect(result.current.resolved).toBe('dark')
    act(() => result.current.setChoice('light'))
    expect(result.current.choice).toBe('light')
    expect(result.current.resolved).toBe('light')
  })
})

describe('mapPalette', () => {
  it('gives the maps a light ground in light and a dark one in dark', () => {
    expect(mapPalette('dark').ground).toBe('#0A0E13')
    expect(mapPalette('light').ground).not.toBe(mapPalette('dark').ground)
    expect(mapPalette('light').trailRgb).toHaveLength(3)
  })
})
