/**
 * What the journey map is allowed to claim.
 *
 * The trail is computed here and only painted by MapLibre, so a mistake in
 * these numbers is a map that lies smoothly: an impossible leg drawn in the
 * colour of a believed one, the newest sighting drawn as the faintest, or
 * four visits to one camera shown as one. These pin each of those.
 */

import { describe, expect, it } from 'vitest'

import {
  formatDuration,
  groupStops,
  isCandidateLeg,
  journeyTrail,
  legSummary,
  sequenceLabel,
  stopCaption,
  TAIL_ALPHA,
  timelineTicks,
  trailGradient,
  travelledTrail,
  type TrailVertex,
} from '@/components/routeTrail'
import type { RouteHop } from '@/lib/types'

const T0 = Date.parse('2026-10-11T13:30:00Z') // 19:00 IST

function hop(
  code: string,
  lon: number,
  lat: number,
  minutes: number,
  overrides: Partial<RouteHop> = {},
): RouteHop {
  const at = new Date(T0 + minutes * 60_000).toISOString()
  return {
    camera_id: `id-${code}`,
    camera_code: code,
    camera_name: `${code} junction`,
    city: 'Ahmedabad',
    district: 'Ahmedabad',
    lat,
    lon,
    arrived_at: at,
    departed_at: at,
    dwell_s: 0,
    sightings: 1,
    plate_confidence: 0.9,
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

/** Pairs of [progress, alpha] out of a `line-gradient` expression. */
function stopsOf(expression: unknown[] | null): [number, number][] {
  expect(expression).not.toBeNull()
  const flat = expression!.slice(3)
  const pairs: [number, number][] = []
  for (let i = 0; i < flat.length; i += 2) {
    const alpha = Number(/rgba\([^)]*,\s*([\d.]+)\)/.exec(String(flat[i + 1]))![1])
    pairs.push([flat[i] as number, alpha])
  }
  return pairs
}

const RGB = [92, 200, 255] as const

describe('groupStops', () => {
  it('draws repeat visits to one camera as one stop carrying every visit', () => {
    const hops = [
      hop('CAM-A', 72.5, 23.0, 0),
      hop('CAM-A', 72.5, 23.0, 10),
      hop('CAM-B', 72.6, 23.1, 20),
      hop('CAM-A', 72.5, 23.0, 30),
    ]
    const groups = groupStops(hops)
    expect(groups).toHaveLength(2)
    expect(groups[0]!.hops).toEqual([0, 1, 3])
    expect(groups[1]!.hops).toEqual([2])
  })

  it('shares a stop between different cameras on the same spot', () => {
    const groups = groupStops([
      hop('SBX-cam06', 70.4579, 21.5222, 0),
      hop('SBX-cam04', 72.5714, 23.0225, 3),
      hop('SBX-cam10', 70.4579, 21.5222, 70),
    ])
    expect(groups).toHaveLength(2)
    expect(groups[0]!.camera_codes).toEqual(['SBX-cam06', 'SBX-cam10'])
  })

  it('marks the first stop, the last one, and any reached by an impossible leg', () => {
    const groups = groupStops([
      hop('A', 72.0, 23.0, 0),
      hop('B', 72.1, 23.0, 10, { plausible: false, flags: ['implausible_speed'] }),
      hop('C', 72.2, 23.0, 20),
    ])
    expect(groups.map((g) => g.role)).toEqual(['start', 'via', 'end'])
    expect(groups.map((g) => g.impossible)).toEqual([false, true, false])
  })

  it('calls a single place the end, not the start: it is where the vehicle was last seen', () => {
    const groups = groupStops([hop('A', 72.0, 23.0, 0), hop('A', 72.0, 23.0, 5)])
    expect(groups[0]!.role).toBe('end')
  })
})

describe('sequenceLabel and stopCaption', () => {
  it('writes runs as ranges and pairs with a dot', () => {
    expect(sequenceLabel([0])).toBe('1')
    expect(sequenceLabel([1, 2])).toBe('2·3')
    expect(sequenceLabel([3, 5])).toBe('4·6')
    expect(sequenceLabel([0, 1, 2, 3, 4])).toBe('1–5')
    expect(sequenceLabel([1, 2, 3, 6])).toBe('2–4·7')
  })

  it('shortens a long scatter of visits to first and last', () => {
    expect(sequenceLabel([0, 2, 4, 6, 8, 10])).toBe('1…11')
  })

  it('names the camera and the time of a single visit, and counts several', () => {
    const one = groupStops([hop('SBX-cam10', 70.4, 21.5, 0)])[0]!
    expect(stopCaption(one, '19:00')).toBe('SBX-cam10 · 19:00')
    const many = groupStops([hop('CAM-DEMO-01', 72.5, 23.0, 0), hop('CAM-DEMO-01', 72.5, 23.0, 9)])[0]!
    expect(stopCaption(many, '19:00')).toBe('CAM-DEMO-01 · 2 visits')
  })
})

describe('trailGradient', () => {
  const line: TrailVertex[] = [
    { lon: 72.0, lat: 23.0, t: 0 },
    { lon: 72.1, lat: 23.0, t: 600 },
    { lon: 72.2, lat: 23.0, t: 1200 },
  ]

  it('fades from a faint oldest end to a full-strength newest end', () => {
    const stops = stopsOf(trailGradient(line, [true, true, true], RGB))
    expect(stops[0]).toEqual([0, Number(TAIL_ALPHA.toFixed(3))])
    expect(stops[stops.length - 1]).toEqual([1, 1])
    for (let i = 1; i < stops.length; i += 1) {
      expect(stops[i]![0]).toBeGreaterThan(stops[i - 1]![0])
      expect(stops[i]![1]).toBeGreaterThanOrEqual(stops[i - 1]![1])
    }
  })

  it('follows time, not distance: a slow first leg stays faint for longer', () => {
    // Equal distances, but the vehicle took 50 minutes over the first leg and
    // 10 over the second, so the middle sighting is 5/6 of the way through.
    const slow: TrailVertex[] = [
      { lon: 72.0, lat: 23.0, t: 0 },
      { lon: 72.1, lat: 23.0, t: 3000 },
      { lon: 72.2, lat: 23.0, t: 3600 },
    ]
    const middle = stopsOf(trailGradient(slow, [true, true, true], RGB)).find(
      ([at]) => Math.abs(at - 0.5) < 0.01,
    )!
    expect(middle[1]).toBeCloseTo(TAIL_ALPHA + (1 - TAIL_ALPHA) * (5 / 6), 2)
  })

  it('leaves an impossible leg out of the trail entirely', () => {
    const stops = stopsOf(trailGradient(line, [true, true, false], RGB))
    // Strictly inside the last leg — the shared sighting at 0.5 is the
    // believed leg's end, give or take floating point.
    const inside = stops.filter(([at]) => at > 0.5 + 1e-6 && at < 1)
    expect(inside.length).toBeGreaterThan(0)
    for (const [, alpha] of inside) expect(alpha).toBe(0)
    // The believed leg before it keeps its brightness up to the shared sighting.
    expect(stops.find(([at]) => Math.abs(at - 0.5) < 1e-9)![1]).toBeGreaterThan(0)
  })

  it('has nothing to draw when every sighting is in one place', () => {
    const still: TrailVertex[] = [
      { lon: 72.0, lat: 23.0, t: 0 },
      { lon: 72.0, lat: 23.0, t: 600 },
    ]
    expect(trailGradient(still, [true, true], RGB)).toBeNull()
    expect(trailGradient([line[0]!], [true], RGB)).toBeNull()
  })

  it('keeps its stops strictly ascending through a revisit of no length', () => {
    const revisit: TrailVertex[] = [
      { lon: 72.0, lat: 23.0, t: 0 },
      { lon: 72.1, lat: 23.0, t: 300 },
      { lon: 72.1, lat: 23.0, t: 600 },
      { lon: 72.2, lat: 23.0, t: 900 },
    ]
    const stops = stopsOf(trailGradient(revisit, [true, true, true, true], RGB))
    for (let i = 1; i < stops.length; i += 1) expect(stops[i]![0]).toBeGreaterThan(stops[i - 1]![0])
  })
})

describe('travelledTrail', () => {
  const hops = [
    hop('A', 72.0, 23.0, 0),
    hop('B', 72.1, 23.0, 10),
    hop('C', 72.2, 23.0, 20, { plausible: false, flags: ['implausible_speed'] }),
  ]
  const timeline = [0, 600, 1200]

  it('runs through every sighting reached, then to where the vehicle is now', () => {
    const trail = travelledTrail(hops, timeline, 900, [72.15, 23.0])
    expect(trail.vertices.map((v) => v.lon)).toEqual([72.0, 72.1, 72.15])
    expect(trail.vertices[2]!.t).toBe(900)
  })

  it('carries the belief of the leg the vehicle is part-way along', () => {
    expect(travelledTrail(hops, timeline, 300, [72.05, 23.0]).believed[1]).toBe(true)
    expect(travelledTrail(hops, timeline, 900, [72.15, 23.0]).believed[2]).toBe(false)
  })
})

describe('legSummary', () => {
  it('states every figure as a lower bound', () => {
    expect(
      legSummary(hop('B', 72.1, 23.0, 10, { distance_km: 1.234, elapsed_s: 240, implied_kmph: 18.5 })),
    ).toBe('≥ 1.2 km · 4 min · ≥ 19 km/h')
  })

  it('names an impossible leg as one, with no speed to admire', () => {
    expect(
      legSummary(
        hop('B', 72.1, 23.0, 10, {
          distance_km: 274.3,
          elapsed_s: 120,
          implied_kmph: 8229,
          plausible: false,
          flags: ['implausible_speed'],
        }),
      ),
    ).toBe('≥ 274 km in 2 min · impossible')
  })

  it('says nothing for the first visit or a leg of no length', () => {
    expect(legSummary(hop('A', 72.0, 23.0, 0))).toBeNull()
    expect(legSummary(hop('A', 72.0, 23.0, 5, { distance_km: 0, elapsed_s: 300 }))).toBeNull()
  })
})

describe('formatDuration', () => {
  it('reads like a person would say it', () => {
    expect(formatDuration(42)).toBe('42 s')
    expect(formatDuration(18 * 60)).toBe('18 min')
    expect(formatDuration(4 * 3600 + 2 * 60)).toBe('4 h 02 min')
    expect(formatDuration(76 * 3600)).toBe('3 d 4 h')
  })
})

describe('timelineTicks', () => {
  it('falls on round IST times', () => {
    // 19:03:37 IST to 21:30:03 IST.
    const start = '2026-10-11T13:33:37Z'
    const ticks = timelineTicks(start, 8786)
    expect(ticks.map((t) => t.label)).toEqual(['19:30', '20:00', '20:30', '21:00', '21:30'])
    expect(ticks[0]!.at).toBe(26 * 60 + 23)
  })

  it('has nothing to mark on a journey with no length', () => {
    expect(timelineTicks('2026-10-11T13:33:37Z', 0)).toEqual([])
  })
})

describe('candidate visits', () => {
  // A read of another plate an analyst included: SBX-cam13, between two
  // confirmed visits. It must never be drawn as a believed leg.
  const hops = [
    hop('SBX-cam06', 72.0, 23.0, 0),
    hop('SBX-cam13', 72.1, 23.0, 5, { candidate: true, read_as: 'GJ03A81234', distance_km: 10.2, elapsed_s: 300 }),
    hop('SBX-cam04', 72.2, 23.0, 10, { distance_km: 10.2, elapsed_s: 300 }),
  ]

  it('marks both legs touching it as candidate legs', () => {
    expect([0, 1, 2].map((k) => isCandidateLeg(hops, k))).toEqual([false, true, true])
  })

  it('leaves them out of the believed trail', () => {
    expect(journeyTrail(hops, [0, 300, 600]).believed).toEqual([true, false, false])
  })

  it('makes a stop of candidates alone a candidate stop', () => {
    expect(groupStops(hops).map((g) => g.candidate)).toEqual([false, true, false])
  })

  it('says "candidate" first on the leg, whichever end it is at', () => {
    expect(legSummary(hops[1]!)).toBe('candidate · ≥ 10 km · 5 min')
    expect(legSummary(hops[2]!, isCandidateLeg(hops, 2))).toBe('candidate · ≥ 10 km · 5 min')
    expect(legSummary(hops[2]!)).toBe('≥ 10 km · 5 min')
  })
})
