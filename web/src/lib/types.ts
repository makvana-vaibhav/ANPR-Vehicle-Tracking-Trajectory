/** Shared API types for the command centre. */

export type CameraStatus = 'online' | 'offline' | 'degraded' | 'unknown'

export interface Camera {
  id: string
  camera_code: string
  name: string
  department_code: string | null
  department_name: string | null
  vms_name: string | null
  vms_vendor: string | null
  /** The road this camera sits on, for corridor-level analytics — see
   *  migration 0004. Null for a camera on no corridor the platform models. */
  corridor: string | null
  district: string | null
  city: string | null
  junction: string | null
  address: string | null
  lat: number
  lon: number
  heading_deg: number | null
  camera_type: string | null
  protocol: string | null
  resolution: string | null
  fps: number | null
  anpr_enabled: boolean
  status: CameraStatus
  installed_on: string | null
  tags: string[] | null
  /** Whether a video source is configured. The URL itself is never sent to the
   *  browser — a federated camera's carries the grid credentials. */
  has_stream: boolean
  /** Recorded clip this camera replays, or null when it pulls a live stream.
   *  Unlike `stream_url` this is safe to send: a filename in our own video
   *  directory, carrying no credentials. */
  source_file: string | null
  created_at: string
  updated_at: string
  distance_km?: number | null
}

export interface CameraPage {
  items: Camera[]
  total: number
  limit: number
  offset: number
}

export interface CameraFeatureProperties {
  id: string
  camera_code: string
  name: string
  corridor: string | null
  district: string | null
  city: string | null
  junction: string | null
  status: CameraStatus
  camera_type: string | null
  anpr_enabled: boolean
  heading_deg: number | null
  department_code: string | null
  department_name: string | null
  vendor: string | null
}

export interface CameraGeoJSON {
  type: 'FeatureCollection'
  features: Array<{
    type: 'Feature'
    id?: string
    geometry: { type: 'Point'; coordinates: [number, number] }
    properties: CameraFeatureProperties
  }>
  properties: { count: number; by_status: Record<string, number> }
}

export interface FleetHealth {
  total: number
  online: number
  offline: number
  degraded: number
  unknown: number
  integrated: number
  awaiting_integration: number
  availability_pct: number
  integrated_availability_pct: number | null
  by_department: Array<{
    department: string
    total: number
    online: number
    offline: number
    degraded: number
    availability_pct: number
  }>
  by_vendor: Array<{
    vendor: string
    total: number
    online: number
    availability_pct: number
  }>
  top_errors: Array<{ error_code: string; count: number }>
  generated_at: string
}

export interface FleetSummary {
  total: number
  by_status: Record<string, number>
  by_department: Record<string, number>
  by_district: Record<string, number>
  anpr_enabled: number
}

export interface StreamGrant {
  camera_id: string
  camera_code: string
  name: string
  status: string
  token: string
  expires_in: number
  whep_url: string | null
  hls_url: string | null
  rtsp_url: string | null
  protocol_preference: string[]
}

export interface CameraHealthHistory {
  camera_id: string
  camera_code: string
  status: CameraStatus
  uptime: {
    window_hours: number
    probes: number
    uptime_pct: number | null
    avg_latency_ms: number | null
    avg_fps: number | null
  }
  history: Array<{
    ts: string
    reachable: boolean | null
    fps_actual: number | null
    latency_ms: number | null
    bitrate_kbps: number | null
    error_code: string | null
  }>
}

export interface GapReport {
  window_hours: number
  generated_at: string
  summary: {
    unavailable_cameras: number
    districts_below_anpr_target: number
    districts_with_no_cameras: number
    unreliable_cameras: number
  }
  availability_gaps: Array<{
    camera_code: string
    name: string
    district: string | null
    status: string
    department: string
  }>
  capability_gaps: Array<{
    district: string
    cameras: number
    anpr_cameras: number
    anpr_share: number
    reason: string
  }>
  coverage_gaps: Array<{ district: string; reason: string }>
  reliability_gaps: Array<{
    camera_code: string
    name: string
    district: string | null
    uptime_pct: number
    reason: string
    /** Probes the uptime figure is computed from. */
    probes: number
  }>
  district_coverage: Array<{
    district: string
    cameras: number
    anpr_cameras: number
    online: number
    anpr_share: number
    availability_pct: number
  }>
}

export interface UserProfile {
  id: string
  username: string
  full_name: string | null
  role: string
  department_id: string | null
  is_active: boolean
  last_login_at: string | null
  permissions: string[]
  /** An administrator chose this password; it is a shared secret until changed. */
  must_change_password?: boolean
}

export interface Department {
  id: string
  code: string
  name: string
  contact_email: string | null
  camera_count: number
}

export interface VmsInstance {
  id: string
  name: string
  vendor: string
  adapter_type: string
  base_url: string | null
  status: string
  last_sync_at: string | null
  camera_count: number
}

// ── Intelligence: detections, watchlist, alerts ───────────────────────

export interface BBox {
  x1: number
  y1: number
  x2: number
  y2: number
  w: number
  h: number
}

export interface Detection {
  id: string
  ts: string
  camera_id: string | null
  camera_code: string
  camera_name: string
  track_id: string
  vehicle_type: string | null
  plate: string | null
  plate_confidence: number | null
  detection_confidence: number | null
  grammar_valid: boolean | null
  bbox: BBox | null
  plate_bbox: BBox | null
  crop_key: string | null
  /** Short-lived signed URL for the plate crop. See Alert.crop_url. */
  crop_url: string | null
  reads_total: number | null
  agreement: number | null
  corrected_from: string | null
  ambiguous: boolean
  candidates: { text: string; score: number; grammar_valid: boolean }[]
}

export interface DetectionPage {
  items: Detection[]
  total: number
  limit: number
  offset: number
}

export type Priority = 'low' | 'medium' | 'high' | 'critical'

export type AlertStatus =
  | 'new'
  | 'acknowledged'
  | 'dispatched'
  | 'closed'
  | 'false_positive'

export interface WatchlistEntry {
  id: string
  plate_normalised: string
  category: string
  priority: Priority
  case_ref: string | null
  remarks: string | null
  valid_from: string | null
  valid_to: string | null
  active: boolean
  added_by: string | null
  created_at: string
}

/** One factor behind an alert. `factor` is a machine-stable slug the UI can
 *  branch or group on; `detail` is the sentence an operator reads. */
export interface AlertReason {
  factor: string
  detail: string
}

export interface Alert {
  id: string
  created_at: string
  alert_type: string
  priority: Priority
  plate_normalised: string | null
  confidence: number | null
  status: AlertStatus
  camera_id: string | null
  detection_id: string | null
  watchlist_id: string | null
  acknowledged_by: string | null
  acknowledged_at: string | null
  notes: string | null
  /**
   * Short-lived signed URL for the plate crop of the detection that raised
   * this alert. Null when there is no crop. May 404 briefly after a detection
   * while the upload is still in flight, so render it with an onError that
   * hides the image rather than showing a broken one.
   */
  crop_url: string | null
  /** Why this fired — the explainability rule in CLAUDE.md §5. Null for a
   *  watchlist hit or camera-down alert (the match/notes already say why);
   *  populated for `anomaly`. */
  reasons: AlertReason[] | null
  /** A `person_match`'s cosine similarity: a score against a threshold, never
   *  a percentage. Absent from APIs that predate it. */
  similarity?: number | null
}

export interface AlertPage {
  items: Alert[]
  total: number
  limit: number
  offset: number
}

/**
 * What arrives on `/ws/events`.
 *
 * Three shapes share the socket. `vehicle.observed` is a vehicle still in
 * view — the one to draw on live video. `vehicle.completed` is the settled
 * consensus, and the one that was written to the database. `alert.raised` is
 * a watchlist hit.
 */
export interface LiveVehicleEvent {
  event: 'vehicle.observed' | 'vehicle.completed'
  /**
   * Which run of the worker's tracker issued this event. Track ids restart at
   * 1 whenever the tracker is rebuilt, so a track id only identifies a vehicle
   * together with this. Absent from events of a worker that predates it.
   */
  run_id?: string
  /** When the worker emitted this. Later than `captured_at` by the pipeline. */
  event_time: string
  /**
   * When the frame these boxes were measured in was captured.
   *
   * This, not `event_time`, is the timestamp an overlay has to draw against:
   * the difference between the two is `latency_ms`, and a box placed at the
   * emit time lands wherever the vehicle has got to since. Null on events from
   * a worker that predates the field.
   */
  captured_at?: string | null
  /** Capture-to-event, in milliseconds. */
  latency_ms?: number
  /**
   * True when this repeats a reading already reported, to update only where
   * the vehicle now is. For drawing, never for counting — see
   * `lib/events.ts`.
   *
   * A refresh also arrives **trimmed**: the boxes, the frame, the clock and
   * enough of the plate to label and colour a rectangle, and none of the
   * evidence. It is emitted several times a second per vehicle purely so an
   * overlay has somewhere current to draw, and carrying every read and every
   * candidate with it made the message whose only job was to be prompt into
   * the largest on the bus. The fields it omits are marked optional below; do
   * not read them without checking, and do not list a refresh anywhere a
   * sighting belongs.
   */
  position_refresh?: boolean
  source: { camera_id: string; name?: string }
  vehicle: {
    vehicle_id: number
    track_ids: number[]
    type: string
    confidence: number
    /** The best sighting — largest and most confident. What the crop came from. */
    bbox: BBox | null
    /**
     * Where the vehicle was in the `captured_at` frame. The only box with a
     * timestamp, and so the only one worth drawing over live video.
     */
    live_bbox?: BBox | null
    /** Absent on a position refresh. */
    first_seen_s?: number
    /** Absent on a position refresh. */
    last_seen_s?: number
  }
  plate: {
    text: string
    confidence: number
    readable: boolean
    grammar_valid: boolean
    ambiguous: boolean
    corrected_from: string | null
    /** Absent on a position refresh. */
    format?: string
    bbox?: BBox | null
    /** Absent on a position refresh — a refresh carries no evidence at all. */
    evidence?: { reads_total?: number; agreement?: number; method?: string }
  }
  /**
   * Crop evidence for this sighting. The worker publishes only the object
   * `plate_crop` key — putting the JPEG on the bus would multiply event
   * traffic tenfold — and the API signs `plate_crop_url` on the way out,
   * because a browser can use neither a key nor an Authorization header on an
   * `<img>`. Absent until the upload lands, and possibly never.
   */
  evidence?: {
    plate_crop?: string | null
    vehicle_crop?: string | null
    plate_crop_url?: string | null
  }
  frame?: { width: number; height: number } | null
}

export interface LiveAlertEvent {
  event: 'alert.raised'
  alert_id: string
  alert_type: string
  priority: Priority
  plate: string | null
  confidence: number | null
  status: AlertStatus
  camera_id: string | null
  detection_id: string | null
  created_at: string
  notes: string | null
  reasons: AlertReason[] | null
  watchlist?: {
    id: string
    plate: string
    category: string
    case_ref: string | null
    exact: boolean
  }
  /** A `person_match`: the entry matched and the face's similarity. Never a
   *  name or a photograph — those come from the audited evidence endpoint. */
  person?: {
    id: string
    category: string
    case_ref: string
  }
  similarity?: number | null
}

/**
 * One vehicle's current boxes inside a `camera.tracks` batch.
 *
 * Compact on purpose: boxes are `[x1, y1, x2, y2]` in source-frame pixels
 * rather than the `{x1, y1, x2, y2, w, h}` objects every other event uses, and
 * fields that carry nothing are **omitted** rather than sent as null. This
 * message goes out several times a second per camera with one entry per
 * vehicle in view, so it is the one place in the schema where byte count is a
 * design constraint. See `ailab.stream.events.LiveTrackBox`.
 *
 * The states an entry can be in, and how to tell them apart:
 *
 *   `plate_bbox`, no `plate`   the detector has **located** a plate and can say
 *                              where it is. Nothing has read it, and nothing
 *                              may ever read it. Draw the box; claim nothing.
 *   `plate` present            there is a reading. Whether it is good enough to
 *                              print is the overlay's policy, which is why
 *                              `grammar_valid` and `ambiguous` travel with it
 *                              instead of a verdict.
 */
export interface LiveTrackBox {
  /** The tracker's identity for this vehicle, stable while it holds it. */
  track_id: number
  type: string
  /** `[x1, y1, x2, y2]` in source-frame pixels. */
  bbox: [number, number, number, number]
  /** Where its plate is. Absent until the detector has localised one. */
  plate_bbox?: [number, number, number, number]
  /** The plate detector's confidence in that localisation, not in any reading. */
  plate_detection_confidence?: number
  /** Absent while there is no reading at all. Never a placeholder. */
  plate?: string
  confidence?: number
  grammar_valid?: boolean
  ambiguous?: boolean
  corrected_from?: string
  /**
   * Seconds since the detector last found this vehicle. Absent when it was
   * found in this batch's own frame; present while its box is only being held
   * at its last position, over an occlusion or after it has left.
   */
  seen_ago_s?: number
}

/**
 * Every drawable vehicle on one camera, as of one frame.
 *
 * **This is the picture, not the intelligence.** It is never persisted, must
 * never be counted as a detection and must never be listed in a plate feed: a
 * vehicle appears in dozens of consecutive batches and each one is the same
 * car. The record of what was seen is `vehicle.completed`.
 *
 * Because it describes the whole camera, it is **authoritative**: a vehicle
 * absent from the newest batch is no longer drawable on that camera. That is
 * how a box learns to disappear promptly rather than waiting out a timeout —
 * and it is why an empty `tracks` array is a meaningful message rather than a
 * pointless one.
 */
export interface LiveTrackBatchEvent {
  event: 'camera.tracks'
  /** When this message was built. */
  event_time: string
  /**
   * When the frame every box in it was measured on was captured. An overlay
   * places boxes against this, not against the moment the message arrived.
   */
  captured_at?: string | null
  /** Capture-to-publish for this batch, in milliseconds. */
  latency_ms?: number
  source: { camera_id: string; name?: string }
  /** The tracker run its track ids belong to. See `LiveVehicleEvent.run_id`. */
  run_id?: string
  /** The space the coordinates are in. Without it they cannot be scaled. */
  frame?: { width: number; height: number } | null
  tracks: LiveTrackBox[]
}

export type LiveEvent =
  | LiveVehicleEvent
  | LiveAlertEvent
  | LiveTrackBatchEvent
  | { event: 'connected'; subscribers: number }
  | { event: 'keepalive' }

// ── Vehicle intelligence: routes and convoys ──────────────────────────

/**
 * One camera in a reconstructed journey, and the leg that led to it.
 *
 * `flags` is why the correlator does not believe part of this leg. An empty
 * list means nothing was found wrong, which is weaker than "this leg is
 * correct" — distances are straight lines between cameras, so a plausible-
 * looking leg has only passed a weak test.
 */
export interface RouteHop {
  camera_id: string
  camera_code: string
  camera_name: string
  city: string | null
  district: string | null
  lat: number
  lon: number
  arrived_at: string
  departed_at: string
  dwell_s: number
  sightings: number
  plate_confidence: number
  distance_m: number | null
  distance_km: number | null
  elapsed_s: number | null
  implied_kmph: number | null
  bearing_deg: number | null
  flags: string[]
  plausible: boolean
  /** The visit's clearest read: the evidence a report shows for it. */
  best_detection_id: string | null
  /**
   * A visit an analyst included although the camera read a different plate
   * (`read_as`): never a confirmed sighting, and drawn and listed as one
   * everywhere. Absent on a route from before candidates existed.
   */
  candidate?: boolean
  read_as?: string | null
  /** How `read_as` differs from the plate, in words. */
  candidate_note?: string | null
}

/**
 * A sighting at a camera whose position is not known. A real sighting, so it
 * is reported, but never placed on the route or used for a distance or speed.
 */
export interface UnplacedSighting {
  detection_id: string
  camera_id: string
  camera_code: string
  camera_name: string
  city: string | null
  district: string | null
  seen_at: string
  plate_confidence: number
  /** An included candidate read at a camera with no position. */
  candidate?: boolean
  read_as?: string | null
}

export interface VehicleRoute {
  plate: string
  window: { from: string | null; to: string | null }
  first_seen: string | null
  last_seen: string | null
  hop_count: number
  camera_count: number
  distance_km: number
  duration_s: number
  /** Time between cameras, excluding dwell at each one. */
  moving_s: number
  /**
   * Journey average, first sighting to last — so it includes time spent
   * stationary. A lower bound twice over: distances are great-circle rather
   * than road, and dwell inflates the denominator. Null when there is no
   * elapsed time to divide by; a single sighting has no speed.
   */
  average_kmph: number | null
  /** Average while moving, ignoring dwell. Null on the same terms. */
  moving_kmph: number | null
  is_plausible: boolean
  confidence: number
  flagged_hop_count: number
  hops: RouteHop[]
  unplaced_sightings: UnplacedSighting[]
  geometry_note: string
  unplaced_note: string
  /** Included candidate visits on this route, placed or not. */
  candidate_hop_count?: number
  /** Included candidates that are not in this window — reported, never dropped. */
  candidates_missing?: string[]
  candidate_note?: string | null
}

export type RouteGeoJSON = GeoJSON.FeatureCollection

export interface Convoy {
  plate: string
  with_plate: string
  shared_cameras: number
  first_together: string
  last_together: string
  median_gap_s: number
  /**
   * The partner plate is within one character of the subject — almost always
   * one vehicle read two ways rather than two vehicles travelling together.
   */
  likely_same_vehicle: boolean
}

export interface ConvoyReport {
  plate: string
  window: { from: string | null; to: string | null }
  criteria: { seconds_apart: number; min_shared_cameras: number }
  convoys: Convoy[]
  note: string
}

export interface RoutablePlates {
  since: string
  min_cameras: number
  plates: { plate: string; cameras: number }[]
}

// ── Fuzzy plate search (P8) ─────────────────────────────────────────────

export interface WatchlistHit {
  category: string
  priority: Priority
  case_ref: string | null
}

export interface PlateSearchResult {
  plate_normalised: string
  /** pg_trgm trigram similarity to the query, 0-1. 1.0 means an exact match. */
  similarity: number
  sightings: number
  cameras: number
  first_seen: string
  last_seen: string
  /** Present when this plate is on an active watchlist entry. */
  watchlist: WatchlistHit | null
}

export interface PlateSearchResponse {
  query: string
  /** The minimum trigram similarity a result had to clear. */
  threshold: number
  /** True when `query` itself is among the results at similarity 1.0. */
  exact_match: boolean
  results: PlateSearchResult[]
}

// ── User administration and audit ─────────────────────────────────────

export type Role =
  | 'admin'
  | 'supervisor'
  | 'operator'
  | 'analyst'
  | 'auditor'
  | 'api_client'

export interface ManagedUser {
  id: string
  username: string
  full_name: string | null
  role: Role
  department_id: string | null
  is_active: boolean
  /** An administrator chose this password; the holder must replace it. */
  must_change_password: boolean
  last_login_at: string | null
  created_at: string | null
}

export interface UserPage {
  items: ManagedUser[]
  total: number
}

export interface AuditEntry {
  id: number
  ts: string
  user_id: string | null
  username: string | null
  role: string | null
  action: string
  resource_type: string | null
  resource_id: string | null
  ip: string | null
  result: string
  params: Record<string, unknown> | null
}

export interface AuditPage {
  items: AuditEntry[]
  total: number
  limit: number
  offset: number
}

// ── City traffic analytics ─────────────────────────────────────────────
// Mirrors app/schemas/analytics.py exactly. Every figure that can be absent
// carries a `status` rather than a substituted number — see that module's
// docstring. `DataStatus` is a closed set so the UI can branch on it
// exhaustively instead of pattern-matching prose.

export type DataStatus = 'ok' | 'insufficient_history' | 'insufficient_data'

export interface AnalyticsWindow {
  start: string
  end: string
  /** Width of one time bucket, in seconds. 0 when the response is not bucketed. */
  bucket_seconds: number
}

export interface FlowPoint {
  ts: string
  vehicles: number
  with_plate: number
}

export interface FlowSeries {
  /** Camera code, or corridor name when grouped by corridor. */
  key: string
  label: string
  corridor: string | null
  points: FlowPoint[]
  total: number
}

export interface FlowResponse {
  window: AnalyticsWindow
  group_by: 'camera' | 'corridor'
  series: FlowSeries[]
  total_vehicles: number
}

export interface SpeedProvenance {
  source: 'observed_journeys'
  legs_considered: number
  legs_excluded_implausible: number
  note: string
}

export interface SegmentSpeed {
  from_camera: string
  to_camera: string
  corridor: string | null
  distance_km: number
  status: DataStatus
  samples: number
  median_kmph: number | null
  p85_kmph: number | null
  median_seconds: number | null
}

export interface CorridorSpeed {
  corridor: string
  status: DataStatus
  samples: number
  median_kmph: number | null
  segments: SegmentSpeed[]
}

export interface SpeedResponse {
  window: AnalyticsWindow
  provenance: SpeedProvenance
  corridors: CorridorSpeed[]
}

export interface RoutePair {
  from_camera: string
  to_camera: string
  from_corridor: string | null
  to_corridor: string | null
  journeys: number
  distance_km: number
  median_gap_seconds: number
  same_corridor: boolean
}

export interface RouteDensityResponse {
  window: AnalyticsWindow
  pairs: RoutePair[]
  total_journeys: number
}

export interface TravelTime {
  from_camera: string
  to_camera: string
  corridor: string | null
  status: DataStatus
  current_seconds: number | null
  current_samples: number
  baseline_seconds: number | null
  baseline_samples: number
  baseline_days: number
  /** Positive means slower than baseline. Null unless both figures exist. */
  delta_pct: number | null
}

export interface TravelTimeResponse {
  window: AnalyticsWindow
  segments: TravelTime[]
  baseline_window_days: number
}

export interface Hotspot {
  camera_code: string
  camera_name: string
  corridor: string | null
  lat: number
  lon: number
  vehicles: number
  /** Share of the busiest camera's count, 0-1. */
  intensity: number
}

export interface HotspotResponse {
  window: AnalyticsWindow
  by_volume: Hotspot[]
  by_slowdown: TravelTime[]
  slowdown_status: DataStatus
  note: string
}

export interface HeatmapFeatureProperties {
  camera_code: string
  camera_name: string
  corridor: string | null
  vehicles: number
  intensity: number
}

export interface HeatmapResponse {
  type: 'FeatureCollection'
  features: Array<{
    type: 'Feature'
    geometry: { type: 'Point'; coordinates: [number, number] }
    properties: HeatmapFeatureProperties
  }>
  window: AnalyticsWindow
  max_vehicles: number
}

// ── Predictive traffic (P10) ─────────────────────────────────────────────
// Mirrors app/schemas/predictions.py exactly. `current_index_pct` is a
// relative measure — this camera's current volume vs. its own typical
// volume at this hour, 100 == normal — never an absolute road-capacity
// occupancy figure. See that module's docstring for why.

export interface ForecastPoint {
  horizon_minutes: 15 | 30
  index_pct: number | null
}

export interface ContributingFactor {
  factor: string
  detail: string
}

export interface BacktestResult {
  status: DataStatus
  /** Held-out buckets the forecast was checked against. */
  samples: number
  /** Mean absolute error, in index percentage points. */
  mae_pct: number | null
}

export interface CongestionSeries {
  /** Camera code, or corridor name when grouped by corridor. */
  key: string
  label: string
  corridor: string | null
  status: DataStatus
  current_index_pct: number | null
  current_bucket_vehicles: number | null
  trend_samples: number
  baseline_days: number
  trend_per_minute_pct: number | null
  forecasts: ForecastPoint[]
  factors: ContributingFactor[]
  backtest: BacktestResult
}

export interface CongestionResponse {
  window: AnalyticsWindow
  group_by: 'camera' | 'corridor'
  baseline_window_days: number
  horizons_minutes: Array<15 | 30>
  series: CongestionSeries[]
}

// ── Traffic intelligence ─────────────────────────────────────────────────
//
// One payload behind the whole dashboard. The panels all describe the same
// window over the same rows, so they are fetched together rather than one per
// panel — eight round trips would let them disagree on screen while each was
// individually correct.

/** Ordered free → worst. Sorting "most congested first" reverses this. */
export type CongestionLevel = 'free' | 'moderate' | 'heavy' | 'severe'

/** Why a congestion level came out the way it did. Same shape as AlertReason:
 *  a level with no reasons is a bug, not a terse response. */
export interface TrafficFactor {
  factor: string
  detail: string
}

/** Unique vehicles by class. Counts of *vehicles*, not frames — the platform
 *  writes one row when a track retires. Every class is present even at zero. */
export interface VehicleTypeCounts {
  car: number
  motorcycle: number
  bus: number
  truck: number
  other: number
}

/**
 * Which way vehicles travelled through a camera's view.
 *
 * **Image space, not compass.** `approaching`/`receding` mean toward and away
 * from the camera. `unmeasured` is vehicles seen once, where movement could
 * not be judged — carried rather than hidden, because it is the difference
 * between "nothing was stationary" and "we could not tell".
 */
export interface DirectionCounts {
  approaching: number
  receding: number
  crossing_left: number
  crossing_right: number
  stationary: number
  unmeasured: number
}

export interface QueueState {
  present: boolean
  /** Vehicles, never metres — nothing here knows how long a car is. */
  length_vehicles: number
  sustained_buckets: number
  status: DataStatus
}

/** A vehicle that has not moved for a long time. "Possible obstruction" and
 *  nothing stronger: the system sees that it stopped, never why. */
export interface PossibleObstruction {
  camera_code: string
  camera_name: string
  corridor: string | null
  lat: number | null
  lon: number | null
  track_id: string
  plate: string | null
  vehicle_type: string | null
  stationary_seconds: number
  last_seen: string
}

/** One camera's view, or one corridor. "Zone" is the field of view — there are
 *  no ROI polygons, and an uncalibrated one would make density look more
 *  precise than it is. */
export interface TrafficZone {
  key: string
  label: string
  corridor: string | null
  lat: number | null
  lon: number | null

  vehicles: number
  by_type: VehicleTypeCounts
  by_direction: DirectionCounts
  vehicles_per_minute: number | null
  vehicles_per_hour: number | null

  /** Most vehicles in view at once. **Vehicles in view, not per kilometre.** */
  peak_occupancy: number
  density_status: DataStatus

  median_speed_kmph: number | null
  speed_status: DataStatus
  travel_time_delta_pct: number | null
  travel_time_status: DataStatus

  congestion: CongestionLevel | null
  congestion_score: number | null
  congestion_status: DataStatus
  factors: TrafficFactor[]

  queue: QueueState
}

export interface TrafficResponse {
  window: AnalyticsWindow
  group_by: 'camera' | 'corridor'
  zones: TrafficZone[]
  /** Vehicles every figure was computed from — the rows read. */
  total_vehicles: number
  totals_by_type: VehicleTypeCounts
  active_cameras: number
  fleet_cameras: number
  /** The read is bounded and newest first: rows read, rows in the window, and
   *  whether the window held more than was read. */
  rows_read: number
  rows_total: number
  truncated: boolean
  possible_obstructions: PossibleObstruction[]
  /** Worst-first, for the "top congested roads" panel. */
  most_congested: string[]
  note: string
}

export interface TrafficHistoryPoint {
  bucket: string
  vehicles: number
  stationary_vehicles: number
  median_dwell_s: number | null
}

export interface TrafficHistoryResponse {
  window: AnalyticsWindow
  key: string | null
  group_by: 'camera' | 'corridor'
  points: TrafficHistoryPoint[]
}

// ── Vehicle re-identification (P11) ──────────────────────────────────────
// Mirrors app/schemas/reid.py. `similarity` is null on every candidate in a
// real database today — nothing in ai-lab computes an appearance embedding
// yet. `embedding_available` says whether ranking used real appearance
// similarity at all; when it's false every candidate below was matched by
// being physically reachable in time, not by appearance — see that
// schema's docstring before rendering these as "re-identified."

export interface ReidMatchFactor {
  factor: string
  detail: string
}

export interface ReidCandidate {
  detection_id: string
  detection_ts: string
  camera_code: string
  camera_name: string
  corridor: string | null
  vehicle_type: string | null
  plate: string | null
  distance_km: number
  elapsed_s: number
  implied_kmph: number
  similarity: number | null
  plausibility_score: number
  matched_on: ReidMatchFactor[]
}

export interface ReidMatchResponse {
  found: boolean
  query_detection_id: string
  query_ts: string | null
  query_camera_code: string | null
  embedding_available: boolean
  candidates: ReidCandidate[]
  note: string
}

// ── The persons watchlist ─────────────────────────────────────────────

export type PersonCategory = 'missing' | 'wanted' | 'demo'

export type PersonStatus = 'pending_approval' | 'active' | 'rejected' | 'retired'

/** One entry, as a role with `person.read` sees it. No embedding, ever; the
 *  photograph only as a two-minute signed link, each one audited. */
export interface PersonEntry {
  id: string
  display_name: string
  category: PersonCategory | string
  case_ref: string
  purpose: string
  notes: string | null
  status: PersonStatus
  valid_until: string
  /** Would be matched right now: active, approved, unexpired. */
  matchable: boolean
  photo_url: string | null
  /** Retention has removed the photograph. */
  photo_purged: boolean
  enrol_quality: {
    detector_score?: number
    face_px?: number
    sharpness?: number
    bbox?: number[]
    photo_width?: number
    photo_height?: number
  } | null
  embedding_model: string
  enrolled_by: string
  enrolled_by_username: string
  enrolled_at: string
  approved_by_username: string | null
  approved_at: string | null
  rejected_by_username: string | null
  rejected_at: string | null
  rejection_reason: string | null
  retired_by_username: string | null
  retired_at: string | null
  retired_reason: string | null
  /** The caller may approve or reject it: pending, `person.approve`, and not
   *  the account that enrolled it (four-eyes). */
  can_review: boolean
}

export interface PersonPage {
  items: PersonEntry[]
  total: number
  limit: number
  offset: number
  pending: number
}

/** The two faces behind a `person_match` alarm, and the numbers behind it. */
export interface PersonMatchEvidence {
  alert_id: string
  person: PersonEntry | null
  face_url: string | null
  face_purged: boolean
  similarity: number | null
  threshold: number
  model_threshold: number
  frames_agreed: number | null
  frames_required: number | null
  captured_at: string | null
  camera_id: string | null
  notice: string
}

/** What the cameras are matching against right now. */
export interface PersonGalleryStatus {
  active_entries: number
  pending_entries: number
  version: string
  published_at: string | null
  publish_error: string | null
  threshold: number
  min_frames: number
  min_margin: number
  model: string
  model_threshold: number
  cameras: string[]
  default_valid_days: number
  max_valid_days: number
  min_face_px: number
}

// ── Candidate sightings: reads that may be this vehicle, misread ─────────

export interface CandidateEdit {
  kind: 'substitution' | 'missing' | 'extra'
  position: number
  expected: string | null
  read: string | null
  /** A common misreading: 0/O/D/Q, 1/I/L, 2/Z, 5/S, 6/G, 8/B, 4/A. */
  confusion: boolean
  text: string
}

export interface CandidateReason {
  factor: string
  detail: string
  /** Whether this reason makes it likelier (`for`) or less likely to be the vehicle. */
  tone: 'for' | 'against' | 'neutral'
}

export type CandidateFit = 'fits' | 'unknown' | 'conflicts' | 'same_visit'

export interface CandidateSighting {
  /** The visit's clearest read: what an include or a dismiss names. */
  detection_id: string
  detection_ts: string
  /** Every read in the visit, so a decision on any of them finds it. */
  detection_ids: string[]
  read_as: string
  camera_id: string
  camera_code: string
  camera_name: string
  city: string | null
  district: string | null
  placed: boolean
  town_level: boolean
  lat: number | null
  lon: number | null
  arrived_at: string
  departed_at: string
  sightings: number
  plate_confidence: number
  vehicle_type: string | null
  edits: CandidateEdit[]
  edit_count: number
  confusions: number
  distance: number
  difference: string
  fit: { status: CandidateFit; detail: string }
  strength: 'strong' | 'possible' | 'weak'
  reasons: CandidateReason[]
  recurrence: number
  crop_url: string | null
}

export interface CandidateReport {
  plate: string
  window: { from: string; to: string | null }
  total: number
  counts: Record<CandidateFit, number>
  candidates: CandidateSighting[]
  target_vehicle_type: string | null
  confirmed_visits: number
  criteria: {
    max_distance: number
    max_edits: number
    confusion_cost: number
    confusions: string[]
    dwell_window_s: number
    max_plausible_kmph: number
  }
  note: string
}

export type CandidateDecisionKind = 'include' | 'dismiss' | 'undo'

export interface CandidateDecisionRecord {
  plate: string
  detection_id: string
  detection_ts: string
  decision: CandidateDecisionKind
  read_as: string
  camera_code: string | null
  difference: string
  decided_by: string
  decided_at: string
}

// ── Pursuit: the cameras a vehicle can reach next, kept under analysis ───

export type PursuitWindow = 'open' | 'soon' | 'town' | 'passed' | 'later'

export type PursuitPinState =
  | 'pinned'
  | 'would_pin'
  | 'always_on'
  | 'waiting'
  | 'held'
  | 'ranked_lower'
  | 'outside_window'
  | 'reads_no_plates'
  | 'recorded'
  | 'not_in_fleet'

export interface PursuitPrediction {
  rank: number
  camera_id: string
  camera_code: string
  camera_name: string
  city: string | null
  lat: number | null
  lon: number | null
  grid: boolean
  always_on: boolean
  /** Straight line from where it was last seen; null between two cameras at one town centre. */
  distance_km: number | null
  approximate: boolean
  eta_from: string | null
  eta_to: string | null
  window: PursuitWindow
  basis: 'observed_pair' | 'observed_network' | 'default' | 'town'
  reasons: string[]
  plates_7d: number
  vehicles_7d: number
  pin_state: PursuitPinState
  pin_note: string
}

export interface PursuitAnchor {
  camera_id: string
  camera_code: string
  camera_name: string
  lat: number
  lon: number
  town_level: boolean
  /** The camera replays a recorded clip: not a vehicle on the road now. */
  recorded: boolean
  seen_at: string
  detection_id: string
}

export interface PursuitPin {
  camera_code: string
  camera_id: string
  pinned_at: string
  grid: boolean
  /** When a detection there first proved the workers were let in. */
  proven_at: string | null
}

export interface PursuitSighting {
  kind: 'confirmed' | 'possible'
  plate: string
  detection_id: string
  detection_ts: string
  camera_code: string | null
  camera_name: string | null
  seen_at: string
  confidence: number
  placed: boolean
  difference: string | null
  /** This read moved the pursuit on. */
  advanced: boolean
}

export interface PursuitGrid {
  held: boolean
  reason: string | null
  hold_until: string | null
  last_grid_detection: string | null
  silent: boolean
  /** What the platform can and cannot see of the workers' login state. */
  visibility: string
}

export interface Pursuit {
  plate: string
  status: 'active' | 'expired' | 'preview'
  started_at: string
  started_by: string
  renewed_at: string | null
  expires_at: string
  remaining_s: number
  pins_wanted: number
  anchor: PursuitAnchor | null
  basis: { kind: string; low_kmph: number; high_kmph: number; samples: number; note: string; short: string }
  predictions: PursuitPrediction[]
  excluded_unplaced: number
  pins: PursuitPin[]
  released: { camera_code: string; released_at: string; closes_at: string }[]
  sightings: PursuitSighting[]
  events: { at: string; text: string }[]
  grid: PursuitGrid
  policy: {
    duration_s: number
    min_pin_s: number
    linger_s: number
    horizon_s: number
    focus_capacity: number
    grid_silence_s: number
    pin_proof_s: number
  }
  notes: string[]
  /** On a preview only: what starting it would pin. */
  would_pin?: string[]
}

export interface PursuitSummary {
  plate: string
  started_at: string
  started_by: string
  expires_at: string
  remaining_s: number
  pins: string[]
}
