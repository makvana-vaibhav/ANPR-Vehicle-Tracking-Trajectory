/**
 * The Network map page, around the map.
 *
 * MapLibre needs WebGL, which jsdom does not have, so the map itself is a
 * stand-in that records what it was asked to draw. What is pinned here: a
 * camera with no known position is never handed to the map but is listed;
 * nothing is opened by default; a link opens and flies to its camera; a
 * marker holding several cameras lists them.
 */

import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { forwardRef, useImperativeHandle } from 'react'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { ToastProvider } from '@/components/Toast'
import { camera, DEMO, unplaced } from '@/components/network/__tests__/fixtures'
import type { MapCluster } from '@/components/network/mapClusters'
import * as api from '@/lib/api'
import type { Camera, CameraHealthHistory, CameraPage } from '@/lib/types'
import MapView from '@/pages/MapView'

vi.mock('@/hooks/useAuth', () => ({
  useAuth: () => ({ can: () => true, user: { username: 'admin', role: 'admin' } }),
}))

vi.mock('@/components/StreamPlayer', () => ({
  default: (props: { cameraCode: string }) => <div data-testid="player" data-camera={props.cameraCode} />,
}))

const drawn = vi.hoisted(() => ({
  cameras: [] as Camera[],
  focus: vi.fn(),
  frame: vi.fn(),
  onSelect: null as null | ((cluster: MapCluster) => void),
}))

vi.mock('@/components/CameraMap', () => ({
  default: forwardRef(function FakeMap(
    props: { cameras: Camera[]; onSelect: (cluster: MapCluster) => void },
    ref,
  ) {
    drawn.cameras = props.cameras
    drawn.onSelect = props.onSelect
    useImperativeHandle(ref, () => ({ focusCamera: drawn.focus, frameCameras: drawn.frame }), [])
    return <div data-testid="map" />
  }),
}))

const TOWN = ['SBX-cam01', 'SBX-cam02', 'SBX-cam03'].map((code) => camera(code))
const FLEET = [DEMO, ...TOWN, unplaced('SBX-cam20', { name: 'Mohanpura' })]

const HEALTH: CameraHealthHistory = {
  camera_id: DEMO.id,
  camera_code: DEMO.camera_code,
  status: 'online',
  uptime: { window_hours: 24, probes: 4, uptime_pct: 100, avg_latency_ms: 40, avg_fps: 15 },
  history: [],
}

function Where() {
  return <output data-testid="where">{useLocation().search}</output>
}

function renderAt(url: string) {
  return render(
    <ToastProvider>
      <MemoryRouter initialEntries={[url]}>
        <Routes>
          <Route
            path="/map"
            element={
              <>
                <MapView />
                <Where />
              </>
            }
          />
        </Routes>
      </MemoryRouter>
    </ToastProvider>,
  )
}

describe('MapView', () => {
  beforeEach(() => {
    drawn.cameras = []
    drawn.focus.mockReset()
    drawn.frame.mockReset()
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('null', { status: 404 }))
    vi.spyOn(api, 'getCameras').mockResolvedValue({
      items: FLEET,
      total: FLEET.length,
      limit: 500,
      offset: 0,
    } as CameraPage)
    vi.spyOn(api, 'getCameraHealth').mockResolvedValue(HEALTH)
    vi.spyOn(api, 'openStream').mockRejectedValue(new Error('must not be called'))
    vi.spyOn(api, 'probeCamera').mockRejectedValue(new Error('must not be called'))
    vi.spyOn(api, 'focusCamera').mockRejectedValue(new Error('must not be called'))
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('never hands the map a camera with no known position, and lists it instead', async () => {
    renderAt('/map')
    const panel = await screen.findByRole('complementary', { name: 'Cameras' })
    await within(panel).findByText('Mohanpura')
    expect(drawn.cameras.map((c) => c.camera_code).sort()).toEqual([
      'CAM-DEMO-01',
      'SBX-cam01',
      'SBX-cam02',
      'SBX-cam03',
    ])
    expect(within(panel).getByText('Without a position')).toBeTruthy()
  })

  it('opens nothing by default: no camera, no stream, no probe', async () => {
    renderAt('/map')
    await screen.findByText('Mohanpura')
    expect(screen.queryByRole('button', { name: 'Close camera details' })).toBeNull()
    expect(screen.queryByTestId('player')).toBeNull()
    expect(api.getCameraHealth).not.toHaveBeenCalled()
    expect(api.openStream).not.toHaveBeenCalled()
    expect(api.probeCamera).not.toHaveBeenCalled()
    expect(api.focusCamera).not.toHaveBeenCalled()
    expect(drawn.focus).not.toHaveBeenCalled()
  })

  it('opens the camera a link names and flies to it, without opening its video', async () => {
    renderAt('/map?camera=CAM-DEMO-01')
    expect(await screen.findByRole('heading', { name: DEMO.name })).toBeTruthy()
    await waitFor(() => expect(drawn.focus).toHaveBeenCalledWith(DEMO))
    expect(screen.queryByTestId('player')).toBeNull()
    expect(api.openStream).not.toHaveBeenCalled()
  })

  it('lists the cameras of a marker that holds several, and opens one into the URL', async () => {
    renderAt('/map')
    await screen.findByText('Mohanpura')
    act(() =>
      drawn.onSelect?.({
        key: '23.02250,72.57140',
        name: 'Ahmedabad',
        lat: 23.0225,
        lon: 72.5714,
        cameras: TOWN,
        spots: 1,
        colocated: true,
        townLevel: true,
      }),
    )
    expect(await screen.findByText(/All 3 share the town’s centre/)).toBeTruthy()
    // Co-located cameras cannot be separated by zooming, so the map stays put.
    expect(drawn.frame).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: /SBX-cam02/ }))
    expect(screen.getByTestId('where').textContent).toBe('?camera=SBX-cam02')
    // Back to the list it came from.
    fireEvent.click(await screen.findByRole('button', { name: /Ahmedabad · 3/ }))
    expect(screen.getByTestId('where').textContent).toBe('')
    expect(screen.getByText(/All 3 share the town’s centre/)).toBeTruthy()
  })

  it('opens a single camera straight from its marker, without flying away from it', async () => {
    renderAt('/map')
    await screen.findByText('Mohanpura')
    act(() =>
      drawn.onSelect?.({
        key: '23.00937,72.56212',
        name: DEMO.junction ?? DEMO.name,
        lat: DEMO.lat,
        lon: DEMO.lon,
        cameras: [DEMO],
        spots: 1,
        colocated: false,
        townLevel: false,
      }),
    )
    expect(await screen.findByRole('heading', { name: DEMO.name })).toBeTruthy()
    expect(screen.getByTestId('where').textContent).toBe('?camera=CAM-DEMO-01')
    expect(drawn.focus).not.toHaveBeenCalled()
  })
})
