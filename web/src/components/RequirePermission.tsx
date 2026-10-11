/**
 * A screen the current role is allowed to open.
 *
 * Hiding a nav item stops it being *clicked*; it does not stop it being
 * typed, bookmarked, or linked to from a handover note. Without this, an
 * auditor who opens `/vehicles` gets the screen, watches it fire requests, and
 * sees an error panel — which reads as a fault rather than as a boundary.
 *
 * The API refuses these calls regardless. This exists so the refusal is
 * legible: it says which permission is missing and who to ask, rather than
 * leaving somebody to guess whether the system is broken.
 *
 * Grey, not red. Nothing has gone wrong and nobody needs to act on it now —
 * this is a boundary working as designed, and drawing it in the alarm colour
 * would teach operators that boundaries are faults.
 */

import { Link } from 'react-router-dom'

import { Icon, RoleBadge } from '@/components/ui'
import { useAuth } from '@/hooks/useAuth'
import { ROLE_SUMMARY, type Permission } from '@/lib/permissions'
import type { Role } from '@/lib/types'

interface Props {
  /** Any one of these is enough to open the screen. */
  anyOf: Permission[]
  /** What the screen is, for the refusal message. */
  label: string
  children: React.ReactNode
}

const ROLES: readonly Role[] = ['admin', 'supervisor', 'operator', 'analyst', 'auditor', 'api_client']

/** The profile carries its role as a plain string; the badge wants one it knows. */
function isRole(value: string | undefined): value is Role {
  return value !== undefined && (ROLES as readonly string[]).includes(value)
}

export default function RequirePermission({ anyOf, label, children }: Props) {
  const { user, can } = useAuth()

  if (anyOf.some((permission) => can(permission))) {
    return <>{children}</>
  }

  const role = user?.role
  const summary = role ? ROLE_SUMMARY[role] : undefined

  return (
    <div className="flex min-h-0 flex-1 items-center justify-center overflow-y-auto p-6">
      <section
        aria-labelledby="no-access-title"
        className="w-full max-w-[26rem] rounded-lg border border-border bg-card p-6"
      >
        <span className="grid h-10 w-10 place-items-center rounded-full border border-input bg-secondary text-muted-foreground">
          <Icon name="shield" size={19} />
        </span>

        <p className="eyebrow mt-5">Not available to your role</p>
        <h1 id="no-access-title" className="mt-1 text-[17px] font-semibold leading-snug">
          {label} is outside what your role can open
        </h1>

        <dl className="mt-5 divide-y divide-border/70 rounded-md border border-border text-[13px]">
          <div className="flex items-center justify-between gap-4 px-3 py-2">
            <dt className="text-muted-foreground">Signed in as</dt>
            <dd className="truncate font-mono text-foreground">{user?.username ?? '—'}</dd>
          </div>
          <div className="flex items-center justify-between gap-4 px-3 py-2">
            <dt className="text-muted-foreground">Role</dt>
            <dd>
              {isRole(role) ? (
                <RoleBadge role={role} title={summary} />
              ) : (
                <span className="font-mono text-foreground">{role ?? '—'}</span>
              )}
            </dd>
          </div>
          {/* Naming the permission turns "it doesn't work" into a request an
              administrator can act on without a conversation. */}
          <div className="flex items-start justify-between gap-4 px-3 py-2">
            <dt className="shrink-0 text-muted-foreground">
              {anyOf.length > 1 ? 'Needs one of' : 'Needs'}
            </dt>
            <dd className="flex flex-wrap justify-end gap-1">
              {anyOf.map((permission) => (
                <code
                  key={permission}
                  className="rounded border border-input bg-background px-1.5 py-px font-mono text-[11px] text-foreground"
                >
                  {permission}
                </code>
              ))}
            </dd>
          </div>
        </dl>

        <p className="mt-4 text-xs leading-relaxed text-muted-foreground">
          {summary ? <>Your role allows: {summary.toLowerCase()}. </> : null}
          An administrator can grant this by changing your role.
        </p>

        <Link
          to="/"
          className="mt-5 inline-flex h-8 items-center gap-1.5 rounded-md bg-foreground px-3.5 text-[13px] font-medium text-background transition hover:bg-foreground/90"
        >
          Back to what you can see
          <Icon name="arrowRight" size={14} />
        </Link>
      </section>
    </div>
  )
}
