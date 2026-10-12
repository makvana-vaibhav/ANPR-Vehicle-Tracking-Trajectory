/**
 * Investigate, from its address.
 *
 * `/vehicles?plate=…` is how the ⌘K palette and other screens open a
 * journey, so these pin that a link lands on the vehicle it names, in the
 * window it names; that searching another plate keeps the address honest
 * without filling the Back button with every plate typed; and that the page
 * never drops the two things a quick version would — the leg nobody could
 * drive, and the sighting it cannot place.
 *
 * And the two things added for the live test: reads of a near plate offered
 * as "possibly the same vehicle", which join the journey only when an analyst
 * includes one (an audited call, then the address), and pursuit.
 */

import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter, Route, Routes, useLocation, useNavigate } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { ToastProvider } from '@/components/Toast'
import * as api from '@/lib/api'
import type {
  CandidateReport,
  CandidateSighting,
  ConvoyReport,
  DetectionPage,
  PlateSearchResponse,
  Pursuit,
  RouteHop,
  VehicleRoute,
} from '@/lib/types'
import VehicleSearch from '@/pages/VehicleSearch'

// The registry card fetches and audits on its own and has its own tests.
vi.mock('@/components/RegistryCard', () => ({ default: () => null }))

const auth = vi.hoisted(() => ({
  permissions: new Set<string>(['search.execute', 'stream.view']),
}))
vi.mock('@/hooks/useAuth', () => ({
  useAuth: () => ({ can: (permission: string) => auth.permissions.has(permission) }),
}))

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
    vi.spyOn(api, 'getCandidates').mockResolvedValue(candidateReport([]))
    vi.spyOn(api, 'listPursuits').mockResolvedValue({ pursuits: [] })
    window.sessionStorage.clear()
    auth.permissions = new Set(['search.execute', 'stream.view'])
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

// ── Possibly the same vehicle ─────────────────────────────────────────

const FITS_ID = '0b6d6f4e-3c1a-4f7e-9a51-111111111111'
const SAME_PASS_ID = '0b6d6f4e-3c1a-4f7e-9a51-222222222222'

function candidate(overrides: Partial<CandidateSighting> = {}): CandidateSighting {
  return {
    detection_id: FITS_ID,
    detection_ts: '2026-10-11T04:01:00Z',
    detection_ids: [FITS_ID],
    read_as: 'GJ03A81234',
    camera_id: 'id-SBX-cam13',
    camera_code: 'SBX-cam13',
    camera_name: 'CN Vidhyalaya',
    city: 'Ahmedabad',
    district: 'Ahmedabad',
    placed: true,
    town_level: true,
    lat: 23.0225,
    lon: 72.5714,
    arrived_at: '2026-10-11T04:01:00Z',
    departed_at: '2026-10-11T04:01:00Z',
    sightings: 1,
    plate_confidence: 0.88,
    vehicle_type: 'car',
    edits: [
      { kind: 'substitution', position: 6, expected: 'B', read: '8', confusion: true, text: 'B read as 8 at position 6 (a common misreading)' },
    ],
    edit_count: 1,
    confusions: 1,
    distance: 0.5,
    difference: '1 character differs: B read as 8 at position 6 (a common misreading)',
    fit: { status: 'fits', detail: 'reachable — ≥ 1.7 km from SBX-cam06 in 1 min (≥ 100 km/h)' },
    strength: 'strong',
    reasons: [
      { factor: 'plate', detail: '1 character differs', tone: 'for' },
      { factor: 'confidence', detail: 'read with confidence 0.88', tone: 'neutral' },
      { factor: 'route', detail: 'reachable — ≥ 1.7 km from SBX-cam06 in 1 min (≥ 100 km/h)', tone: 'for' },
      { factor: 'vehicle', detail: 'a car, like the confirmed reads', tone: 'for' },
    ],
    recurrence: 1,
    crop_url: null,
    ...overrides,
  }
}

function candidateReport(candidates: CandidateSighting[]): CandidateReport {
  return {
    plate: 'GJ03AB1234',
    window: { from: '2026-10-11T00:00:00Z', to: null },
    total: candidates.length,
    counts: { fits: 0, unknown: 0, conflicts: 0, same_visit: 0 },
    candidates,
    target_vehicle_type: 'car',
    confirmed_visits: 2,
    criteria: {
      max_distance: 2,
      max_edits: 3,
      confusion_cost: 0.5,
      confusions: ['0/O/D/Q'],
      dwell_window_s: 300,
      max_plausible_kmph: 150,
    },
    note: '',
  }
}

/** The route once the candidate is included: three visits, the middle one marked. */
function routeWithCandidate(plate: string): VehicleRoute {
  const base = routeFor(plate)
  return {
    ...base,
    hops: [
      base.hops[0]!,
      hop('SBX-cam13', '2026-10-11T04:01:00Z', {
        candidate: true,
        read_as: 'GJ03A81234',
        candidate_note: '1 character differs: B read as 8 at position 6 (a common misreading)',
        best_detection_id: FITS_ID,
      }),
      base.hops[1]!,
    ],
    candidate_hop_count: 1,
    candidates_missing: [],
  }
}

describe('Possibly the same vehicle', () => {
  beforeEach(() => {
    vi.spyOn(api, 'getVehicleRoute').mockImplementation(async (plate, query) =>
      query?.include?.length ? routeWithCandidate(plate) : routeFor(plate),
    )
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
    vi.spyOn(api, 'getDetections').mockResolvedValue({ items: [], total: 0, limit: 80, offset: 0 } as DetectionPage)
    vi.spyOn(api, 'getRoutablePlates').mockResolvedValue({ since: '', min_cameras: 2, plates: [] })
    vi.spyOn(api, 'listPursuits').mockResolvedValue({ pursuits: [] })
    vi.spyOn(api, 'getCandidates').mockResolvedValue(
      candidateReport([
        candidate(),
        candidate({
          detection_id: SAME_PASS_ID,
          detection_ids: [SAME_PASS_ID],
          read_as: 'GJ03AB1Z34',
          camera_code: 'SBX-cam06',
          fit: { status: 'same_visit', detail: 'read at SBX-cam06 while GJ03AB1234 was read there' },
        }),
      ]),
    )
    vi.spyOn(api, 'decideCandidate').mockImplementation(async (plate, body) => ({
      plate,
      detection_id: body.detection_id,
      detection_ts: body.detection_ts,
      decision: body.decision,
      read_as: 'GJ03A81234',
      camera_code: 'SBX-cam13',
      difference: '',
      decided_by: 'analyst',
      decided_at: '2026-10-11T05:00:00Z',
    }))
    window.sessionStorage.clear()
    auth.permissions = new Set(['search.execute', 'stream.view'])
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('lists each with its reasons, and folds away the same pass read twice', async () => {
    renderAt(['/vehicles?plate=GJ03AB1234'])
    const list = await screen.findByRole('region', { name: 'Possibly the same vehicle' })
    const card = await within(list).findByRole('listitem', { name: 'Candidate GJ03A81234 at SBX-cam13' })
    expect(within(card).getByText('Strong lead')).toBeTruthy()
    expect(within(card).getByText(/B read as 8 at position 6/)).toBeTruthy()
    expect(within(card).getByText(/reachable — ≥ 1.7 km from SBX-cam06/)).toBeTruthy()
    expect(within(list).getByText(/1 read inside a confirmed visit/)).toBeTruthy()
    // Nothing is in the journey until someone puts it there.
    expect(api.getVehicleRoute).toHaveBeenCalledTimes(1)
    expect(location().searchParams.has('include')).toBe(false)
  })

  it('includes one only after the audited call, then the address and the route follow', async () => {
    renderAt(['/vehicles?plate=GJ03AB1234'])
    const card = await screen.findByRole('listitem', { name: 'Candidate GJ03A81234 at SBX-cam13' })
    fireEvent.click(within(card).getByRole('button', { name: /Include in journey/ }))

    await waitFor(() =>
      expect(api.decideCandidate).toHaveBeenCalledWith('GJ03AB1234', {
        detection_id: FITS_ID,
        detection_ts: '2026-10-11T04:01:00Z',
        decision: 'include',
      }),
    )
    await waitFor(() => expect(location().searchParams.get('include')).toBe(FITS_ID))
    await waitFor(() =>
      expect(api.getVehicleRoute).toHaveBeenLastCalledWith(
        'GJ03AB1234',
        expect.objectContaining({ include: [FITS_ID] }),
      ),
    )
    // On the route, marked as what it is.
    const sightings = screen.getByRole('complementary', { name: 'Sightings' })
    expect(await within(sightings).findByRole('button', { name: /Visit 2, a candidate, SBX-cam13/ })).toBeTruthy()
    expect(within(sightings).getAllByText('Candidate').length).toBeGreaterThan(0)
    expect(screen.getByText('included, not confirmed')).toBeTruthy()
    // Counted apart from the reads of the plate itself.
    expect(screen.getByText('+ 1 candidate visit an analyst included')).toBeTruthy()
    expect(screen.getByText('3 reads · 2 visits to 2 cameras')).toBeTruthy()
  })

  it('dismisses one, and can take it back', async () => {
    renderAt(['/vehicles?plate=GJ03AB1234'])
    const card = await screen.findByRole('listitem', { name: 'Candidate GJ03A81234 at SBX-cam13' })
    fireEvent.click(within(card).getByRole('button', { name: 'Dismiss' }))
    await waitFor(() => expect(location().searchParams.get('dismiss')).toBe(FITS_ID))
    expect(await screen.findByText('1 dismissed')).toBeTruthy()
    expect(screen.queryByRole('listitem', { name: 'Candidate GJ03A81234 at SBX-cam13' })).toBeNull()

    fireEvent.click(screen.getByText('1 dismissed'))
    fireEvent.click(screen.getByRole('button', { name: 'Undo' }))
    await waitFor(() => expect(location().searchParams.has('dismiss')).toBe(false))
    expect(vi.mocked(api.decideCandidate).mock.calls.map((call) => call[1].decision)).toEqual([
      'dismiss',
      'undo',
    ])
  })

  it('changes nothing when the decision cannot be recorded', async () => {
    vi.mocked(api.decideCandidate).mockRejectedValue(new Error('audit unavailable'))
    renderAt(['/vehicles?plate=GJ03AB1234'])
    const card = await screen.findByRole('listitem', { name: 'Candidate GJ03A81234 at SBX-cam13' })
    fireEvent.click(within(card).getByRole('button', { name: /Include in journey/ }))
    expect(await screen.findByText(/audit unavailable/)).toBeTruthy()
    expect(location().searchParams.has('include')).toBe(false)
    expect(api.getVehicleRoute).toHaveBeenCalledTimes(1)
  })

  it('builds the journey a link describes, candidates and all', async () => {
    renderAt([`/vehicles?plate=GJ03AB1234&include=${FITS_ID}`])
    await waitFor(() =>
      expect(api.getVehicleRoute).toHaveBeenCalledWith(
        'GJ03AB1234',
        expect.objectContaining({ include: [FITS_ID] }),
      ),
    )
    const card = await screen.findByRole('listitem', { name: 'Candidate GJ03A81234 at SBX-cam13' })
    expect(within(card).getByText('In the journey, as a candidate')).toBeTruthy()
  })

  it('drops the decisions when another plate is opened', async () => {
    renderAt([`/vehicles?plate=GJ03AB1234&include=${FITS_ID}`])
    await screen.findByRole('heading', { name: 'Journey of GJ03AB1234' })
    fireEvent.click(screen.getByText('probe palette'))
    await screen.findByRole('heading', { name: 'Journey of MH12DE1433' })
    expect(location().searchParams.has('include')).toBe(false)
    expect(api.getVehicleRoute).toHaveBeenLastCalledWith('MH12DE1433', expect.not.objectContaining({ include: expect.anything() }))
  })
})

// ── Pursuit ───────────────────────────────────────────────────────────

function pursuitBody(overrides: Partial<Pursuit> = {}): Pursuit {
  return {
    plate: 'GJ03AB1234',
    status: 'preview',
    started_at: '2026-10-11T04:05:00Z',
    started_by: 'operator',
    renewed_at: null,
    expires_at: new Date(Date.now() + 12 * 60_000).toISOString(),
    remaining_s: 720,
    pins_wanted: 2,
    anchor: {
      camera_id: 'id-SBX-cam04',
      camera_code: 'SBX-cam04',
      camera_name: 'Paldi Circle',
      lat: 23.02,
      lon: 72.57,
      town_level: true,
      recorded: false,
      seen_at: new Date(Date.now() - 3 * 60_000).toISOString(),
      detection_id: 'd',
    },
    basis: { kind: 'default', low_kmph: 10, high_kmph: 60, samples: 0, note: 'the default band 10–60 km/h', short: '' },
    predictions: [
      {
        rank: 1,
        camera_id: 'id-SBX-cam12',
        camera_code: 'SBX-cam12',
        camera_name: 'Tri Mandir Adalaj Tollnaka',
        city: 'Adalaj',
        lat: 23.16,
        lon: 72.58,
        grid: true,
        always_on: false,
        distance_km: 15.8,
        approximate: true,
        eta_from: '2026-10-11T04:20:00Z',
        eta_to: '2026-10-11T05:40:00Z',
        window: 'open',
        basis: 'default',
        reasons: ['15.8 km from SBX-cam04 in a straight line', 'its arrival window is open now'],
        plates_7d: 4,
        vehicles_7d: 40,
        pin_state: 'would_pin',
        pin_note: 'would be pinned',
      },
    ],
    excluded_unplaced: 5,
    pins: [],
    released: [],
    sightings: [],
    events: [],
    grid: {
      held: false,
      reason: null,
      hold_until: null,
      last_grid_detection: new Date(Date.now() - 60_000).toISOString(),
      silent: false,
      visibility: 'The platform cannot see the AI workers’ login state.',
    },
    policy: {
      duration_s: 900,
      min_pin_s: 180,
      linger_s: 300,
      horizon_s: 900,
      focus_capacity: 3,
      grid_silence_s: 600,
      pin_proof_s: 240,
    },
    notes: [],
    would_pin: ['SBX-cam12'],
    ...overrides,
  }
}

describe('Pursuit, from Investigate', () => {
  beforeEach(() => {
    vi.spyOn(api, 'getVehicleRoute').mockImplementation(async (plate) => routeFor(plate))
    vi.spyOn(api, 'getConvoys').mockResolvedValue({
      plate: '',
      window: { from: null, to: null },
      criteria: { seconds_apart: 120, min_shared_cameras: 2 },
      convoys: [],
      note: '',
    } as ConvoyReport)
    vi.spyOn(api, 'searchPlates').mockResolvedValue({ query: '', threshold: 0.3, exact_match: true, results: [] } as PlateSearchResponse)
    vi.spyOn(api, 'getDetections').mockResolvedValue({ items: [], total: 0, limit: 80, offset: 0 } as DetectionPage)
    vi.spyOn(api, 'getRoutablePlates').mockResolvedValue({ since: '', min_cameras: 2, plates: [] })
    vi.spyOn(api, 'getCandidates').mockResolvedValue(candidateReport([]))
    vi.spyOn(api, 'listPursuits').mockResolvedValue({ pursuits: [] })
    vi.spyOn(api, 'predictPursuit').mockResolvedValue(pursuitBody())
    vi.spyOn(api, 'startPursuit').mockResolvedValue(
      pursuitBody({
        status: 'active',
        would_pin: undefined,
        pins: [{ camera_code: 'SBX-cam12', camera_id: 'id', pinned_at: new Date().toISOString(), grid: true, proven_at: null }],
        predictions: [{ ...pursuitBody().predictions[0]!, pin_state: 'pinned', pin_note: 'pinned: analysed now' }],
      }),
    )
    window.sessionStorage.clear()
    auth.permissions = new Set(['search.execute', 'stream.view'])
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('shows the prediction first and pins nothing until Start', async () => {
    renderAt(['/vehicles?plate=GJ03AB1234'])
    fireEvent.click(await screen.findByRole('button', { name: /^Pursue$/ }))
    const panel = await screen.findByRole('region', { name: 'Pursuit' })
    expect((await within(panel).findAllByText(/SBX-cam12/)).length).toBeGreaterThan(0)
    expect(within(panel).getByText(/Starting would pin/)).toBeTruthy()
    expect(within(panel).getByText('Would pin')).toBeTruthy()
    expect(api.startPursuit).not.toHaveBeenCalled()

    fireEvent.click(within(panel).getByRole('button', { name: /Start pursuit/ }))
    await waitFor(() => expect(api.startPursuit).toHaveBeenCalledWith('GJ03AB1234', 2))
    expect(await within(panel).findByText('Pinned · 1 of 2')).toBeTruthy()
    expect(within(panel).getByRole('button', { name: /Stop pursuit/ })).toBeTruthy()
  })

  it('says when grid cameras are held, and that it is inferred', async () => {
    vi.mocked(api.predictPursuit).mockResolvedValue(
      pursuitBody({
        would_pin: [],
        grid: {
          held: true,
          reason: 'No grid camera has produced a detection for 14 min.',
          hold_until: null,
          last_grid_detection: null,
          silent: true,
          visibility: 'The platform cannot see the AI workers’ login state.',
        },
      }),
    )
    renderAt(['/vehicles?plate=GJ03AB1234'])
    fireEvent.click(await screen.findByRole('button', { name: /^Pursue$/ }))
    const panel = await screen.findByRole('region', { name: 'Pursuit' })
    expect(await within(panel).findByText('Grid cameras are not being pinned')).toBeTruthy()
    expect(within(panel).getByText(/No grid camera has produced a detection for 14 min/)).toBeTruthy()
    expect(within(panel).getByText(/Inferred from detections/)).toBeTruthy()
  })

  it('is not offered to a role that may not open cameras', async () => {
    auth.permissions = new Set(['search.execute'])
    renderAt(['/vehicles?plate=GJ03AB1234'])
    await screen.findByRole('heading', { name: 'Journey of GJ03AB1234' })
    expect(screen.queryByRole('button', { name: /^Pursue$/ })).toBeNull()
  })

  it('opens by itself on a plate already being pursued', async () => {
    vi.mocked(api.listPursuits).mockResolvedValue({
      pursuits: [
        {
          plate: 'GJ03AB1234',
          started_at: '2026-10-11T04:05:00Z',
          started_by: 'operator',
          expires_at: new Date(Date.now() + 600_000).toISOString(),
          remaining_s: 600,
          pins: ['SBX-cam12'],
        },
      ],
    })
    vi.spyOn(api, 'getPursuit').mockResolvedValue(
      pursuitBody({ status: 'active', would_pin: undefined }),
    )
    renderAt(['/vehicles?plate=GJ03AB1234'])
    const panel = await screen.findByRole('region', { name: 'Pursuit' })
    expect(await within(panel).findByText(/Reads since it started/)).toBeTruthy()
    expect(api.getPursuit).toHaveBeenCalledWith('GJ03AB1234')
    expect(api.predictPursuit).not.toHaveBeenCalled()
  })
})
