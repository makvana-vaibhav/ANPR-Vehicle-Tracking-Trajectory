/**
 * Cameras, grouped into the places an operator names.
 *
 * The organisers' grid publishes most cameras with only a town, so a dozen of
 * them share one coordinate — the town's centre. Drawn one marker per camera,
 * they stack into a single dot that hides how many are there; drawn as one
 * marker per town with a count, the map says what it actually knows: "eleven
 * cameras in Ahmedabad", not "one camera, somewhere in Ahmedabad".
 *
 * Five grid cameras have no position at all and sit at a placeholder in the
 * middle of the state. Those are never drawn: a dot at the centroid of
 * Gujarat would be a claim that a camera stands in a field near Botad.
 */

import type { Camera } from '@/lib/types'

/** Tag the registry carries on a camera whose position is not known. */
export const UNPLACED_TAG = 'placement:unknown'

/** Where the registry parks a camera with no position (the state centroid). */
export const PLACEHOLDER = { lat: 22.2587, lon: 71.1924 } as const

type Positioned = Pick<Camera, 'lat' | 'lon' | 'tags'>

export function isUnplaced(camera: Positioned): boolean {
  if (camera.tags?.includes(UNPLACED_TAG)) return true
  return (
    Math.abs(camera.lat - PLACEHOLDER.lat) < 1e-4 &&
    Math.abs(camera.lon - PLACEHOLDER.lon) < 1e-4
  )
}

export interface Place {
  /** Stable across refreshes, so a selection survives a reload of the list. */
  key: string
  name: string
  lat: number
  lon: number
  cameras: Camera[]
}

/**
 * One place per town where the town is known, otherwise one per ~100 m.
 *
 * By town rather than by coordinate because the grid's town-level cameras and
 * a precisely placed camera in the same town are a kilometre or two apart —
 * two dots that overlap at any zoom that shows the state, labelled with the
 * same name.
 */
export function groupPlaces(cameras: Camera[]): { places: Place[]; unplaced: Camera[] } {
  const groups = new Map<string, Camera[]>()
  const unplaced: Camera[] = []

  for (const camera of cameras) {
    if (isUnplaced(camera)) {
      unplaced.push(camera)
      continue
    }
    const town = camera.city?.trim().toLowerCase()
    const key = town
      ? `town:${town}`
      : `at:${camera.lat.toFixed(3)},${camera.lon.toFixed(3)}`
    const members = groups.get(key)
    if (members) members.push(camera)
    else groups.set(key, [camera])
  }

  const places: Place[] = []
  for (const [key, members] of groups) {
    const first = members[0]
    if (!first) continue
    places.push({
      key,
      name: first.city?.trim() || first.junction || first.name,
      lat: members.reduce((sum, c) => sum + c.lat, 0) / members.length,
      lon: members.reduce((sum, c) => sum + c.lon, 0) / members.length,
      cameras: [...members].sort((a, b) => a.camera_code.localeCompare(b.camera_code)),
    })
  }
  // Biggest first: labels are placed in this order, so when two collide the
  // smaller town is the one that moves.
  places.sort((a, b) => b.cameras.length - a.cameras.length || a.name.localeCompare(b.name))
  unplaced.sort((a, b) => a.camera_code.localeCompare(b.camera_code))
  return { places, unplaced }
}

/** `SBX-cam10` → `cam10`, `CAM-DEMO-01` → `DEMO-01`: enough to tell them apart
 *  in a list of four where every one shares the prefix. */
export function shortCode(code: string): string {
  return code.replace(/^SBX-/i, '').replace(/^CAM-/i, '')
}
