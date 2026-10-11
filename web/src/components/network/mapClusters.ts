/**
 * Cameras, grouped for drawing on a map at a given zoom.
 *
 * Two kinds of togetherness, kept apart because they mean different things:
 *
 *   co-located  cameras registered at the same coordinate. The organisers'
 *               grid publishes most cameras with a town and no junction, so a
 *               town's cameras all sit on its centre. No zoom separates them —
 *               they are one marker with a count, listed when clicked.
 *   nearby      cameras at different coordinates that are too close to tell
 *               apart at this zoom: Ahmedabad's town-centre cameras and the
 *               demo camera on Ashram Road, two kilometres apart, at state
 *               scale. They share a marker until the operator zooms in.
 *
 * Grouping happens in screen space, against the current projection, so the
 * same estate reads as ten towns across Gujarat and as separate junctions
 * once zoomed into a city — the scale a city deployment of a thousand
 * cameras needs as much as this one.
 */

import { isUnplaced } from '@/lib/places'
import type { Camera, CameraStatus, CongestionLevel } from '@/lib/types'

import { STATUS_LABEL, STATUS_ORDER, TOWN_LEVEL_TAG, townOf } from './cameraFacts'

/* Map paint and the markers' inline fills cannot take Tailwind classes, so the
   colours they need are named here by value and shared with the legend that
   explains them. Keep in step with styles/index.css and CommandMap. */

/** A camera place: light, but below --foreground. */
export const MARKER_FILL = '#C9D3DD'
/** --faint: a place where no camera's state can be told. */
export const MARKER_FILL_DIM = '#7A8897'

/**
 * Corridor congestion, quiet to loud. Flowing traffic is normal, so it is
 * grey; the warm steps are the severity palette, because a corridor at a
 * standstill is the thing a person may need to act on.
 */
export const CONGESTION_COLOUR: Record<CongestionLevel, string> = {
  free: '#9AA9B8', // --muted-foreground
  moderate: '#F5C37A', // a pale step of --priority-high
  heavy: '#F5A33C', // --priority-high
  severe: '#FF5C55', // --priority-critical
}
/** A corridor nothing was measured on: faint, never the flowing grey. */
export const NO_FIGURE_COLOUR = '#2A3644' // --input

/** Detection density in the trail's one hue, transparent to near-white. */
export const HEATMAP_STOPS: [number, string][] = [
  [0, 'rgba(92, 200, 255, 0)'],
  [0.2, 'rgba(92, 200, 255, 0.18)'],
  [0.45, 'rgba(92, 200, 255, 0.4)'],
  [0.7, 'rgba(150, 220, 255, 0.6)'],
  [1, 'rgba(230, 246, 255, 0.85)'],
]

/** Markers whose centres are closer than this, in pixels, are drawn as one. */
export const CLUSTER_RADIUS_PX = 20

export interface Spot {
  /** The coordinate, to five decimals (about a metre). */
  key: string
  lon: number
  lat: number
  cameras: Camera[]
}

export interface MapCluster {
  /** The anchor spot's key: stable across refreshes while the estate is. */
  key: string
  name: string
  /** Where the marker sits — on its largest member, never between members. */
  lon: number
  lat: number
  cameras: Camera[]
  /** How many distinct coordinates the cluster holds. */
  spots: number
  /** Several cameras at one coordinate: zooming in will not separate them. */
  colocated: boolean
  /** Every camera in it is positioned only to its town. */
  townLevel: boolean
}

export type ClusterTone = 'offline' | 'degraded' | 'unknown' | 'normal'

function isTownLevel(camera: Camera): boolean {
  return camera.tags?.includes(TOWN_LEVEL_TAG) ?? false
}

/** Cameras grouped by registered coordinate. Unplaced cameras are left out. */
export function spotsOf(cameras: Camera[]): Spot[] {
  const byKey = new Map<string, Spot>()
  for (const camera of cameras) {
    if (isUnplaced(camera)) continue
    if (!Number.isFinite(camera.lat) || !Number.isFinite(camera.lon)) continue
    const key = `${camera.lat.toFixed(5)},${camera.lon.toFixed(5)}`
    const spot = byKey.get(key)
    if (spot) spot.cameras.push(camera)
    else byKey.set(key, { key, lat: camera.lat, lon: camera.lon, cameras: [camera] })
  }
  const spots = [...byKey.values()]
  for (const spot of spots) {
    spot.cameras.sort((a, b) => a.camera_code.localeCompare(b.camera_code))
  }
  // Largest first: each cluster is anchored on the first spot to claim it, so
  // the marker lands where most of its cameras actually are.
  spots.sort((a, b) => b.cameras.length - a.cameras.length || a.key.localeCompare(b.key))
  return spots
}

/**
 * Greedy screen-space clustering.
 *
 * Every spot within `radius` pixels of an unclaimed anchor joins it; anchors
 * are taken largest first. Neighbours are found through a grid of
 * radius-sized cells, so each spot is compared with a handful of others
 * rather than with the whole estate.
 */
export function clusterSpots(
  spots: Spot[],
  project: (lon: number, lat: number) => { x: number; y: number },
  radius: number = CLUSTER_RADIUS_PX,
): MapCluster[] {
  const points = spots.map((spot) => ({ spot, p: project(spot.lon, spot.lat) }))
  const cellOf = (x: number, y: number) => `${Math.floor(x / radius)}:${Math.floor(y / radius)}`

  const cells = new Map<string, number[]>()
  points.forEach((point, index) => {
    const key = cellOf(point.p.x, point.p.y)
    const bucket = cells.get(key)
    if (bucket) bucket.push(index)
    else cells.set(key, [index])
  })

  const claimed = new Array<boolean>(points.length).fill(false)
  const clusters: MapCluster[] = []

  points.forEach((anchor, index) => {
    if (claimed[index]) return
    claimed[index] = true
    const members: Spot[] = [anchor.spot]
    const cx = Math.floor(anchor.p.x / radius)
    const cy = Math.floor(anchor.p.y / radius)
    for (let dx = -1; dx <= 1; dx += 1) {
      for (let dy = -1; dy <= 1; dy += 1) {
        for (const other of cells.get(`${cx + dx}:${cy + dy}`) ?? []) {
          if (claimed[other]) continue
          const q = points[other]
          if (!q) continue
          if (Math.hypot(q.p.x - anchor.p.x, q.p.y - anchor.p.y) <= radius) {
            claimed[other] = true
            members.push(q.spot)
          }
        }
      }
    }

    const cameras = members.flatMap((spot) => spot.cameras)
    clusters.push({
      key: anchor.spot.key,
      name: clusterName(cameras),
      lon: anchor.spot.lon,
      lat: anchor.spot.lat,
      cameras,
      spots: members.length,
      colocated: members.length === 1 && cameras.length > 1,
      townLevel: cameras.length > 0 && cameras.every(isTownLevel),
    })
  })
  return clusters
}

/**
 * What a marker is called.
 *
 * A single precisely placed camera is named for its junction. Anything else —
 * a town-level camera, or several cameras — is named for the town most of
 * them are in: a junction name drawn at a town's centre would claim a
 * precision the registry does not have.
 */
export function clusterName(cameras: Camera[]): string {
  const [only] = cameras
  if (!only) return ''
  if (cameras.length === 1) {
    return isTownLevel(only) ? townOf(only) : only.junction?.trim() || only.name
  }
  const counts = new Map<string, number>()
  for (const camera of cameras) {
    const town = townOf(camera)
    counts.set(town, (counts.get(town) ?? 0) + 1)
  }
  const [top] = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
  return top?.[0] ?? townOf(only)
}

/**
 * The one fact a marker shows about state.
 *
 * Grey when normal: a place reads as anything other than plain only when a
 * camera there needs someone (offline, degraded), or when nothing there can
 * be told at all (every camera's state unknown, drawn dim).
 */
export function clusterTone(cameras: Pick<Camera, 'status'>[]): ClusterTone {
  if (cameras.some((c) => c.status === 'offline')) return 'offline'
  if (cameras.some((c) => c.status === 'degraded')) return 'degraded'
  if (cameras.length > 0 && cameras.every((c) => c.status === 'unknown')) return 'unknown'
  return 'normal'
}

/** Dot diameter by camera count — the same steps the Command map uses. */
export function dotSize(count: number): number {
  if (count >= 8) return 14
  if (count >= 4) return 11
  if (count >= 2) return 9
  return 7
}

/** "1 online · 9 state unknown" — zero counts are left out. */
export function statusSummary(cameras: Pick<Camera, 'status'>[]): string {
  const counts = new Map<CameraStatus, number>()
  for (const camera of cameras) counts.set(camera.status, (counts.get(camera.status) ?? 0) + 1)
  return STATUS_ORDER.filter((status) => (counts.get(status) ?? 0) > 0)
    .map((status) => `${counts.get(status)} ${STATUS_LABEL[status].toLowerCase()}`)
    .join(' · ')
}
