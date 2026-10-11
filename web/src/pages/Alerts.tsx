/**
 * Alarm triage.
 *
 * Live alerts arrive over the WebSocket and are merged into the list from the
 * database, so an alert raised while this screen is open appears without a
 * refresh and an alert raised before it was opened is still there. Getting
 * only one of those right is the usual way this screen goes wrong.
 *
 * Every action is a lifecycle transition the API records against the operator
 * who made it. `false_positive` sits alongside `closed` as a first-class
 * outcome: an operator who can only close an alert will close the wrong ones
 * silently, and those are exactly the ones worth knowing about. The API
 * refuses one without a reason, so the screen asks for the reason first
 * rather than letting the request fail.
 *
 * ## The shape: a queue and one alarm
 *
 * The queue on the left is the work, most severe first. The pane on the right
 * is the one alarm being worked: the plate drawn as a plate beside the crop it
 * was read from, why it fired, what it is about, and the next steps it can
 * take. Alarms about the same plate are drawn together, because two alarms on
 * one vehicle are one thing to deal with, not two — that is the cross-camera
 * link this product exists to make, shown where an operator acts on it.
 *
 * ## Selection is an alarm, not a row number
 *
 * The queue re-reads itself whenever an alarm is raised, and a new one lands
 * at the top. A cursor kept as a row index slid onto a different alarm every
 * time that happened — and the next `a` acknowledged whatever was now under
 * it. The selection is the alarm's id, and the address carries it
 * (`/alerts?alert=<id>`), so the Command screen can link straight to one and
 * an operator can hand a colleague the alarm they are looking at. Which
 * statuses are listed rides along as `?status=` (absent means the open
 * queue). Both are replaced in place, never pushed: Back leaves the screen
 * rather than stepping back through every alarm looked at.
 */

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type RefObject,
} from 'react'
import { Link, useSearchParams } from 'react-router-dom'

import PlateCrop from '@/components/PlateCrop'
import { Skeleton, SkeletonRows } from '@/components/Skeleton'
import { useToast } from '@/components/Toast'
import {
  Badge,
  Button,
  EmptyState,
  ErrorBanner,
  Field,
  Icon,
  InfoHint,
  Input,
  PlateChip,
  PriorityBadge,
  Select,
  SeverityGlyph,
  StatusBadge,
} from '@/components/ui'
import { useAuth } from '@/hooks/useAuth'
import { useEventStream } from '@/hooks/useEventStream'
import * as api from '@/lib/api'
import { alarmKind, alarmTitle, type AlarmKind } from '@/lib/alarms'
import { PERMISSIONS } from '@/lib/permissions'
import { spacedPlate } from '@/lib/plates'
import type { Alert, AlertReason, AlertStatus, Camera, WatchlistEntry } from '@/lib/types'

/**
 * One page of the queue. The API caps a page at 200; an open queue is rarely
 * past a dozen, and a hundred keeps the full-history view quick to read.
 */
const PAGE_SIZE = 100

/**
 * How often the queue is re-read with no live event to prompt it. A transition
 * is never announced on the socket — the health monitor closing a camera-down
 * alarm when the camera answers again, or a colleague acknowledging one — so
 * without this the queue would go on showing those as open until a reload.
 */
const REFRESH_MS = 30_000

/** Which transitions an operator is offered, given where the alert is now. */
const NEXT_STEPS: Record<AlertStatus, { to: AlertStatus; label: string }[]> = {
  new: [
    { to: 'acknowledged', label: 'Acknowledge' },
    { to: 'false_positive', label: 'False positive' },
  ],
  acknowledged: [
    { to: 'dispatched', label: 'Dispatch' },
    { to: 'closed', label: 'Close' },
    { to: 'false_positive', label: 'False positive' },
  ],
  dispatched: [
    { to: 'closed', label: 'Close' },
    { to: 'false_positive', label: 'False positive' },
  ],
  closed: [],
  false_positive: [],
}

/**
 * Which grant each transition needs, mirroring the API's own table.
 *
 * They are separate permissions because in a control room they are separate
 * authorities: acknowledging is routine, dispatching commits a unit, closing
 * ends the record.
 */
const TRANSITION_PERMISSION: Record<AlertStatus, string> = {
  new: PERMISSIONS.alertRead,
  acknowledged: PERMISSIONS.alertAcknowledge,
  dispatched: PERMISSIONS.alertDispatch,
  closed: PERMISSIONS.alertClose,
  false_positive: PERMISSIONS.alertClose,
}

/** The key that performs each transition, as printed on its button. */
const TRANSITION_KEY: Partial<Record<AlertStatus, string>> = {
  acknowledged: 'A',
  dispatched: 'D',
  closed: 'C',
  false_positive: 'F',
}

/** What the toast says happened. */
const OUTCOME: Record<AlertStatus, string> = {
  new: 'reopened',
  acknowledged: 'acknowledged',
  dispatched: 'dispatched',
  closed: 'closed',
  false_positive: 'marked a false positive',
}

const STATUS_WORD: Record<AlertStatus, string> = {
  new: 'new',
  acknowledged: 'acknowledged',
  dispatched: 'dispatched',
  closed: 'closed',
  false_positive: 'false positive',
}

const STATUS_LINE: Record<AlertStatus, string> = {
  new: 'New · not yet acknowledged',
  acknowledged: 'Acknowledged',
  dispatched: 'Dispatched',
  closed: 'Closed',
  false_positive: 'Closed as a false positive',
}

const OPEN: ReadonlySet<AlertStatus> = new Set<AlertStatus>(['new', 'acknowledged', 'dispatched'])

// ── What kind of alarm, in an operator's words ────────────────────────

// The names and kinds themselves live in lib/alarms, shared with Command.
export { alarmKind, alarmTitle } from '@/lib/alarms'
export type { AlarmKind } from '@/lib/alarms'


type KindFilter = 'all' | AlarmKind

const KIND_FILTERS: { value: KindFilter; label: string; noun: string }[] = [
  { value: 'all', label: 'All', noun: '' },
  { value: 'watchlist', label: 'Watchlist', noun: 'watchlist' },
  { value: 'journey', label: 'Journeys', noun: 'journey' },
  { value: 'camera', label: 'Cameras', noun: 'camera' },
  { value: 'other', label: 'Other', noun: 'other' },
]

/** The next step, in a sentence, for the pane's "What to do". */
function guidanceFor(alert: Alert): string {
  switch (alert.alert_type) {
    case 'watchlist_hit':
      return 'Compare the crop with the plate. If they agree, dispatch a unit; if they do not, mark it a false positive and say why.'
    case 'possible_match':
      return 'Check the crop before anything else: one misread character is enough to raise this alarm against a plate that is not watched.'
    case 'anomaly':
      return 'Open the journey and judge whether it needs a person. A route that differs from the usual is a fact about the route, not about who is driving.'
    case 'camera_down':
      return alert.camera_id
        ? "Check the camera's power and network link. This alarm closes itself when the camera answers again."
        : "Check the integration's server and its login. This alarm closes itself when a camera behind it answers again."
    default:
      return 'Review what was recorded and decide whether it needs a person.'
  }
}

const FACTOR_LABEL: Record<string, string> = {
  impossible_hop: 'Impossible leg',
  rare_transition: 'Rare route',
  slow_transition: 'Slower than usual',
  fast_transition: 'Faster than usual',
}

/** A reason's factor slug, as a label. Unknown factors are shown, not hidden. */
export function factorLabel(factor: string): string {
  return FACTOR_LABEL[factor] ?? capitalise(factor.replace(/_/g, ' '))
}

/**
 * Identical reasons folded into one line with a count.
 *
 * A journey re-scored as it grows can name the same impossible leg a dozen
 * times over; seventeen lines of which five are distinct reads as noise, and
 * an operator stops reading at the third. Nothing is dropped — the count says
 * how many there were. Order is first appearance, which is journey order.
 */
export function collapseReasons(reasons: readonly AlertReason[]): { reason: AlertReason; count: number }[] {
  const out: { reason: AlertReason; count: number }[] = []
  const at = new Map<string, number>()
  for (const reason of reasons) {
    const key = `${reason.factor}\u0000${reason.detail}`
    const index = at.get(key)
    if (index === undefined) {
      at.set(key, out.length)
      out.push({ reason, count: 1 })
    } else {
      out[index]!.count += 1
    }
  }
  return out
}

/** The reason a one-line summary leads with: an impossible leg, if there is one. */
function strongestReason(reasons: readonly AlertReason[] | null): AlertReason | null {
  if (!reasons || reasons.length === 0) return null
  return reasons.find((r) => r.factor === 'impossible_hop') ?? reasons[0] ?? null
}

/**
 * `notes` split into what the platform wrote when it raised the alarm and what
 * was added at each transition after.
 *
 * The API appends each transition's note to the same field on a new line. The
 * first line is the platform's own cause for every kind except an exact
 * watchlist hit, which is raised with no notes at all. An anomaly's first line
 * is its reasons joined into a sentence — already shown as named factors, so
 * not repeated. The `[vms:<id>]` tag the health monitor uses to find its own
 * alarm again is a key, not something to read, and is left out.
 */
export function splitNotes(alert: Pick<Alert, 'alert_type' | 'notes' | 'reasons'>): {
  cause: string | null
  notes: string[]
} {
  const lines = (alert.notes ?? '')
    .split('\n')
    .map((line) => line.replace(/\s*\[vms:[^\]]*\]/g, '').trim())
    .filter(Boolean)

  if (alert.reasons && alert.reasons.length > 0) {
    const joined = alert.reasons.map((r) => r.detail).join('; ')
    return { cause: null, notes: lines[0] === joined ? lines.slice(1) : lines }
  }
  if (alert.alert_type === 'watchlist_hit') return { cause: null, notes: lines }
  return { cause: lines[0] ?? null, notes: lines.slice(1) }
}

// ── The queue's shape ─────────────────────────────────────────────────

export interface QueueGroup {
  key: string
  kind: 'vehicle' | 'cameras' | 'single'
  plate: string | null
  alerts: Alert[]
}

/**
 * The queue, grouped: every alarm on one plate together, and the camera
 * alarms together, each group placed where its most severe alarm falls.
 *
 * The API has already sorted by severity, so a group's first alarm is its
 * worst and first appearance is the right place for the whole group. The
 * order inside a group is the API's.
 */
export function groupQueue(alerts: readonly Alert[]): QueueGroup[] {
  const groups: QueueGroup[] = []
  const byKey = new Map<string, QueueGroup>()
  for (const alert of alerts) {
    const plate = alert.plate_normalised
    const key = plate
      ? `plate:${plate}`
      : alarmKind(alert.alert_type) === 'camera'
        ? 'cameras'
        : `alert:${alert.id}`
    let group = byKey.get(key)
    if (!group) {
      group = {
        key,
        kind: plate ? 'vehicle' : key === 'cameras' ? 'cameras' : 'single',
        plate: plate ?? null,
        alerts: [],
      }
      byKey.set(key, group)
      groups.push(group)
    }
    group.alerts.push(alert)
  }
  return groups
}

/**
 * Which alarm the pane should show after the queue changed under it.
 *
 *  - The selected alarm is still listed: keep it. A new alarm arriving above
 *    it must never move the operator off the one they are reading.
 *  - Nothing selected yet: the most severe.
 *  - The operator just closed it here: the alarm that took its place, so a
 *    backlog can be cleared one keystroke at a time.
 *  - It was listed and has gone (closed elsewhere, or filtered out): the most
 *    severe.
 *  - It has never been listed — a link to an alarm this page has not loaded:
 *    keep waiting for it rather than silently showing a different one.
 */
export function reconcileSelection({
  selectedId,
  visibleIds,
  seenId,
  advance,
}: {
  selectedId: string | null
  visibleIds: readonly string[]
  seenId: string | null
  advance: { from: string; next: string | null } | null
}): string | null {
  if (selectedId !== null && visibleIds.includes(selectedId)) return selectedId
  const first = visibleIds[0] ?? null
  if (selectedId === null) return first
  if (advance && advance.from === selectedId) {
    return advance.next !== null && visibleIds.includes(advance.next) ? advance.next : first
  }
  if (seenId === selectedId) return first
  return selectedId
}

// ── Time, as an operator reads it ─────────────────────────────────────

/** "just now", "6 min", "1 h 15 min", "2 d 3 h". */
export function ageLabel(iso: string, now: number): string {
  const seconds = Math.max(0, Math.round((now - Date.parse(iso)) / 1000))
  if (seconds < 60) return 'just now'
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes} min`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return minutes % 60 ? `${hours} h ${minutes % 60} min` : `${hours} h`
  const days = Math.floor(hours / 24)
  return hours % 24 ? `${days} d ${hours % 24} h` : `${days} d`
}

const IST_DAY = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Kolkata',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
})

/** The time alone for today (IST), with the date for anything older. */
function whenIST(iso: string, now: number): string {
  return IST_DAY.format(new Date(iso)) === IST_DAY.format(new Date(now))
    ? api.formatIST(iso, false)
    : api.formatIST(iso)
}

function capitalise(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1)
}

// ── Small facts about one alarm ───────────────────────────────────────

/** Where an alarm happened, as a camera code and a place. */
function placeOf(alert: Alert, camera: Camera | undefined): string | null {
  if (camera) {
    const place = camera.junction || camera.name
    return place && place !== camera.camera_code ? `${camera.camera_code} · ${place}` : camera.camera_code
  }
  // A camera id the registry list does not hold: say so rather than print a
  // bare UUID as though it were a name.
  return alert.camera_id ? 'camera not in the registry list' : null
}

/** One line under an alarm card: why it is there, as briefly as it can be said. */
function headlineOf(alert: Alert, entry: WatchlistEntry | undefined): string | null {
  const read = alert.confidence !== null ? ` · read ${alert.confidence.toFixed(2)}` : ''
  if (alert.alert_type === 'watchlist_hit') {
    return entry
      ? `${capitalise(entry.category)}${entry.case_ref ? ` · ${entry.case_ref}` : ''} · exact${read}`
      : `Exact watchlist match${read}`
  }
  if (alert.alert_type === 'possible_match' && entry) {
    return `Near ${spacedPlate(entry.plate_normalised)} · verify before acting${read}`
  }
  const strongest = strongestReason(alert.reasons)
  if (strongest) return `${factorLabel(strongest.factor)} · ${strongest.detail}`
  return splitNotes(alert).cause
}

/** What the toast calls the alarm: its plate, its camera, or just "Alarm". */
function subjectOf(alert: Alert, camera: Camera | undefined): string {
  if (alert.plate_normalised) return spacedPlate(alert.plate_normalised)
  return camera?.camera_code ?? 'Alarm'
}

type Scope = 'open' | AlertStatus | 'all'

const SCOPES: { value: Scope; label: string; caption: string }[] = [
  { value: 'open', label: 'Open', caption: 'open' },
  { value: 'new', label: 'New', caption: 'new' },
  { value: 'acknowledged', label: 'Acknowledged', caption: 'acknowledged' },
  { value: 'dispatched', label: 'Dispatched', caption: 'dispatched' },
  { value: 'closed', label: 'Closed', caption: 'closed' },
  { value: 'false_positive', label: 'False positive', caption: 'false positives' },
  { value: 'all', label: 'Every status', caption: 'in all' },
]

/** The `?status=` value, or the open queue when it is absent or unknown. */
export function parseScope(value: string | null): Scope {
  return SCOPES.some((s) => s.value === value) ? (value as Scope) : 'open'
}

function scopeQuery(scope: Scope): api.AlertQuery {
  if (scope === 'open') return { open_only: true }
  if (scope === 'all') return {}
  return { status: scope }
}

// ── The screen ────────────────────────────────────────────────────────

export default function Alerts() {
  const toast = useToast()
  const { can, user } = useAuth()
  // The feed's connection state is drawn once, in the top bar — it is a
  // global fact and every screen was drawing its own copy.
  const { alerts: liveAlerts } = useEventStream()
  const [searchParams, setSearchParams] = useSearchParams()
  const requestedId = searchParams.get('alert')
  // Which alarms, by status, lives in the address beside the alarm itself, so
  // "the false positives from last night" is a link like any other.
  const scope = parseScope(searchParams.get('status'))

  const [alerts, setAlerts] = useState<Alert[]>([])
  const [total, setTotal] = useState(0)
  const [cameras, setCameras] = useState<Map<string, Camera>>(new Map())
  // Null until the first answer, so "not loaded yet" is never read as "the
  // entry does not exist".
  const [entries, setEntries] = useState<Map<string, WatchlistEntry> | null>(null)
  const [kind, setKind] = useState<KindFilter>('all')
  const [pages, setPages] = useState(1)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [working, setWorking] = useState<string | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(requestedId)
  const [note, setNote] = useState('')
  const [needsReason, setNeedsReason] = useState(false)
  const [now, setNow] = useState(() => Date.now())

  const noteRef = useRef<HTMLInputElement>(null)
  const cardRefs = useRef(new Map<string, HTMLButtonElement>())
  const scrolledToRef = useRef<string | null>(null)
  // The last alarm the pane actually showed, and the one to move to after an
  // action here takes the shown one off the list. See reconcileSelection.
  const seenRef = useRef<string | null>(null)
  const advanceRef = useRef<{ from: string; next: string | null } | null>(null)
  // Responses can land out of order when filters change quickly; only the
  // newest request may write the list.
  const ticketRef = useRef(0)
  const workingRef = useRef<string | null>(null)

  const mayReadWatchlist = can(PERMISSIONS.watchlistRead)

  const load = useCallback(async () => {
    const ticket = ++ticketRef.current
    try {
      // Triage order: what needs a person first, a watchlist hit before
      // anything inferred — not merely what happened last.
      const responses = await Promise.all(
        Array.from({ length: pages }, (_, page) =>
          api.getAlerts({
            ...scopeQuery(scope),
            sort: 'priority',
            limit: PAGE_SIZE,
            offset: page * PAGE_SIZE,
          }),
        ),
      )
      if (ticket !== ticketRef.current) return
      // Pages are read at slightly different moments, so an alarm can slide
      // across a page boundary between them; keep the first sighting of each.
      const ids = new Set<string>()
      const merged: Alert[] = []
      for (const response of responses) {
        for (const item of response.items) {
          if (ids.has(item.id)) continue
          ids.add(item.id)
          merged.push(item)
        }
      }
      setAlerts(merged)
      setTotal(responses[0]?.total ?? merged.length)
      setError(null)
    } catch (err) {
      if (ticket !== ticketRef.current) return
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      if (ticket === ticketRef.current) setLoading(false)
    }
  }, [scope, pages])

  useEffect(() => {
    void load()
  }, [load])

  const loadRef = useRef(load)
  useEffect(() => {
    loadRef.current = load
  }, [load])

  // An alert arriving on the socket is not yet in `alerts`. Refetch rather
  // than synthesising a row: the database record carries fields the live
  // payload does not, and a half-populated row would triage badly. Keyed on
  // the newest alert rather than the buffer, so changing a filter does not
  // read the queue twice.
  const newestLive = liveAlerts[0]?.alert_id ?? null
  const lastLiveRef = useRef(newestLive)
  useEffect(() => {
    if (newestLive === lastLiveRef.current) return
    lastLiveRef.current = newestLive
    void loadRef.current()
  }, [newestLive])

  useEffect(() => {
    const timer = window.setInterval(() => {
      setNow(Date.now())
      void loadRef.current()
    }, REFRESH_MS)
    return () => window.clearInterval(timer)
  }, [])

  // A live alert carries only ids for the camera. Resolving codes once here
  // means the list does not fire a request per row.
  useEffect(() => {
    let cancelled = false
    async function loadCameras() {
      try {
        const page = await api.getCameras({ limit: '500' })
        if (!cancelled) setCameras(new Map(page.items.map((c) => [c.id, c])))
      } catch {
        /* the queue still works without camera names */
      }
    }
    void loadCameras()
    return () => {
      cancelled = true
    }
  }, [])

  // The watchlist entry behind a hit: its case reference and reason are what
  // turn "a plate matched" into something an operator can act on. Retired
  // entries are included — an alarm outlives the entry that raised it.
  const loadEntries = useCallback(async () => {
    if (!mayReadWatchlist) return
    try {
      const list = await api.getWatchlist({ active_only: 'false', limit: '500' })
      setEntries(new Map(list.map((e) => [e.id, e])))
    } catch {
      /* an alarm still reads without its watchlist context */
    }
  }, [mayReadWatchlist])

  useEffect(() => {
    void loadEntries()
  }, [loadEntries])

  // A plate added to the watchlist after this page loaded raises alarms that
  // name an entry not yet in hand. Ask once per such entry, not on every
  // refresh of the queue.
  const askedForRef = useRef(new Set<string>())
  useEffect(() => {
    if (entries === null) return
    const unknown = alerts
      .map((a) => a.watchlist_id)
      .filter((id): id is string => !!id && !entries.has(id) && !askedForRef.current.has(id))
    if (unknown.length === 0) return
    for (const id of unknown) askedForRef.current.add(id)
    void loadEntries()
  }, [alerts, entries, loadEntries])

  const activePlates = useMemo(
    () =>
      new Set(
        [...(entries?.values() ?? [])].filter((e) => e.active).map((e) => e.plate_normalised),
      ),
    [entries],
  )

  const entryOf = useCallback(
    (alert: Alert) => (alert.watchlist_id ? entries?.get(alert.watchlist_id) : undefined),
    [entries],
  )

  /** The red ring: this vehicle is on the watchlist, now. */
  const isWatched = useCallback(
    (alert: Alert) => {
      if (!alert.plate_normalised) return false
      if (activePlates.has(alert.plate_normalised)) return true
      return alert.alert_type === 'watchlist_hit' && entryOf(alert)?.active !== false
    },
    [activePlates, entryOf],
  )

  const counts = useMemo(() => {
    const tally: Record<KindFilter, number> = { all: alerts.length, watchlist: 0, journey: 0, camera: 0, other: 0 }
    for (const alert of alerts) tally[alarmKind(alert.alert_type)] += 1
    return tally
  }, [alerts])

  const filtered = useMemo(
    () => (kind === 'all' ? alerts : alerts.filter((a) => alarmKind(a.alert_type) === kind)),
    [alerts, kind],
  )
  const groups = useMemo(() => groupQueue(filtered), [filtered])
  const ordered = useMemo(() => groups.flatMap((g) => g.alerts), [groups])
  const visibleIds = useMemo(() => ordered.map((a) => a.id), [ordered])
  const selected = useMemo(
    () => ordered.find((a) => a.id === selectedId) ?? null,
    [ordered, selectedId],
  )

  const writeAddress = useCallback(
    (id: string | null) => {
      setSearchParams(
        (current) => {
          const next = new URLSearchParams(current)
          if (id) next.set('alert', id)
          else next.delete('alert')
          return next
        },
        // Replace, not push: stepping through forty alarms must not leave
        // forty entries for the Back button to walk through.
        { replace: true },
      )
    },
    [setSearchParams],
  )

  // The selection as of this instant, readable before React has re-rendered:
  // a held-down `j` repeats faster than some renders land, and each press
  // must step from where the last one went, not from where the screen was.
  const selectedIdRef = useRef(selectedId)
  useLayoutEffect(() => {
    selectedIdRef.current = selectedId
  }, [selectedId])

  const select = useCallback(
    (id: string) => {
      selectedIdRef.current = id
      setSelectedId(id)
      writeAddress(id)
    },
    [writeAddress],
  )

  // The address changed from outside — a link followed, Back pressed.
  useEffect(() => {
    if (requestedId) setSelectedId(requestedId)
  }, [requestedId])

  useEffect(() => {
    if (loading) return
    const next = reconcileSelection({
      selectedId,
      visibleIds,
      seenId: seenRef.current,
      advance: advanceRef.current,
    })
    advanceRef.current = null
    if (next !== null && visibleIds.includes(next)) seenRef.current = next
    if (next !== selectedId) {
      setSelectedId(next)
      // A shared link names the alarm on screen; when that alarm leaves the
      // list, the address follows the one that replaced it.
      if (searchParams.has('alert')) writeAddress(next)
    }
  }, [loading, visibleIds, selectedId, searchParams, writeAddress])

  // A note belongs to the alarm it was typed against.
  useEffect(() => {
    setNote('')
    setNeedsReason(false)
  }, [selectedId])

  // Bring the selected card into view once per selection — including a linked
  // alarm far down the queue — but never yank the list back while the
  // operator is scrolling it between refreshes.
  useEffect(() => {
    if (!selectedId || scrolledToRef.current === selectedId) return
    const card = cardRefs.current.get(selectedId)
    if (!card) return
    scrolledToRef.current = selectedId
    card.scrollIntoView?.({ block: 'nearest' })
  }, [selectedId, visibleIds])

  const act = useCallback(
    async (alert: Alert, to: AlertStatus) => {
      const reason = note.trim()
      if (to === 'false_positive' && !reason) {
        // The API refuses a false positive without a reason — it is the
        // outcome most worth reviewing later. Ask for it here rather than
        // send a request that is certain to fail.
        setNeedsReason(true)
        noteRef.current?.focus()
        return
      }
      // One step at a time: a second `a` pressed before the first answer
      // would only be refused as a repeat by the API.
      if (workingRef.current) return
      workingRef.current = alert.id
      setWorking(alert.id)
      try {
        await api.transitionAlert(alert.id, to, reason || undefined)
        const camera = alert.camera_id ? cameras.get(alert.camera_id) : undefined
        toast.success(`${subjectOf(alert, camera)} ${OUTCOME[to]}. Recorded against you.`)
        setNote('')
        setNeedsReason(false)
        const index = ordered.findIndex((a) => a.id === alert.id)
        advanceRef.current = {
          from: alert.id,
          next: ordered[index + 1]?.id ?? ordered[index - 1]?.id ?? null,
        }
        await load()
      } catch (err) {
        toast.error(err)
      } finally {
        workingRef.current = null
        setWorking(null)
      }
    },
    [note, cameras, ordered, load, toast],
  )

  // ── Keyboard triage ────────────────────────────────────────────────
  // j/k to move, a/d/c/f to act. Triage in a control room is a repetitive
  // job, and reaching for a mouse for every one of forty alarms is the
  // difference between clearing a backlog and giving up on it. `c` ends an
  // alarm's life in one key and is confirmed by the toast rather than by a
  // dialog that would defeat the point of a shortcut; `f` first asks for the
  // reason the API requires, then Enter sends it.
  //
  // The listener is attached once and calls whichever handler the latest
  // render left behind, so a key never acts on the queue as it was a render
  // ago.
  const onKeyRef = useRef<(event: KeyboardEvent) => void>(() => undefined)
  useLayoutEffect(() => {
    onKeyRef.current = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null
      if (target && (['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName) || target.isContentEditable)) return
      if (event.metaKey || event.ctrlKey || event.altKey) return
      if (ordered.length === 0) return

      const currentId = selectedIdRef.current
      const index = currentId ? ordered.findIndex((a) => a.id === currentId) : -1
      const current = index >= 0 ? ordered[index] : undefined
      const step = (to: AlertStatus) => {
        if (!current || workingRef.current) return
        const allowed = (NEXT_STEPS[current.status] ?? []).some((s) => s.to === to)
        if (allowed && can(TRANSITION_PERMISSION[to])) void act(current, to)
      }

      switch (event.key.toLowerCase()) {
        case 'j': {
          const next = ordered[Math.min(index + 1, ordered.length - 1)]
          if (next) select(next.id)
          break
        }
        case 'k': {
          const next = ordered[Math.max(index - 1, 0)]
          if (next) select(next.id)
          break
        }
        case 'a':
          step('acknowledged')
          break
        case 'd':
          step('dispatched')
          break
        case 'c':
          step('closed')
          break
        case 'f':
          step('false_positive')
          break
        default:
          return
      }
      event.preventDefault()
    }
  })

  useEffect(() => {
    const listener = (event: KeyboardEvent) => onKeyRef.current(event)
    window.addEventListener('keydown', listener)
    return () => window.removeEventListener('keydown', listener)
  }, [])

  const changeScope = (next: Scope) => {
    if (next === scope) return
    setPages(1)
    // The old list is not an answer to the new question; show the skeleton
    // rather than leave it on screen looking current.
    setAlerts([])
    setLoading(true)
    setSearchParams(
      (current) => {
        const params = new URLSearchParams(current)
        if (next === 'open') params.delete('status')
        else params.set('status', next)
        return params
      },
      { replace: true },
    )
  }

  // The banner exists so a critical hit cannot be missed by an operator
  // looking at another part of the screen.
  const waitingCritical = useMemo(
    () => alerts.filter((a) => a.priority === 'critical' && a.status === 'new'),
    [alerts],
  )

  const scopeCaption = SCOPES.find((s) => s.value === scope)?.caption ?? ''
  // A link to an alarm this list does not hold — closed since the link was
  // made, most often. Ask for it by id and open the list it belongs to now,
  // rather than leave the operator to guess which filter is hiding it.
  const fetchedForRef = useRef<string | null>(null)
  const changeScopeRef = useRef(changeScope)
  changeScopeRef.current = changeScope
  useEffect(() => {
    if (loading || !requestedId || scope === 'all') return
    if (alerts.some((a) => a.id === requestedId) || fetchedForRef.current === requestedId) return
    fetchedForRef.current = requestedId
    api
      .getAlert(requestedId)
      .then((found) => {
        if (found.status !== scope) changeScopeRef.current(found.status)
      })
      .catch(() => {
        /* the "not in this list" notice stands, with its own way out */
      })
  }, [loading, requestedId, alerts, scope])

  const hasMore = total > alerts.length
  const showCameraLabel = groups.some((g) => g.kind === 'cameras') && groups.some((g) => g.kind !== 'cameras')
  const kindNoun = KIND_FILTERS.find((k) => k.value === kind)?.noun ?? ''
  // An alarm asked for by address that is loaded but hidden by the kind filter.
  const hiddenByFilter = selectedId && !selected ? alerts.some((a) => a.id === selectedId) : false

  return (
    <div className="flex min-h-0 flex-1 flex-col lg:flex-row">
      {/* ── The queue ─────────────────────────────────────────────────── */}
      <aside
        aria-label="Alarm queue"
        className="flex max-h-[50%] min-h-0 shrink-0 flex-col border-b border-border bg-chrome lg:max-h-none lg:w-[420px] lg:border-b-0 lg:border-r xl:w-[460px]"
      >
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2 px-4 pb-3 pt-4">
          <h1 className="text-base font-semibold leading-tight">Alarms</h1>
          <span className="text-xs text-faint">
            {loading ? '…' : `${total} ${scopeCaption}`} · most severe first
          </span>
          <InfoHint label="How the queue is ordered">
            Most severe first; within a severity, a watchlist hit — a known
            vehicle, read now — leads anything inferred. Alarms on one plate
            are drawn together where the worst of them falls. The queue
            re-reads itself the moment an alarm is raised, and every 30
            seconds besides.
          </InfoHint>
          <div className="ml-auto w-36">
            <Select
              aria-label="Which alarms"
              value={scope}
              onChange={(e) => changeScope(e.target.value as Scope)}
            >
              {SCOPES.map((s) => (
                <option key={s.value} value={s.value}>
                  {s.label}
                </option>
              ))}
            </Select>
          </div>
        </div>

        {/* A filter is a setting, so the chosen chip is raised rather than
            painted in the accent — the accent is the selected alarm. */}
        <div
          role="radiogroup"
          aria-label="Kind of alarm"
          className="flex flex-wrap gap-1.5 border-b border-border px-4 pb-3"
        >
          {KIND_FILTERS.filter((k) => k.value !== 'other' || counts.other > 0).map((k) => {
            const active = kind === k.value
            return (
              <button
                key={k.value}
                type="button"
                role="radio"
                aria-checked={active}
                onClick={() => setKind(k.value)}
                className={`inline-flex h-7 items-center gap-1.5 rounded-md border px-2.5 text-xs transition ${
                  active
                    ? 'border-input bg-secondary text-foreground'
                    : 'border-border text-muted-foreground hover:border-input hover:text-foreground'
                }`}
              >
                {k.label}
                <span className={`font-mono text-[11px] ${active ? 'text-muted-foreground' : 'text-faint'}`}>
                  {loading ? '–' : counts[k.value]}
                </span>
              </button>
            )
          })}
        </div>

        {waitingCritical.length > 0 && (
          <button
            type="button"
            onClick={() => {
              const first = waitingCritical[0]
              if (!first) return
              setKind('all')
              select(first.id)
            }}
            className="mx-2.5 mt-3 flex shrink-0 items-center gap-2 rounded-md border border-priority-critical/50 bg-priority-critical/10 px-3 py-2 text-left text-[13px] font-medium text-priority-critical transition hover:bg-priority-critical/15"
          >
            <span className="animate-pulse-alert">
              <SeverityGlyph priority="critical" size={11} />
            </span>
            {waitingCritical.length} critical alarm{waitingCritical.length === 1 ? '' : 's'} awaiting
            acknowledgement
            <Icon name="arrowRight" size={14} className="ml-auto" />
          </button>
        )}

        {error && (
          <div className="mx-2.5 mt-3 shrink-0">
            <ErrorBanner>Could not read the alarms: {error}</ErrorBanner>
          </div>
        )}

        <div className="min-h-0 flex-1 overflow-y-auto px-2.5 pb-3">
          {loading ? (
            <div className="px-1.5 pt-3">
              <SkeletonRows rows={5} height="h-[92px]" />
            </div>
          ) : ordered.length === 0 ? (
            error && alerts.length === 0 ? null : (
              <EmptyState
                className="mx-1.5 mt-3"
                title={
                  alerts.length > 0
                    ? `No ${kindNoun} alarms ${scope === 'open' ? 'open' : 'here'}.`
                    : scope === 'open'
                      ? 'Nothing open.'
                      : `No ${scopeCaption} alarms.`
                }
                hint={
                  alerts.length > 0
                    ? undefined
                    : scope === 'open'
                      ? 'Put a plate on the watchlist, and a sighting on any camera will raise one here.'
                      : undefined
                }
              />
            )
          ) : (
            groups.map((group) => {
              const together = group.kind === 'vehicle' && group.alerts.length > 1
              return (
                <div key={group.key} className="pt-3">
                  {together && group.plate && (
                    <div className="flex items-center gap-2 px-1.5 pb-2">
                      <PlateChip
                        plate={group.plate}
                        size="xs"
                        watched={group.alerts.some(isWatched)}
                      />
                      <span className="text-xs text-muted-foreground">
                        {group.alerts.length} alarms · one vehicle
                      </span>
                    </div>
                  )}
                  {group.kind === 'cameras' && showCameraLabel && (
                    <p className="eyebrow px-1.5 pb-2 pt-1">Cameras</p>
                  )}
                  <ul className="space-y-2">
                    {group.alerts.map((alert) => (
                      <li key={alert.id}>
                        <AlarmCard
                          alert={alert}
                          camera={alert.camera_id ? cameras.get(alert.camera_id) : undefined}
                          entry={entryOf(alert)}
                          watched={isWatched(alert)}
                          showPlate={!together}
                          selected={alert.id === selectedId}
                          now={now}
                          onSelect={() => select(alert.id)}
                          cardRef={(el) => {
                            if (el) cardRefs.current.set(alert.id, el)
                            else cardRefs.current.delete(alert.id)
                          }}
                        />
                      </li>
                    ))}
                  </ul>
                </div>
              )
            })
          )}
        </div>

        {/* Triage here is repetitive, so the shortcuts are advertised rather
            than left to be discovered. */}
        <footer className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1.5 border-t border-border px-4 py-2.5 text-[11px] text-faint">
          <span className="inline-flex items-center gap-1">
            <kbd className="kbd">J</kbd>
            <kbd className="kbd">K</kbd>
            move
          </span>
          <span className="inline-flex items-center gap-1">
            <kbd className="kbd">A</kbd>
            ack
          </span>
          <span className="inline-flex items-center gap-1">
            <kbd className="kbd">D</kbd>
            dispatch
          </span>
          <span className="inline-flex items-center gap-1">
            <kbd className="kbd">C</kbd>
            close
          </span>
          <span className="inline-flex items-center gap-1">
            <kbd className="kbd">F</kbd>
            false
          </span>
          {hasMore && !loading && (
            <span className="ml-auto inline-flex items-center gap-2">
              <span className="font-mono">
                {alerts.length} of {total}
              </span>
              <Button size="sm" variant="ghost" onClick={() => setPages((p) => p + 1)}>
                Show {Math.min(PAGE_SIZE, total - alerts.length)} more
              </Button>
            </span>
          )}
        </footer>
      </aside>

      {/* ── The alarm being worked ────────────────────────────────────── */}
      <section aria-label="Selected alarm" className="min-h-0 min-w-0 flex-1 overflow-y-auto">
        {loading ? (
          <div className="flex flex-col gap-5 px-6 py-5" aria-busy="true">
            <Skeleton className="h-7 w-80 max-w-full" />
            <div className="flex flex-wrap gap-4">
              <Skeleton className="h-60 flex-[1_1_320px]" />
              <Skeleton className="h-60 flex-[1_1_300px]" />
            </div>
            <Skeleton className="h-32 w-full" />
          </div>
        ) : selected ? (
          <AlarmDetail
            key={selected.id}
            alert={selected}
            camera={selected.camera_id ? cameras.get(selected.camera_id) : undefined}
            entry={entryOf(selected)}
            entriesLoaded={entries !== null}
            watched={isWatched(selected)}
            siblings={
              selected.plate_normalised
                ? alerts.filter(
                    (a) => a.id !== selected.id && a.plate_normalised === selected.plate_normalised,
                  )
                : []
            }
            now={now}
            userId={user?.id ?? null}
            can={can}
            working={working === selected.id}
            note={note}
            onNote={setNote}
            onCancelReason={() => setNeedsReason(false)}
            needsReason={needsReason}
            noteRef={noteRef}
            onAct={(to) => void act(selected, to)}
            onSelect={select}
          />
        ) : selectedId ? (
          <div className="px-6 py-5">
            <div className="rounded-lg border border-dashed border-border px-6 py-8">
              <p className="text-[15px] font-medium">That alarm is not in this list.</p>
              <p className="mt-1.5 max-w-prose text-xs leading-relaxed text-faint">
                {hiddenByFilter
                  ? 'It is loaded, but hidden by the kind of alarm chosen above.'
                  : scope === 'all'
                    ? `It is not among the ${alerts.length} most severe alarms loaded here.`
                    : `It may have been closed since the link was made — this list shows ${scopeCaption} alarms only.`}
              </p>
              <div className="mt-4 flex flex-wrap gap-2">
                {hiddenByFilter && (
                  <Button size="sm" variant="outline" onClick={() => setKind('all')}>
                    Show every kind
                  </Button>
                )}
                {!hiddenByFilter && scope !== 'all' && (
                  <Button size="sm" variant="outline" onClick={() => changeScope('all')}>
                    Look in every status
                  </Button>
                )}
                {!hiddenByFilter && scope === 'all' && hasMore && (
                  <Button size="sm" variant="outline" onClick={() => setPages((p) => p + 1)}>
                    Load {Math.min(PAGE_SIZE, total - alerts.length)} more
                  </Button>
                )}
                {ordered[0] && (
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => {
                      const first = ordered[0]
                      if (first) select(first.id)
                    }}
                  >
                    Go to the most severe
                  </Button>
                )}
              </div>
            </div>
          </div>
        ) : (
          <div className="flex h-full items-center justify-center px-6 py-10">
            <div className="max-w-sm text-center">
              <p className="text-[15px] font-medium">
                {scope === 'open' ? 'Nothing needs a person right now.' : 'No alarm to show.'}
              </p>
              <p className="mt-1.5 text-xs leading-relaxed text-faint">
                An alarm appears in the queue the moment it is raised. This screen
                listens to the live feed, and re-reads the queue every 30 seconds.
              </p>
            </div>
          </div>
        )}
      </section>
    </div>
  )
}

// ── One card in the queue ─────────────────────────────────────────────

function AlarmCard({
  alert,
  camera,
  entry,
  watched,
  showPlate,
  selected,
  now,
  onSelect,
  cardRef,
}: {
  alert: Alert
  camera: Camera | undefined
  entry: WatchlistEntry | undefined
  watched: boolean
  /** False inside a vehicle group, whose header already shows the plate. */
  showPlate: boolean
  selected: boolean
  now: number
  onSelect: () => void
  cardRef: (el: HTMLButtonElement | null) => void
}) {
  const open = OPEN.has(alert.status)
  // Grey when normal: only an open alarm is drawn as needing someone. A
  // closed critical alarm keeps its severity as a shape and a word, quietly.
  const critical = open && alert.priority === 'critical'
  const place = placeOf(alert, camera)
  const headline = headlineOf(alert, entry)
  const distinctReasons = alert.reasons ? collapseReasons(alert.reasons).length : 0
  const plateShown = showPlate ? alert.plate_normalised : null
  // What the alarm is about — a plate, a camera. An integration alarm has
  // neither, and its one line of cause moves up rather than leave a row empty.
  const identified = Boolean(plateShown || place)

  return (
    <button
      ref={cardRef}
      type="button"
      aria-pressed={selected}
      onClick={onSelect}
      className={`grid w-full grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-x-2.5 gap-y-1.5 rounded-lg border p-3 text-left transition ${
        critical
          ? 'border-priority-critical/40 bg-priority-critical/[0.07]'
          : 'border-border bg-card'
      } ${selected ? 'ring-2 ring-primary/70' : 'hover:border-muted-foreground/40'}`}
    >
      <PriorityBadge priority={alert.priority} solid={open} />
      <span className={`truncate text-[13px] font-semibold ${open ? '' : 'text-muted-foreground'}`}>
        {alarmTitle(alert)}
      </span>
      <span
        className={`whitespace-nowrap font-mono text-[11px] ${
          critical && alert.status === 'new' ? 'text-priority-critical' : 'text-faint'
        }`}
      >
        {ageLabel(alert.created_at, now)}
      </span>

      <span aria-hidden="true" />
      {identified ? (
        <span className="flex min-w-0 items-center gap-2">
          {plateShown && <PlateChip plate={plateShown} size="xs" watched={watched} />}
          {place && <span className="truncate font-mono text-[11px] text-muted-foreground">{place}</span>}
        </span>
      ) : (
        <span className="truncate text-xs text-muted-foreground">{headline}</span>
      )}
      <span className="whitespace-nowrap text-right font-mono text-[11px] text-faint">
        {STATUS_WORD[alert.status]}
      </span>

      {identified && headline && (
        <>
          <span aria-hidden="true" />
          <span className="col-span-2 flex min-w-0 items-baseline gap-2 text-xs text-muted-foreground">
            <span className="truncate">{headline}</span>
            {distinctReasons > 1 && (
              <span
                className="shrink-0 font-mono text-[11px] text-faint"
                title={`${distinctReasons - 1} more reason${distinctReasons === 2 ? '' : 's'}`}
              >
                +{distinctReasons - 1}
              </span>
            )}
          </span>
        </>
      )}
    </button>
  )
}

// ── The selected alarm ────────────────────────────────────────────────

function AlarmDetail({
  alert,
  camera,
  entry,
  entriesLoaded,
  watched,
  siblings,
  now,
  userId,
  can,
  working,
  note,
  onNote,
  onCancelReason,
  needsReason,
  noteRef,
  onAct,
  onSelect,
}: {
  alert: Alert
  camera: Camera | undefined
  entry: WatchlistEntry | undefined
  entriesLoaded: boolean
  watched: boolean
  /** Other loaded alarms on the same plate. */
  siblings: Alert[]
  now: number
  userId: string | null
  can: (permission: string) => boolean
  working: boolean
  note: string
  onNote: (value: string) => void
  /** The operator backed out of marking a false positive. */
  onCancelReason: () => void
  needsReason: boolean
  noteRef: RefObject<HTMLInputElement>
  onAct: (to: AlertStatus) => void
  onSelect: (id: string) => void
}) {
  const open = OPEN.has(alert.status)
  const plate = alert.plate_normalised
  const { cause, notes } = splitNotes(alert)
  const steps = NEXT_STEPS[alert.status] ?? []
  const allowed = steps.filter((step) => can(TRANSITION_PERMISSION[step.to]))
  // Forward steps first; the two that end an alarm sit apart, to the right,
  // where they are deliberate rather than the nearest thing to hand.
  const forward = allowed.filter((s) => s.to === 'acknowledged' || s.to === 'dispatched')
  const ending = allowed.filter((s) => s.to === 'closed' || s.to === 'false_positive')

  const tone =
    open && alert.priority === 'critical'
      ? 'border-priority-critical/40 bg-priority-critical/[0.07]'
      : open && alert.priority === 'high'
        ? 'border-priority-high/30 bg-card'
        : 'border-border bg-card'
  const labelTone = open && alert.priority === 'critical' ? 'text-priority-critical' : ''

  const actor = !alert.acknowledged_by
    ? 'the platform'
    : alert.acknowledged_by === userId
      ? 'you'
      : 'another user'

  return (
    <div className="flex flex-col gap-5 px-6 py-5">
      {/* The time wraps under the title before the status gives up its
          place on the right — the status is what an operator checks first. */}
      <header className="flex items-start gap-3">
        <span className="pt-1">
          <PriorityBadge priority={alert.priority} solid={open} />
        </span>
        <div className="flex min-w-0 flex-1 flex-wrap items-baseline gap-x-3 gap-y-1">
          <h2 className="text-[22px] font-semibold leading-tight tracking-tight">{alarmTitle(alert)}</h2>
          <span className="font-mono text-xs text-muted-foreground">
            {whenIST(alert.created_at, now)} IST · {ageLabel(alert.created_at, now)}
            {ageLabel(alert.created_at, now) === 'just now' ? '' : ' ago'}
          </span>
        </div>
        <span className="inline-flex h-6 shrink-0 items-center whitespace-nowrap rounded-full border border-input px-2.5 text-xs text-muted-foreground">
          {STATUS_LINE[alert.status]}
        </span>
      </header>

      {/* Two columns, each as tall as what it holds: the evidence and where
          it was seen on the left, what the alarm is about on the right. A
          camera alarm has nothing for the right, and takes the width. */}
      <div className="flex flex-wrap items-start gap-4">
        <div className="flex min-w-0 flex-[1_1_320px] flex-col gap-4">
          {/* ── Evidence: the plate and the pixels it was read from ── */}
          {plate ? (
            <div className="flex flex-col gap-3 rounded-lg border border-border bg-card p-4">
              <PlateChip plate={plate} size="xl" watched={watched} className="self-start" />
              {/* The photograph the alarm is about. An operator acting on a
                  watchlist hit is being asked to trust a string read off a
                  moving vehicle; showing the pixels it came from is what makes
                  that judgement possible. */}
              <div className="flex h-28 items-center justify-center overflow-hidden rounded-md bg-background">
                <PlateCrop
                  url={alert.crop_url}
                  plate={plate}
                  height={88}
                  fallback={
                    <p className="max-w-xs px-4 text-center text-xs leading-relaxed text-faint">
                      {alert.alert_type === 'anomaly'
                        ? 'A journey finding has no single photograph — it is drawn from several sightings. Open the journey to see each one.'
                        : alert.crop_url
                          ? 'The crop has not arrived — it may still be uploading, or could not be fetched.'
                          : 'This read was stored without a crop.'}
                    </p>
                  }
                />
              </div>
              <dl className="flex flex-wrap gap-x-5 gap-y-1 text-xs text-muted-foreground">
                {alert.alert_type === 'watchlist_hit' && (
                  <div>
                    <dt className="sr-only">Match</dt>
                    <dd>Exact match</dd>
                  </div>
                )}
                {alert.alert_type === 'possible_match' && (
                  <div>
                    <dt className="sr-only">Match</dt>
                    <dd>Near match</dd>
                  </div>
                )}
                {alert.confidence !== null && (
                  <div className="flex gap-1.5">
                    <dt>Confidence</dt>
                    <dd className="font-mono text-foreground">{alert.confidence.toFixed(2)}</dd>
                  </div>
                )}
                {alert.reasons && alert.reasons.length > 0 && (
                  <div>
                    <dt className="sr-only">Reasons</dt>
                    <dd>
                      {collapseReasons(alert.reasons).length} reason
                      {collapseReasons(alert.reasons).length === 1 ? '' : 's'}, below
                    </dd>
                  </div>
                )}
              </dl>
            </div>
          ) : (
            <div className="flex flex-col gap-2 rounded-lg border border-border bg-card p-4">
              <p className="eyebrow">{alert.camera_id ? 'Camera' : 'Integration'}</p>
              {camera ? (
                <CameraFacts camera={camera} can={can} large />
              ) : alert.camera_id ? (
                <p className="text-[13px] text-muted-foreground">
                  This camera is not in the registry list this screen read.
                </p>
              ) : (
                <p className="text-[13px] leading-relaxed text-muted-foreground">
                  No single camera: an integration — a recorder, or a vendor&apos;s
                  camera grid — is not answering, so every camera behind it is out
                  of reach at once.
                </p>
              )}
            </div>
          )}

          {plate && (
            <div className="rounded-lg border border-border bg-card p-4">
              {/* An anomaly is scored as a journey advances, so its camera is
                  where the vehicle had got to — not where anything was read
                  wrongly. */}
              <p className="eyebrow">{alert.alert_type === 'anomaly' ? 'Last seen at' : 'Read at'}</p>
              {camera ? (
                <div className="mt-1.5">
                  <CameraFacts camera={camera} can={can} />
                </div>
              ) : (
                <p className="mt-1.5 text-[13px] text-muted-foreground">
                  {alert.camera_id
                    ? 'This camera is not in the registry list this screen read.'
                    : 'No camera is recorded against this alarm.'}
                </p>
              )}
            </div>
          )}
        </div>

        {/* ── What it is about ── */}
        {(alert.watchlist_id || plate) && (
          <div className="flex min-w-0 flex-[1_1_300px] flex-col gap-4">
            {alert.watchlist_id && (
              <div className="rounded-lg border border-border bg-card p-4">
                <p className="eyebrow">Watchlist entry</p>
                {entry ? (
                  <div className="mt-1.5 space-y-1">
                    <p className="text-[15px] font-medium">
                      {capitalise(entry.category)}
                      {entry.case_ref && (
                        <>
                          {' · '}
                          <span className="font-mono text-[13px]">{entry.case_ref}</span>
                        </>
                      )}
                    </p>
                    {entry.remarks && (
                      <p className="text-[13px] leading-relaxed text-muted-foreground">{entry.remarks}</p>
                    )}
                    <p className="text-xs text-faint">
                      Added {api.formatIST(entry.created_at)} IST ·{' '}
                      {entry.active ? 'watched now' : 'retired since'}
                    </p>
                    {alert.alert_type === 'possible_match' && (
                      <div className="flex flex-wrap items-center gap-2 pt-2">
                        <PlateChip plate={entry.plate_normalised} size="sm" watched={entry.active} />
                        <span className="text-xs text-muted-foreground">the watched plate this read nearly matches</span>
                      </div>
                    )}
                  </div>
                ) : (
                  <p className="mt-1.5 text-[13px] text-muted-foreground">
                    {!can(PERMISSIONS.watchlistRead)
                      ? 'Reading the entry needs the watchlist.read permission.'
                      : entriesLoaded
                        ? 'The entry this alarm names was not among those this screen read.'
                        : 'Reading the entry…'}
                  </p>
                )}
                {can(PERMISSIONS.watchlistRead) && (
                  <Link
                    to="/watchlist"
                    className="mt-2 inline-flex items-center gap-1 text-xs text-primary hover:underline"
                  >
                    Watchlist <Icon name="arrowRight" size={12} />
                  </Link>
                )}
              </div>
            )}
            {plate && (
              <div className="rounded-lg border border-border bg-card p-4">
                <p className="eyebrow">This vehicle</p>
                {siblings.length > 0 ? (
                  <ul className="mt-2 space-y-1.5">
                    {siblings.slice(0, 5).map((other) => (
                      <li key={other.id}>
                        <button
                          type="button"
                          onClick={() => onSelect(other.id)}
                          className="flex w-full items-center gap-2 rounded-md px-1.5 py-1 text-left text-[13px] transition hover:bg-secondary/60"
                        >
                          <PriorityBadge priority={other.priority} />
                          <span className="truncate">{alarmTitle(other)}</span>
                          <span className="ml-auto shrink-0 font-mono text-[11px] text-faint">
                            {ageLabel(other.created_at, now)} · {STATUS_WORD[other.status]}
                          </span>
                        </button>
                      </li>
                    ))}
                    {siblings.length > 5 && (
                      <li className="px-1.5 text-xs text-faint">and {siblings.length - 5} more in the queue</li>
                    )}
                  </ul>
                ) : (
                  <p className="mt-1.5 text-[13px] text-muted-foreground">
                    No other alarm on this plate in the list.
                  </p>
                )}
                {can(PERMISSIONS.searchExecute) && (
                  <Link
                    to={`/vehicles?plate=${encodeURIComponent(plate)}`}
                    className="mt-2 inline-flex items-center gap-1 text-xs text-primary hover:underline"
                  >
                    Open the journey <Icon name="arrowRight" size={12} />
                  </Link>
                )}
              </div>
            )}
          </div>
        )}
      </div>

      {/* ── Why it fired, and what to do about it ──
          The explainability rule: an alert that carries reasons is shown as
          its named factors, not the raw `notes` string those factors were
          joined into — `Risk: 87%` alone is a bug; the factors are the
          feature. A kind with no reasons of its own says why in words. */}
      <section aria-label="Why this alarm fired" className={`rounded-lg border p-4 ${tone}`}>
        <p className={`eyebrow ${labelTone}`}>Why it fired</p>
        <div className="mt-2">
          {alert.reasons && alert.reasons.length > 0 ? (
            <ul className="space-y-2">
              {collapseReasons(alert.reasons).map(({ reason, count }, i) => (
                <li key={`${reason.factor}-${i}`} className="flex flex-wrap items-start gap-x-2.5 gap-y-1">
                  <Badge tone={reason.factor === 'impossible_hop' ? 'danger' : 'neutral'}>
                    {factorLabel(reason.factor)}
                  </Badge>
                  <span className="min-w-0 flex-1 text-[13px] leading-relaxed">{reason.detail}</span>
                  {count > 1 && (
                    <span className="font-mono text-[11px] text-faint" title={`Named ${count} times`}>
                      ×{count}
                    </span>
                  )}
                </li>
              ))}
            </ul>
          ) : alert.alert_type === 'watchlist_hit' ? (
            <p className="text-[13px] leading-relaxed">
              A plate on the watchlist was read with an exact match
              {alert.confidence !== null ? (
                <>
                  , at confidence <span className="font-mono">{alert.confidence.toFixed(2)}</span>
                </>
              ) : null}
              {entry ? (
                <>
                  {' '}
                  — listed as <span className="font-medium">{entry.category}</span>
                  {entry.case_ref ? (
                    <>
                      {' '}under <span className="font-mono">{entry.case_ref}</span>
                    </>
                  ) : null}
                </>
              ) : null}
              .
            </p>
          ) : (
            <p className="text-[13px] leading-relaxed">
              {cause ?? 'No reason was recorded with this alarm.'}
            </p>
          )}
        </div>
        <div className="mt-4 border-t border-border pt-3">
          <p className={`eyebrow ${labelTone}`}>What to do</p>
          <p className="mt-1.5 text-[13px] leading-relaxed text-muted-foreground">{guidanceFor(alert)}</p>
        </div>
      </section>

      {/* ── The next step ── */}
      <section aria-label="Actions" className="flex flex-col gap-3">
        {allowed.length > 0 ? (
          <>
            <Field
              label={needsReason ? 'Why is this a false positive?' : 'Note for the record'}
              hint={
                needsReason ? (
                  <span className="text-priority-high">
                    A false positive must say why — it is the outcome most worth
                    reviewing later. Type the reason, then press Enter.
                  </span>
                ) : (
                  'Saved with the next step, against your account. Optional, except for a false positive.'
                )
              }
            >
              <Input
                ref={noteRef}
                value={note}
                maxLength={500}
                onChange={(e) => onNote(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && needsReason && note.trim()) {
                    e.preventDefault()
                    onAct('false_positive')
                  } else if (e.key === 'Escape') {
                    // Back to the queue's keys, and out of the false-positive
                    // question if that is what was being asked.
                    onCancelReason()
                    e.currentTarget.blur()
                  }
                }}
                placeholder={
                  needsReason
                    ? 'For example: the crop shows a different plate'
                    : 'What you checked, or which unit you sent'
                }
                aria-invalid={needsReason || undefined}
              />
            </Field>
            <div className="flex flex-wrap items-center gap-2">
              {forward.map((step) => (
                <Button
                  key={step.to}
                  variant={step.to === 'dispatched' ? 'destructive' : 'primary'}
                  disabled={working}
                  onClick={() => onAct(step.to)}
                >
                  {step.label}
                  <kbd
                    className={`kbd ${
                      step.to === 'dispatched'
                        ? 'border-status-offline/40 text-status-offline'
                        : 'border-background/30 text-background/70'
                    }`}
                  >
                    {TRANSITION_KEY[step.to]}
                  </kbd>
                </Button>
              ))}
              <span className="flex-1" />
              {ending.map((step) => (
                <Button key={step.to} variant="ghost" disabled={working} onClick={() => onAct(step.to)}>
                  {step.label}
                  <kbd className="kbd">{TRANSITION_KEY[step.to]}</kbd>
                </Button>
              ))}
            </div>
          </>
        ) : (
          <p className="text-xs text-muted-foreground">
            {steps.length > 0
              ? `${capitalise(STATUS_WORD[alert.status])} — your role cannot advance this alarm.`
              : `${STATUS_LINE[alert.status]} — nothing is left to do on this alarm.`}
          </p>
        )}
      </section>

      {/* ── The record ──
          What the API can say about this alarm's life: when it was raised,
          and the most recent step — `acknowledged_at` is restamped on every
          transition, so it is the time the alarm reached its current state,
          whatever that is. */}
      <section aria-label="Record" className="border-t border-border pt-4">
        <p className="eyebrow">Record</p>
        <ol className="mt-2 space-y-1.5 text-xs">
          <li className="flex flex-wrap gap-x-2">
            <span className="font-mono text-muted-foreground">{api.formatIST(alert.created_at)}</span>
            <span>raised by the platform</span>
          </li>
          {alert.status !== 'new' && alert.acknowledged_at && (
            <li className="flex flex-wrap gap-x-2">
              <span className="font-mono text-muted-foreground">{api.formatIST(alert.acknowledged_at)}</span>
              <span>
                {STATUS_WORD[alert.status]} by {actor}
              </span>
            </li>
          )}
          {alert.status === 'new' && <li className="text-faint">— waiting for an operator</li>}
        </ol>
        {notes.length > 0 && (
          <>
            <p className="eyebrow mt-4">Notes</p>
            <ul className="mt-2 space-y-1.5">
              {notes.map((line, i) => (
                <li key={i} className="text-[13px] leading-relaxed text-muted-foreground">
                  {line}
                </li>
              ))}
            </ul>
          </>
        )}
      </section>
    </div>
  )
}

/** A camera's identity and where it is, with the ways into it. */
function CameraFacts({
  camera,
  can,
  large = false,
}: {
  camera: Camera
  can: (permission: string) => boolean
  large?: boolean
}) {
  const where = [camera.junction, camera.city, camera.district].filter(Boolean).join(', ')
  return (
    <div className="space-y-1">
      <p className="flex flex-wrap items-center gap-2">
        <span className={`font-mono font-medium ${large ? 'text-[22px] leading-tight' : 'text-sm'}`}>
          {camera.camera_code}
        </span>
        <StatusBadge status={camera.status} />
      </p>
      {camera.name !== camera.camera_code && (
        <p className="text-[13px] text-muted-foreground">{camera.name}</p>
      )}
      {where && <p className="text-xs text-faint">{where}</p>}
      <div className="flex flex-wrap gap-x-4 gap-y-1 pt-1.5 text-xs">
        {can(PERMISSIONS.streamView) && camera.has_stream && (
          <Link
            to={`/anpr?camera=${encodeURIComponent(camera.camera_code)}`}
            className="inline-flex items-center gap-1 text-primary hover:underline"
          >
            Watch live <Icon name="arrowRight" size={12} />
          </Link>
        )}
        <Link
          to={`/cameras?camera=${encodeURIComponent(camera.camera_code)}`}
          className="inline-flex items-center gap-1 text-primary hover:underline"
        >
          Camera record <Icon name="arrowRight" size={12} />
        </Link>
      </div>
    </div>
  )
}
