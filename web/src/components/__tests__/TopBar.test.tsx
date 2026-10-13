/**
 * The top bar: plain workspace names, and the theme switch.
 */

import { fireEvent, render, screen, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import TopBar from '@/components/TopBar'
import { resetThemeForTests, THEME_STORAGE_KEY } from '@/lib/theme'

vi.mock('@/hooks/useAuth', () => ({
  useAuth: () => ({
    user: { id: 'u1', username: 'operator', full_name: 'Duty Operator', role: 'operator', permissions: [] },
    can: () => true,
    signOut: vi.fn(),
  }),
}))
vi.mock('@/hooks/useEventStream', () => ({ useEventStream: () => ({ status: 'live' }) }))
vi.mock('@/hooks/useOpenAlarms', () => ({ useOpenAlarms: () => ({ open: 2, critical: 0 }) }))
vi.mock('@/components/PursuitPill', () => ({ default: () => null }))

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
  vi.stubGlobal(
    'matchMedia',
    vi.fn(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() })),
  )
  resetThemeForTests()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

function renderBar(path = '/dashboard') {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <TopBar onOpenSearch={() => undefined} />
    </MemoryRouter>,
  )
}

describe('TopBar', () => {
  it('names the workspaces in plain words', () => {
    renderBar()
    const nav = screen.getByRole('navigation', { name: 'Workspaces' })
    const names = within(nav)
      .getAllByRole('link')
      .map((link) => link.textContent?.replace(/\d+$/, '').trim())
    expect(names).toEqual(['Overview', 'Live', 'Search', 'Alarms', 'Cameras', 'More'])
  })

  it('switches between dark and light in one click, and remembers it', () => {
    renderBar()
    fireEvent.click(screen.getByRole('button', { name: 'Switch to light theme' }))
    expect(document.documentElement.dataset.theme).toBe('light')
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe('light')
    fireEvent.click(screen.getByRole('button', { name: 'Switch to dark theme' }))
    expect(document.documentElement.dataset.theme).toBe('dark')
  })

  it('offers System, Light and Dark in the account menu', () => {
    renderBar()
    fireEvent.click(screen.getByRole('button', { name: /signed in as/i }))
    const group = screen.getByRole('radiogroup', { name: 'Theme' })
    const options = within(group).getAllByRole('radio')
    expect(options.map((o) => o.textContent)).toEqual(['System', 'Light', 'Dark'])
    expect(options[0]?.getAttribute('aria-checked')).toBe('true')
    fireEvent.click(within(group).getByRole('radio', { name: 'Light' }))
    expect(document.documentElement.dataset.theme).toBe('light')
    fireEvent.click(within(group).getByRole('radio', { name: 'System' }))
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBeNull()
    expect(document.documentElement.dataset.theme).toBe('dark')
  })

  it('groups traffic and administration under More', () => {
    renderBar('/traffic')
    const sub = screen.getByRole('navigation', { name: 'More screens' })
    expect(within(sub).getAllByRole('link').map((l) => l.textContent)).toEqual([
      'Traffic',
      'Accounts',
      'Audit trail',
    ])
  })
})
