/**
 * The top bar's pursuit pill: there while a pursuit runs, on every screen,
 * linking back to its panel — and absent for a role that may not see one.
 */

import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import PursuitPill from '@/components/PursuitPill'
import * as api from '@/lib/api'

const auth = vi.hoisted(() => ({ permissions: new Set<string>(['search.execute']) }))
vi.mock('@/hooks/useAuth', () => ({
  useAuth: () => ({ can: (permission: string) => auth.permissions.has(permission) }),
}))

function summary(plate: string, minutes: number) {
  return {
    plate,
    started_at: new Date().toISOString(),
    started_by: 'operator',
    expires_at: new Date(Date.now() + minutes * 60_000 - 5_000).toISOString(),
    remaining_s: minutes * 60,
    pins: ['SBX-cam12'],
  }
}

function renderPill() {
  return render(
    <MemoryRouter>
      <PursuitPill />
    </MemoryRouter>,
  )
}

describe('PursuitPill', () => {
  beforeEach(() => {
    auth.permissions = new Set(['search.execute'])
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('names the plate and the time left, and links to its panel', async () => {
    vi.spyOn(api, 'listPursuits').mockResolvedValue({ pursuits: [summary('GJ01AB1234', 12)] })
    renderPill()
    const link = await screen.findByRole('link', { name: /GJ01AB1234/ })
    expect(link.textContent).toContain('12 min left')
    expect(link.getAttribute('href')).toBe('/vehicles?plate=GJ01AB1234&pursuit=1')
    expect(link.getAttribute('title')).toContain('pinned SBX-cam12')
  })

  it('measures the time left from when the pursuit arrives, not from when the bar mounted', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    try {
      const list = vi.spyOn(api, 'listPursuits').mockResolvedValue({ pursuits: [] })
      renderPill()
      await vi.advanceTimersByTimeAsync(5 * 60_000) // the bar has been up five minutes
      list.mockResolvedValue({ pursuits: [summary('GJ01AB1234', 15)] })
      await vi.advanceTimersByTimeAsync(15_000) // the next poll finds a fresh pursuit
      expect((await screen.findByRole('link')).textContent).toContain('15 min left')
    } finally {
      vi.useRealTimers()
    }
  })

  it('counts the others when more than one runs', async () => {
    vi.spyOn(api, 'listPursuits').mockResolvedValue({
      pursuits: [summary('GJ01AB1234', 12), summary('MH12DE1433', 5)],
    })
    renderPill()
    expect((await screen.findByRole('link')).textContent).toContain('+1')
  })

  it('is not there when nothing is pursued', async () => {
    vi.spyOn(api, 'listPursuits').mockResolvedValue({ pursuits: [] })
    renderPill()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(screen.queryByRole('link')).toBeNull()
  })

  it('does not ask at all for a role that may not search', async () => {
    auth.permissions = new Set()
    const list = vi.spyOn(api, 'listPursuits')
    renderPill()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(list).not.toHaveBeenCalled()
    expect(screen.queryByRole('link')).toBeNull()
  })
})
