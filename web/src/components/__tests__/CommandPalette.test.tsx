/**
 * ⌘K: a plate opens its journey, a camera opens live, a word finds a screen.
 *
 * The case that needed thought: "cam10" has letters and digits like a plate,
 * and the operator who typed it wants the camera.
 */

import { act, fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter, useLocation } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import CommandPalette from '@/components/CommandPalette'
import * as api from '@/lib/api'
import type { Camera } from '@/lib/types'

let allowed: (permission: string) => boolean = () => true

vi.mock('@/hooks/useAuth', () => ({
  useAuth: () => ({ can: (p: string) => allowed(p), signOut: vi.fn() }),
}))

function camera(code: string, junction: string, city: string | null): Camera {
  return {
    id: `id-${code}`,
    camera_code: code,
    name: junction,
    department_code: null,
    department_name: null,
    vms_name: null,
    vms_vendor: null,
    corridor: null,
    district: null,
    city,
    junction,
    address: null,
    lat: 21.5,
    lon: 70.4,
    heading_deg: null,
    camera_type: null,
    protocol: null,
    resolution: null,
    fps: null,
    anpr_enabled: true,
    status: 'online',
    installed_on: null,
    tags: null,
    has_stream: true,
    source_file: null,
    created_at: '2026-10-11T00:00:00Z',
    updated_at: '2026-10-11T00:00:00Z',
  }
}

function Where() {
  const location = useLocation()
  return <output data-testid="where">{location.pathname + location.search}</output>
}

async function openWith(text: string) {
  const onClose = vi.fn()
  render(
    <MemoryRouter initialEntries={['/dashboard']}>
      <CommandPalette open onClose={onClose} />
      <Where />
    </MemoryRouter>,
  )
  // Let the camera list arrive before typing.
  await act(async () => {})
  fireEvent.change(screen.getByRole('textbox', { name: 'Search' }), { target: { value: text } })
  return onClose
}

function press(key: string) {
  fireEvent.keyDown(screen.getByRole('textbox', { name: 'Search' }), { key })
}

describe('CommandPalette', () => {
  beforeEach(() => {
    allowed = () => true
    vi.spyOn(api, 'getCameras').mockResolvedValue({
      items: [
        camera('SBX-cam10', 'char-chowk-road-2', 'Junagadh'),
        camera('CAM-DEMO-01', 'Ashram Road @ Paldi', 'Ahmedabad'),
      ],
      total: 2,
      limit: 500,
      offset: 0,
    })
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('opens a plate straight into its journey', async () => {
    const onClose = await openWith('gj 03 ab 1234')
    press('Enter')
    expect(screen.getByTestId('where').textContent).toBe('/vehicles?plate=GJ03AB1234')
    expect(onClose).toHaveBeenCalled()
  })

  it('takes "cam10" to the camera, not to a plate search', async () => {
    await openWith('cam10')
    press('Enter')
    expect(screen.getByTestId('where').textContent).toBe('/anpr?camera=SBX-cam10')
  })

  it('sends a role that may not watch video to the registry instead', async () => {
    allowed = (p) => p !== 'stream.view'
    await openWith('paldi')
    press('Enter')
    expect(screen.getByTestId('where').textContent).toBe('/cameras?camera=CAM-DEMO-01')
  })

  it('finds a screen by name, and moves through results with the arrows', async () => {
    await openWith('watchlist')
    expect(screen.getByText('Alarms · Watchlist')).toBeTruthy()
    press('Enter')
    expect(screen.getByTestId('where').textContent).toBe('/watchlist')
  })

  it('offers no plate search to a role that cannot search', async () => {
    allowed = (p) => p !== 'search.execute'
    await openWith('GJ03AB1234')
    expect(screen.queryByText('Find this vehicle')).toBeNull()
  })
})
