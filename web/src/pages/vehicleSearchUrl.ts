/**
 * What the Investigate screen reads from its address, and writes back to it.
 *
 * `/vehicles?plate=GJ03AB1234` opens that vehicle's journey directly: the ⌘K
 * palette links here that way, and so can any other screen that shows a plate.
 * `since` and `until` (UTC, ISO 8601) pin an exact window — the same pair the
 * printable report takes — so a link can open the journey around a moment
 * rather than "the last 24 hours" from whenever it happens to be clicked.
 *
 * `include` and `dismiss` carry an analyst's decisions on candidate sightings
 * (reads of a slightly different plate that may be this vehicle): comma-
 * separated detection ids. They belong to the plate they were made about, so
 * opening another plate drops them; the link carries the hypothesis exactly,
 * and the audit trail holds who made each decision and when.
 *
 * Pure functions, so the parsing a shared link depends on is tested rather
 * than eyeballed.
 */

/** The form every lookup uses: upper case, letters and digits only. */
export function toSearchPlate(text: string): string {
  return text.toUpperCase().replace(/[^A-Z0-9]/g, '')
}

/** The plate a link asks for, normalised, or null when it names none. */
export function plateFromParams(params: URLSearchParams): string | null {
  const plate = toSearchPlate(params.get('plate') ?? '')
  return plate || null
}

/** A window with a fixed start and, optionally, a fixed end. */
export interface ExactWindow {
  since: string
  until: string | null
}

/**
 * The exact window a link asks for, or null when it asks for none.
 *
 * A start that cannot be read, or an end that is not after the start, is
 * ignored rather than repaired: the screen falls back to its own default
 * window, which it shows, instead of searching a window nobody chose.
 */
export function windowFromParams(params: URLSearchParams): ExactWindow | null {
  const sinceRaw = params.get('since')
  if (!sinceRaw) return null
  const from = Date.parse(sinceRaw)
  if (Number.isNaN(from)) return null

  const untilRaw = params.get('until')
  if (!untilRaw) return { since: new Date(from).toISOString(), until: null }
  const to = Date.parse(untilRaw)
  if (Number.isNaN(to) || to <= from) return null
  return { since: new Date(from).toISOString(), until: new Date(to).toISOString() }
}

/**
 * The address for a plate being looked at. An exact window travels with it;
 * a relative one ("last 24 h") does not, because it would mean a different
 * window to whoever opens the link later. Unrelated parameters are kept.
 */
export function paramsFor(
  current: URLSearchParams,
  plate: string,
  exact: ExactWindow | null,
): URLSearchParams {
  const next = new URLSearchParams(current)
  // Decisions about candidates are about one plate's journey.
  if (plateFromParams(current) !== plate) {
    next.delete(INCLUDE)
    next.delete(DISMISS)
  }
  next.set('plate', plate)
  if (exact) {
    next.set('since', exact.since)
    if (exact.until) next.set('until', exact.until)
    else next.delete('until')
  } else {
    next.delete('since')
    next.delete('until')
  }
  return next
}

// ── Decisions on candidate sightings ─────────────────────────────────

const INCLUDE = 'include'
const DISMISS = 'dismiss'

/** A detection id as the API issues it — anything else in a link is ignored. */
const DETECTION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** The most a link carries of either list; the API takes at most 20 includes. */
export const MAX_DECISIONS = 20

/** Candidate sightings an analyst included in the journey, or dismissed. */
export interface Decisions {
  include: string[]
  dismiss: string[]
}

export const NO_DECISIONS: Decisions = { include: [], dismiss: [] }

function idsFrom(raw: string | null): string[] {
  const ids = (raw ?? '')
    .split(',')
    .map((id) => id.trim().toLowerCase())
    .filter((id) => DETECTION_ID.test(id))
  return [...new Set(ids)].slice(0, MAX_DECISIONS)
}

/**
 * The decisions a link carries. Ids that are not detection ids are dropped,
 * and a read both included and dismissed counts as included — the later act
 * replaces the earlier one when it is made here, so both at once can only be
 * a hand-edited link, and leaving a read in the journey with its candidate
 * mark is the reversible reading of it.
 */
export function decisionsFromParams(params: URLSearchParams): Decisions {
  const include = idsFrom(params.get(INCLUDE))
  const dismiss = idsFrom(params.get(DISMISS)).filter((id) => !include.includes(id))
  return { include, dismiss }
}

/** The address with these decisions; empty lists leave no parameter behind. */
export function paramsWithDecisions(current: URLSearchParams, decisions: Decisions): URLSearchParams {
  const next = new URLSearchParams(current)
  for (const [key, ids] of [
    [INCLUDE, decisions.include],
    [DISMISS, decisions.dismiss],
  ] as const) {
    if (ids.length > 0) next.set(key, ids.slice(0, MAX_DECISIONS).join(','))
    else next.delete(key)
  }
  return next
}

/** Apply one decision: include and dismiss replace each other; undo clears both. */
export function decide(
  decisions: Decisions,
  id: string,
  decision: 'include' | 'dismiss' | 'undo',
): Decisions {
  const include = decisions.include.filter((x) => x !== id)
  const dismiss = decisions.dismiss.filter((x) => x !== id)
  if (decision === 'include') include.push(id)
  if (decision === 'dismiss') dismiss.push(id)
  return { include, dismiss }
}

/** Undo, include or dismiss one candidate, named by any of its reads. */
export function decideCandidate(
  decisions: Decisions,
  ids: string[],
  decision: 'include' | 'dismiss' | 'undo',
): Decisions {
  const [representative] = ids
  const cleared = {
    include: decisions.include.filter((x) => !ids.includes(x)),
    dismiss: decisions.dismiss.filter((x) => !ids.includes(x)),
  }
  return representative ? decide(cleared, representative, decision) : cleared
}

// ── For the session ──────────────────────────────────────────────────
//
// The address is the record of an investigation; this tab's memory only
// spares the analyst re-deciding when they look at another plate and come
// back. Per tab and per plate, gone when the tab closes, and an address that
// carries decisions always wins over it.

const SESSION_KEY = 'contrail.candidate-decisions.'

export function rememberDecisions(plate: string, decisions: Decisions): void {
  try {
    window.sessionStorage.setItem(SESSION_KEY + plate, JSON.stringify(decisions))
  } catch {
    /* storage unavailable: the address still carries them */
  }
}

export function recalledDecisions(plate: string): Decisions {
  try {
    const raw = window.sessionStorage.getItem(SESSION_KEY + plate)
    if (!raw) return NO_DECISIONS
    const parsed = JSON.parse(raw) as Partial<Decisions>
    const params = new URLSearchParams()
    params.set(INCLUDE, (parsed.include ?? []).join(','))
    params.set(DISMISS, (parsed.dismiss ?? []).join(','))
    return decisionsFromParams(params)
  } catch {
    return NO_DECISIONS
  }
}

/** Whether a link names any decision at all. */
export function hasDecisionParams(params: URLSearchParams): boolean {
  return params.has(INCLUDE) || params.has(DISMISS)
}
