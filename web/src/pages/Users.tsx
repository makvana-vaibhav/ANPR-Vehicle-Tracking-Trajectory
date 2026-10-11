/**
 * Account administration.
 *
 * The screen is deliberately blunt about consequences, because the actions
 * here are the ones that decide whether the audit trail means anything:
 *
 * * **Deactivate, don't delete.** Deleting a user who has acted orphans every
 *   audit row naming them. The API refuses it outright once an account has
 *   history; the delete control says so before you reach that refusal, and
 *   sits last, behind a confirmation, below the deactivate that should be
 *   reached for instead.
 * * **A password an administrator sets is a shared secret.** Until the holder
 *   replaces it, two people can sign in as them and nothing that account does
 *   is attributable. Accounts in that state are flagged in the table.
 * * **Role changes take effect on the holder's next request**, not their next
 *   login — the API checks permissions per request, so removing a grant stops
 *   the next action rather than the next session.
 *
 * The list is what the screen opens on; creating and amending an account are
 * the rarer acts, so they live in a slide-over rather than permanently above
 * the table. A role used to be changed by a bare dropdown in each row, which
 * re-granted an account the moment the select was brushed — in the drawer it
 * is an explicit save.
 */

import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from 'react'
import { Link } from 'react-router-dom'

import { SkeletonRows } from '@/components/Skeleton'
import { useToast } from '@/components/Toast'
import {
  Button,
  Drawer,
  EmptyState,
  Field,
  Icon,
  InfoHint,
  Input,
  PageHeader,
  RoleBadge,
  SectionLabel,
  Select,
  SeverityGlyph,
  Table,
  Td,
  Th,
  Thead,
  Tr,
} from '@/components/ui'
import { useAuth } from '@/hooks/useAuth'
import * as api from '@/lib/api'
import { PERMISSIONS, ROLE_SUMMARY } from '@/lib/permissions'
import type { ManagedUser, Role } from '@/lib/types'

/** Roles a person can be given. */
const ROLES: Role[] = ['admin', 'supervisor', 'operator', 'analyst', 'auditor']

/**
 * `api_client` is a machine identity, not a person, and is deliberately absent
 * from the list above — nobody should be able to turn an officer into one, or
 * one into an officer, from a dropdown.
 *
 * It still has to *render*: a `<select>` whose value matches no option shows
 * the first option instead, which displayed the camera-onboarding client as an
 * administrator. So a machine account's role is shown, never offered for edit.
 */
const MACHINE_ROLES: Role[] = ['api_client']

const MIN_PASSWORD = 12

/** "11 Oct 2026, 23:45" in IST — storage stays UTC. */
function istDateTime(iso: string): string {
  return new Intl.DateTimeFormat('en-IN', {
    timeZone: 'Asia/Kolkata',
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(new Date(iso))
}

function istDate(iso: string): string {
  return new Intl.DateTimeFormat('en-IN', {
    timeZone: 'Asia/Kolkata',
    day: '2-digit',
    month: 'short',
    year: 'numeric',
  }).format(new Date(iso))
}

function initialsOf(account: ManagedUser): string {
  const name = account.full_name?.trim() || account.username
  const words = name.split(/[\s._-]+/).filter(Boolean)
  if (words.length >= 2) {
    return `${words[0]?.charAt(0) ?? ''}${words[1]?.charAt(0) ?? ''}`.toUpperCase()
  }
  return name.slice(0, 2).toUpperCase()
}

export default function Users() {
  const toast = useToast()
  const { user: me, can } = useAuth()
  const mayCreate = can(PERMISSIONS.userCreate)
  const mayUpdate = can(PERMISSIONS.userUpdate)
  const mayDelete = can(PERMISSIONS.userDelete)
  const mayManage = mayUpdate || mayDelete

  /** `null` until the first load returns, so "loading" never reads as "none". */
  const [users, setUsers] = useState<ManagedUser[] | null>(null)
  const [creating, setCreating] = useState(false)
  const [managingId, setManagingId] = useState<string | null>(null)

  const load = useCallback(async () => {
    try {
      setUsers((await api.getUsers()).items)
    } catch (err) {
      toast.error(err)
      setUsers((current) => current ?? [])
    }
  }, [toast])

  useEffect(() => {
    void load()
  }, [load])

  const managing = users?.find((u) => u.id === managingId) ?? null
  const list = users ?? []
  const active = list.filter((u) => u.is_active).length
  const shared = list.filter((u) => u.is_active && u.must_change_password).length

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
      <div className="space-y-5 px-6 py-5">
        <PageHeader
          title="Accounts"
          subtitle={
            <>
              <span>
                {users === null ? 'loading…' : `${list.length} accounts · ${active} active`}
              </span>
              {shared > 0 && (
                <>
                  <span className="text-muted-foreground/40">·</span>
                  <span className="inline-flex items-center gap-1.5 text-priority-high">
                    <SeverityGlyph priority="high" size={8} />
                    {shared} with a password not yet their own
                  </span>
                </>
              )}
              <span className="text-muted-foreground/40">·</span>
              <span>every action is recorded against one of them</span>
              <InfoHint label="Why accounts are deactivated rather than deleted">
                Each account must belong to a named person, because the audit
                trail attributes every action to one. Deleting a user who has
                acted orphans every row naming them, so the API refuses it once
                an account has history — deactivation is what a supervisor
                should reach for. A role change takes effect on the holder's
                next request, not their next sign-in.
              </InfoHint>
            </>
          }
          actions={
            mayCreate && (
              <Button onClick={() => setCreating(true)}>
                <Icon name="plus" size={15} />
                New account
              </Button>
            )
          }
        />

        {users === null ? (
          <SkeletonRows rows={5} height="h-12" />
        ) : list.length === 0 ? (
          <EmptyState
            title="No accounts to show."
            hint="If this is wrong, the list could not be read — see the notice in the corner."
          />
        ) : (
          <Table className="min-w-[860px]">
            <Thead>
              <tr>
                <Th>Account</Th>
                <Th>Role</Th>
                <Th>Status</Th>
                <Th>Last sign-in (IST)</Th>
                <Th>Created</Th>
                <Th className="w-24">
                  <span className="sr-only">Actions</span>
                </Th>
              </tr>
            </Thead>
            <tbody>
              {list.map((account) => {
                const self = account.id === me?.id
                const machine = MACHINE_ROLES.includes(account.role)
                const selected = account.id === managingId
                return (
                  <Tr
                    key={account.id}
                    onClick={mayManage ? () => setManagingId(account.id) : undefined}
                    className={`${mayManage ? 'cursor-pointer' : ''} ${selected ? 'bg-secondary/50' : ''}`}
                  >
                    <Td>
                      <div className="flex items-center gap-3">
                        <span
                          aria-hidden
                          className={`grid h-8 w-8 shrink-0 place-items-center rounded-full text-[11px] font-semibold ${
                            account.is_active
                              ? 'bg-secondary text-foreground'
                              : 'border border-dashed border-input text-faint'
                          }`}
                        >
                          {machine ? <Icon name="key" size={14} /> : initialsOf(account)}
                        </span>
                        <div className="min-w-0">
                          <p className="flex items-center gap-1.5">
                            <span
                              className={`font-mono text-[13px] ${account.is_active ? 'text-foreground' : 'text-muted-foreground'}`}
                            >
                              {account.username}
                            </span>
                            {self && (
                              <span className="rounded border border-border px-1 text-[10px] font-medium uppercase tracking-[0.06em] text-faint">
                                you
                              </span>
                            )}
                          </p>
                          <p className="truncate text-xs text-muted-foreground">
                            {account.full_name || (machine ? 'Machine identity' : '—')}
                          </p>
                        </div>
                      </div>
                    </Td>
                    <Td>
                      <RoleBadge role={account.role} title={ROLE_SUMMARY[account.role]} />
                    </Td>
                    <Td>
                      <div className="flex flex-col gap-1">
                        {account.is_active ? (
                          <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
                            <span className="h-1.5 w-1.5 rounded-full bg-primary" />
                            Active
                          </span>
                        ) : (
                          <span className="inline-flex items-center gap-1.5 text-xs text-faint">
                            <span className="h-1.5 w-1.5 rounded-full border border-faint" />
                            Deactivated
                          </span>
                        )}
                        {account.must_change_password && (
                          <span
                            className="inline-flex items-center gap-1.5 text-xs text-priority-high"
                            title="An administrator set this password, so two people know it. Nothing this account does is attributable until the holder changes it."
                          >
                            <SeverityGlyph priority="high" size={8} />
                            Password not yet personal
                          </span>
                        )}
                      </div>
                    </Td>
                    <Td>
                      {account.last_login_at ? (
                        <>
                          <span className="block font-mono text-xs text-foreground">
                            {istDateTime(account.last_login_at)}
                          </span>
                          <span className="block text-[11px] text-faint">
                            {api.relativeTime(account.last_login_at)}
                          </span>
                        </>
                      ) : (
                        <span className="text-xs text-faint">never</span>
                      )}
                    </Td>
                    <Td className="font-mono text-xs text-muted-foreground">
                      {account.created_at ? istDate(account.created_at) : '—'}
                    </Td>
                    <Td className="text-right">
                      {mayManage && (
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={(event) => {
                            event.stopPropagation()
                            setManagingId(account.id)
                          }}
                          aria-label={`Manage ${account.username}`}
                        >
                          Manage
                          <Icon name="chevronRight" size={14} />
                        </Button>
                      )}
                    </Td>
                  </Tr>
                )
              })}
            </tbody>
          </Table>
        )}
      </div>

      {mayCreate && (
        <CreateAccount
          open={creating}
          onClose={() => setCreating(false)}
          onCreated={async () => {
            setCreating(false)
            await load()
          }}
        />
      )}

      {managing && (
        <Drawer
          open
          title={managing.username}
          description={
            <span className="flex flex-wrap items-center gap-2">
              <RoleBadge role={managing.role} />
              <span>{managing.full_name || 'No full name recorded'}</span>
            </span>
          }
          onClose={() => setManagingId(null)}
          width="w-[min(32rem,94vw)]"
        >
          <ManageAccount
            key={managing.id}
            account={managing}
            self={managing.id === me?.id}
            mayUpdate={mayUpdate}
            mayDelete={mayDelete}
            onChanged={load}
            onDeleted={async () => {
              setManagingId(null)
              await load()
            }}
          />
        </Drawer>
      )}
    </div>
  )
}

// ── Create ──────────────────────────────────────────────────────────────

function CreateAccount({
  open,
  onClose,
  onCreated,
}: {
  open: boolean
  onClose: () => void
  onCreated: () => Promise<void>
}) {
  const toast = useToast()
  const [username, setUsername] = useState('')
  const [fullName, setFullName] = useState('')
  const [password, setPassword] = useState('')
  const [role, setRole] = useState<Role>('operator')
  const [busy, setBusy] = useState(false)

  async function create(event: FormEvent) {
    event.preventDefault()
    setBusy(true)
    try {
      await api.createUser({
        username: username.trim(),
        password,
        full_name: fullName.trim() || null,
        role,
      })
      toast.success(
        `${username.trim()} created. They must set their own password before ` +
          'the account can be relied on for attribution.',
      )
      setUsername('')
      setFullName('')
      setPassword('')
      await onCreated()
    } catch (err) {
      toast.error(err)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Drawer
      open={open}
      title="New account"
      description="One named person per account — the audit trail attributes every action to one."
      onClose={onClose}
      width="w-[min(30rem,94vw)]"
    >
      <form onSubmit={create} className="space-y-4">
        <Field
          label="Username"
          hint="Letters, digits, dot, dash or underscore. Permanent — it is what the audit trail records."
        >
          <Input
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            placeholder="insp.desai"
            pattern="[a-zA-Z0-9._\-]+"
            minLength={3}
            maxLength={64}
            required
            autoFocus
            autoCapitalize="none"
            spellCheck={false}
            className="font-mono"
          />
        </Field>

        <Field label="Full name">
          <Input
            value={fullName}
            onChange={(e) => setFullName(e.target.value)}
            placeholder="Insp. R Desai"
            maxLength={200}
          />
        </Field>

        <Field label="Role" hint={ROLE_SUMMARY[role]}>
          <Select value={role} onChange={(e) => setRole(e.target.value as Role)}>
            {ROLES.map((r) => (
              <option key={r} value={r}>
                {r}
              </option>
            ))}
          </Select>
        </Field>

        <Field
          label="Initial password"
          hint={`At least ${MIN_PASSWORD} characters, and not a credential documented in this repository.`}
        >
          <Input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            minLength={MIN_PASSWORD}
            required
            autoComplete="new-password"
            className="font-mono"
          />
        </Field>

        <p className="flex items-start gap-2.5 rounded-md border border-border bg-background/50 px-3 py-2.5 text-xs leading-relaxed text-muted-foreground">
          <Icon name="key" size={14} className="mt-px shrink-0 text-faint" />
          The holder must replace this password before the account is
          attributable. Until they do, it is a secret you share with them.
        </p>

        <div className="flex items-center justify-end gap-2 border-t border-border pt-4">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" disabled={busy}>
            {busy ? 'Creating…' : 'Create account'}
          </Button>
        </div>
      </form>
    </Drawer>
  )
}

// ── Manage ──────────────────────────────────────────────────────────────

function DrawerSection({
  title,
  children,
  tone = 'normal',
}: {
  title: string
  children: ReactNode
  tone?: 'normal' | 'danger'
}) {
  return (
    <section
      className={`space-y-3 border-t pt-5 first:border-t-0 first:pt-0 ${
        tone === 'danger' ? 'border-status-offline/30' : 'border-border'
      }`}
    >
      <SectionLabel>{title}</SectionLabel>
      {children}
    </section>
  )
}

function ManageAccount({
  account,
  self,
  mayUpdate,
  mayDelete,
  onChanged,
  onDeleted,
}: {
  account: ManagedUser
  self: boolean
  mayUpdate: boolean
  mayDelete: boolean
  onChanged: () => Promise<void>
  onDeleted: () => Promise<void>
}) {
  const toast = useToast()
  const machine = MACHINE_ROLES.includes(account.role)

  const [fullName, setFullName] = useState(account.full_name ?? '')
  const [role, setRole] = useState<Role>(account.role)
  const [saving, setSaving] = useState(false)
  const [toggling, setToggling] = useState(false)
  const [resetValue, setResetValue] = useState('')
  const [resetting, setResetting] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [deleting, setDeleting] = useState(false)

  // A save reloads the list, which hands this drawer the stored record —
  // follow it, so the form shows what is now true rather than what was typed.
  useEffect(() => {
    setFullName(account.full_name ?? '')
    setRole(account.role)
  }, [account.full_name, account.role])

  const nameChanged = (fullName.trim() || null) !== (account.full_name || null)
  const roleChanged = role !== account.role
  const roleLocked = self || machine

  async function save(event: FormEvent) {
    event.preventDefault()
    const changes: Parameters<typeof api.updateUser>[1] = {}
    if (nameChanged) changes.full_name = fullName.trim() || null
    if (roleChanged && !roleLocked) changes.role = role
    if (Object.keys(changes).length === 0) return
    setSaving(true)
    try {
      await api.updateUser(account.id, changes)
      toast.success(
        changes.role
          ? `${account.username} is now ${changes.role}. It applies from their next request.`
          : `${account.username} updated.`,
      )
      await onChanged()
    } catch (err) {
      toast.error(err)
    } finally {
      setSaving(false)
    }
  }

  async function toggleActive() {
    setToggling(true)
    try {
      await api.updateUser(account.id, { is_active: !account.is_active })
      toast.success(
        account.is_active
          ? `${account.username} deactivated. Their history stays readable.`
          : `${account.username} reactivated.`,
      )
      await onChanged()
    } catch (err) {
      toast.error(err)
    } finally {
      setToggling(false)
    }
  }

  async function submitReset(event: FormEvent) {
    event.preventDefault()
    setResetting(true)
    try {
      await api.resetUserPassword(account.id, resetValue)
      toast.success(`${account.username} must set a new password at next sign-in.`)
      setResetValue('')
      await onChanged()
    } catch (err) {
      toast.error(err)
    } finally {
      setResetting(false)
    }
  }

  async function remove() {
    setDeleting(true)
    try {
      await api.deleteUser(account.id)
      toast.success(`${account.username} deleted.`)
      await onDeleted()
    } catch (err) {
      // The API's refusal names the audit entries that block it — that
      // sentence is the useful part, so it is shown as given.
      toast.error(err)
      setConfirmDelete(false)
    } finally {
      setDeleting(false)
    }
  }

  return (
    <div className="space-y-5">
      <DrawerSection title="Record">
        <dl className="divide-y divide-border/70 rounded-md border border-border text-[13px]">
          <Fact label="Username">
            <span className="font-mono">{account.username}</span>
          </Fact>
          <Fact label="Status">
            {account.is_active ? (
              <span className="inline-flex items-center gap-1.5">
                <span className="h-1.5 w-1.5 rounded-full bg-primary" />
                Active
              </span>
            ) : (
              <span className="text-muted-foreground">Deactivated</span>
            )}
          </Fact>
          {account.must_change_password && (
            <Fact label="Password">
              <span className="inline-flex items-center gap-1.5 text-priority-high">
                <SeverityGlyph priority="high" size={8} />
                Set by an administrator
              </span>
            </Fact>
          )}
          <Fact label="Last sign-in">
            {account.last_login_at ? (
              <span className="font-mono text-xs">
                {istDateTime(account.last_login_at)} IST
                <span className="ml-1.5 font-sans text-faint">
                  {api.relativeTime(account.last_login_at)}
                </span>
              </span>
            ) : (
              <span className="text-faint">never</span>
            )}
          </Fact>
          <Fact label="Created">
            <span className="font-mono text-xs">
              {account.created_at ? `${istDateTime(account.created_at)} IST` : '—'}
            </span>
          </Fact>
          <Fact label="Account id">
            <span className="break-all font-mono text-[11px] text-muted-foreground">
              {account.id}
            </span>
          </Fact>
        </dl>
      </DrawerSection>

      {self && (
        <p className="flex items-start gap-2.5 rounded-md border border-border bg-background/50 px-3 py-2.5 text-xs leading-relaxed text-muted-foreground">
          <Icon name="info" size={14} className="mt-px shrink-0 text-faint" />
          <span>
            This is your own account. Your role and access can only be changed
            by another administrator, and your password from{' '}
            <Link to="/password" className="text-primary hover:underline">
              Change password
            </Link>
            .
          </span>
        </p>
      )}

      {mayUpdate && (
        <DrawerSection title="Details">
          <form onSubmit={save} className="space-y-3">
            <Field label="Full name">
              <Input
                value={fullName}
                onChange={(e) => setFullName(e.target.value)}
                maxLength={200}
              />
            </Field>
            <Field
              label="Role"
              hint={
                roleLocked
                  ? self
                    ? 'You cannot change your own role.'
                    : 'A machine identity — its role is not offered for change here.'
                  : `${ROLE_SUMMARY[role] ?? ''}. Takes effect on their next request.`
              }
            >
              {roleLocked ? (
                <div className="flex h-[34px] items-center">
                  <RoleBadge role={account.role} title={ROLE_SUMMARY[account.role]} />
                </div>
              ) : (
                <Select value={role} onChange={(e) => setRole(e.target.value as Role)}>
                  {ROLES.map((r) => (
                    <option key={r} value={r}>
                      {r}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
            <div className="flex justify-end">
              <Button
                type="submit"
                variant="outline"
                size="sm"
                disabled={saving || (!nameChanged && !(roleChanged && !roleLocked))}
              >
                {saving ? 'Saving…' : 'Save changes'}
              </Button>
            </div>
          </form>
        </DrawerSection>
      )}

      {mayUpdate && !self && (
        <DrawerSection title="Access">
          <p className="text-xs leading-relaxed text-muted-foreground">
            {account.is_active
              ? 'Deactivating stops every sign-in and keeps the account’s history readable. It is the right tool for someone who has left or changed posts.'
              : 'This account cannot sign in. Its history is intact; reactivating restores access with the same role.'}
          </p>
          <Button
            variant={account.is_active ? 'destructive' : 'outline'}
            size="sm"
            disabled={toggling}
            onClick={() => void toggleActive()}
          >
            {toggling ? 'Working…' : account.is_active ? 'Deactivate account' : 'Reactivate account'}
          </Button>
        </DrawerSection>
      )}

      {mayUpdate && !self && (
        <DrawerSection title="Password">
          <form onSubmit={submitReset} className="space-y-3">
            <Field
              label="Temporary password"
              hint={`At least ${MIN_PASSWORD} characters. They must replace it at their next sign-in — until then it is a secret you share with them.`}
            >
              <Input
                type="password"
                value={resetValue}
                onChange={(e) => setResetValue(e.target.value)}
                minLength={MIN_PASSWORD}
                required
                autoComplete="new-password"
                className="font-mono"
              />
            </Field>
            <div className="flex justify-end">
              <Button type="submit" variant="outline" size="sm" disabled={resetting}>
                {resetting ? 'Setting…' : 'Set temporary password'}
              </Button>
            </div>
          </form>
        </DrawerSection>
      )}

      {mayDelete && !self && (
        <DrawerSection title="Delete" tone="danger">
          <p className="text-xs leading-relaxed text-muted-foreground">
            Only for an account created in error, before it did anything. Once
            an account has any audit history the platform refuses — deleting it
            would orphan every entry naming it. Deactivate instead.
          </p>
          {confirmDelete ? (
            <div className="flex flex-wrap items-center gap-2 rounded-md border border-status-offline/40 bg-status-offline/[0.06] px-3 py-2.5">
              <span className="mr-auto text-xs text-foreground">
                Delete <span className="font-mono">{account.username}</span> permanently?
              </span>
              <Button variant="ghost" size="sm" onClick={() => setConfirmDelete(false)}>
                Keep it
              </Button>
              <Button
                variant="destructive"
                size="sm"
                disabled={deleting}
                onClick={() => void remove()}
              >
                {deleting ? 'Deleting…' : 'Delete'}
              </Button>
            </div>
          ) : (
            <Button variant="ghost" size="sm" onClick={() => setConfirmDelete(true)}>
              Delete account…
            </Button>
          )}
        </DrawerSection>
      )}
    </div>
  )
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-4 px-3 py-2">
      <dt className="shrink-0 text-muted-foreground">{label}</dt>
      <dd className="min-w-0 text-right">{children}</dd>
    </div>
  )
}
