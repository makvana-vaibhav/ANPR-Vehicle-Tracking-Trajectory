/**
 * What the Investigate screen reads from its address, and writes back to it.
 *
 * `/vehicles?plate=GJ03AB1234` opens that vehicle's journey directly: the ⌘K
 * palette links here that way, and so can any other screen that shows a plate.
 * `since` and `until` (UTC, ISO 8601) pin an exact window — the same pair the
 * printable report takes — so a link can open the journey around a moment
 * rather than "the last 24 hours" from whenever it happens to be clicked.
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
