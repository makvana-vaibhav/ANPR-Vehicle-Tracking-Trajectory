/**
 * Every status pill, severity pill and role pill in the product, from one
 * place. Before this, "online" was a dot in MapView, a badge with a
 * differently-shaped border in Cameras, and a plain word in LiveAnpr — the
 * same fact rendered three ways depending which file happened to draw it.
 *
 * Colour always comes from the semantic tokens in `index.css`
 * (`status-*` / `priority-*`), never a raw Tailwind swatch — a stray
 * `amber-500` here would drift from `priority-high` the next time either one
 * is retuned.
 *
 * The palette's rule: grey when normal, colour means a person is needed. So a
 * camera that is answering is a quiet badge with a trail-coloured dot, and
 * only the states someone has to act on are filled. Severity always carries a
 * shape and a word as well as a colour — red and amber are the pair a
 * colour-blind operator is most likely to confuse, and the triangle and the
 * diamond are not.
 */

import type { ReactNode } from 'react'

import type { CameraStatus, Priority, Role } from '@/lib/types'

export type BadgeTone = 'neutral' | 'primary' | 'success' | 'warning' | 'danger'

const TONE_CLASS: Record<BadgeTone, string> = {
  neutral: 'border-border bg-secondary/60 text-muted-foreground',
  primary: 'border-primary/40 bg-primary/10 text-primary',
  success: 'border-status-online/40 bg-status-online/10 text-status-online',
  warning: 'border-priority-high/45 bg-priority-high/10 text-priority-high',
  danger: 'border-status-offline/45 bg-status-offline/10 text-status-offline',
}

const PILL = 'inline-flex items-center gap-1.5 rounded border px-1.5 py-px text-[10px] font-medium uppercase tracking-[0.06em]'

/** A generic labelled pill for one-off facts ("recorded demo", "validation
 *  only") that do not carry a camera/priority/role semantic of their own. */
export function Badge({
  tone = 'neutral',
  children,
  title,
}: {
  tone?: BadgeTone
  children: ReactNode
  title?: string
}) {
  return (
    <span title={title} className={`${PILL} ${TONE_CLASS[tone]}`}>
      {children}
    </span>
  )
}

// ── Camera status ─────────────────────────────────────────────────────

const STATUS_TONE: Record<CameraStatus, { dot: string; badge: string }> = {
  online: {
    dot: 'bg-status-online',
    badge: 'border-border bg-secondary/60 text-muted-foreground',
  },
  offline: {
    dot: 'bg-status-offline',
    badge: 'border-status-offline/45 bg-status-offline/10 text-status-offline',
  },
  degraded: {
    dot: 'bg-status-degraded',
    badge: 'border-status-degraded/45 bg-status-degraded/10 text-status-degraded',
  },
  unknown: {
    dot: 'bg-status-unknown',
    badge: 'border-border bg-secondary/60 text-faint',
  },
}

/** The dot alone — camera markers, list rows, anywhere a full badge is too
 *  heavy for the density of the row. */
export function StatusDot({
  status,
  className = '',
}: {
  status: CameraStatus
  className?: string
}) {
  return (
    <span
      className={`inline-block h-2 w-2 shrink-0 rounded-full ${STATUS_TONE[status].dot} ${className}`}
    />
  )
}

export function StatusBadge({ status, label }: { status: CameraStatus; label?: string }) {
  return (
    <span className={`${PILL} ${STATUS_TONE[status].badge}`}>
      <StatusDot status={status} className="h-1.5 w-1.5" />
      {label ?? status}
    </span>
  )
}

// ── Severity ──────────────────────────────────────────────────────────

const PRIORITY_TONE: Record<Priority, { dot: string; badge: string; solid: string }> = {
  critical: {
    dot: 'bg-priority-critical',
    badge: 'border-priority-critical/50 bg-priority-critical/10 text-priority-critical',
    solid: 'bg-priority-critical text-priority-critical-ink',
  },
  high: {
    dot: 'bg-priority-high',
    badge: 'border-priority-high/50 bg-priority-high/10 text-priority-high',
    solid: 'bg-priority-high text-priority-high-ink',
  },
  medium: {
    dot: 'bg-priority-medium',
    badge: 'border-priority-medium/50 bg-priority-medium/10 text-priority-medium',
    solid: 'bg-priority-medium text-priority-medium-ink',
  },
  low: {
    dot: 'bg-priority-low',
    badge: 'border-border bg-secondary/60 text-muted-foreground',
    solid: 'bg-secondary text-muted-foreground',
  },
}

/**
 * The shape that goes with each severity: triangle, diamond, circle, ring.
 * Drawn in `currentColor`, so it takes the ink of whatever badge holds it.
 */
export function SeverityGlyph({
  priority,
  size = 9,
  className = '',
}: {
  priority: Priority
  size?: number
  className?: string
}) {
  return (
    <svg
      viewBox="0 0 10 10"
      width={size}
      height={size}
      aria-hidden="true"
      focusable="false"
      className={`shrink-0 ${className}`}
    >
      {priority === 'critical' && <path d="M5 0.8 9.6 9.2H0.4Z" fill="currentColor" />}
      {priority === 'high' && <path d="M5 0.4 9.6 5 5 9.6 0.4 5Z" fill="currentColor" />}
      {priority === 'medium' && <circle cx="5" cy="5" r="4.2" fill="currentColor" />}
      {priority === 'low' && (
        <circle cx="5" cy="5" r="3.6" fill="none" stroke="currentColor" strokeWidth="1.4" />
      )}
    </svg>
  )
}

export function PriorityDot({
  priority,
  className = '',
}: {
  priority: Priority
  className?: string
}) {
  return (
    <span
      className={`inline-block h-2 w-2 shrink-0 rounded-full ${PRIORITY_TONE[priority].dot} ${className}`}
    />
  )
}

/** `solid` is the loud variant, for the one or two badges on a screen that
 *  need to read before anything else (an alarm card's severity). Everywhere
 *  else the outline variant keeps the palette from shouting. Both carry the
 *  shape and the word. */
export function PriorityBadge({
  priority,
  solid = false,
}: {
  priority: Priority
  solid?: boolean
}) {
  return (
    <span
      className={`inline-flex h-5 shrink-0 items-center gap-1.5 rounded px-1.5 text-[10px] font-semibold uppercase tracking-[0.06em] ${
        solid ? PRIORITY_TONE[priority].solid : `border ${PRIORITY_TONE[priority].badge}`
      }`}
    >
      <SeverityGlyph priority={priority} />
      {priority}
    </span>
  )
}

// ── Roles ─────────────────────────────────────────────────────────────

const ROLE_TONE: Record<Role, string> = {
  admin: 'border-primary/40 bg-primary/10 text-primary',
  supervisor: 'border-input bg-secondary text-foreground',
  operator: 'border-border bg-secondary/60 text-muted-foreground',
  analyst: 'border-border bg-secondary/60 text-muted-foreground',
  auditor: 'border-border bg-secondary/60 text-muted-foreground',
  api_client: 'border-border bg-secondary/60 text-faint',
}

export function RoleBadge({ role, title }: { role: Role; title?: string }) {
  return (
    <span title={title} className={`${PILL} ${ROLE_TONE[role]}`}>
      {role.replace('_', ' ')}
    </span>
  )
}
