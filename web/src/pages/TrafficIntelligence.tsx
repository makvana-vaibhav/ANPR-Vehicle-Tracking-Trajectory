/**
 * Traffic Intelligence — the city-wide half of the PS.
 *
 * This page was `Analytics.tsx` and absorbed the traffic feature rather than
 * sitting beside it. Flow, speed, route density, travel time, hotspots and
 * the congestion forecast all describe the same roads as the counts, density,
 * queues and obstructions added here; two pages would have shown the same
 * corridor twice and let the two disagree.
 *
 * ## The rule this page cannot break
 *
 * Every figure on this screen is computed from observed rows on the server
 * (`app/routers/analytics.py`, `app/routers/predictions.py`) and carries the
 * evidence it was computed from. This page's only job is to render that
 * honestly:
 *
 * - A `status` of `insufficient_data` or `insufficient_history` is rendered
 *   as exactly that — never as a zero, never as a chart bar that looks like
 *   a real measurement sitting at nought. Each such state says what is
 *   missing and what would produce the figure.
 * - The demo fleet replays recorded clips, so the speed endpoint usually
 *   excludes every leg as implausible (a clip loop makes the gap between two
 *   cameras seconds, not minutes, which is hundreds of km/h over real
 *   distance). That is shown, with the counts, not hidden.
 * - Density is **vehicles in a camera's view**, not vehicles per kilometre.
 *   No camera here is calibrated, so there is no honest conversion.
 * - A stopped vehicle is a **possible obstruction** and never an accident.
 *   The system sees that a vehicle has not moved; it cannot see whether that
 *   is a breakdown, a delivery or a driver reading a map.
 * - A forecast is shown with **every** contributing factor the API gave and
 *   with its own backtested error. A prediction with no error bar is
 *   decoration, and one with half its reasons is half an explanation.
 * - The traffic endpoint reads a bounded number of rows, newest first, and
 *   says when the window held more (`truncated`, `rows_read`, `rows_total`).
 *   It once read oldest first and said nothing, so its total was the cap —
 *   "20,000 vehicles" over a window that held 27,000. The total shown is the
 *   server's count of the whole window, and every panel built on the bounded
 *   read says it covers the latest part of the window, not all of it.
 *
 * The caveats sit behind the `ⓘ` beside each title, and the panels are
 * grouped into four tabs so each is one screenful.
 *
 * ## Time is drawn as time
 *
 * The API returns only buckets that have rows in them. Drawn on a category
 * axis, 13:05 and 13:30 sat side by side as if five minutes apart, with a
 * slope drawn between them through twenty-five minutes in which nothing was
 * observed. The trend charts now plot on a real time axis across the whole
 * window and break the line where buckets are missing.
 *
 * ## The view is in the URL
 *
 * Tab, window and corridor live in the query string, so "the forecast for
 * Ashram Road over the last six hours" is a link that can be handed over.
 */

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  LabelList,
  ReferenceArea,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'

import { SkeletonRows, SkeletonStat } from '@/components/Skeleton'
import type { BadgeTone, IconName } from '@/components/ui'
import {
  Badge,
  Button,
  ErrorBanner,
  Icon,
  InfoHint,
  PageHeader,
  Panel,
  PanelHeader,
  PlateChip,
  Select,
  SegmentedControl,
  SeverityGlyph,
  StatTile,
  Table,
  Tabs,
  Td,
  Th,
  Thead,
  Toolbar,
  ToolbarField,
  Tr,
} from '@/components/ui'
import { useAuth } from '@/hooks/useAuth'
import * as api from '@/lib/api'
import { PERMISSIONS } from '@/lib/permissions'
import {
  DAY,
  factorLabel,
  forecastGeometry,
  HOUR,
  istTicks,
  MINUTE,
  quietLeadIn,
  trafficSample,
  withGaps,
  type TimeFlags,
} from '@/pages/trafficSeries'
import type {
  CongestionLevel,
  CongestionResponse,
  CongestionSeries,
  FlowResponse,
  HotspotResponse,
  Priority,
  RouteDensityResponse,
  SpeedResponse,
  TrafficFactor,
  TrafficHistoryResponse,
  TrafficResponse,
  TrafficZone,
  TravelTimeResponse,
} from '@/lib/types'

// ── Time ─────────────────────────────────────────────────────────────────

const WINDOWS = [
  { value: '1', label: '1 h', hours: 1, bucket: '5m' },
  { value: '6', label: '6 h', hours: 6, bucket: '15m' },
  { value: '24', label: '24 h', hours: 24, bucket: '1h' },
  { value: '168', label: '7 d', hours: 168, bucket: '1d' },
] as const

const DEFAULT_HOURS = 24

type TabKey = 'overview' | 'roads' | 'journeys' | 'forecast'
const TAB_KEYS: readonly TabKey[] = ['overview', 'roads', 'journeys', 'forecast']

const IST_CLOCK = new Intl.DateTimeFormat('en-IN', {
  timeZone: 'Asia/Kolkata',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
})
const IST_DAY = new Intl.DateTimeFormat('en-IN', {
  timeZone: 'Asia/Kolkata',
  day: '2-digit',
  month: 'short',
})
const IST_STAMP = new Intl.DateTimeFormat('en-IN', {
  timeZone: 'Asia/Kolkata',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23',
})

/** Spans longer than this are labelled by day rather than by clock time. */
const DAY_LABEL_SPAN = 30 * HOUR

/** Tick spacing for a span: about six to eight ticks, on round IST times. */
function tickStep(spanMs: number): number {
  if (spanMs <= 1.5 * HOUR) return 10 * MINUTE
  if (spanMs <= 8 * HOUR) return HOUR
  if (spanMs <= DAY_LABEL_SPAN) return 3 * HOUR
  return DAY
}

/**
 * The time axis for a response, from that response's own window — not from
 * the window selected. While a new window loads, the previous chart stays on
 * screen, and its axis has to keep describing the data it is drawing.
 */
function timeAxis(window: { start: string; end: string }) {
  const start = Date.parse(window.start)
  const end = Date.parse(window.end)
  const span = end - start
  return {
    start,
    end,
    span,
    props: {
      dataKey: 't',
      type: 'number' as const,
      scale: 'time' as const,
      domain: [start, end] as [number, number],
      allowDataOverflow: true,
      ticks: istTicks(start, end, tickStep(span)),
      tickFormatter: (v: number) =>
        span > DAY_LABEL_SPAN ? IST_DAY.format(v) : IST_CLOCK.format(v),
    },
  }
}

function leadInLabel(ms: number, spanMs: number): string {
  const at =
    spanMs > DAY_LABEL_SPAN ? `${IST_DAY.format(ms)}, ${IST_CLOCK.format(ms)}` : IST_CLOCK.format(ms)
  return `No detections before ${at} IST`
}

/** The span a bucket covers, for a tooltip heading: "11 Oct, 23:45–23:50 IST". */
function bucketLabel(ms: number, bucketMs: number): string {
  if (bucketMs >= DAY) return `${IST_DAY.format(ms)} IST`
  return `${IST_DAY.format(ms)}, ${IST_CLOCK.format(ms)}–${IST_CLOCK.format(ms + bucketMs)} IST`
}

function seconds(value: number | null): string {
  if (value === null) return '—'
  if (value < 60) return `${Math.round(value)}s`
  return `${Math.round(value / 60)} min`
}

/** 21400 → "21.4k". Keeps a five-figure count inside the gutter. */
function compact(value: number): string {
  if (Math.abs(value) >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`
  if (Math.abs(value) >= 1_000) return `${(value / 1_000).toFixed(1)}k`
  return String(value)
}

/** A share, with a decimal only where whole percent would round it to zero. */
function share(pct: number): string {
  if (pct === 0) return '0%'
  if (pct < 1) return `${pct.toFixed(1)}%`
  return `${Math.round(pct)}%`
}

// ── Chart chrome ─────────────────────────────────────────────────────────

/**
 * Chart series colours, in fixed slot order.
 *
 * These were `--status-online` and `--priority-high` — so a corridor was drawn
 * in the colour that means "camera healthy" and "needs attention" on every
 * other screen, which is a claim the chart is not making. They were also
 * cycled with `% 4`, which silently gave two corridors the same colour once
 * there were five; this fleet sits on twelve.
 *
 * Four is the cap this palette validates for (re-checked against the panel
 * surface, #0F151C: worst adjacent colour-vision separation ΔE 8.4, every
 * slot above 3:1), so a fifth corridor and beyond fold into one neutral band
 * rather than repeating a hue. Two corridors sharing a colour is worse than
 * not naming them individually.
 */
const SERIES_COLORS = [
  'hsl(var(--chart-1))',
  'hsl(var(--chart-2))',
  'hsl(var(--chart-3))',
  'hsl(var(--chart-4))',
] as const
const OTHER_COLOR = 'hsl(var(--chart-other))'
const OTHER_KEY = 'Other corridors'
/** Series drawn individually before the rest fold into `OTHER_KEY`. */
const MAX_SERIES = SERIES_COLORS.length

function seriesColor(slot: number): string {
  return SERIES_COLORS[slot] ?? OTHER_COLOR
}

/** Recharts takes colours as props, not classes, so the chrome is named here
 *  once — every one a theme token, never a literal. */
const GRID = 'hsl(var(--border))'
/** The hairline of surface between stacked fills, and the ring round a
 *  marker, so touching marks stay legible as separate marks. */
const SURFACE = 'hsl(var(--card))'
const CURSOR = { stroke: 'hsl(var(--input))', strokeWidth: 1 }
const TICK = { fontSize: 11, fill: 'hsl(var(--faint))', fontFamily: "'IBM Plex Mono', monospace" }
const ACTIVE_DOT = { r: 4, strokeWidth: 2, stroke: SURFACE }

/**
 * Chart margins and axis width.
 *
 * The left margin used to be -20 with a 36px axis, which pulled five-figure
 * counts off the left edge — "20,000" rendered as "i0". Vehicle counts here
 * run into tens of thousands, so the axis gets the room it needs and the
 * labels are abbreviated rather than truncated.
 */
const CHART_MARGIN = { left: 4, right: 12, top: 8, bottom: 0 }
const Y_AXIS_WIDTH = 44

/** A dot for a bucket with no neighbour to draw a line to — see `withGaps`. */
function isolatedDot(color: string) {
  return function IsolatedDot(props: {
    cx?: number
    cy?: number
    index?: number
    payload?: TimeFlags
    value?: unknown
  }) {
    const { cx, cy, index, payload, value } = props
    if (!payload?.isolated || cx === undefined || cy === undefined || value === null) {
      return <g key={index} />
    }
    return (
      <circle key={index} cx={cx} cy={cy} r={2.5} fill={color} stroke={SURFACE} strokeWidth={1.5} />
    )
  }
}

/**
 * The stretch of the window before anything was observed, said in words.
 *
 * Called as a function, not rendered as `<LeadIn />`: Recharts 2 lays out
 * only the child types it knows, so a wrapper component placed inside a chart
 * is skipped without a warning. The `ReferenceArea` has to be the child.
 */
function leadInArea(
  rows: readonly (TimeFlags & { t: number })[],
  start: number,
  end: number,
) {
  const until = quietLeadIn(rows, start, end)
  if (until === null) return null
  return (
    <ReferenceArea
      x1={start}
      x2={until}
      fill="hsl(var(--secondary))"
      fillOpacity={0.28}
      stroke="none"
      ifOverflow="hidden"
      label={{
        value: leadInLabel(until, end - start),
        position: 'center',
        fill: 'hsl(var(--faint))',
        fontSize: 11,
      }}
    />
  )
}

// ── Congestion and its reasons ───────────────────────────────────────────

/**
 * Congestion level → badge. Grey when normal, colour when a person may be
 * needed: free and moderate traffic are the road working, heavy and severe
 * are where somebody might act. Severity always carries its shape and its
 * word with the colour, the same as an alarm.
 */
const CONGESTION: Record<CongestionLevel, { tone: BadgeTone; glyph?: Priority }> = {
  free: { tone: 'neutral' },
  moderate: { tone: 'neutral' },
  heavy: { tone: 'warning', glyph: 'high' },
  severe: { tone: 'danger', glyph: 'critical' },
}

function CongestionBadge({ zone }: { zone: TrafficZone }) {
  if (!zone.congestion) {
    return (
      <Badge tone="neutral" title="No occupancy, speed or travel-time figure for this window">
        no data
      </Badge>
    )
  }
  const level = CONGESTION[zone.congestion]
  return (
    <Badge
      tone={level.tone}
      title={
        zone.congestion_score !== null
          ? `Score ${zone.congestion_score.toFixed(2)} of 1`
          : undefined
      }
    >
      {level.glyph && <SeverityGlyph priority={level.glyph} size={8} />}
      {zone.congestion}
    </Badge>
  )
}

function FactorList({ factors }: { factors: TrafficFactor[] }) {
  if (factors.length === 0) return null
  return (
    <ul className="mt-1 space-y-0.5">
      {factors.map((f) => (
        <li key={`${f.factor}:${f.detail}`} className="text-[11px] leading-snug text-faint">
          <span className="text-muted-foreground">{factorLabel(f.factor)}</span> · {f.detail}
        </li>
      ))}
    </ul>
  )
}

// ── Forecast copy ────────────────────────────────────────────────────────

/** Mirrors `predictions.py` — used only to say what a forecast is waiting
 *  for. The server decides; these words describe its decision. */
const BASELINE_DAYS_NEEDED = 3
const BASELINE_WINDOW_DAYS = 7
const TREND_POINTS_NEEDED = 3
const FORECAST_LOOKBACK_MIN = 90

/** UI thresholds for the "now" badge on a forecast card: how far above its
 *  own typical a camera has to be before the badge takes a colour. */
const INDEX_WARN = 110
const INDEX_CRITICAL = 150

function waitingReason(series: CongestionSeries): string {
  if (series.status === 'insufficient_history') {
    return `No baseline — this hour of day not yet seen on ${BASELINE_DAYS_NEEDED} of the previous ${BASELINE_WINDOW_DAYS} days`
  }
  if (series.current_index_pct !== null) {
    return `Too few recent buckets to fit a trend (needs ${TREND_POINTS_NEEDED} with a baseline)`
  }
  return `No baseline for the hours in the last ${FORECAST_LOOKBACK_MIN} minutes`
}

// ── The page ─────────────────────────────────────────────────────────────

function parseTab(value: string | null): TabKey {
  return TAB_KEYS.find((key) => key === value) ?? 'overview'
}

function parseHours(value: string | null): number {
  const hours = Number(value)
  return WINDOWS.some((w) => w.hours === hours) ? hours : DEFAULT_HOURS
}

function since(hours: number): string {
  return new Date(Date.now() - hours * HOUR).toISOString()
}

export default function TrafficIntelligence() {
  const { can } = useAuth()
  const [params, setParams] = useSearchParams()
  const tab = parseTab(params.get('tab'))
  const hours = parseHours(params.get('window'))
  const corridor = params.get('corridor') ?? ''
  const windowDef = WINDOWS.find((w) => w.hours === hours) ?? WINDOWS[2]
  const bucket = windowDef.bucket

  const [corridors, setCorridors] = useState<string[]>([])
  const [flow, setFlow] = useState<FlowResponse | null>(null)
  const [speed, setSpeed] = useState<SpeedResponse | null>(null)
  const [routes, setRoutes] = useState<RouteDensityResponse | null>(null)
  const [travelTime, setTravelTime] = useState<TravelTimeResponse | null>(null)
  const [hotspots, setHotspots] = useState<HotspotResponse | null>(null)
  const [congestion, setCongestion] = useState<CongestionResponse | null>(null)
  const [traffic, setTraffic] = useState<TrafficResponse | null>(null)
  const [history, setHistory] = useState<TrafficHistoryResponse | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [updatedAt, setUpdatedAt] = useState<Date | null>(null)

  /** Only the newest request may write to the screen — switching windows
   *  quickly used to let a slow 7-day response land over a fresh 1-hour one. */
  const sequence = useRef(0)

  const update = useCallback(
    (changes: Record<string, string | null>) => {
      setParams(
        (previous) => {
          const next = new URLSearchParams(previous)
          for (const [key, value] of Object.entries(changes)) {
            if (value === null || value === '') next.delete(key)
            else next.set(key, value)
          }
          return next
        },
        { replace: true },
      )
    },
    [setParams],
  )

  /** A link to one tab of this same view — used by the KPI tiles. */
  const hrefFor = (target: TabKey): string => {
    const next = new URLSearchParams(params)
    if (target === 'overview') next.delete('tab')
    else next.set('tab', target)
    const search = next.toString()
    return `/traffic${search ? `?${search}` : ''}`
  }

  // The corridor list, once. There is no dedicated endpoint for it — the
  // camera registry already knows every corridor a camera sits on.
  useEffect(() => {
    api
      .getCameras({ limit: '500' })
      .then((page) => {
        const found = Array.from(
          new Set(
            page.items.map((c) => c.corridor).filter((c): c is string => Boolean(c)),
          ),
        ).sort()
        setCorridors(found)
      })
      .catch(() => undefined)
  }, [])

  const load = useCallback(async () => {
    const mine = ++sequence.current
    setLoading(true)
    try {
      const windowSince = since(hours)
      const [
        flowBody,
        speedBody,
        routesBody,
        travelBody,
        hotspotsBody,
        congestionBody,
        trafficBody,
        historyBody,
      ] = await Promise.all([
        api.getAnalyticsFlow({ since: windowSince, bucket, group_by: 'corridor', corridor }),
        api.getAnalyticsSpeed({ since: windowSince, corridor }),
        api.getAnalyticsRoutes({ since: windowSince, limit: 15 }),
        api.getAnalyticsTravelTime({ since: windowSince }),
        api.getAnalyticsHotspots({ since: windowSince, limit: 8 }),
        api.getCongestionForecast({ group_by: 'camera', corridor }),
        // Grouped by corridor: a road is what an operator acts on, and it is
        // also the only grouping for which speed and travel time exist at all
        // — both come from the distance between two cameras.
        api.getTrafficState({ since: windowSince, group_by: 'corridor', corridor }),
        api.getTrafficHistory({
          since: windowSince,
          group_by: 'corridor',
          key: corridor || undefined,
        }),
      ])
      if (mine !== sequence.current) return
      setFlow(flowBody)
      setSpeed(speedBody)
      setRoutes(routesBody)
      setTravelTime(travelBody)
      setHotspots(hotspotsBody)
      setCongestion(congestionBody)
      setTraffic(trafficBody)
      setHistory(historyBody)
      setUpdatedAt(new Date())
      setError(null)
    } catch (err) {
      if (mine !== sequence.current) return
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      if (mine === sequence.current) setLoading(false)
    }
  }, [hours, corridor, bucket])

  useEffect(() => {
    void load()
  }, [load])

  // ── Derived series ──────────────────────────────────────────────────

  const historyRows = useMemo(() => {
    if (!history) return []
    return withGaps<HistoryRow>(
      history.points.map((p) => ({
        t: Date.parse(p.bucket),
        vehicles: p.vehicles,
        stationary: p.stationary_vehicles,
      })),
      history.window.bucket_seconds * 1000,
      (t) => ({ t, vehicles: null, stationary: null }),
    )
  }, [history])

  /**
   * One row per bucket, one key per corridor — the shape a stacked area chart
   * wants. `flow.series` arrives one array per corridor instead.
   *
   * Past four corridors the remainder is summed into a single neutral band.
   * The alternative, cycling four hues across twelve corridors, drew three
   * different roads in the same colour and called them different things.
   *
   * Series are keyed `s0…sN` rather than by corridor name, so a corridor that
   * happens to be called "t" cannot collide with the time column.
   */
  const flowChart = useMemo(() => {
    if (!flow) return { rows: [] as FlowRow[], series: [] as FlowSeriesDef[] }

    // Ranked by total volume so the four drawn individually are the four worth
    // looking at — then sorted by name, so a corridor keeps the same colour
    // when the window changes and the ranking shifts under it.
    const totals = flow.series.map((s) => ({
      key: s.key,
      total: s.points.reduce((sum, p) => sum + p.vehicles, 0),
    }))
    const named = new Set(
      [...totals]
        .sort((a, b) => b.total - a.total)
        .slice(0, MAX_SERIES)
        .map((t) => t.key),
    )
    const drawn = flow.series
      .map((s) => s.key)
      .filter((k) => named.has(k))
      .sort()
    const hasOther = flow.series.length > drawn.length
    const labels = hasOther ? [...drawn, OTHER_KEY] : drawn
    const series: FlowSeriesDef[] = labels.map((label, slot) => ({
      dataKey: `s${slot}`,
      label,
      color: label === OTHER_KEY ? OTHER_COLOR : seriesColor(slot),
    }))
    const slotOf = new Map(labels.map((label, slot) => [label, `s${slot}`]))

    const byBucket = new Map<number, Record<string, number>>()
    for (const s of flow.series) {
      const dataKey = slotOf.get(named.has(s.key) ? s.key : OTHER_KEY)
      if (!dataKey) continue
      for (const point of s.points) {
        const t = Date.parse(point.ts)
        const values = byBucket.get(t) ?? {}
        values[dataKey] = (values[dataKey] ?? 0) + point.vehicles
        byBucket.set(t, values)
      }
    }
    // A bucket that exists was observed. A corridor with no row in it saw no
    // vehicles while the others did, which is a real zero — unlike a bucket
    // missing altogether, which `withGaps` turns into a break.
    const rows: FlowRow[] = Array.from(byBucket.entries())
      .sort((a, b) => a[0] - b[0])
      .map(([t, values]) => {
        const row: FlowRow = { t }
        for (const def of series) row[def.dataKey] = values[def.dataKey] ?? 0
        return row
      })
    return {
      rows: withGaps<FlowRow>(rows, flow.window.bucket_seconds * 1000, (t) => {
        const blank: FlowRow = { t }
        for (const def of series) blank[def.dataKey] = null
        return blank
      }),
      series,
    }
  }, [flow])

  const okCorridors = useMemo(
    () => (speed ? speed.corridors.filter((c) => c.status === 'ok') : []),
    [speed],
  )
  const shortCorridors = useMemo(
    () => (speed ? speed.corridors.filter((c) => c.status !== 'ok') : []),
    [speed],
  )

  const zones = traffic?.zones ?? []

  // The server says when its bounded read stopped short of the window.
  const partial = trafficSample(traffic)
  const sample: SampleInfo | null = partial
    ? { ...partial, windowLabel: windowDef.label, canNarrow: hours > 1 }
    : null
  const congested = zones.filter((z) => z.congestion === 'heavy' || z.congestion === 'severe')
  const severe = zones.some((z) => z.congestion === 'severe')
  const failed = error !== null && traffic === null
  const refetching = loading && traffic !== null

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      {/* Header, filters and the KPI strip stay put while the tab below
          scrolls — the window and corridor apply to everything underneath, so
          scrolling a long table should not scroll away the controls that say
          what the table is of. */}
      <div className="shrink-0 px-6 pt-5">
        <PageHeader
          title="Traffic intelligence"
          subtitle={
            <>
              <span>last {windowDef.label}</span>
              <span className="text-muted-foreground/40">·</span>
              <span>{corridor || 'all corridors'}</span>
              <span className="text-muted-foreground/40">·</span>
              <span className="font-mono text-faint">
                {updatedAt ? `updated ${IST_STAMP.format(updatedAt)} IST` : 'loading…'}
              </span>
              <InfoHint label="How these figures are produced">
                Every figure here is computed from observed vehicles and
                journeys on the server. Anything that cannot be computed says so
                rather than showing a zero — a plausible-looking invented number
                would survive the demo and destroy the claim. Times are IST.
              </InfoHint>
            </>
          }
          actions={
            <Toolbar>
              {/* Both controls are pinned to the same height so their labels
                  sit on one line — a select and a segmented control have
                  different intrinsic heights, and bottom-aligning them left
                  the two captions stepped. */}
              <ToolbarField label="Corridor">
                <Select
                  value={corridor}
                  onChange={(e) => update({ corridor: e.target.value })}
                  className="h-8 max-w-[14rem] py-0"
                >
                  <option value="">All corridors</option>
                  {corridors.map((c) => (
                    <option key={c} value={c}>
                      {c}
                    </option>
                  ))}
                  {/* A corridor from a shared link that the registry no
                      longer lists still has to show as selected. */}
                  {corridor && !corridors.includes(corridor) && (
                    <option value={corridor}>{corridor}</option>
                  )}
                </Select>
              </ToolbarField>
              <ToolbarField label="Window" group>
                <SegmentedControl
                  className="h-8"
                  value={windowDef.value}
                  onChange={(v) => update({ window: v === String(DEFAULT_HOURS) ? null : v })}
                  options={WINDOWS.map((w) => ({ value: w.value, label: w.label }))}
                />
              </ToolbarField>
              <Button
                variant="outline"
                onClick={() => void load()}
                disabled={loading}
                aria-label="Refresh"
                title="Fetch every panel again for this window"
                className="w-8 px-0"
              >
                <Icon name="refresh" size={15} className={loading ? 'animate-spin' : ''} />
              </Button>
            </Toolbar>
          }
        />

        {error && (
          <div className="mt-3">
            <ErrorBanner>{error}</ErrorBanner>
          </div>
        )}

        {/* ── KPI tiles ─────────────────────────────────────────────── */}
        <section className="mt-4 grid grid-cols-2 gap-3 xl:grid-cols-4">
          {!traffic ? (
            failed ? (
              <p className="col-span-full text-xs text-faint">
                Figures not loaded — see the error above.
              </p>
            ) : (
              <>
                <SkeletonStat />
                <SkeletonStat />
                <SkeletonStat />
                <SkeletonStat />
              </>
            )
          ) : (
            <>
              <StatTile
                label="Vehicles observed"
                value={(sample ? sample.observed : traffic.total_vehicles).toLocaleString('en-IN')}
                aside={<KpiSparkline rows={historyRows} />}
                detail={
                  sample
                    ? `unique · last ${windowDef.label} · road figures from the latest ${sample.read.toLocaleString('en-IN')}`
                    : `unique · last ${windowDef.label}`
                }
                info={
                  <>
                    Counted once when a vehicle's track retires, never once per
                    frame. A vehicle in view for ten seconds is one vehicle. The
                    line is vehicles per five minutes across the window.
                    {sample && (
                      <>
                        {' '}
                        The road-state figures are read from at most{' '}
                        {sample.read.toLocaleString('en-IN')} vehicles per request,
                        newest first; this total is the server's count of the whole
                        window.
                      </>
                    )}
                  </>
                }
              />
              <StatTile
                label="Active cameras"
                value={
                  <>
                    {traffic.active_cameras}
                    <span className="text-base text-faint"> / {traffic.fleet_cameras}</span>
                  </>
                }
                tone={traffic.active_cameras === 0 ? 'warn' : undefined}
                detail="saw a vehicle in this window"
              />
              <StatTile
                label="Roads congested"
                value={String(congested.length)}
                tone={severe ? 'bad' : congested.length > 0 ? 'warn' : undefined}
                detail={`heavy or severe, of ${zones.length} with traffic`}
                to={hrefFor('roads')}
              />
              <StatTile
                label="Possible obstructions"
                value={String(traffic.possible_obstructions.length)}
                tone={traffic.possible_obstructions.length > 0 ? 'warn' : undefined}
                detail="stopped longer than a queue explains"
                info="A stopped vehicle, and nothing more. The system can see that it has not moved, not why — a breakdown, a delivery and a police stop all look identical from here."
                to={hrefFor('roads')}
              />
            </>
          )}
        </section>

        <div className="mt-4">
          <Tabs
            value={tab}
            onChange={(next) => update({ tab: next === 'overview' ? null : next })}
            tabs={[
              { value: 'overview', label: 'Overview' },
              { value: 'roads', label: 'Roads', badge: traffic && <TabCount n={zones.length} /> },
              {
                value: 'journeys',
                label: 'Journeys',
                badge: routes && <TabCount n={routes.pairs.length} />,
              },
              { value: 'forecast', label: 'Forecast' },
            ]}
          />
        </div>
      </div>

      {/* Refetching holds the previous render at reduced opacity rather than
          flashing skeletons: the frame stays, the numbers update under it. */}
      <div
        className={`min-h-0 flex-1 space-y-4 overflow-y-auto px-6 py-5 transition-opacity ${
          refetching ? 'opacity-60' : ''
        }`}
      >
        {tab === 'overview' && (
          <>
            <div className="grid gap-4 xl:grid-cols-3">
              <Panel className="xl:col-span-2">
                <PanelHeader
                  title="Traffic over time"
                  caption="Vehicles per 5-minute bucket"
                  info="The same five-minute buckets the queue detector runs over, so this chart and the verdict on the Roads tab cannot disagree. Where no bucket exists the line breaks: no detection rows were recorded there, and the chart does not draw a slope through time nothing was observed in."
                  action={
                    <ChartLegend
                      items={[
                        { label: 'Vehicles', color: seriesColor(0), mark: 'line' },
                        { label: 'Stationary', color: seriesColor(1), mark: 'line' },
                      ]}
                    />
                  }
                />
                {!history ? (
                  <PanelLoading failed={failed} height="h-60" />
                ) : historyRows.length === 0 ? (
                  <NoFigure kind="nothing" title="No detections in this window." className="mt-3">
                    No camera{corridor ? ` on ${corridor}` : ''} recorded a vehicle in
                    the last {windowDef.label}.
                  </NoFigure>
                ) : (
                  <div className="mt-3 h-60">
                    <ResponsiveContainer width="100%" height="100%">
                      <AreaChart data={historyRows} margin={CHART_MARGIN}>
                        <CartesianGrid stroke={GRID} vertical={false} />
                        <XAxis
                          {...timeAxis(history.window).props}
                          tick={TICK}
                          axisLine={{ stroke: GRID }}
                          tickLine={false}
                        />
                        <YAxis
                          tick={TICK}
                          axisLine={false}
                          tickLine={false}
                          width={Y_AXIS_WIDTH}
                          tickFormatter={compact}
                          allowDecimals={false}
                        />
                        {leadInArea(
                          historyRows,
                          timeAxis(history.window).start,
                          timeAxis(history.window).end,
                        )}
                        <Tooltip
                          cursor={CURSOR}
                          content={(props) => (
                            <ChartTooltip
                              active={props.active}
                              payload={props.payload}
                              label={props.label}
                              heading={(t) =>
                                bucketLabel(t, history.window.bucket_seconds * 1000)
                              }
                            />
                          )}
                        />
                        {/* Stationary is a subset of all vehicles, so the two
                            overlap rather than stack. */}
                        <Area
                          type="monotone"
                          dataKey="vehicles"
                          name="Vehicles"
                          stroke={seriesColor(0)}
                          strokeWidth={1.75}
                          fill={seriesColor(0)}
                          fillOpacity={0.12}
                          connectNulls={false}
                          isAnimationActive={false}
                          dot={isolatedDot(seriesColor(0))}
                          activeDot={ACTIVE_DOT}
                        />
                        <Area
                          type="monotone"
                          dataKey="stationary"
                          name="Stationary"
                          stroke={seriesColor(1)}
                          strokeWidth={1.75}
                          fill={seriesColor(1)}
                          fillOpacity={0.12}
                          connectNulls={false}
                          isAnimationActive={false}
                          dot={isolatedDot(seriesColor(1))}
                          activeDot={ACTIVE_DOT}
                        />
                      </AreaChart>
                    </ResponsiveContainer>
                  </div>
                )}
              </Panel>

              <Panel>
                <PanelHeader
                  title="Vehicles by type"
                  caption={
                    traffic
                      ? sample
                        ? `The latest ${traffic.total_vehicles.toLocaleString('en-IN')} vehicles in the window`
                        : `${traffic.total_vehicles.toLocaleString('en-IN')} unique vehicles`
                      : undefined
                  }
                  info="Unique vehicles, counted once when their track retires — never once per frame. Every class is listed even at zero, so a quiet class is not mistaken for a missing one."
                />
                {!traffic ? (
                  <PanelLoading failed={failed} height="h-40" />
                ) : traffic.total_vehicles === 0 ? (
                  <NoFigure kind="nothing" title="No vehicles in this window." className="mt-3" />
                ) : (
                  <>
                    <VehicleMix traffic={traffic} />
                    {sample && <SampleNote sample={sample} className="mt-4" />}
                  </>
                )}
              </Panel>
            </div>

            <div className="grid gap-4 xl:grid-cols-3">
              <Panel className="xl:col-span-2">
                <PanelHeader
                  title="Vehicle flow by corridor"
                  caption={
                    flowChart.series.length === 1
                      ? `${flowChart.series[0]?.label} · vehicles per ${bucketWord(bucket)}`
                      : `Vehicles per ${bucketWord(bucket)}, stacked`
                  }
                  info={`The ${MAX_SERIES} busiest corridors are drawn individually; everything else is summed into one neutral band. Cycling a small set of colours across twelve corridors would paint different roads the same colour and call them different things. Cameras with no corridor assigned are not part of this chart.`}
                  action={
                    flowChart.series.length > 1 ? (
                      <ChartLegend
                        items={flowChart.series.map((s) => ({
                          label: s.label,
                          color: s.color,
                          mark: 'square' as const,
                        }))}
                      />
                    ) : undefined
                  }
                />
                {!flow ? (
                  <PanelLoading failed={failed} height="h-64" />
                ) : flowChart.rows.length === 0 ? (
                  <NoFigure kind="nothing" title="No corridor traffic in this window." className="mt-3">
                    No camera with a corridor assigned recorded a vehicle in the last{' '}
                    {windowDef.label}.
                  </NoFigure>
                ) : (
                  <div className="mt-3 h-64">
                    <ResponsiveContainer width="100%" height="100%">
                      <AreaChart data={flowChart.rows} margin={CHART_MARGIN}>
                        <CartesianGrid stroke={GRID} vertical={false} />
                        <XAxis
                          {...timeAxis(flow.window).props}
                          tick={TICK}
                          axisLine={{ stroke: GRID }}
                          tickLine={false}
                        />
                        <YAxis
                          tick={TICK}
                          axisLine={false}
                          tickLine={false}
                          width={Y_AXIS_WIDTH}
                          tickFormatter={compact}
                          allowDecimals={false}
                        />
                        {leadInArea(
                          flowChart.rows,
                          timeAxis(flow.window).start,
                          timeAxis(flow.window).end,
                        )}
                        <Tooltip
                          cursor={CURSOR}
                          content={(props) => (
                            <ChartTooltip
                              active={props.active}
                              payload={props.payload}
                              label={props.label}
                              heading={(t) => bucketLabel(t, flow.window.bucket_seconds * 1000)}
                              total={flowChart.series.length > 1}
                            />
                          )}
                        />
                        {flowChart.series.map((s) => {
                          const stacked = flowChart.series.length > 1
                          return (
                            <Area
                              key={s.dataKey}
                              // Straight segments: at an hour or a day per
                              // bucket a smoothed curve invents the shape of
                              // traffic between points nobody measured.
                              type="linear"
                              dataKey={s.dataKey}
                              name={s.label}
                              stackId="flow"
                              // Stacked, the stroke is the card surface, not
                              // the fill: a hairline of background between
                              // bands is what keeps two adjacent fills legible
                              // as two. A lone corridor is drawn like any
                              // single series — a line over a light wash, not
                              // a saturated block.
                              stroke={stacked ? SURFACE : s.color}
                              strokeWidth={stacked ? 2 : 1.75}
                              fill={s.color}
                              fillOpacity={stacked ? 0.6 : 0.12}
                              connectNulls={false}
                              isAnimationActive={false}
                              dot={isolatedDot(s.color)}
                              activeDot={ACTIVE_DOT}
                            />
                          )
                        })}
                      </AreaChart>
                    </ResponsiveContainer>
                  </div>
                )}
              </Panel>

              <Panel>
                <PanelHeader
                  title="Busiest cameras"
                  caption="By volume — not a congestion measure"
                  info={hotspots?.note}
                  action={
                    can(PERMISSIONS.cameraRead) ? (
                      <Link
                        to="/map"
                        className="flex items-center gap-1 text-xs text-muted-foreground transition hover:text-foreground"
                        title="The detection-density heat layer is on the network map"
                      >
                        Heat map
                        <Icon name="arrowRight" size={13} />
                      </Link>
                    ) : undefined
                  }
                />
                {!hotspots ? (
                  <PanelLoading failed={failed} height="h-40" />
                ) : (
                  <BusiestCameras hotspots={hotspots} />
                )}
              </Panel>
            </div>
          </>
        )}

        {tab === 'roads' && (
          <>
            {/* Everything on this tab is built on the traffic endpoint's
                read, so the one note covers both panels. */}
            {sample && <SampleNote sample={sample} />}
            <Panel>
              <PanelHeader
                title="Road state"
                caption="Most congested first · each verdict with the signals behind it"
                info={
                  <>
                    Density is vehicles in view at once, not vehicles per
                    kilometre — no camera here is calibrated, so there is no
                    honest conversion between the two. A congestion level is
                    scored over whichever of occupancy, speed and travel time
                    exist for the road, and the ones it used are listed under
                    its name. {traffic?.note}
                  </>
                }
              />
              {!traffic ? (
                <PanelLoading failed={failed} rows={5} />
              ) : zones.length === 0 ? (
                <NoFigure kind="nothing" title="No traffic observed in this window." className="mt-3" />
              ) : (
                <div className="mt-3">
                  <RoadStateTable zones={zones} />
                </div>
              )}
            </Panel>

            {traffic && traffic.possible_obstructions.length > 0 && (
              <Panel>
                <PanelHeader
                  title="Possible obstructions"
                  caption={`${traffic.possible_obstructions.length} stopped vehicle${traffic.possible_obstructions.length === 1 ? '' : 's'} · longest first`}
                  info="Vehicles that stopped and stayed stopped. The system can see that they did not move, not why — a breakdown, a delivery and a police stop all look identical from here. Never an accident, and never a claim about a person."
                />
                <div className="mt-3">
                  <ObstructionsTable rows={traffic.possible_obstructions} />
                </div>
              </Panel>
            )}
          </>
        )}

        {tab === 'journeys' && (
          <>
            <Panel>
              <PanelHeader
                title="Route density"
                caption="Camera-to-camera movements, ranked by distinct vehicles"
                info="Distances are straight-line between cameras, so they are a floor on the road distance actually driven — which is why every distance here is prefixed ≥."
              />
              {!routes ? (
                <PanelLoading failed={failed} rows={5} />
              ) : routes.pairs.length === 0 ? (
                <NoFigure
                  kind="nothing"
                  title="No multi-camera journeys observed in this window."
                  className="mt-3"
                  needs="the same plate is read on two different cameras within the window."
                >
                  Route density counts vehicles whose plate was read on one
                  camera and then on another. None were in the last{' '}
                  {windowDef.label}.
                </NoFigure>
              ) : (
                <div className="mt-3">
                  <RouteDensityTable routes={routes} />
                </div>
              )}
            </Panel>

            <Panel>
              <PanelHeader
                title="Travel time vs baseline"
                caption={`Against the same time of day on the previous ${travelTime?.baseline_window_days ?? BASELINE_WINDOW_DAYS} days`}
                info="A segment's current median journey time against its own median at this time of day on earlier days. A baseline is published only from five or more journeys; below that the segment says how many it has."
              />
              {!travelTime ? (
                <PanelLoading failed={failed} rows={3} height="h-16" />
              ) : travelTime.segments.length === 0 ? (
                <NoFigure
                  kind="nothing"
                  title="No segments observed in this window."
                  className="mt-3"
                  needs="a vehicle is read on two cameras in sequence, giving a segment a journey time."
                />
              ) : (
                <TravelTimeGrid travelTime={travelTime} />
              )}
            </Panel>
          </>
        )}

        {tab === 'forecast' && (
          <>
            <Panel>
              <PanelHeader
                title="Predicted congestion"
                caption="Each camera's volume against its own typical for this hour — 100% is normal"
                info="100% is normal for this hour of day, not an absolute road-capacity reading — no capacity data exists to compute one. The +15 and +30 min figures are a straight-line trend through the last 30 minutes; the band and the ± figure are that same method's error, measured against buckets already inside the window. Every contributing factor the forecast used is listed on its card."
              />
              {!congestion ? (
                <PanelLoading failed={failed} rows={3} height="h-24" />
              ) : (
                <ForecastSection congestion={congestion} />
              )}
            </Panel>

            <Panel>
              <PanelHeader
                title="Corridor speed"
                caption="Median km/h of physically plausible legs between cameras"
                info={speed?.provenance.note}
              />
              {!speed ? (
                <PanelLoading failed={failed} height="h-48" />
              ) : okCorridors.length === 0 ? (
                <SpeedUnavailable speed={speed} />
              ) : (
                <div
                  className="mt-3"
                  style={{ height: Math.max(120, okCorridors.length * 38 + 36) }}
                >
                  {/* Horizontal: corridor names are long and there can be a
                      dozen of them, and a speed is read against its
                      neighbours, not against a time axis. */}
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart
                      data={okCorridors}
                      layout="vertical"
                      margin={{ left: 4, right: 64, top: 4, bottom: 0 }}
                    >
                      <CartesianGrid stroke={GRID} horizontal={false} />
                      <XAxis
                        type="number"
                        tick={TICK}
                        axisLine={{ stroke: GRID }}
                        tickLine={false}
                        allowDecimals={false}
                      />
                      <YAxis
                        type="category"
                        dataKey="corridor"
                        width={150}
                        tick={{ fontSize: 12, fill: 'hsl(var(--muted-foreground))' }}
                        axisLine={false}
                        tickLine={false}
                      />
                      <Tooltip
                        cursor={{ fill: 'hsl(var(--secondary) / 0.5)' }}
                        content={(props) => (
                          <ChartTooltip
                            active={props.active}
                            payload={props.payload}
                            label={props.label}
                            heading={(v) => String(v)}
                            unit=" km/h"
                            note={(row) => {
                              const samples = (row as { samples?: unknown } | undefined)?.samples
                              return typeof samples === 'number'
                                ? `median of ${samples} plausible leg${samples === 1 ? '' : 's'}`
                                : null
                            }}
                          />
                        )}
                      />
                      {/* One series, so no legend — the title names it.
                          Direct labels instead, which beat a tooltip when
                          there are a handful of bars to compare at a glance. */}
                      <Bar
                        dataKey="median_kmph"
                        name="median"
                        fill={seriesColor(0)}
                        radius={[0, 4, 4, 0]}
                        maxBarSize={18}
                        isAnimationActive={false}
                      >
                        <LabelList
                          dataKey="median_kmph"
                          position="right"
                          formatter={(v: number) => `${v} km/h`}
                          style={{
                            fontSize: 11,
                            fill: 'hsl(var(--foreground))',
                            fontFamily: "'IBM Plex Mono', monospace",
                          }}
                        />
                      </Bar>
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              )}

              {okCorridors.length > 0 && shortCorridors.length > 0 && (
                <div className="mt-3 flex flex-wrap items-center gap-1.5">
                  <span className="text-[11px] text-faint">No figure yet:</span>
                  {shortCorridors.map((c) => (
                    <Badge key={c.corridor} tone="neutral" title={`${c.samples} plausible leg(s)`}>
                      {c.corridor}
                    </Badge>
                  ))}
                </div>
              )}
            </Panel>
          </>
        )}
      </div>
    </div>
  )
}

// ── Shapes ───────────────────────────────────────────────────────────────

interface HistoryRow extends TimeFlags {
  t: number
  vehicles: number | null
  stationary: number | null
}

interface FlowRow extends TimeFlags {
  t: number
  [series: string]: number | boolean | null | undefined
}

interface FlowSeriesDef {
  dataKey: string
  label: string
  color: string
}

function bucketWord(bucket: string): string {
  return (
    { '5m': '5 minutes', '15m': '15 minutes', '1h': 'hour', '1d': 'day' }[bucket] ?? bucket
  )
}

// ── Small parts ──────────────────────────────────────────────────────────

interface SampleInfo {
  /** Vehicles the traffic endpoint read — the window's latest. */
  read: number
  /** Vehicles in the whole window, counted by the server. */
  observed: number
  windowLabel: string
  /** Whether a shorter window is on offer to bring the read under the bound. */
  canNarrow: boolean
}

/**
 * Says that a panel was computed from the latest part of the window only.
 * Not a warning colour: nothing is wrong with the roads, and nobody needs to
 * act — but a figure built on a sample has to say so beside the figure.
 */
function SampleNote({ sample, className = '' }: { sample: SampleInfo; className?: string }) {
  const read = sample.read.toLocaleString('en-IN')
  return (
    <p
      className={`flex items-start gap-2 rounded-md border border-border bg-background/50 px-3 py-2 text-xs leading-relaxed text-muted-foreground ${className}`}
    >
      <Icon name="info" size={14} className="mt-px shrink-0 text-faint" />
      <span>
        Computed from the latest {read} of {sample.observed.toLocaleString('en-IN')}{' '}
        vehicles in the last {sample.windowLabel} — the server reads at most {read}{' '}
        per request, newest first, so the start of the window is not in this panel.
        {sample.canNarrow ? ' A shorter window may fit within that.' : ''}
      </span>
    </p>
  )
}

function TabCount({ n }: { n: number }) {
  return (
    <span className="rounded-full bg-secondary px-1.5 font-mono text-[10px] leading-4 text-muted-foreground">
      {n}
    </span>
  )
}

function PanelLoading({
  failed,
  rows = 1,
  height = 'h-9',
}: {
  failed: boolean
  rows?: number
  height?: string
}) {
  if (failed) {
    return <p className="mt-3 text-xs text-faint">Not loaded — see the error above.</p>
  }
  return (
    <div className="mt-3">
      <SkeletonRows rows={rows} height={height} />
    </div>
  )
}

/**
 * Why a figure is absent, said as plainly as the figure would have been.
 *
 * Three kinds, because they mean different things to an operator: nothing was
 * observed (quiet roads, or cameras not reading), not enough history yet (it
 * will appear with time, untouched), and nothing plausible (observed, then
 * excluded on purpose). Each names what would produce the figure, so an empty
 * panel reads as a state of the data rather than as a broken screen.
 */
function NoFigure({
  kind,
  title,
  children,
  needs,
  className = '',
}: {
  kind: 'nothing' | 'history' | 'implausible'
  title: ReactNode
  children?: ReactNode
  needs?: ReactNode
  className?: string
}) {
  const meta: Record<typeof kind, { eyebrow: string; icon: IconName }> = {
    nothing: { eyebrow: 'Nothing observed', icon: 'eye' },
    history: { eyebrow: 'Not enough history yet', icon: 'clock' },
    implausible: { eyebrow: 'No plausible measurement', icon: 'filter' },
  }
  return (
    <div
      className={`rounded-lg border border-dashed border-input/70 bg-background/40 px-4 py-4 ${className}`}
    >
      <div className="flex items-start gap-3">
        <span className="grid h-8 w-8 shrink-0 place-items-center rounded-full border border-border bg-card text-faint">
          <Icon name={meta[kind].icon} size={15} />
        </span>
        <div className="min-w-0">
          <p className="eyebrow">{meta[kind].eyebrow}</p>
          <p className="mt-1 text-[13px] font-medium text-foreground">{title}</p>
          {children && (
            <div className="mt-1 max-w-[68ch] text-xs leading-relaxed text-muted-foreground">
              {children}
            </div>
          )}
          {needs && (
            <p className="mt-2 text-xs leading-relaxed text-faint">
              <span className="text-muted-foreground">Appears when</span> {needs}
            </p>
          )}
        </div>
      </div>
    </div>
  )
}

/** A legend in text tokens: the colour is carried by the key beside each
 *  name, never by the name itself. */
function ChartLegend({
  items,
}: {
  items: { label: string; color: string; mark: 'line' | 'square' }[]
}) {
  return (
    <ul className="flex flex-wrap items-center justify-end gap-x-3.5 gap-y-1">
      {items.map((item) => (
        <li key={item.label} className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <span
            aria-hidden
            className={item.mark === 'line' ? 'h-0.5 w-3.5 rounded-full' : 'h-2.5 w-2.5 rounded-[2px]'}
            style={{ background: item.color }}
          />
          {item.label}
        </li>
      ))}
    </ul>
  )
}

interface TooltipEntry {
  name?: string | number
  value?: unknown
  color?: string
  dataKey?: unknown
  fill?: string
  payload?: unknown
}

/**
 * The one tooltip every chart here uses. Values lead and names follow — the
 * reader already has the series and wants the number — keyed with a short
 * stroke of the series colour. A bucket with no rows says so rather than
 * showing zeros.
 */
function ChartTooltip({
  active,
  payload,
  label,
  heading,
  total = false,
  unit = '',
  note,
}: {
  active?: boolean
  payload?: ReadonlyArray<TooltipEntry>
  label?: unknown
  heading: (label: number) => string
  total?: boolean
  unit?: string
  /** One more line under the values, from the hovered row itself. */
  note?: (row: unknown) => string | null
}) {
  if (!active || !payload || payload.length === 0) return null
  const entries = payload.filter((p) => p.dataKey !== undefined)
  const numbers = entries.map((p) => (typeof p.value === 'number' ? p.value : null))
  const empty = numbers.every((n) => n === null)
  const sum = numbers.reduce<number>((acc, n) => acc + (n ?? 0), 0)
  const extra = note ? note(entries[0]?.payload) : null
  return (
    <div className="min-w-[11rem] rounded-md border border-border bg-popover px-3 py-2 shadow-xl">
      <p className="font-mono text-[11px] text-faint">
        {typeof label === 'number' ? heading(label) : String(label ?? '')}
      </p>
      {empty ? (
        <p className="mt-1 text-xs text-muted-foreground">No detection rows in this bucket.</p>
      ) : (
        <ul className="mt-1.5 space-y-1">
          {/* Stacked areas hand the payload over top-down; the legend reads
              in slot order, so the tooltip does too. */}
          {[...entries].reverse().map((entry, i) => (
            <li key={`${String(entry.dataKey)}-${i}`} className="flex items-center gap-2 text-xs">
              <span
                aria-hidden
                className="h-0.5 w-3 shrink-0 rounded-full"
                style={{ background: entry.color ?? entry.fill }}
              />
              <span className="font-mono font-medium text-foreground">
                {typeof entry.value === 'number'
                  ? `${entry.value.toLocaleString('en-IN')}${unit}`
                  : '—'}
              </span>
              <span className="truncate text-muted-foreground">{entry.name}</span>
            </li>
          ))}
          {total && entries.length > 1 && (
            <li className="flex items-center gap-2 border-t border-border pt-1 text-xs">
              <span aria-hidden className="w-3 shrink-0" />
              <span className="font-mono font-medium text-foreground">
                {sum.toLocaleString('en-IN')}
                {unit}
              </span>
              <span className="text-muted-foreground">total</span>
            </li>
          )}
        </ul>
      )}
      {extra && <p className="mt-1.5 text-[11px] text-faint">{extra}</p>}
    </div>
  )
}

/**
 * The KPI's trend, from the same five-minute history the main chart draws.
 * Breaks where buckets are missing, like the chart, so a quiet hour does not
 * read as a smooth decline.
 */
function KpiSparkline({ rows }: { rows: Array<HistoryRow> }) {
  const W = 84
  const H = 24
  const real = rows.filter((r): r is HistoryRow & { vehicles: number } => r.vehicles !== null)
  const first = real[0]
  const last = real[real.length - 1]
  if (!first || !last || real.length < 2 || last.t <= first.t) return null
  const max = Math.max(1, ...real.map((r) => r.vehicles))
  const x = (t: number) => ((t - first.t) / (last.t - first.t)) * (W - 2) + 1
  const y = (v: number) => H - 2 - (v / max) * (H - 4)

  const segments: string[][] = []
  let current: string[] = []
  for (const row of rows) {
    if (row.vehicles === null) {
      if (current.length) segments.push(current)
      current = []
      continue
    }
    current.push(`${x(row.t).toFixed(1)},${y(row.vehicles).toFixed(1)}`)
  }
  if (current.length) segments.push(current)

  return (
    <svg
      width={W}
      height={H}
      viewBox={`0 0 ${W} ${H}`}
      aria-hidden="true"
      className="mb-0.5 text-primary"
    >
      {segments.map((points, i) => {
        if (points.length === 1) {
          const [cx, cy] = (points[0] ?? '0,0').split(',')
          return <circle key={i} cx={cx} cy={cy} r={1.4} fill="currentColor" />
        }
        return (
          <polyline
            key={i}
            points={points.join(' ')}
            fill="none"
            stroke="currentColor"
            strokeWidth={1.6}
            strokeLinejoin="round"
            strokeLinecap="round"
          />
        )
      })}
    </svg>
  )
}

/**
 * Vehicle mix as one hundred-percent bar rather than five equal boxes.
 *
 * This is parts-of-a-whole data, and five boxes each showing a count and its
 * own percentage made the reader compose the whole in their head. A single
 * stacked bar shows the composition directly; the list beside it carries the
 * identity and the numbers, so the bar is never read by colour alone. Every
 * class is listed, zero included, as the API sends it.
 */
function VehicleMix({ traffic }: { traffic: TrafficResponse }) {
  const rows = (
    [
      ['Car', traffic.totals_by_type.car],
      ['Motorcycle', traffic.totals_by_type.motorcycle],
      ['Bus', traffic.totals_by_type.bus],
      ['Truck', traffic.totals_by_type.truck],
      ['Other', traffic.totals_by_type.other],
    ] as const
  ).map(([label, count], slot) => ({
    label,
    count,
    pct: traffic.total_vehicles > 0 ? (count / traffic.total_vehicles) * 100 : 0,
    colour: label === 'Other' ? OTHER_COLOR : seriesColor(slot),
  }))
  const drawn = rows.filter((row) => row.count > 0)

  return (
    <div className="mt-4">
      {/* gap-0.5 is the 2px surface gap between segments. */}
      <div className="flex h-3 gap-0.5 overflow-hidden rounded-[3px]" role="img" aria-label={
        drawn.map((r) => `${r.label} ${share(r.pct)}`).join(', ')
      }>
        {drawn.map((row) => (
          <div
            key={row.label}
            title={`${row.label}: ${row.count.toLocaleString('en-IN')} (${share(row.pct)})`}
            style={{ width: `${row.pct}%`, background: row.colour }}
            className="h-full min-w-[2px]"
          />
        ))}
      </div>
      <ul className="mt-4 space-y-2">
        {rows.map((row) => (
          <li key={row.label} className="flex items-center gap-2.5 text-[13px]">
            <span
              aria-hidden
              className="h-2.5 w-2.5 shrink-0 rounded-[2px]"
              style={{ background: row.count > 0 ? row.colour : 'transparent', boxShadow: row.count > 0 ? undefined : 'inset 0 0 0 1px hsl(var(--input))' }}
            />
            <span className={row.count > 0 ? 'text-muted-foreground' : 'text-faint'}>{row.label}</span>
            <span
              className={`ml-auto font-mono tabular-nums ${row.count > 0 ? 'text-foreground' : 'text-faint'}`}
            >
              {row.count.toLocaleString('en-IN')}
            </span>
            <span className="w-12 shrink-0 text-right font-mono text-xs tabular-nums text-faint">
              {share(row.pct)}
            </span>
          </li>
        ))}
      </ul>
    </div>
  )
}

function BusiestCameras({ hotspots }: { hotspots: HotspotResponse }) {
  if (hotspots.by_volume.length === 0) {
    return <NoFigure kind="nothing" title="No detections in this window." className="mt-3" />
  }
  return (
    <>
      <ol className="mt-3 space-y-0.5">
        {hotspots.by_volume.map((hot, i) => (
          <li key={hot.camera_code} className="flex items-center gap-2.5 rounded-md px-1 py-1.5">
            <span className="w-4 shrink-0 text-right font-mono text-[11px] text-faint">{i + 1}</span>
            <div className="min-w-0 flex-1">
              <p className="truncate font-mono text-xs text-foreground">{hot.camera_code}</p>
              <p className="truncate text-[11px] text-muted-foreground">
                {hot.camera_name}
                {hot.corridor ? ` · ${hot.corridor}` : ''}
              </p>
            </div>
            <div
              className="h-1.5 w-16 shrink-0 overflow-hidden rounded-full bg-secondary"
              title={`${Math.round(hot.intensity * 100)}% of the busiest camera`}
            >
              <div
                className="h-full rounded-full"
                style={{ width: `${Math.max(2, Math.round(hot.intensity * 100))}%`, background: seriesColor(0) }}
              />
            </div>
            <span className="w-14 shrink-0 text-right font-mono text-xs tabular-nums text-foreground">
              {hot.vehicles.toLocaleString('en-IN')}
            </span>
          </li>
        ))}
      </ol>
      <div className="mt-3 border-t border-border pt-3">
        <p className="eyebrow">Slowest against baseline</p>
        {hotspots.slowdown_status === 'ok' && hotspots.by_slowdown.length > 0 ? (
          <ul className="mt-2 space-y-1">
            {hotspots.by_slowdown.slice(0, 4).map((s) => (
              <li key={`${s.from_camera}-${s.to_camera}`} className="flex items-center gap-2 text-xs">
                <span className="truncate font-mono text-foreground">
                  {s.from_camera} → {s.to_camera}
                </span>
                <span className="ml-auto font-mono text-priority-high">
                  {s.delta_pct !== null ? `${s.delta_pct > 0 ? '+' : ''}${s.delta_pct}%` : '—'}
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="mt-1.5 text-xs leading-relaxed text-faint">
            No segment has enough history for a baseline yet, so there is no
            slowdown ranking — volume above is not one.
          </p>
        )}
      </div>
    </>
  )
}

function RoadStateTable({ zones }: { zones: TrafficZone[] }) {
  return (
    <Table className="min-w-[900px]">
      <Thead>
        <tr>
          <Th>Road</Th>
          <Th>Congestion</Th>
          <Th className="text-right">Vehicles</Th>
          <Th className="text-right">Per hour</Th>
          <Th className="text-right" title="Most vehicles in view at once">
            In view
          </Th>
          <Th className="text-right">Speed</Th>
          <Th className="text-right">Travel time</Th>
          <Th>Queue</Th>
        </tr>
      </Thead>
      <tbody>
        {[...zones]
          .sort((a, b) => (b.congestion_score ?? -1) - (a.congestion_score ?? -1))
          .map((zone) => (
            <Tr key={zone.key} className="align-top">
              <Td className="max-w-[24rem]">
                <span className="font-medium text-foreground">{zone.label}</span>
                <FactorList factors={zone.factors} />
              </Td>
              <Td>
                <CongestionBadge zone={zone} />
              </Td>
              <Td className="text-right font-mono tabular-nums">
                {zone.vehicles.toLocaleString('en-IN')}
              </Td>
              {/* Rounded: a vehicle count per hour arrives as a float and
                  "833.33 vehicles" claims a precision the measurement does
                  not have. */}
              <Td className="text-right font-mono tabular-nums">
                {zone.vehicles_per_hour === null
                  ? '—'
                  : Math.round(zone.vehicles_per_hour).toLocaleString('en-IN')}
              </Td>
              <Td className="text-right font-mono tabular-nums">
                {zone.density_status === 'ok' ? (
                  zone.peak_occupancy
                ) : (
                  <Absent why="No dwell times recorded for these vehicles" />
                )}
              </Td>
              <Td className="text-right font-mono tabular-nums">
                {zone.speed_status === 'ok' && zone.median_speed_kmph !== null ? (
                  `${zone.median_speed_kmph} km/h`
                ) : (
                  <Absent why="No physically plausible leg — expected on replayed demo footage" />
                )}
              </Td>
              <Td className="text-right font-mono tabular-nums">
                {zone.travel_time_status === 'ok' && zone.travel_time_delta_pct !== null ? (
                  <span
                    className={
                      zone.travel_time_delta_pct > 15
                        ? 'inline-flex items-center gap-1.5 text-priority-high'
                        : 'text-foreground'
                    }
                  >
                    {zone.travel_time_delta_pct > 15 && <SeverityGlyph priority="high" size={8} />}
                    {zone.travel_time_delta_pct > 0 ? '+' : ''}
                    {zone.travel_time_delta_pct}%
                  </span>
                ) : (
                  <Absent why="No baseline yet for this time of day" />
                )}
              </Td>
              <Td>
                {zone.queue.present ? (
                  <Badge tone="warning">
                    <SeverityGlyph priority="high" size={8} />
                    {zone.queue.length_vehicles} vehicles
                  </Badge>
                ) : zone.queue.status !== 'ok' ? (
                  <span className="text-[11px] text-faint">not measured</span>
                ) : (
                  <span className="text-[11px] text-muted-foreground">none</span>
                )}
              </Td>
            </Tr>
          ))}
      </tbody>
    </Table>
  )
}

/** A dash that says why it is a dash. */
function Absent({ why }: { why: string }) {
  return (
    <span className="cursor-help text-faint" title={why}>
      —<span className="sr-only"> ({why})</span>
    </span>
  )
}

const OBSTRUCTIONS_SHOWN = 12

function ObstructionsTable({ rows }: { rows: TrafficResponse['possible_obstructions'] }) {
  const sorted = [...rows].sort((a, b) => b.stationary_seconds - a.stationary_seconds)
  return (
    <>
      <Table className="min-w-[760px]">
        <Thead>
          <tr>
            <Th>Camera</Th>
            <Th>Road</Th>
            <Th>Vehicle</Th>
            <Th>Plate</Th>
            <Th className="text-right">Stationary for</Th>
            <Th className="text-right">Last seen (IST)</Th>
          </tr>
        </Thead>
        <tbody>
          {/* Keyed with the position as well: the same track can be listed
              twice (once per stop it made), and a duplicate key makes React
              drop or repeat rows. */}
          {sorted.slice(0, OBSTRUCTIONS_SHOWN).map((row, i) => (
            <Tr key={`${row.track_id}:${row.last_seen}:${i}`}>
              <Td>
                <span className="block font-mono text-xs text-foreground">{row.camera_code}</span>
                <span className="block max-w-[14rem] truncate text-[11px] text-faint">
                  {row.camera_name}
                </span>
              </Td>
              <Td className="text-muted-foreground">{row.corridor ?? '—'}</Td>
              <Td className="capitalize text-muted-foreground">{row.vehicle_type ?? '—'}</Td>
              <Td>
                {row.plate ? (
                  <PlateChip plate={row.plate} size="xs" />
                ) : (
                  <span className="text-[11px] text-faint">not read</span>
                )}
              </Td>
              <Td className="text-right font-mono tabular-nums text-foreground">
                {seconds(row.stationary_seconds)}
              </Td>
              <Td className="text-right font-mono text-xs tabular-nums text-muted-foreground">
                {api.formatIST(row.last_seen, false)}
              </Td>
            </Tr>
          ))}
        </tbody>
      </Table>
      {sorted.length > OBSTRUCTIONS_SHOWN && (
        <p className="mt-2 text-xs text-faint">
          The {OBSTRUCTIONS_SHOWN} longest of {sorted.length}.
        </p>
      )}
    </>
  )
}

function RouteDensityTable({ routes }: { routes: RouteDensityResponse }) {
  const busiest = Math.max(1, ...routes.pairs.map((p) => p.journeys))
  return (
    <Table className="min-w-[760px]">
      <Thead>
        <tr>
          <Th>Movement</Th>
          <Th>Corridor</Th>
          <Th>Journeys</Th>
          <Th className="text-right">Distance</Th>
          <Th className="text-right">Median gap</Th>
        </tr>
      </Thead>
      <tbody>
        {routes.pairs.map((pair) => (
          <Tr key={`${pair.from_camera}-${pair.to_camera}`}>
            <Td className="whitespace-nowrap font-mono text-xs text-foreground">
              {pair.from_camera}
              <Icon name="arrowRight" size={12} className="mx-1.5 inline text-faint" />
              {pair.to_camera}
            </Td>
            <Td className="text-xs text-muted-foreground">
              {pair.same_corridor
                ? (pair.to_corridor ?? '—')
                : `${pair.from_corridor ?? '?'} → ${pair.to_corridor ?? '?'}`}
            </Td>
            <Td>
              <div className="flex items-center gap-2.5">
                <span className="w-10 text-right font-mono tabular-nums text-foreground">
                  {pair.journeys}
                </span>
                <span className="h-1.5 w-24 overflow-hidden rounded-full bg-secondary">
                  <span
                    className="block h-full rounded-full"
                    style={{
                      width: `${Math.max(3, (pair.journeys / busiest) * 100)}%`,
                      background: seriesColor(0),
                    }}
                  />
                </span>
              </div>
            </Td>
            <Td className="text-right font-mono tabular-nums text-muted-foreground">
              ≥ {pair.distance_km} km
            </Td>
            <Td className="text-right font-mono tabular-nums text-muted-foreground">
              {seconds(pair.median_gap_seconds)}
            </Td>
          </Tr>
        ))}
      </tbody>
    </Table>
  )
}

/** Mirrors `analytics.py` MIN_BASELINE_SAMPLES, for the "n of 5" progress
 *  shown while a segment's baseline is still building. */
const BASELINE_SAMPLES_NEEDED = 5

function TravelTimeGrid({ travelTime }: { travelTime: TravelTimeResponse }) {
  return (
    <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-4">
      {travelTime.segments.slice(0, 12).map((segment) => {
        const slower = segment.delta_pct !== null && segment.delta_pct > 15
        return (
          <div
            key={`${segment.from_camera}-${segment.to_camera}`}
            className="rounded-md border border-border bg-background/40 px-3.5 py-3"
          >
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0">
                <p className="truncate font-mono text-xs text-foreground">
                  {segment.from_camera} → {segment.to_camera}
                </p>
                <p className="mt-0.5 truncate text-[11px] text-faint">
                  {segment.corridor ?? 'no corridor'}
                </p>
              </div>
              {segment.status === 'ok' ? (
                <Badge
                  tone={slower ? 'warning' : 'neutral'}
                  title={
                    segment.delta_pct !== null && segment.delta_pct < -15
                      ? 'Faster than this time of day usually is'
                      : undefined
                  }
                >
                  {slower && <SeverityGlyph priority="high" size={8} />}
                  {segment.delta_pct !== null
                    ? `${segment.delta_pct > 0 ? '+' : ''}${segment.delta_pct}%`
                    : 'baseline'}
                </Badge>
              ) : (
                <Badge tone="neutral">{segment.status.replace(/_/g, ' ')}</Badge>
              )}
            </div>
            <div className="mt-3 flex items-end gap-5">
              <div>
                <p className="eyebrow">Now</p>
                <p className="mt-0.5 font-mono text-lg leading-none text-foreground">
                  {seconds(segment.current_seconds)}
                </p>
              </div>
              <div className="min-w-0 flex-1">
                <p className="eyebrow">Baseline</p>
                {segment.status === 'insufficient_history' ? (
                  <div className="mt-1">
                    <p className="font-mono text-xs text-muted-foreground">
                      {segment.baseline_samples} of {BASELINE_SAMPLES_NEEDED} journeys
                    </p>
                    <div className="mt-1 h-1 overflow-hidden rounded-full bg-secondary">
                      <div
                        className="h-full rounded-full bg-muted-foreground/60"
                        style={{
                          width: `${Math.min(100, (segment.baseline_samples / BASELINE_SAMPLES_NEEDED) * 100)}%`,
                        }}
                      />
                    </div>
                  </div>
                ) : (
                  <p className="mt-0.5 font-mono text-sm text-muted-foreground">
                    {seconds(segment.baseline_seconds)}
                  </p>
                )}
              </div>
            </div>
          </div>
        )
      })}
    </div>
  )
}

// ── Forecast ─────────────────────────────────────────────────────────────

function ForecastSection({ congestion }: { congestion: CongestionResponse }) {
  if (congestion.series.length === 0) {
    return (
      <NoFigure
        kind="nothing"
        title={`No camera saw traffic in the last ${FORECAST_LOOKBACK_MIN} minutes.`}
        className="mt-3"
        needs="a camera records vehicles in the recent window the trend is fitted through."
      >
        A forecast extends each camera's recent trend, so it needs recent
        traffic before it can say anything.
      </NoFigure>
    )
  }

  const ready = congestion.series
    .filter((s) => s.status === 'ok' && s.current_index_pct !== null)
    .sort((a, b) => (b.current_index_pct ?? 0) - (a.current_index_pct ?? 0))
  const waiting = congestion.series.filter((s) => !ready.includes(s))
  // Said once when every camera is waiting for the same thing, rather than
  // repeated down the list.
  const reasons = new Set(waiting.map(waitingReason))
  const sharedReason = waiting.length > 1 && reasons.size === 1 ? [...reasons][0] : null

  return (
    <div className="mt-3 space-y-4">
      {ready.length === 0 ? (
        <NoFigure
          kind="history"
          title={`No forecast yet — ${congestion.series.length} camera${congestion.series.length === 1 ? ' has' : 's have'} recent traffic, none a baseline to forecast against.`}
          needs={`this hour of day has been observed on at least ${BASELINE_DAYS_NEEDED} of the previous ${congestion.baseline_window_days || BASELINE_WINDOW_DAYS} days. The figures then appear here unchanged in method — nothing is estimated in the meantime.`}
        >
          A forecast here is a camera's volume against its own typical volume
          for the hour, extended by its recent trend. Without that typical
          there is no 100% to measure against, so no percentage is shown.
        </NoFigure>
      ) : (
        <div className="grid gap-3 md:grid-cols-2 2xl:grid-cols-3">
          {ready.slice(0, 12).map((series) => (
            <ForecastCard key={series.key} series={series} />
          ))}
        </div>
      )}

      {waiting.length > 0 && (
        <div>
          <p className="eyebrow">
            Waiting for history · {waiting.length} camera{waiting.length === 1 ? '' : 's'}
          </p>
          {sharedReason && <p className="mt-1 text-xs text-faint">{sharedReason}</p>}
          <ul className="mt-2 divide-y divide-border/60 rounded-md border border-border">
            {waiting.map((series) => (
              <li
                key={series.key}
                className="flex flex-wrap items-center gap-x-4 gap-y-1 px-3 py-2 text-xs"
              >
                <span className="w-28 shrink-0 truncate font-mono text-foreground">{series.key}</span>
                <span className="min-w-0 flex-1 truncate text-muted-foreground">
                  {series.label !== series.key ? series.label : ''}
                  {series.corridor ? ` · ${series.corridor}` : ''}
                </span>
                {series.current_index_pct !== null && (
                  <span className="font-mono text-muted-foreground">
                    now {Math.round(series.current_index_pct)}%
                  </span>
                )}
                {!sharedReason && (
                  <span className="basis-full text-faint sm:basis-auto">{waitingReason(series)}</span>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}

function ForecastCard({ series }: { series: CongestionSeries }) {
  const now = series.current_index_pct
  const tone: BadgeTone =
    now !== null && now > INDEX_CRITICAL ? 'danger' : now !== null && now > INDEX_WARN ? 'warning' : 'neutral'
  const glyph: Priority | null = tone === 'danger' ? 'critical' : tone === 'warning' ? 'high' : null
  const mae = series.backtest.status === 'ok' ? series.backtest.mae_pct : null
  const horizons = series.forecasts.map((f) => ({ minutes: f.horizon_minutes, value: f.index_pct }))

  return (
    <article className="flex flex-col rounded-lg border border-border bg-background/40 px-4 py-3.5">
      <header className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="truncate text-[13px] font-medium text-foreground">{series.label}</h3>
          <p className="truncate font-mono text-[11px] text-faint">
            {series.key}
            {series.corridor ? ` · ${series.corridor}` : ''}
          </p>
        </div>
        {now !== null && (
          <Badge tone={tone} title="Current five-minute bucket against this camera's typical for the hour">
            {glyph && <SeverityGlyph priority={glyph} size={8} />}
            {Math.round(now)}% of typical
          </Badge>
        )}
      </header>

      <div className="mt-3 flex items-end gap-2">
        <Figure label="Now" value={now} strong />
        {horizons.map((h) => (
          <div key={h.minutes} className="flex items-end gap-2">
            <Icon name="arrowRight" size={13} className="mb-1 text-faint" />
            <Figure label={`+${h.minutes} min`} value={h.value} />
          </div>
        ))}
      </div>

      {now !== null && (
        <ForecastSpark now={now} horizons={horizons} mae={mae} className="mt-3" />
      )}

      <div className="mt-3 border-t border-border pt-2.5">
        <p className="eyebrow">Why</p>
        {series.factors.length > 0 ? (
          <ul className="mt-1.5 space-y-1">
            {series.factors.map((f) => (
              <li key={`${f.factor}:${f.detail}`} className="text-xs leading-snug">
                <span className="text-foreground">{factorLabel(f.factor)}</span>
                <span className="text-muted-foreground"> · {f.detail}</span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="mt-1 text-xs text-faint">The API returned no contributing factor.</p>
        )}
      </div>

      <p className="mt-2.5 text-[11px] text-faint">
        {mae !== null
          ? `Backtested error ±${mae} pts over ${series.backtest.samples} held-out buckets`
          : 'Not enough history yet to backtest this forecast — read it without an error bar.'}
      </p>
    </article>
  )
}

function Figure({ label, value, strong = false }: { label: string; value: number | null; strong?: boolean }) {
  return (
    <div>
      <p className="eyebrow">{label}</p>
      <p
        className={`mt-0.5 font-mono leading-none ${strong ? 'text-xl text-foreground' : 'text-base text-muted-foreground'}`}
      >
        {value !== null ? `${Math.round(value)}%` : '—'}
      </p>
    </div>
  )
}

/**
 * The forecast as a picture: now, the projection, the error band, and the
 * 100% line it is all measured against.
 *
 * Lines and the band are drawn in an SVG stretched to the card's width, with
 * non-scaling strokes; the markers and the label are HTML placed by
 * percentage. A stretched SVG turns circles into ovals and text into a smear,
 * and measuring the card in JavaScript to avoid that is more machinery than a
 * sixty-pixel chart deserves.
 */
function ForecastSpark({
  now,
  horizons,
  mae,
  className = '',
}: {
  now: number
  horizons: { minutes: number; value: number | null }[]
  mae: number | null
  className?: string
}) {
  const W = 320
  const H = 64
  const geometry = forecastGeometry(now, horizons, mae, W, H)
  const [observed, ...projected] = geometry.points
  if (!observed) return null
  const color = seriesColor(0)
  const left = (x: number) => `${(x / W) * 100}%`
  const top = (y: number) => `${(y / H) * 100}%`
  const described = [
    `${Math.round(now)}% of typical now`,
    ...horizons
      .filter((h) => h.value !== null)
      .map((h) => `${Math.round(h.value ?? 0)}% in ${h.minutes} minutes`),
  ].join(', ')
  return (
    <div
      role="img"
      aria-label={`Forecast: ${described}. Typical for this hour is 100%.`}
      className={`relative h-16 w-full ${className}`}
    >
      <svg
        viewBox={`0 0 ${W} ${H}`}
        preserveAspectRatio="none"
        aria-hidden="true"
        className="absolute inset-0 h-full w-full overflow-visible"
      >
        <line
          x1={0}
          x2={W}
          y1={geometry.typicalY}
          y2={geometry.typicalY}
          stroke="hsl(var(--input))"
          strokeWidth={1}
          vectorEffect="non-scaling-stroke"
        />
        {geometry.band && <polygon points={geometry.band} fill={color} opacity={0.16} />}
        {projected.length > 0 && (
          <polyline
            points={geometry.points.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ')}
            fill="none"
            stroke={color}
            strokeWidth={1.75}
            strokeDasharray="4 4"
            strokeLinecap="round"
            vectorEffect="non-scaling-stroke"
          />
        )}
      </svg>
      {projected.map((p) => (
        <span
          key={p.minutes}
          aria-hidden
          className="absolute h-[7px] w-[7px] -translate-x-1/2 -translate-y-1/2 rounded-full border-[1.5px] bg-card"
          style={{ left: left(p.x), top: top(p.y), borderColor: color }}
        />
      ))}
      <span
        aria-hidden
        className="absolute h-[9px] w-[9px] -translate-x-1/2 -translate-y-1/2 rounded-full ring-2 ring-card"
        style={{ left: left(observed.x), top: top(observed.y), background: color }}
      />
      <span
        aria-hidden
        className={`absolute right-0 font-mono text-[10px] leading-none text-faint ${
          geometry.typicalY > H / 2 ? '-translate-y-[calc(100%+3px)]' : 'translate-y-[3px]'
        }`}
        style={{ top: top(geometry.typicalY) }}
      >
        typical 100%
      </span>
    </div>
  )
}

/**
 * The corridor speed panel when no corridor has a figure — which, on the
 * replayed demo fleet, is the expected state. It says which of three
 * different situations this is, from the counts the API sends with it.
 */
function SpeedUnavailable({ speed }: { speed: SpeedResponse }) {
  const { legs_considered: considered, legs_excluded_implausible: excluded } = speed.provenance
  const short = speed.corridors.filter((c) => c.status !== 'ok')

  if (considered === 0) {
    return (
      <NoFigure
        kind="nothing"
        title="No journey legs in this window."
        className="mt-3"
        needs="the same plate is read on two cameras of one corridor, giving a distance and a time between them."
      >
        {speed.provenance.note}
      </NoFigure>
    )
  }

  if (excluded >= considered) {
    return (
      <NoFigure
        kind="implausible"
        title={`All ${considered.toLocaleString('en-IN')} observed legs were excluded as physically implausible.`}
        className="mt-3"
        needs="cameras report real timing — the figures then resolve unchanged."
      >
        This is the expected state on replayed demo footage: a looping clip
        makes the gap between two cameras seconds rather than minutes, which
        over the real distance would be hundreds of km/h. Publishing that as a
        speed would be the invented number this page exists to refuse.
      </NoFigure>
    )
  }

  return (
    <NoFigure
      kind="history"
      title="Too few plausible legs on any corridor to publish a speed."
      className="mt-3"
      needs="a corridor has enough plausible legs for its median to mean something."
    >
      {(considered - excluded).toLocaleString('en-IN')} of{' '}
      {considered.toLocaleString('en-IN')} legs were plausible
      {short.length > 0 && (
        <>
          , spread across:{' '}
          {short.map((c, i) => (
            <span key={c.corridor}>
              {i > 0 && ', '}
              <span className="text-foreground">{c.corridor}</span>{' '}
              <span className="font-mono">({c.samples})</span>
            </span>
          ))}
        </>
      )}
      .
    </NoFigure>
  )
}
