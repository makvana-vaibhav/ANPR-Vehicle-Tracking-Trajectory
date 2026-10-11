/**
 * Probe history, bucketed for the Fleet health chart.
 *
 * A stretch with no probes must stay a gap, and a cached 0 ms answer must not
 * pass for a measured round trip.
 */

import { describe, expect, it } from 'vitest'

import { bucketProbes, bucketWidthMs, median, type Probe } from '@/components/network/probeHistory'

const MIN = 60_000
const T0 = Date.parse('2026-10-11T16:00:00Z')

function probe(minutes: number, reachable: boolean, latency: number | null = 100, error: string | null = null): Probe {
  return {
    ts: new Date(T0 + minutes * MIN).toISOString(),
    reachable,
    fps_actual: null,
    latency_ms: latency,
    bitrate_kbps: null,
    error_code: reachable ? null : (error ?? 'sandbox_unreachable'),
  }
}

describe('bucketWidthMs', () => {
  it('rounds to a clock-friendly width', () => {
    expect(bucketWidthMs(60 * MIN) / MIN).toBe(5)
    expect(bucketWidthMs(125 * MIN) / MIN).toBe(10)
    expect(bucketWidthMs(24 * 60 * MIN) / MIN).toBe(60)
  })
})

describe('median', () => {
  it('takes the middle, or the mean of the two middles', () => {
    expect(median([5, 1, 3])).toBe(3)
    expect(median([4, 1, 3, 2])).toBe(2.5)
    expect(median([])).toBeNull()
  })
})

describe('bucketProbes', () => {
  it('counts the share answered per bucket, newest data in any order', () => {
    const buckets = bucketProbes(
      [probe(6, true), probe(1, true), probe(2, false), probe(3, true), probe(4, false)],
      5 * MIN,
    )
    expect(buckets).toHaveLength(2)
    expect(buckets[0]).toMatchObject({ start: T0, probes: 4, answered: 2, answeredPct: 50, failedPct: 50 })
    expect(buckets[1]).toMatchObject({ start: T0 + 5 * MIN, probes: 1, answered: 1, answeredPct: 100, failedPct: 0 })
  })

  it('keeps an empty stretch as an empty bucket rather than closing the gap', () => {
    const buckets = bucketProbes([probe(1, true), probe(16, true)], 5 * MIN)
    expect(buckets.map((b) => b.probes)).toEqual([1, 0, 0, 1])
    expect(buckets[1]).toMatchObject({ answeredPct: null, failedPct: null, latencyMs: null })
  })

  it('leaves 0 ms answers out of the round trip, and names the commonest failure', () => {
    const [bucket] = bucketProbes(
      [
        probe(0, true, 0),
        probe(1, true, 600),
        probe(2, true, 800),
        probe(3, false, 0, 'timeout'),
        probe(4, false, 0, 'sandbox_unreachable'),
        probe(4.5, false, 0, 'sandbox_unreachable'),
      ],
      5 * MIN,
    )
    expect(bucket?.latencyMs).toBe(700)
    expect(bucket?.topError).toBe('sandbox_unreachable')
  })

  it('returns nothing for no history', () => {
    expect(bucketProbes([])).toEqual([])
  })
})
