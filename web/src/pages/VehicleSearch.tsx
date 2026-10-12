/**
 * Investigate: a plate in, a journey out.
 *
 * This is Judge Moment 4 — type a plate, get every sighting and a route drawn
 * across cameras with timestamps and implied speeds — and Moment 5, search.
 * `/vehicles?plate=GJ03AB1234` opens a journey directly: the ⌘K palette and
 * any screen that shows a plate link here that way (see `vehicleSearchUrl`).
 *
 * ## What this screen is careful about
 *
 * The route is inference, and the screen says so in three places rather than
 * one: the map's legend, each leg's figures in the sightings list, and the
 * summary above them. That repetition is deliberate. Somebody reading a
 * printed screenshot of this in a case file will not have the docstring, and
 * "37 km/h between Rajkot and Gondal" reads as a measurement unless it is told
 * otherwise.
 *
 * Legs the correlator could not believe are shown, in red, with the reason.
 * They are not filtered out — an impossible leg is the signature of a cloned
 * plate, and hiding it would remove the most useful thing on the page.
 *
 * Sightings at cameras whose position is unknown are listed, never dropped,
 * and never placed on the map or used for a distance.
 *
 * Reads of a slightly different plate — the vehicle misread by a character or
 * two — are listed as "Possibly the same vehicle", each with its reasons. An
 * analyst includes one (it joins the route as a dashed candidate leg, marked
 * as such everywhere) or dismisses it; each decision is an audited API call,
 * and the decisions travel in the address (`include`, `dismiss`).
 *
 * **Pursue** opens the pursuit panel: the cameras the vehicle can reach next,
 * ranked with their arrival windows, and — once started — kept under analysis
 * by the workers while the operator follows it.
 */

import {
  Fragment,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
  type ReactNode,
} from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'

import CandidateSightings, { type Decision } from '@/components/CandidateSightings'
import PlateCrop from '@/components/PlateCrop'
import PursuitPanel from '@/components/PursuitPanel'
import RegistryCard from '@/components/RegistryCard'
import RouteMap, { type PredictedCamera, type RouteMapHandle } from '@/components/RouteMap'
import {
  formatDuration,
  formatKm,
  groupStops,
  isCandidateLeg,
  legSummary,
} from '@/components/routeTrail'
import UnplacedSightings from '@/components/UnplacedSightings'
import { useToast } from '@/components/Toast'
import {
  Badge,
  Button,
  EmptyState,
  Field,
  Icon,
  InfoHint,
  Input,
  PlateChip,
  PriorityBadge,
  SegmentedControl,
  Select,
  Spinner,
  Table,
  Td,
  Th,
  Thead,
  Tr,
} from '@/components/ui'
import { useAuth } from '@/hooks/useAuth'
import * as api from '@/lib/api'
import { evidenceFloor } from '@/lib/evidence'
import { buildTimeline, journeySeconds } from '@/lib/journey'
import { etaText, useActivePursuits } from '@/lib/pursuit'
import type {
  CandidateReport,
  CandidateSighting,
  Convoy,
  Detection,
  PlateSearchResult,
  Pursuit,
  ReidMatchResponse,
  RouteHop,
  VehicleRoute,
  WatchlistHit,
} from '@/lib/types'
import {
  decideCandidate as applyDecision,
  decisionsFromParams,
  hasDecisionParams,
  paramsFor,
  paramsWithDecisions,
  plateFromParams,
  recalledDecisions,
  rememberDecisions,
  toSearchPlate,
  windowFromParams,
  type Decisions,
  type ExactWindow,
} from '@/pages/vehicleSearchUrl'

/** Windows an operator actually asks for. */
const WINDOWS = [
  { value: '1', label: '1 h', hours: 1 },
  { value: '6', label: '6 h', hours: 6 },
  { value: '24', label: '24 h', hours: 24 },
  { value: '168', label: '7 d', hours: 168 },
  { value: '720', label: '30 d', hours: 720 },
] as const

/** Plain-English reasons, so a flag never appears as a bare identifier. */
const FLAG_TEXT: Record<string, string> = {
  implausible_speed:
    'Faster than a vehicle can travel — and the distance used is a straight line, so the real journey was longer still.',
  impossible_simultaneous:
    'The same plate at two separated cameras at the same instant. One vehicle cannot do this.',
  revisit:
    'The vehicle returned to a camera it had already passed — it doubled back, or waited nearby and came back.',
  co_located:
    'Two different cameras within 50 m of each other; a speed here would be position error, not motion.',
  unobserved_gap: 'Over an hour with no sighting — the vehicle passed through unwatched roads.',
  heading_conflict:
    'The camera faces away from the direction of travel, so the reading may belong to a different carriageway.',
  same_visit:
    'Read at the same camera in the same pass as the visit before — one vehicle read two ways, or the vehicle beside it.',
}

/** The flags that make a leg impossible, rather than merely worth a note. */
const GRAVE_FLAGS = new Set(['implausible_speed', 'impossible_simultaneous'])

/** A plate offered as a starting point should be one the reader was sure of. */
const RECENT_MIN_CONFIDENCE = 0.85

const NO_HOPS: RouteHop[] = []

/** The left rail, shared by both ways of searching. */
const RAIL =
  'flex shrink-0 flex-col gap-5 border-b border-border bg-chrome px-4 py-4 lg:w-[272px] lg:overflow-y-auto lg:border-b-0 lg:border-r xl:w-[296px]'

function since(hours: number): string {
  return new Date(Date.now() - hours * 3_600_000).toISOString()
}

/** The window a search runs over: relative, or the exact one a link asked for. */
interface SearchWindow {
  hours: number
  exact: ExactWindow | null
}

function queryOf(window: SearchWindow): api.RouteQuery {
  return window.exact
    ? { since: window.exact.since, until: window.exact.until ?? undefined }
    : { since: since(window.hours) }
}

/** What identifies a search, so arriving at the same address twice runs it once. */
function keyOf(plate: string, exact: ExactWindow | null): string {
  return exact ? `${plate}|${exact.since}|${exact.until ?? ''}` : `${plate}|relative`
}

function windowLabel(hours: number, exact: ExactWindow | null): string {
  if (exact) {
    const from = api.formatIST(exact.since)
    return exact.until ? `${from} to ${api.formatIST(exact.until)} IST` : `since ${from} IST`
  }
  return `the last ${WINDOWS.find((w) => w.hours === hours)?.label ?? `${hours} h`}`
}

/** Every read of the plate, placed or not, in time order — and of any
 *  candidate an analyst included, marked as one. */
interface Read {
  at: string
  camera_code: string
  city: string | null
  candidate: boolean
}

function readsOf(route: VehicleRoute | null): Read[] {
  if (!route) return []
  return [
    ...route.hops.flatMap((h) => [
      { at: h.arrived_at, camera_code: h.camera_code, city: h.city, candidate: Boolean(h.candidate) },
      { at: h.departed_at, camera_code: h.camera_code, city: h.city, candidate: Boolean(h.candidate) },
    ]),
    ...route.unplaced_sightings.map((s) => ({
      at: s.seen_at,
      camera_code: s.camera_code,
      city: null,
      candidate: Boolean(s.candidate),
    })),
  ].sort((a, b) => new Date(a.at).getTime() - new Date(b.at).getTime())
}

/**
 * `19:03:37`, or `11 Oct, 19:03:37` when the reads cross a day. Rendered in
 * IST at the edge like every time on screen; the year adds nothing inside a
 * window of thirty days at most.
 */
function istTime(iso: string, withDate: boolean): string {
  return new Intl.DateTimeFormat('en-IN', {
    timeZone: 'Asia/Kolkata',
    ...(withDate ? { day: 'numeric' as const, month: 'short' as const } : {}),
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).format(new Date(iso))
}

/** The IST calendar day a moment falls on — `11 Oct` — or '' for none. */
function istDay(iso: string | undefined): string {
  if (!iso) return ''
  return new Intl.DateTimeFormat('en-IN', {
    timeZone: 'Asia/Kolkata',
    day: 'numeric',
    month: 'short',
  }).format(new Date(iso))
}

/** `2026-10-11`: the IST date, for telling days apart (en-CA orders it so). */
function istDate(iso: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date(iso))
}

/** A read's confidence below this is worth checking against its crop. */
const WEAK_READ = 0.6

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`
}

export default function VehicleSearch() {
  const toast = useToast()
  const navigate = useNavigate()
  const [params, setParams] = useSearchParams()
  const [mode, setMode] = useState<'plate' | 'attributes'>('plate')
  const [query, setQuery] = useState('')
  const [hours, setHours] = useState<number>(24)
  /** An exact window a link asked for; replaces `hours` until one is picked. */
  const [exact, setExact] = useState<ExactWindow | null>(null)

  const [plate, setPlate] = useState<string | null>(null)
  const [route, setRoute] = useState<VehicleRoute | null>(null)
  /** The window the route on screen was fetched over, so the exports and the
   *  printable report describe the same reads the screen shows. */
  const [searched, setSearched] = useState<api.RouteQuery | null>(null)
  const [convoys, setConvoys] = useState<Convoy[]>([])
  const [matches, setMatches] = useState<PlateSearchResult[] | null>(null)
  const [crops, setCrops] = useState<Record<string, string | null>>({})
  const [suggestions, setSuggestions] = useState<{ plate: string; cameras: number }[]>([])
  const [recent, setRecent] = useState<Detection[]>([])
  const [hoverHop, setHoverHop] = useState<number | null>(null)
  const [selectedHop, setSelectedHop] = useState<number | null>(null)
  const [playing, setPlaying] = useState(false)
  const [busy, setBusy] = useState(false)

  const { can } = useAuth()
  /** Pursuit opens cameras for analysis: the right to watch, and to search. */
  const canPursue = can('stream.view') && can('search.execute')
  const [candidateReport, setCandidateReport] = useState<CandidateReport | null>(null)
  const [candidatesLoading, setCandidatesLoading] = useState(false)
  /** The candidate whose decision is being recorded. */
  const [deciding, setDeciding] = useState<string | null>(null)
  const [pursuitOpen, setPursuitOpen] = useState(false)
  const [pursuit, setPursuit] = useState<Pursuit | null>(null)

  const mapRef = useRef<RouteMapHandle>(null)
  const hopRefs = useRef<(HTMLLIElement | null)[]>([])
  /** Only the newest search may write its answer: a slow reply for a plate
   *  typed earlier must not replace the one for the plate typed since. */
  const sequence = useRef(0)
  const lastKey = useRef<string | null>(null)
  const hoursRef = useRef(hours)
  hoursRef.current = hours
  const paramsRef = useRef(params)
  paramsRef.current = params
  /** The candidates the route on screen was built with, as the address names them. */
  const routeInclude = useRef('')

  const search = useCallback(
    async (target: string, window: SearchWindow) => {
      const normalised = toSearchPlate(target)
      if (normalised.length < 4) {
        toast.error('A plate needs at least four letters or digits to search on.')
        return
      }
      lastKey.current = keyOf(normalised, window.exact)
      setQuery(normalised)
      // The candidates included in this plate's journey: the address's when it
      // already names this plate, otherwise what this tab last decided about it.
      const current = paramsRef.current
      const chosen: Decisions =
        plateFromParams(current) === normalised && hasDecisionParams(current)
          ? decisionsFromParams(current)
          : recalledDecisions(normalised)
      // The address names the vehicle on screen, so it can be shared or
      // reloaded. Replaced rather than pushed: Back leaves the screen instead
      // of stepping through every plate typed into it.
      setParams(
        (latest) => paramsWithDecisions(paramsFor(latest, normalised, window.exact), chosen),
        { replace: true },
      )

      const id = (sequence.current += 1)
      const q = queryOf(window)
      const include = chosen.include
      setBusy(true)
      setSelectedHop(null)
      setHoverHop(null)
      try {
        const [document, convoyReport] = await Promise.all([
          api.getVehicleRoute(normalised, include.length > 0 ? { ...q, include } : q),
          api.getConvoys(normalised, { ...q, min_shared_cameras: 2 }),
        ])
        if (id !== sequence.current) return
        routeInclude.current = include.join(',')
        setPlate(normalised)
        setRoute(document)
        setSearched(q)
        setConvoys(convoyReport.convoys)
      } catch (err) {
        if (id !== sequence.current) return
        toast.error(err)
        setPlate(null)
        setRoute(null)
        setSearched(null)
        setConvoys([])
      } finally {
        if (id === sequence.current) setBusy(false)
      }
    },
    [toast, setParams],
  )
  const searchRef = useRef(search)
  searchRef.current = search

  // ── Arriving from a link ────────────────────────────────────────────
  const paramPlate = plateFromParams(params)
  const paramWindow = windowFromParams(params)
  const paramSince = paramWindow?.since ?? null
  const paramUntil = paramWindow?.until ?? null

  useEffect(() => {
    if (!paramPlate) return
    const linked = paramSince ? { since: paramSince, until: paramUntil } : null
    // The address this screen wrote itself, after a search it already ran.
    if (keyOf(paramPlate, linked) === lastKey.current) return
    setMode('plate')
    setExact(linked)
    void searchRef.current(paramPlate, { hours: hoursRef.current, exact: linked })
  }, [paramPlate, paramSince, paramUntil])

  // ── Starting points ─────────────────────────────────────────────────

  // Which plates have a route worth drawing, over the window actually being
  // searched. Computing these over a longer window than the search would
  // promise a multi-camera route and then deliver a single-camera one.
  useEffect(() => {
    let cancelled = false
    api
      .getRoutablePlates(2, 12, exact?.since ?? since(hours))
      .then((body) => {
        if (!cancelled) setSuggestions(body.plates)
      })
      .catch(() => {
        /* the search still works without suggestions */
      })
    return () => {
      cancelled = true
    }
  }, [hours, exact])

  // Plates read most recently, for a screen that would otherwise open on an
  // empty box. Not a plate search — no plate is asked for — so it is not one
  // of the audited lookups; opening one of these is.
  useEffect(() => {
    let cancelled = false
    api
      .getDetections({ readable_only: true, since: exact?.since ?? since(hours), limit: 80 })
      .then((page) => {
        if (cancelled) return
        const seen = new Set<string>()
        const picked: Detection[] = []
        for (const d of page.items) {
          if (!d.plate || seen.has(d.plate)) continue
          if ((d.plate_confidence ?? 0) < RECENT_MIN_CONFIDENCE || d.grammar_valid === false) continue
          seen.add(d.plate)
          picked.push(d)
          if (picked.length >= 8) break
        }
        setRecent(picked)
      })
      .catch(() => {
        if (!cancelled) setRecent([])
      })
    return () => {
      cancelled = true
    }
  }, [hours, exact])

  // ── Around the vehicle on screen ────────────────────────────────────

  // Plates close to the one searched. When the exact plate was not read this
  // is the way out of a dead end — a misread character or a partial plate
  // should not stop at an empty screen when the vehicle is one edit away —
  // and when it was, the near-identical plates are often this same vehicle
  // read differently. The exact match also says whether it is watched.
  useEffect(() => {
    if (!route || !plate || !searched) {
      setMatches(null)
      return
    }
    let cancelled = false
    api
      .searchPlates(plate, { since: searched.since, until: searched.until })
      .then((body) => {
        if (!cancelled) setMatches(body.results)
      })
      .catch(() => {
        if (!cancelled) setMatches([])
      })
    return () => {
      cancelled = true
    }
  }, [route, plate, searched])

  // The evidence crop for each visit — its clearest read. One request,
  // filtered to reads at least as confident as the weakest visit's best
  // (`evidenceFloor`): a busy plate has hundreds of reads, and the newest page
  // alone would miss the best read of every visit but the last. A crop that
  // still is not found shows nothing — it is evidence about a sighting, never
  // the sighting itself.
  useEffect(() => {
    const floor = route ? evidenceFloor(route) : null
    if (!route || !plate || !searched || floor === null) {
      setCrops({})
      return
    }
    let cancelled = false
    api
      .getDetections({
        plate,
        since: searched.since,
        until: searched.until,
        min_confidence: floor,
        limit: 200,
      })
      .then((page) => {
        if (!cancelled) setCrops(Object.fromEntries(page.items.map((d) => [d.id, d.crop_url ?? null])))
      })
      .catch(() => {
        if (!cancelled) setCrops({})
      })
    return () => {
      cancelled = true
    }
  }, [route, plate, searched])

  // Reads one or two characters away — the vehicle, perhaps, misread. Over
  // the window searched; a decision on one rebuilds the route, not this list.
  useEffect(() => {
    if (!plate || !searched) {
      setCandidateReport(null)
      return
    }
    let cancelled = false
    setCandidatesLoading(true)
    api
      .getCandidates(plate, { since: searched.since, until: searched.until })
      .then((report) => {
        if (!cancelled) setCandidateReport(report)
      })
      .catch(() => {
        if (!cancelled) setCandidateReport(null)
      })
      .finally(() => {
        if (!cancelled) setCandidatesLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [plate, searched])

  // An include or an undo changes the address; the route follows it.
  const decisions = useMemo(() => decisionsFromParams(params), [params])
  const includeKey = decisions.include.join(',')
  useEffect(() => {
    if (!plate || !searched || busy) return
    if (plateFromParams(params) !== plate || includeKey === routeInclude.current) return
    let cancelled = false
    const include = includeKey ? includeKey.split(',') : []
    api
      .getVehicleRoute(plate, include.length > 0 ? { ...searched, include } : searched)
      .then((document) => {
        if (cancelled) return
        routeInclude.current = includeKey
        setRoute(document)
      })
      .catch((err: unknown) => {
        if (!cancelled) toast.error(err)
      })
    return () => {
      cancelled = true
    }
  }, [includeKey, plate, searched, busy, params, toast])

  // ── Pursuit ─────────────────────────────────────────────────────────
  const pursuits = useActivePursuits(can('search.execute'))
  const pursued = !!plate && pursuits.some((p) => p.plate === plate)
  const askedForPursuit = params.get('pursuit') === '1'
  useEffect(() => {
    setPursuitOpen(false)
    setPursuit(null)
  }, [plate])
  // A pursuit already running on this plate, or a link from the top bar's pill.
  useEffect(() => {
    if (plate && (pursued || askedForPursuit)) setPursuitOpen(true)
  }, [plate, pursued, askedForPursuit])

  const closePursuit = useCallback(() => {
    setPursuitOpen(false)
    setPursuit(null)
    setParams(
      (current) => {
        const next = new URLSearchParams(current)
        next.delete('pursuit')
        return next
      },
      { replace: true },
    )
  }, [setParams])

  /** The cameras it can reach next, ringed on the map — one ring per place. */
  const predictedNow = useMemo<PredictedCamera[]>(() => {
    if (!pursuitOpen || !pursuit) return []
    const places = new Map<string, { codes: string[]; lon: number; lat: number; eta: string; pinned: boolean }>()
    for (const p of pursuit.predictions) {
      if (p.lat === null || p.lon === null) continue
      if (p.window === 'passed' || p.window === 'later') continue
      const key = `${p.lat.toFixed(5)},${p.lon.toFixed(5)}`
      const place = places.get(key) ?? {
        codes: [],
        lon: p.lon,
        lat: p.lat,
        eta: etaText(p.eta_from, p.eta_to),
        pinned: false,
      }
      place.codes.push(p.camera_code)
      place.pinned ||= p.pin_state === 'pinned'
      places.set(key, place)
    }
    return [...places.values()].slice(0, 6).map((place) => ({
      code:
        place.codes.length > 2
          ? `${place.codes.slice(0, 2).join(', ')} +${place.codes.length - 2}`
          : place.codes.join(', '),
      lon: place.lon,
      lat: place.lat,
      label: place.eta,
      pinned: place.pinned,
    }))
  }, [pursuitOpen, pursuit])
  // Stable by content: the panel refreshes every few seconds, and a new list
  // each time would redraw the rings and re-frame a map the operator has panned.
  const predictedKey = JSON.stringify(predictedNow)
  const predicted = useMemo(() => JSON.parse(predictedKey) as PredictedCamera[], [predictedKey])

  // ── Actions ─────────────────────────────────────────────────────────

  /**
   * Include, dismiss or undo a candidate. The API call is the record — an
   * audit row naming who decided what about which read — and only once it
   * succeeds does the journey on screen change.
   */
  const decideOn = useCallback(
    async (candidate: CandidateSighting, decision: Decision) => {
      if (!plate) return
      setDeciding(candidate.detection_id)
      try {
        await api.decideCandidate(plate, {
          detection_id: candidate.detection_id,
          detection_ts: candidate.detection_ts,
          decision,
        })
        const next = applyDecision(
          decisionsFromParams(paramsRef.current),
          [candidate.detection_id, ...candidate.detection_ids],
          decision,
        )
        rememberDecisions(plate, next)
        setParams((current) => paramsWithDecisions(current, next), { replace: true })
        if (decision === 'include') {
          toast.success(
            `${candidate.read_as} at ${candidate.camera_code} is in the journey, marked as a candidate`,
          )
        }
      } catch (err) {
        toast.error(err)
      } finally {
        setDeciding(null)
      }
    },
    [plate, setParams, toast],
  )

  function submit(event: FormEvent) {
    event.preventDefault()
    void search(query, { hours, exact })
  }

  /** Open another plate — a suggestion, a near match, a vehicle alongside. */
  const open = useCallback(
    (target: string) => {
      setMode('plate')
      void searchRef.current(target, { hours: hoursRef.current, exact })
    },
    [exact],
  )

  function changeWindow(next: number) {
    setHours(next)
    setExact(null)
    if (plate) void search(plate, { hours: next, exact: null })
  }

  function clearExact() {
    setExact(null)
    if (plate) void search(plate, { hours, exact: null })
  }

  async function exportCsv(run: () => Promise<string>) {
    try {
      toast.success(`Downloaded ${await run()}`)
    } catch (err) {
      toast.error(err)
    }
  }

  function openReport() {
    if (!route || !searched) return
    const qs = new URLSearchParams()
    if (searched.since) qs.set('since', searched.since)
    if (searched.until) qs.set('until', searched.until)
    // The report shows the journey on screen, candidates included and marked.
    if (decisions.include.length > 0) qs.set('include', decisions.include.join(','))
    navigate(`/reports/vehicle/${encodeURIComponent(route.plate)}?${qs}`)
  }

  const selectFromMap = useCallback((index: number) => {
    setSelectedHop(index)
    window.requestAnimationFrame(() =>
      hopRefs.current[index]?.scrollIntoView({ block: 'nearest', behavior: 'smooth' }),
    )
  }, [])

  function selectFromList(index: number) {
    setSelectedHop((current) => (current === index ? null : index))
    mapRef.current?.focus(index)
  }

  // ── Derived ─────────────────────────────────────────────────────────

  const hops = route?.hops ?? NO_HOPS
  const unplaced = route?.unplaced_sightings ?? []
  const reads = useMemo(() => readsOf(route), [route])
  const firstRead = reads[0]
  const lastRead = reads[reads.length - 1]
  // A window spanning midnight makes time-only stamps look out of order
  // (17:49 then 12:32), so the date is shown whenever the reads cross a day —
  // an IST day, since that is the clock every stamp is shown on.
  const spansDays = !!firstRead && !!lastRead && istDate(firstRead.at) !== istDate(lastRead.at)
  const watch = matches?.find((m) => m.plate_normalised === plate)?.watchlist ?? null
  const nearMatches = (matches ?? []).filter((m) => m.plate_normalised !== plate)
  // Places, not cameras: two cameras on one spot leave nothing to travel
  // between, and the map groups its stops the same way.
  const places = useMemo(() => groupStops(hops).length, [hops])
  const canReplay = useMemo(
    () => places > 1 && journeySeconds(buildTimeline(hops)) > 0,
    [places, hops],
  )
  const activeHop = hoverHop ?? selectedHop
  const nothingRead = !!route && hops.length === 0 && unplaced.length === 0
  const currentQuery = () => queryOf({ hours, exact })
  // A candidate visit's crop is a read of another plate, so it is not among
  // this plate's reads: it comes with the candidate list.
  const candidateCrops = useMemo(() => {
    const out: Record<string, string | null> = {}
    for (const c of candidateReport?.candidates ?? []) {
      for (const id of [c.detection_id, ...c.detection_ids]) out[id] = c.crop_url
    }
    return out
  }, [candidateReport])
  const allCrops = useMemo(() => ({ ...candidateCrops, ...crops }), [candidateCrops, crops])
  const candidateCount = candidateReport?.total ?? 0
  const missing = route?.candidates_missing ?? []
  const showEvidence =
    !!route && (hops.length > 0 || unplaced.length > 0 || candidateCount > 0 || pursuitOpen)
  const openPursuit = canPursue ? () => setPursuitOpen(true) : undefined

  const modeSwitch = (
    <SegmentedControl
      fill
      value={mode}
      onChange={setMode}
      options={[
        { value: 'plate', label: 'By plate' },
        { value: 'attributes', label: 'By attributes' },
      ]}
    />
  )

  return (
    <div className="flex h-full min-h-0 flex-col">
      {mode === 'plate' && route && !nothingRead ? (
        <VehicleBand
          route={route}
          watch={watch}
          firstRead={firstRead}
          lastRead={lastRead}
          spansDays={spansDays}
          places={places}
          canReplay={canReplay}
          playing={playing}
          onReplay={() => (playing ? mapRef.current?.pause() : mapRef.current?.replay())}
          onCsv={() =>
            void exportCsv(() =>
              api.downloadRouteReport(route.plate, {
                ...(searched ?? currentQuery()),
                ...(decisions.include.length > 0 ? { include: decisions.include } : {}),
              }),
            )
          }
          onReport={openReport}
          pursuing={pursued}
          onPursue={openPursuit}
          registry={
            <RegistryCard
              plate={route.plate}
              // The newest confirmed read: a candidate's read is of another plate.
              detectionId={
                route.hops.filter((h) => !h.candidate).at(-1)?.best_detection_id ?? undefined
              }
            />
          }
        />
      ) : (
        <PageBand mode={mode} />
      )}

      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto lg:flex-row lg:overflow-hidden">
        {mode === 'attributes' ? (
          <AttributeSearch modeSwitch={modeSwitch} onOpenPlate={open} />
        ) : (
          <>
            {/* ── The question ─────────────────────────────────────── */}
            <aside aria-label="Search" className={RAIL}>
              {modeSwitch}

              <form onSubmit={submit} className="flex flex-col gap-4">
                <label className="block">
                  <span className="eyebrow">Plate, as read or as remembered</span>
                  <input
                    value={query}
                    onChange={(e) => setQuery(e.target.value.toUpperCase())}
                    placeholder="GJ03AB1234"
                    aria-label="Plate"
                    autoComplete="off"
                    spellCheck={false}
                    className="mt-1.5 h-11 w-full rounded-md border border-input bg-background px-3 font-plate text-[22px] font-bold uppercase tracking-[0.08em] text-foreground outline-none transition placeholder:text-faint/50 focus:border-primary/70 focus:ring-1 focus:ring-primary/40"
                  />
                </label>

                <div>
                  <span className="eyebrow">Window</span>
                  <SegmentedControl
                    fill
                    className="mt-1.5 [&>button]:px-0"
                    value={exact ? 'exact' : String(hours)}
                    onChange={(v) => changeWindow(Number(v))}
                    options={WINDOWS.map((w) => ({ value: w.value, label: w.label }))}
                  />
                  {exact && (
                    <p className="mt-2 flex items-start gap-2 rounded-md border border-input bg-secondary/60 px-2.5 py-1.5 text-xs text-foreground">
                      <Icon name="clock" size={13} className="mt-px text-faint" />
                      <span className="min-w-0 flex-1 font-mono text-[11px] leading-snug">
                        {windowLabel(hours, exact)}
                      </span>
                      <button
                        type="button"
                        onClick={clearExact}
                        aria-label="Use a relative window instead"
                        title="Use a relative window instead"
                        className="text-faint transition hover:text-foreground"
                      >
                        <Icon name="close" size={13} />
                      </button>
                    </p>
                  )}
                </div>

                <Button type="submit" disabled={busy} className="h-9 w-full">
                  {busy ? (
                    <>
                      <Spinner className="h-3.5 w-3.5 border-background border-t-transparent" />
                      Searching…
                    </>
                  ) : (
                    <>
                      <Icon name="search" size={14} />
                      Search
                    </>
                  )}
                </Button>
              </form>

              {route && !nothingRead && nearMatches.length > 0 && (
                <section>
                  <RailHeading
                    info={
                      <>
                        Ranked by how closely each plate matches what you typed, not by when
                        it was seen. A near-identical plate in the same place and hour is
                        usually this vehicle read differently.
                      </>
                    }
                  >
                    Close to what you typed
                  </RailHeading>
                  <ul className="mt-2 space-y-1.5">
                    {nearMatches.slice(0, 6).map((match) => (
                      <li key={match.plate_normalised}>
                        <MatchRow match={match} onOpen={open} />
                      </li>
                    ))}
                  </ul>
                </section>
              )}

              {route && !nothingRead && convoys.length > 0 && (
                <Convoys convoys={convoys} onOpen={open} />
              )}

              {/* The submission's "detected plates with timestamps" report:
                  every plate read in the chosen window, on every camera. */}
              <div className="mt-auto space-y-3 pt-1">
                <div>
                  <Button
                    variant="outline"
                    className="w-full"
                    onClick={() => void exportCsv(() => api.downloadPlatesReport(currentQuery()))}
                  >
                    <Icon name="download" size={14} />
                    Export plate reads (CSV)
                  </Button>
                  <p className="mt-1.5 text-[11px] text-faint">
                    Every plate read in {windowLabel(hours, exact)}, on every camera.
                  </p>
                </div>
                <div className="rounded-lg border border-border p-3 text-xs leading-relaxed text-muted-foreground">
                  <p className="mb-1 font-medium text-foreground">Reading a route</p>
                  Legs are straight lines between cameras, so every distance and speed is a lower
                  bound. A camera that was not reading plates at the time could not have seen the
                  vehicle: absence here is not absence from the road.
                </div>
              </div>
            </aside>

            {/* ── The journey ──────────────────────────────────────── */}
            <main className="relative flex h-[480px] min-w-0 shrink-0 flex-col lg:h-auto lg:flex-1 lg:shrink">
              <RouteMap
                ref={mapRef}
                hops={hops}
                activeSequence={activeHop}
                onSelectHop={selectFromMap}
                onPlayingChange={setPlaying}
                predicted={predicted}
              >
                {busy && (
                  <div className="absolute inset-x-0 top-3 flex justify-center">
                    <span className="flex items-center gap-2 rounded-full border border-border bg-card/95 px-3 py-1.5 text-xs text-muted-foreground shadow-lg">
                      <Spinner className="h-3.5 w-3.5" />
                      Searching {query ? <span className="font-mono">{query}</span> : null}…
                    </span>
                  </div>
                )}

                {!route && !busy && (
                  <MapCard>
                    <Starting
                      suggestions={suggestions}
                      recent={recent}
                      windowText={windowLabel(hours, exact)}
                      onOpen={open}
                    />
                  </MapCard>
                )}

                {route && nothingRead && (
                  <MapCard>
                    <NotRead
                      plate={route.plate}
                      windowText={windowLabel(hours, exact)}
                      hours={exact ? null : hours}
                      matches={nearMatches}
                      onWiden={changeWindow}
                      onOpen={open}
                      candidates={candidateCount}
                      onPursue={openPursuit}
                    />
                  </MapCard>
                )}

                {route && hops.length === 0 && unplaced.length > 0 && (
                  <MapCard>
                    <p className="eyebrow">Not on the map</p>
                    <p className="mt-2 text-[13px] leading-relaxed text-muted-foreground">
                      <PlateChip plate={route.plate} size="xs" /> was read{' '}
                      {plural(unplaced.length, 'time')}, only at cameras whose position is
                      unknown — so there is nothing to place, and no distance or speed to
                      measure. The reads are listed under Sightings.
                    </p>
                  </MapCard>
                )}

                {route && hops.length > 0 && places === 1 && !busy && (
                  <div className="absolute left-3 right-[12.5rem] top-3 flex">
                    <p className="pointer-events-auto flex max-w-xl gap-2.5 rounded-lg border border-border bg-card/95 px-4 py-2.5 text-xs leading-relaxed text-muted-foreground shadow-xl backdrop-blur">
                      <Icon name="info" size={15} className="mt-px text-faint" />
                      <span>
                        {hops.every((h) => h.candidate) ? (
                          <>
                            Only {hops.length === 1 ? 'a candidate visit is' : 'candidate visits are'}{' '}
                            on the map — a read of another plate that an analyst included, not a
                            confirmed read of this one. A journey needs reads at cameras in
                            different places.
                          </>
                        ) : hops.length === 1 ? (
                          <>
                            Seen once, at{' '}
                            <span className="font-mono text-foreground">{hops[0]!.camera_code}</span>.
                            A journey needs the plate read again at a camera somewhere else.
                          </>
                        ) : route.camera_count === 1 ? (
                          <>
                            All {hops.length} sightings are on one camera, so there is no journey to
                            draw — only a record of the vehicle passing{' '}
                            <span className="font-mono text-foreground">{hops[0]!.camera_code}</span>{' '}
                            more than once. A route needs the plate read on cameras in different
                            places.
                          </>
                        ) : (
                          <>
                            All {hops.length} sightings are at cameras on one spot, so there is no
                            journey to draw and no distance to measure. A route needs the plate read
                            on cameras in different places.
                          </>
                        )}
                      </span>
                    </p>
                  </div>
                )}
              </RouteMap>
            </main>

            {/* ── The evidence ─────────────────────────────────────── */}
            {route && showEvidence && (
              <aside
                aria-label="Sightings"
                className="flex shrink-0 flex-col border-t border-border bg-chrome lg:w-[330px] lg:border-l lg:border-t-0 xl:w-[368px]"
              >
                <div className="flex items-center gap-2 px-4 pb-2.5 pt-3.5">
                  <h2 className="text-[15px] font-semibold">Sightings</h2>
                  <span className="truncate text-xs text-faint">
                    {[
                      hops.length > 0 &&
                        `${plural(hops.length, 'visit')} · ${plural(route.camera_count, 'camera')}`,
                      unplaced.length > 0 && `${unplaced.length} position unknown`,
                    ]
                      .filter(Boolean)
                      .join(' · ')}
                  </span>
                  <span className="ml-auto">
                    <InfoHint label="How these figures are measured" align="right">
                      {route.geometry_note}
                    </InfoHint>
                  </span>
                </div>
                <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-2.5 pb-4">
                  {pursuitOpen && plate && (
                    <PursuitPanel
                      plate={plate}
                      canSteer={canPursue}
                      onClose={closePursuit}
                      onConfirmedRead={() =>
                        void searchRef.current(plate, { hours: hoursRef.current, exact })
                      }
                      onPredictions={setPursuit}
                    />
                  )}
                  {missing.length > 0 && (
                    <p className="rounded-md border border-priority-high/30 bg-priority-high/[0.06] px-2.5 py-1.5 text-[11px] leading-snug text-priority-high">
                      {plural(missing.length, 'included candidate')} {missing.length === 1 ? 'is' : 'are'}{' '}
                      not in this window, so {missing.length === 1 ? 'it is' : 'they are'} not on the
                      route. Widen the window to see {missing.length === 1 ? 'it' : 'them'} again.
                    </p>
                  )}
                  {hops.length > 0 && (
                    <ol className="space-y-1.5">
                      {hops.map((hop, index) => (
                        <Fragment key={`${hop.camera_id}-${hop.arrived_at}`}>
                          {/* A day divider rather than a date on every row:
                              the list is in time order, so it reads once. */}
                          {spansDays &&
                            istDay(hop.arrived_at) !== istDay(hops[index - 1]?.arrived_at) && (
                              <li role="presentation" className="eyebrow px-1.5 pb-0.5 pt-2 first:pt-0">
                                {istDay(hop.arrived_at)}
                              </li>
                            )}
                          <HopRow
                            hop={hop}
                            index={index}
                            last={hops.length - 1}
                            active={activeHop === index}
                            selected={selectedHop === index}
                            crop={hop.best_detection_id ? (allCrops[hop.best_detection_id] ?? null) : null}
                            plate={route.plate}
                            candidateLeg={isCandidateLeg(hops, index)}
                            innerRef={(node) => {
                              hopRefs.current[index] = node
                            }}
                            onEnter={() => setHoverHop(index)}
                            onLeave={() => setHoverHop(null)}
                            onSelect={() => selectFromList(index)}
                          />
                        </Fragment>
                      ))}
                    </ol>
                  )}
                  {unplaced.length > 0 && (
                    <UnplacedSightings
                      sightings={unplaced}
                      crops={allCrops}
                      plate={route.plate}
                      withDate={spansDays}
                    />
                  )}
                  <CandidateSightings
                    plate={route.plate}
                    report={candidateReport}
                    loading={candidatesLoading}
                    decisions={decisions}
                    busy={deciding}
                    onDecide={(candidate, decision) => void decideOn(candidate, decision)}
                    withDate={spansDays}
                  />
                </div>
              </aside>
            )}
          </>
        )}
      </div>
    </div>
  )
}

// ── The bands ─────────────────────────────────────────────────────────

function PageBand({ mode }: { mode: 'plate' | 'attributes' }) {
  return (
    <header className="flex shrink-0 flex-wrap items-center gap-x-6 gap-y-2 border-b border-border bg-chrome px-5 py-3">
      <div className="min-w-0">
        <h1 className="text-[17px] font-semibold leading-tight tracking-tight">Vehicle search</h1>
        <p className="mt-0.5 flex flex-wrap items-center gap-x-1.5 text-xs text-muted-foreground">
          {mode === 'plate' ? (
            <>
              <span>every sighting of a plate, and the journey they imply</span>
              <InfoHint label="What a drawn route is and is not">
                A route is inference. The platform knows where a vehicle was seen, not how it
                got between those points — the lines are straight legs between cameras, not
                the roads driven, so every distance and speed is a lower bound. Legs the
                correlator could not believe are shown in red rather than hidden: an
                impossible leg is the signature of a cloned plate, and removing it would
                remove the most useful thing on the page.
              </InfoHint>
            </>
          ) : (
            <>
              <span>browse sightings by what a vehicle looks like</span>
              <InfoHint label="What can be searched on">
                Type, camera and time window filter every sighting the pipeline has made,
                including ones whose plate could not be read. Colour cannot be filtered on
                yet — nothing in the pipeline reads it.
              </InfoHint>
            </>
          )}
        </p>
      </div>
    </header>
  )
}

/** The vehicle on screen: its plate, when and where it was read, and what needs explaining. */
function VehicleBand({
  route,
  watch,
  firstRead,
  lastRead,
  spansDays,
  places,
  canReplay,
  playing,
  onReplay,
  onCsv,
  onReport,
  pursuing = false,
  onPursue,
  registry,
}: {
  route: VehicleRoute
  watch: WatchlistHit | null
  firstRead: Read | undefined
  lastRead: Read | undefined
  spansDays: boolean
  /** Distinct places the vehicle was read at — what a distance needs two of. */
  places: number
  canReplay: boolean
  playing: boolean
  onReplay: () => void
  onCsv: () => void
  onReport: () => void
  /** A pursuit of this plate is running. */
  pursuing?: boolean
  /** Absent for a role that may not open cameras for analysis. */
  onPursue?: () => void
  /** Reference data about the registration, beside the plate, when there is any. */
  registry?: ReactNode
}) {
  const candidates = route.candidate_hop_count ?? 0
  // The counts beside the plate are reads *of the plate*; included candidates
  // are counted apart, so a reader never takes one for a confirmed read.
  const hops = route.hops.filter((h) => !h.candidate)
  const unplaced = route.unplaced_sightings.filter((s) => !s.candidate)
  const cameras = new Set(hops.map((h) => h.camera_id)).size
  const reads = hops.reduce((sum, h) => sum + h.sightings, 0) + unplaced.length
  const impossible = route.hops.filter((h) => !h.plausible).length
  const noted = route.hops.filter((h) => h.plausible && h.flags.length > 0).length
  const weakest =
    route.hops.length > 0 ? Math.min(...route.hops.map((h) => h.plate_confidence)) : null
  const elapsed =
    firstRead && lastRead
      ? (new Date(lastRead.at).getTime() - new Date(firstRead.at).getTime()) / 1000
      : 0
  const placeOf = (read: Read) =>
    [read.camera_code, read.city, read.candidate ? 'candidate' : null].filter(Boolean).join(' · ')
  const measurable = places > 1 && route.distance_km > 0

  return (
    // Two fixed rows — the vehicle and its actions, then its figures — so
    // nothing reflows (and the map below never resizes) when a label changes.
    <section aria-label="Vehicle" className="shrink-0 border-b border-border bg-chrome px-5 py-3">
      <h1 className="sr-only">Journey of {route.plate}</h1>
      <div className="flex flex-wrap items-center gap-x-5 gap-y-2">
        <div className="flex items-center gap-4">
          <PlateChip plate={route.plate} size="xl" watched={!!watch} />
          <div className="flex min-w-0 flex-col gap-1">
            {watch && (
              <span className="flex flex-wrap items-center gap-2 text-xs">
                <PriorityBadge priority={watch.priority} solid />
                <span className="font-medium capitalize text-foreground">
                  On the watchlist · {watch.category}
                </span>
                {watch.case_ref && (
                  <span className="font-mono text-[11px] text-muted-foreground">{watch.case_ref}</span>
                )}
              </span>
            )}
            <span className="text-xs text-muted-foreground">
              {hops.length > 0
                ? `${plural(reads, 'read')} · ${plural(hops.length, 'visit')} to ${plural(cameras, 'camera')}`
                : `${plural(reads, 'read')}, none where the camera's position is known`}
            </span>
            {hops.length > 0 && unplaced.length > 0 && (
              <span className="text-xs text-faint">
                and {unplaced.length} where the camera&rsquo;s position is unknown
              </span>
            )}
            {candidates > 0 && (
              <span className="text-xs text-primary">
                + {plural(candidates, 'candidate visit')} an analyst included
              </span>
            )}
          </div>
        </div>

        <div className="ml-auto flex flex-wrap gap-2">
          {onPursue && (
            <Button
              variant="outline"
              onClick={onPursue}
              title="The cameras it can reach next, ranked — and kept under analysis while you follow it"
              className={pursuing ? 'border-primary/60 text-primary' : undefined}
            >
              <Icon name="live" size={13} />
              {pursuing ? 'Pursuing' : 'Pursue'}
            </Button>
          )}
          {canReplay && (
            <Button
              variant="outline"
              onClick={onReplay}
              className="min-w-[138px]"
              title="Play the journey on the map, in proportion to real time"
            >
              <Icon name={playing ? 'pause' : 'play'} size={13} />
              {playing ? 'Pause' : 'Replay journey'}
            </Button>
          )}
          <Button variant="outline" onClick={onCsv} title="Every visit in order, and the leg to it">
            <Icon name="download" size={14} />
            CSV
          </Button>
          <Button onClick={onReport}>
            <Icon name="ledger" size={14} />
            Printable report
          </Button>
        </div>
      </div>

      <dl className="mt-3 flex flex-wrap gap-x-6 gap-y-2.5 xl:gap-x-8">
        {/* One read has one moment: "first" and "last" would both be it. */}
        {firstRead && lastRead && elapsed > 0 ? (
          <>
            <Figure
              label="First seen"
              value={istTime(firstRead.at, spansDays)}
              detail={placeOf(firstRead)}
            />
            <Figure
              label="Last seen"
              value={istTime(lastRead.at, spansDays)}
              detail={placeOf(lastRead)}
            />
            <Figure label="Elapsed" value={formatDuration(elapsed)} detail="first read to last" />
          </>
        ) : (
          firstRead && (
            <Figure label="Seen" value={istTime(firstRead.at, spansDays)} detail={placeOf(firstRead)} />
          )
        )}
        {/* A distance, a speed and a leg need two places; with fewer there is
            nothing to measure, and a zero would read as a measurement. */}
        {measurable && (
          <Figure
            label="Straight-line"
            value={`≥ ${formatKm(route.distance_km)} km`}
            info="Roads are never shorter than the straight line between two cameras, so this is a floor on the distance driven."
          />
        )}
        {measurable && route.average_kmph !== null && (
          <Figure
            label="Average speed"
            value={`≥ ${Math.round(route.average_kmph)} km/h`}
            detail={
              route.moving_kmph !== null && route.moving_kmph !== route.average_kmph
                ? `≥ ${Math.round(route.moving_kmph)} km/h moving`
                : undefined
            }
            info={
              <>
                First sighting to last, so it includes time stopped at a junction, and the
                distances are straight lines. Both push it down, so the real average is at least
                this. The moving figure leaves out the time spent at each camera.
              </>
            }
          />
        )}
        {weakest !== null && (
          <Figure
            label={route.hops.length === 1 ? 'Read confidence' : 'Route confidence'}
            value={route.confidence.toFixed(2)}
            detail={
              weakest < WEAK_READ
                ? 'a weak read — check its crop'
                : impossible > 0
                  ? 'lowered by the impossible legs'
                  : candidates > 0
                    ? 'includes candidate reads'
                    : undefined
            }
            tone={weakest < WEAK_READ ? 'warn' : undefined}
            info="The weakest plate read on the route, less a quarter for every impossible leg: a route is only as good as its worst link."
          />
        )}
        {candidates > 0 && (
          <Figure
            label="Candidates"
            value={plural(candidates, 'visit')}
            detail="included, not confirmed"
            tone="warn"
            info="Reads of a different plate an analyst included as possibly this vehicle. They are drawn dashed and every figure here includes them."
          />
        )}
        {places > 1 && (
          <Figure
            label="To explain"
            value={
              impossible > 0 ? (
                <span className="flex items-center gap-1.5 text-priority-critical">
                  <Icon name="alert" size={14} />
                  {plural(impossible, 'leg')}
                </span>
              ) : (
                'none'
              )
            }
            detail={noted > 0 ? `${plural(noted, 'leg')} with a note` : 'no impossible legs'}
          />
        )}
      </dl>

      {registry && <div className="mt-3 max-w-4xl">{registry}</div>}
    </section>
  )
}

function Figure({
  label,
  value,
  detail,
  info,
  tone,
}: {
  label: string
  value: ReactNode
  detail?: string
  info?: ReactNode
  /** Amber when a person should look again; grey otherwise. */
  tone?: 'warn'
}) {
  return (
    <div className="min-w-0">
      <dt className="eyebrow flex items-center gap-1">
        {label}
        {info && <InfoHint>{info}</InfoHint>}
      </dt>
      <dd
        className={`mt-0.5 font-mono text-[15px] leading-tight ${tone === 'warn' ? 'text-priority-high' : 'text-foreground'}`}
      >
        {value}
      </dd>
      {detail && (
        <dd
          className={`mt-0.5 max-w-[220px] truncate text-[11px] ${tone === 'warn' ? 'text-priority-high' : 'font-mono text-faint'}`}
        >
          {detail}
        </dd>
      )}
    </div>
  )
}

// ── Over the map ──────────────────────────────────────────────────────

function MapCard({ children }: { children: ReactNode }) {
  return (
    <div className="absolute inset-0 flex items-center justify-center p-6">
      <div className="pointer-events-auto max-h-full w-full max-w-[460px] overflow-y-auto rounded-lg border border-border bg-card/95 p-5 shadow-2xl backdrop-blur">
        {children}
      </div>
    </div>
  )
}

/** Before any search: what this screen answers, and somewhere to start. */
function Starting({
  suggestions,
  recent,
  windowText,
  onOpen,
}: {
  suggestions: { plate: string; cameras: number }[]
  recent: Detection[]
  windowText: string
  onOpen: (plate: string) => void
}) {
  return (
    <>
      <p className="eyebrow">Investigate</p>
      <h2 className="mt-1 text-lg font-semibold leading-snug">Where has a vehicle been?</h2>
      <p className="mt-1.5 text-[13px] leading-relaxed text-muted-foreground">
        Type a plate — as read, or as remembered — for every sighting of it, the journey those
        sightings imply, and anything about that journey that needs explaining.
      </p>

      {suggestions.length > 0 && (
        <section className="mt-4">
          <p className="eyebrow">Seen on more than one camera</p>
          <ul className="mt-2 flex flex-wrap gap-2">
            {suggestions.map((s) => (
              <li key={s.plate}>
                <button
                  type="button"
                  onClick={() => onOpen(s.plate)}
                  className="flex items-center gap-2 rounded-md border border-border bg-background/60 px-2 py-1.5 transition hover:border-primary/60"
                >
                  <PlateChip plate={s.plate} size="xs" />
                  <span className="font-mono text-[11px] text-muted-foreground">{s.cameras} cams</span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}

      {recent.length > 0 && (
        <section className="mt-4">
          <p className="eyebrow">Read most recently</p>
          <ul className="mt-2 flex flex-wrap gap-2">
            {recent.map((d) => (
              <li key={d.plate}>
                <button
                  type="button"
                  onClick={() => onOpen(d.plate!)}
                  title={`${d.camera_code} · ${api.formatIST(d.ts)} IST · read ${(d.plate_confidence ?? 0).toFixed(2)}`}
                  className="rounded-md p-1 transition hover:bg-secondary"
                >
                  <PlateChip plate={d.plate!} size="xs" />
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}

      {suggestions.length === 0 && recent.length === 0 && (
        <p className="mt-4 text-xs text-faint">No plate was read with confidence in {windowText}.</p>
      )}
    </>
  )
}

/** The searched plate was not read at all: say so, and offer the ways out. */
function NotRead({
  plate,
  windowText,
  hours,
  matches,
  onWiden,
  onOpen,
  candidates = 0,
  onPursue,
}: {
  plate: string
  windowText: string
  /** Null when the window is an exact one from a link. */
  hours: number | null
  matches: PlateSearchResult[]
  onWiden: (hours: number) => void
  onOpen: (plate: string) => void
  /** Reads of a near plate that may be it, listed beside the map. */
  candidates?: number
  /** Watch for it on every analysed camera; absent for a role that may not. */
  onPursue?: () => void
}) {
  const wider = WINDOWS.filter((w) => hours !== null && w.hours > hours && w.hours >= 168)
  return (
    <>
      <p className="eyebrow">No sightings</p>
      <p className="mt-2 flex flex-wrap items-center gap-2 text-[13px] text-muted-foreground">
        <PlateChip plate={plate} size="sm" candidate title="As typed — not read by any camera" />
        was not read in {windowText}.
      </p>

      {candidates > 0 && (
        <p className="mt-2 text-[13px] leading-relaxed text-foreground">
          {plural(candidates, 'read')} of a plate one or two characters from it may be this vehicle
          misread — listed under <span className="font-medium">Possibly the same vehicle</span>,
          each with why.
        </p>
      )}

      {onPursue && (
        <div className="mt-3">
          <Button size="sm" variant="outline" onClick={onPursue}>
            <Icon name="live" size={12} />
            Pursue — watch for it on every analysed camera
          </Button>
        </div>
      )}

      {wider.length > 0 && (
        <div className="mt-3 flex flex-wrap gap-2">
          {wider.map((w) => (
            <Button key={w.value} size="sm" variant="outline" onClick={() => onWiden(w.hours)}>
              Search the last {w.label}
            </Button>
          ))}
        </div>
      )}

      {matches.length > 0 ? (
        <section className="mt-4">
          <RailHeading info="Ranked by how closely each plate matches what you typed, not by when it was seen.">
            Did you mean…
          </RailHeading>
          <ul className="mt-2 space-y-1.5">
            {matches.map((match) => (
              <li key={match.plate_normalised}>
                <MatchRow match={match} onOpen={onOpen} />
              </li>
            ))}
          </ul>
        </section>
      ) : (
        <p className="mt-3 text-xs text-faint">
          No plate close to it was read either. A camera that was not reading plates at the time
          could not have seen it.
        </p>
      )}
    </>
  )
}

// ── The left rail's lists ─────────────────────────────────────────────

function RailHeading({ children, info }: { children: ReactNode; info?: ReactNode }) {
  return (
    <h2 className="eyebrow flex items-center gap-1">
      {children}
      {info && <InfoHint>{info}</InfoHint>}
    </h2>
  )
}

/** A plate the fuzzy search suggests: drawn as a candidate, never as a read. */
function MatchRow({ match, onOpen }: { match: PlateSearchResult; onOpen: (plate: string) => void }) {
  return (
    <button
      type="button"
      onClick={() => onOpen(match.plate_normalised)}
      className="group flex w-full items-center gap-2.5 rounded-md border border-border bg-background/40 px-2.5 py-2 text-left transition hover:border-primary/50"
    >
      <PlateChip plate={match.plate_normalised} size="xs" candidate watched={!!match.watchlist} />
      <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-muted-foreground">
        {Math.round(match.similarity * 100)}% · {plural(match.sightings, 'read')}
        {match.cameras > 1 && ` · ${match.cameras} cams`}
      </span>
      {match.watchlist && <PriorityBadge priority={match.watchlist.priority} />}
      <Icon name="arrowRight" size={13} className="text-faint transition group-hover:text-primary" />
    </button>
  )
}

function Convoys({ convoys, onOpen }: { convoys: Convoy[]; onOpen: (plate: string) => void }) {
  const real = convoys.filter((c) => !c.likely_same_vehicle)
  const misreads = convoys.filter((c) => c.likely_same_vehicle)
  return (
    <section>
      <RailHeading
        info={
          <>
            Co-occurrence is evidence of association, not proof of it. Two vehicles on the same
            road at the same time will co-occur without being related.
          </>
        }
      >
        Seen alongside
      </RailHeading>

      {real.length === 0 ? (
        <p className="mt-2 text-xs text-faint">No other vehicle travelled with this one.</p>
      ) : (
        <ul className="mt-2 space-y-1.5">
          {real.map((convoy) => (
            <li key={convoy.with_plate}>
              <button
                type="button"
                onClick={() => onOpen(convoy.with_plate)}
                className="group flex w-full items-center gap-2.5 rounded-md border border-border bg-background/40 px-2.5 py-2 text-left transition hover:border-primary/50"
              >
                <PlateChip plate={convoy.with_plate} size="xs" />
                <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-muted-foreground">
                  {convoy.shared_cameras} shared · {Math.round(convoy.median_gap_s)} s apart
                </span>
                <Icon name="arrowRight" size={13} className="text-faint transition group-hover:text-primary" />
              </button>
            </li>
          ))}
        </ul>
      )}

      {/* Kept visible rather than filtered away: a cluster of near-identical
          plates is a measurement of how often the reader is disagreeing with
          itself on this vehicle, which is worth an operator knowing. */}
      {misreads.length > 0 && (
        <details className="mt-2">
          <summary className="cursor-pointer text-[11px] leading-snug text-muted-foreground">
            {misreads.length} near-identical plate{misreads.length === 1 ? '' : 's'} — almost
            certainly this same vehicle read differently, not a convoy
          </summary>
          <ul className="mt-2 flex flex-wrap gap-1.5">
            {misreads.map((convoy) => (
              <li key={convoy.with_plate}>
                <PlateChip plate={convoy.with_plate} size="xs" candidate />
              </li>
            ))}
          </ul>
        </details>
      )}
    </section>
  )
}

// ── The sightings column ──────────────────────────────────────────────

/** A visit's number, drawn the way the map draws its stop. */
const BADGE: Record<'start' | 'via' | 'end' | 'impossible' | 'candidate', string> = {
  start: 'border-2 border-foreground/80 text-foreground',
  via: 'bg-foreground/80 text-background',
  end: 'bg-primary text-primary-foreground',
  impossible: 'border-2 border-priority-critical text-priority-critical',
  candidate: 'border-2 border-dashed border-primary text-primary',
}

function HopRow({
  hop,
  index,
  last,
  active,
  selected,
  crop,
  plate,
  candidateLeg = false,
  innerRef,
  onEnter,
  onLeave,
  onSelect,
}: {
  hop: RouteHop
  index: number
  last: number
  active: boolean
  selected: boolean
  crop: string | null
  plate: string
  /** The leg into this visit touches a candidate at either end. */
  candidateLeg?: boolean
  innerRef: (node: HTMLLIElement | null) => void
  onEnter: () => void
  onLeave: () => void
  onSelect: () => void
}) {
  const impossible = !hop.plausible
  const candidate = Boolean(hop.candidate)
  const look = impossible
    ? 'impossible'
    : candidate
      ? 'candidate'
      : index === last
        ? 'end'
        : index === 0
          ? 'start'
          : 'via'
  const leg = legSummary(hop, candidateLeg)

  function onKeyDown(event: KeyboardEvent) {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault()
      onSelect()
    }
  }

  return (
    <li
      ref={innerRef}
      role="button"
      tabIndex={0}
      aria-pressed={selected}
      aria-label={`Visit ${index + 1}${candidate ? ', a candidate' : ''}, ${hop.camera_code}, ${api.formatIST(hop.arrived_at)} IST`}
      onMouseEnter={onEnter}
      onMouseLeave={onLeave}
      onFocus={onEnter}
      onBlur={onLeave}
      onClick={onSelect}
      onKeyDown={onKeyDown}
      className={`grid cursor-pointer grid-cols-[22px_minmax(0,1fr)_auto] gap-x-2.5 rounded-lg border px-2.5 py-2 transition ${
        impossible
          ? 'border-priority-critical/40 bg-priority-critical/[0.06]'
          : candidate
            ? 'border-dashed border-primary/50 bg-primary/[0.05]'
            : 'border-border bg-card hover:border-input'
      } ${active ? 'ring-1 ring-primary/80' : ''}`}
    >
      <span
        className={`mt-0.5 flex h-[22px] w-[22px] items-center justify-center rounded-full font-mono text-[10px] font-semibold ${BADGE[look]}`}
      >
        {index + 1}
      </span>

      <div className="min-w-0">
        <p className="flex items-baseline gap-1.5 font-mono text-xs">
          <span className="text-foreground">{istTime(hop.arrived_at, false)}</span>
          <span className="text-faint">·</span>
          <span className="truncate font-medium text-foreground">{hop.camera_code}</span>
        </p>
        <p className="truncate text-xs text-muted-foreground" title={hop.camera_name}>
          {hop.camera_name}
          {hop.city ? ` · ${hop.city}` : ''}
        </p>
        {candidate && hop.read_as && (
          <p className="mt-1 flex flex-wrap items-center gap-1.5 text-[11px] text-primary">
            <span className="font-medium uppercase tracking-[0.06em]">Candidate</span>
            <span className="text-faint">read as</span>
            <PlateChip plate={hop.read_as} size="xs" candidate title="As read — included by an analyst, not confirmed" />
          </p>
        )}
        {candidate && hop.candidate_note && (
          <p className="mt-0.5 text-[11px] leading-snug text-muted-foreground">{hop.candidate_note}</p>
        )}
        <p className="mt-0.5 flex flex-wrap gap-x-2.5 font-mono text-[11px] text-faint">
          <span title="The plate reader's agreement across frames, 0 to 1">
            read {hop.plate_confidence.toFixed(2)}
          </span>
          <span>{plural(hop.sightings, 'read')}</span>
          {hop.dwell_s > 0 && <span>seen for {formatDuration(hop.dwell_s)}</span>}
        </p>
        {leg && (
          <p
            className={`mt-0.5 font-mono text-[11px] ${impossible ? 'font-medium text-priority-critical' : candidateLeg ? 'text-primary' : 'text-muted-foreground'}`}
            title="Straight-line distance over elapsed time, from the previous visit: a lower bound on the speed actually driven."
          >
            {leg}
          </p>
        )}
        {hop.flags.length > 0 && (
          <div className="mt-1 space-y-0.5">
            {hop.flags.map((flag) => (
              <FlagLine key={flag} flag={flag} />
            ))}
          </div>
        )}
      </div>

      <div className="flex items-start pt-0.5">
        {crop && <PlateCrop url={crop} plate={hop.read_as ?? plate} height={26} />}
      </div>
    </li>
  )
}

/** One reason, in plain words: red with a triangle when the leg is impossible. */
function FlagLine({ flag }: { flag: string }) {
  const grave = GRAVE_FLAGS.has(flag)
  const tone = grave
    ? 'text-priority-critical'
    : flag === 'heading_conflict'
      ? 'text-priority-high'
      : 'text-muted-foreground'
  return (
    <p className={`flex gap-1.5 text-[11px] leading-snug ${tone}`}>
      <Icon name={grave ? 'alert' : 'info'} size={12} className="mt-px" />
      <span>{FLAG_TEXT[flag] ?? flag}</span>
    </p>
  )
}

// ── Search by attributes ──────────────────────────────────────────────

/** Windows worth offering for a browse rather than a route — shorter by
 *  default, since an attribute query with no plate to anchor it can return a
 *  lot more than one vehicle's worth of rows. */
const ATTRIBUTE_WINDOWS = [
  { value: '1', label: '1 h' },
  { value: '6', label: '6 h' },
  { value: '24', label: '24 h' },
] as const

/**
 * Search beyond plates (P9) — the PS's "white SUV, near CAM-17, 10:30-11:00"
 * case. Type, camera and time window all work today, filtering the same
 * `detections` table the plate search reads, over whatever the pipeline has
 * already produced. Colour does not — nothing in the pipeline extracts a
 * vehicle's colour yet (see BUILD_STATE.md's P9 section for exactly what is
 * and is not built) — so that field is shown, disabled, with the reason
 * stated, rather than silently accepted and always returning nothing.
 *
 * A sighting with no readable plate can still be followed: "Find similar"
 * asks re-identification (P11) for candidates at other cameras, each with the
 * reasons it was matched on. A candidate is never a confirmed sighting.
 */
function AttributeSearch({
  modeSwitch,
  onOpenPlate,
}: {
  modeSwitch: ReactNode
  /** Open a plate's journey — from a row, or from a candidate that has one. */
  onOpenPlate: (plate: string) => void
}) {
  const toast = useToast()
  const [vehicleType, setVehicleType] = useState('')
  const [cameraId, setCameraId] = useState('')
  const [cameras, setCameras] = useState<{ id: string; camera_code: string }[]>([])
  const [hours, setHours] = useState(6)
  const [results, setResults] = useState<Detection[] | null>(null)
  const [total, setTotal] = useState(0)
  const [busy, setBusy] = useState(false)

  const [reidOpenId, setReidOpenId] = useState<string | null>(null)
  const [reidResult, setReidResult] = useState<ReidMatchResponse | null>(null)
  const [reidBusy, setReidBusy] = useState(false)

  useEffect(() => {
    api
      .getCameras({ limit: '500' })
      .then((page) => setCameras(page.items))
      .catch(() => undefined)
  }, [])

  async function submit(event: FormEvent) {
    event.preventDefault()
    setBusy(true)
    try {
      const page = await api.getDetections({
        vehicle_type: vehicleType || undefined,
        camera_id: cameraId || undefined,
        since: since(hours),
        readable_only: false,
        limit: 30,
      })
      setResults(page.items)
      setTotal(page.total)
    } catch (err) {
      toast.error(err)
      setResults(null)
    } finally {
      setBusy(false)
    }
  }

  async function toggleReid(detection: Detection) {
    if (reidOpenId === detection.id) {
      setReidOpenId(null)
      setReidResult(null)
      return
    }
    setReidOpenId(detection.id)
    setReidResult(null)
    setReidBusy(true)
    try {
      const result = await api.getReidCandidates({
        detection_id: detection.id,
        detection_ts: detection.ts,
      })
      setReidResult(result)
    } catch (err) {
      toast.error(err)
      setReidOpenId(null)
    } finally {
      setReidBusy(false)
    }
  }

  return (
    <>
      <aside aria-label="Search" className={RAIL}>
        {modeSwitch}

        <form onSubmit={submit} className="flex flex-col gap-4">
          <Field label="Type">
            <Select value={vehicleType} onChange={(e) => setVehicleType(e.target.value)}>
              <option value="">Any vehicle</option>
              <option value="car">Car</option>
              <option value="motorcycle">Motorcycle</option>
              <option value="bus">Bus</option>
              <option value="truck">Truck</option>
            </Select>
          </Field>

          <Field label="Camera">
            <Select value={cameraId} onChange={(e) => setCameraId(e.target.value)}>
              <option value="">Any camera</option>
              {cameras.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.camera_code}
                </option>
              ))}
            </Select>
          </Field>

          <Field
            label="Colour"
            hint="Not available yet — nothing in the pipeline reads vehicle colour."
          >
            <Input value="" disabled placeholder="Coming later" />
          </Field>

          <div>
            <span className="eyebrow">Window</span>
            <SegmentedControl
              fill
              className="mt-1.5"
              value={String(hours)}
              onChange={(v) => setHours(Number(v))}
              options={ATTRIBUTE_WINDOWS.map((w) => ({ value: w.value, label: w.label }))}
            />
          </div>

          <Button type="submit" disabled={busy} className="h-9 w-full">
            {busy ? (
              <>
                <Spinner className="h-3.5 w-3.5 border-background border-t-transparent" />
                Searching…
              </>
            ) : (
              <>
                <Icon name="filter" size={14} />
                Search
              </>
            )}
          </Button>
        </form>

        <div className="mt-auto rounded-lg border border-border p-3 text-xs leading-relaxed text-muted-foreground">
          <p className="mb-1 font-medium text-foreground">When the plate is unreadable</p>
          Blur, darkness, angle and dirt defeat a plate reader. A sighting with no plate can still
          be followed: <span className="text-foreground">Find similar</span> lists vehicles at
          other cameras that could have been it — candidates, with their reasons, never
          confirmed sightings.
        </div>
      </aside>

      <main className="min-w-0 flex-1 overflow-y-auto p-5">
        {results === null ? (
          <EmptyState
            title="Describe the vehicle on the left, then search."
            hint="Type, camera and window filter every sighting the pipeline has made — including ones whose plate could not be read."
          />
        ) : results.length === 0 ? (
          <EmptyState
            title="Nothing matched."
            hint="Try a different type, camera or window — colour can't be filtered on yet."
          />
        ) : (
          <div>
            <p className="text-xs text-faint">
              {results.length} shown of {total} matching · newest first · times IST
            </p>
            <div className="mt-2">
              <Table>
                <Thead>
                  <tr>
                    <Th>When (IST)</Th>
                    <Th>Camera</Th>
                    <Th>Type</Th>
                    <Th>Plate</Th>
                    <Th>Evidence</Th>
                    <Th />
                  </tr>
                </Thead>
                <tbody>
                  {results.map((d) => (
                    <Fragment key={d.id}>
                      <Tr>
                        <Td className="whitespace-nowrap font-mono text-xs text-muted-foreground">
                          {api.formatIST(d.ts)}
                        </Td>
                        <Td className="font-mono text-xs">{d.camera_code}</Td>
                        <Td className="text-xs capitalize">{d.vehicle_type ?? '—'}</Td>
                        <Td>
                          {d.plate ? (
                            <button
                              type="button"
                              onClick={() => onOpenPlate(d.plate!)}
                              title="Open this vehicle's journey"
                              className="rounded transition hover:opacity-80"
                            >
                              <PlateChip plate={d.plate} size="xs" />
                            </button>
                          ) : (
                            <span className="text-xs text-faint">unread</span>
                          )}
                        </Td>
                        <Td>
                          <PlateCrop url={d.crop_url} plate={d.plate} height={22} />
                        </Td>
                        <Td className="text-right">
                          {!d.plate && (
                            <button
                              type="button"
                              onClick={() => void toggleReid(d)}
                              className="text-xs font-medium text-primary hover:underline"
                            >
                              {reidOpenId === d.id ? 'Hide similar' : 'Find similar'}
                            </button>
                          )}
                        </Td>
                      </Tr>
                      {reidOpenId === d.id && (
                        <tr key={`${d.id}-reid`}>
                          <td colSpan={6} className="border-b border-border bg-secondary/40 px-3 py-3">
                            {reidBusy ? (
                              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                                <Spinner className="h-3.5 w-3.5" />
                                Searching…
                              </div>
                            ) : !reidResult || reidResult.candidates.length === 0 ? (
                              <p className="text-xs text-muted-foreground">
                                No plausible candidate at another camera in the surrounding
                                30 minutes.
                              </p>
                            ) : (
                              <div className="space-y-2">
                                <div className="flex flex-wrap items-center gap-2">
                                  <Badge tone={reidResult.embedding_available ? 'primary' : 'neutral'}>
                                    {reidResult.embedding_available
                                      ? 'appearance-matched'
                                      : 'plausibility only'}
                                  </Badge>
                                  <p className="text-xs text-muted-foreground">{reidResult.note}</p>
                                </div>
                                <p className="eyebrow">Candidates · not confirmed</p>
                                <ul className="space-y-1.5">
                                  {reidResult.candidates.map((c) => (
                                    <li
                                      key={c.detection_id}
                                      className="rounded-md border border-dashed border-primary/40 bg-card px-3 py-2"
                                    >
                                      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                                        <span className="font-mono text-xs font-medium">
                                          {c.camera_code}
                                        </span>
                                        <span className="font-mono text-xs text-muted-foreground">
                                          {api.formatIST(c.detection_ts)}
                                        </span>
                                        <span
                                          className="font-mono text-[11px] text-faint"
                                          title="Straight line between the two cameras, so the distance and the speed are lower bounds"
                                        >
                                          ≥ {formatKm(c.distance_km)} km ·{' '}
                                          {formatDuration(c.elapsed_s)} · ≥{' '}
                                          {Math.round(c.implied_kmph)} km/h
                                        </span>
                                        {c.similarity !== null && (
                                          <Badge tone="primary">sim {c.similarity.toFixed(2)}</Badge>
                                        )}
                                        {c.plate && (
                                          <button
                                            type="button"
                                            onClick={() => onOpenPlate(c.plate!)}
                                            title="Open this plate's journey"
                                            className="rounded transition hover:opacity-80"
                                          >
                                            <PlateChip plate={c.plate} size="xs" candidate />
                                          </button>
                                        )}
                                      </div>
                                      {c.matched_on.length > 0 && (
                                        <ul className="mt-1 space-y-0.5">
                                          {c.matched_on.map((reason) => (
                                            <li
                                              key={reason.factor}
                                              className="text-[11px] leading-snug text-faint"
                                            >
                                              {reason.detail}
                                            </li>
                                          ))}
                                        </ul>
                                      )}
                                    </li>
                                  ))}
                                </ul>
                              </div>
                            )}
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  ))}
                </tbody>
              </Table>
            </div>
          </div>
        )}
      </main>
    </>
  )
}
