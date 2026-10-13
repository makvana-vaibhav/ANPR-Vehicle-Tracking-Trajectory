/**
 * Live: watch a camera and see what the pipeline reads off it.
 *
 * Two sources of truth sit side by side deliberately. The video with its
 * overlay shows *where* a vehicle was when it was read; the ledger beside it
 * shows *what* was read, with the evidence. The ledger never lies about the
 * reading itself, so the two together are honest in a way either alone would
 * not be.
 *
 * ## One camera on the stage, the rest in a rail
 *
 * A video wall would play every camera at once. This one deliberately plays
 * one: the organisers' grid meters watch time per address and locks out a
 * session that churns, and every decoded feed costs CPU the inference worker
 * on the same machine needs. The other cameras are a rail to scan and pick
 * from — code, place, and whether the pipeline is reading plates on each right
 * now — and picking one moves it onto the stage.
 *
 * The camera on the stage is named in the address (`/anpr?camera=SBX-cam10`),
 * which is how the search palette and the Command screen open a camera here,
 * and the address follows the operator's own choice so a reload or a shared
 * link lands on the same camera. **An address that names a camera opens that
 * camera or nothing** — never a default chosen while the named one is still
 * being looked up, because opening a camera nobody asked for spends the grid's
 * watch time and makes the workers analyse it. For the same reason, an address
 * that names none opens the most active camera *off* the grid, and a grid
 * camera only when there is nothing else.
 *
 * ## Where the boxes come from, and why they are not late
 *
 * A box has to appear early and has to be drawn on the vehicle, which keeps
 * moving after the frame it was measured on. Four things carry that weight, and
 * none of them is a delay the viewer has to accept:
 *
 * **A box appears as soon as a plate is *localised*** — when the detector has
 * found a plate and can say where it is, before OCR has read it and whether or
 * not OCR ever does. Waiting for text cost about a second of consensus, and on
 * this fleet two-thirds of tracked vehicles never yield a reading at all. The
 * picture distinguishes the three states, so a rectangle meaning "there is a
 * plate here" is never mistaken for one meaning "this vehicle is identified".
 *
 * **The worker publishes one message per camera per tick** — `camera.tracks`,
 * carrying every drawable vehicle at once, up to five times a second (every
 * frame it analyses, when it is analysing fewer than that). Because that
 * message describes the whole camera, a box also goes away the moment the car
 * does, rather than waiting out a timeout.
 *
 * **The player says which capture instant is on screen** — read from the HLS
 * programme-date tags, or measured from WebRTC's own receive lag — so a box is
 * scheduled against the picture rather than against now. **The overlay then
 * predicts** from the vehicle's own measured velocity across the gap between
 * that instant and the position it was last told about.
 *
 * The extra buffer below is the last resort, not the mechanism: it holds the
 * picture deliberately behind live so that every event arrives before its frame
 * is shown. Worth spending when the worker is loaded heavily enough that
 * capture-to-event runs into seconds, and not otherwise.
 *
 * Every camera is labelled with where its video comes from rather than left to
 * be guessed at — a judge is entitled to know whether they are looking at a
 * live camera or a replayed clip, and a platform that blurred the two would be
 * misrepresenting the capability being demonstrated.
 *
 * **Opening a camera causes it to be analysed.** One laptop cannot read plates
 * on the whole grid at once — each analysed camera costs about a core — so the
 * workers run a short always-on list and rotate the rest. While a camera is
 * open here the page sends a heartbeat (`api.focusCamera`), and the worker that
 * owns the camera puts it first: opened if need be, analysed within a few
 * seconds, and kept analysed until the page moves on. See
 * `services/api/app/services/focus.py` and `ai_worker.rotation`.
 *
 * ## Watched plates
 *
 * A read whose plate has raised a watchlist alarm is drawn as one, on the
 * picture and in the ledger. "Watched" is taken from the alarms themselves —
 * those that arrive on the socket while this page is open, and those still
 * open in the API — never from matching plates in the browser: the alarm is
 * where the platform has already decided, with the validity window, the near
 * matches and the deduplication applied.
 */

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Link, useSearchParams } from 'react-router-dom'

import AnprOverlay from '@/components/AnprOverlay'
import LivePlateFeed, { readFromDetection, timeIST, type WatchHit } from '@/components/LivePlateFeed'
import PipelineDiagnostics, { percentile } from '@/components/PipelineDiagnostics'
import { Skeleton, SkeletonRows } from '@/components/Skeleton'
import StreamPlayer, { type PlayerStatus } from '@/components/StreamPlayer'
import {
  Badge,
  Button,
  Checkbox,
  EmptyState,
  ErrorBanner,
  Icon,
  InfoHint,
  Input,
  PlateChip,
  SeverityGlyph,
  Spinner,
  StatusBadge,
  StatusDot,
} from '@/components/ui'
import { useAuth } from '@/hooks/useAuth'
import { useCameraFocus } from '@/hooks/useCameraFocus'
import { useCameraBoxes, useCameraEvents, useEventStream } from '@/hooks/useEventStream'
import * as api from '@/lib/api'
import { isPositionRefresh } from '@/lib/events'
import { PERMISSIONS } from '@/lib/permissions'
import { groupPlaces, isUnplaced } from '@/lib/places'
import type { Alert, Camera, Detection, LiveAlertEvent, LiveEvent, StreamGrant } from '@/lib/types'

/** Cameras with recorded ANPR activity float to the top of the rail. */
const RECENT_WINDOW_HOURS = 6

/**
 * How far behind live to hold the picture when the extra buffer is asked for.
 *
 * It has to cover capture-to-event on the worker plus the hop through Redis,
 * the API and the socket — otherwise a read arrives after its frame has already
 * been shown and the box never appears. It also has to stay inside what the
 * gateway keeps available: MediaMTX holds seven one-second segments, so beyond
 * about six seconds there is nothing left to play.
 *
 * Not needed for ordinary alignment any more. The gateway's low-latency HLS
 * already holds back ~600 ms and WebRTC reports its own lag, so the overlay
 * knows what is on screen either way; this buys headroom for a worker whose
 * latency has run into seconds, which is a load problem rather than a
 * synchronisation one.
 */
const SYNC_DELAY_MS = 2_500

/**
 * How recently a camera must have produced pipeline output to count as
 * reading plates.
 *
 * The output is a located or read plate — a `camera.tracks` batch or a vehicle
 * event. A worker watching an empty road publishes nothing (it says once that
 * the road is empty and then stays quiet), so silence is ambiguous between
 * "not analysed" and "analysed, nothing to see"; the window is long enough
 * that a gap between cars on a quiet junction does not flicker the mark off.
 */
export const READING_WINDOW_MS = 30_000

/** How often the reading marks are re-swept for cameras that have gone quiet. */
const READING_SWEEP_MS = 2_000

/** How often open watchlist alarms are re-read, between live arrivals. */
const ALARM_REFRESH_MS = 60_000

/** Rolling window for the title bar's pipeline latency. */
const LATENCY_SAMPLES = 20

/**
 * A camera carrying recorded footage rather than a live feed.
 *
 * Read from the registry's own tags, not guessed from the name: the `demo` tag
 * comes from `data/seed/cameras.csv` and is the single place that decides what
 * counts as demonstration footage.
 */
export function isDemoFeed(camera: Camera): boolean {
  // A grid camera switched to its own recording (`make grid-replay`) has a
  // clip and the `recorded-footage` tag but not `demo`; it is still a loop.
  if (camera.source_file) return true
  const tags = camera.tags ?? []
  return tags.includes('demo') || tags.includes('recorded-footage')
}

/**
 * A camera on the organisers' grid.
 *
 * The grid publishes HLS on 443 and WebRTC on a port most networks block, so
 * its cameras start on HLS — through our own authenticated proxy — rather than
 * paying a visible WebRTC failure first. Read from the adapter the registry
 * records (`vms_vendor`), with the `sandbox` tag as a fallback. It used to be
 * read from the VMS *name*, which an earlier rename changed from "Sentinel
 * Sandbox Grid" to "Hosted Camera Grid" — after which no grid camera matched,
 * and every one tried WebRTC against the grid first.
 */
export function isGridCamera(camera: Camera): boolean {
  // Replaying its recording, it is served by our own gateway, not the grid.
  if (camera.source_file) return false
  if (camera.vms_vendor === 'hosted_grid') return true
  if ((camera.tags ?? []).includes('sandbox')) return true
  return (camera.vms_name ?? '').toLowerCase().includes('sandbox')
}

/** Cameras that have read a plate recently first, then online, then the rest. */
export function orderCameras(cameras: Camera[], recent: ReadonlySet<string>): Camera[] {
  return [...cameras].sort((a, b) => {
    const activeA = recent.has(a.camera_code) ? 0 : 1
    const activeB = recent.has(b.camera_code) ? 0 : 1
    if (activeA !== activeB) return activeA - activeB
    const onlineA = a.status === 'online' ? 0 : 1
    const onlineB = b.status === 'online' ? 0 : 1
    if (onlineA !== onlineB) return onlineA - onlineB
    return a.camera_code.localeCompare(b.camera_code)
  })
}

/**
 * The camera to open when the address names none: the one most worth looking
 * at that is not on the organisers' grid. Opening a grid camera spends their
 * metered watch time and puts a worker on it, which should be an operator's
 * choice rather than a side effect of clicking "Live". Only when every camera
 * is on the grid does the most active one open by itself, so the page is never
 * left empty for want of a choice.
 */
export function defaultCamera(ordered: Camera[]): Camera | null {
  return ordered.find((camera) => !isGridCamera(camera)) ?? ordered[0] ?? null
}

/** The camera an address names, matched the way an operator types it. */
export function findCamera(cameras: Camera[], code: string): Camera | null {
  const wanted = code.trim().toLowerCase()
  return cameras.find((camera) => camera.camera_code.toLowerCase() === wanted) ?? null
}

/** The town, or the honest absence of one. */
function townOf(camera: Camera): string {
  if (isUnplaced(camera)) return 'position unknown'
  return camera.city?.trim() || camera.district?.trim() || 'position unknown'
}

/** Where a camera is, as a person would say it: the junction, then the town. */
function placeOf(camera: Camera): string {
  return camera.junction?.trim() || camera.name
}

// ── Watchlist alarms ────────────────────────────────────────────────────

/** An alarm from the API that is about a watched plate. */
export function isWatchlistAlert(alert: Pick<Alert, 'alert_type' | 'watchlist_id'>): boolean {
  return (
    alert.watchlist_id !== null ||
    alert.alert_type === 'watchlist_hit' ||
    alert.alert_type === 'possible_match'
  )
}

/** An alarm off the socket that is about a watched plate. */
export function isWatchlistEvent(event: LiveAlertEvent): boolean {
  return (
    Boolean(event.watchlist) ||
    event.alert_type === 'watchlist_hit' ||
    event.alert_type === 'possible_match'
  )
}

/**
 * Plates that have raised a watchlist alarm, keyed as stored, and why.
 *
 * Open alarms from the API cover what fired before this page was opened; the
 * socket covers what fires while it is. A live alarm carries the watchlist
 * entry itself — its category, the listed plate on a near match — so it is
 * preferred where both describe a plate, and the newest live alarm for a plate
 * is the one that stands. Anything that is not a watchlist alarm (a trajectory
 * anomaly, a camera fault) is not a reason to call a plate watched.
 */
export function watchHits(live: LiveAlertEvent[], open: Alert[]): Map<string, WatchHit> {
  const hits = new Map<string, WatchHit>()
  for (const alert of open) {
    if (!alert.plate_normalised || !isWatchlistAlert(alert)) continue
    hits.set(alert.plate_normalised, {
      listed: null,
      category: null,
      exact: alert.alert_type !== 'possible_match',
      priority: alert.priority,
    })
  }
  // The socket buffer is newest first; walked oldest first, the newest wins.
  for (let index = live.length - 1; index >= 0; index -= 1) {
    const event = live[index]
    if (!event?.plate || !isWatchlistEvent(event)) continue
    hits.set(event.plate, {
      listed: event.watchlist?.plate ?? null,
      category: event.watchlist?.category ?? null,
      exact: event.watchlist?.exact ?? event.alert_type !== 'possible_match',
      priority: event.priority,
    })
  }
  return hits
}

/**
 * Open watchlist alarms from the API, for a role that may read them.
 *
 * Re-read whenever an alarm arrives live — the moment an operator is looking —
 * and on a slow timer between, so one that has been handled stops marking its
 * camera. A failure here costs a red ring and is no reason to put an error on
 * the screen of the person watching; the Alarms screen reports its own.
 */
function useOpenWatchAlarms(allowed: boolean, liveAlerts: LiveAlertEvent[]): Alert[] {
  const [open, setOpen] = useState<Alert[]>([])

  const load = useCallback(async () => {
    if (!allowed) return
    try {
      const page = await api.getAlerts({ open_only: true, sort: 'priority', limit: 100 })
      setOpen(page.items.filter(isWatchlistAlert))
    } catch {
      // See above: a convenience, never a blocker.
    }
  }, [allowed])

  useEffect(() => {
    void load()
    const timer = window.setInterval(() => void load(), ALARM_REFRESH_MS)
    return () => window.clearInterval(timer)
  }, [load])

  // Only a genuinely new arrival: the buffer already holds whatever came in
  // before this page was opened, and the load above has covered that.
  const newest = liveAlerts[0]?.alert_id ?? null
  const seenRef = useRef(newest)
  useEffect(() => {
    if (newest === null || newest === seenRef.current) return
    seenRef.current = newest
    void load()
  }, [newest, load])

  return open
}

// ── Which cameras are reading plates now ────────────────────────────────

function sameMembers(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  if (a.size !== b.size) return false
  for (const item of a) if (!b.has(item)) return false
  return true
}

/**
 * Camera codes (lower-cased) whose pipeline has produced output recently.
 *
 * Fed by every batch and vehicle event in the fleet, but those arrive several
 * times a second per analysed camera, so arrival only stamps a time in a ref.
 * State changes when the *set* changes: at once when a camera starts reading,
 * and on a slow sweep when one goes quiet.
 */
function useReadingNow(): ReadonlySet<string> {
  const { subscribe } = useEventStream()
  const lastSeenRef = useRef(new Map<string, number>())
  const [codes, setCodes] = useState<ReadonlySet<string>>(() => new Set())

  useEffect(() => {
    const lastSeen = lastSeenRef.current
    const sweep = () => {
      const now = Date.now()
      const next = new Set<string>()
      for (const [code, at] of lastSeen) {
        if (now - at <= READING_WINDOW_MS) next.add(code)
        else lastSeen.delete(code)
      }
      setCodes((current) => (sameMembers(current, next) ? current : next))
    }

    const unsubscribe = subscribe((event: LiveEvent) => {
      if (
        event.event !== 'camera.tracks' &&
        event.event !== 'vehicle.observed' &&
        event.event !== 'vehicle.completed'
      ) {
        return
      }
      const code = event.source?.camera_id?.toLowerCase()
      if (!code) return
      const starting = !lastSeen.has(code)
      lastSeen.set(code, Date.now())
      if (starting) sweep()
    })
    const timer = window.setInterval(sweep, READING_SWEEP_MS)
    return () => {
      unsubscribe()
      window.clearInterval(timer)
    }
  }, [subscribe])

  return codes
}

// ── The rail's filters ──────────────────────────────────────────────────

interface FilterChip {
  key: string
  label: string
  count: number
  ids: ReadonlySet<string> | null
}

/**
 * Towns with more than one camera get a chip of their own; towns with one are
 * folded into "Other towns", and cameras with no known position get theirs.
 * A chip per single-camera town would be a second copy of the list.
 */
function townChips(cameras: Camera[]): FilterChip[] {
  const { places, unplaced } = groupPlaces(cameras)
  const chips: FilterChip[] = []
  const singles = new Set<string>()
  for (const place of places) {
    if (place.cameras.length >= 2) {
      chips.push({
        key: place.key,
        label: place.name,
        count: place.cameras.length,
        ids: new Set(place.cameras.map((c) => c.id)),
      })
    } else {
      for (const camera of place.cameras) singles.add(camera.id)
    }
  }
  if (singles.size > 0) {
    chips.push({ key: 'other', label: 'Other towns', count: singles.size, ids: singles })
  }
  if (unplaced.length > 0) {
    chips.push({
      key: 'unplaced',
      label: 'Position unknown',
      count: unplaced.length,
      ids: new Set(unplaced.map((c) => c.id)),
    })
  }
  return chips
}

function matchesQuery(camera: Camera, query: string): boolean {
  const needle = query.trim().toLowerCase()
  if (!needle) return true
  return [camera.camera_code, camera.name, camera.junction, camera.city, camera.district]
    .filter(Boolean)
    .some((field) => String(field).toLowerCase().includes(needle))
}

// ── Small pieces ────────────────────────────────────────────────────────

/**
 * The camera's mark, in the map's own language: the dot is its status, a
 * trail-coloured ring means the pipeline is reading plates on it, a red ring
 * means a watchlist alarm is open there.
 */
function CameraGlyph({
  camera,
  reading,
  alarm,
}: {
  camera: Camera
  reading: boolean
  alarm: boolean
}) {
  const ring = alarm ? 'border-priority-critical' : reading ? 'border-primary' : 'border-transparent'
  return (
    <span
      aria-hidden
      className={`mt-[3px] grid h-3.5 w-3.5 shrink-0 place-items-center rounded-full border ${ring}`}
    >
      <StatusDot status={camera.status} className="h-1.5 w-1.5" />
    </span>
  )
}

function StatePill({ tone, children, title }: { tone: 'reading' | 'quiet'; children: ReactNode; title?: string }) {
  return (
    <span
      title={title}
      className={`inline-flex h-6 shrink-0 items-center gap-1.5 rounded px-2 text-[10px] font-semibold uppercase tracking-[0.06em] ${
        tone === 'reading'
          ? 'bg-primary text-primary-foreground'
          : 'border border-input text-muted-foreground'
      }`}
    >
      {children}
    </span>
  )
}

function plural(count: number, one: string, many = `${one}s`): string {
  return `${count} ${count === 1 ? one : many}`
}

/** "A", "A and B", "A, B and C", "A, B, C, D and 3 more". */
function ReadingList({ cameras }: { cameras: Camera[] }) {
  const named = cameras.slice(0, 4)
  const rest = cameras.length - named.length
  return (
    <>
      {named.map((camera, index) => {
        const last = index === named.length - 1
        const separator = index === 0 ? '' : last && rest === 0 ? ' and ' : ', '
        return (
          <span key={camera.id}>
            {separator}
            <span className="font-mono text-foreground">{camera.camera_code}</span>
          </span>
        )
      })}
      {rest > 0 && ` and ${rest} more`}
    </>
  )
}

// ── The page ────────────────────────────────────────────────────────────

export default function LiveAnpr() {
  const { can } = useAuth()
  const { alerts: liveAlerts } = useEventStream()
  const [searchParams, setSearchParams] = useSearchParams()
  const requested = searchParams.get('camera')?.trim() || null

  // Null while the fleet is loading — distinct from a fleet that is empty.
  const [cameras, setCameras] = useState<Camera[] | null>(null)
  const [recentCodes, setRecentCodes] = useState<ReadonlySet<string>>(() => new Set())
  const [fleetError, setFleetError] = useState<string | null>(null)
  const [fleetAttempt, setFleetAttempt] = useState(0)
  // A camera the address names that is not in the ANPR fleet is looked up on
  // its own (the search palette links every camera here), and this is where
  // that lookup has got to.
  const [lookup, setLookup] = useState<{ code: string; missing: boolean } | null>(null)

  const [selected, setSelected] = useState<Camera | null>(null)
  const [grant, setGrant] = useState<StreamGrant | null>(null)
  const [openError, setOpenError] = useState<string | null>(null)
  const [openAttempt, setOpenAttempt] = useState(0)
  const [history, setHistory] = useState<Detection[] | null>(null)
  const [historyFailed, setHistoryFailed] = useState(false)
  const [player, setPlayer] = useState<PlayerStatus | null>(null)

  const [showBoxes, setShowBoxes] = useState(true)
  // Off by default, and now genuinely optional rather than the price of
  // correct boxes: the delay it adds is real and is the single biggest
  // contributor to the video feeling laggy when you open a camera, while
  // alignment no longer depends on it. Kept because a worker under enough load
  // to push capture-to-event into seconds cannot be aligned any other way.
  const [syncBoxes, setSyncBoxes] = useState(false)
  // Diagnostics are opt-in: the panel is for proving an optimisation worked,
  // not something an operator needs on screen during normal use.
  const [showDiagnostics, setShowDiagnostics] = useState(false)

  const [query, setQuery] = useState('')
  const [chip, setChip] = useState('all')

  // The player hands its capture clock to the overlay through a render prop;
  // the diagnostics panel needs the same clock to measure how far behind the
  // source the picture is, so it is captured here as it goes past, and read
  // through a getter that is stable for the life of the page.
  const videoClockRef = useRef<(() => number | null) | null>(null)
  const readVideoClock = useCallback(() => videoClockRef.current?.() ?? null, [])

  const selectedId = selected?.id ?? null
  const selectedCode = selected?.camera_code ?? null

  const liveEvents = useCameraEvents(selectedCode)
  // The live-boxes channel. One message per camera per tick carrying every
  // vehicle the pipeline has localised a plate on, which is what the overlay
  // draws from — earlier than a reading, and an order cheaper than sending the
  // same boxes one vehicle at a time.
  const liveBoxes = useCameraBoxes(selectedCode)

  // The overlay wants every event, because position refreshes are what let it
  // follow a vehicle. The ledger wants only the readings: a refresh repeats a
  // plate already listed, so leaving them in would crowd out the cars read a
  // few seconds ago with the same car reported again.
  const readings = useMemo(
    () => liveEvents.filter((event) => !isPositionRefresh(event)),
    [liveEvents],
  )

  const readingNow = useReadingNow()
  const mayReadAlerts = can(PERMISSIONS.alertRead)
  const openAlarms = useOpenWatchAlarms(mayReadAlerts, liveAlerts)
  const watched = useMemo(() => watchHits(liveAlerts, openAlarms), [liveAlerts, openAlarms])
  const watchedPlates = useMemo(() => new Set(watched.keys()), [watched])
  const alarmCameras = useMemo(
    () => new Set(openAlarms.map((alert) => alert.camera_id).filter((id): id is string => Boolean(id))),
    [openAlarms],
  )

  const plateHref = useMemo(
    () =>
      can(PERMISSIONS.searchExecute)
        ? (plate: string) => `/vehicles?plate=${encodeURIComponent(plate)}`
        : undefined,
    [can],
  )

  // ── The fleet, and which cameras have actually produced plates ──────────
  useEffect(() => {
    let cancelled = false
    async function load() {
      // Settled rather than all-or-nothing: the activity query only orders the
      // rail, and its failing is no reason to show no cameras at all. Both are
      // waited for, so the rail — and the camera it opens on when the address
      // names none — is ordered once rather than reshuffled under the cursor.
      const [page, recent] = await Promise.allSettled([
        api.getCameras({ limit: '500', anpr_enabled: 'true' }),
        api.getDetections({
          since: new Date(Date.now() - RECENT_WINDOW_HOURS * 3_600_000).toISOString(),
          limit: 200,
        }),
      ])
      if (cancelled) return
      if (page.status === 'rejected') {
        const reason: unknown = page.reason
        setFleetError(reason instanceof Error ? reason.message : String(reason))
        return
      }
      if (recent.status === 'fulfilled') {
        setRecentCodes(new Set(recent.value.items.map((d) => d.camera_code).filter(Boolean)))
      }
      setCameras(page.value.items)
      setFleetError(null)
    }
    void load()
    return () => {
      cancelled = true
    }
  }, [fleetAttempt])

  const ordered = useMemo(() => orderCameras(cameras ?? [], recentCodes), [cameras, recentCodes])
  const requestedCamera = useMemo(
    () => (requested && cameras ? findCamera(cameras, requested) : null),
    [requested, cameras],
  )

  // ── A camera named in the address but not in the ANPR fleet ─────────────
  const fleetLoaded = cameras !== null
  const requestedFound = requestedCamera !== null
  useEffect(() => {
    if (!requested || !fleetLoaded || requestedFound) return
    let cancelled = false
    setLookup({ code: requested, missing: false })
    api
      .getCameras({ search: requested, limit: '20' })
      .then((page) => {
        if (cancelled) return
        const found = findCamera(page.items, requested)
        if (found) {
          setCameras((current) =>
            current === null || current.some((c) => c.id === found.id) ? current : [...current, found],
          )
        } else {
          setLookup({ code: requested, missing: true })
        }
      })
      .catch(() => {
        if (!cancelled) setLookup({ code: requested, missing: true })
      })
    return () => {
      cancelled = true
    }
  }, [requested, fleetLoaded, requestedFound])

  /** Put a camera on the stage, and say so in the address. */
  const showCamera = useCallback(
    (camera: Camera) => {
      setSelected(camera)
      setSearchParams(
        (current) => {
          const next = new URLSearchParams(current)
          next.set('camera', camera.camera_code)
          return next
        },
        // Replace, not push: switching cameras is looking around, not
        // navigating, and Back should leave the page rather than replay the
        // operator's camera choices one at a time.
        { replace: true },
      )
    },
    [setSearchParams],
  )

  // ── Which camera is on the stage ────────────────────────────────────────
  useEffect(() => {
    if (cameras === null) return
    if (requested) {
      // The address names a camera: that one, or none at all. Never the
      // default — a default chosen while the named camera is still being
      // looked up would open a stream nobody asked for, and on the
      // organisers' grid that spends watch time and starts a worker on it.
      if (requestedCamera) {
        if (selected?.id !== requestedCamera.id) setSelected(requestedCamera)
      } else if (selected !== null) {
        setSelected(null)
      }
      return
    }
    // The address names none: keep the camera on screen and write it into the
    // address, or open the one most worth looking at.
    if (selected) {
      showCamera(selected)
      return
    }
    const first = defaultCamera(ordered)
    if (first) showCamera(first)
  }, [cameras, requested, requestedCamera, selected, ordered, showCamera])

  // ── Open the stream and load what this camera read before we arrived ────
  useEffect(() => {
    if (!selectedId) return
    let cancelled = false
    setGrant(null)
    setOpenError(null)
    setPlayer(null)
    setHistory(null)
    setHistoryFailed(false)

    // Independent: a camera whose history will not load is still worth
    // watching, and one whose stream is refused still has a history.
    api
      .openStream(selectedId)
      .then((streamGrant) => {
        if (!cancelled) setGrant(streamGrant)
      })
      .catch((err: unknown) => {
        if (!cancelled) setOpenError(err instanceof Error ? err.message : String(err))
      })
    api
      .getDetections({ camera_id: selectedId, limit: 30 })
      .then((past) => {
        if (!cancelled) setHistory(past.items)
      })
      .catch(() => {
        if (cancelled) return
        setHistory([])
        setHistoryFailed(true)
      })

    return () => {
      cancelled = true
    }
  }, [selectedId, openAttempt])

  // The camera on screen is analysed first, for as long as it is on screen.
  useCameraFocus(selectedId)

  // ── The pipeline's own latency, for the title bar ───────────────────────
  // A median over the last few batches rather than the newest figure, which
  // jumps by a hundred milliseconds five times a second and reads as noise.
  const latencySamplesRef = useRef<number[]>([])
  const [aiLatency, setAiLatency] = useState<number | null>(null)
  useEffect(() => {
    latencySamplesRef.current = []
    setAiLatency(null)
  }, [selectedId])
  const sampleLatency = useCallback((value: number | undefined) => {
    if (typeof value !== 'number' || !Number.isFinite(value)) return
    const samples = latencySamplesRef.current
    samples.push(value)
    if (samples.length > LATENCY_SAMPLES) samples.shift()
    const median = percentile(samples, 0.5)
    setAiLatency(median === null ? null : Math.round(median / 10) * 10)
  }, [])
  useEffect(() => sampleLatency(liveBoxes?.latency_ms), [liveBoxes, sampleLatency])
  useEffect(() => sampleLatency(liveEvents[0]?.latency_ms), [liveEvents, sampleLatency])

  // ── Derived ─────────────────────────────────────────────────────────────
  const fleet = cameras ?? []
  const readingInFleet = fleet.filter((c) => readingNow.has(c.camera_code.toLowerCase()))
  const chips = useMemo(() => townChips(cameras ?? []), [cameras])
  const activeChip = chips.find((c) => c.key === chip) ?? null
  const railCameras = ordered.filter((camera) => {
    if (chip === 'reading' && !readingNow.has(camera.camera_code.toLowerCase())) return false
    if (activeChip?.ids && !activeChip.ids.has(camera.id)) return false
    return matchesQuery(camera, query)
  })
  const filtered = chip !== 'all' || query.trim() !== ''

  const reading = selected !== null && readingNow.has(selected.camera_code.toLowerCase())
  const alarmHere = selected !== null && alarmCameras.has(selected.id)
  const demoCount = fleet.filter(isDemoFeed).length
  const looking = requested !== null && !requestedCamera && !(lookup?.code === requested && lookup.missing)
  const missing = requested !== null && !requestedCamera && lookup?.code === requested && lookup.missing
  const earlier = (history ?? [])
    .map(readFromDetection)
    .filter((read): read is NonNullable<typeof read> => read !== null)

  return (
    // overflow-hidden on a wide screen, not auto: the three columns below each
    // scroll their own body, so the page itself must hold still. A video wall
    // that scrolls out from under the operator is worse than one that clips.
    // Narrower than that the columns stack, and the page scrolls as a whole.
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto lg:overflow-hidden">
      {/* ── The page bar: what is being read, and the rail's filters ───── */}
      <header className="flex shrink-0 flex-wrap items-center gap-x-5 gap-y-2 border-b border-border px-4 py-2.5 lg:px-5">
        <div className="flex min-w-0 items-baseline gap-3">
          <h1 className="text-base font-semibold">Live</h1>
          {/* Says which cameras are *being read*, not just which exist. Every
              camera streams, but ANPR runs on a short always-on list plus the
              camera open here, which goes first. */}
          <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
            {cameras === null ? (
              'Loading cameras…'
            ) : (
              <>
                <span>{plural(fleet.length, 'camera')}</span>
                <span className="text-faint">·</span>
                <span>
                  plates read on{' '}
                  <span className={readingInFleet.length > 0 ? 'font-medium text-foreground' : ''}>
                    {readingInFleet.length}
                  </span>{' '}
                  now
                </span>
              </>
            )}
            <InfoHint label="How analysis is assigned">
              Every camera streams to this screen, but one machine cannot read
              plates on all of them at once: each analysed camera costs about a
              core. ANPR runs continuously on a short always-on list, and the
              camera open here is analysed first for as long as it is open —
              its boxes start within a few seconds of opening it. A camera
              counts as reading when it has located or read a plate in the last{' '}
              {READING_WINDOW_MS / 1000} seconds.
            </InfoHint>
          </p>
        </div>

        {cameras !== null && fleet.length > 0 && (
          <div role="group" aria-label="Show cameras" className="flex flex-wrap gap-1.5">
            {[
              { key: 'all', label: 'All', count: fleet.length },
              { key: 'reading', label: 'Reading plates', count: readingInFleet.length },
              ...chips,
            ].map((option) => {
              const on = chip === option.key
              return (
                <button
                  key={option.key}
                  type="button"
                  aria-pressed={on}
                  onClick={() => setChip(option.key)}
                  className={`flex h-7 items-center gap-1.5 rounded-md border px-2.5 text-xs transition ${
                    on
                      ? 'border-input bg-secondary text-foreground'
                      : 'border-border text-muted-foreground hover:bg-secondary/50 hover:text-foreground'
                  }`}
                >
                  {option.key === 'reading' && (
                    <span
                      aria-hidden
                      className={`h-1.5 w-1.5 rounded-full ${option.count > 0 ? 'bg-primary' : 'bg-status-unknown'}`}
                    />
                  )}
                  {option.label}
                  <span className="font-mono text-[11px] text-faint">{option.count}</span>
                </button>
              )
            })}
          </div>
        )}
      </header>

      {fleetError && (
        <div className="shrink-0 px-4 pt-3 lg:px-5">
          <ErrorBanner>
            <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
              Cameras could not be loaded: {fleetError}
              <button
                type="button"
                onClick={() => setFleetAttempt((n) => n + 1)}
                className="font-medium underline underline-offset-2"
              >
                Try again
              </button>
            </span>
          </ErrorBanner>
        </div>
      )}

      {/* Height is bounded only where the columns sit side by side. Stacked,
          each section takes its natural height and the page scrolls: a
          bounded grid with shrinkable rows draws the stage over the ledger. */}
      <div className="grid gap-3 p-3 lg:min-h-0 lg:flex-1 lg:grid-cols-[232px_minmax(0,1fr)_300px] lg:p-4 xl:grid-cols-[256px_minmax(0,1fr)_340px]">
        {/* ── The rail ──────────────────────────────────────────────── */}
        <aside
          aria-label="Cameras"
          className="flex max-h-[45vh] flex-col overflow-hidden rounded-lg border border-border bg-card lg:max-h-none lg:min-h-0"
        >
          <div className="shrink-0 border-b border-border p-2">
            <label className="relative block">
              <span className="sr-only">Filter cameras</span>
              <Icon
                name="search"
                size={14}
                className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-faint"
              />
              <Input
                type="search"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Escape') setQuery('')
                }}
                placeholder="Code, junction or town"
                spellCheck={false}
                autoComplete="off"
                className="h-8 pl-8"
              />
            </label>
          </div>

          {/* A dense list rather than a stack of bordered cards: this is a
              picker for twelve to sixty entries, and one bordered box per row
              made the rail read as sixty separate panels. */}
          {cameras === null ? (
            <div className="p-2">
              {fleetError ? (
                <p className="px-1 py-2 text-xs text-muted-foreground">No cameras to list.</p>
              ) : (
                <SkeletonRows rows={8} height="h-10" />
              )}
            </div>
          ) : railCameras.length === 0 ? (
            <p className="px-3 py-4 text-xs text-muted-foreground">
              {fleet.length === 0 ? 'No ANPR cameras are registered.' : 'No camera matches.'}
            </p>
          ) : (
            <ul className="min-h-0 flex-1 overflow-y-auto py-1">
              {railCameras.map((camera) => {
                const active = camera.id === selectedId
                const cameraReading = readingNow.has(camera.camera_code.toLowerCase())
                const alarm = alarmCameras.has(camera.id)
                return (
                  <li key={camera.id}>
                    <button
                      type="button"
                      onClick={() => showCamera(camera)}
                      aria-current={active ? 'true' : undefined}
                      className={`relative flex w-full items-start gap-2.5 px-3 py-2 text-left transition ${
                        active ? 'bg-secondary' : 'hover:bg-secondary/50'
                      }`}
                    >
                      {active && (
                        <span
                          aria-hidden
                          className="absolute inset-y-1 left-0 w-[3px] rounded-r bg-primary"
                        />
                      )}
                      <CameraGlyph camera={camera} reading={cameraReading} alarm={alarm} />
                      <span className="min-w-0 flex-1">
                        <span className="flex items-center gap-2">
                          <span className="font-mono text-[12px] font-medium text-foreground">
                            {camera.camera_code}
                          </span>
                          {/* Provenance, always. A viewer should never have to
                              wonder whether a feed is a real camera or a clip. */}
                          {isDemoFeed(camera) && (
                            <span
                              title="Recorded clip, not a live camera"
                              className="text-[10px] font-medium uppercase tracking-[0.06em] text-priority-high"
                            >
                              clip
                            </span>
                          )}
                          {!camera.anpr_enabled && (
                            <span
                              title="Outside the ANPR fleet: video only, no plates are read here"
                              className="text-[10px] uppercase tracking-[0.06em] text-faint"
                            >
                              no anpr
                            </span>
                          )}
                          {alarm ? (
                            <span className="ml-auto flex items-center gap-1 text-[10px] font-semibold uppercase tracking-[0.06em] text-priority-critical">
                              <SeverityGlyph priority="critical" size={8} />
                              alarm
                            </span>
                          ) : (
                            cameraReading && (
                              <span className="ml-auto text-[10px] font-semibold uppercase tracking-[0.06em] text-primary">
                                reading
                              </span>
                            )
                          )}
                        </span>
                        <span className="mt-0.5 block truncate text-[12px] text-muted-foreground">
                          {placeOf(camera)}
                          <span className="text-faint"> · {townOf(camera)}</span>
                        </span>
                      </span>
                    </button>
                  </li>
                )
              })}
            </ul>
          )}

          {cameras !== null && filtered && (
            <div className="flex shrink-0 items-center justify-between gap-2 border-t border-border px-3 py-1.5 text-[11px] text-faint">
              <span>
                {railCameras.length} of {fleet.length}
              </span>
              <button
                type="button"
                onClick={() => {
                  setQuery('')
                  setChip('all')
                }}
                className="text-muted-foreground transition hover:text-foreground"
              >
                Show all
              </button>
            </div>
          )}
        </aside>

        {/* ── The stage ─────────────────────────────────────────────── */}
        <section aria-label="Camera on screen" className="min-w-0 lg:min-h-0 lg:overflow-y-auto">
          {/* Never taller than the screen: on a wide monitor the picture would
              otherwise outgrow the height and push its own controls below the
              fold. The figure is the chrome above and below the video. */}
          <div className="mx-auto flex w-full flex-col gap-3 lg:max-w-[calc((100vh-14rem)*16/9)]">
            {selected ? (
              <>
                {/* Title bar: which camera, where, and what it is doing. On a
                    wide screen it holds one line and the place name gives way
                    first; the state on the right is what an operator scans. */}
                <div className="flex flex-wrap items-center gap-x-3 gap-y-2 lg:flex-nowrap">
                  <div className="flex min-w-0 items-center gap-3 lg:flex-1">
                    <span className="flex h-6 shrink-0 items-center rounded-md border border-border bg-background px-2 font-mono text-[12px] text-foreground">
                      {selected.camera_code}
                    </span>
                    <h2 className="min-w-0 truncate text-[15px] font-medium" title={placeOf(selected)}>
                      {placeOf(selected)}
                    </h2>
                    <span className="hidden shrink-0 text-[13px] text-muted-foreground sm:inline">
                      {townOf(selected)}
                    </span>
                  </div>

                  <div className="ml-auto flex shrink-0 flex-wrap items-center gap-2 lg:flex-nowrap">
                    {alarmHere && (
                      <Link
                        to="/alerts"
                        className="inline-flex h-6 items-center gap-1.5 rounded bg-priority-critical px-2 text-[10px] font-semibold uppercase tracking-[0.06em] text-priority-critical-ink"
                      >
                        <SeverityGlyph priority="critical" />
                        Watchlist alarm
                      </Link>
                    )}
                    {isDemoFeed(selected) && <Badge tone="warning">Recorded clip</Badge>}
                    {(selected.status === 'offline' || selected.status === 'degraded') && (
                      <StatusBadge status={selected.status} />
                    )}
                    {!selected.anpr_enabled ? (
                      <StatePill tone="quiet" title="This camera is outside the ANPR fleet">
                        Video only
                      </StatePill>
                    ) : reading ? (
                      <StatePill
                        tone="reading"
                        title={`A plate has been located or read here in the last ${READING_WINDOW_MS / 1000} s`}
                      >
                        Reading plates
                      </StatePill>
                    ) : (
                      player?.state === 'playing' && (
                        <StatePill
                          tone="quiet"
                          title={`No plate located or read here in the last ${READING_WINDOW_MS / 1000} s. Reading starts within a few seconds of opening a camera, once a vehicle shows its plate.`}
                        >
                          Streaming
                        </StatePill>
                      )
                    )}
                    {aiLatency !== null && (
                      <span
                        title="Capture to event on the worker — the median of the last few batches"
                        className="font-mono text-[11px] text-faint"
                      >
                        AI {aiLatency} ms
                      </span>
                    )}
                  </div>
                </div>

                {/* The picture. */}
                {openError ? (
                  <div className="flex aspect-video flex-col items-center justify-center gap-2 rounded-lg border border-border bg-card px-6 text-center">
                    <Icon name="video" size={22} className="text-status-degraded" />
                    <p className="text-[13px] font-medium text-status-degraded">
                      This camera could not be opened
                    </p>
                    <p className="max-w-md text-xs leading-relaxed text-muted-foreground">
                      {openError}
                    </p>
                    <Button
                      variant="outline"
                      size="sm"
                      className="mt-1"
                      onClick={() => setOpenAttempt((n) => n + 1)}
                    >
                      <Icon name="refresh" size={13} />
                      Try again
                    </Button>
                  </div>
                ) : grant ? (
                  <StreamPlayer
                    whepUrl={grant.whep_url}
                    hlsUrl={grant.hls_url}
                    cameraCode={selected.camera_code}
                    preferHls={isGridCamera(selected)}
                    syncDelayMs={syncBoxes ? SYNC_DELAY_MS : 0}
                    onStatus={setPlayer}
                    overlay={(videoClock) => {
                      videoClockRef.current = videoClock
                      return (
                        <AnprOverlay
                          batch={liveBoxes}
                          // Still passed, and used only for a camera that
                          // publishes no batches — a worker predating the
                          // channel, or the simulator's load mode. The overlay
                          // ignores them for drawing once a batch has arrived.
                          events={liveEvents}
                          camera={selected.camera_code}
                          enabled={showBoxes}
                          // Always. The clock says which capture instant is on
                          // screen, and both transports can now answer — HLS
                          // from its programme-date tags, WebRTC from its own
                          // measured receive lag. Withholding it unless the
                          // extra buffer was ticked left the overlay guessing
                          // on the default path, which is the one everybody
                          // actually watches.
                          videoClock={videoClock}
                          watchedPlates={watchedPlates}
                        />
                      )
                    }}
                    toolbar={
                      <>
                        <Checkbox
                          checked={showBoxes}
                          onChange={(e) => setShowBoxes(e.target.checked)}
                          label="Plate boxes"
                          labelClassName="gap-1.5 text-xs text-muted-foreground"
                        />
                        <span className="flex items-center gap-1">
                          <Checkbox
                            checked={syncBoxes}
                            onChange={(e) => setSyncBoxes(e.target.checked)}
                            label="Extra buffer"
                            labelClassName="gap-1.5 text-xs text-muted-foreground"
                          />
                          <InfoHint label="What the extra buffer does">
                            Holds the picture {(SYNC_DELAY_MS / 1000).toFixed(1)}s
                            behind live, so every reading arrives before the frame
                            it describes is shown. Boxes are aligned to the picture
                            either way — turn this on only when the worker is loaded
                            enough that readings arrive seconds late.
                          </InfoHint>
                        </span>
                        <Checkbox
                          checked={showDiagnostics}
                          onChange={(e) => setShowDiagnostics(e.target.checked)}
                          label="Latency"
                          labelClassName="gap-1.5 text-xs text-muted-foreground"
                        />
                      </>
                    }
                  />
                ) : (
                  <div className="relative">
                    <Skeleton className="aspect-video w-full rounded-lg" />
                    <div className="absolute inset-0 flex flex-col items-center justify-center gap-2.5">
                      <Spinner className="h-6 w-6" />
                      <p className="text-xs text-muted-foreground">Opening stream…</p>
                    </div>
                  </div>
                )}

                {/* Provenance and how the boxes are placed, as facts rather
                    than as an essay. A viewer is entitled to know whether they
                    are looking at a live camera or a replayed clip — but that
                    is a few words plus a marker, not a paragraph under every
                    camera they open. The reasoning is intact behind the hints. */}
                <div className="flex flex-wrap items-center gap-x-5 gap-y-1.5 text-xs text-muted-foreground">
                  {isDemoFeed(selected) ? (
                    <span className="flex items-center gap-1.5">
                      Recorded footage, replayed on a loop
                      <InfoHint label="Why this feed is recorded footage">
                        Recorded footage, not a live camera. It is replayed so
                        the pipeline can be demonstrated end to end on traffic
                        close enough for plates to be legible.
                        {demoCount > 1 &&
                          ` ${demoCount} cameras in this list replay recorded footage.`}
                        {regionOf(selected) &&
                          ` The plates in it are ${regionOf(selected)} registrations, read by the same pipeline.`}
                      </InfoHint>
                    </span>
                  ) : (
                    <span className="flex items-center gap-1.5">
                      {isGridCamera(selected)
                        ? "From the organisers' grid, pulled on demand"
                        : 'Live, pulled on demand'}
                      <InfoHint label="What affects plate legibility here">
                        Plate legibility depends entirely on what the camera can
                        see. Vehicles are detected and tracked regardless, but a
                        plate at 40–60&nbsp;px in glare is frequently unreadable.
                        Nothing is invented when a plate cannot be read — the
                        ledger simply stays empty.
                      </InfoHint>
                    </span>
                  )}

                  {selected.vms_name && (
                    <span className="text-faint" title="The video management system this camera is federated from">
                      {selected.vms_name}
                    </span>
                  )}

                  <span className="flex items-center gap-1.5">
                    {syncBoxes ? (
                      <>
                        <span className="text-foreground">
                          Buffered {(SYNC_DELAY_MS / 1000).toFixed(1)}s
                        </span>
                        · boxes exact
                      </>
                    ) : (
                      <>
                        <span className="text-foreground">Live</span>· boxes predicted
                      </>
                    )}
                    <InfoHint label="How the boxes are placed">
                      {syncBoxes ? (
                        <>
                          The picture is held {(SYNC_DELAY_MS / 1000).toFixed(1)}s
                          behind live, so every reading is already here before
                          the frame it describes is shown and no box has to be
                          predicted at all.
                        </>
                      ) : (
                        <>
                          The lowest-latency picture the transport allows. A box
                          appears as soon as a plate is located — dashed until
                          it has been read — placed against the capture instant
                          on screen and carried forward on the vehicle&rsquo;s
                          own measured velocity, so it lands on the car rather
                          than behind it.
                        </>
                      )}{' '}
                      Every box carries the pipeline&rsquo;s own
                      capture-to-event figure; tick <em>Latency</em> to see it
                      aggregated. The ledger on the right is the authoritative
                      record of what was read.
                    </InfoHint>
                  </span>
                </div>

                {showDiagnostics && grant && (
                  <PipelineDiagnostics
                    key={selected.id}
                    events={liveEvents}
                    batch={liveBoxes}
                    videoClock={readVideoClock}
                    transport={
                      player?.state === 'playing'
                        ? player.transport === 'hls'
                          ? 'HLS'
                          : 'WebRTC'
                        : null
                    }
                  />
                )}

                {/* What this camera read before the page was opened. It sits
                    under the picture rather than in the ledger because the two
                    answer different questions — "what is happening now"
                    belongs beside the picture, "what already happened" does
                    not — and because stacked in the right-hand column it was
                    the thing that got cut off. */}
                <section aria-label="Earlier on this camera" className="pb-1">
                  <h3 className="flex items-baseline gap-2 text-[11px] font-medium uppercase tracking-[0.06em] text-muted-foreground">
                    Earlier on this camera
                    {history !== null && earlier.length > 0 && (
                      <span className="font-mono normal-case tracking-normal text-faint">
                        {plural(earlier.length, 'read')}, newest first
                      </span>
                    )}
                  </h3>
                  {history === null ? (
                    <div className="mt-2 flex flex-wrap gap-1.5">
                      {Array.from({ length: 6 }, (_, i) => (
                        <Skeleton key={i} className="h-8 w-40 rounded-md" />
                      ))}
                    </div>
                  ) : earlier.length === 0 ? (
                    <p className="mt-1.5 text-xs text-faint">
                      {historyFailed
                        ? 'The earlier reads could not be loaded.'
                        : 'Nothing read on this camera before you opened it.'}
                    </p>
                  ) : (
                    <ul className="mt-2 flex flex-wrap gap-1.5">
                      {earlier.map((read) => {
                        const watch = watched.get(read.plate) ?? null
                        const href = plateHref?.(read.plate) ?? null
                        const body = (
                          <>
                            <PlateChip
                              plate={read.plate}
                              size="xs"
                              watched={watch !== null}
                              partial={read.ambiguous || read.grammarValid === false}
                            />
                            <span className="font-mono text-[11px] text-muted-foreground">
                              {timeIST(read.at)}
                            </span>
                            {read.confidence !== null && (
                              <span className="font-mono text-[11px] text-faint">
                                {read.confidence.toFixed(2)}
                              </span>
                            )}
                          </>
                        )
                        const chipClass = `flex items-center gap-2 rounded-md border px-2 py-1 transition ${
                          watch
                            ? 'border-priority-critical/45 bg-priority-critical/[0.07]'
                            : 'border-border bg-card'
                        }`
                        const title = [
                          read.vehicleType ?? 'vehicle',
                          read.frames !== null ? plural(read.frames, 'frame') : null,
                          watch ? 'raised a watchlist alarm' : null,
                        ]
                          .filter(Boolean)
                          .join(' · ')
                        return (
                          <li key={read.key}>
                            {href ? (
                              <Link
                                to={href}
                                title={`${title} — open its journey`}
                                className={`${chipClass} hover:border-input hover:bg-secondary/40`}
                              >
                                {body}
                              </Link>
                            ) : (
                              <span title={title} className={chipClass}>
                                {body}
                              </span>
                            )}
                          </li>
                        )
                      })}
                    </ul>
                  )}
                </section>
              </>
            ) : cameras === null && fleetError ? (
              <EmptyState
                title="No camera to show"
                hint="The camera list could not be loaded. Try again from the banner above."
              />
            ) : cameras === null || looking ? (
              <div className="flex flex-col gap-3">
                <Skeleton className="h-6 w-72" />
                <div className="relative">
                  <Skeleton className="aspect-video w-full rounded-lg" />
                  {looking && (
                    <p className="absolute inset-0 flex items-center justify-center text-xs text-muted-foreground">
                      Looking for {requested}…
                    </p>
                  )}
                </div>
              </div>
            ) : missing ? (
              <EmptyState
                className="py-16"
                title={`No camera called ${requested}`}
                hint="Nothing has been opened. Pick a camera from the list — the address will follow."
              />
            ) : fleet.length === 0 ? (
              <EmptyState
                className="py-16"
                title="No ANPR cameras are registered"
                hint="Cameras appear here once they are onboarded with plate reading turned on."
              />
            ) : (
              <EmptyState className="py-16" title="Pick a camera from the list" />
            )}
          </div>
        </section>

        {/* ── The ledger ────────────────────────────────────────────── */}
        <aside
          aria-label="Plate reads"
          className="flex max-h-[80vh] min-h-[320px] min-w-0 flex-col overflow-hidden rounded-lg border border-border bg-card lg:max-h-none lg:min-h-0"
        >
          <div className="flex shrink-0 items-center gap-2 border-b border-border px-3.5 py-2.5">
            <h2 className="text-[13px] font-semibold">Reads</h2>
            <span
              aria-hidden
              className={`h-1.5 w-1.5 shrink-0 rounded-full ${reading ? 'animate-pulse-alert bg-primary' : 'bg-status-unknown'}`}
            />
            <span className="min-w-0 truncate text-xs text-faint">
              newest first{selectedCode && <> · <span className="font-mono">{selectedCode}</span></>}
            </span>
            <span className="ml-auto">
              <InfoHint label="What this ledger is" align="right">
                The authoritative record of what the pipeline read. Unlike the
                boxes on the video, nothing here depends on lining up with a
                moving picture — each row carries the crop it was read from,
                how many frames were involved, whether they agreed, and whether
                the grammar had to repair the string. A plate that raised a
                watchlist alarm is ringed in red.
              </InfoHint>
            </span>
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto p-2.5">
            <LivePlateFeed
              events={readings}
              watched={watched}
              plateHref={plateHref}
              emptyMessage={
                selectedCode
                  ? `Nothing read on ${selectedCode} since you opened it.`
                  : 'Pick a camera to see its reads.'
              }
            />
          </div>

          <div className="shrink-0 border-t border-border px-3.5 py-3 text-xs leading-relaxed text-muted-foreground">
            <p className="font-medium text-foreground">What is being read</p>
            <p className="mt-1">
              {readingInFleet.length === 0 ? (
                'No camera has located or read a plate in the last half-minute.'
              ) : (
                <>
                  Plates are being read on <ReadingList cameras={readingInFleet} />.
                </>
              )}{' '}
              Opening a camera puts it first: reading starts within a few
              seconds and continues while it is on screen.
            </p>
          </div>
        </aside>
      </div>
    </div>
  )
}

/** The plate region a recorded clip's registry entry declares, if any. */
function regionOf(camera: Camera): string | null {
  const tag = (camera.tags ?? []).find((t) => t.startsWith('plate-region:'))
  const region = tag?.slice('plate-region:'.length).trim()
  return region ? region : null
}
