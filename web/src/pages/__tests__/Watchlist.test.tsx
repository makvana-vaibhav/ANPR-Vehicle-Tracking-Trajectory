/**
 * The watchlist: what is watched, what was retired and can come back, and who
 * may change either.
 */

import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { ToastProvider } from '@/components/Toast'
import * as api from '@/lib/api'
import { PERMISSIONS } from '@/lib/permissions'
import type { WatchlistEntry } from '@/lib/types'
import Watchlist, { bySeverity, matchesFilter } from '@/pages/Watchlist'

const auth = vi.hoisted(() => ({ permissions: new Set<string>() }))
vi.mock('@/hooks/useAuth', () => ({
  useAuth: () => ({ can: (permission: string) => auth.permissions.has(permission) }),
}))

function entry(id: string, plate: string, overrides: Partial<WatchlistEntry> = {}): WatchlistEntry {
  return {
    id,
    plate_normalised: plate,
    category: 'stolen',
    priority: 'high',
    case_ref: `FIR/${id}`,
    remarks: null,
    valid_from: null,
    valid_to: null,
    active: true,
    added_by: null,
    created_at: '2026-09-13T03:07:59Z',
    ...overrides,
  }
}

const WATCHED = entry('w1', 'GJ03AB1234', { priority: 'critical', remarks: 'Kalawad Road' })
const WANTED = entry('w2', 'GJ18W3962', { category: 'wanted' })
const RETIRED = entry('w3', 'EY61NBG', { active: false })
// A retired entry for a plate that is watched again under another case.
const RETIRED_CLASH = entry('w4', 'GJ03AB1234', { active: false, case_ref: 'FIR/old' })

function renderPage() {
  return render(
    <ToastProvider>
      <MemoryRouter>
        <Watchlist />
      </MemoryRouter>
    </ToastProvider>,
  )
}

const tableRows = (label: string) => {
  const heading = screen.getByText(label, { exact: false, selector: 'h2' })
  const section = heading.closest('section')!
  return within(section).getAllByRole('row').slice(1)
}

describe('Watchlist page', () => {
  beforeEach(() => {
    auth.permissions = new Set([
      PERMISSIONS.watchlistRead,
      PERMISSIONS.watchlistCreate,
      PERMISSIONS.watchlistUpdate,
    ])
    vi.spyOn(api, 'getWatchlist').mockResolvedValue([WANTED, WATCHED, RETIRED, RETIRED_CLASH])
    vi.spyOn(api, 'addToWatchlist').mockResolvedValue(WATCHED)
    vi.spyOn(api, 'updateWatchlistEntry').mockResolvedValue(WATCHED)
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('asks for retired entries too, so they can be listed and brought back', async () => {
    renderPage()
    await screen.findByText('Watched now')
    expect(api.getWatchlist).toHaveBeenCalledWith(expect.objectContaining({ active_only: 'false' }))
    expect(await screen.findByText('Retired (2)', { exact: false })).toBeTruthy()
  })

  it('lists the watched plates most severe first, drawn as plates', async () => {
    renderPage()
    await screen.findByText('Retired (2)', { exact: false })
    const plates = tableRows('Watched now').map((row) => row.querySelector('.plate-text')?.textContent)
    expect(plates).toEqual(['GJ 03 AB 1234', 'GJ 18 W 3962'])
  })

  it('will not reinstate a plate that is already watched under another entry', async () => {
    renderPage()
    await screen.findByText('Retired (2)', { exact: false })
    const reinstate = screen.getAllByRole('button', { name: 'Reinstate' }) as HTMLButtonElement[]
    // Retired rows are sorted like the live ones; find each by its case.
    const byCase = (ref: string) =>
      reinstate.find((button) => button.closest('tr')?.textContent?.includes(ref))!
    expect(byCase('FIR/old').disabled).toBe(true)
    expect(byCase('FIR/w3').disabled).toBe(false)

    fireEvent.click(byCase('FIR/w3'))
    await waitFor(() => expect(api.updateWatchlistEntry).toHaveBeenCalledWith('w3', { active: true }))
  })

  it('retires rather than deletes', async () => {
    renderPage()
    await screen.findByText('Retired (2)', { exact: false })
    const row = tableRows('Watched now')[0]!
    fireEvent.click(within(row).getByRole('button', { name: 'Retire' }))
    await waitFor(() => expect(api.updateWatchlistEntry).toHaveBeenCalledWith('w1', { active: false }))
  })

  it('adds a plate in its stored form, with its case and reason', async () => {
    renderPage()
    await screen.findByText('Watched now')
    const form = screen.getByRole('complementary', { name: 'Add a plate' })
    fireEvent.change(within(form).getByPlaceholderText('GJ03AB1234'), { target: { value: 'gj-05 cd 6789' } })
    fireEvent.change(within(form).getByPlaceholderText('FIR/2026/0142'), { target: { value: 'FIR/2026/0999' } })
    fireEvent.change(within(form).getByPlaceholderText('Reported stolen, Rajkot City'), {
      target: { value: 'Reported stolen' },
    })
    fireEvent.click(within(form).getByRole('button', { name: /Add to watchlist/ }))
    await waitFor(() =>
      expect(api.addToWatchlist).toHaveBeenCalledWith({
        plate: 'GJ05CD6789',
        category: 'stolen',
        priority: 'critical',
        case_ref: 'FIR/2026/0999',
        remarks: 'Reported stolen',
      }),
    )
  })

  it('says before submitting that a plate is already watched', async () => {
    renderPage()
    await screen.findByText('Retired (2)', { exact: false })
    const form = screen.getByRole('complementary', { name: 'Add a plate' })
    fireEvent.change(within(form).getByPlaceholderText('GJ03AB1234'), { target: { value: 'GJ 03 AB 1234' } })
    expect(within(form).getByText(/Already watched under FIR\/w1/)).toBeTruthy()
  })

  it('amends priority, category and remarks — never the case', async () => {
    renderPage()
    await screen.findByText('Retired (2)', { exact: false })
    fireEvent.click(within(tableRows('Watched now')[0]!).getByRole('button', { name: 'Amend' }))

    const drawer = await screen.findByRole('dialog', { name: /Amend GJ 03 AB 1234/ })
    fireEvent.change(within(drawer).getByDisplayValue('Critical'), { target: { value: 'medium' } })
    fireEvent.click(within(drawer).getByRole('button', { name: 'Save' }))
    await waitFor(() =>
      expect(api.updateWatchlistEntry).toHaveBeenCalledWith('w1', {
        category: 'stolen',
        priority: 'medium',
        remarks: 'Kalawad Road',
      }),
    )
  })

  it('shows a role that can only read no way to change anything', async () => {
    auth.permissions = new Set([PERMISSIONS.watchlistRead])
    renderPage()
    await screen.findByText('Retired (2)', { exact: false })
    expect(screen.queryByRole('complementary', { name: 'Add a plate' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Retire' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Reinstate' })).toBeNull()
    expect(screen.getByText(/can read the watchlist but not change it/)).toBeTruthy()
  })

  it('reports a list it could not read', async () => {
    vi.mocked(api.getWatchlist).mockRejectedValue(new Error('API unreachable'))
    renderPage()
    expect(await screen.findByText(/Could not read the watchlist: API unreachable/)).toBeTruthy()
  })
})

describe('watchlist ordering and search', () => {
  it('puts the most severe first, then the newest', () => {
    const older = entry('a', 'AAA1111', { priority: 'high', created_at: '2026-09-01T00:00:00Z' })
    const newer = entry('b', 'BBB2222', { priority: 'high', created_at: '2026-09-02T00:00:00Z' })
    const critical = entry('c', 'CCC3333', { priority: 'critical', created_at: '2026-08-01T00:00:00Z' })
    expect([older, newer, critical].sort(bySeverity).map((e) => e.id)).toEqual(['c', 'b', 'a'])
  })

  it('finds a plate however it is typed, and a case or remark by its words', () => {
    const e = entry('a', 'GJ03AB1234', { case_ref: 'FIR/2026/RJT/0412', remarks: 'Kalawad Road' })
    expect(matchesFilter(e, 'gj 03 ab')).toBe(true)
    expect(matchesFilter(e, 'rjt/0412')).toBe(true)
    expect(matchesFilter(e, 'kalawad')).toBe(true)
    expect(matchesFilter(e, 'MH12')).toBe(false)
    expect(matchesFilter(e, '  ')).toBe(true)
  })
})
