/**
 * A camera's probe history, cut into time buckets for a chart.
 *
 * The health monitor probes every camera every few seconds and the API hands
 * back the most recent 500 probes. Plotted one by one that is a barcode;
 * bucketed into about two dozen intervals it answers the two questions an
 * operator asks — how much of the time did it answer, and how fast.
 */

import type { CameraHealthHistory } from '@/lib/types'

export type Probe = CameraHealthHistory['history'][number]

export interface ProbeBucket {
  /** Bucket bounds, epoch milliseconds, [start, end). */
  start: number
  end: number
  probes: number
  answered: number
  /** Share of probes answered, 0–100; null when nothing was probed. */
  answeredPct: number | null
  /** The rest of the bar: 100 − answeredPct; null when nothing was probed. */
  failedPct: number | null
  /** Median round trip of the probes that measured one; null when none did. */
  latencyMs: number | null
  /** The most frequent failure in the bucket, or null when none failed. */
  topError: string | null
}

const NICE_MINUTES = [1, 2, 5, 10, 15, 30, 60, 120, 240, 480, 1440]

/** A clock-friendly bucket width that cuts `spanMs` into roughly `target` columns. */
export function bucketWidthMs(spanMs: number, target = 24): number {
  const raw = Math.max(spanMs, 60_000) / target / 60_000
  const minutes = NICE_MINUTES.find((m) => m >= raw) ?? NICE_MINUTES[NICE_MINUTES.length - 1] ?? 60
  return minutes * 60_000
}

export function median(values: number[]): number | null {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  const upper = sorted[mid] ?? 0
  return sorted.length % 2 === 1 ? upper : ((sorted[mid - 1] ?? upper) + upper) / 2
}

/**
 * Bucket probes on clock-aligned boundaries.
 *
 * Every bucket between the first probe and the last is returned, including
 * empty ones: a stretch with no probes at all is information (the monitor
 * stopped), and closing the gap would draw it as a stretch of answers.
 *
 * A probe that reports 0 ms measured no round trip — the grid's adapter
 * answers most probes from a cached copy of the grid's catalogue — so it
 * counts towards "answered" but is left out of the latency median rather
 * than dragging it towards zero.
 */
export function bucketProbes(history: Probe[], widthMs?: number): ProbeBucket[] {
  const probes = history
    .map((probe) => ({ probe, t: Date.parse(probe.ts) }))
    .filter((entry) => Number.isFinite(entry.t))
    .sort((a, b) => a.t - b.t)

  const first = probes[0]?.t
  const last = probes[probes.length - 1]?.t
  if (first === undefined || last === undefined) return []

  const width = widthMs ?? bucketWidthMs(last - first)
  const origin = Math.floor(first / width) * width
  const count = Math.floor((last - origin) / width) + 1

  const groups: Probe[][] = Array.from({ length: count }, () => [])
  for (const { probe, t } of probes) {
    groups[Math.min(count - 1, Math.floor((t - origin) / width))]?.push(probe)
  }

  return groups.map((group, index) => {
    const start = origin + index * width
    const answered = group.filter((p) => p.reachable === true).length
    const answeredPct = group.length ? Math.round((answered / group.length) * 1000) / 10 : null
    const latencies = group
      .map((p) => p.latency_ms)
      .filter((ms): ms is number => typeof ms === 'number' && ms > 0)

    const errors = new Map<string, number>()
    for (const p of group) {
      if (p.reachable !== true && p.error_code) {
        errors.set(p.error_code, (errors.get(p.error_code) ?? 0) + 1)
      }
    }
    const [topError] = [...errors.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))

    return {
      start,
      end: start + width,
      probes: group.length,
      answered,
      answeredPct,
      failedPct: answeredPct === null ? null : Math.round((100 - answeredPct) * 10) / 10,
      latencyMs: median(latencies),
      topError: topError?.[0] ?? null,
    }
  })
}
