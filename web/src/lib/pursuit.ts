/**
 * Pursuit, for the screens: words for its states, and the list the top bar
 * keeps an eye on.
 *
 * Every time is rendered in IST here, at the edge; the API speaks UTC.
 */

import { useEffect, useState } from 'react'

import * as api from '@/lib/api'
import type { PursuitPinState, PursuitSummary, PursuitWindow } from '@/lib/types'

/** How often the top bar asks which pursuits are running. */
export const LIST_POLL_MS = 15_000

/** How often an open pursuit panel refreshes: reads land within a tick. */
export const PANEL_POLL_MS = 5_000

/** `07:12`, IST. */
export function istHM(iso: string): string {
  return new Intl.DateTimeFormat('en-IN', {
    timeZone: 'Asia/Kolkata',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(new Date(iso))
}

/** `12 min left`, `40 s left`, `ended`. */
export function remaining(expiresAt: string, now = Date.now()): string {
  const seconds = Math.round((new Date(expiresAt).getTime() - now) / 1000)
  if (seconds <= 0) return 'ended'
  if (seconds < 60) return `${seconds} s left`
  return `${Math.ceil(seconds / 60)} min left`
}

/** `3 min ago`, for a moment in the recent past. */
export function ago(iso: string, now = Date.now()): string {
  const seconds = Math.max(0, Math.round((now - new Date(iso).getTime()) / 1000))
  if (seconds < 60) return `${seconds} s ago`
  const minutes = Math.round(seconds / 60)
  if (minutes < 120) return `${minutes} min ago`
  return `${Math.floor(minutes / 60)} h ${minutes % 60} min ago`
}

export const WINDOW_TEXT: Record<PursuitWindow, string> = {
  open: 'window open now',
  soon: 'window opens soon',
  town: 'same town',
  passed: 'window passed',
  later: 'later',
}

/** The arrival window in IST, or why there is none. */
export function etaText(etaFrom: string | null, etaTo: string | null): string {
  if (!etaFrom || !etaTo) return 'no arrival time: distance unknown'
  return `${istHM(etaFrom)}–${istHM(etaTo)} IST`
}

export const PIN_TEXT: Record<PursuitPinState, string> = {
  pinned: 'Pinned',
  would_pin: 'Would pin',
  always_on: 'Always analysed',
  waiting: 'Waiting',
  held: 'Not pinned',
  ranked_lower: 'Ranked lower',
  outside_window: 'Out of reach',
  reads_no_plates: 'Reads no plates',
  recorded: 'Recorded clip',
  not_in_fleet: 'Not analysed',
}

/**
 * The pursuits running now, refreshed every `LIST_POLL_MS`. Empty when the
 * role may not see them or the API cannot be reached: a pill that is not
 * there is the right failure for a status indicator.
 */
export function useActivePursuits(enabled: boolean): PursuitSummary[] {
  const [pursuits, setPursuits] = useState<PursuitSummary[]>([])
  useEffect(() => {
    if (!enabled) {
      setPursuits([])
      return
    }
    let cancelled = false
    const load = () =>
      api
        .listPursuits()
        .then((body) => {
          if (!cancelled) setPursuits(body.pursuits)
        })
        .catch(() => {
          if (!cancelled) setPursuits([])
        })
    void load()
    const timer = window.setInterval(() => void load(), LIST_POLL_MS)
    // A pursuit started or stopped on this screen shows at once.
    const onChange = () => void load()
    window.addEventListener(PURSUIT_CHANGED, onChange)
    return () => {
      cancelled = true
      window.clearInterval(timer)
      window.removeEventListener(PURSUIT_CHANGED, onChange)
    }
  }, [enabled])
  return pursuits
}

/** Fired after this tab starts, renews or stops a pursuit. */
export const PURSUIT_CHANGED = 'contrail:pursuit-changed'

export function announcePursuitChange(): void {
  window.dispatchEvent(new Event(PURSUIT_CHANGED))
}
