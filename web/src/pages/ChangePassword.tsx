/**
 * Change your own password.
 *
 * Separate from the admin reset screen because the two are different acts. An
 * administrator resetting a password creates a shared secret; a person setting
 * their own ends one. Only the second makes an account attributable, which is
 * why the API re-verifies the current password here and does not there.
 *
 * One screen for both arrivals: somebody sent here because an administrator
 * set their password (the forced change, flagged on the account menu), and
 * somebody who simply chose to change it. The first is told why it matters
 * before being asked for anything.
 */

import { useState, type FormEvent } from 'react'
import { Link } from 'react-router-dom'

import {
  Button,
  Checkbox,
  ErrorBanner,
  Field,
  Icon,
  Input,
  PageHeader,
  Panel,
  RoleBadge,
  SeverityGlyph,
} from '@/components/ui'
import { useAuth } from '@/hooks/useAuth'
import * as api from '@/lib/api'
import type { Role } from '@/lib/types'
import { MAX_LENGTH, MIN_LENGTH, passwordChecks } from '@/pages/passwordPolicy'

const ROLES: readonly Role[] = ['admin', 'supervisor', 'operator', 'analyst', 'auditor', 'api_client']

function isRole(value: string | undefined): value is Role {
  return value !== undefined && (ROLES as readonly string[]).includes(value)
}

export default function ChangePassword() {
  const { user, refresh } = useAuth()
  const [current, setCurrent] = useState('')
  const [next, setNext] = useState('')
  const [confirm, setConfirm] = useState('')
  const [reveal, setReveal] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState(false)

  const forced = Boolean(user?.must_change_password)
  const role = user?.role
  const checks = passwordChecks(next, confirm, current, user?.username ?? '')

  async function submit(event: FormEvent) {
    event.preventDefault()
    if (next !== confirm) {
      setError('The two new passwords do not match.')
      return
    }
    setBusy(true)
    setError(null)
    try {
      await api.changeOwnPassword(current, next)
      setDone(true)
      setCurrent('')
      setNext('')
      setConfirm('')
      // The top bar's "set your password" mark reads the profile; without a
      // fresh one it stays lit until the next sign-in.
      try {
        await refresh()
      } catch {
        /* the change itself succeeded; the mark clears at the next sign-in */
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  const fieldType = reveal ? 'text' : 'password'

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
      <div className="mx-auto w-full max-w-[60rem] px-6 py-7">
        <PageHeader
          title={forced && !done ? 'Set your own password' : 'Change password'}
          subtitle={
            <>
              <span>Signed in as</span>
              <span className="font-mono text-foreground">{user?.username}</span>
              {isRole(role) && <RoleBadge role={role} />}
            </>
          }
        />

        {forced && !done && (
          <div className="mt-5 flex items-start gap-3 rounded-lg border border-priority-high/40 bg-priority-high/[0.07] px-4 py-3">
            <SeverityGlyph priority="high" size={11} className="mt-1 text-priority-high" />
            <div className="min-w-0">
              <p className="text-[13px] font-medium text-priority-high">
                An administrator set this password
              </p>
              <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">
                More than one person knows it. Until you change it, actions
                taken by this account cannot be attributed to you alone.
              </p>
            </div>
          </div>
        )}

        <div className="mt-6 grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_17rem]">
          <Panel className="p-5 sm:p-6">
            {done ? (
              <div className="flex items-start gap-3.5">
                <span className="grid h-9 w-9 shrink-0 place-items-center rounded-full border border-primary/40 bg-primary/10 text-primary">
                  <Icon name="check" size={18} />
                </span>
                <div className="min-w-0">
                  <p className="text-[15px] font-semibold">Password changed</p>
                  <p className="mt-1 text-[13px] leading-relaxed text-muted-foreground">
                    It takes effect immediately; existing sessions elsewhere
                    stay signed in until their tokens expire.
                  </p>
                  <Link
                    to="/"
                    className="mt-4 inline-flex items-center gap-1.5 text-[13px] text-primary hover:underline"
                  >
                    Back to work
                    <Icon name="arrowRight" size={14} />
                  </Link>
                </div>
              </div>
            ) : (
              <form onSubmit={submit} className="space-y-4">
                <Field label="Current password">
                  <Input
                    type={fieldType}
                    value={current}
                    onChange={(e) => setCurrent(e.target.value)}
                    required
                    autoComplete="current-password"
                    className="font-mono"
                  />
                </Field>

                <div className="grid gap-4 sm:grid-cols-2">
                  <Field label="New password">
                    <Input
                      type={fieldType}
                      value={next}
                      onChange={(e) => setNext(e.target.value)}
                      minLength={MIN_LENGTH}
                      maxLength={MAX_LENGTH}
                      required
                      autoComplete="new-password"
                      className="font-mono"
                    />
                  </Field>

                  <Field label="New password again">
                    <Input
                      type={fieldType}
                      value={confirm}
                      onChange={(e) => setConfirm(e.target.value)}
                      minLength={MIN_LENGTH}
                      maxLength={MAX_LENGTH}
                      required
                      autoComplete="new-password"
                      className="font-mono"
                    />
                  </Field>
                </div>

                <Checkbox
                  label="Show what I am typing"
                  checked={reveal}
                  onChange={(e) => setReveal(e.target.checked)}
                  labelClassName="gap-2 text-xs text-muted-foreground"
                />

                {/* The API is the authority on all of this; the checklist
                    exists so the rules are known before the form is
                    submitted, not after. */}
                <div className="rounded-md border border-border bg-background/50 px-3.5 py-3">
                  <p className="eyebrow">The new password</p>
                  <ul className="mt-2 grid gap-x-5 gap-y-1.5 sm:grid-cols-2">
                    {checks.map((check) => (
                      <li
                        key={check.id}
                        className={`flex items-center gap-2 text-xs ${
                          check.ok ? 'text-foreground' : 'text-muted-foreground'
                        }`}
                      >
                        {check.ok ? (
                          <Icon name="check" size={14} className="shrink-0 text-primary" />
                        ) : (
                          <span
                            aria-hidden
                            className="mx-[3px] h-2 w-2 shrink-0 rounded-full border border-faint"
                          />
                        )}
                        <span>
                          {check.label}
                          <span className="sr-only">{check.ok ? ' — met' : ' — not yet met'}</span>
                        </span>
                      </li>
                    ))}
                  </ul>
                  <p className="mt-2.5 text-[11px] leading-relaxed text-faint">
                    The server also refuses any credential published in this
                    repository, and it has the final say.
                  </p>
                </div>

                {error && <ErrorBanner>{error}</ErrorBanner>}

                <div className="flex items-center gap-3 pt-1">
                  <Button type="submit" disabled={busy}>
                    {busy ? 'Changing…' : forced ? 'Set my password' : 'Change password'}
                  </Button>
                  {!forced && (
                    <Link
                      to="/"
                      className="text-[13px] text-muted-foreground transition hover:text-foreground"
                    >
                      Cancel
                    </Link>
                  )}
                </div>
              </form>
            )}
          </Panel>

          <aside className="space-y-3 text-xs leading-relaxed text-muted-foreground">
            <p className="eyebrow">Why it matters</p>
            <p>
              Every action on this platform is recorded against an account, and
              that record is only worth something if one person holds each
              account.
            </p>
            <p>
              A password an administrator sets is known to two people. One you
              set yourself is known to one — which is what makes what this
              account does attributable to you.
            </p>
            <p className="text-faint">
              Your current password is checked again here, so a session left
              open on a shared workstation cannot be used to take the account.
            </p>
          </aside>
        </div>
      </div>
    </div>
  )
}
