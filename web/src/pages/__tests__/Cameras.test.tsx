/**
 * The camera registry.
 *
 * Four promises: nothing opens unless asked (a grid camera's watch time is
 * rationed, so no page may start a stream or a probe by itself); a link
 * names what it opens; the address bar follows the screen; and an edit
 * changes only what the operator changed.
 */

import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { ToastProvider } from '@/components/Toast'
import { camera, DEMO, unplaced } from '@/components/network/__tests__/fixtures'
import * as api from '@/lib/api'
import type { CameraHealthHistory, CameraPage, Department } from '@/lib/types'
import Cameras from '@/pages/Cameras'

vi.mock('@/hooks/useAuth', () => ({
  useAuth: () => ({ can: () => true, user: { username: 'admin', role: 'admin' } }),
}))

// jsdom has no media pipeline; a marker stands in for the player so a test
// can see whether one was ever mounted.
vi.mock('@/components/StreamPlayer', () => ({
  default: (props: { cameraCode: string }) => <div data-testid="player" data-camera={props.cameraCode} />,
}))

const FLEET = [
  DEMO,
  camera('SBX-cam05', { name: 'Visat teen Rasta', department_code: 'POLICE', department_name: 'Gujarat Police' }),
  camera('SBX-cam06', { name: 'Timbavadi gate', city: 'Junagadh', district: 'Junagadh', lat: 21.52, lon: 70.45 }),
  unplaced('SBX-cam20', { name: 'Mohanpura' }),
  unplaced('SBX-cam22', { name: 'BK Mervada tran Rasta' }),
]

const HEALTH: CameraHealthHistory = {
  camera_id: 'x',
  camera_code: 'x',
  status: 'unknown',
  uptime: { window_hours: 24, probes: 0, uptime_pct: null, avg_latency_ms: null, avg_fps: null },
  history: [],
}

function Where() {
  const location = useLocation()
  return <output data-testid="where">{location.search}</output>
}

function renderAt(url: string) {
  return render(
    <ToastProvider>
      <MemoryRouter initialEntries={[url]}>
        <Routes>
          <Route
            path="/cameras"
            element={
              <>
                <Cameras />
                <Where />
              </>
            }
          />
        </Routes>
      </MemoryRouter>
    </ToastProvider>,
  )
}

const where = () => screen.getByTestId('where').textContent ?? ''

function rowOf(code: string): HTMLElement {
  const row = document.querySelector<HTMLElement>(`[data-camera="${code}"]`)
  if (!row) throw new Error(`no row for ${code}`)
  return row
}

describe('Cameras', () => {
  beforeEach(() => {
    vi.spyOn(api, 'getCameras').mockResolvedValue({
      items: FLEET,
      total: FLEET.length,
      limit: 500,
      offset: 0,
    } as CameraPage)
    vi.spyOn(api, 'getDepartments').mockResolvedValue([
      { id: 'd1', code: 'MUNICIPAL', name: 'Municipal', contact_email: null, camera_count: 1 },
      { id: 'd2', code: 'POLICE', name: 'Gujarat Police', contact_email: null, camera_count: 1 },
    ] as Department[])
    vi.spyOn(api, 'getVmsInstances').mockResolvedValue([])
    vi.spyOn(api, 'getAdapters').mockResolvedValue({ adapters: {}, detail: '' })
    vi.spyOn(api, 'getSourceVideos').mockResolvedValue([])
    vi.spyOn(api, 'getCameraHealth').mockResolvedValue(HEALTH)
    vi.spyOn(api, 'openStream').mockRejectedValue(new Error('must not be called'))
    vi.spyOn(api, 'probeCamera').mockRejectedValue(new Error('must not be called'))
    vi.spyOn(api, 'focusCamera').mockRejectedValue(new Error('must not be called'))
    vi.spyOn(api, 'updateCamera').mockImplementation(async (id) => FLEET.find((c) => c.id === id)!)
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('opens no camera by default, and never starts a stream or a probe', async () => {
    renderAt('/cameras')
    await screen.findByText('Visat teen Rasta')
    expect(screen.queryByRole('complementary', { name: 'Camera details' })).toBeNull()
    expect(screen.queryByTestId('player')).toBeNull()
    expect(api.getCameraHealth).not.toHaveBeenCalled()
    expect(api.openStream).not.toHaveBeenCalled()
    expect(api.probeCamera).not.toHaveBeenCalled()
    expect(api.focusCamera).not.toHaveBeenCalled()
  })

  it('opens the camera a link names — case-blind — without opening its video', async () => {
    renderAt('/cameras?camera=sbx-cam05')
    const panel = await screen.findByRole('complementary', { name: 'Camera details' })
    expect(within(panel).getByRole('heading', { name: 'Visat teen Rasta' })).toBeTruthy()
    expect(rowOf('SBX-cam05').getAttribute('aria-selected')).toBe('true')
    await waitFor(() => expect(api.getCameraHealth).toHaveBeenCalledWith('id-SBX-cam05'))
    expect(screen.queryByTestId('player')).toBeNull()
    expect(api.openStream).not.toHaveBeenCalled()
    expect(api.probeCamera).not.toHaveBeenCalled()
  })

  it('says so when the camera a link names does not exist', async () => {
    renderAt('/cameras?camera=SBX-cam99')
    expect(await screen.findByText('No camera SBX-cam99 in the registry.')).toBeTruthy()
  })

  it('puts the camera a row opens into the address bar, and takes it out on close', async () => {
    renderAt('/cameras')
    await screen.findByText('Visat teen Rasta')
    fireEvent.click(rowOf('SBX-cam06'))
    expect(where()).toBe('?camera=SBX-cam06')
    const panel = await screen.findByRole('complementary', { name: 'Camera details' })
    fireEvent.click(within(panel).getByRole('button', { name: 'Close camera details' }))
    expect(where()).toBe('')
  })

  it('shows only cameras without a position under ?filter=unplaced, and keeps the URL in step', async () => {
    renderAt('/cameras?filter=unplaced')
    await screen.findByText('Mohanpura')
    const codes = [...document.querySelectorAll('[data-camera]')].map((r) => r.getAttribute('data-camera'))
    expect(codes).toEqual(['SBX-cam20', 'SBX-cam22'])
    expect(screen.getByText('2 cameras have no known position')).toBeTruthy()

    const position = screen.getByRole('group', { name: 'Position' })
    fireEvent.click(within(position).getByRole('radio', { name: 'All' }))
    expect(where()).toBe('')
    await waitFor(() => expect(document.querySelectorAll('[data-camera]')).toHaveLength(FLEET.length))

    fireEvent.click(within(position).getByRole('radio', { name: /^Without a position/ }))
    expect(where()).toBe('?filter=unplaced')
  })

  it('sends only the fields an edit changed — never the untouched department', async () => {
    renderAt('/cameras')
    await screen.findByText('Visat teen Rasta')
    fireEvent.click(within(rowOf('SBX-cam05')).getByRole('button', { name: 'Edit' }))
    const form = await screen.findByRole('dialog', { name: 'Amend SBX-cam05' })
    fireEvent.change(within(form).getByDisplayValue('Visat teen Rasta'), {
      target: { value: 'Visat Teen Rasta junction' },
    })
    fireEvent.click(within(form).getByRole('button', { name: 'Save changes' }))
    await waitFor(() =>
      expect(api.updateCamera).toHaveBeenCalledWith('id-SBX-cam05', { name: 'Visat Teen Rasta junction' }),
    )
  })

  it('lets an unplaced camera keep no position, or be placed — dropping the tag that hid it', async () => {
    renderAt('/cameras?filter=unplaced')
    await screen.findByText('Mohanpura')
    fireEvent.click(within(rowOf('SBX-cam20')).getByRole('button', { name: 'Edit' }))
    const form = await screen.findByRole('dialog', { name: 'Amend SBX-cam20' })
    const [lat, lon] = within(form).getAllByPlaceholderText('Not known') as HTMLInputElement[]
    // The placeholder coordinate is never offered back as if it were a position.
    expect(lat?.value).toBe('')
    expect(lon?.value).toBe('')

    fireEvent.change(lat!, { target: { value: '22.5' } })
    fireEvent.change(lon!, { target: { value: '71.5' } })
    fireEvent.click(within(form).getByRole('button', { name: 'Save changes' }))
    await waitFor(() =>
      expect(api.updateCamera).toHaveBeenCalledWith('id-SBX-cam20', {
        lat: 22.5,
        lon: 71.5,
        tags: ['sandbox'],
      }),
    )
  })
})
