/**
 * What the Network screens say about a camera, decided once.
 *
 * The registry records a camera's source, position and state as a mix of
 * columns and tags. The map, the registry table and the detail panel all need
 * the same reading of them, and three screens each deriving "is this a grid
 * camera?" from a different field is how one camera ends up described three
 * ways. Everything here is a pure function of a `Camera`, except the paged
 * fetch at the bottom.
 */

import * as api from '@/lib/api'
import { isUnplaced, UNPLACED_TAG } from '@/lib/places'
import type { Camera, CameraStatus } from '@/lib/types'

// ── Source ───────────────────────────────────────────────────────────

/** Tag on a grid camera the organisers publish with a town but no junction. */
export const TOWN_LEVEL_TAG = 'placement:city'

/** Tag on a camera placed by geocoding its name (data/seed/camera_positions.csv):
 *  approximate, from the name, never surveyed. */
export const GEOCODED_TAG = 'placement:geocoded'

/** Credit for positions geocoded with OpenStreetMap (ODbL 1.0). */
export const OSM_ATTRIBUTION = '© OpenStreetMap contributors'

export type SourceKind = 'grid' | 'recorded' | 'stream' | 'none'

/**
 * Where a camera's pictures come from.
 *
 * `source_file` is the direct answer for a camera replaying a clip, but the
 * demonstration camera replays one the simulator is configured with, so its
 * column is empty and its tags are what say it is recorded footage. Checked
 * before the grid, because a recorded clip must never read as a live camera.
 */
export function sourceKind(
  camera: Pick<Camera, 'source_file' | 'tags' | 'vms_vendor' | 'has_stream'>,
): SourceKind {
  if (camera.source_file) return 'recorded'
  const tags = camera.tags ?? []
  if (tags.includes('recorded-footage') || tags.includes('demo')) return 'recorded'
  if (camera.vms_vendor === 'hosted_grid' || tags.includes('sandbox')) return 'grid'
  if (camera.has_stream) return 'stream'
  return 'none'
}

export const SOURCE_LABEL: Record<SourceKind, string> = {
  grid: 'Grid',
  recorded: 'Recorded clip',
  stream: 'Live stream',
  none: 'No source',
}

export const SOURCE_DETAIL: Record<SourceKind, string> = {
  grid: "The organisers' hosted grid. Video is pulled only when someone opens it.",
  recorded: 'A recorded clip replayed on a loop. Not a live camera.',
  stream: 'A live RTSP or ONVIF stream, pulled through the gateway on demand.',
  none: 'No video source. This camera can never be watched or analysed until one is added.',
}

// ── Position ─────────────────────────────────────────────────────────

/**
 * How much the registry knows about where a camera stands.
 *
 *   exact    placed at its junction.
 *   approx   geocoded from the camera's name with OpenStreetMap: near the
 *            junction or locality the name matched, never surveyed.
 *   town     the grid gave a town only; drawn at the town's centre, with every
 *            other camera the grid placed there.
 *   unknown  no town either. Never drawn on a map — see lib/places.
 */
export type PositionKind = 'exact' | 'approx' | 'town' | 'unknown'

export function positionKind(camera: Pick<Camera, 'lat' | 'lon' | 'tags'>): PositionKind {
  if (isUnplaced(camera)) return 'unknown'
  if (camera.tags?.includes(TOWN_LEVEL_TAG)) return 'town'
  if (camera.tags?.includes(GEOCODED_TAG)) return 'approx'
  return 'exact'
}

/** One line on how a camera's position was arrived at. */
export const POSITION_WORDS: Record<PositionKind, string> = {
  exact: 'Placed at its junction.',
  approx: `Approximate — geocoded from the name with OpenStreetMap, not surveyed. ${OSM_ATTRIBUTION}.`,
  town: 'Town centre only: the grid gives the town, not the junction.',
  unknown: 'Not known.',
}

/** The town a camera belongs to, for grouping and labels. */
export function townOf(camera: Pick<Camera, 'city' | 'district' | 'junction' | 'name'>): string {
  return camera.city?.trim() || camera.district?.trim() || camera.junction?.trim() || camera.name
}

/** Junction, town and district, without repeating whichever equals the name. */
export function placeLine(
  camera: Pick<Camera, 'name' | 'junction' | 'city' | 'district'>,
): string {
  const parts: string[] = []
  const name = camera.name.trim().toLowerCase()
  const junction = camera.junction?.trim()
  if (junction && junction.toLowerCase() !== name) parts.push(junction)
  const city = camera.city?.trim()
  if (city) parts.push(city)
  const district = camera.district?.trim()
  if (district && district.toLowerCase() !== city?.toLowerCase()) parts.push(district)
  return parts.join(' · ')
}

// ── State ────────────────────────────────────────────────────────────

export const STATUS_ORDER: CameraStatus[] = ['online', 'offline', 'degraded', 'unknown']

export const STATUS_LABEL: Record<CameraStatus, string> = {
  online: 'Online',
  offline: 'Offline',
  degraded: 'Degraded',
  unknown: 'State unknown',
}

export const STATUS_EXPLANATION: Record<CameraStatus, string> = {
  online: 'Answering, and delivering video.',
  offline: 'Its integration answers, but this camera is sending no video.',
  degraded: 'Video is arriving, but late or with dropped frames.',
  unknown:
    'Its state cannot be told: the integration it sits behind is not answering, or it has not been probed yet. Unknown is not the same as offline.',
}

const IST_CLOCK = new Intl.DateTimeFormat('en-IN', {
  timeZone: 'Asia/Kolkata',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
})

/**
 * Why a camera's status is its last known one, or null when it is fresh.
 *
 * When an integration refuses our session or does not answer, the health
 * monitor cannot ask about its cameras, so it leaves each status as it was
 * rather than flipping it — and the screen has to say so, or a stale "online"
 * reads as a fresh one.
 */
export function staleWords(
  camera: Pick<Camera, 'status_stale_reason' | 'status_confirmed_at'>,
): string | null {
  const reason = camera.status_stale_reason
  if (!reason) return null
  const cause =
    reason === 'grid_refused'
      ? "the organisers' grid is refusing our session (its cooldown)"
      : probeErrorWords(reason).toLowerCase()
  const when = camera.status_confirmed_at
    ? `last confirmed ${IST_CLOCK.format(new Date(camera.status_confirmed_at))} IST`
    : 'not confirmed in the last 24 h'
  return `Last known — ${when}; ${cause}.`
}

export function countByStatus(cameras: Pick<Camera, 'status'>[]): Record<CameraStatus, number> {
  const counts: Record<CameraStatus, number> = { online: 0, offline: 0, degraded: 0, unknown: 0 }
  for (const camera of cameras) counts[camera.status] += 1
  return counts
}

// ── Probe failures, in words ─────────────────────────────────────────

/**
 * Every error code the adapters write to a probe (services/api/app/adapters),
 * as a sentence. "sandbox_unreachable × 3,690" tells an operator nothing; "the
 * organisers' grid did not answer" tells them where to look.
 */
const PROBE_ERRORS: Record<string, string> = {
  sandbox_unreachable: "The organisers' grid did not answer",
  grid_refused: "The organisers' grid refused our session (cooldown) — camera state kept as last known",
  reported_offline: 'The grid reports this camera as not live',
  unknown_to_vms: 'The camera is no longer in its recorder’s list',
  vms_unreachable: 'The recorder (VMS) did not answer',
  unauthorized: 'The recorder refused our credentials',
  vms_error: 'The recorder returned an error',
  bad_vms_response: 'The recorder’s reply could not be read',
  onvif_unreachable: 'The camera did not answer over ONVIF',
  no_stream_configured: 'The camera answers, but no stream address is registered',
  gateway_unreachable: 'The stream gateway did not answer',
  not_publishing: 'Nothing is publishing this camera to the gateway',
  stream_not_ready: 'The gateway has the camera, but no video is arriving',
  no_stream_url: 'No stream address is registered',
  ffprobe_missing: 'The probe tool is missing from the server',
  timeout: 'No reply in time',
  spawn_failed: 'The probe could not be started',
  bad_probe_output: 'The probe’s output could not be read',
  no_video_stream: 'The stream answers, but carries no video',
  adapter_exception: 'The integration failed unexpectedly',
}

/**
 * Probe failures that mean the camera could not be asked at all — its
 * integration refused our session or did not answer. They say nothing about
 * the camera: its status stays as last known and they are left out of uptime.
 * Mirrors `STATUS_HOLD_ERRORS` in services/api/app/adapters/base.py.
 */
export const NOT_ASKED_ERRORS: ReadonlySet<string> = new Set([
  'vms_unreachable',
  'onvif_unreachable',
  'sandbox_unreachable',
  'grid_refused',
  'gateway_unreachable',
  'unauthorized',
  'adapter_exception',
])

export function probeErrorWords(code: string): string {
  const known = PROBE_ERRORS[code]
  if (known) return known
  const words = code.replace(/_/g, ' ').trim()
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : 'Unknown failure'
}

const VENDOR_WORDS: Record<string, string> = {
  hosted_grid: "Organisers' grid",
  simulated: 'Recorded demo feed',
  rtsp: 'Direct RTSP',
  onvif: 'ONVIF',
  vendor_api: 'Vendor VMS',
  unassigned: 'No integration',
}

export function vendorWords(vendor: string | null | undefined): string {
  if (!vendor) return VENDOR_WORDS.unassigned ?? 'No integration'
  return VENDOR_WORDS[vendor] ?? vendor
}

// ── Filtering ────────────────────────────────────────────────────────

/** Department filter value for cameras that belong to no department. */
export const UNASSIGNED = '__unassigned'

export type PositionFilter = '' | 'placed' | 'unplaced'

export interface CameraFilter {
  search: string
  status: CameraStatus | ''
  /** A department code, `UNASSIGNED`, or '' for all. */
  department: string
  vendor: string
  anprOnly: boolean
  source: SourceKind | ''
  position: PositionFilter
}

export const NO_FILTER: CameraFilter = {
  search: '',
  status: '',
  department: '',
  vendor: '',
  anprOnly: false,
  source: '',
  position: '',
}

export function isFiltered(filter: CameraFilter): boolean {
  return (
    filter.search.trim() !== '' ||
    filter.status !== '' ||
    filter.department !== '' ||
    filter.vendor !== '' ||
    filter.anprOnly ||
    filter.source !== '' ||
    filter.position !== ''
  )
}

export function matchesFilter(camera: Camera, filter: CameraFilter): boolean {
  if (filter.status && camera.status !== filter.status) return false
  if (filter.department === UNASSIGNED) {
    if (camera.department_code) return false
  } else if (filter.department && camera.department_code !== filter.department) {
    return false
  }
  if (filter.vendor && (camera.vms_vendor ?? '') !== filter.vendor) return false
  if (filter.anprOnly && !camera.anpr_enabled) return false
  if (filter.source && sourceKind(camera) !== filter.source) return false
  if (filter.position === 'unplaced' && !isUnplaced(camera)) return false
  if (filter.position === 'placed' && isUnplaced(camera)) return false

  const needle = filter.search.trim().toLowerCase()
  if (needle) {
    const haystack = [camera.camera_code, camera.name, camera.junction, camera.city, camera.district]
      .filter(Boolean)
      .join(' ')
      .toLowerCase()
    if (!haystack.includes(needle)) return false
  }
  return true
}

export function filterCameras(cameras: Camera[], filter: CameraFilter): Camera[] {
  return isFiltered(filter) ? cameras.filter((c) => matchesFilter(c, filter)) : cameras
}

export interface DepartmentOption {
  code: string
  name: string
  count: number
}

/** The departments that actually own a camera, with how many — plus the unowned. */
export function departmentOptions(cameras: Camera[]): {
  departments: DepartmentOption[]
  unassigned: number
} {
  const byCode = new Map<string, DepartmentOption>()
  let unassigned = 0
  for (const camera of cameras) {
    const code = camera.department_code
    if (!code) {
      unassigned += 1
      continue
    }
    const option = byCode.get(code) ?? { code, name: camera.department_name ?? code, count: 0 }
    option.count += 1
    byCode.set(code, option)
  }
  return {
    departments: [...byCode.values()].sort((a, b) => a.code.localeCompare(b.code)),
    unassigned,
  }
}

/** The integrations the registry's cameras arrive through. */
export function vendorOptions(cameras: Camera[]): string[] {
  return [...new Set(cameras.map((c) => c.vms_vendor).filter((v): v is string => Boolean(v)))].sort()
}

// ── Amending ─────────────────────────────────────────────────────────

function sameValue(a: unknown, b: unknown): boolean {
  if (Array.isArray(a) || Array.isArray(b)) {
    const left = Array.isArray(a) ? a : []
    const right = Array.isArray(b) ? b : []
    return left.length === right.length && left.every((v, i) => v === right[i])
  }
  // The registry stores an absent value as null; a form, as ''.
  const norm = (v: unknown) => (v === undefined || v === '' ? null : v)
  return norm(a) === norm(b)
}

/**
 * The part of an edit that actually changes the camera.
 *
 * A PATCH is applied field by field and audited by field name, so sending
 * the whole form would rewrite every column with whatever the form held — the
 * edit form used to reset the department to blank, which unassigned the
 * department of every camera anyone saved. Only differences are sent.
 * Coordinates move together or not at all, as the API requires.
 */
export function amendment(
  camera: Camera,
  body: Partial<api.CameraInput>,
): Partial<api.CameraInput> {
  const current = camera as unknown as Record<string, unknown>
  const changed: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(body)) {
    if (key === 'lat' || key === 'lon' || key === 'camera_code') continue
    if (!sameValue(current[key], value)) changed[key] = value
  }
  if (body.lat !== undefined && body.lon !== undefined) {
    if (!sameValue(camera.lat, body.lat) || !sameValue(camera.lon, body.lon)) {
      changed.lat = body.lat
      changed.lon = body.lon
    }
  }
  return changed as Partial<api.CameraInput>
}

/**
 * The tags a camera should carry once an operator has given it a position.
 *
 * `placement:unknown` and `placement:city` record what the grid did not
 * know; a person who types in coordinates has answered that, and a tag left
 * behind would keep the camera off the map (or drawn at its town's centre)
 * after it was placed.
 */
export function tagsAfterPlacing(tags: string[] | null): string[] | null {
  if (!tags) return tags
  return tags.filter(
    (tag) => tag !== UNPLACED_TAG && tag !== TOWN_LEVEL_TAG && tag !== GEOCODED_TAG,
  )
}

// ── URL ──────────────────────────────────────────────────────────────
//
// `?camera=<CODE>` names the camera whose detail is open, on every Network
// screen; `?filter=unplaced` (or `placed`) is the registry's position filter.
// Both are read here so a link built anywhere — the search palette, the map,
// a colleague's message — lands on the same thing.

export function readCameraParam(params: URLSearchParams): string | null {
  const value = params.get('camera')?.trim()
  return value ? value : null
}

export function readPositionFilter(params: URLSearchParams): PositionFilter {
  const value = params.get('filter')
  return value === 'unplaced' || value === 'placed' ? value : ''
}

/** A copy of `params` with each key set, or removed when its value is empty. */
export function withParams(
  params: URLSearchParams,
  changes: Record<string, string | null | undefined>,
): URLSearchParams {
  const next = new URLSearchParams(params)
  for (const [key, value] of Object.entries(changes)) {
    if (value) next.set(key, value)
    else next.delete(key)
  }
  return next
}

/** Camera codes are compared case-blind: `sbx-cam05` in a pasted link is SBX-cam05. */
export function findCamera(cameras: Camera[], code: string | null): Camera | null {
  if (!code) return null
  const needle = code.toLowerCase()
  return cameras.find((c) => c.camera_code.toLowerCase() === needle) ?? null
}

// ── Fetching ─────────────────────────────────────────────────────────

const PAGE_SIZE = 500
/** A ceiling on pages, so a server that misreports `total` cannot loop us forever. */
const MAX_PAGES = 40

/**
 * Every camera in the registry, a page at a time.
 *
 * The list endpoint caps a page at 500. The deployment is far below that, but
 * a screen that silently showed the first 500 of a larger estate would be
 * wrong in exactly the way nobody notices.
 */
export async function fetchAllCameras(params: Record<string, string> = {}): Promise<Camera[]> {
  const cameras: Camera[] = []
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const body = await api.getCameras({
      ...params,
      limit: String(PAGE_SIZE),
      offset: String(page * PAGE_SIZE),
    })
    cameras.push(...body.items)
    if (body.items.length < PAGE_SIZE || cameras.length >= body.total) break
  }
  return cameras
}
