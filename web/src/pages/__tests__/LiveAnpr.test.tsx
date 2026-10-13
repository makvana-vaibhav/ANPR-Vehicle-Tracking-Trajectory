/**
 * Which camera the Live page puts on the stage, and what it opens.
 *
 * Opening a camera is not free: it issues a stream grant, starts a focus
 * heartbeat that makes a worker analyse it, and on the organisers' grid it
 * spends a metered watch-time quota. So the one thing this page must never do
 * is open a camera nobody asked for — in particular, open its default choice
 * while the camera the address names is still being found.
 */

import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter, Route, Routes, useLocation, useNavigate, useNavigationType } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest'

import * as api from '@/lib/api'
import type {
  Alert,
  AlertPage,
  Camera,
  CameraPage,
  Detection,
  DetectionPage,
  LiveAlertEvent,
  LiveEvent,
  StreamGrant,
} from '@/lib/types'
import LiveAnpr, { findCamera, isDemoFeed, isGridCamera, orderCameras, watchHits } from '@/pages/LiveAnpr'

const socket = vi.hoisted(() => ({
  alerts: [] as LiveAlertEvent[],
  handlers: new Set<(event: LiveEvent) => void>(),
  noEvents: [] as never[],
}))

vi.mock('@/hooks/useAuth', () => ({
  useAuth: () => ({ can: () => true, user: { username: 'operator', role: 'operator' } }),
}))

// The socket, without a socket: subscribers are kept so a test can deliver an
// event, and the per-camera buffers stay empty — what is under test here is
// which camera is opened, not what it reads.
vi.mock('@/hooks/useEventStream', () => {
  const subscribe = (handler: (event: LiveEvent) => void) => {
    socket.handlers.add(handler)
    return () => {
      socket.handlers.delete(handler)
    }
  }
  return {
    useEventStream: () => ({
      status: 'live',
      detections: [],
      alerts: socket.alerts,
      counts: { detections: 0, alerts: 0 },
      subscribe,
      clearAlerts: () => undefined,
    }),
    useCameraEvents: () => socket.noEvents,
    useCameraBoxes: () => null,
  }
})

// jsdom has neither WebRTC nor Media Source Extensions. The player is replaced
// by a marker that says which camera it was handed and on which transport it
// was told to start.
vi.mock('@/components/StreamPlayer', () => ({
  default: (props: { cameraCode: string; preferHls?: boolean }) => (
    <div
      data-testid="player"
      data-camera={props.cameraCode}
      data-prefer-hls={String(Boolean(props.preferHls))}
    />
  ),
}))

function camera(code: string, overrides: Partial<Camera> = {}): Camera {
  return {
    id: `id-${code}`,
    camera_code: code,
    name: `${code} junction`,
    department_code: null,
    department_name: null,
    vms_name: null,
    vms_vendor: null,
    corridor: null,
    district: null,
    city: 'Ahmedabad',
    junction: null,
    address: null,
    lat: 23.0225,
    lon: 72.5714,
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
    ...overrides,
  }
}

const GRID = camera('SBX-cam01', {
  vms_name: 'Hosted Camera Grid',
  vms_vendor: 'hosted_grid',
  tags: ['sandbox', 'grid-id:cam01'],
})
const GRID_TWO = camera('SBX-cam02', {
  vms_name: 'Hosted Camera Grid',
  vms_vendor: 'hosted_grid',
  tags: ['sandbox', 'grid-id:cam02'],
})
const DEMO = camera('CAM-DEMO-01', {
  vms_name: 'Recorded demo feed (local simulator)',
  vms_vendor: 'simulated',
  tags: ['demo', 'recorded-footage'],
  status: 'unknown',
})
const OUTSIDE = camera('CAM-PTZ-09', { anpr_enabled: false })

function detection(code: string): Detection {
  return {
    id: `det-${code}`,
    ts: '2026-10-11T14:00:00Z',
    camera_id: `id-${code}`,
    camera_code: code,
    camera_name: code,
    track_id: '1',
    vehicle_type: 'car',
    plate: 'GJ01AB1234',
    plate_confidence: 0.93,
    detection_confidence: 0.9,
    grammar_valid: true,
    bbox: null,
    plate_bbox: null,
    crop_key: null,
    crop_url: null,
    reads_total: 3,
    agreement: 1,
    corrected_from: null,
    ambiguous: false,
    candidates: [],
  }
}

const cameraPage = (items: Camera[]) =>
  ({ items, total: items.length, limit: 500, offset: 0 }) as CameraPage
const detectionPage = (items: Detection[]) =>
  ({ items, total: items.length, limit: 200, offset: 0 }) as DetectionPage

let fleet: Camera[] = []
let outsideFleet: Camera[] = []
let recentlyActive: string[] = []
let openAlerts: Alert[] = []

let openStream: MockInstance<typeof api.openStream>
let focus: MockInstance<typeof api.focusCamera>

/** Where the page has put the address, and how. */
function Probe() {
  const location = useLocation()
  const type = useNavigationType()
  return <output data-testid="address" data-search={location.search} data-type={type} />
}

/** Somewhere else in the app sending the operator to a camera. */
function Elsewhere({ to }: { to: string }) {
  const navigate = useNavigate()
  return (
    <button type="button" onClick={() => navigate(to)}>
      jump
    </button>
  )
}

function renderAt(url: string, jumpTo?: string) {
  return render(
    <MemoryRouter initialEntries={[url]}>
      <Routes>
        <Route
          path="/anpr"
          element={
            <>
              <LiveAnpr />
              <Probe />
              {jumpTo && <Elsewhere to={jumpTo} />}
            </>
          }
        />
      </Routes>
    </MemoryRouter>,
  )
}

/** Let every pending request settle and every effect it triggers run. */
async function settle() {
  for (let i = 0; i < 5; i += 1) {
    await act(async () => {
      await Promise.resolve()
    })
  }
}

const opened = () => openStream.mock.calls.map((call) => call[0])
const focused = () => focus.mock.calls.map((call) => call[0])
const address = () => screen.getByTestId('address')

beforeEach(() => {
  fleet = [GRID, GRID_TWO, DEMO]
  outsideFleet = []
  // The grid camera is the most active, so it is what the page would open if
  // nothing told it otherwise.
  recentlyActive = ['SBX-cam01']
  openAlerts = []
  socket.alerts = []
  socket.handlers.clear()

  vi.spyOn(api, 'getCameras').mockImplementation(async (params: Record<string, string> = {}) =>
    cameraPage(params.search ? outsideFleet.filter((c) => c.camera_code.includes(params.search ?? '')) : fleet),
  )
  vi.spyOn(api, 'getDetections').mockImplementation(async (query: api.DetectionQuery = {}) =>
    detectionPage(query.camera_id ? [] : recentlyActive.map(detection)),
  )
  vi.spyOn(api, 'getAlerts').mockImplementation(
    async () => ({ items: openAlerts, total: openAlerts.length, limit: 100, offset: 0 }) as AlertPage,
  )
  openStream = vi.spyOn(api, 'openStream').mockImplementation(
    async (id: string) =>
      ({
        camera_id: id,
        camera_code: id.replace(/^id-/, ''),
        name: id,
        status: 'online',
        token: 'stream-token',
        expires_in: 120,
        whep_url: `http://gateway.test/${id}/whep`,
        hls_url: `http://gateway.test/${id}/index.m3u8`,
        rtsp_url: null,
        protocol_preference: ['whep', 'hls'],
      }) as StreamGrant,
  )
  focus = vi.spyOn(api, 'focusCamera').mockResolvedValue(undefined)
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('the camera the address names', () => {
  it('opens that camera, and never the default first', async () => {
    renderAt('/anpr?camera=CAM-DEMO-01')
    await waitFor(() => expect(opened()).toEqual([DEMO.id]))
    await settle()

    expect(opened()).toEqual([DEMO.id])
    expect(focused().every((id) => id === DEMO.id)).toBe(true)
    expect(focused()).toContain(DEMO.id)
    expect(screen.getByTestId('player').getAttribute('data-camera')).toBe('CAM-DEMO-01')
  })

  it('matches the code however it was typed', async () => {
    renderAt('/anpr?camera=cam-demo-01')
    await waitFor(() => expect(opened()).toEqual([DEMO.id]))
  })

  it('opens nothing at all when no camera has that code', async () => {
    renderAt('/anpr?camera=NOPE-404')
    expect(await screen.findByText('No camera called NOPE-404')).toBeDefined()
    await settle()

    expect(opened()).toEqual([])
    expect(focused()).toEqual([])
  })

  it('finds a camera outside the plate-reading fleet, and opens only that', async () => {
    outsideFleet = [OUTSIDE]
    renderAt('/anpr?camera=CAM-PTZ-09')
    await waitFor(() => expect(opened()).toEqual([OUTSIDE.id]))
    await settle()

    expect(opened()).toEqual([OUTSIDE.id])
    expect(screen.getByText('Video only')).toBeDefined()
  })

  it('follows the address when somewhere else in the app changes it', async () => {
    // The search palette navigates to /anpr?camera=… while this page is open;
    // the route does not remount, so the page has to notice.
    renderAt('/anpr?camera=CAM-DEMO-01', '/anpr?camera=SBX-cam02')
    await waitFor(() => expect(opened()).toEqual([DEMO.id]))

    fireEvent.click(screen.getByRole('button', { name: 'jump' }))
    await waitFor(() => expect(opened()).toEqual([DEMO.id, GRID_TWO.id]))
    expect(screen.getByTestId('player').getAttribute('data-camera')).toBe('SBX-cam02')
  })
})

describe('a camera that will not open', () => {
  it('says why on the stage, and tries again when asked', async () => {
    openStream.mockRejectedValueOnce(
      new Error('The grid refused this stream (403): one session per IP'),
    )
    renderAt('/anpr?camera=CAM-DEMO-01')

    expect(
      await screen.findByText('The grid refused this stream (403): one session per IP'),
    ).toBeDefined()
    expect(screen.queryByTestId('player')).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: /Try again/ }))
    await waitFor(() => expect(screen.getByTestId('player')).toBeDefined())
    expect(opened()).toEqual([DEMO.id, DEMO.id])
  })
})

describe('without a camera in the address', () => {
  it('opens the most active camera and writes it into the address', async () => {
    recentlyActive = ['CAM-DEMO-01']
    renderAt('/anpr')
    await waitFor(() => expect(opened()).toEqual([DEMO.id]))
    await waitFor(() => expect(address().getAttribute('data-search')).toBe('?camera=CAM-DEMO-01'))
    // Replaced, not pushed: Back leaves the page.
    expect(address().getAttribute('data-type')).toBe('REPLACE')
  })

  it('does not open a grid camera by itself while one off the grid exists', async () => {
    // The grid camera is the most active here, and clicking "Live" must still
    // not spend the organisers' watch time on it.
    renderAt('/anpr')
    await waitFor(() => expect(opened()).toEqual([DEMO.id]))
    await settle()

    expect(opened()).toEqual([DEMO.id])
    expect(focused().every((id) => id === DEMO.id)).toBe(true)
  })

  it('opens the most active camera when every camera is on the grid', async () => {
    fleet = [GRID, GRID_TWO]
    recentlyActive = ['SBX-cam02']
    renderAt('/anpr')
    await waitFor(() => expect(opened()).toEqual([GRID_TWO.id]))
  })
})

describe('switching camera', () => {
  it('keeps the address in step, replacing rather than pushing', async () => {
    renderAt('/anpr?camera=CAM-DEMO-01')
    await waitFor(() => expect(opened()).toEqual([DEMO.id]))

    const rail = screen.getByRole('complementary', { name: 'Cameras' })
    fireEvent.click(within(rail).getByRole('button', { name: /SBX-cam02/ }))

    await waitFor(() => expect(address().getAttribute('data-search')).toBe('?camera=SBX-cam02'))
    expect(address().getAttribute('data-type')).toBe('REPLACE')
    await waitFor(() => expect(opened()).toEqual([DEMO.id, GRID_TWO.id]))
  })

  it('starts a grid camera on HLS and a local one on WebRTC', async () => {
    renderAt('/anpr?camera=SBX-cam02')
    await waitFor(() =>
      expect(screen.getByTestId('player').getAttribute('data-prefer-hls')).toBe('true'),
    )

    const rail = screen.getByRole('complementary', { name: 'Cameras' })
    fireEvent.click(within(rail).getByRole('button', { name: /CAM-DEMO-01/ }))
    await waitFor(() =>
      expect(screen.getByTestId('player').getAttribute('data-camera')).toBe('CAM-DEMO-01'),
    )
    expect(screen.getByTestId('player').getAttribute('data-prefer-hls')).toBe('false')
  })
})

describe('the rail', () => {
  it('marks a camera that is reading plates, from what the pipeline sends', async () => {
    renderAt('/anpr?camera=CAM-DEMO-01')
    await waitFor(() => expect(opened()).toEqual([DEMO.id]))
    const rail = screen.getByRole('complementary', { name: 'Cameras' })
    expect(within(rail).queryByText('reading')).toBeNull()

    act(() => {
      for (const handler of socket.handlers) {
        handler({
          event: 'camera.tracks',
          event_time: new Date().toISOString(),
          source: { camera_id: 'SBX-cam02' },
          frame: { width: 1920, height: 1080 },
          tracks: [],
        })
      }
    })

    const row = within(rail).getByRole('button', { name: /SBX-cam02/ })
    expect(within(row).getByText('reading')).toBeDefined()
    expect(screen.getByRole('button', { name: /Reading plates/ }).textContent).toContain('1')
  })

  it('marks a camera where a watchlist alarm is open', async () => {
    openAlerts = [
      {
        id: 'alert-1',
        created_at: '2026-10-11T14:00:00Z',
        alert_type: 'watchlist_hit',
        priority: 'critical',
        plate_normalised: 'GJ03AB1234',
        confidence: 0.94,
        status: 'new',
        camera_id: GRID_TWO.id,
        detection_id: null,
        watchlist_id: 'w-1',
        acknowledged_by: null,
        acknowledged_at: null,
        notes: null,
        crop_url: null,
        reasons: null,
      },
    ]
    renderAt('/anpr?camera=CAM-DEMO-01')
    const rail = screen.getByRole('complementary', { name: 'Cameras' })
    const row = await within(rail).findByRole('button', { name: /SBX-cam02/ })
    await waitFor(() => expect(within(row).getByText('alarm')).toBeDefined())
  })

  it('filters by what is typed', async () => {
    renderAt('/anpr?camera=CAM-DEMO-01')
    await waitFor(() => expect(opened()).toEqual([DEMO.id]))
    const rail = screen.getByRole('complementary', { name: 'Cameras' })

    fireEvent.change(within(rail).getByRole('searchbox'), { target: { value: 'demo' } })
    expect(within(rail).queryByRole('button', { name: /SBX-cam01/ })).toBeNull()
    expect(within(rail).getByRole('button', { name: /CAM-DEMO-01/ })).toBeDefined()
    // Filtering the list never changes what is on the stage.
    expect(opened()).toEqual([DEMO.id])
  })
})

describe('helpers', () => {
  it('knows a grid camera by its adapter, not by its name', () => {
    // VMS names have been renamed before; the adapter was not.
    expect(isGridCamera(GRID)).toBe(true)
    expect(isGridCamera(camera('X', { vms_vendor: 'hosted_grid' }))).toBe(true)
    expect(isGridCamera(DEMO)).toBe(false)
  })

  it('treats a grid camera replaying its recording as a recorded clip', () => {
    // `make grid-replay`: same camera, served from our gateway, on a loop.
    const replay = camera('SBX-cam10', {
      tags: ['sandbox', 'grid-id:cam10', 'recorded-footage', 'grid-replay'],
      source_file: 'grid-SBX-cam10.mp4',
    })
    expect(isGridCamera(replay)).toBe(false)
    expect(isDemoFeed(replay)).toBe(true)
  })

  it('orders recently active cameras first, then online, then by code', () => {
    const quiet = camera('A-quiet', { status: 'unknown' })
    const online = camera('B-online')
    const active = camera('C-active', { status: 'offline' })
    expect(orderCameras([quiet, online, active], new Set(['C-active'])).map((c) => c.camera_code)).toEqual([
      'C-active',
      'B-online',
      'A-quiet',
    ])
  })

  it('finds a camera by code in any case', () => {
    expect(findCamera([GRID, DEMO], ' cam-demo-01 ')?.id).toBe(DEMO.id)
    expect(findCamera([GRID, DEMO], 'cam-demo')).toBeNull()
  })

  it('calls a plate watched only on a watchlist alarm', () => {
    const base = {
      event: 'alert.raised' as const,
      alert_id: 'a',
      priority: 'critical' as const,
      confidence: 0.9,
      status: 'new' as const,
      camera_id: null,
      detection_id: null,
      created_at: '2026-10-11T14:00:00Z',
      notes: null,
      reasons: null,
    }
    const hits = watchHits(
      [
        {
          ...base,
          alert_type: 'watchlist_hit',
          plate: 'GJ03AB1234',
          watchlist: { id: 'w', plate: 'GJ03AB1234', category: 'stolen', case_ref: null, exact: true },
        },
        // A trajectory anomaly is about a journey, not a listed plate.
        { ...base, alert_type: 'anomaly', plate: 'GJ05CD5678' },
        { ...base, alert_type: 'camera_down', plate: null },
      ],
      [
        {
          id: 'r',
          created_at: '2026-10-11T13:00:00Z',
          alert_type: 'possible_match',
          priority: 'high',
          plate_normalised: 'GJ18W3963',
          confidence: 0.8,
          status: 'new',
          camera_id: null,
          detection_id: null,
          watchlist_id: 'w-2',
          acknowledged_by: null,
          acknowledged_at: null,
          notes: 'Near match',
          crop_url: null,
          reasons: null,
        },
      ],
    )

    expect([...hits.keys()].sort()).toEqual(['GJ03AB1234', 'GJ18W3963'])
    expect(hits.get('GJ03AB1234')).toEqual({
      listed: 'GJ03AB1234',
      category: 'stolen',
      exact: true,
      priority: 'critical',
    })
    expect(hits.get('GJ18W3963')?.exact).toBe(false)
  })
})
