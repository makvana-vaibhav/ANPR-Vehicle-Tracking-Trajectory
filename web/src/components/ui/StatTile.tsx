/**
 * One KPI tile. Dashboard's counters, the map's status strip and Fleet
 * Health's cards were three separate implementations of this same idea, each
 * slightly different in radius, padding and label size — the kind of drift
 * that makes a product feel like it was assembled from parts rather than
 * designed as one thing.
 *
 * Grey when normal: a `good` tile is drawn exactly like an untoned one. Only
 * `warn` and `bad` take colour, and `bad` tints the whole tile, because a
 * figure that needs someone should be found before it is read.
 *
 * `variant="strip"` drops the tile's own border and radius for the rare case
 * where the parent already draws the dividers (a `gap-px bg-border` grid) —
 * the composition stays, only the duplicated chrome goes.
 */

import type { ReactNode } from 'react'
import { Link } from 'react-router-dom'

import { Icon } from './Icon'
import { InfoHint } from './InfoHint'

export type StatTone = 'good' | 'warn' | 'bad'

const VALUE_TONE: Record<StatTone, string> = {
  good: '',
  warn: 'text-priority-high',
  bad: 'text-priority-critical',
}

const CARD_TONE: Record<StatTone | 'none', string> = {
  none: 'border-border bg-card',
  good: 'border-border bg-card',
  warn: 'border-priority-high/30 bg-card',
  bad: 'border-priority-critical/35 bg-priority-critical/[0.07]',
}

export function StatTile({
  label,
  value,
  detail,
  info,
  tone,
  to,
  aside,
  variant = 'card',
  className = '',
}: {
  label: string
  value: ReactNode
  detail?: ReactNode
  /** How the figure is arrived at, when that is not obvious from the label. */
  info?: ReactNode
  tone?: StatTone
  to?: string
  /** Set to the right of the figure — a sparkline, a unit. */
  aside?: ReactNode
  variant?: 'card' | 'strip'
  className?: string
}) {
  const shell =
    variant === 'card'
      ? `block rounded-lg border px-3.5 py-3 transition ${CARD_TONE[tone ?? 'none']}`
      : 'block bg-card px-4 py-3 transition'

  const quiet = tone === 'bad' ? 'text-priority-critical/80' : 'text-muted-foreground'

  const body = (
    <>
      <p
        className={`flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-[0.06em] ${quiet} ${to ? 'pr-5' : ''}`}
      >
        {label}
        {info && <InfoHint>{info}</InfoHint>}
      </p>
      <div className="mt-1.5 flex items-end gap-3">
        {/* Tracking is pulled in because these are large lining figures set
            in a mono face — at 24px the default letter-spacing makes
            "12,480" read as separated digits rather than as one number. */}
        <p
          className={`font-mono text-2xl font-medium leading-none tracking-tight ${tone ? VALUE_TONE[tone] : ''}`}
        >
          {value}
        </p>
        {aside}
      </div>
      {detail && (
        <p
          className={`mt-1.5 text-xs leading-snug ${tone === 'bad' ? 'text-priority-critical/80' : 'text-faint'}`}
        >
          {detail}
        </p>
      )}
    </>
  )

  // The arrow is the affordance that says a tile is a way into another screen.
  // Without it a linked tile and a static one are indistinguishable until the
  // cursor happens to land on one.
  return to ? (
    <Link to={to} className={`group ${shell} relative hover:border-muted-foreground/40 ${className}`}>
      {body}
      <span className="absolute right-3 top-3 text-faint/60 transition group-hover:text-primary">
        <Icon name="arrowRight" size={14} />
      </span>
    </Link>
  ) : (
    <div className={`${shell} ${className}`}>{body}</div>
  )
}
