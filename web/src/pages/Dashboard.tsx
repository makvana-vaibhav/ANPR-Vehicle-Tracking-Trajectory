/**
 * Command: the whole network, now.
 *
 * What an operator needs in the first two seconds of a shift — is the network
 * up, is anything demanding a person, is the pipeline actually reading — and
 * the one thing a list of counters never shows: *where*. So the screen is a
 * map, with the counters laid over it, the alarms docked beside it, and the
 * plates arriving along the bottom as they are read.
 *
 * ## Decisions worth stating
 *
 * **Every number says what it counts.** "Reading plates: 4" is the cameras
 * that read at least one plate in the last ten minutes, counted from the
 * detections table in five-minute buckets — not the number configured to,
 * which would look the same with the pipeline stopped.
 *
 * **Something on screen is always visibly live.** Counters are historical and
 * keep their values when the pipeline dies. The ripples on the map and the
 * strip of plates along the bottom are not: they move when plates are read
 * and stop when they are not.
 *
 * **The page does not scroll** on a wall-sized screen. The alarm list and the
 * plate strip scroll inside themselves so the layout holds still.
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'

import CommandMap, { type Trail } from '@/components/CommandMap'
import { sourceKind } from '@/components/network/cameraFacts'
import { Skeleton } from '@/components/Skeleton'
import {
  ErrorBanner,
  Icon,
  InfoHint,
  PlateChip,
  PriorityBadge,
  StatTile,
  StatusDot,
} from '@/components/ui'
import { useAuth } from '@/hooks/useAuth'
import { useEventStream } from '@/hooks/useEventStream'
import * as api from '@/lib/api'
import { alarmKind, alarmTitle, type AlarmKind } from '@/lib/alarms'
import { liveTrackKey } from '@/lib/events'
import { PERMISSIONS } from '@/lib/permissions'
import { groupPlaces, shortCode, type Place } from '@/lib/places'
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
function ageOf(iso: string, now: number): string {
  const s = Math.max(0, (now - new Date(iso).getTime()) / 1000)
  if (s < 60) return `${Math.floor(s)} s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m} min`
  const h = Math.floor(m / 60)
  if (h < 24) return m % 60 ? `${h} h ${m % 60} min` : `${h} h`
  return `${Math.floor(h / 24)} d`
}

// ── Alarm kinds — the same words the Alarms screen uses ───────────────

type Kind = 'all' | AlarmKind

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
  const [platesFallback, setPlatesFallback] = useState<number | null>(null)
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
      setFlow(await api.getAnalyticsFlow({ since, bucket: '5m', group_by: 'camera' }))
    } catch {
      // A role without analytics still gets the headline count, from the
      // detections table directly.
      setFlow(null)
      try {
        setPlatesFallback((await api.getDetections({ since, readable_only: true, limit: 1 })).total)
      } catch {
        setPlatesFallback(null)
      }
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
      setAlarms((await api.getAlerts({ open_only: true, sort: 'priority', limit: 50 })).items)
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
  const { places, unplaced } = useMemo(() => groupPlaces(cameras ?? []), [cameras])
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

  const readingList = useMemo(
    () => [...reading].sort((a, b) => a.localeCompare(b)),
    [reading],
  )

  const activity = useMemo(() => {
    if (!flow) return null
    const width = flow.window.bucket_seconds * 1000
    const start = new Date(flow.window.start).getTime()
    const end = new Date(flow.window.end).getTime()
    const n = Math.max(1, Math.ceil((end - start) / width))
    const buckets = new Array<number>(n).fill(0)
    let plates = 0
    for (const series of flow.series) {
      for (const point of series.points) {
        plates += point.with_plate
        const index = Math.floor((new Date(point.ts).getTime() - start) / width)
        if (index >= 0 && index < n) buckets[index] = (buckets[index] ?? 0) + point.with_plate
      }
    }
    return { plates, vehicles: flow.total_vehicles, buckets }
  }, [flow])

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

  // The same reading of "where the pictures come from" as the Network
  // screens: the demo camera's clip is configured in the simulator, so its
  // tags, not `source_file`, are what say it is recorded.
  const recorded = (cameras ?? []).filter((c) => sourceKind(c) === 'recorded').length
  const grid = (cameras ?? []).filter((c) => sourceKind(c) === 'grid').length
  const openCount = alarms?.length ?? 0
  const critical = (alarms ?? []).filter((a) => a.priority === 'critical')
  const newestCritical = critical.reduce<string | null>(
    (newest, a) => (newest === null || a.created_at > newest ? a.created_at : newest),
    null,
  )

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

          {/* ── The counters, over the map ─────────────────────────── */}
          <div className="pointer-events-none absolute inset-x-4 top-4 flex flex-wrap items-start gap-2">
            {health === null ? (
              <>
                <TileSkeleton />
                <TileSkeleton />
                <TileSkeleton />
              </>
            ) : (
              <>
                <StatTile
                  className="pointer-events-auto min-w-[150px]"
                  label="Feeds answering"
                  value={
                    <>
                      {health.online}
                      <span className="text-base text-faint"> / {health.total}</span>
                    </>
                  }
                  detail={
                    health.unknown > 0
                      ? `${health.unknown} state unknown`
                      : `${grid} grid · ${recorded} recorded`
                  }
                  info="Cameras whose last health probe answered, of every camera registered. A camera not probed yet, or behind a grid that is refusing us, is counted as not known rather than as down."
                  tone={
                    health.total === 0 || health.online / health.total < 0.5
                      ? 'bad'
                      : health.offline + health.degraded > 0
                        ? 'warn'
                        : undefined
                  }
                  to="/health"
                />
                <StatTile
                  className="pointer-events-auto min-w-[180px] max-w-[260px]"
                  label="Reading plates"
                  value={String(reading.size)}
                  detail={
                    readingList.length > 0 ? (
                      <span className="font-mono text-[11px]">
                        {readingList.map(shortCode).join(' · ')}
                      </span>
                    ) : (
                      'no plate read in 10 min'
                    )
                  }
                  info="Cameras that read at least one plate in the last ten minutes, from the record and the live feed. Plates are read continuously on a short list of cameras, and on any camera opened in Live."
                  tone={reading.size === 0 ? 'warn' : undefined}
                  to={mayWatch ? '/anpr' : undefined}
                />
                <StatTile
                  className="pointer-events-auto min-w-[200px]"
                  label="Plates read · last hour"
                  value={
                    activity
                      ? activity.plates.toLocaleString('en-IN')
                      : platesFallback === null
                        ? '—'
                        : platesFallback.toLocaleString('en-IN')
                  }
                  aside={activity && <Sparkline values={activity.buckets} />}
                  detail={
                    activity
                      ? `of ${activity.vehicles.toLocaleString('en-IN')} vehicles seen`
                      : undefined
                  }
                  info="Readable plates settled by the pipeline in the last hour, in five-minute steps — the line is plates per five minutes, the newest step still filling. Most come from the recorded demo camera, which replays a busy road continuously."
                />
                {maySeeAlerts && (
                  <StatTile
                    className="pointer-events-auto min-w-[150px]"
                    label="Open alarms"
                    value={alarms === null ? '—' : String(openCount)}
                    detail={
                      critical.length > 0 && newestCritical
                        ? `${critical.length} critical · ${ageOf(newestCritical, now)} old`
                        : openCount > 0
                          ? 'none critical'
                          : 'nothing open'
                    }
                    tone={critical.length > 0 ? 'bad' : openCount > 0 ? 'warn' : undefined}
                    to="/alerts"
                  />
                )}
              </>
            )}
            <IstClock />
          </div>

          {error && (
            <div className="absolute inset-x-4 top-32 max-w-xl">
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

          <Legend trailWindow={trailWindow} unplaced={unplaced.length} />
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

      {maySeeAlerts && (
        <AlarmDock
          alarms={alarms}
          byId={byId}
          now={now}
          readingCount={reading.size}
          cameraCount={cameras?.length ?? null}
        />
      )}
    </div>
  )
}

// ── Pieces ────────────────────────────────────────────────────────────

function TileSkeleton() {
  return (
    <div className="pointer-events-auto w-[170px] rounded-lg border border-border bg-card px-3.5 py-3">
      <Skeleton className="h-2.5 w-24" />
      <Skeleton className="mt-2.5 h-6 w-14" />
      <Skeleton className="mt-2 h-2.5 w-20" />
    </div>
  )
}

/** The wall clock, in IST. A control room reads every time on screen against
 *  it, so it sits with the counters rather than in a corner — on a screen wide
 *  enough to hold both on one row. */
function IstClock() {
  const now = useNow(1_000)
  const date = new Date(now)
  const day = new Intl.DateTimeFormat('en-IN', {
    timeZone: 'Asia/Kolkata',
    weekday: 'short',
    day: 'numeric',
    month: 'short',
  }).format(date)
  return (
    <div className="pointer-events-auto ml-auto hidden rounded-lg border border-border bg-card px-3 py-2 text-right min-[1380px]:block">
      <p className="font-mono text-[15px] font-medium leading-none tracking-tight">
        {api.formatIST(date.toISOString(), false)}
        <span className="ml-1.5 text-[11px] text-faint">IST</span>
      </p>
      <p className="mt-1 text-[11px] text-faint">{day}</p>
    </div>
  )
}

/** Plates per five minutes across the last hour, as one thin line. */
function Sparkline({ values }: { values: number[] }) {
  const W = 84
  const H = 24
  if (values.length < 2) return null
  const max = Math.max(1, ...values)
  const step = W / (values.length - 1)
  const points = values
    .map((v, i) => `${(i * step).toFixed(1)},${(H - 2 - (v / max) * (H - 4)).toFixed(1)}`)
    .join(' ')
  return (
    <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} aria-hidden="true" className="mb-0.5 text-primary">
      <polyline
        points={points}
        fill="none"
        stroke="currentColor"
        strokeWidth={1.6}
        strokeLinejoin="round"
        strokeLinecap="round"
      />
    </svg>
  )
}

function Legend({
  trailWindow,
  unplaced,
}: {
  trailWindow: string | null | undefined
  unplaced: number
}) {
  return (
    <div className="absolute bottom-4 left-4 flex max-w-[calc(100%-5rem)] flex-wrap items-center gap-x-3.5 gap-y-1.5 rounded-lg border border-border bg-card/95 px-3 py-2 text-xs text-muted-foreground">
      <span className="inline-flex items-center gap-1.5">
        <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
          <circle cx="7" cy="7" r="6" fill="none" className="stroke-primary" strokeWidth="1.5" />
          <circle cx="7" cy="7" r="3" className="fill-place" />
        </svg>
        Reading plates
      </span>
      <span className="inline-flex items-center gap-1.5">
        <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
          <circle cx="7" cy="7" r="3" className="fill-place" />
        </svg>
        Cameras
      </span>
      <span className="inline-flex items-center gap-1.5">
        <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
          <circle cx="7" cy="7" r="6" fill="none" className="stroke-priority-critical" strokeWidth="1.5" />
          <circle cx="7" cy="7" r="3" className="fill-place" />
        </svg>
        Alarm
      </span>
      <span className="inline-flex items-center gap-1.5">
        <svg width="22" height="10" viewBox="0 0 22 10" aria-hidden="true">
          <defs>
            <linearGradient id="legend-trail" x1="0" x2="1" y1="0" y2="0">
              <stop offset="0" stopColor="#5CC8FF" stopOpacity="0" />
              <stop offset="1" stopColor="#5CC8FF" stopOpacity="1" />
            </linearGradient>
          </defs>
          <path d="M1 8 Q 8 1 21 3" fill="none" stroke="url(#legend-trail)" strokeWidth="2" strokeLinecap="round" />
        </svg>
        {trailWindow === undefined
          ? 'Journeys'
          : trailWindow
            ? `Journeys, ${trailWindow}`
            : 'No vehicle seen at two cameras in 24 h'}
      </span>
      {unplaced > 0 && (
        <Link
          to="/cameras?filter=unplaced"
          className="inline-flex items-center gap-1.5 border-l border-border pl-3 text-priority-high hover:underline"
        >
          <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
            <circle cx="7" cy="7" r="5.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeDasharray="2 2" />
          </svg>
          {unplaced} camera{unplaced === 1 ? '' : 's'} without a position
        </Link>
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
    <div className="absolute right-4 top-[5.5rem] z-10 flex max-h-[calc(100%-11rem)] w-80 flex-col overflow-hidden rounded-lg border border-input bg-popover shadow-2xl">
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
          <li key={camera.id} className="flex items-center gap-2.5 px-3.5 py-2">
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
              className="shrink-0 rounded-md border border-input px-2 py-1 text-[11px] text-muted-foreground transition hover:border-muted-foreground/60 hover:text-foreground"
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
        <span className="eyebrow">Reading now</span>
        <span
          className={`h-1.5 w-1.5 rounded-full ${live ? 'animate-pulse-alert bg-primary' : 'bg-priority-high'}`}
        />
        <span className="text-xs text-faint">
          {live ? 'newest first, as they are read' : 'live feed reconnecting — showing the record'}
        </span>
        <InfoHint>
          Each plate once, when the pipeline settles it — the same reading that is written to the
          record. A plate on the watchlist is ringed in red.
        </InfoHint>
        {mayWatch && (
          <Link
            to="/anpr"
            className="ml-auto flex items-center gap-1 text-xs text-muted-foreground transition hover:text-foreground"
          >
            Open Live
            <Icon name="arrowRight" size={13} />
          </Link>
        )}
      </div>
      {reads.length === 0 ? (
        <p className="py-3 text-[13px] text-faint">
          Nothing read yet. Plates appear here the moment a camera reads one.
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
                    {read.confidence !== null ? ` · read ${read.confidence.toFixed(2)}` : ''}
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
                    title={`Every sighting of ${read.plate}`}
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
  readingCount,
  cameraCount,
}: {
  alarms: Alert[] | null
  byId: Map<string, Camera>
  now: number
  readingCount: number
  cameraCount: number | null
}) {
  const [kind, setKind] = useState<Kind>('all')
  const counts = useMemo(() => {
    const c: Record<Kind, number> = { all: 0, watchlist: 0, journey: 0, camera: 0, other: 0 }
    for (const a of alarms ?? []) {
      c.all += 1
      c[alarmKind(a.alert_type)] += 1
    }
    return c
  }, [alarms])
  const shown = (alarms ?? []).filter((a) => kind === 'all' || alarmKind(a.alert_type) === kind)
  // "Other" only when something is in it: an empty chip for a kind that
  // rarely exists is noise on a screen this small.
  const kinds: [Kind, string][] = [
    ['all', 'All'],
    ['watchlist', 'Watchlist'],
    ['journey', 'Journeys'],
    ['camera', 'Cameras'],
    ...(counts.other > 0 ? ([['other', 'Other']] as [Kind, string][]) : []),
  ]

  return (
    <aside
      aria-label="Alarms"
      className="flex min-h-[420px] w-full shrink-0 flex-col border-t border-border bg-chrome lg:min-h-0 lg:w-[360px] lg:border-l lg:border-t-0 2xl:w-[400px]"
    >
      <div className="flex items-baseline gap-2.5 px-4 pb-3 pt-4">
        <h2 className="text-[15px] font-semibold">Alarms</h2>
        <span className="text-xs text-faint">
          {alarms === null ? 'loading' : `${counts.all} open · most severe first`}
        </span>
        <Link
          to="/alerts"
          className="ml-auto flex items-center gap-1 text-xs text-muted-foreground transition hover:text-foreground"
        >
          Triage
          <Icon name="arrowRight" size={13} />
        </Link>
      </div>

      <div role="tablist" aria-label="Alarm kinds" className="flex flex-wrap gap-1.5 border-b border-border px-4 pb-3">
        {kinds.map(([value, label]) => {
          const active = kind === value
          return (
            <button
              key={value}
              type="button"
              role="tab"
              aria-selected={active}
              onClick={() => setKind(value)}
              className={`h-7 rounded-md border px-2.5 text-xs transition ${
                active
                  ? 'border-input bg-secondary text-foreground'
                  : 'border-border text-muted-foreground hover:text-foreground'
              }`}
            >
              {label} <span className="font-mono text-faint">{counts[value]}</span>
            </button>
          )
        })}
      </div>

      <div className="min-h-0 flex-1 space-y-2 overflow-y-auto p-2.5">
        {alarms === null ? (
          <>
            <Skeleton className="h-24 w-full rounded-lg" />
            <Skeleton className="h-24 w-full rounded-lg" />
          </>
        ) : shown.length === 0 ? (
          <div className="flex flex-col items-center gap-2 px-6 py-10 text-center">
            <span className="grid h-9 w-9 place-items-center rounded-full border border-border text-faint">
              <Icon name="check" size={17} />
            </span>
            <p className="text-[13px] text-muted-foreground">
              {kind === 'all' ? 'Nothing open.' : 'Nothing open of this kind.'}
            </p>
            <p className="text-xs text-faint">
              A watched plate passing any camera raises an alarm here by itself.
            </p>
          </div>
        ) : (
          shown.map((alarm) => <AlarmCard key={alarm.id} alarm={alarm} camera={alarm.camera_id ? byId.get(alarm.camera_id) : undefined} now={now} />)
        )}
      </div>

      {cameraCount !== null && cameraCount > 0 && (
        <div className="m-2.5 mt-0 rounded-lg border border-border bg-background px-3 py-2.5 text-xs leading-relaxed text-muted-foreground">
          <p className="mb-0.5 font-medium text-foreground">What is being read</p>
          Plates are being read on {readingCount} of {cameraCount} cameras right now, and on any
          camera opened in Live within a few seconds. The rest stream without plate reading.
        </div>
      )}
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
  const detail = plainDetail(
    alarm.reasons?.[0]?.detail ?? alarm.notes?.split('\n').find((line) => line.trim()),
  )
  const where = camera
    ? [camera.camera_code, camera.junction || camera.name, camera.city].filter(Boolean).join(' · ')
    : null
  return (
    <Link
      to={`/alerts?alert=${encodeURIComponent(alarm.id)}`}
      className={`block rounded-lg border px-3 py-2.5 transition ${
        isCritical
          ? 'border-priority-critical/45 bg-priority-critical/[0.07] hover:bg-priority-critical/[0.11]'
          : 'border-border bg-card hover:border-muted-foreground/40'
      }`}
    >
      <span className="flex items-center gap-2">
        <PriorityBadge priority={alarm.priority} solid />
        <span className="truncate text-[13px] font-semibold">
          {alarmTitle(alarm)}
        </span>
        <span
          className={`ml-auto shrink-0 font-mono text-[11px] ${isCritical ? 'text-priority-critical' : 'text-faint'}`}
        >
          {ageOf(alarm.created_at, now)}
        </span>
      </span>
      {alarm.plate_normalised && (
        <span className="mt-2 flex items-center gap-2">
          <PlateChip
            plate={alarm.plate_normalised}
            size="sm"
            watched={alarm.alert_type === 'watchlist_hit'}
          />
          {alarm.confidence !== null && (
            <span className="font-mono text-[11px] text-faint">read {alarm.confidence.toFixed(2)}</span>
          )}
        </span>
      )}
      {detail && <span className="mt-1.5 line-clamp-2 block text-xs text-muted-foreground">{detail}</span>}
      {where && <span className="mt-1.5 block truncate font-mono text-[11px] text-faint">{where}</span>}
    </Link>
  )
}
