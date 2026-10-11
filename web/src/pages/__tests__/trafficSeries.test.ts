/**
 * The pure parts of the traffic screen — the ones that decide what a chart
 * claims about time and what a forecast picture shows.
 *
 * Each pins a way the screen could say something false: a slope drawn through
 * hours nothing was observed in, a bucket silently lost because it had no
 * neighbour, axis ticks at times no clock shows, a reason dropped because the
 * UI had no word for it, a forecast drawn without the 100% it is measured
 * against.
 */

import { describe, expect, it } from 'vitest'

import {
  factorLabel,
  forecastGeometry,
  isTruncatedRead,
  istTicks,
  quietLeadIn,
  withGaps,
} from '@/pages/trafficSeries'

const MIN = 60_000
const HOUR = 60 * MIN

function ist(ms: number): string {
  return new Intl.DateTimeFormat('en-IN', {
    timeZone: 'Asia/Kolkata',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(ms)
}

describe('istTicks', () => {
  it('puts ticks on round IST hours, not round UTC ones', () => {
    // 18:00 UTC is 23:30 IST, so the first three-hourly tick is IST midnight.
    const start = Date.parse('2026-10-10T18:00:00Z')
    const end = Date.parse('2026-10-11T18:00:00Z')
    const ticks = istTicks(start, end, 3 * HOUR)

    expect(ticks[0]).toBe(Date.parse('2026-10-10T18:30:00Z'))
    expect(ticks.map(ist)).toEqual([
      '00:00',
      '03:00',
      '06:00',
      '09:00',
      '12:00',
      '15:00',
      '18:00',
      '21:00',
    ])
    expect(ticks.every((t) => t >= start && t <= end)).toBe(true)
  })

  it('lands daily ticks on IST midnight', () => {
    const start = Date.parse('2026-10-04T18:00:00Z')
    const end = Date.parse('2026-10-11T18:00:00Z')
    const ticks = istTicks(start, end, 24 * HOUR)
    expect(ticks).toHaveLength(7)
    expect(ticks.map(ist).every((label) => label === '00:00')).toBe(true)
  })

  it('returns nothing for an empty window or a non-positive step', () => {
    const t = Date.parse('2026-10-11T00:00:00Z')
    expect(istTicks(t, t, HOUR)).toEqual([])
    expect(istTicks(t + HOUR, t, HOUR)).toEqual([])
    expect(istTicks(t, t + HOUR, 0)).toEqual([])
  })
})

type Row = { t: number; v: number | null }
const blank = (t: number): Row => ({ t, v: null })

describe('withGaps', () => {
  it('leaves contiguous buckets alone', () => {
    const rows: Row[] = [0, 5, 10].map((m) => ({ t: m * MIN, v: m }))
    const out = withGaps(rows, 5 * MIN, blank)
    expect(out.map((r) => r.t)).toEqual([0, 5 * MIN, 10 * MIN])
    expect(out.some((r) => r.gap)).toBe(false)
    expect(out.some((r) => r.isolated)).toBe(false)
  })

  it('breaks the line where buckets are missing instead of bridging them', () => {
    const rows: Row[] = [
      { t: 0, v: 15 },
      { t: 5 * MIN, v: 20 },
      { t: 30 * MIN, v: 141 },
      { t: 35 * MIN, v: 466 },
    ]
    const out = withGaps(rows, 5 * MIN, blank)
    expect(out).toHaveLength(5)
    const gap = out[2]
    expect(gap?.gap).toBe(true)
    expect(gap?.v).toBeNull()
    // The blank sits in the first missing bucket, not halfway across.
    expect(gap?.t).toBe(10 * MIN)
  })

  it('marks a bucket with no real neighbour, so it is drawn as a dot rather than lost', () => {
    const rows: Row[] = [
      { t: 0, v: 15 },
      { t: 30 * MIN, v: 141 },
      { t: 35 * MIN, v: 466 },
      { t: 90 * MIN, v: 9 },
    ]
    const out = withGaps(rows, 5 * MIN, blank)
    const real = out.filter((r) => !r.gap)
    expect(real.map((r) => Boolean(r.isolated))).toEqual([true, false, false, true])
  })

  it('treats a lone bucket as isolated and an empty series as empty', () => {
    expect(withGaps([{ t: 0, v: 1 }], 5 * MIN, blank)[0]?.isolated).toBe(true)
    expect(withGaps([], 5 * MIN, blank)).toEqual([])
  })
})

describe('quietLeadIn', () => {
  const start = 0
  const end = 24 * HOUR

  it('reports when observation began, if most of the window came before it', () => {
    const rows = [{ t: 18 * HOUR }, { t: 18 * HOUR + 5 * MIN }]
    expect(quietLeadIn(rows, start, end)).toBe(18 * HOUR)
  })

  it('stays quiet when data starts near the beginning of the window', () => {
    expect(quietLeadIn([{ t: HOUR }], start, end)).toBeNull()
  })

  it('looks past gap rows to the first real bucket, and handles no data at all', () => {
    expect(quietLeadIn([{ t: 2 * HOUR, gap: true }, { t: 12 * HOUR }], start, end)).toBe(12 * HOUR)
    expect(quietLeadIn([], start, end)).toBeNull()
  })
})

describe('factorLabel', () => {
  it('names the factors the API sends', () => {
    expect(factorLabel('inflow_trend')).toBe('Inflow trend')
    expect(factorLabel('upstream_inflow')).toBe('Upstream inflow')
    expect(factorLabel('speed_trend')).toBe('Approach speed')
    expect(factorLabel('occupancy')).toBe('Occupancy')
  })

  it('humanises a factor it has no word for rather than hiding it', () => {
    expect(factorLabel('queue_spill-back')).toBe('Queue spill back')
    expect(factorLabel('')).toBe('')
  })
})

describe('forecastGeometry', () => {
  const W = 320
  const H = 64

  it('draws higher values higher and always includes the 100% line', () => {
    const g = forecastGeometry(
      128,
      [
        { minutes: 15, value: 138 },
        { minutes: 30, value: 147 },
      ],
      7.4,
      W,
      H,
    )
    expect(g.points.map((p) => p.minutes)).toEqual([0, 15, 30])
    const [now, plus15, plus30] = g.points
    expect(now!.y).toBeGreaterThan(plus15!.y)
    expect(plus15!.y).toBeGreaterThan(plus30!.y)
    // 100% is below all three, and on the canvas.
    expect(g.typicalY).toBeGreaterThan(now!.y)
    expect(g.typicalY).toBeLessThanOrEqual(H)
    expect(now!.x).toBeLessThan(plus30!.x)
  })

  it('draws a band only when the forecast has a backtested error', () => {
    const horizons = [
      { minutes: 15, value: 80 },
      { minutes: 30, value: 75 },
    ]
    expect(forecastGeometry(84, horizons, null, W, H).band).toBeNull()
    const band = forecastGeometry(84, horizons, 5, W, H).band
    // now, two upper points, two lower points.
    expect(band?.split(' ')).toHaveLength(5)
  })

  it('keeps 100% on the canvas for a camera far below typical', () => {
    const g = forecastGeometry(20, [{ minutes: 15, value: 18 }], null, W, H)
    expect(g.typicalY).toBeGreaterThanOrEqual(0)
    expect(g.typicalY).toBeLessThan(g.points[0]!.y)
  })

  it('never takes the band below a zero index', () => {
    const g = forecastGeometry(5, [{ minutes: 15, value: 4 }], 20, W, H)
    const lowest = Math.max(...(g.band ?? '').split(' ').map((pair) => Number(pair.split(',')[1])))
    // y grows downward; the lowest band point is the zero line, inside the canvas.
    expect(lowest).toBeLessThanOrEqual(H)
  })

  it('skips horizons the API could not forecast', () => {
    const g = forecastGeometry(
      96,
      [
        { minutes: 15, value: null },
        { minutes: 30, value: null },
      ],
      null,
      W,
      H,
    )
    expect(g.points).toHaveLength(1)
    expect(g.band).toBeNull()
  })
})

describe('isTruncatedRead', () => {
  it('flags a read that stopped at the cap while the buckets saw more', () => {
    expect(isTruncatedRead(20_000, 27_101)).toBe(true)
  })

  it('does not flag a complete read, or a window that holds exactly the cap', () => {
    expect(isTruncatedRead(6_085, 6_085)).toBe(false)
    expect(isTruncatedRead(20_000, 20_000)).toBe(false)
  })

  it('does not take a few late arrivals under the cap for truncation', () => {
    // A detection can land between the two queries; that is not a cap.
    expect(isTruncatedRead(19_998, 20_003)).toBe(false)
  })

  it('cannot judge without the bucket count', () => {
    expect(isTruncatedRead(20_000, null)).toBe(false)
  })
})
