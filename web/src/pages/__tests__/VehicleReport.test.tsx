/**
 * The printable route report.
 *
 * What it must never do is what a quick report would: drop the sightings it
 * cannot place, hide a leg it does not believe, or imply the vehicle was
 * nowhere else. These pin those three, and the plate drawn as a plate.
 */

import { render, screen, within } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { ToastProvider } from '@/components/Toast'
import * as api from '@/lib/api'
import type {
  CameraPage,
  CandidateReport,
  DetectionPage,
  RouteHop,
  VehicleRoute,
} from '@/lib/types'
import VehicleReport, { spacedPlate } from '@/pages/VehicleReport'

vi.mock('@/hooks/useAuth', () => ({
  useAuth: () => ({ user: { username: 'analyst', full_name: 'A. Analyst', role: 'analyst' } }),
}))

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
    best_detection_id: `det-${code}`,
    ...overrides,
  }
}

const ROUTE: VehicleRoute = {
  plate: 'GJ03AB1234',
  window: { from: '2026-10-11T00:00:00Z', to: '2026-10-11T12:00:00Z' },
  first_seen: '2026-10-11T04:00:00Z',
  last_seen: '2026-10-11T04:30:00Z',
  hop_count: 2,
  camera_count: 2,
  distance_km: 93.1,
  duration_s: 1800,
  moving_s: 1800,
  average_kmph: 186.2,
  moving_kmph: 186.2,
  is_plausible: false,
  confidence: 0.91,
  flagged_hop_count: 1,
  hops: [
    hop('SBX-cam10', '2026-10-11T04:00:00Z'),
    hop('SBX-cam17', '2026-10-11T04:30:00Z', {
      lat: 22.3,
      lon: 70.8,
      distance_m: 93_100,
      distance_km: 93.1,
      elapsed_s: 1800,
      implied_kmph: 186.2,
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
  unplaced_note: 'Sightings at cameras whose position is not known are listed separately.',
}

function renderReport(search = '?since=2026-10-11T00:00:00Z') {
  return render(
    <ToastProvider>
      <MemoryRouter initialEntries={[`/reports/vehicle/GJ03AB1234${search}`]}>
        <Routes>
          <Route path="/reports/vehicle/:plate" element={<VehicleReport />} />
        </Routes>
      </MemoryRouter>
    </ToastProvider>,
  )
}

describe('VehicleReport', () => {
  beforeEach(() => {
    vi.spyOn(api, 'getVehicleRoute').mockResolvedValue(ROUTE)
    vi.spyOn(api, 'getDetections').mockResolvedValue({
      items: [],
      total: 0,
      limit: 200,
      offset: 0,
    } as DetectionPage)
    vi.spyOn(api, 'getCameras').mockResolvedValue({ items: [], total: 0 } as unknown as CameraPage)
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('lists every visit in order, the leg it could not believe included', async () => {
    renderReport()
    const [visits] = await screen.findAllByRole('table')
    const rows = within(visits!).getAllByRole('row').slice(1)
    expect(rows.map((r) => within(r).getByText(/^SBX-cam\d+$/).textContent)).toEqual([
      'SBX-cam10',
      'SBX-cam17',
    ])
    expect(within(rows[1]!).getByText(/faster than any vehicle could have driven/)).toBeTruthy()
  })

  it('keeps the sightings it cannot place, separately', async () => {
    renderReport()
    expect(await screen.findByText(/camera’s position is unknown/)).toBeTruthy()
    expect(screen.getAllByText('SBX-cam22').length).toBeGreaterThan(0)
  })

  it('says that absence from the report is not absence from the road', async () => {
    renderReport()
    expect(await screen.findByText(/absence from this report is not evidence/)).toBeTruthy()
  })

  it('names who prepared it', async () => {
    renderReport()
    expect(await screen.findByText(/by A\. Analyst \(analyst\)/)).toBeTruthy()
  })

  it('does not print a zero as a measurement for a plate read only where position is unknown', async () => {
    vi.mocked(api.getVehicleRoute).mockResolvedValue({
      ...ROUTE,
      hops: [],
      hop_count: 0,
      camera_count: 0,
      distance_km: 0,
      duration_s: 0,
      average_kmph: null,
      confidence: 0,
      is_plausible: true,
      flagged_hop_count: 0,
      first_seen: null,
      last_seen: null,
    })
    renderReport()
    expect(await screen.findByText(/Read only where the camera’s position is unknown/)).toBeTruthy()
    // First seen comes from the reads that were made, not from the route.
    const firstSeen = screen.getByText('First seen').nextElementSibling
    expect(firstSeen?.textContent).not.toBe('—')
    expect(screen.getByText('Straight-line distance').nextElementSibling?.textContent).toBe('—')
    expect(screen.getByText('Weakest read on the route').nextElementSibling?.textContent).toBe('—')
    expect(screen.queryByText(/at least 0 km/)).toBeNull()
  })

  it("asks for each visit's clearest read, not the newest 200, and prints its crop", async () => {
    // A busy plate: the newest 200 reads all come from the last visit, so a
    // plain "this plate's reads" request left the first visit without its
    // crop. The report now asks only for reads as confident as the weakest
    // visit's best (0.90 here, the unplaced read), which keeps all three.
    vi.mocked(api.getVehicleRoute).mockResolvedValue({
      ...ROUTE,
      hops: [
        hop('SBX-cam10', '2026-10-11T04:00:00Z', { plate_confidence: 0.97 }),
        { ...ROUTE.hops[1]!, plate_confidence: 0.93 },
      ],
    })
    vi.mocked(api.getDetections).mockResolvedValue({
      items: [
        { id: 'det-SBX-cam17', crop_url: '/crops/cam17.jpg' },
        { id: 'det-SBX-cam10', crop_url: '/crops/cam10.jpg' },
        { id: 'det-unplaced', crop_url: '/crops/unplaced.jpg' },
      ],
      total: 3,
      limit: 200,
      offset: 0,
    } as unknown as DetectionPage)

    renderReport()

    expect(await screen.findByAltText('Plate read at SBX-cam10')).toHaveProperty(
      'src',
      expect.stringContaining('/crops/cam10.jpg'),
    )
    expect(screen.getByAltText('Plate read at SBX-cam17')).toHaveProperty(
      'src',
      expect.stringContaining('/crops/cam17.jpg'),
    )
    expect(screen.getByAltText('Plate read at SBX-cam22')).toHaveProperty(
      'src',
      expect.stringContaining('/crops/unplaced.jpg'),
    )
    const asked = vi.mocked(api.getDetections).mock.calls.map(([query]) => query)
    expect(asked).toHaveLength(1)
    expect(asked[0]).toMatchObject({ plate: 'GJ03AB1234', limit: 200 })
    expect(asked[0]!.min_confidence).toBeCloseTo(0.899, 6)
  })
})

describe('VehicleReport, with candidates an analyst included', () => {
  const INCLUDED = '0b6d6f4e-3c1a-4f7e-9a51-111111111111'

  beforeEach(() => {
    vi.spyOn(api, 'getVehicleRoute').mockResolvedValue({
      ...ROUTE,
      hops: [
        ROUTE.hops[0]!,
        hop('SBX-cam13', '2026-10-11T04:10:00Z', {
          candidate: true,
          read_as: 'GJ03A81234',
          candidate_note: '1 character differs: B read as 8 at position 6 (a common misreading)',
          best_detection_id: INCLUDED,
        }),
        ROUTE.hops[1]!,
      ],
      candidate_hop_count: 1,
      candidates_missing: [],
    })
    vi.spyOn(api, 'getDetections').mockResolvedValue({ items: [], total: 0, limit: 200, offset: 0 } as DetectionPage)
    vi.spyOn(api, 'getCameras').mockResolvedValue({ items: [], total: 0 } as unknown as CameraPage)
    vi.spyOn(api, 'getCandidates').mockResolvedValue({
      candidates: [{ detection_id: INCLUDED, detection_ids: [INCLUDED], crop_url: '/crops/candidate.jpg' }],
    } as unknown as CandidateReport)
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('builds the journey the screen showed and marks the candidate as one', async () => {
    renderReport(`?since=2026-10-11T00:00:00Z&include=${INCLUDED}`)
    expect(await screen.findByText(/included by an analyst; not a confirmed read/)).toBeTruthy()
    expect(api.getVehicleRoute).toHaveBeenCalledWith(
      'GJ03AB1234',
      expect.objectContaining({ include: [INCLUDED] }),
    )
    expect(screen.getByText('Candidate visits included').nextElementSibling?.textContent).toBe(
      '1 — not confirmed',
    )
    expect(screen.getByText(/Visits marked/)).toBeTruthy()
    // Its crop is a read of the other plate, fetched with the candidates.
    expect(await screen.findByAltText('Plate read at SBX-cam13')).toHaveProperty(
      'src',
      expect.stringContaining('/crops/candidate.jpg'),
    )
  })
})

describe('spacedPlate', () => {
  it('spaces an Indian plate the way it is painted', () => {
    expect(spacedPlate('GJ03AB1234')).toBe('GJ 03 AB 1234')
    expect(spacedPlate('GJ1A1234')).toBe('GJ 1 A 1234')
  })

  it('leaves anything else as it was read', () => {
    expect(spacedPlate('AB12CDE')).toBe('AB12CDE')
  })
})
