/**
 * Grouping cameras into places.
 *
 * The two things a map must not do: draw a camera whose position is unknown
 * as if it were known, and draw a town's dozen cameras as one anonymous dot.
 */

import { describe, expect, it } from 'vitest'

import { groupPlaces, isUnplaced, PLACEHOLDER, shortCode } from '@/lib/places'
import type { Camera } from '@/lib/types'

function camera(code: string, overrides: Partial<Camera> = {}): Camera {
  return {
    id: `id-${code}`,
    camera_code: code,
    name: `${code} name`,
    department_code: null,
    department_name: null,
    vms_name: null,
    vms_vendor: null,
    corridor: null,
    district: null,
    city: null,
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

describe('isUnplaced', () => {
  it('trusts the registry tag', () => {
    expect(isUnplaced(camera('a', { tags: ['placement:unknown'] }))).toBe(true)
  })

  it('treats the placeholder centroid as unknown even without the tag', () => {
    expect(isUnplaced(camera('a', { lat: PLACEHOLDER.lat, lon: PLACEHOLDER.lon }))).toBe(true)
  })

  it('accepts a real position', () => {
    expect(isUnplaced(camera('a', { lat: 21.5222, lon: 70.4579 }))).toBe(false)
  })
})

describe('groupPlaces', () => {
  it('groups a town into one place and counts every camera in it', () => {
    const { places } = groupPlaces([
      camera('SBX-cam01', { city: 'Ahmedabad' }),
      camera('SBX-cam02', { city: 'Ahmedabad' }),
      // Precisely placed, a kilometre or two from the town centre.
      camera('CAM-DEMO-01', { city: 'Ahmedabad', lat: 23.00937, lon: 72.56212 }),
      camera('SBX-cam10', { city: 'Junagadh', lat: 21.5222, lon: 70.4579 }),
    ])
    expect(places.map((p) => [p.name, p.cameras.length])).toEqual([
      ['Ahmedabad', 3],
      ['Junagadh', 1],
    ])
    const ahmedabad = places[0]
    expect(ahmedabad?.lat).toBeCloseTo((23.0225 * 2 + 23.00937) / 3, 6)
  })

  it('keeps unplaced cameras out of every place, and lists them', () => {
    const { places, unplaced } = groupPlaces([
      camera('SBX-cam20', { lat: PLACEHOLDER.lat, lon: PLACEHOLDER.lon, junction: 'Mohanpura' }),
      camera('SBX-cam10', { city: 'Junagadh', lat: 21.5222, lon: 70.4579 }),
    ])
    expect(places).toHaveLength(1)
    expect(unplaced.map((c) => c.camera_code)).toEqual(['SBX-cam20'])
  })

  it('falls back to position, then to the junction, when the town is unknown', () => {
    const { places } = groupPlaces([
      camera('X-1', { lat: 22.3, lon: 70.8, junction: 'Bus Port' }),
      camera('X-2', { lat: 22.3001, lon: 70.8001, junction: 'Bus Port' }),
    ])
    expect(places).toHaveLength(1)
    expect(places[0]?.name).toBe('Bus Port')
  })
})

describe('shortCode', () => {
  it('drops the shared prefixes', () => {
    expect(shortCode('SBX-cam10')).toBe('cam10')
    expect(shortCode('CAM-DEMO-01')).toBe('DEMO-01')
  })
})
