/**
 * Overview: the whole network, now — calm, and one step from every job.
 *
 * Built for a constable or a control-room operator, not an analyst: a map of
 * the cameras, the alarms that need someone, the plates being read, and a box
 * to look a vehicle up. Everything else — rates, sparklines, how each figure
 * is derived — lives on the screen it belongs to (Live, Cameras → Health,
 * More → Traffic), one click away.
 *
 * ## Decisions worth stating
 *
 * **Two figures, both counted.** "32 of 32 cameras online" is the fleet's
 * own status (and says how many are only last-known while the grid refuses
 * us); "3 reading plates" is the cameras that read a plate in the last ten
 * minutes, from the record and the live feed — not the number configured to,
 * which would look the same with the pipeline stopped.
 *
 * **Something on screen is always visibly live.** The ripples on the map and
 * the strip of plates along the bottom move when plates are read and stop
 * when they are not.
 *
 * **Vehicles first.** Persons-watchlist (face) matches are not shown here;
 * they have their own lane under Alarms → Persons.
 */

import { useCallback, useEffect, useMemo, useState, type FormEvent, type ReactNode } from 'react'
import { Link, useNavigate } from 'react-router-dom'

import CommandMap, { type Trail } from '@/components/CommandMap'
import { sourceKind } from '@/components/network/cameraFacts'
import { Skeleton } from '@/components/Skeleton'
import { ErrorBanner, Icon, PlateChip, PriorityBadge, StatusDot } from '@/components/ui'
import { useAuth } from '@/hooks/useAuth'
import { useEventStream } from '@/hooks/useEventStream'
import * as api from '@/lib/api'
import { alarmTitle, isPersonAlarm } from '@/lib/alarms'
import { liveTrackKey } from '@/lib/events'
import { PERMISSIONS } from '@/lib/permissions'
import { groupPlaces, type Place } from '@/lib/places'
import type { Alert, Camera, Detection, FleetHealth, FlowResponse } from '@/lib/types'

const REFRESH_MS = 30_000
const SLOW_REFRESH_MS = 60_000
/** A camera counts as reading plates if it read one this recently. */
const READING_WINDOW_MS = 10 * 60_000
const MAX_TRAILS = 8
const STRIP_LENGTH = 14

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/** Ticks so that "in the last ten minutes" and "4 min ago" stay true. */
function useNow(everyMs: number): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), everyMs)
    return () => window.clearInterval(timer)
  }, [everyMs])
  return now
}

/** "2 min", "1 h 15 min" — an alarm's age, short enough for a card corner. */
export function ageOf(iso: string, now: number): string {
  const s = Math.max(0, (now - new Date(iso).getTime()) / 1000)
  if (s < 60) return `${Math.floor(s)} s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m} min`
  const h = Math.floor(m / 60)
  if (h < 24) return m % 60 ? `${h} h ${m % 60} min` : `${h} h`
  return `${Math.floor(h / 24)} d`
}

/** What a typed plate becomes in the search address: letters and digits only. */
export function normalisePlateInput(text: string): string {
  return text.toUpperCase().replace(/[^A-Z0-9]/g, '')
}

// ── A plate read, from the live feed or from the record ──────────────

interface Read {
  key: string
  plate: string
  code: string
  at: string
  confidence: number | null
}

export default function Dashboard() {
  const { can } = useAuth()
  const { detections, alerts: liveAlerts, status } = useEventStream()
  const now = useNow(15_000)

  const maySeeAlerts = can(PERMISSIONS.alertRead)
  const maySearch = can(PERMISSIONS.searchExecute)
  const mayWatch = can(PERMISSIONS.streamView)

  const [cameras, setCameras] = useState<Camera[] | null>(null)
  const [health, setHealth] = useState<FleetHealth | null>(null)
  const [flow, setFlow] = useState<FlowResponse | null>(null)
  const [alarms, setAlarms] = useState<Alert[] | null>(null)
  const [trails, setTrails] = useState<Trail[]>([])
  const [trailWindow, setTrailWindow] = useState<string | null | undefined>(undefined)
  const [seed, setSeed] = useState<Detection[]>([])
  const [selectedKey, setSelectedKey] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  // ── Loading ──────────────────────────────────────────────────────────

  const loadNetwork = useCallback(async () => {
    try {
      const [page, fleet] = await Promise.all([
        api.getCameras({ limit: '500' }),
        api.getFleetHealth(),
      ])
      setCameras(page.items)
      setHealth(fleet)
      setError(null)
    } catch (err) {
      setError(message(err))
    }
  }, [])

  const loadActivity = useCallback(async () => {
    const since = new Date(Date.now() - 3_600_000).toISOString()
    try {
      // Which cameras read a plate recently. The recorded clip counts: this
      // screen shows the pipeline at work, not traffic.
      setFlow(
        await api.getAnalyticsFlow({
          since,
          bucket: '5m',
          group_by: 'camera',
          include_recorded: true,
        }),
      )
    } catch {
      // A role without analytics still sees cameras reading from the live
      // feed alone.
      setFlow(null)
    }
    try {
      setSeed((await api.getDetections({ readable_only: true, limit: STRIP_LENGTH })).items)
    } catch {
      /* the strip fills from the live feed alone */
    }
  }, [])

  const loadAlarms = useCallback(async () => {
    if (!maySeeAlerts) return
    try {
      const page = await api.getAlerts({ open_only: true, sort: 'priority', limit: 50 })
      setAlarms(page.items.filter((a) => !isPersonAlarm(a.alert_type)))
    } catch (err) {
      setError(message(err))
    }
  }, [maySeeAlerts])

  // A vehicle seen at two or more cameras, as a trail. The last hour if there
  // are any; otherwise the last day, labelled as such — never a wider window
  // passed off as "now".
  const loadTrails = useCallback(async () => {
    if (!maySearch) {
      setTrailWindow(null)
      return
    }
    const windows: [number, string][] = [
      [1, 'last hour'],
      [24, 'last 24 h'],
    ]
    try {
      for (const [hours, label] of windows) {
        const since = new Date(Date.now() - hours * 3_600_000).toISOString()
        const routable = await api.getRoutablePlates(2, MAX_TRAILS, since)
        if (routable.plates.length === 0) continue
        const routes = await Promise.all(
          routable.plates.map((p) => api.getVehicleRoute(p.plate, { since }).catch(() => null)),
        )
        const found: Trail[] = []
        for (const route of routes) {
          if (!route || route.hops.length < 2) continue
          found.push({
            plate: route.plate,
            coords: route.hops.map((h) => [h.lon, h.lat] as [number, number]),
            plausible: route.is_plausible,
          })
        }
        if (found.length > 0) {
          setTrails(found)
          setTrailWindow(label)
          return
        }
      }
      setTrails([])
      setTrailWindow(null)
    } catch {
      setTrailWindow(null)
    }
  }, [maySearch])

  useEffect(() => {
    void loadNetwork()
    void loadAlarms()
    const fast = window.setInterval(() => {
      void loadNetwork()
      void loadAlarms()
    }, REFRESH_MS)
    return () => window.clearInterval(fast)
  }, [loadNetwork, loadAlarms])

  useEffect(() => {
    void loadActivity()
    void loadTrails()
    const slow = window.setInterval(() => {
      void loadActivity()
      void loadTrails()
    }, SLOW_REFRESH_MS)
    return () => window.clearInterval(slow)
  }, [loadActivity, loadTrails])

  // An alarm arriving live is reflected now, not at the next poll — that wait
  // is exactly when an operator is watching.
  useEffect(() => {
    if (liveAlerts.length > 0) void loadAlarms()
  }, [liveAlerts, loadAlarms])

  // ── Derived ──────────────────────────────────────────────────────────

  const byCode = useMemo(
    () => new Map((cameras ?? []).map((c) => [c.camera_code.toLowerCase(), c])),
    [cameras],
  )
  const byId = useMemo(() => new Map((cameras ?? []).map((c) => [c.id, c])), [cameras])
  const { places } = useMemo(() => groupPlaces(cameras ?? []), [cameras])
  const selected = places.find((p) => p.key === selectedKey) ?? null

  /** Cameras that read a plate in the last ten minutes: the record, plus
   *  whatever has arrived live since it was fetched. */
  const reading = useMemo(() => {
    const codes = new Set<string>()
    const cutoff = now - READING_WINDOW_MS
    if (flow) {
      const width = flow.window.bucket_seconds * 1000
      for (const series of flow.series) {
        if (series.points.some((p) => p.with_plate > 0 && new Date(p.ts).getTime() + width >= cutoff)) {
          codes.add(series.key)
        }
      }
    }
    for (const event of detections) {
      if (new Date(event.event_time).getTime() >= cutoff) codes.add(event.source.camera_id)
    }
    return codes
  }, [flow, detections, now])

  const watched = useMemo(() => {
    const plates = new Set<string>()
    for (const a of alarms ?? []) {
      if (a.alert_type === 'watchlist_hit' && a.plate_normalised) plates.add(a.plate_normalised)
    }
    for (const a of liveAlerts) {
      if (a.alert_type === 'watchlist_hit' && a.plate) plates.add(a.plate)
    }
    return plates
  }, [alarms, liveAlerts])

  const alarmedCameras = useMemo(
    () => new Set((alarms ?? []).flatMap((a) => (a.camera_id ? [a.camera_id] : []))),
    [alarms],
  )

  const reads = useMemo<Read[]>(() => {
    const out: Read[] = []
    const seen = new Set<string>()
    // One card per vehicle: a vehicle's first reading and its settled one
    // arrive as two events, and listing both would count it twice.
    for (const event of detections) {
      const key = liveTrackKey(event)
      if (seen.has(key)) continue
      seen.add(key)
      out.push({
        key,
        plate: event.plate.text,
        code: event.source.camera_id,
        at: event.captured_at ?? event.event_time,
        confidence: event.plate.confidence,
      })
      if (out.length >= STRIP_LENGTH) return out
    }
    // Topped up from the record, so the strip says what was read most
    // recently even in the first seconds after the page opens.
    const live = new Set(out.map((r) => `${r.plate}|${r.code}`))
    for (const d of seed) {
      if (!d.plate || live.has(`${d.plate}|${d.camera_code}`)) continue
      out.push({ key: d.id, plate: d.plate, code: d.camera_code, at: d.ts, confidence: d.plate_confidence })
      if (out.length >= STRIP_LENGTH) break
    }
    return out
  }, [detections, seed])

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto lg:flex-row lg:overflow-hidden">
      <section className="flex min-h-[600px] min-w-0 flex-1 flex-col lg:min-h-0">
        <div className="relative min-h-0 flex-1 overflow-hidden">
          <CommandMap
            places={places}
            reading={reading}
            alarmed={alarmedCameras}
            trails={trails}
            selectedKey={selectedKey}
            onSelect={(place) => setSelectedKey(place?.key ?? null)}
          />

          {/* ── Look a vehicle up, and the two figures that matter ─────── */}
          <div className="pointer-events-none absolute left-4 top-4 flex w-[min(440px,calc(100%-2rem))] flex-col gap-2.5">
            {maySearch && <PlateSearch />}
            <div className="flex flex-wrap gap-2">
              {health === null ? (
                <>
                  <Skeleton className="h-9 w-48 rounded-full" />
                  <Skeleton className="h-9 w-36 rounded-full" />
                </>
              ) : (
                <>
                  <FleetChip health={health} />
                  <StatusChip
                    to={mayWatch ? '/anpr' : undefined}
                    tone={reading.size === 0 ? 'warn' : 'normal'}
                    dot={reading.size === 0 ? 'bg-priority-high' : 'bg-primary animate-pulse-alert'}
                    title="Cameras that read a plate in the last 10 minutes"
                  >
                    {reading.size} reading plates
                  </StatusChip>
                </>
              )}
            </div>
          </div>

          {error && (
            <div className="absolute inset-x-4 top-36 max-w-xl">
              <ErrorBanner>{error}</ErrorBanner>
            </div>
          )}

          {selected && (
            <PlaceCard
              place={selected}
              reading={reading}
              alarmed={alarmedCameras}
              mayWatch={mayWatch}
              onClose={() => setSelectedKey(null)}
            />
          )}

          <Legend trailWindow={trailWindow} />
        </div>

        <ReadingStrip
          reads={reads}
          byCode={byCode}
          watched={watched}
          live={status === 'live'}
          maySearch={maySearch}
          mayWatch={mayWatch}
        />
      </section>

      {maySeeAlerts && <AlarmDock alarms={alarms} byId={byId} now={now} />}
    </div>
  )
}

// ── Pieces ────────────────────────────────────────────────────────────

/** The one box a constable needs most: a plate in, its journey out. */
function PlateSearch() {
  const navigate = useNavigate()
  const [text, setText] = useState('')
  const plate = normalisePlateInput(text)
  const submit = (event: FormEvent) => {
    event.preventDefault()
    if (plate) navigate(`/vehicles?plate=${encodeURIComponent(plate)}`)
  }
  return (
    <form
      role="search"
      aria-label="Search vehicle"
      onSubmit={submit}
      className="pointer-events-auto flex h-11 items-center gap-2 rounded-lg border border-input bg-card pl-3 pr-1.5 shadow-lg"
    >
      <Icon name="search" size={17} className="text-muted-foreground" />
      <input
        value={text}
        onChange={(e) => setText(e.target.value)}
        aria-label="Plate number"
        placeholder="Search a plate, e.g. GJ01AB1234"
        autoComplete="off"
        spellCheck={false}
        className="h-full min-w-0 flex-1 bg-transparent font-mono text-[14px] uppercase tracking-wide outline-none placeholder:font-sans placeholder:normal-case placeholder:tracking-normal placeholder:text-faint"
      />
      <button
        type="submit"
        disabled={!plate}
        className="h-8 shrink-0 rounded-md bg-foreground px-3.5 text-[13px] font-medium text-background transition hover:bg-foreground/90 disabled:opacity-40"
      >
        Search
      </button>
    </form>
  )
}

function StatusChip({
  children,
  to,
  tone,
  dot,
  title,
}: {
  children: ReactNode
  to?: string
  tone: 'normal' | 'warn' | 'bad'
  dot: string
  title?: string
}) {
  const shell = `pointer-events-auto inline-flex h-9 items-center gap-2 rounded-full border px-3.5 text-[13px] shadow-lg transition ${
    tone === 'bad'
      ? 'border-priority-critical/50 bg-card text-priority-critical'
      : tone === 'warn'
        ? 'border-priority-high/50 bg-card text-priority-high'
        : 'border-border bg-card text-foreground'
  } ${to ? 'hover:border-muted-foreground/50' : ''}`
  const body = (
    <>
      <span className={`h-2 w-2 shrink-0 rounded-full ${dot}`} />
      {children}
      {to && <Icon name="arrowRight" size={13} className="text-faint" />}
    </>
  )
  return to ? (
    <Link to={to} title={title} className={shell}>
      {body}
    </Link>
  ) : (
    <span title={title} className={shell}>
      {body}
    </span>
  )
}

/** "32 of 32 cameras online" — and, honestly, how many of those are only the
 *  last state known while the grid refuses our session. */
function FleetChip({ health }: { health: FleetHealth }) {
  const share = health.total === 0 ? 0 : health.online / health.total
  const tone = health.total === 0 || share < 0.5 ? 'bad' : health.offline + health.degraded > 0 ? 'warn' : 'normal'
  const dot = tone === 'bad' ? 'bg-priority-critical' : tone === 'warn' ? 'bg-priority-high' : 'bg-primary'
  const stale = health.stale ?? 0
  return (
    <StatusChip
      to="/health"
      tone={tone}
      dot={dot}
      title="Camera status from the health monitor. Last known: the grid is refusing our session, so these keep their last confirmed state."
    >
      {health.online} of {health.total} cameras online
      {stale > 0 && <span className="text-faint">· {stale} last known</span>}
    </StatusChip>
  )
}

function Legend({ trailWindow }: { trailWindow: string | null | undefined }) {
  return (
    <div className="absolute bottom-4 left-4 flex max-w-[calc(100%-5rem)] flex-wrap items-center gap-x-4 gap-y-1.5 rounded-lg border border-border bg-card/95 px-3 py-2 text-xs text-muted-foreground shadow-lg">
      <span className="inline-flex items-center gap-1.5">
        <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
          <circle cx="7" cy="7" r="3" className="fill-place" />
        </svg>
        Camera
      </span>
      <span className="inline-flex items-center gap-1.5">
        <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
          <circle cx="7" cy="7" r="6" fill="none" className="stroke-primary" strokeWidth="1.5" />
          <circle cx="7" cy="7" r="3" className="fill-place" />
        </svg>
        Reading plates
      </span>
      <span className="inline-flex items-center gap-1.5">
        <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
          <circle cx="7" cy="7" r="6" fill="none" className="stroke-priority-critical" strokeWidth="1.5" />
          <circle cx="7" cy="7" r="3" className="fill-place" />
        </svg>
        Alarm
      </span>
      {trailWindow && (
        <span className="inline-flex items-center gap-1.5">
          <svg width="22" height="10" viewBox="0 0 22 10" aria-hidden="true">
            <path d="M1 8 Q 8 1 21 3" fill="none" className="stroke-primary" strokeWidth="2" strokeLinecap="round" />
          </svg>
          Vehicle journeys, {trailWindow}
        </span>
      )}
    </div>
  )
}

function PlaceCard({
  place,
  reading,
  alarmed,
  mayWatch,
  onClose,
}: {
  place: Place
  reading: Set<string>
  alarmed: Set<string>
  mayWatch: boolean
  onClose: () => void
}) {
  return (
    <div className="absolute right-4 top-4 z-10 flex max-h-[calc(100%-6rem)] w-80 flex-col overflow-hidden rounded-lg border border-input bg-popover shadow-2xl">
      <div className="flex items-start gap-3 border-b border-border px-3.5 py-3">
        <div className="min-w-0">
          <p className="truncate text-sm font-semibold">{place.name}</p>
          <p className="mt-0.5 text-xs text-faint">
            {place.cameras.length} camera{place.cameras.length === 1 ? '' : 's'}
            {' · '}
            {place.cameras.filter((c) => reading.has(c.camera_code)).length} reading plates
          </p>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close"
          className="ml-auto rounded p-1 text-muted-foreground transition hover:bg-secondary hover:text-foreground"
        >
          <Icon name="close" size={15} />
        </button>
      </div>
      <ul className="min-h-0 flex-1 divide-y divide-border overflow-y-auto">
        {place.cameras.map((camera) => (
          <li key={camera.id} className="flex items-center gap-2.5 px-3.5 py-2.5">
            <StatusDot status={camera.status} />
            <div className="min-w-0 flex-1">
              <p className="flex items-center gap-2 font-mono text-xs">
                {camera.camera_code}
                {reading.has(camera.camera_code) && (
                  <span className="rounded border border-primary/40 px-1 text-[10px] text-primary">
                    reading
                  </span>
                )}
                {alarmed.has(camera.id) && (
                  <span className="rounded border border-priority-critical/50 px-1 text-[10px] text-priority-critical">
                    alarm
                  </span>
                )}
              </p>
              <p className="truncate text-xs text-faint">
                {camera.junction || camera.name}
                {sourceKind(camera) === 'recorded' ? ' · recorded clip' : ''}
              </p>
            </div>
            <Link
              to={
                mayWatch
                  ? `/anpr?camera=${encodeURIComponent(camera.camera_code)}`
                  : `/cameras?camera=${encodeURIComponent(camera.camera_code)}`
              }
              className="shrink-0 rounded-md border border-input px-2.5 py-1.5 text-xs text-foreground transition hover:border-muted-foreground/60 hover:bg-secondary"
            >
              {mayWatch ? 'Watch' : 'Details'}
            </Link>
          </li>
        ))}
      </ul>
    </div>
  )
}

function ReadingStrip({
  reads,
  byCode,
  watched,
  live,
  maySearch,
  mayWatch,
}: {
  reads: Read[]
  byCode: Map<string, Camera>
  watched: Set<string>
  live: boolean
  maySearch: boolean
  mayWatch: boolean
}) {
  return (
    <section aria-label="Reading now" className="shrink-0 border-t border-border bg-chrome px-4 pb-3 pt-2.5">
      <div className="mb-2 flex items-center gap-2.5">
        <h2 className="text-[13px] font-semibold">Reading now</h2>
        <span
          className={`h-1.5 w-1.5 rounded-full ${live ? 'animate-pulse-alert bg-primary' : 'bg-priority-high'}`}
        />
        {!live && <span className="text-xs text-priority-high">reconnecting — showing recent reads</span>}
        {mayWatch && (
          <Link
            to="/anpr"
            className="ml-auto flex items-center gap-1 rounded-md px-2 py-1 text-xs text-muted-foreground transition hover:bg-secondary hover:text-foreground"
          >
            Watch live
            <Icon name="arrowRight" size={13} />
          </Link>
        )}
      </div>
      {reads.length === 0 ? (
        <p className="py-3 text-[13px] text-faint">
          No plates read yet. They appear here the moment a camera reads one.
        </p>
      ) : (
        <ul className="flex gap-2 overflow-x-auto pb-1 [mask-image:linear-gradient(to_right,black_92%,transparent)]">
          {reads.map((read, index) => {
            const camera = byCode.get(read.code.toLowerCase())
            const isWatched = watched.has(read.plate)
            const body = (
              <>
                <PlateChip plate={read.plate} size="sm" watched={isWatched} />
                <span className="min-w-0">
                  <span
                    className={`block truncate font-mono text-[11px] ${isWatched ? 'text-priority-critical' : 'text-foreground/80'}`}
                  >
                    {read.code}
                    {camera?.city ? ` · ${camera.city}` : ''}
                  </span>
                  <span className="block font-mono text-[11px] text-faint">
                    {api.formatIST(read.at, false)}
                    {read.confidence !== null ? ` · ${Math.round(read.confidence * 100)}%` : ''}
                  </span>
                </span>
              </>
            )
            const shell = `flex max-w-[19rem] shrink-0 items-center gap-2.5 rounded-lg border px-2.5 py-2 transition ${
              isWatched
                ? 'border-priority-critical/45 bg-priority-critical/[0.07]'
                : 'border-border bg-card hover:border-muted-foreground/40'
            } ${index === 0 ? 'animate-ticker-in' : ''}`
            return (
              <li key={read.key}>
                {maySearch ? (
                  <Link
                    to={`/vehicles?plate=${encodeURIComponent(read.plate)}`}
                    title={`Where ${read.plate} has been`}
                    className={shell}
                  >
                    {body}
                  </Link>
                ) : (
                  <div className={shell}>{body}</div>
                )}
              </li>
            )
          })}
        </ul>
      )}
    </section>
  )
}

function AlarmDock({
  alarms,
  byId,
  now,
}: {
  alarms: Alert[] | null
  byId: Map<string, Camera>
  now: number
}) {
  const count = alarms?.length ?? 0
  const critical = (alarms ?? []).some((a) => a.priority === 'critical')
  return (
    <aside
      aria-label="Alarms"
      className="flex min-h-[420px] w-full shrink-0 flex-col border-t border-border bg-chrome lg:min-h-0 lg:w-[360px] lg:border-l lg:border-t-0 2xl:w-[400px]"
    >
      <div className="flex items-center gap-2.5 border-b border-border px-4 py-3.5">
        <h2 className="text-[15px] font-semibold">Alarms</h2>
        {alarms !== null && (
          <span
            className={`inline-flex h-[20px] min-w-[20px] items-center justify-center rounded-full px-1.5 font-mono text-[11px] font-medium ${
              critical
                ? 'bg-priority-critical text-priority-critical-ink'
                : 'bg-secondary text-foreground'
            }`}
          >
            {count}
          </span>
        )}
        <Link
          to="/alerts"
          className="ml-auto flex items-center gap-1 rounded-md px-2 py-1 text-xs text-muted-foreground transition hover:bg-secondary hover:text-foreground"
        >
          All alarms
          <Icon name="arrowRight" size={13} />
        </Link>
      </div>

      <div className="min-h-0 flex-1 space-y-2 overflow-y-auto p-2.5">
        {alarms === null ? (
          <>
            <Skeleton className="h-20 w-full rounded-lg" />
            <Skeleton className="h-20 w-full rounded-lg" />
          </>
        ) : alarms.length === 0 ? (
          <div className="flex flex-col items-center gap-2 px-6 py-12 text-center">
            <span className="grid h-10 w-10 place-items-center rounded-full border border-border text-faint">
              <Icon name="check" size={18} />
            </span>
            <p className="text-[14px] font-medium">No open alarms</p>
            <p className="text-xs text-faint">
              Put a plate on the watchlist — any camera that reads it raises an alarm here.
            </p>
          </div>
        ) : (
          alarms.map((alarm) => (
            <AlarmCard
              key={alarm.id}
              alarm={alarm}
              camera={alarm.camera_id ? byId.get(alarm.camera_id) : undefined}
              now={now}
            />
          ))
        )}
      </div>
    </aside>
  )
}

/** Notes can end in a machine reference — `[vms:a3d4…]` — that is useful in
 *  the record and noise on a card. */
function plainDetail(text: string | null | undefined): string | null {
  const cleaned = text?.replace(/\s*\[[a-z_]+:[^\]]+\]/gi, '').trim()
  return cleaned ? cleaned : null
}

function AlarmCard({ alarm, camera, now }: { alarm: Alert; camera: Camera | undefined; now: number }) {
  const isCritical = alarm.priority === 'critical'
  // A plate says what the alarm is about; without one, the first line of why.
  const detail = alarm.plate_normalised
    ? null
    : plainDetail(alarm.reasons?.[0]?.detail ?? alarm.notes?.split('\n').find((line) => line.trim()))
  const where = camera ? [camera.camera_code, camera.junction || camera.name].filter(Boolean).join(' · ') : null
  return (
    <Link
      to={`/alerts?alert=${encodeURIComponent(alarm.id)}`}
      className={`block rounded-lg border px-3.5 py-3 transition ${
        isCritical
          ? 'border-priority-critical/45 bg-priority-critical/[0.07] hover:bg-priority-critical/[0.11]'
          : 'border-border bg-card hover:border-muted-foreground/40'
      }`}
    >
      <span className="flex items-center gap-2">
        <PriorityBadge priority={alarm.priority} solid />
        <span className="truncate text-[13px] font-semibold">{alarmTitle(alarm)}</span>
        <span
          className={`ml-auto shrink-0 font-mono text-[11px] ${isCritical ? 'text-priority-critical' : 'text-faint'}`}
        >
          {ageOf(alarm.created_at, now)}
        </span>
      </span>
      {alarm.plate_normalised && (
        <span className="mt-2.5 flex items-center gap-2">
          <PlateChip
            plate={alarm.plate_normalised}
            size="md"
            watched={alarm.alert_type === 'watchlist_hit'}
          />
        </span>
      )}
      {detail && <span className="mt-1.5 line-clamp-2 text-xs text-muted-foreground">{detail}</span>}
      {where && <span className="mt-2 block truncate font-mono text-[11px] text-faint">{where}</span>}
    </Link>
  )
}
