/**
 * How the Network screens read a camera: its source, its position, the
 * filters, the URL, and the edit that must change only what was changed.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  amendment,
  departmentOptions,
  fetchAllCameras,
  filterCameras,
  findCamera,
  matchesFilter,
  NO_FILTER,
  POSITION_WORDS,
  positionKind,
  probeErrorWords,
  staleWords,
  readCameraParam,
  readPositionFilter,
  sourceKind,
  tagsAfterPlacing,
  UNASSIGNED,
  vendorOptions,
  withParams,
} from '@/components/network/cameraFacts'
import * as api from '@/lib/api'
import type { CameraPage } from '@/lib/types'

import { camera, DEMO, unplaced } from './fixtures'

describe('sourceKind', () => {
  it('reads a pinned clip as recorded', () => {
    expect(sourceKind(camera('CAM-1', { source_file: 'road.mp4', vms_vendor: null }))).toBe('recorded')
  })

  it('reads the demo camera as recorded from its tags, though it has no source_file', () => {
    expect(DEMO.source_file).toBeNull()
    expect(sourceKind(DEMO)).toBe('recorded')
  })

  it('reads a grid camera as grid', () => {
    expect(sourceKind(camera('SBX-cam01'))).toBe('grid')
    expect(sourceKind(camera('SBX-cam02', { vms_vendor: null, tags: ['sandbox'] }))).toBe('grid')
  })

  it('tells a configured live stream from no source at all', () => {
    expect(sourceKind(camera('CAM-2', { vms_vendor: 'rtsp', tags: null }))).toBe('stream')
    expect(sourceKind(camera('CAM-3', { vms_vendor: null, tags: null, has_stream: false }))).toBe('none')
  })
})

describe('positionKind', () => {
  it('knows an unplaced camera by its tag', () => {
    expect(positionKind(unplaced('SBX-cam20'))).toBe('unknown')
  })

  it('knows one by the placeholder coordinate even without the tag', () => {
    expect(positionKind(unplaced('SBX-cam22', { tags: null }))).toBe('unknown')
  })

  it('tells a town-centre camera from a placed one', () => {
    expect(positionKind(camera('SBX-cam01'))).toBe('town')
    expect(positionKind(DEMO)).toBe('exact')
  })

  it('never presents a position geocoded from the name as surveyed', () => {
    const geocoded = camera('SBX-cam15', {
      lat: 23.01468,
      lon: 72.55917,
      tags: ['sandbox', 'grid-id:cam15', 'placement:geocoded'],
    })
    expect(positionKind(geocoded)).toBe('approx')
    expect(POSITION_WORDS.approx).toMatch(/approximate/i)
    expect(POSITION_WORDS.approx).toMatch(/geocoded from the name/)
    expect(POSITION_WORDS.approx).toContain('© OpenStreetMap contributors')
  })
})

describe('staleWords', () => {
  it('is silent for a fresh status', () => {
    expect(staleWords(camera('SBX-cam10', { status: 'online' }))).toBeNull()
  })

  it('says a held status is the last known one, when it was confirmed and why', () => {
    const words = staleWords(
      camera('SBX-cam10', {
        status: 'online',
        status_stale_reason: 'grid_refused',
        // 10:42 IST
        status_confirmed_at: '2026-10-12T05:12:00Z',
      }),
    )
    expect(words).toContain('Last known')
    expect(words).toContain('10:42 IST')
    expect(words).toMatch(/refusing our session/)
  })

  it('admits when nothing confirmed it in a day', () => {
    expect(
      staleWords(camera('SBX-cam10', { status_stale_reason: 'sandbox_unreachable' })),
    ).toMatch(/not confirmed in the last 24 h/)
  })
})

describe('filtering', () => {
  const fleet = [
    DEMO,
    camera('SBX-cam01', { status: 'offline', department_code: 'POLICE' }),
    camera('SBX-cam02', { anpr_enabled: false, city: 'Junagadh', district: 'Junagadh' }),
    unplaced('SBX-cam20', { name: 'Mohanpura' }),
  ]

  it('passes everything with no filter', () => {
    expect(filterCameras(fleet, NO_FILTER)).toHaveLength(4)
  })

  it('filters by status, department, unassigned and integration', () => {
    expect(filterCameras(fleet, { ...NO_FILTER, status: 'offline' }).map((c) => c.camera_code)).toEqual([
      'SBX-cam01',
    ])
    expect(filterCameras(fleet, { ...NO_FILTER, department: 'MUNICIPAL' })).toEqual([DEMO])
    expect(filterCameras(fleet, { ...NO_FILTER, department: UNASSIGNED }).map((c) => c.camera_code)).toEqual([
      'SBX-cam02',
      'SBX-cam20',
    ])
    expect(filterCameras(fleet, { ...NO_FILTER, vendor: 'simulated' })).toEqual([DEMO])
  })

  it('filters by plate reading, source and position', () => {
    expect(filterCameras(fleet, { ...NO_FILTER, anprOnly: true })).toHaveLength(3)
    expect(filterCameras(fleet, { ...NO_FILTER, source: 'recorded' })).toEqual([DEMO])
    expect(filterCameras(fleet, { ...NO_FILTER, position: 'unplaced' }).map((c) => c.camera_code)).toEqual([
      'SBX-cam20',
    ])
    expect(filterCameras(fleet, { ...NO_FILTER, position: 'placed' })).toHaveLength(3)
  })

  it('searches code, name, junction, town and district, ignoring case', () => {
    expect(matchesFilter(DEMO, { ...NO_FILTER, search: 'cam-demo' })).toBe(true)
    expect(matchesFilter(DEMO, { ...NO_FILTER, search: 'ASHRAM' })).toBe(true)
    expect(matchesFilter(DEMO, { ...NO_FILTER, search: 'sabarmati' })).toBe(true)
    expect(filterCameras(fleet, { ...NO_FILTER, search: 'junagadh' }).map((c) => c.camera_code)).toEqual([
      'SBX-cam02',
    ])
  })

  it('offers only the departments and integrations cameras actually have', () => {
    const { departments, unassigned } = departmentOptions(fleet)
    expect(departments.map((d) => [d.code, d.count])).toEqual([
      ['MUNICIPAL', 1],
      ['POLICE', 1],
    ])
    expect(unassigned).toBe(2)
    expect(vendorOptions(fleet)).toEqual(['hosted_grid', 'simulated'])
  })
})

describe('the URL', () => {
  it('reads ?camera= and ignores an empty one', () => {
    expect(readCameraParam(new URLSearchParams('camera=SBX-cam05'))).toBe('SBX-cam05')
    expect(readCameraParam(new URLSearchParams('camera='))).toBeNull()
    expect(readCameraParam(new URLSearchParams(''))).toBeNull()
  })

  it('reads ?filter= as a position filter, and nothing else', () => {
    expect(readPositionFilter(new URLSearchParams('filter=unplaced'))).toBe('unplaced')
    expect(readPositionFilter(new URLSearchParams('filter=placed'))).toBe('placed')
    expect(readPositionFilter(new URLSearchParams('filter=bogus'))).toBe('')
  })

  it('sets and clears keys without disturbing the others', () => {
    const start = new URLSearchParams('filter=unplaced&camera=SBX-cam20')
    expect(withParams(start, { camera: null }).toString()).toBe('filter=unplaced')
    expect(withParams(start, { camera: 'CAM-DEMO-01' }).get('filter')).toBe('unplaced')
    // The input is never mutated.
    expect(start.get('camera')).toBe('SBX-cam20')
  })

  it('finds a camera by code without regard to case', () => {
    expect(findCamera([DEMO], 'cam-demo-01')).toBe(DEMO)
    expect(findCamera([DEMO], 'SBX-cam99')).toBeNull()
    expect(findCamera([DEMO], null)).toBeNull()
  })
})

describe('probeErrorWords', () => {
  it('says what a known failure means', () => {
    expect(probeErrorWords('sandbox_unreachable')).toBe("The organisers' grid did not answer")
    expect(probeErrorWords('unauthorized')).toMatch(/refused our credentials/)
  })

  it('still reads as words for a code it has never seen', () => {
    expect(probeErrorWords('brand_new_failure')).toBe('Brand new failure')
  })
})

describe('amendment', () => {
  it('sends only what changed — never a department the form did not touch', () => {
    const changes = amendment(DEMO, {
      name: 'Paldi junction',
      department_code: 'MUNICIPAL',
      district: 'Sabarmati',
      heading_deg: null,
      lat: DEMO.lat,
      lon: DEMO.lon,
    })
    expect(changes).toEqual({ name: 'Paldi junction' })
  })

  it('treats a blank field and an absent value as the same', () => {
    expect(amendment(camera('SBX-cam01', { resolution: null }), { resolution: null })).toEqual({})
  })

  it('moves the coordinates together, or not at all', () => {
    expect(amendment(DEMO, { lat: 23.01, lon: DEMO.lon })).toEqual({ lat: 23.01, lon: DEMO.lon })
  })

  it('never sends the camera code', () => {
    expect(amendment(DEMO, { camera_code: 'CAM-OTHER' })).toEqual({})
  })
})

describe('tagsAfterPlacing', () => {
  it('drops the placement tags and keeps the rest', () => {
    expect(tagsAfterPlacing(['sandbox', 'placement:unknown', 'grid-id:cam20'])).toEqual([
      'sandbox',
      'grid-id:cam20',
    ])
    expect(tagsAfterPlacing(['sandbox', 'placement:city'])).toEqual(['sandbox'])
    expect(tagsAfterPlacing(['sandbox', 'placement:geocoded'])).toEqual(['sandbox'])
    expect(tagsAfterPlacing(null)).toBeNull()
  })
})

describe('fetchAllCameras', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('reads every page, not just the first', async () => {
    const all = Array.from({ length: 620 }, (_, i) => camera(`CAM-${String(i).padStart(4, '0')}`))
    const spy = vi.spyOn(api, 'getCameras').mockImplementation(async (params = {}) => {
      const offset = Number(params.offset ?? 0)
      const limit = Number(params.limit ?? 50)
      return { items: all.slice(offset, offset + limit), total: all.length, limit, offset } as CameraPage
    })
    const cameras = await fetchAllCameras()
    expect(cameras).toHaveLength(620)
    expect(spy).toHaveBeenCalledTimes(2)
    expect(spy.mock.calls[1]?.[0]).toMatchObject({ offset: '500', limit: '500' })
  })
})
