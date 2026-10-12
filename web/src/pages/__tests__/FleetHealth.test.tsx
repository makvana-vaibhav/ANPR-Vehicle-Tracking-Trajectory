/**
 * Fleet health.
 *
 * No camera's history opens by itself; a link or a gap-report row opens it;
 * failures are said in words; and grey stays grey — colour only on the
 * figures that need someone.
 */

import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { camera, DEMO } from '@/components/network/__tests__/fixtures'
import * as api from '@/lib/api'
import type { CameraHealthHistory, CameraPage, FleetHealth, GapReport } from '@/lib/types'
import FleetHealthPage from '@/pages/FleetHealth'

const GRID_CAMERA = camera('SBX-cam05', { name: 'Visat teen Rasta' })

const HEALTH: FleetHealth = {
  total: 31,
  online: 1,
  offline: 0,
  degraded: 0,
  unknown: 30,
  integrated: 1,
  awaiting_integration: 30,
  availability_pct: 3.2,
  integrated_availability_pct: 100,
  by_department: [
    { department: 'UNASSIGNED', total: 27, online: 0, offline: 0, degraded: 0, availability_pct: 0 },
    { department: 'MUNICIPAL', total: 1, online: 1, offline: 0, degraded: 0, availability_pct: 100 },
  ],
  by_vendor: [
    { vendor: 'hosted_grid', total: 30, online: 0, availability_pct: 0 },
    { vendor: 'simulated', total: 1, online: 1, availability_pct: 100 },
  ],
  top_errors: [{ error_code: 'sandbox_unreachable', count: 3690 }],
  generated_at: new Date().toISOString(),
}

const GAPS: GapReport = {
  window_hours: 24,
  generated_at: new Date().toISOString(),
  summary: {
    unavailable_cameras: 0,
    districts_below_anpr_target: 0,
    districts_with_no_cameras: 1,
    unreliable_cameras: 1,
  },
  availability_gaps: [],
  capability_gaps: [],
  coverage_gaps: [{ district: 'Vatva', reason: 'No cameras registered in this district' }],
  reliability_gaps: [
    {
      camera_code: 'SBX-cam05',
      name: 'Visat teen Rasta',
      district: 'Ahmadabad',
      uptime_pct: 57.5,
      reason: 'Intermittent — repeatedly dropping in and out',
      probes: 40,
    },
  ],
  district_coverage: [],
}

function history(code: string, id: string): CameraHealthHistory {
  return {
    camera_id: id,
    camera_code: code,
    status: 'online',
    uptime: { window_hours: 24, probes: 3, uptime_pct: 66.7, avg_latency_ms: 120, avg_fps: null },
    history: [
      { ts: '2026-10-11T18:10:00Z', reachable: true, fps_actual: null, latency_ms: 100, bitrate_kbps: null, error_code: null },
      { ts: '2026-10-11T18:05:00Z', reachable: false, fps_actual: null, latency_ms: 0, bitrate_kbps: null, error_code: 'timeout' },
      { ts: '2026-10-11T18:00:00Z', reachable: true, fps_actual: null, latency_ms: 140, bitrate_kbps: null, error_code: null },
    ],
  }
}

function Where() {
  return <output data-testid="where">{useLocation().search}</output>
}

function renderAt(url: string) {
  return render(
    <MemoryRouter initialEntries={[url]}>
      <Routes>
        <Route
          path="/health"
          element={
            <>
              <FleetHealthPage />
              <Where />
            </>
          }
        />
      </Routes>
    </MemoryRouter>,
  )
}

// Recharts' ResponsiveContainer measures itself; jsdom has nothing to measure with.
class NoResize {
  observe() {}
  unobserve() {}
  disconnect() {}
}

describe('FleetHealth', () => {
  beforeEach(() => {
    vi.stubGlobal('ResizeObserver', NoResize)
    vi.spyOn(api, 'getFleetHealth').mockResolvedValue(HEALTH)
    vi.spyOn(api, 'getGapReport').mockResolvedValue(GAPS)
    vi.spyOn(api, 'getDepartments').mockResolvedValue([])
    vi.spyOn(api, 'getCameras').mockResolvedValue({
      items: [DEMO, GRID_CAMERA],
      total: 2,
      limit: 500,
      offset: 0,
    } as CameraPage)
    vi.spyOn(api, 'getCameraHealth').mockImplementation(async (id) =>
      id === DEMO.id ? history(DEMO.camera_code, DEMO.id) : history('SBX-cam05', GRID_CAMERA.id),
    )
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('opens no camera’s history by default', async () => {
    renderAt('/health')
    expect(await screen.findByText('Choose a camera to see how it has answered.')).toBeTruthy()
    await screen.findByRole('option', { name: /CAM-DEMO-01/ })
    expect(api.getCameraHealth).not.toHaveBeenCalled()
  })

  it('opens the history a link names', async () => {
    renderAt('/health?camera=CAM-DEMO-01')
    await waitFor(() => expect(api.getCameraHealth).toHaveBeenCalledWith(DEMO.id, 24))
    expect(await screen.findByText('66.7%')).toBeTruthy()
  })

  it('says what is failing in words, with the code beside it', async () => {
    renderAt('/health')
    expect(await screen.findByText("The organisers' grid did not answer")).toBeTruthy()
    expect(screen.getByText('sandbox_unreachable')).toBeTruthy()
    expect(screen.getByText(/3,690 failed probes in the last hour/)).toBeTruthy()
  })

  it('opens a camera’s history from the gap report, into the URL', async () => {
    renderAt('/health')
    const row = (await screen.findByText('Visat teen Rasta')).closest('tr')!
    fireEvent.click(row)
    expect(screen.getByTestId('where').textContent).toBe('?camera=SBX-cam05')
    await waitFor(() => expect(api.getCameraHealth).toHaveBeenCalledWith(GRID_CAMERA.id, 24))
  })

  it('downloads the gap report for the window on screen, and says what it saved', async () => {
    const download = vi
      .spyOn(api, 'downloadGapReport')
      .mockResolvedValue('gap-report-20261011-0723-to-20261012-0723.csv')
    renderAt('/health')
    await screen.findByText('Visat teen Rasta')
    fireEvent.click(screen.getByRole('button', { name: /Download gap report/ }))
    await waitFor(() => expect(download).toHaveBeenCalledWith(24))
    expect(await screen.findByText(/Saved gap-report-20261011-0723/)).toBeTruthy()
  })

  it('says why a gap report download failed, beside the button', async () => {
    vi.spyOn(api, 'downloadGapReport').mockRejectedValue(new Error('Export failed (502)'))
    renderAt('/health')
    fireEvent.click(await screen.findByRole('button', { name: /Download gap report/ }))
    expect((await screen.findByRole('alert')).textContent).toContain('Export failed (502)')
  })

  it('colours only the figure that needs someone', async () => {
    renderAt('/health')
    const unknown = (await screen.findByText('State unknown')).closest('div')!
    expect(within(unknown.parentElement!).getByText('30').className).toMatch(/text-priority-high/)
    const offline = screen.getByText('Offline', { selector: 'p' }).parentElement!
    expect(within(offline).getByText('0').className).not.toMatch(/text-priority/)
  })

  it('names a refusing integration once, in the alarm’s words, and keeps states as last known', async () => {
    vi.spyOn(api, 'getFleetHealth').mockResolvedValue({
      ...HEALTH,
      stale: 30,
      integrations: [
        {
          vms_id: 'vms-grid',
          name: 'Hosted Camera Grid',
          vendor: 'hosted_grid',
          state: 'refused',
          error_code: 'grid_refused',
          cameras_held: 30,
          last_answered_at: '2026-10-12T05:12:00Z',
          alarm_open_since: '2026-10-12T05:14:00Z',
        },
      ],
    })
    renderAt('/health')
    const notice = (
      await screen.findByText('Hosted Camera Grid is refusing our session — its cooldown')
    ).closest('[role="status"]')!
    expect(notice.textContent).toContain('30 cameras keep their last known status')
    expect(notice.textContent).toContain('last answered 10:42 IST')
    expect(notice.textContent).toContain('since 10:44 IST')
    expect(screen.getByText(/30 shown as last known/)).toBeTruthy()
  })

  it('reports ageing equipment, and says plainly when install dates are unknown', async () => {
    vi.spyOn(api, 'getGapReport').mockResolvedValue({
      ...GAPS,
      reliability_gaps: [],
      coverage_gaps: [],
      ageing_gaps: [
        {
          camera_code: 'SBX-cam05',
          name: 'Visat teen Rasta',
          district: 'Ahmedabad',
          installed_on: '2014-03-01',
          age_years: 12.6,
          reason: 'Installed 12.6 years ago (review after 5).',
        },
      ],
      install_date_unknown: {
        cameras: 31,
        camera_codes: ['SBX-cam01'],
        reason: 'Install date not recorded, so the age of this equipment cannot be judged.',
      },
    })
    renderAt('/health')
    fireEvent.click(await screen.findByRole('tab', { name: /Ageing/ }))
    expect(await screen.findByText('Install date unknown for 31 cameras')).toBeTruthy()
    expect(screen.getByText('2014-03-01')).toBeTruthy()
    expect(screen.getByText('12.6 y')).toBeTruthy()
  })

  it('counts districts over Gujarat, and names the cameras that cover none', async () => {
    vi.spyOn(api, 'getGapReport').mockResolvedValue({
      ...GAPS,
      reliability_gaps: [],
      coverage_gaps: [{ district: 'Dang', reason: 'No camera with a known position' }],
      geography: {
        basis: "Gujarat's 33 districts",
        districts: 33,
        position_unknown: ['SBX-cam22'],
        recorded_footage: ['CAM-DEMO-01'],
        outside_gujarat: [],
      },
    })
    renderAt('/health')
    expect(await screen.findByText(/Gujarat districts \(1 of 33\)/)).toBeTruthy()
    expect(screen.getByText(/Not counted in any district/).textContent).toContain('SBX-cam22')
    expect(screen.getByText(/Not counted in any district/).textContent).toContain('CAM-DEMO-01')
  })
})
