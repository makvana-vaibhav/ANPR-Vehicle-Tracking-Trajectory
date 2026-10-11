/**
 * Investigate, from its address.
 *
 * `/vehicles?plate=…` is how the ⌘K palette and other screens open a
 * journey, so these pin that a link lands on the vehicle it names, in the
 * window it names; that searching another plate keeps the address honest
 * without filling the Back button with every plate typed; and that the page
 * never drops the two things a quick version would — the leg nobody could
 * drive, and the sighting it cannot place.
 */

import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter, Route, Routes, useLocation, useNavigate } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { ToastProvider } from '@/components/Toast'
import * as api from '@/lib/api'
import type {
  ConvoyReport,
  DetectionPage,
  PlateSearchResponse,
  RouteHop,
  VehicleRoute,
} from '@/lib/types'
import VehicleSearch from '@/pages/VehicleSearch'

// MapLibre needs WebGL, which jsdom has not got, and the map is not what these
// tests are about. The stand-in keeps the map's overlay, because the cards an
// operator reads when there is nothing to draw are drawn over it.
vi.mock('@/components/RouteMap', async () => {
  const React = await import('react')
  const RouteMap = React.forwardRef(function RouteMap(
    props: { children?: React.ReactNode },
    _ref: unknown,
  ) {
    return React.createElement('div', { 'data-testid': 'route-map' }, props.children)
  })
  return { default: RouteMap }
})

function hop(code: string, at: string, overrides: Partial<RouteHop> = {}): RouteHop {
  return {
    camera_id: `id-${code}`,
    camera_code: code,
    camera_name: `${code} junction`,
    city: 'Junagadh',
    district: 'Junagadh',
    lat: 21.52,
    lon: 70.45,
    arrived_at: at,
    departed_at: at,
    dwell_s: 0,
    sightings: 1,
    plate_confidence: 0.94,
    distance_m: null,
    distance_km: null,
    elapsed_s: null,
    implied_kmph: null,
    bearing_deg: null,
    flags: [],
    plausible: true,
    best_detection_id: null,
    ...overrides,
  }
}

function routeFor(plate: string, overrides: Partial<VehicleRoute> = {}): VehicleRoute {
  return {
    plate,
    window: { from: '2026-10-11T00:00:00Z', to: null },
    first_seen: '2026-10-11T04:00:00Z',
    last_seen: '2026-10-11T04:03:00Z',
    hop_count: 2,
    camera_count: 2,
    distance_km: 274.3,
    duration_s: 180,
    moving_s: 180,
    average_kmph: 5486,
    moving_kmph: 5486,
    is_plausible: false,
    confidence: 0.66,
    flagged_hop_count: 1,
    hops: [
      hop('SBX-cam06', '2026-10-11T04:00:00Z'),
      hop('SBX-cam04', '2026-10-11T04:03:00Z', {
        city: 'Ahmedabad',
        lat: 23.02,
        lon: 72.57,
        distance_m: 274_300,
        distance_km: 274.3,
        elapsed_s: 180,
        implied_kmph: 5486,
        flags: ['implausible_speed'],
        plausible: false,
      }),
    ],
    unplaced_sightings: [
      {
        detection_id: 'det-unplaced',
        camera_id: 'id-SBX-cam22',
        camera_code: 'SBX-cam22',
        camera_name: 'BK Mervada tran Rasta',
        city: null,
        district: null,
        seen_at: '2026-10-11T05:00:00Z',
        plate_confidence: 0.9,
      },
    ],
    geometry_note: 'straight lines',
    unplaced_note: 'listed separately',
    ...overrides,
  }
}

const NOT_READ: Partial<VehicleRoute> = {
  hops: [],
  hop_count: 0,
  camera_count: 0,
  distance_km: 0,
  duration_s: 0,
  average_kmph: null,
  moving_kmph: null,
  confidence: 0,
  is_plausible: true,
  flagged_hop_count: 0,
  first_seen: null,
  last_seen: null,
  unplaced_sightings: [],
}

/** Where the router is, a way to press Back, and a link the way ⌘K follows one. */
function Probe() {
  const location = useLocation()
  const navigate = useNavigate()
  return (
    <>
      <output data-testid="location">{location.pathname + location.search}</output>
      <button type="button" onClick={() => navigate(-1)}>
        probe back
      </button>
      <button type="button" onClick={() => navigate('/vehicles?plate=MH12DE1433')}>
        probe palette
      </button>
    </>
  )
}

function renderAt(entries: string[]) {
  return render(
    <ToastProvider>
      <MemoryRouter initialEntries={entries} initialIndex={entries.length - 1}>
        <Routes>
          <Route path="/vehicles" element={<VehicleSearch />} />
          <Route path="/dashboard" element={<p>dashboard</p>} />
        </Routes>
        <Probe />
      </MemoryRouter>
    </ToastProvider>,
  )
}

function location(): URL {
  return new URL(screen.getByTestId('location').textContent ?? '', 'http://contrail.test')
}

describe('VehicleSearch, opened by its address', () => {
  beforeEach(() => {
    vi.spyOn(api, 'getVehicleRoute').mockImplementation(async (plate) => routeFor(plate))
    vi.spyOn(api, 'getConvoys').mockResolvedValue({
      plate: '',
      window: { from: null, to: null },
      criteria: { seconds_apart: 120, min_shared_cameras: 2 },
      convoys: [],
      note: '',
    } as ConvoyReport)
    vi.spyOn(api, 'searchPlates').mockResolvedValue({
      query: '',
      threshold: 0.3,
      exact_match: true,
      results: [],
    } as PlateSearchResponse)
    vi.spyOn(api, 'getDetections').mockResolvedValue({
      items: [],
      total: 0,
      limit: 80,
      offset: 0,
    } as DetectionPage)
    vi.spyOn(api, 'getRoutablePlates').mockResolvedValue({ since: '', min_cameras: 2, plates: [] })
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('searches the plate a link names, normalised, and says so in the address', async () => {
    renderAt(['/vehicles?plate=gj%2003%20ab-1234'])
    await waitFor(() =>
      expect(api.getVehicleRoute).toHaveBeenCalledWith(
        'GJ03AB1234',
        expect.objectContaining({ since: expect.any(String) }),
      ),
    )
    expect((screen.getByLabelText('Plate') as HTMLInputElement).value).toBe('GJ03AB1234')
    await waitFor(() => expect(location().searchParams.get('plate')).toBe('GJ03AB1234'))
  })

  it('does not search again for the address it wrote itself', async () => {
    renderAt(['/vehicles?plate=gj03ab1234'])
    await screen.findByRole('heading', { name: 'Journey of GJ03AB1234' })
    expect(location().searchParams.get('plate')).toBe('GJ03AB1234')
    expect(api.getVehicleRoute).toHaveBeenCalledTimes(1)
  })

  it('replaces the address for the next plate, so Back leaves the screen', async () => {
    renderAt(['/dashboard', '/vehicles?plate=GJ03AB1234'])
    await screen.findByRole('heading', { name: 'Journey of GJ03AB1234' })

    fireEvent.change(screen.getByLabelText('Plate'), { target: { value: 'mh12de1433' } })
    fireEvent.submit(screen.getByLabelText('Plate').closest('form')!)

    await screen.findByRole('heading', { name: 'Journey of MH12DE1433' })
    expect(api.getVehicleRoute).toHaveBeenLastCalledWith('MH12DE1433', expect.any(Object))
    expect(location().searchParams.get('plate')).toBe('MH12DE1433')

    fireEvent.click(screen.getByText('probe back'))
    await waitFor(() => expect(location().pathname).toBe('/dashboard'))
  })

  it('opens a newly linked plate while it is already on screen', async () => {
    renderAt(['/vehicles?plate=GJ03AB1234'])
    await screen.findByRole('heading', { name: 'Journey of GJ03AB1234' })

    // The palette navigates to the same screen; nothing remounts it.
    fireEvent.click(screen.getByText('probe palette'))
    await screen.findByRole('heading', { name: 'Journey of MH12DE1433' })
    expect((screen.getByLabelText('Plate') as HTMLInputElement).value).toBe('MH12DE1433')
    expect(api.getVehicleRoute).toHaveBeenCalledTimes(2)
  })

  it('searches exactly the window a link gives, and shows it', async () => {
    renderAt(['/vehicles?plate=GJ03AB1234&since=2026-10-11T00:00:00Z&until=2026-10-11T12:00:00Z'])
    await waitFor(() =>
      expect(api.getVehicleRoute).toHaveBeenCalledWith('GJ03AB1234', {
        since: '2026-10-11T00:00:00.000Z',
        until: '2026-10-11T12:00:00.000Z',
      }),
    )
    // Shown beside the window picker, in IST, with a way back to a relative one.
    const search = screen.getByRole('complementary', { name: 'Search' })
    expect(
      await within(search).findByText('11 Oct 2026, 05:30:00 to 11 Oct 2026, 17:30:00 IST'),
    ).toBeTruthy()
    expect(within(search).getByRole('button', { name: 'Use a relative window instead' })).toBeTruthy()
  })

  it('falls back to its own window when a link’s window cannot be read', async () => {
    renderAt(['/vehicles?plate=GJ03AB1234&since=yesterday'])
    await waitFor(() => expect(api.getVehicleRoute).toHaveBeenCalled())
    const [, window] = vi.mocked(api.getVehicleRoute).mock.calls[0]!
    expect(window?.until).toBeUndefined()
    const since = Date.parse(window!.since!)
    expect(Date.now() - since).toBeGreaterThan(23.9 * 3_600_000)
    expect(Date.now() - since).toBeLessThan(24.1 * 3_600_000)
    await waitFor(() => expect(location().searchParams.has('since')).toBe(false))
  })

  it('refuses a plate too short to search on', async () => {
    renderAt(['/vehicles?plate=AB1'])
    expect(await screen.findByText(/at least four letters or digits/)).toBeTruthy()
    expect(api.getVehicleRoute).not.toHaveBeenCalled()
  })

  it('shows the leg nobody could drive, with why, and the read it cannot place', async () => {
    renderAt(['/vehicles?plate=GJ03AB1234'])
    expect(await screen.findByText(/Faster than a vehicle can travel/)).toBeTruthy()
    const sightings = screen.getByRole('complementary', { name: 'Sightings' })
    expect(within(sightings).getByText('≥ 274 km in 3 min · impossible')).toBeTruthy()
    expect(within(sightings).getByText('Position unknown')).toBeTruthy()
    expect(within(sightings).getByText('SBX-cam22')).toBeTruthy()
    expect(within(sightings).getByText('not on the map')).toBeTruthy()
    // And the summary counts the leg as one to explain.
    expect(screen.getByText('1 leg')).toBeTruthy()
  })

  it('offers the plates close to one that was not read, and opens them', async () => {
    vi.mocked(api.getVehicleRoute).mockImplementation(async (plate) =>
      plate === 'NA13NRV' ? routeFor(plate, NOT_READ) : routeFor(plate),
    )
    vi.mocked(api.searchPlates).mockResolvedValue({
      query: 'NA13NRV',
      threshold: 0.3,
      exact_match: false,
      results: [
        {
          plate_normalised: 'NA13NRU',
          similarity: 0.6,
          sightings: 448,
          cameras: 1,
          first_seen: '2026-10-11T13:33:37Z',
          last_seen: '2026-10-11T18:13:21Z',
          watchlist: null,
        },
      ],
    })
    renderAt(['/vehicles?plate=NA13NRV'])
    expect(await screen.findByText(/was not read in the last 24 h/)).toBeTruthy()
    fireEvent.click(await screen.findByRole('button', { name: /NA13NRU/ }))
    await screen.findByRole('heading', { name: 'Journey of NA13NRU' })
    expect(location().searchParams.get('plate')).toBe('NA13NRU')
  })
})
