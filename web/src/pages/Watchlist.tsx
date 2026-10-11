/**
 * Watchlist manager: put a plate on the list and the platform watches for it.
 *
 * Adding an entry is the single most consequential action an operator takes on
 * this system — it is what turns a passing car into a red alert — so the form
 * asks for a case reference and a reason rather than just a plate. Both are
 * carried into the alert, which is what makes a hit actionable instead of
 * merely noisy.
 *
 * Entries are retired, not deleted. The delete endpoint exists and is
 * admin-only precisely because watchlist history is evidence; this screen
 * offers deactivation, which is what a supervisor should reach for. Every
 * change — adding, amending, retiring, reinstating — is written to the audit
 * trail by the API against the account that made it.
 *
 * The list is the page, and adding sits docked beside it: looking at what is
 * being watched is the common act, and it should be what the screen opens on,
 * with the form one glance away rather than on top of it.
 */

import { useCallback, useEffect, useMemo, useState, type FormEvent, type ReactNode } from 'react'

import { SkeletonRows } from '@/components/Skeleton'
import { useToast } from '@/components/Toast'
import {
  Button,
  Drawer,
  EmptyState,
  ErrorBanner,
  Field,
  Icon,
  InfoHint,
  Input,
  PageHeader,
  PlateChip,
  PriorityBadge,
  SectionLabel,
  Select,
  Table,
  Td,
  Th,
  Thead,
  Tr,
} from '@/components/ui'
import { useAuth } from '@/hooks/useAuth'
import * as api from '@/lib/api'
import { PERMISSIONS } from '@/lib/permissions'
import { normalisePlate, spacedPlate } from '@/lib/plates'
import type { Priority, WatchlistEntry } from '@/lib/types'

const CATEGORIES = ['stolen', 'suspect', 'wanted', 'bolo', 'expired'] as const
const PRIORITIES: Priority[] = ['low', 'medium', 'high', 'critical']

/** A date alone, in IST — the time sits under it. */
const IST_DATE = new Intl.DateTimeFormat('en-IN', { timeZone: 'Asia/Kolkata', dateStyle: 'medium' })

/** The API's own ceiling for one page of the watchlist. */
const LIST_LIMIT = 500

const CATEGORY_LABEL: Record<string, string> = {
  stolen: 'Stolen',
  suspect: 'Suspect',
  wanted: 'Wanted',
  bolo: 'BOLO — be on the lookout',
  expired: 'Expired',
}

/** A category as written in a list. Unknown ones are shown as they are. */
function categoryLabel(category: string): string {
  return CATEGORY_LABEL[category] ?? category.charAt(0).toUpperCase() + category.slice(1)
}

const PRIORITY_RANK: Record<Priority, number> = { critical: 0, high: 1, medium: 2, low: 3 }

const PRIORITY_LABEL: Record<Priority, string> = {
  critical: 'Critical',
  high: 'High',
  medium: 'Medium',
  low: 'Low',
}

/** Most severe first, then newest — the order an operator scans for. */
export function bySeverity(a: WatchlistEntry, b: WatchlistEntry): number {
  return (
    (PRIORITY_RANK[a.priority] ?? 4) - (PRIORITY_RANK[b.priority] ?? 4) ||
    Date.parse(b.created_at) - Date.parse(a.created_at)
  )
}

/** Whether an entry answers a free-text filter: plate, case or remark. */
export function matchesFilter(entry: WatchlistEntry, filter: string): boolean {
  const needle = filter.trim().toUpperCase()
  if (!needle) return true
  const compact = normalisePlate(needle)
  return (
    (compact.length > 0 && entry.plate_normalised.includes(compact)) ||
    (entry.case_ref ?? '').toUpperCase().includes(needle) ||
    (entry.remarks ?? '').toUpperCase().includes(needle) ||
    entry.category.toUpperCase().includes(needle)
  )
}

/** Normalise a typed plate exactly as the form submits it. */
function formPlate(text: string): string {
  return text.toUpperCase().replace(/[^A-Z0-9]/g, '')
}

export default function Watchlist() {
  const toast = useToast()
  const { can } = useAuth()
  // Reading the watchlist and changing it are separate grants: an analyst may
  // see what is being looked for without being able to add to it.
  const mayAdd = can(PERMISSIONS.watchlistCreate)
  const mayAmend = can(PERMISSIONS.watchlistUpdate)

  const [entries, setEntries] = useState<WatchlistEntry[]>([])
  const [plate, setPlate] = useState('')
  const [category, setCategory] = useState<string>('stolen')
  const [priority, setPriority] = useState<Priority>('critical')
  const [caseRef, setCaseRef] = useState('')
  const [remarks, setRemarks] = useState('')
  const [busy, setBusy] = useState(false)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [filter, setFilter] = useState('')
  const [pendingId, setPendingId] = useState<string | null>(null)
  const [editing, setEditing] = useState<WatchlistEntry | null>(null)

  const load = useCallback(async () => {
    try {
      // Retired entries too. The API hides them unless asked, which left the
      // "Retired" list below empty however many there were — and with it the
      // only way to bring one back.
      setEntries(await api.getWatchlist({ active_only: 'false', limit: String(LIST_LIMIT) }))
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const active = useMemo(() => entries.filter((e) => e.active).sort(bySeverity), [entries])
  const retired = useMemo(() => entries.filter((e) => !e.active).sort(bySeverity), [entries])
  const watchedPlates = useMemo(() => new Set(active.map((e) => e.plate_normalised)), [active])
  const shownActive = useMemo(() => active.filter((e) => matchesFilter(e, filter)), [active, filter])
  const shownRetired = useMemo(() => retired.filter((e) => matchesFilter(e, filter)), [retired, filter])

  const typed = formPlate(plate)
  // The API refuses a second active entry for one plate; saying so before the
  // operator fills in the rest of the form is kinder than a refusal after.
  const alreadyWatched = typed.length >= 4 ? active.find((e) => e.plate_normalised === typed) : undefined

  async function submit(event: FormEvent) {
    event.preventDefault()
    const normalised = formPlate(plate)
    if (normalised.length < 4) {
      toast.error('A plate needs at least four letters or digits to match on.')
      return
    }

    setBusy(true)
    try {
      await api.addToWatchlist({
        plate: normalised,
        category,
        priority,
        case_ref: caseRef.trim() || null,
        remarks: remarks.trim() || null,
      })
      toast.success(`${normalised} is now watched. A sighting will raise an alert.`)
      setPlate('')
      setCaseRef('')
      setRemarks('')
      await load()
    } catch (err) {
      toast.error(err)
    } finally {
      setBusy(false)
    }
  }

  async function toggleActive(entry: WatchlistEntry) {
    setPendingId(entry.id)
    try {
      await api.updateWatchlistEntry(entry.id, { active: !entry.active })
      toast.success(
        entry.active
          ? `${entry.plate_normalised} retired — it will no longer raise alerts.`
          : `${entry.plate_normalised} is being watched again.`,
      )
      await load()
    } catch (err) {
      toast.error(err)
    } finally {
      setPendingId(null)
    }
  }

  const filtering = filter.trim().length > 0

  return (
    <div className="flex min-h-0 flex-1 flex-col lg:flex-row">
      <div className="min-h-0 min-w-0 flex-1 overflow-y-auto">
        <div className="flex flex-col gap-6 px-6 py-5">
          <PageHeader
            title="Watchlist"
            subtitle={
              <>
                <span>
                  {loading
                    ? 'Reading the list…'
                    : `${active.length} plate${active.length === 1 ? '' : 's'} watched across the fleet`}
                </span>
                {!loading && retired.length > 0 && (
                  <>
                    <span className="text-faint">·</span>
                    <span>{retired.length} retired</span>
                  </>
                )}
                <span className="text-faint">·</span>
                <span>matched on every settled read</span>
                <InfoHint label="What adding a plate here does">
                  This is the most consequential action on the platform — it is what
                  turns a passing car into a red alert. The case reference and reason
                  are carried into the alert, which is what makes a hit actionable
                  rather than merely noisy. Every change here is recorded in the audit
                  trail against the account that made it.
                </InfoHint>
              </>
            }
            actions={
              <label className="relative block w-72 max-w-full">
                <span className="sr-only">Find an entry</span>
                <Icon
                  name="search"
                  size={14}
                  className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-faint"
                />
                <Input
                  type="search"
                  value={filter}
                  onChange={(e) => setFilter(e.target.value)}
                  placeholder="Find a plate, case or remark"
                  className="pl-8"
                />
              </label>
            }
          />

          {error && <ErrorBanner>Could not read the watchlist: {error}</ErrorBanner>}

          {!mayAdd && !mayAmend && (
            <p className="rounded-lg border border-border bg-card px-4 py-2.5 text-xs text-muted-foreground">
              Your role can read the watchlist but not change it. Adding a plate needs{' '}
              <code className="font-mono text-foreground">watchlist.create</code>; retiring or
              amending one needs <code className="font-mono text-foreground">watchlist.update</code>.
            </p>
          )}

          {/* ── Watched now ─────────────────────────────────────────── */}
          <section className="flex flex-col gap-2">
            <SectionLabel
              action={
                filtering && !loading ? (
                  <span className="text-xs text-faint">
                    {shownActive.length} of {active.length} match
                  </span>
                ) : undefined
              }
            >
              Watched now
            </SectionLabel>
            {loading ? (
              <SkeletonRows rows={4} height="h-12" />
            ) : shownActive.length === 0 ? (
              <EmptyState
                title={
                  filtering
                    ? `No watched plate matches “${filter.trim()}”.`
                    : mayAdd
                      ? 'Nothing is being watched. Add a plate to start.'
                      : 'Nothing is being watched. A supervisor can add a plate.'
                }
              />
            ) : (
              <EntryTable
                entries={shownActive}
                mayAmend={mayAmend}
                pendingId={pendingId}
                renderActions={(entry) => (
                  <>
                    <Button variant="ghost" size="sm" onClick={() => setEditing(entry)}>
                      Amend
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={pendingId === entry.id}
                      onClick={() => void toggleActive(entry)}
                    >
                      Retire
                    </Button>
                  </>
                )}
              />
            )}
            {!loading && entries.length >= LIST_LIMIT && (
              <p className="text-xs text-faint">
                Showing the {LIST_LIMIT} most recent entries — the most the API returns at once.
              </p>
            )}
          </section>

          {/* ── Retired ─────────────────────────────────────────────── */}
          {!loading && retired.length > 0 && (
            <section className="flex flex-col gap-2">
              <SectionLabel
                action={
                  filtering ? (
                    <span className="text-xs text-faint">
                      {shownRetired.length} of {retired.length} match
                    </span>
                  ) : undefined
                }
              >
                Retired ({retired.length})
                <InfoHint>
                  Kept rather than deleted. A watchlist entry is evidence of what
                  was being looked for and when, so entries are retired — the delete
                  endpoint exists and is admin-only for exactly that reason.
                </InfoHint>
              </SectionLabel>
              {shownRetired.length === 0 ? (
                <EmptyState title={`No retired entry matches “${filter.trim()}”.`} />
              ) : (
                <EntryTable
                  entries={shownRetired}
                  retired
                  mayAmend={mayAmend}
                  pendingId={pendingId}
                  renderActions={(entry) => {
                    // Reinstating beside an active entry for the same plate
                    // would leave the plate watched twice, under two cases.
                    const clash = watchedPlates.has(entry.plate_normalised)
                    return (
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={clash || pendingId === entry.id}
                        title={clash ? 'This plate is already watched under another entry' : undefined}
                        onClick={() => void toggleActive(entry)}
                      >
                        Reinstate
                      </Button>
                    )
                  }}
                />
              )}
            </section>
          )}
        </div>
      </div>

      {/* ── Add ───────────────────────────────────────────────────────── */}
      {mayAdd && (
        <aside
          aria-label="Add a plate"
          className="shrink-0 border-t border-border bg-chrome lg:w-[360px] lg:overflow-y-auto lg:border-l lg:border-t-0"
        >
          <form onSubmit={submit} className="flex flex-col gap-4 px-5 py-5">
            <div>
              <h2 className="text-sm font-semibold">Add a plate</h2>
              <p className="mt-0.5 text-xs text-faint">
                A sighting on any camera raises an alarm.
              </p>
            </div>

            <Field label="Plate" hint="Spaces and dashes are ignored.">
              <Input
                value={plate}
                onChange={(e) => setPlate(e.target.value.toUpperCase())}
                placeholder="GJ03AB1234"
                className="font-mono uppercase"
                autoComplete="off"
                spellCheck={false}
                aria-invalid={alreadyWatched ? true : undefined}
              />
            </Field>

            {/* The plate as it will be matched, drawn as a plate — what the
                operator is about to put a red ring around. */}
            <div className="flex min-h-[64px] flex-col items-center justify-center gap-1.5 rounded-md border border-dashed border-border bg-background px-3 py-3">
              {typed.length >= 4 ? (
                <PlateChip plate={typed} size="lg" watched />
              ) : (
                <span className="text-xs text-faint">The plate, as it will be matched</span>
              )}
              {alreadyWatched && (
                <span className="text-center text-xs text-priority-high">
                  Already watched{alreadyWatched.case_ref ? ` under ${alreadyWatched.case_ref}` : ''} — amend
                  that entry instead.
                </span>
              )}
            </div>

            <div className="grid grid-cols-2 gap-3">
              <Field label="Category">
                <Select value={category} onChange={(e) => setCategory(e.target.value)}>
                  {CATEGORIES.map((c) => (
                    <option key={c} value={c}>
                      {categoryLabel(c)}
                    </option>
                  ))}
                </Select>
              </Field>

              <Field label="Priority">
                <Select value={priority} onChange={(e) => setPriority(e.target.value as Priority)}>
                  {PRIORITIES.map((p) => (
                    <option key={p} value={p}>
                      {PRIORITY_LABEL[p]}
                    </option>
                  ))}
                </Select>
              </Field>
            </div>

            <Field label="Case reference">
              <Input
                value={caseRef}
                onChange={(e) => setCaseRef(e.target.value)}
                placeholder="FIR/2026/0142"
                className="font-mono"
              />
            </Field>

            <Field label="Remarks" hint="Shown to whoever handles the alarm.">
              <Input
                value={remarks}
                onChange={(e) => setRemarks(e.target.value)}
                placeholder="Reported stolen, Rajkot City"
              />
            </Field>

            <Button type="submit" disabled={busy} className="w-full">
              <Icon name="plus" size={14} />
              {busy ? 'Adding…' : 'Add to watchlist'}
            </Button>
            <p className="text-[11px] leading-relaxed text-faint">
              Recorded in the audit trail against your account.
            </p>
          </form>
        </aside>
      )}

      <AmendDrawer
        entry={editing}
        onClose={() => setEditing(null)}
        onSaved={async () => {
          setEditing(null)
          await load()
        }}
      />
    </div>
  )
}

// ── The list ──────────────────────────────────────────────────────────

function EntryTable({
  entries,
  retired = false,
  mayAmend,
  pendingId,
  renderActions,
}: {
  entries: WatchlistEntry[]
  retired?: boolean
  mayAmend: boolean
  pendingId: string | null
  renderActions: (entry: WatchlistEntry) => ReactNode
}) {
  return (
    <Table className="min-w-[680px]">
      <Thead>
        <tr>
          <Th>Plate</Th>
          <Th>Listed as</Th>
          <Th>Remarks</Th>
          <Th>Priority</Th>
          <Th>Added (IST)</Th>
          {mayAmend && <Th />}
        </tr>
      </Thead>
      <tbody>
        {entries.map((entry) => (
          <Tr key={entry.id} className={pendingId === entry.id ? 'opacity-60' : ''}>
            <Td className="whitespace-nowrap">
              {/* Retired plates are drawn quieter: still the same object, no
                  longer one anything is watching for. */}
              <span className={retired ? 'opacity-60' : ''}>
                <PlateChip plate={entry.plate_normalised} size="sm" />
              </span>
            </Td>
            <Td className="whitespace-nowrap">
              <p className={`text-[13px] ${retired ? 'text-muted-foreground' : ''}`}>
                {categoryLabel(entry.category)}
              </p>
              <p className="font-mono text-[11px] text-faint">
                {entry.case_ref || 'no case reference'}
                {entry.valid_to ? ` · until ${api.formatIST(entry.valid_to)}` : ''}
              </p>
            </Td>
            {/* `w-full max-w-0` lets the remarks take whatever width the
                other columns leave, and truncate inside it — so the actions
                stay on screen at any width rather than scrolling off. */}
            <Td className="w-full max-w-0">
              <p className="truncate text-xs text-muted-foreground" title={entry.remarks ?? undefined}>
                {entry.remarks || '—'}
              </p>
            </Td>
            <Td>
              {/* Grey when normal: a retired entry needs nobody, so its
                  severity is still a shape and a word, but quiet. */}
              <span className={retired ? 'opacity-60' : ''}>
                <PriorityBadge priority={entry.priority} />
              </span>
            </Td>
            <Td className="whitespace-nowrap font-mono text-[11px]">
              <p className="text-muted-foreground">{IST_DATE.format(new Date(entry.created_at))}</p>
              <p className="text-faint">{api.formatIST(entry.created_at, false)}</p>
            </Td>
            {mayAmend && (
              <Td className="text-right">
                <span className="inline-flex items-center justify-end gap-1.5">{renderActions(entry)}</span>
              </Td>
            )}
          </Tr>
        ))}
      </tbody>
    </Table>
  )
}

// ── Amending an entry ─────────────────────────────────────────────────

/**
 * Change how an entry is watched for — its priority, category, remarks.
 *
 * Not its case reference: a plate and its case together are the entry's
 * identity, and a different case is a different entry. Changing it here would
 * rewrite what an alarm raised yesterday was raised under.
 */
function AmendDrawer({
  entry,
  onClose,
  onSaved,
}: {
  entry: WatchlistEntry | null
  onClose: () => void
  onSaved: () => Promise<void>
}) {
  const toast = useToast()
  const [category, setCategory] = useState('')
  const [priority, setPriority] = useState<Priority>('high')
  const [remarks, setRemarks] = useState('')
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (!entry) return
    setCategory(entry.category)
    setPriority(entry.priority)
    setRemarks(entry.remarks ?? '')
  }, [entry])

  if (!entry) return null

  // An entry may carry a category this form does not offer (the API accepts
  // any short word); keep it choosable rather than silently replace it.
  const categories: string[] = CATEGORIES.includes(entry.category as (typeof CATEGORIES)[number])
    ? [...CATEGORIES]
    : [entry.category, ...CATEGORIES]

  const changed =
    category !== entry.category || priority !== entry.priority || remarks.trim() !== (entry.remarks ?? '')

  async function save(event: FormEvent) {
    event.preventDefault()
    if (!entry) return
    setSaving(true)
    try {
      await api.updateWatchlistEntry(entry.id, {
        category,
        priority,
        remarks: remarks.trim() || null,
      })
      toast.success(`${entry.plate_normalised} amended. Recorded against you.`)
      await onSaved()
    } catch (err) {
      toast.error(err)
    } finally {
      setSaving(false)
    }
  }

  return (
    <Drawer
      open
      onClose={onClose}
      title={`Amend ${spacedPlate(entry.plate_normalised)}`}
      description={
        entry.case_ref ? (
          <>
            Under <span className="font-mono">{entry.case_ref}</span>. A different case is a
            different entry.
          </>
        ) : (
          'A different case is a different entry.'
        )
      }
      width="w-[min(28rem,94vw)]"
    >
      <form onSubmit={save} className="flex flex-col gap-4">
        <div className="flex justify-center rounded-md border border-border bg-background py-4">
          <PlateChip plate={entry.plate_normalised} size="lg" watched={entry.active} />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Category">
            <Select value={category} onChange={(e) => setCategory(e.target.value)}>
              {categories.map((c) => (
                <option key={c} value={c}>
                  {categoryLabel(c)}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Priority">
            <Select value={priority} onChange={(e) => setPriority(e.target.value as Priority)}>
              {PRIORITIES.map((p) => (
                <option key={p} value={p}>
                  {PRIORITY_LABEL[p]}
                </option>
              ))}
            </Select>
          </Field>
        </div>
        <Field label="Remarks" hint="Shown to whoever handles the alarm.">
          <Input value={remarks} onChange={(e) => setRemarks(e.target.value)} />
        </Field>
        <div className="flex items-center gap-2 pt-1">
          <Button type="submit" disabled={saving || !changed}>
            {saving ? 'Saving…' : 'Save'}
          </Button>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <span className="ml-auto text-[11px] text-faint">Recorded in the audit trail.</span>
        </div>
      </form>
    </Drawer>
  )
}
