/**
 * The arithmetic behind the traffic screen's charts, kept apart from the
 * screen so it can be tested without rendering anything — and so the screen
 * module exports only components, which is what lets the dev server swap it
 * in place rather than reloading every page that imports it.
 *
 * Nothing here fetches or invents a figure. Each function decides how an
 * observed figure is *drawn*: where time ticks fall, where a line must break,
 * what a forecast picture includes, and when a server read was cut short.
 */

import type { TrafficResponse } from '@/lib/types'

export const MINUTE = 60_000
export const HOUR = 60 * MINUTE
export const DAY = 24 * HOUR
/** IST is UTC+05:30 all year — no daylight saving to account for. */
const IST_OFFSET_MS = 5.5 * HOUR

/** A traffic read that covered only part of its window. */
export interface TrafficSample {
  /** Vehicles the road figures were computed from: the window's latest. */
  read: number
  /** Vehicles in the whole window, counted by the server. */
  observed: number
}

/**
 * What the traffic endpoint's read covered, when it was not the whole window.
 *
 * The server reads a bounded number of detection rows, **newest first**, and
 * says when the window held more (`truncated`, with `rows_read` and
 * `rows_total`). Past the bound the type mix, road state and obstructions
 * describe the latest part of the window, and the screen says so beside each
 * of them. This used to be inferred here from a mirrored copy of the server's
 * cap and the uncapped bucket total; the server now states it.
 */
export function trafficSample(
  traffic: Pick<TrafficResponse, 'truncated' | 'rows_read' | 'rows_total'> | null,
): TrafficSample | null {
  if (!traffic?.truncated) return null
  return { read: traffic.rows_read, observed: traffic.rows_total }
}

/**
 * Axis ticks on round IST boundaries — every ten minutes, hour, three hours
 * or midnight — between two instants.
 *
 * Recharts' own number-axis ticks are "nice" in milliseconds since 1970,
 * which lands them on times like 21:17:46. A control room reads the clock on
 * the wall, so the ticks are put where that clock's hands would be.
 */
export function istTicks(startMs: number, endMs: number, stepMs: number): number[] {
  if (!(stepMs > 0) || !(endMs > startMs)) return []
  const first = Math.ceil((startMs + IST_OFFSET_MS) / stepMs) * stepMs - IST_OFFSET_MS
  const ticks: number[] = []
  for (let t = first; t <= endMs; t += stepMs) ticks.push(t)
  return ticks
}

/** Set on rows by `withGaps`: a stand-in for missing buckets, or a real
 *  bucket with no real neighbour on either side. */
export interface TimeFlags {
  gap?: boolean
  isolated?: boolean
}

/**
 * Break a bucketed series where buckets are missing.
 *
 * The API returns a bucket only when it has rows, so consecutive buckets more
 * than one width apart mean a stretch with no detections at all — the camera
 * fleet was quiet, down, or not yet running; nothing here can tell which. A
 * blank row is inserted in the first missing bucket, which a chart drawn with
 * `connectNulls={false}` renders as a break rather than a slope.
 *
 * A real bucket left with blanks on both sides would then draw nothing at
 * all — a line needs two points — so it is marked `isolated` and drawn as a
 * dot instead of being silently lost.
 */
export function withGaps<T extends { t: number }>(
  rows: readonly T[],
  bucketMs: number,
  blank: (t: number) => T,
): Array<T & TimeFlags> {
  const out: Array<T & TimeFlags> = []
  rows.forEach((row, i) => {
    const previous = rows[i - 1]
    if (previous && bucketMs > 0 && row.t - previous.t > bucketMs * 1.5) {
      out.push({ ...blank(previous.t + bucketMs), gap: true })
    }
    out.push({ ...row })
  })
  out.forEach((row, i) => {
    if (row.gap) return
    const before = out[i - 1]
    const after = out[i + 1]
    row.isolated = (!before || before.gap === true) && (!after || after.gap === true)
  })
  return out
}

/**
 * When the first real bucket starts well after the window does, the instant it
 * starts — so the chart can say "nothing before 18:35" rather than leave most
 * of its width blank and let that read as a fault. A lead-in shorter than a
 * twelfth of the window is not worth a label.
 */
export function quietLeadIn(
  rows: readonly (TimeFlags & { t: number })[],
  startMs: number,
  endMs: number,
): number | null {
  const first = rows.find((row) => !row.gap)
  if (!first || !(endMs > startMs)) return null
  return first.t - startMs > (endMs - startMs) / 12 ? first.t : null
}

/** The API's factor slugs, in the words an operator reads. */
const FACTOR_LABEL: Record<string, string> = {
  occupancy: 'Occupancy',
  speed: 'Speed',
  travel_time: 'Travel time',
  no_signal: 'No signal',
  inflow_trend: 'Inflow trend',
  upstream_inflow: 'Upstream inflow',
  speed_trend: 'Approach speed',
}

/** `upstream_inflow` → "Upstream inflow". An unknown slug is humanised rather
 *  than hidden: a reason the UI has no word for is still a reason. */
export function factorLabel(slug: string): string {
  const known = FACTOR_LABEL[slug]
  if (known) return known
  const words = slug.replace(/[_-]+/g, ' ').trim()
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : slug
}

export interface ForecastGeometry {
  points: { minutes: number; value: number; x: number; y: number }[]
  /** Polygon points for the backtested-error band, or null with no backtest. */
  band: string | null
  /** Where 100% — "typical for this hour" — falls. */
  typicalY: number
}

/**
 * Lay out a forecast — now, +15, +30 — on a small canvas, with the 100%
 * "typical" line and the backtested error as a band around the projection.
 *
 * The scale always includes 100%, so a camera running at 60% of typical
 * reads as below the line rather than as a full-height chart of a small
 * number. The band narrows to nothing at "now", which is observed, and
 * widens to ±MAE at each horizon; it is clamped at zero because a volume
 * index below zero is not a thing.
 */
export function forecastGeometry(
  now: number,
  horizons: { minutes: number; value: number | null }[],
  mae: number | null,
  width: number,
  height: number,
  pad = 6,
): ForecastGeometry {
  const known = horizons.filter((h): h is { minutes: number; value: number } => h.value !== null)
  const values = [now, ...known.map((h) => h.value)]
  const spread = mae ?? 0
  let lo = Math.min(100, ...values.map((v) => Math.max(0, v - spread)))
  let hi = Math.max(100, ...values.map((v) => v + spread))
  const room = Math.max(10, (hi - lo) * 0.12)
  lo = Math.max(0, lo - room)
  hi += room
  const span = Math.max(30, ...known.map((h) => h.minutes))
  const x = (minutes: number) => pad + (minutes / span) * (width - 2 * pad)
  const y = (value: number) => pad + ((hi - value) / (hi - lo)) * (height - 2 * pad)

  const points = [{ minutes: 0, value: now }, ...known].map((p) => ({
    ...p,
    x: x(p.minutes),
    y: y(p.value),
  }))

  let band: string | null = null
  if (mae !== null && known.length > 0) {
    const upper = known.map((h) => `${x(h.minutes).toFixed(1)},${y(h.value + mae).toFixed(1)}`)
    const lower = [...known]
      .reverse()
      .map((h) => `${x(h.minutes).toFixed(1)},${y(Math.max(0, h.value - mae)).toFixed(1)}`)
    band = [`${x(0).toFixed(1)},${y(now).toFixed(1)}`, ...upper, ...lower].join(' ')
  }

  return { points, band, typicalY: y(100) }
}
