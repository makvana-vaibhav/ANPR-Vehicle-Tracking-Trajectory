/**
 * The arithmetic behind a drawn journey, kept apart from MapLibre so it can be
 * tested: which sightings share a marker, how bright each part of the trail
 * is, and the words a leg is labelled with.
 *
 * ## The trail
 *
 * A journey is drawn as a contrail — a straight line through the sightings in
 * time order that fades towards the oldest end, so the direction of travel and
 * the most recent position read at a glance. MapLibre's `line-gradient` paints
 * along one line by `line-progress` (fraction of the line's length), and it
 * cannot vary per feature, so the brightness at every sighting is computed
 * here and handed over as gradient stops.
 *
 * A leg the correlator could not believe is cut out of the trail entirely
 * (transparent) and drawn on its own as a red dashed line. A trail running
 * through an impossible leg would draw the one thing on the page the platform
 * does not believe in the colour of the things it does.
 */

import type { RouteHop } from '@/lib/types'

// ── Markers ──────────────────────────────────────────────────────────

/** One place on the map, and every visit made to it. */
export interface StopGroup {
  /** Position in the returned list; also the GeoJSON feature id. */
  id: number
  lon: number
  lat: number
  /** Every camera at this spot, in order of first visit. */
  camera_codes: string[]
  /** Indices into `hops`, ascending. */
  hops: number[]
  /** `end` wins over `start`: a vehicle seen only at one camera was last seen there. */
  role: 'start' | 'end' | 'via'
  /** At least one visit here was reached by a leg nobody could drive. */
  impossible: boolean
}

/**
 * Visits grouped by where they happened, in order of first visit.
 *
 * A vehicle read at the same camera five times would otherwise be five
 * markers stacked on one point, only the top one visible — the map would say
 * "visit 5" and hide the other four. Grouped by position rather than by
 * camera, because two cameras at one junction (or two whose position is the
 * same town centre) would stack in exactly the same way.
 */
export function groupStops(hops: RouteHop[]): StopGroup[] {
  const groups: StopGroup[] = []
  const byPlace = new Map<string, StopGroup>()
  const last = hops.length - 1
  hops.forEach((hop, index) => {
    // ~1 m: the same spot to any zoom this map is drawn at.
    const place = `${hop.lat.toFixed(5)},${hop.lon.toFixed(5)}`
    let group = byPlace.get(place)
    if (!group) {
      group = {
        id: groups.length,
        lon: hop.lon,
        lat: hop.lat,
        camera_codes: [],
        hops: [],
        role: 'via',
        impossible: false,
      }
      byPlace.set(place, group)
      groups.push(group)
    }
    if (!group.camera_codes.includes(hop.camera_code)) group.camera_codes.push(hop.camera_code)
    group.hops.push(index)
    if (!hop.plausible) group.impossible = true
    if (index === last) group.role = 'end'
    else if (index === 0 && group.role !== 'end') group.role = 'start'
  })
  return groups
}

function run(first: number, last: number): string {
  if (first === last) return String(first)
  return last === first + 1 ? `${first}·${last}` : `${first}–${last}`
}

/**
 * The visit numbers a marker carries, 1-based: `1`, `2·3`, `1–5`, `2–4·7`.
 * Past seven characters it shortens to `first…last` — the full list is in the
 * sightings column beside the map.
 */
export function sequenceLabel(indices: number[]): string {
  const numbers = [...indices].sort((a, b) => a - b).map((i) => i + 1)
  if (numbers.length === 0) return ''
  const parts: string[] = []
  let first = numbers[0]!
  let previous = first
  for (const n of numbers.slice(1)) {
    if (n === previous + 1) {
      previous = n
      continue
    }
    parts.push(run(first, previous))
    first = n
    previous = n
  }
  parts.push(run(first, previous))
  const label = parts.join('·')
  return label.length <= 7 ? label : `${numbers[0]}…${numbers[numbers.length - 1]}`
}

/**
 * The label beside a stop: `SBX-cam10 · 19:12` for one visit (time in IST,
 * passed in already formatted), `CAM-DEMO-01 · 5 visits` for several, and the
 * cameras named — or counted — when more than one shares the spot.
 */
export function stopCaption(group: StopGroup, firstTime: string): string {
  const [first, ...rest] = group.camera_codes
  const cameras =
    rest.length === 0 ? first : rest.length === 1 ? `${first}, ${rest[0]}` : `${first} +${rest.length}`
  return group.hops.length === 1 ? `${cameras} · ${firstTime}` : `${cameras} · ${group.hops.length} visits`
}

// ── The trail ────────────────────────────────────────────────────────

/** A point on a trail, and when the vehicle was there (seconds from the start). */
export interface TrailVertex {
  lon: number
  lat: number
  t: number
}

/**
 * Web Mercator, in world units. `line-progress` is measured in the projected
 * plane, so progress computed in degrees would put a stop in the wrong place
 * on any leg that is not due east-west.
 */
function project(lon: number, lat: number): [number, number] {
  const s = Math.sin((lat * Math.PI) / 180)
  return [(lon + 180) / 360, 0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)]
}

/** Brightness at the oldest end of a trail: faint, never invisible. */
export const TAIL_ALPHA = 0.22

/**
 * `line-gradient` for a trail through `vertices`.
 *
 * `believed[k]` (k ≥ 1) says whether the leg into vertex `k` is believed.
 * Brightness follows **time**, not distance: a vertex's alpha is how far
 * through the journey's clock the vehicle was there. A long fast leg and a
 * short slow one are each as bright as their moment, not their length.
 *
 * Null when the trail has no length — every sighting in one place leaves
 * nothing to draw, and an interpolation needs at least one stop.
 */
export function trailGradient(
  vertices: TrailVertex[],
  believed: boolean[],
  rgb: readonly [number, number, number],
  tailAlpha = TAIL_ALPHA,
): unknown[] | null {
  if (vertices.length < 2) return null

  const points = vertices.map((v) => project(v.lon, v.lat))
  const cumulative = [0]
  for (let k = 1; k < points.length; k += 1) {
    const [x0, y0] = points[k - 1]!
    const [x1, y1] = points[k]!
    cumulative.push(cumulative[k - 1]! + Math.hypot(x1 - x0, y1 - y0))
  }
  const length = cumulative[cumulative.length - 1]!
  if (!(length > 0)) return null

  const progress = cumulative.map((d) => d / length)
  const span = vertices[vertices.length - 1]!.t - vertices[0]!.t
  const alphaAt = (k: number): number => {
    const fraction =
      span > 0 ? (vertices[k]!.t - vertices[0]!.t) / span : progress[k]!
    return tailAlpha + (1 - tailAlpha) * Math.min(1, Math.max(0, fraction))
  }

  const stops: [number, number][] = []
  const push = (at: number, alpha: number) => {
    // `interpolate` demands strictly ascending inputs; a repeat (a zero-length
    // revisit leg) adds nothing a neighbour does not already say.
    const previous = stops[stops.length - 1]
    if (previous && at <= previous[0]) return
    stops.push([at, alpha])
  }

  for (let k = 1; k < vertices.length; k += 1) {
    const from = progress[k - 1]!
    const to = progress[k]!
    if (to <= from) continue
    if (believed[k] ?? true) {
      push(from, alphaAt(k - 1))
      push(to, alphaAt(k))
    } else {
      // Transparent strictly inside the leg, so the believed legs either side
      // keep their own brightness right up to the shared sighting.
      const inset = (to - from) * 0.02
      push(from + inset, 0)
      push(to - inset, 0)
    }
  }
  if (stops.length === 0) return null

  const [r, g, b] = rgb
  return [
    'interpolate',
    ['linear'],
    ['line-progress'],
    ...stops.flatMap(([at, alpha]) => [at, `rgba(${r}, ${g}, ${b}, ${alpha.toFixed(3)})`]),
  ]
}

/** The whole journey as a trail: every sighting, and which legs are believed. */
export function journeyTrail(
  hops: RouteHop[],
  timeline: number[],
): { vertices: TrailVertex[]; believed: boolean[] } {
  return {
    vertices: hops.map((hop, i) => ({ lon: hop.lon, lat: hop.lat, t: timeline[i] ?? 0 })),
    believed: hops.map((hop) => hop.plausible),
  }
}

/**
 * The part of the journey behind the vehicle `seconds` into playback: every
 * sighting already reached, then where it is now. The leg it is part-way along
 * is believed or not as the leg itself is.
 */
export function travelledTrail(
  hops: RouteHop[],
  timeline: number[],
  seconds: number,
  here: [number, number],
): { vertices: TrailVertex[]; believed: boolean[] } {
  const vertices: TrailVertex[] = []
  const believed: boolean[] = []
  let reached = 0
  for (let i = 0; i < hops.length; i += 1) {
    if ((timeline[i] ?? Infinity) > seconds) break
    vertices.push({ lon: hops[i]!.lon, lat: hops[i]!.lat, t: timeline[i]! })
    believed.push(hops[i]!.plausible)
    reached = i + 1
  }
  if (reached === 0) return { vertices: [], believed: [] }
  vertices.push({ lon: here[0], lat: here[1], t: seconds })
  believed.push(hops[reached]?.plausible ?? true)
  return { vertices, believed }
}

// ── Words and figures ────────────────────────────────────────────────

/** `42 s`, `18 min`, `4 h 02 min`, `3 d 4 h`. */
export function formatDuration(seconds: number): string {
  if (seconds < 60) return `${Math.round(seconds)} s`
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes} min`
  const hours = Math.floor(minutes / 60)
  if (hours < 48) return `${hours} h ${String(minutes % 60).padStart(2, '0')} min`
  return `${Math.floor(hours / 24)} d ${hours % 24} h`
}

/** Kilometres at the precision a straight-line distance deserves. */
export function formatKm(km: number): string {
  return km < 10 ? km.toFixed(1) : String(Math.round(km))
}

/**
 * A leg in a few words — `≥ 1.2 km · 4 min · ≥ 18 km/h`, or for one no vehicle
 * could drive, `≥ 300 km in 3 min · impossible`. Every figure is a lower bound
 * (straight line, not road) and says so with `≥`. Null for the first visit,
 * which has no leg, and for a leg of no length, which has nothing to say.
 */
export function legSummary(hop: RouteHop): string | null {
  if (hop.distance_km === null || hop.elapsed_s === null) return null
  if (hop.distance_km <= 0) return null
  const km = `≥ ${formatKm(hop.distance_km)} km`
  const time = formatDuration(hop.elapsed_s)
  if (!hop.plausible) return `${km} in ${time} · impossible`
  const speed = hop.implied_kmph !== null ? ` · ≥ ${Math.round(hop.implied_kmph)} km/h` : ''
  return `${km} · ${time}${speed}`
}

// ── The timeline axis ────────────────────────────────────────────────

const IST_OFFSET_S = 5.5 * 3600
const TICK_STEPS_S = [60, 300, 600, 900, 1800, 3600, 7200, 10_800, 21_600, 43_200, 86_400]

/**
 * Clock ticks for a journey's timeline, on round IST times (19:00, 19:30…),
 * as seconds from the first sighting. India keeps no daylight saving, so the
 * fixed +05:30 offset is exact; the labels themselves are rendered by
 * `Intl` in Asia/Kolkata like every other time on screen.
 */
export function timelineTicks(
  startIso: string,
  totalSeconds: number,
  maxTicks = 6,
): { at: number; label: string }[] {
  if (!(totalSeconds > 0)) return []
  const step =
    TICK_STEPS_S.find((s) => totalSeconds / s <= maxTicks) ?? TICK_STEPS_S[TICK_STEPS_S.length - 1]!
  const startS = new Date(startIso).getTime() / 1000
  const first = Math.ceil((startS + IST_OFFSET_S) / step) * step - IST_OFFSET_S
  const format = new Intl.DateTimeFormat(
    'en-IN',
    step >= 86_400
      ? { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short' }
      : { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' },
  )
  const ticks: { at: number; label: string }[] = []
  for (let t = first; t <= startS + totalSeconds; t += step) {
    ticks.push({ at: t - startS, label: format.format(new Date(t * 1000)) })
  }
  return ticks
}
