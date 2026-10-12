/**
 * Insights (traffic intelligence) — recorded footage.
 *
 * CAM-DEMO-01 loops a 15-second clip and was ~93% of every vehicle this page
 * counted. What is pinned here: recordings are left out unless the box is
 * ticked; every request carries the same choice, so no panel counts the loop
 * while another does not; the choice lives in the link (`?recorded=1`); and
 * the page names the cameras it left out, from the server's own answer.
 */

import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import * as api from '@/lib/api'
import type {
  AnalyticsWindow,
  CameraPage,
  CongestionResponse,
  FlowResponse,
  HotspotResponse,
  RecordedFootage,
  RouteDensityResponse,
  SpeedResponse,
  TrafficHistoryResponse,
  TrafficResponse,
  TravelTimeResponse,
} from '@/lib/types'
import TrafficIntelligence from '@/pages/TrafficIntelligence'

vi.mock('@/hooks/useAuth', () => ({
  useAuth: () => ({ can: () => true, user: { username: 'analyst', role: 'analyst' } }),
}))

const WINDOW: AnalyticsWindow = {
  start: '2026-10-11T06:00:00Z',
  end: '2026-10-12T06:00:00Z',
  bucket_seconds: 300,
}

/** What the server says it did, given what it was asked. */
function footage(included: boolean, cameras = ['CAM-DEMO-01']): RecordedFootage {
  return { included, cameras, excluded_cameras: included ? [] : cameras }
}

type Asked = { include_recorded?: boolean }

function traffic(q: Asked | undefined, cameras?: string[]): TrafficResponse {
  return {
    window: WINDOW,
    group_by: 'corridor',
    zones: [],
    total_vehicles: 0,
    totals_by_type: { car: 0, motorcycle: 0, bus: 0, truck: 0, other: 0 },
    active_cameras: 0,
    fleet_cameras: 30,
    rows_read: 0,
    rows_total: 0,
    truncated: false,
    possible_obstructions: [],
    most_congested: [],
    note: '',
    recorded_footage: footage(Boolean(q?.include_recorded), cameras),
  }
}

/** Every request the page makes for its figures — the corridor list aside. */
const FIGURE_CALLS = [
  'getAnalyticsFlow',
  'getAnalyticsSpeed',
  'getAnalyticsRoutes',
  'getAnalyticsTravelTime',
  'getAnalyticsHotspots',
  'getCongestionForecast',
  'getTrafficState',
  'getTrafficHistory',
] as const

function stub(recordedCameras?: string[]) {
  vi.spyOn(api, 'getCameras').mockResolvedValue({
    items: [],
    total: 0,
    limit: 500,
    offset: 0,
  } as unknown as CameraPage)
  vi.spyOn(api, 'getAnalyticsFlow').mockImplementation(
    async (q): Promise<FlowResponse> => ({
      window: WINDOW,
      group_by: 'corridor',
      series: [],
      total_vehicles: 0,
      recorded_footage: footage(Boolean(q?.include_recorded), recordedCameras),
    }),
  )
  vi.spyOn(api, 'getAnalyticsSpeed').mockImplementation(
    async (q): Promise<SpeedResponse> => ({
      window: WINDOW,
      provenance: {
        source: 'observed_journeys',
        legs_considered: 0,
        legs_excluded_implausible: 0,
        note: 'No journeys with a measurable leg were observed in this window.',
      },
      corridors: [],
      recorded_footage: footage(Boolean(q?.include_recorded), recordedCameras),
    }),
  )
  vi.spyOn(api, 'getAnalyticsRoutes').mockImplementation(
    async (q): Promise<RouteDensityResponse> => ({
      window: WINDOW,
      pairs: [],
      total_journeys: 0,
      recorded_footage: footage(Boolean(q?.include_recorded), recordedCameras),
    }),
  )
  vi.spyOn(api, 'getAnalyticsTravelTime').mockImplementation(
    async (q): Promise<TravelTimeResponse> => ({
      window: WINDOW,
      segments: [],
      baseline_window_days: 7,
      recorded_footage: footage(Boolean(q?.include_recorded), recordedCameras),
    }),
  )
  vi.spyOn(api, 'getAnalyticsHotspots').mockImplementation(
    async (q): Promise<HotspotResponse> => ({
      window: WINDOW,
      by_volume: [],
      by_slowdown: [],
      slowdown_status: 'insufficient_history',
      note: '',
      recorded_footage: footage(Boolean(q?.include_recorded), recordedCameras),
    }),
  )
  vi.spyOn(api, 'getCongestionForecast').mockImplementation(
    async (q): Promise<CongestionResponse> => ({
      window: WINDOW,
      group_by: 'camera',
      baseline_window_days: 7,
      horizons_minutes: [15, 30],
      series: [],
      recorded_footage: footage(Boolean(q?.include_recorded), recordedCameras),
    }),
  )
  vi.spyOn(api, 'getTrafficState').mockImplementation(async (q) =>
    traffic(q, recordedCameras),
  )
  vi.spyOn(api, 'getTrafficHistory').mockImplementation(
    async (q): Promise<TrafficHistoryResponse> => ({
      window: WINDOW,
      key: null,
      group_by: 'corridor',
      points: [],
      recorded_footage: footage(Boolean(q?.include_recorded), recordedCameras),
    }),
  )
}

/** The `include_recorded` each figure request was last made with. */
function lastAsked(): Record<string, boolean | undefined> {
  return Object.fromEntries(
    FIGURE_CALLS.map((name) => {
      const calls = vi.mocked(api[name]).mock.calls
      const query = calls[calls.length - 1]?.[0] as Asked | undefined
      return [name, query?.include_recorded]
    }),
  )
}

function everyRequestAsked(value: boolean): Record<string, boolean> {
  return Object.fromEntries(FIGURE_CALLS.map((name) => [name, value]))
}

function Where() {
  return <output data-testid="where">{useLocation().search}</output>
}

function renderAt(url: string) {
  return render(
    <MemoryRouter initialEntries={[url]}>
      <Routes>
        <Route
          path="/traffic"
          element={
            <>
              <TrafficIntelligence />
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

function toggle(): HTMLInputElement {
  return screen.getByRole('checkbox', { name: 'Include recorded clips' }) as HTMLInputElement
}

describe('TrafficIntelligence — recorded footage', () => {
  beforeEach(() => {
    vi.stubGlobal('ResizeObserver', NoResize)
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('leaves recorded clips out by default, and says which', async () => {
    stub()
    renderAt('/traffic')

    const note = await screen.findByTestId('recorded-note')
    expect(note.textContent).toContain(
      'Excluding CAM-DEMO-01 — a recorded clip that loops, not live traffic.',
    )
    expect(toggle().checked).toBe(false)
    expect(lastAsked()).toEqual(everyRequestAsked(false))
    expect(screen.getByTestId('where').textContent).toBe('')
  })

  it('ticking the box puts it in the link and asks every panel to count them', async () => {
    stub()
    renderAt('/traffic?window=6')
    await screen.findByTestId('recorded-note')

    fireEvent.click(toggle())

    expect(screen.getByTestId('where').textContent).toBe('?window=6&recorded=1')
    await waitFor(() => expect(lastAsked()).toEqual(everyRequestAsked(true)))
    await waitFor(() =>
      expect(screen.getByTestId('recorded-note').textContent).toContain(
        'Including CAM-DEMO-01 — a recorded clip that loops, not live traffic.',
      ),
    )
    expect(toggle().checked).toBe(true)
  })

  it('a link with ?recorded=1 opens with them counted, and unticking takes it out', async () => {
    stub()
    renderAt('/traffic?recorded=1')

    await waitFor(() =>
      expect(screen.getByTestId('recorded-note').textContent).toContain('Including CAM-DEMO-01'),
    )
    expect(toggle().checked).toBe(true)
    expect(lastAsked()).toEqual(everyRequestAsked(true))

    fireEvent.click(toggle())

    expect(screen.getByTestId('where').textContent).toBe('')
    await waitFor(() => expect(lastAsked()).toEqual(everyRequestAsked(false)))
    await waitFor(() =>
      expect(screen.getByTestId('recorded-note').textContent).toContain('Excluding CAM-DEMO-01'),
    )
  })

  it('names every recording it left out', async () => {
    stub(['CAM-DEMO-01', 'CAM-DEMO-02'])
    renderAt('/traffic')

    expect((await screen.findByTestId('recorded-note')).textContent).toContain(
      'Excluding CAM-DEMO-01 and CAM-DEMO-02 — recorded clips that loop, not live traffic.',
    )
  })

  it('says nothing when no camera replays a recording', async () => {
    stub([])
    renderAt('/traffic')

    await waitFor(() => expect(api.getTrafficState).toHaveBeenCalled())
    await screen.findByText('Vehicles observed')
    expect(screen.queryByTestId('recorded-note')).toBeNull()
    expect(toggle().checked).toBe(false)
  })
})
