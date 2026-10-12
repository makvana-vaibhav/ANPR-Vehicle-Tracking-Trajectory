/**
 * Network · Fleet health — is the network answering, what is failing, and
 * where is the city blind.
 *
 * The gap report answers the question an operations lead actually asks —
 * *where is the city blind?* — which is not the same as *which cameras are
 * broken*. A district with no camera at all never appears in a fault list.
 *
 * Grey when normal: a figure takes colour only when it needs someone. The
 * per-camera probe history is opened from the gap report, the camera picker
 * or `?camera=<CODE>` — never by default — and reading it touches only the
 * health monitor's own record, never the camera.
 */

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import {
  Bar,
  BarChart,
  CartesianGrid,
  Rectangle,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
  type RectangleProps,
  type TooltipProps,
} from 'recharts'

import { SkeletonRows } from '@/components/Skeleton'
import {
  fetchAllCameras,
  findCamera,
  probeErrorWords,
  readCameraParam,
  STATUS_LABEL,
  vendorWords,
  withParams,
} from '@/components/network/cameraFacts'
import { bucketProbes, type ProbeBucket } from '@/components/network/probeHistory'
import {
  Button,
  EmptyState,
  ErrorBanner,
  Icon,
  PageHeader,
  Panel,
  PanelHeader,
  SegmentedControl,
  Select,
  StatTile,
  StatusBadge,
  Table,
  Tabs,
  Td,
  Th,
  Thead,
  Tr,
} from '@/components/ui'
import * as api from '@/lib/api'
import type {
  Camera,
  CameraHealthHistory,
  Department,
  FleetHealth as FleetHealthData,
  GapReport,
  IntegrationState,
} from '@/lib/types'

const REFRESH_MS = 30_000

/** The API returns at most this many probes of history per request. */
const HISTORY_CAP = 500

type GapTab = 'unavailable' | 'unreliable' | 'coverage' | 'capability' | 'ageing'
type HistoryWindow = '1' | '6' | '24'
type HistoryView = 'chart' | 'table'

/* Recharts takes colours as props, not classes, so the tokens are repeated
   here by value — keep them in step with styles/index.css. */
const GRID = '#1E2833' // --border: recessive
const TICK = '#7A8897' // --faint
const SERIES = '#5CC8FF' // --primary: the one series that is the point
const FAILED = '#FF5C55' // --status-offline: a probe nobody answered (drawn at 80%: ≥3:1 on --card)
const CURSOR = 'rgba(154, 169, 184, 0.08)' // a ghost of --muted-foreground
const TICK_STYLE = { fill: TICK, fontSize: 11, fontFamily: 'IBM Plex Mono, monospace' }

const CLOCK = new Intl.DateTimeFormat('en-IN', {
  timeZone: 'Asia/Kolkata',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
})
const clock = (ms: number) => CLOCK.format(new Date(ms))

/** The API sends `probes` on each reliability gap; the shared type omits it. */
type ReliabilityGap = GapReport['reliability_gaps'][number] & { probes?: number }

export default function FleetHealthPage() {
  const [params, setParams] = useSearchParams()
  const historyCode = readCameraParam(params)

  const [health, setHealth] = useState<FleetHealthData | null>(null)
  const [gaps, setGaps] = useState<GapReport | null>(null)
  const [cameras, setCameras] = useState<Camera[] | null>(null)
  const [departments, setDepartments] = useState<Department[]>([])
  const [error, setError] = useState<string | null>(null)
  const historyRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    async function load() {
      try {
        const [h, g] = await Promise.all([api.getFleetHealth(), api.getGapReport(24)])
        setHealth(h)
        setGaps(g)
        setError(null)
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err))
      }
    }
    void load()
    const timer = window.setInterval(() => void load(), REFRESH_MS)
    return () => window.clearInterval(timer)
  }, [])

  // The camera list (for the history picker) and department names change
  // rarely; read once.
  useEffect(() => {
    fetchAllCameras()
      .then(setCameras)
      .catch(() => setCameras([]))
    api
      .getDepartments()
      .then(setDepartments)
      .catch(() => undefined)
  }, [])

  const openHistory = useCallback(
    (code: string | null, scroll = false) => {
      setParams((prev) => withParams(prev, { camera: code }), { replace: true })
      if (code && scroll) {
        window.requestAnimationFrame(() =>
          historyRef.current?.scrollIntoView?.({ behavior: 'smooth', block: 'start' }),
        )
      }
    },
    [setParams],
  )

  const historyCamera = findCamera(cameras ?? [], historyCode)
  const departmentName = useMemo(
    () => new Map(departments.map((d) => [d.code, d.name])),
    [departments],
  )
  const failedProbes = health?.top_errors.reduce((sum, e) => sum + e.count, 0) ?? 0

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="space-y-5 px-6 pb-8 pt-5">
        <PageHeader
          title="Fleet health"
          subtitle={
            <>
              <span>{health ? `${health.total} cameras` : 'loading…'}</span>
              <span className="text-faint">·</span>
              <span>where coverage is missing, and why</span>
              {health && (
                <>
                  <span className="text-faint">·</span>
                  <span>updated {api.relativeTime(health.generated_at)}</span>
                </>
              )}
            </>
          }
        />

        {error && <ErrorBanner>{error}</ErrorBanner>}

        {health?.integrations?.map((integration) => (
          <IntegrationNotice key={integration.vms_id} integration={integration} />
        ))}

        {/* Availability. "State unknown" appears only when it is non-zero: a
            card permanently reading 0, explaining a state that no longer
            normally occurs, is how a screen stops being read at all. */}
        <section
          className={`grid gap-3 sm:grid-cols-2 ${
            health != null && health.unknown > 0 ? 'xl:grid-cols-4' : 'xl:grid-cols-3'
          }`}
        >
          <StatTile
            label="Answering"
            value={health ? `${health.online} / ${health.total}` : '—'}
            detail={
              health
                ? health.stale
                  ? `${health.availability_pct}% · ${health.stale} shown as last known`
                  : `${health.availability_pct}% of the registry`
                : undefined
            }
            info="Cameras whose status says they deliver video. Debounced: a status changes only after several probes in a row agree. When an integration refuses or does not answer, its cameras keep their last known status — marked “last known” — instead of flipping; video an AI worker is receiving counts as an answer."
          />
          <StatTile
            label="Offline"
            value={health?.offline ?? '—'}
            detail="integration answers, no video"
            tone={health && health.offline > 0 ? 'bad' : undefined}
          />
          <StatTile
            label="Degraded"
            value={health?.degraded ?? '—'}
            detail="video late, or dropping frames"
            tone={health && health.degraded > 0 ? 'warn' : undefined}
          />
          {health != null && health.unknown > 0 && (
            <StatTile
              label="State unknown"
              value={health.unknown}
              detail="never confirmed, or not probed yet"
              tone="warn"
              info="Cameras no probe has yet been able to confirm either way — onboarded recently, or behind an integration that has not answered since. A refusal by the organisers' grid no longer moves cameras here: they keep their last known status, marked as such."
            />
          )}
        </section>

        <div className="grid gap-5 xl:grid-cols-[minmax(0,1.65fr)_minmax(0,1fr)]">
          <div className="min-w-0 space-y-5">
            <GapPanel gaps={gaps} onOpenCamera={(code) => openHistory(code, true)} />
            <div ref={historyRef} className="scroll-mt-4">
              <HistoryPanel
                cameras={cameras}
                camera={historyCamera}
                missingCode={cameras && historyCode && !historyCamera ? historyCode : null}
                onPick={(code) => openHistory(code)}
              />
            </div>
          </div>

          <div className="min-w-0 space-y-5">
            {/* Failure causes */}
            <Panel>
              <PanelHeader
                title="What is failing"
                caption={
                  health
                    ? failedProbes > 0
                      ? `${failedProbes.toLocaleString('en-IN')} failed probes in the last hour`
                      : 'no failed probes in the last hour'
                    : undefined
                }
                info="Grouped by cause, so one root cause reads as one problem rather than as forty separate failures. Counts are probes, not cameras: every camera is probed every few seconds."
              />
              {health === null ? (
                <div className="mt-3">
                  <SkeletonRows rows={2} height="h-8" />
                </div>
              ) : health.top_errors.length === 0 ? (
                <p className="mt-3 text-xs text-faint">Every probe in the last hour was answered.</p>
              ) : (
                <ul className="mt-3 space-y-3">
                  {health.top_errors.map((e) => (
                    <li key={e.error_code}>
                      <div className="flex items-baseline justify-between gap-3">
                        <span className="text-[13px]">{probeErrorWords(e.error_code)}</span>
                        <span className="shrink-0 font-mono text-xs text-muted-foreground">
                          {e.count.toLocaleString('en-IN')}
                        </span>
                      </div>
                      <div className="mt-1 flex items-center gap-2">
                        <span className="shrink-0 font-mono text-[11px] text-faint">{e.error_code}</span>
                        <span className="h-1 flex-1 overflow-hidden rounded-full bg-secondary">
                          <span
                            className="block h-full rounded-full bg-status-offline/70"
                            style={{ width: `${(e.count / Math.max(failedProbes, 1)) * 100}%` }}
                          />
                        </span>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </Panel>

            {/* Per department */}
            <Panel>
              <PanelHeader
                title="By department"
                caption="answering of registered"
                info="Cameras answering against cameras registered, per owning department. A department below full strength is a maintenance question rather than an alert."
              />
              {health === null ? (
                <div className="mt-3">
                  <SkeletonRows rows={4} height="h-5" />
                </div>
              ) : (
                <ul className="mt-3 space-y-2.5">
                  {health.by_department.map((row) => (
                    <MeterRow
                      key={row.department}
                      label={row.department}
                      title={departmentName.get(row.department)}
                      online={row.online}
                      degraded={row.degraded}
                      offline={row.offline}
                      total={row.total}
                    />
                  ))}
                </ul>
              )}
              <MeterLegend />
            </Panel>

            {/* Vendor breadth — the interoperability evidence */}
            <Panel>
              <PanelHeader
                title="By integration"
                info="One adapter interface reaching every integration here. Adding another kind of recorder is one class plus one registry entry; nothing else in the platform changes."
              />
              {health === null ? (
                <div className="mt-3">
                  <SkeletonRows rows={2} height="h-5" />
                </div>
              ) : (
                <ul className="mt-3 space-y-2.5">
                  {health.by_vendor.map((row) => (
                    <MeterRow
                      key={row.vendor}
                      label={vendorWords(row.vendor)}
                      sublabel={row.vendor}
                      online={row.online}
                      degraded={0}
                      offline={0}
                      total={row.total}
                      wide
                    />
                  ))}
                </ul>
              )}
            </Panel>
          </div>
        </div>
      </div>
    </div>
  )
}

// ── Coverage and reliability gaps ─────────────────────────────────────────

function GapPanel({
  gaps,
  onOpenCamera,
}: {
  gaps: GapReport | null
  onOpenCamera: (code: string) => void
}) {
  const counts: Record<GapTab, number> = {
    unavailable: gaps?.availability_gaps.length ?? 0,
    unreliable: gaps?.reliability_gaps.length ?? 0,
    coverage: gaps?.coverage_gaps.length ?? 0,
    capability: gaps?.capability_gaps.length ?? 0,
    ageing: (gaps?.ageing_gaps?.length ?? 0) + (gaps?.install_date_unknown?.cameras ?? 0),
  }
  // Open on the most urgent kind that has anything in it.
  const order: GapTab[] = ['unavailable', 'unreliable', 'coverage', 'capability', 'ageing']
  const [chosen, setChosen] = useState<GapTab | null>(null)
  const tab = chosen ?? order.find((t) => counts[t] > 0) ?? 'unavailable'

  const badge = (n: number) => (
    <span
      className={`rounded px-1.5 font-mono text-[10px] ${
        n > 0 ? 'bg-priority-high/15 text-priority-high' : 'bg-secondary text-faint'
      }`}
    >
      {n}
    </span>
  )

  return (
    // Not a Panel: the tabs and tables run edge to edge, and Panel's own
    // padding cannot be taken off from the call site.
    <section className="overflow-hidden rounded-lg border border-border bg-card">
      <div className="px-4 pt-4">
        <PanelHeader
          title="Where the network is blind"
          caption={gaps ? `last ${gaps.window_hours} hours` : undefined}
          info="Five failure modes, kept apart because each needs a different response: fix the camera, steady a flapping one, install a camera where there is none, add plate reading where there is too little, or replace ageing equipment. Districts are Gujarat's 33, by each camera's position; a recorded clip or a camera with no known position covers no district. Unreliable means below 90% uptime over the probes that got an answer; the ANPR target is a share of a district's cameras."
          action={<GapReportDownload hours={gaps?.window_hours ?? 24} />}
        />
      </div>
      <div className="mt-3 px-2">
        <Tabs
          value={tab}
          onChange={setChosen}
          tabs={[
            { value: 'unavailable', label: 'Unavailable', badge: badge(counts.unavailable) },
            { value: 'unreliable', label: 'Unreliable', badge: badge(counts.unreliable) },
            { value: 'coverage', label: 'No cameras', badge: badge(counts.coverage) },
            { value: 'capability', label: 'Below ANPR target', badge: badge(counts.capability) },
            { value: 'ageing', label: 'Ageing', badge: badge(counts.ageing) },
          ]}
        />
      </div>

      <div className="max-h-[22rem] overflow-y-auto">
        {gaps === null ? (
          <div className="p-4">
            <SkeletonRows rows={4} height="h-8" />
          </div>
        ) : counts[tab] === 0 ? (
          <div className="p-4">
            <EmptyState title={GAP_EMPTY[tab]} />
          </div>
        ) : tab === 'unavailable' ? (
          <Table bare>
            <Thead>
              <tr>
                <Th>Camera</Th>
                <Th>District</Th>
                <Th>Department</Th>
                <Th>Status</Th>
              </tr>
            </Thead>
            <tbody>
              {gaps.availability_gaps.map((g) => (
                <CameraRow key={g.camera_code} code={g.camera_code} name={g.name} onOpen={onOpenCamera}>
                  <Td className="text-muted-foreground">{g.district ?? '—'}</Td>
                  <Td className="font-mono text-xs text-muted-foreground">{g.department}</Td>
                  <Td>
                    <StatusLabel status={g.status} />
                  </Td>
                </CameraRow>
              ))}
            </tbody>
          </Table>
        ) : tab === 'unreliable' ? (
          <Table bare>
            <Thead>
              <tr>
                <Th>Camera</Th>
                <Th>District</Th>
                <Th className="text-right">Uptime</Th>
                <Th className="text-right">Probes</Th>
              </tr>
            </Thead>
            <tbody>
              {(gaps.reliability_gaps as ReliabilityGap[]).map((g) => (
                <CameraRow key={g.camera_code} code={g.camera_code} name={g.name} onOpen={onOpenCamera}>
                  <Td className="text-muted-foreground">{g.district ?? 'position not known'}</Td>
                  <Td className="text-right font-mono text-xs">{g.uptime_pct}%</Td>
                  <Td className="text-right font-mono text-xs text-muted-foreground">
                    {g.probes?.toLocaleString('en-IN') ?? '—'}
                  </Td>
                </CameraRow>
              ))}
            </tbody>
          </Table>
        ) : tab === 'ageing' ? (
          <AgeingGaps gaps={gaps} onOpenCamera={onOpenCamera} />
        ) : tab === 'coverage' ? (
          <div className="px-4 py-3">
            <p className="text-xs text-faint">
              Gujarat districts ({gaps.coverage_gaps.length} of {gaps.geography?.districts ?? 33})
              with no camera whose position is known. A vehicle can cross these entirely
              unobserved.
            </p>
            <NotCounted gaps={gaps} />
            <ul className="mt-2.5 flex flex-wrap gap-1.5">
              {gaps.coverage_gaps.map((g) => (
                <li
                  key={g.district}
                  title={g.reason}
                  className="rounded-md border border-border bg-secondary/40 px-2 py-0.5 text-xs"
                >
                  {g.district}
                </li>
              ))}
            </ul>
          </div>
        ) : (
          <Table bare>
            <Thead>
              <tr>
                <Th>District</Th>
                <Th className="text-right">Cameras</Th>
                <Th className="text-right">ANPR</Th>
                <Th className="text-right">Share</Th>
              </tr>
            </Thead>
            <tbody>
              {gaps.capability_gaps.map((g) => (
                <Tr key={g.district}>
                  <Td title={g.reason}>{g.district}</Td>
                  <Td className="text-right font-mono text-xs">{g.cameras}</Td>
                  <Td className="text-right font-mono text-xs">{g.anpr_cameras}</Td>
                  <Td className="text-right font-mono text-xs">{Math.round(g.anpr_share * 100)}%</Td>
                </Tr>
              ))}
            </tbody>
          </Table>
        )}
      </div>
    </section>
  )
}

/**
 * The gap report as a CSV file — the same analysis, one row per gap, times in
 * IST and UTC — for whoever has to act on it. The download is audited.
 * Its outcome is said beside the button rather than in a toast, so it stays
 * readable for as long as the panel is on screen.
 */
function GapReportDownload({ hours }: { hours: number }) {
  const [state, setState] = useState<
    { kind: 'idle' } | { kind: 'busy' } | { kind: 'saved'; name: string } | { kind: 'failed'; message: string }
  >({ kind: 'idle' })

  async function download() {
    setState({ kind: 'busy' })
    try {
      setState({ kind: 'saved', name: await api.downloadGapReport(hours) })
    } catch (err) {
      setState({ kind: 'failed', message: err instanceof Error ? err.message : String(err) })
    }
  }

  return (
    <div className="flex shrink-0 items-center gap-2">
      {state.kind === 'saved' && (
        <span className="hidden max-w-[14rem] truncate text-[11px] text-faint sm:inline" title={state.name}>
          Saved {state.name}
        </span>
      )}
      {state.kind === 'failed' && (
        <span role="alert" className="max-w-[16rem] truncate text-[11px] text-status-offline" title={state.message}>
          {state.message}
        </span>
      )}
      <Button
        variant="outline"
        size="sm"
        onClick={() => void download()}
        disabled={state.kind === 'busy'}
        title={`One row per gap over the last ${hours} hours, as CSV`}
      >
        <Icon name="download" size={14} />
        {state.kind === 'busy' ? 'Preparing…' : 'Download gap report'}
      </Button>
    </div>
  )
}

const GAP_EMPTY: Record<GapTab, string> = {
  unavailable: 'Every registered camera is delivering video.',
  unreliable: 'No camera dropped below the uptime target in this window.',
  coverage: 'Every Gujarat district has at least one camera.',
  capability: 'Every district meets the plate-reading target.',
  ageing: 'Every camera has an install date, and none is due for review.',
}

/** Cameras the district counts leave out, by name: a looping clip covers no
 *  road, and a camera nobody can place covers no district. */
function NotCounted({ gaps }: { gaps: GapReport }) {
  const geo = gaps.geography
  if (!geo) return null
  const parts = [
    geo.position_unknown.length > 0 &&
      `${geo.position_unknown.length} with no known position (${geo.position_unknown.join(', ')})`,
    geo.recorded_footage.length > 0 &&
      `${geo.recorded_footage.length} recorded clip${geo.recorded_footage.length === 1 ? '' : 's'} (${geo.recorded_footage.join(', ')})`,
    geo.outside_gujarat.length > 0 && `${geo.outside_gujarat.length} outside Gujarat`,
  ].filter(Boolean)
  if (parts.length === 0) return null
  return <p className="mt-1.5 text-[11px] text-faint">Not counted in any district: {parts.join('; ')}.</p>
}

/** Equipment due for review by age — and, said plainly, cameras whose install
 *  date the registry does not hold. No date is ever assumed. */
function AgeingGaps({
  gaps,
  onOpenCamera,
}: {
  gaps: GapReport
  onOpenCamera: (code: string) => void
}) {
  const ageing = gaps.ageing_gaps ?? []
  const undated = gaps.install_date_unknown
  return (
    <div>
      {undated && undated.cameras > 0 && (
        <div className="border-b border-border px-4 py-3">
          <p className="text-[13px]">
            Install date unknown for {undated.cameras} camera{undated.cameras === 1 ? '' : 's'}
          </p>
          <p className="mt-0.5 text-[11px] text-faint">
            {undated.reason} The CSV lists each one.
          </p>
        </div>
      )}
      {ageing.length > 0 && (
        <Table bare>
          <Thead>
            <tr>
              <Th>Camera</Th>
              <Th>District</Th>
              <Th className="text-right">Installed</Th>
              <Th className="text-right">Age</Th>
            </tr>
          </Thead>
          <tbody>
            {ageing.map((g) => (
              <CameraRow key={g.camera_code} code={g.camera_code} name={g.name} onOpen={onOpenCamera}>
                <Td className="text-muted-foreground">{g.district ?? '—'}</Td>
                <Td className="text-right font-mono text-xs">{g.installed_on}</Td>
                <Td className="text-right font-mono text-xs">{g.age_years} y</Td>
              </CameraRow>
            ))}
          </tbody>
        </Table>
      )}
    </div>
  )
}

const IST_TIME = new Intl.DateTimeFormat('en-IN', {
  timeZone: 'Asia/Kolkata',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
})

/**
 * One line for an integration that could not be asked about its cameras —
 * the same incident the one integration alarm describes, in the same words.
 */
function IntegrationNotice({ integration }: { integration: IntegrationState }) {
  const refused = integration.state === 'refused'
  const last = integration.last_answered_at
    ? `last answered ${IST_TIME.format(new Date(integration.last_answered_at))} IST`
    : 'no answer in the last 24 h'
  return (
    <div
      role="status"
      className="rounded-lg border border-priority-medium/40 bg-priority-medium/[0.06] px-4 py-3"
    >
      <p className="text-[13px] font-medium">
        {refused
          ? `${integration.name} is refusing our session — its cooldown`
          : `${integration.name} is not answering`}
      </p>
      <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">
        {integration.cameras_held} cameras keep their last known status, marked “last known”, until
        it answers again ({last}). Where an AI worker is still receiving a camera’s video, that
        camera counts as answering.{' '}
        {integration.alarm_open_since
          ? `One alarm is open for this, since ${IST_TIME.format(new Date(integration.alarm_open_since))} IST.`
          : 'An alarm opens only if this lasts a minute or more.'}
      </p>
    </div>
  )
}

function CameraRow({
  code,
  name,
  onOpen,
  children,
}: {
  code: string
  name: string
  onOpen: (code: string) => void
  children: ReactNode
}) {
  return (
    <Tr
      tabIndex={0}
      onClick={() => onOpen(code)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') onOpen(code)
      }}
      title="Show this camera's probe history"
      className="cursor-pointer"
    >
      <Td>
        <span className="camera-code block text-[11px] text-muted-foreground">{code}</span>
        <span className="block max-w-[18rem] truncate">{name}</span>
      </Td>
      {children}
    </Tr>
  )
}

function StatusLabel({ status }: { status: string }) {
  if (status === 'online' || status === 'offline' || status === 'degraded' || status === 'unknown') {
    return <StatusBadge status={status} label={STATUS_LABEL[status]} />
  }
  return <span className="text-xs text-muted-foreground">{status}</span>
}

// ── Meters ────────────────────────────────────────────────────────────────

function MeterRow({
  label,
  sublabel,
  title,
  online,
  degraded,
  offline,
  total,
  wide = false,
}: {
  label: string
  sublabel?: string
  title?: string
  online: number
  degraded: number
  offline: number
  total: number
  wide?: boolean
}) {
  const rest = Math.max(0, total - online - degraded - offline)
  // One flex track, a 2 px gap between parts, each part as wide as its count.
  const parts = [
    { n: online, className: 'bg-status-online', name: 'answering' },
    { n: degraded, className: 'bg-status-degraded', name: 'degraded' },
    { n: offline, className: 'bg-status-offline', name: 'offline' },
    { n: rest, className: 'bg-secondary', name: 'not answering' },
  ].filter((part) => part.n > 0)

  return (
    <li
      className={`grid items-center gap-3 ${
        wide ? 'grid-cols-[12rem_minmax(0,1fr)_3.5rem]' : 'grid-cols-[6.5rem_minmax(0,1fr)_3.5rem]'
      }`}
    >
      <span className="min-w-0 truncate" title={title}>
        <span className={sublabel ? 'text-[13px]' : 'font-mono text-xs'}>{label}</span>
        {sublabel && <span className="ml-1.5 font-mono text-[11px] text-faint">{sublabel}</span>}
      </span>
      <span
        className="flex h-1.5 gap-[2px] overflow-hidden rounded-full"
        role="img"
        aria-label={`${online} of ${total} answering`}
      >
        {parts.map((part) => (
          <span
            key={part.name}
            className={`h-full ${part.className}`}
            style={{ flexGrow: part.n, flexBasis: 0 }}
          />
        ))}
      </span>
      <span className="text-right font-mono text-[11px] text-muted-foreground">
        {online}/{total}
      </span>
    </li>
  )
}

function MeterLegend() {
  return (
    <p className="mt-3 flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-faint">
      <Key className="bg-status-online">Answering</Key>
      <Key className="bg-status-degraded">Degraded</Key>
      <Key className="bg-status-offline">Offline</Key>
      <Key className="bg-secondary">Not answering</Key>
    </p>
  )
}

function Key({ className, children }: { className: string; children: ReactNode }) {
  return (
    <span className="flex items-center gap-1.5">
      <span aria-hidden="true" className={`h-1.5 w-3 rounded-full ${className}`} />
      {children}
    </span>
  )
}

// ── One camera's probe history ────────────────────────────────────────────

function HistoryPanel({
  cameras,
  camera,
  missingCode,
  onPick,
}: {
  cameras: Camera[] | null
  camera: Camera | null
  missingCode: string | null
  onPick: (code: string | null) => void
}) {
  const [hours, setHours] = useState<HistoryWindow>('24')
  const [view, setView] = useState<HistoryView>('chart')
  const [history, setHistory] = useState<CameraHealthHistory | null>(null)
  const [failed, setFailed] = useState(false)
  const cameraId = camera?.id ?? null

  useEffect(() => {
    setHistory(null)
    setFailed(false)
    if (!cameraId) return
    let cancelled = false
    const read = () =>
      api
        .getCameraHealth(cameraId, Number(hours))
        .then((body) => {
          if (!cancelled) setHistory(body)
        })
        .catch(() => {
          if (!cancelled) setFailed(true)
        })
    void read()
    const timer = window.setInterval(() => void read(), REFRESH_MS)
    return () => {
      cancelled = true
      window.clearInterval(timer)
    }
  }, [cameraId, hours])

  const buckets = useMemo(() => (history ? bucketProbes(history.history) : []), [history])
  const capped = history !== null && history.history.length >= HISTORY_CAP
  const oldest = history?.history[history.history.length - 1]?.ts
  const sorted = useMemo(
    () => [...(cameras ?? [])].sort((a, b) => a.camera_code.localeCompare(b.camera_code)),
    [cameras],
  )

  return (
    <Panel>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <PanelHeader
          title="Probe history"
          caption={camera ? `${camera.camera_code} · ${camera.name}` : 'one camera at a time'}
          info="Every camera is probed every few seconds; each probe either finds it answering or records why not. The history is the monitor's own record — reading it never contacts the camera. Grid cameras are probed through the grid's catalogue, whose round trip is the grid's rather than the camera's, so none is recorded for them. Probes the integration refused are shown as unanswered here but are not counted in uptime."
        />
        <div className="flex flex-wrap items-center gap-2">
          {/* A fixed box: the kit's controls fill their container. */}
          <div className="w-60">
            <Select
              aria-label="Camera"
              value={camera?.camera_code ?? ''}
              onChange={(e) => onPick(e.target.value || null)}
              className="h-8 py-0"
              disabled={cameras === null}
            >
              <option value="">{cameras === null ? 'Loading cameras…' : 'Choose a camera…'}</option>
              {sorted.map((c) => (
                <option key={c.id} value={c.camera_code}>
                  {c.camera_code} · {c.name}
                </option>
              ))}
            </Select>
          </div>
          <SegmentedControl
            value={hours}
            onChange={setHours}
            options={[
              { value: '1', label: '1 h' },
              { value: '6', label: '6 h' },
              { value: '24', label: '24 h' },
            ]}
          />
          <SegmentedControl
            value={view}
            onChange={setView}
            options={[
              { value: 'chart', label: 'Chart' },
              { value: 'table', label: 'Table' },
            ]}
          />
        </div>
      </div>

      {!camera ? (
        <EmptyState
          className="mt-4"
          title={
            missingCode
              ? `No camera ${missingCode} in the registry.`
              : 'Choose a camera to see how it has answered.'
          }
          hint="Or pick one from the gap report above."
        />
      ) : failed ? (
        <p className="mt-4 text-xs text-status-offline">Probe history could not be loaded.</p>
      ) : history === null ? (
        <div className="mt-4">
          <SkeletonRows rows={3} height="h-12" />
        </div>
      ) : history.history.length === 0 ? (
        <EmptyState className="mt-4" title={`Not probed in the last ${hours} h.`} />
      ) : (
        <>
          <div className="mt-4 flex flex-wrap items-center gap-x-6 gap-y-2">
            <StatusBadge status={history.status} label={STATUS_LABEL[history.status]} />
            <Figure
              label={`Uptime, ${hours} h`}
              value={history.uptime.uptime_pct !== null ? `${history.uptime.uptime_pct}%` : '—'}
            />
            <Figure label="Probes" value={history.uptime.probes.toLocaleString('en-IN')} />
            <Figure
              label="Mean latency"
              value={
                history.uptime.avg_latency_ms !== null
                  ? `${Math.round(history.uptime.avg_latency_ms).toLocaleString('en-IN')} ms`
                  : '—'
              }
            />
            {history.uptime.avg_fps !== null && (
              <Figure label="Frame rate" value={`${history.uptime.avg_fps} fps`} />
            )}
            <Link
              to={`/cameras?camera=${encodeURIComponent(history.camera_code)}`}
              className="ml-auto text-xs text-primary hover:underline"
            >
              Open in the registry
            </Link>
          </div>
          <p className="mt-2 text-[11px] text-faint">
            {capped && oldest
              ? `Charted: the latest ${HISTORY_CAP} probes, since ${clock(Date.parse(oldest))} IST. The figures above cover the whole ${hours} h.`
              : `Charted: every probe in the last ${hours} h.`}{' '}
            Times are IST.
          </p>

          {view === 'chart' ? <HistoryCharts buckets={buckets} /> : <HistoryTable buckets={buckets} />}
        </>
      )}
    </Panel>
  )
}

function Figure({ label, value }: { label: string; value: string }) {
  return (
    <span>
      <span className="block text-[10px] font-medium uppercase tracking-[0.06em] text-faint">{label}</span>
      <span className="font-mono text-sm">{value}</span>
    </span>
  )
}

function HistoryCharts({ buckets }: { buckets: ProbeBucket[] }) {
  const measured = buckets.some((b) => b.latencyMs !== null)
  const width = buckets[0] ? Math.round((buckets[0].end - buckets[0].start) / 60_000) : 0

  return (
    <div className="mt-4 space-y-5">
      <figure>
        <figcaption className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs">
          <span className="text-muted-foreground">Share of probes answered, per {width} min</span>
          <span className="flex items-center gap-1.5 text-faint">
            <span aria-hidden="true" className="h-2 w-2 rounded-sm" style={{ background: SERIES }} />
            Answered
          </span>
          <span className="flex items-center gap-1.5 text-faint">
            <span
              aria-hidden="true"
              className="h-2 w-2 rounded-sm opacity-80"
              style={{ background: FAILED }}
            />
            Did not answer
          </span>
          <span className="text-faint">· a gap is a stretch with no probes at all</span>
        </figcaption>
        <div className="mt-2 h-44">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={buckets} margin={{ top: 6, right: 8, bottom: 0, left: 0 }} barCategoryGap={2}>
              <CartesianGrid vertical={false} stroke={GRID} />
              <XAxis
                dataKey="start"
                tickFormatter={clock}
                tick={TICK_STYLE}
                tickLine={false}
                axisLine={{ stroke: GRID }}
                minTickGap={28}
              />
              <YAxis
                domain={[0, 100]}
                ticks={[0, 50, 100]}
                tickFormatter={(v: number) => `${v}%`}
                tick={TICK_STYLE}
                tickLine={false}
                axisLine={false}
                width={44}
              />
              <Tooltip cursor={{ fill: CURSOR }} content={<BucketTooltip />} isAnimationActive={false} />
              <Bar
                dataKey="answeredPct"
                stackId="probes"
                fill={SERIES}
                maxBarSize={24}
                shape={<AnsweredBar />}
                isAnimationActive={false}
              />
              <Bar
                dataKey="failedPct"
                stackId="probes"
                fill={FAILED}
                fillOpacity={0.8}
                radius={[4, 4, 0, 0]}
                maxBarSize={24}
                isAnimationActive={false}
              />
            </BarChart>
          </ResponsiveContainer>
        </div>
      </figure>

      <figure>
        <figcaption className="text-xs text-muted-foreground">
          Median round trip per {width} min, milliseconds
          {!measured && <span className="text-faint"> · none measured in this window</span>}
        </figcaption>
        <div className="mt-2 h-32">
          <ResponsiveContainer width="100%" height="100%">
            {/* Columns, like the chart above: each value is one bucket's
                median, and a line would draw a continuity between buckets
                that was never measured. Same layout, so the times line up. */}
            <BarChart data={buckets} margin={{ top: 6, right: 8, bottom: 0, left: 0 }} barCategoryGap={2}>
              <CartesianGrid vertical={false} stroke={GRID} />
              <XAxis
                dataKey="start"
                tickFormatter={clock}
                tick={TICK_STYLE}
                tickLine={false}
                axisLine={{ stroke: GRID }}
                minTickGap={28}
              />
              <YAxis
                tickFormatter={(v: number) => v.toLocaleString('en-IN')}
                tick={TICK_STYLE}
                tickLine={false}
                axisLine={false}
                width={44}
                tickCount={3}
                allowDecimals={false}
              />
              <Tooltip cursor={{ fill: CURSOR }} content={<BucketTooltip />} isAnimationActive={false} />
              <Bar
                dataKey="latencyMs"
                fill={SERIES}
                radius={[4, 4, 0, 0]}
                maxBarSize={24}
                isAnimationActive={false}
              />
            </BarChart>
          </ResponsiveContainer>
        </div>
      </figure>
    </div>
  )
}

/** The answered segment is the top of its column when nothing failed, and
 *  then takes the rounded data-end; under a failed segment it stays square. */
function AnsweredBar(props: RectangleProps & { payload?: ProbeBucket }) {
  const { payload, ...rest } = props
  return <Rectangle {...rest} radius={payload?.failedPct ? 0 : [4, 4, 0, 0]} />
}

function BucketTooltip({ active, payload }: TooltipProps<number, string>) {
  const bucket = payload?.[0]?.payload as ProbeBucket | undefined
  if (!active || !bucket) return null
  return (
    <div className="rounded-md border border-border bg-popover px-3 py-2 text-xs shadow-xl">
      <p className="font-mono text-[11px] text-muted-foreground">
        {clock(bucket.start)}–{clock(bucket.end)} IST
      </p>
      {bucket.probes === 0 ? (
        <p className="mt-1 text-faint">No probes in this stretch</p>
      ) : (
        <>
          <p className="mt-1">
            <span className="font-mono text-[13px] text-foreground">{bucket.answeredPct}%</span>{' '}
            <span className="text-muted-foreground">
              answered · {bucket.answered} of {bucket.probes}
            </span>
          </p>
          <p className="mt-0.5 text-muted-foreground">
            {bucket.latencyMs !== null ? (
              <>
                <span className="font-mono text-foreground">{Math.round(bucket.latencyMs)} ms</span>{' '}
                median round trip
              </>
            ) : (
              'No round trip measured'
            )}
          </p>
          {bucket.topError && (
            <p className="mt-0.5 flex items-center gap-1.5 text-muted-foreground">
              <span aria-hidden="true" className="h-[2px] w-3 rounded-full bg-status-offline" />
              {probeErrorWords(bucket.topError)}
            </p>
          )}
        </>
      )}
    </div>
  )
}

function HistoryTable({ buckets }: { buckets: ProbeBucket[] }) {
  return (
    <div className="mt-4 max-h-80 overflow-y-auto">
      <Table>
        <Thead>
          <tr>
            <Th>From (IST)</Th>
            <Th className="text-right">Probes</Th>
            <Th className="text-right">Answered</Th>
            <Th className="text-right">Median round trip</Th>
            <Th>Most common failure</Th>
          </tr>
        </Thead>
        <tbody>
          {[...buckets].reverse().map((b) => (
            <Tr key={b.start}>
              <Td className="font-mono text-xs">
                {clock(b.start)}–{clock(b.end)}
              </Td>
              <Td className="text-right font-mono text-xs">{b.probes}</Td>
              <Td className="text-right font-mono text-xs">
                {b.answeredPct === null ? '—' : `${b.answeredPct}%`}
              </Td>
              <Td className="text-right font-mono text-xs">
                {b.latencyMs === null ? '—' : `${Math.round(b.latencyMs)} ms`}
              </Td>
              <Td className="text-xs text-muted-foreground">
                {b.topError ? probeErrorWords(b.topError) : '—'}
              </Td>
            </Tr>
          ))}
        </tbody>
      </Table>
    </div>
  )
}
