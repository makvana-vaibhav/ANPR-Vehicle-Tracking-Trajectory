/**
 * The persons watchlist: people the platform is authorised to look for.
 *
 * A face is the most sensitive thing this platform handles, and the screen is
 * built to make its controls visible rather than merely enforced:
 *
 *  - **Four-eyes.** An entry is enrolled by one account and starts matching
 *    only when a *different* account approves it. The approval queue says, on
 *    each entry, whether you may decide it and why not — "you enrolled this"
 *    is shown, not discovered as a refusal.
 *  - **Purpose and expiry.** Every entry carries the purpose it is held for,
 *    a case reference and an expiry; the list shows how long each has left.
 *  - **Audited looking.** Every list and every view of a photograph is written
 *    to the audit trail by the API, naming each photo it signed a link for.
 *    So this screen reads the list when it opens and after a change, and never
 *    polls.
 *  - **Possible, never identified.** A match raises a "Possible person match"
 *    alarm that a person must confirm by comparing the two faces.
 *
 * Retired and rejected entries are kept, quietly, as the record of what was
 * authorised and by whom; their embeddings are already destroyed and their
 * photos go at the retention date.
 */

import { useCallback, useEffect, useMemo, useState, type FormEvent, type ReactNode } from 'react'

import { SkeletonRows } from '@/components/Skeleton'
import { useToast } from '@/components/Toast'
import {
  Badge,
  Button,
  Drawer,
  EmptyState,
  ErrorBanner,
  Field,
  Icon,
  InfoHint,
  Input,
  PageHeader,
  SectionLabel,
  Select,
  StatTile,
  Table,
  Td,
  Th,
  Thead,
  Tr,
  controlClass,
} from '@/components/ui'
import { useAuth } from '@/hooks/useAuth'
import * as api from '@/lib/api'
import { PERMISSIONS } from '@/lib/permissions'
import type { PersonEntry, PersonGalleryStatus, PersonStatus } from '@/lib/types'

/** The API's ceiling for one page; each row signs a photo link. */
const LIST_LIMIT = 50

const CATEGORY_LABEL: Record<string, string> = {
  missing: 'Missing person',
  wanted: 'Wanted — warrant',
  demo: 'Demo — fictional case',
}

const CATEGORY_HINT: Record<string, string> = {
  missing: 'Reported missing; the entry exists to find them.',
  wanted: 'Sought under the warrant or order the case reference names.',
  demo: 'A demonstration on recorded footage. Never a real investigation.',
}

export function categoryLabel(category: string): string {
  return CATEGORY_LABEL[category] ?? category.charAt(0).toUpperCase() + category.slice(1)
}

const STATUS_WORD: Record<PersonStatus, string> = {
  pending_approval: 'Awaiting approval',
  active: 'Matched now',
  rejected: 'Rejected',
  retired: 'Retired',
}

const IST_DATE = new Intl.DateTimeFormat('en-IN', { timeZone: 'Asia/Kolkata', dateStyle: 'medium' })

/** "12 days left", "expires today", "expired". */
export function expiryLabel(validUntil: string, now: number): string {
  const ms = Date.parse(validUntil) - now
  if (ms <= 0) return 'expired'
  const days = Math.floor(ms / 86_400_000)
  if (days === 0) return 'expires today'
  return `${days} day${days === 1 ? '' : 's'} left`
}

/** Why the caller may not decide on a pending entry, or null if they may. */
export function reviewBlocker(
  entry: Pick<PersonEntry, 'can_review' | 'enrolled_by' | 'status'>,
  userId: string | null,
  mayApprove: boolean,
): string | null {
  if (entry.status !== 'pending_approval') return 'Only an entry awaiting approval can be decided.'
  if (!mayApprove) return 'Approving needs the person.approve permission.'
  if (userId !== null && entry.enrolled_by === userId) {
    return 'You enrolled this entry — a different account must approve or reject it.'
  }
  return entry.can_review ? null : 'You cannot decide this entry.'
}

export default function Persons() {
  const toast = useToast()
  const { can, user } = useAuth()
  const mayEnrol = can(PERMISSIONS.personEnrol)
  const mayApprove = can(PERMISSIONS.personApprove)
  const mayRetire = can(PERMISSIONS.personRetire)

  const [entries, setEntries] = useState<PersonEntry[]>([])
  const [gallery, setGallery] = useState<PersonGalleryStatus | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [enrolling, setEnrolling] = useState(false)
  const [deciding, setDeciding] = useState<{ entry: PersonEntry; action: 'reject' | 'retire' } | null>(
    null,
  )
  const [pendingId, setPendingId] = useState<string | null>(null)
  const [now] = useState(() => Date.now())

  const load = useCallback(async () => {
    try {
      const [page, status] = await Promise.all([
        api.getPersons({ limit: LIST_LIMIT }),
        api.getPersonGallery(),
      ])
      setEntries(page.items)
      setGallery(status)
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

  const pending = useMemo(() => entries.filter((e) => e.status === 'pending_approval'), [entries])
  const active = useMemo(() => entries.filter((e) => e.status === 'active'), [entries])
  const ended = useMemo(
    () => entries.filter((e) => e.status === 'retired' || e.status === 'rejected'),
    [entries],
  )

  async function approve(entry: PersonEntry) {
    setPendingId(entry.id)
    try {
      await api.approvePerson(entry.id)
      toast.success(`${entry.display_name} approved — the cameras now look for this face. Recorded against you.`)
      await load()
    } catch (err) {
      toast.error(err)
    } finally {
      setPendingId(null)
    }
  }

  const cameras = gallery?.cameras ?? []

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="flex flex-col gap-6 px-6 py-5">
        <PageHeader
          title="Persons"
          subtitle={
            <>
              <span>
                {loading
                  ? 'Reading the list…'
                  : `${active.length} matched now · ${pending.length} awaiting a second approver`}
              </span>
              <span className="text-faint">·</span>
              <span>
                {cameras.length > 0
                  ? `faces looked for on ${cameras.join(', ')}`
                  : 'no camera is tagged to look for faces'}
              </span>
              <InfoHint label="What this watchlist does, and what it never does">
                A face seen by a camera tagged <code className="font-mono">analytics:faces</code> is
                compared with the approved entries below. When several frames of the same face agree
                with one entry, a <em>Possible person match</em> alarm is raised — and a person must
                compare the two faces before anyone acts. Faces that match nothing are not stored:
                no crop, no embedding. Every view of this list and of every photograph is recorded
                in the audit trail.
              </InfoHint>
            </>
          }
          actions={
            mayEnrol ? (
              <Button onClick={() => setEnrolling(true)}>
                <Icon name="plus" size={14} />
                Enrol a person
              </Button>
            ) : undefined
          }
        />

        {error && <ErrorBanner>Could not read the persons watchlist: {error}</ErrorBanner>}

        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <StatTile
            label="Matched now"
            value={gallery ? String(gallery.active_entries) : '—'}
            detail="approved, unexpired entries the cameras compare against"
          />
          <StatTile
            label="Awaiting approval"
            value={gallery ? String(gallery.pending_entries) : '—'}
            tone={gallery && gallery.pending_entries > 0 ? 'warn' : undefined}
            detail="needs a second account — four-eyes"
          />
          <StatTile
            label="Match rule"
            value={gallery ? gallery.threshold.toFixed(2) : '—'}
            detail={
              gallery
                ? `cosine similarity, ${gallery.min_frames}+ frames agreeing (model's own ${gallery.model_threshold.toFixed(3)})`
                : undefined
            }
            info="A frame must reach this similarity to the enrolled reference, and several frames of the same face must agree on the same entry, clear of the next-closest. The platform's threshold is stricter than the model's published one because one face is compared with every passer-by."
          />
          <StatTile
            label="Cameras looking"
            value={gallery ? String(cameras.length) : '—'}
            detail={cameras.length ? cameras.join(', ') : 'tag a camera analytics:faces to start'}
          />
        </div>

        {!mayEnrol && !mayApprove && !mayRetire && (
          <p className="rounded-lg border border-border bg-card px-4 py-2.5 text-xs text-muted-foreground">
            Your role can read the persons watchlist but not change it. Enrolling needs{' '}
            <code className="font-mono text-foreground">person.enrol</code>; approving needs{' '}
            <code className="font-mono text-foreground">person.approve</code>, held by a different
            account from the one that enrolled.
          </p>
        )}

        {/* ── The approval queue ─────────────────────────────────────── */}
        <section className="flex flex-col gap-2" aria-label="Awaiting approval">
          <SectionLabel>
            Awaiting a second approver ({loading ? '…' : pending.length})
            <InfoHint>
              Four-eyes: the account that enrolled an entry cannot approve or reject it. The API
              refuses it, and so does the database. Nothing here is matched until it is approved.
            </InfoHint>
          </SectionLabel>
          {loading ? (
            <SkeletonRows rows={1} height="h-20" />
          ) : pending.length === 0 ? (
            <EmptyState title="Nothing is waiting for approval." />
          ) : (
            <ul className="flex flex-col gap-2">
              {pending.map((entry) => {
                const blocker = reviewBlocker(entry, user?.id ?? null, mayApprove)
                return (
                  <li
                    key={entry.id}
                    className="flex flex-wrap items-center gap-4 rounded-lg border border-priority-high/30 bg-card p-3"
                  >
                    <Portrait url={entry.photo_url} name={entry.display_name} size={64} />
                    <div className="min-w-0 flex-1">
                      <EntryTitle entry={entry} />
                      <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">{entry.purpose}</p>
                      <p className="mt-1 text-[11px] text-faint">
                        Enrolled by <span className="text-muted-foreground">{entry.enrolled_by_username}</span>{' '}
                        {api.formatIST(entry.enrolled_at)} IST
                        {entry.enrol_quality?.face_px
                          ? ` · face ${Math.round(entry.enrol_quality.face_px)} px, detector ${entry.enrol_quality.detector_score?.toFixed(2) ?? '—'}`
                          : ''}
                      </p>
                    </div>
                    <div className="flex shrink-0 flex-col items-end gap-1.5">
                      {blocker === null ? (
                        <span className="flex gap-2">
                          <Button
                            size="sm"
                            disabled={pendingId === entry.id}
                            onClick={() => void approve(entry)}
                          >
                            Approve
                          </Button>
                          <Button
                            size="sm"
                            variant="outline"
                            disabled={pendingId === entry.id}
                            onClick={() => setDeciding({ entry, action: 'reject' })}
                          >
                            Reject
                          </Button>
                        </span>
                      ) : (
                        <span className="max-w-[16rem] text-right text-xs text-muted-foreground">
                          <Icon name="shield" size={13} className="mr-1 inline align-[-2px]" />
                          {blocker}
                        </span>
                      )}
                      {mayRetire && (
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => setDeciding({ entry, action: 'retire' })}
                        >
                          Withdraw
                        </Button>
                      )}
                    </div>
                  </li>
                )
              })}
            </ul>
          )}
        </section>

        {/* ── Matched now ────────────────────────────────────────────── */}
        <section className="flex flex-col gap-2" aria-label="Matched now">
          <SectionLabel>Matched now ({loading ? '…' : active.length})</SectionLabel>
          {loading ? (
            <SkeletonRows rows={3} height="h-14" />
          ) : active.length === 0 ? (
            <EmptyState
              title="No approved entry — the cameras are matching against nobody."
              hint={mayEnrol ? 'Enrol a person; a second account approves it.' : undefined}
            />
          ) : (
            <EntryTable
              entries={active}
              now={now}
              renderActions={
                mayRetire
                  ? (entry) => (
                      <Button size="sm" variant="outline" onClick={() => setDeciding({ entry, action: 'retire' })}>
                        Retire
                      </Button>
                    )
                  : undefined
              }
            />
          )}
        </section>

        {/* ── No longer matched ──────────────────────────────────────── */}
        {!loading && ended.length > 0 && (
          <section className="flex flex-col gap-2" aria-label="No longer matched">
            <SectionLabel>
              No longer matched ({ended.length})
              <InfoHint>
                Kept as the record of what was authorised, by whom and why. Their embeddings were
                destroyed when they stopped matching; their photos are deleted at the media retention
                date.
              </InfoHint>
            </SectionLabel>
            <EntryTable entries={ended} now={now} quiet />
          </section>
        )}
      </div>

      <EnrolDrawer
        open={enrolling}
        gallery={gallery}
        onClose={() => setEnrolling(false)}
        onEnrolled={async () => {
          setEnrolling(false)
          await load()
        }}
      />
      <DecisionDrawer
        decision={deciding}
        onClose={() => setDeciding(null)}
        onDone={async () => {
          setDeciding(null)
          await load()
        }}
      />
    </div>
  )
}

// ── Pieces ────────────────────────────────────────────────────────────

/** The reference photo. A signed two-minute link; if it has lapsed or the
 *  photo was removed by retention, the frame says so instead of breaking. */
function Portrait({ url, name, size = 44 }: { url: string | null; name: string; size?: number }) {
  const [failed, setFailed] = useState(false)
  const style = { width: size, height: size }
  if (!url || failed) {
    return (
      <span
        style={style}
        className="grid shrink-0 place-items-center rounded-md border border-dashed border-border text-faint"
        title={url ? 'The photo link has lapsed — reopen the screen' : 'No photo held'}
      >
        <Icon name="users" size={Math.round(size / 2.6)} />
      </span>
    )
  }
  return (
    <img
      src={url}
      alt={`Reference photo: ${name}`}
      style={style}
      // max-w-none: Tailwind's preflight caps an image at its container's
      // width, and a table cell beside a `w-full` column has almost none.
      className="max-w-none shrink-0 rounded-md border border-border object-cover"
      onError={() => setFailed(true)}
    />
  )
}

function EntryTitle({ entry }: { entry: PersonEntry }) {
  return (
    <p className="flex flex-wrap items-center gap-2">
      <span className="text-[14px] font-semibold">{entry.display_name}</span>
      <Badge tone={entry.category === 'demo' ? 'neutral' : 'primary'} title={CATEGORY_HINT[entry.category]}>
        {categoryLabel(entry.category)}
      </Badge>
      <span className="font-mono text-[11px] text-muted-foreground">{entry.case_ref}</span>
    </p>
  )
}

function EntryTable({
  entries,
  now,
  quiet = false,
  renderActions,
}: {
  entries: PersonEntry[]
  now: number
  quiet?: boolean
  renderActions?: (entry: PersonEntry) => ReactNode
}) {
  return (
    <Table className="min-w-[760px]">
      <Thead>
        <tr>
          <Th className="w-16">
            <span className="sr-only">Photo</span>
          </Th>
          <Th>Entry</Th>
          <Th>Status</Th>
          <Th>Valid until (IST)</Th>
          <Th>Enrolled · approved</Th>
          {renderActions && <Th />}
        </tr>
      </Thead>
      <tbody>
        {entries.map((entry) => (
          <Tr key={entry.id} className={quiet ? 'opacity-70' : ''}>
            <Td>
              <Portrait url={entry.photo_url} name={entry.display_name} />
            </Td>
            <Td className="w-full max-w-0">
              <EntryTitle entry={entry} />
              <p className="mt-0.5 truncate text-xs text-muted-foreground" title={entry.purpose}>
                {entry.purpose}
              </p>
            </Td>
            <Td className="whitespace-nowrap text-xs">
              <p className={entry.status === 'active' ? 'text-foreground' : 'text-muted-foreground'}>
                {STATUS_WORD[entry.status]}
              </p>
              {(entry.retired_reason || entry.rejection_reason) && (
                <p
                  className="max-w-[14rem] truncate text-[11px] text-faint"
                  title={entry.retired_reason ?? entry.rejection_reason ?? undefined}
                >
                  {entry.retired_reason ?? entry.rejection_reason}
                </p>
              )}
            </Td>
            <Td className="whitespace-nowrap font-mono text-[11px]">
              <p className="text-muted-foreground">{IST_DATE.format(new Date(entry.valid_until))}</p>
              {entry.status === 'active' && <p className="text-faint">{expiryLabel(entry.valid_until, now)}</p>}
            </Td>
            <Td className="whitespace-nowrap text-[11px] text-muted-foreground">
              <p>{entry.enrolled_by_username}</p>
              <p className="text-faint">
                {entry.approved_by_username
                  ? `approved by ${entry.approved_by_username}`
                  : entry.rejected_by_username
                    ? `rejected by ${entry.rejected_by_username}`
                    : 'not approved'}
              </p>
            </Td>
            {renderActions && <Td className="text-right">{renderActions(entry)}</Td>}
          </Tr>
        ))}
      </tbody>
    </Table>
  )
}

// ── Enrolling ─────────────────────────────────────────────────────────

const CATEGORIES = ['missing', 'wanted', 'demo'] as const

function EnrolDrawer({
  open,
  gallery,
  onClose,
  onEnrolled,
}: {
  open: boolean
  gallery: PersonGalleryStatus | null
  onClose: () => void
  onEnrolled: () => Promise<void>
}) {
  const toast = useToast()
  const [photo, setPhoto] = useState<File | null>(null)
  const [preview, setPreview] = useState<string | null>(null)
  const [displayName, setDisplayName] = useState('')
  const [category, setCategory] = useState<string>('missing')
  const [caseRef, setCaseRef] = useState('')
  const [purpose, setPurpose] = useState('')
  const [notes, setNotes] = useState('')
  const [validDays, setValidDays] = useState('')
  const [busy, setBusy] = useState(false)
  const [refusal, setRefusal] = useState<string | null>(null)

  const maxDays = gallery?.max_valid_days ?? 90
  const defaultDays = gallery?.default_valid_days ?? 30

  // The preview is a local object URL: the photo is not uploaded until submit.
  useEffect(() => {
    if (!photo) {
      setPreview(null)
      return
    }
    const url = URL.createObjectURL(photo)
    setPreview(url)
    return () => URL.revokeObjectURL(url)
  }, [photo])

  useEffect(() => {
    if (open) return
    setPhoto(null)
    setDisplayName('')
    setCategory('missing')
    setCaseRef('')
    setPurpose('')
    setNotes('')
    setValidDays('')
    setRefusal(null)
  }, [open])

  if (!open) return null

  const ready =
    photo !== null && displayName.trim() && caseRef.trim() && purpose.trim().length >= 10 && !busy

  async function submit(event: FormEvent) {
    event.preventDefault()
    if (!photo) return
    setBusy(true)
    setRefusal(null)
    try {
      const days = Number(validDays || defaultDays)
      const entry = await api.enrolPerson({
        photo,
        display_name: displayName.trim(),
        category,
        case_ref: caseRef.trim(),
        purpose: purpose.trim(),
        notes: notes.trim() || undefined,
        valid_days: Number.isFinite(days) ? days : undefined,
      })
      toast.success(`${entry.display_name} enrolled — awaiting a second approver. Recorded against you.`)
      await onEnrolled()
    } catch (err) {
      // A refused photo (no face, several faces, too small) says what to do
      // instead; it belongs beside the photo, not in a toast that fades.
      setRefusal(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Drawer
      open
      onClose={onClose}
      title="Enrol a person"
      description="One reference photo. Matching starts only when a different account approves."
      width="w-[min(34rem,94vw)]"
    >
      <form onSubmit={submit} className="flex flex-col gap-4">
        <div className="flex gap-4">
          <div className="grid h-36 w-28 shrink-0 place-items-center overflow-hidden rounded-md border border-dashed border-border bg-background">
            {preview ? (
              <img src={preview} alt="Reference photo preview" className="h-full w-full object-cover" />
            ) : (
              <Icon name="users" size={28} className="text-faint" />
            )}
          </div>
          <div className="flex min-w-0 flex-col gap-2">
            <Field
              label="Reference photo"
              hint={`JPEG or PNG showing exactly one face, at least ${gallery?.min_face_px ?? 80} px across. It is re-encoded before it is stored — no EXIF, no location.`}
            >
              <input
                type="file"
                accept="image/jpeg,image/png"
                aria-label="Reference photo"
                onChange={(e) => {
                  setRefusal(null)
                  setPhoto(e.target.files?.[0] ?? null)
                }}
                className="block w-full text-xs text-muted-foreground file:mr-3 file:rounded-md file:border file:border-input file:bg-secondary file:px-2.5 file:py-1 file:text-xs file:text-foreground"
              />
            </Field>
          </div>
        </div>

        {refusal && (
          <p role="alert" className="rounded-md border border-priority-high/45 bg-priority-high/10 px-3 py-2 text-xs text-priority-high">
            {refusal}
          </p>
        )}

        <Field label="Display name" hint="An alias or case name is enough — often better than a legal name.">
          <Input value={displayName} onChange={(e) => setDisplayName(e.target.value)} maxLength={120} />
        </Field>

        <div className="grid grid-cols-2 gap-3">
          <Field label="Category" hint={CATEGORY_HINT[category]}>
            <Select value={category} onChange={(e) => setCategory(e.target.value)}>
              {CATEGORIES.map((c) => (
                <option key={c} value={c}>
                  {categoryLabel(c)}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Case reference" hint="Missing-person report, warrant or order number.">
            <Input
              value={caseRef}
              onChange={(e) => setCaseRef(e.target.value)}
              maxLength={64}
              placeholder="MP/2026/0142"
              className="font-mono"
            />
          </Field>
        </div>

        <Field
          label="Purpose and legal basis"
          hint="Required. Why this person may be looked for, under what authority. Shown to the approver."
        >
          <textarea
            value={purpose}
            onChange={(e) => setPurpose(e.target.value)}
            rows={3}
            maxLength={2000}
            className={controlClass}
            aria-label="Purpose and legal basis"
          />
        </Field>

        <div className="grid grid-cols-[1fr_8rem] gap-3">
          <Field label="Notes" hint="For whoever handles a possible match.">
            <Input value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={2000} />
          </Field>
          <Field label="Valid for (days)" hint={`Up to ${maxDays}.`}>
            <Input
              type="number"
              min={1}
              max={maxDays}
              value={validDays}
              placeholder={String(defaultDays)}
              onChange={(e) => setValidDays(e.target.value)}
            />
          </Field>
        </div>

        <div className="flex items-center gap-2 pt-1">
          <Button type="submit" disabled={!ready}>
            {busy ? 'Checking the photo…' : 'Enrol — pending approval'}
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

// ── Rejecting, withdrawing, retiring ──────────────────────────────────

function DecisionDrawer({
  decision,
  onClose,
  onDone,
}: {
  decision: { entry: PersonEntry; action: 'reject' | 'retire' } | null
  onClose: () => void
  onDone: () => Promise<void>
}) {
  const toast = useToast()
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    setReason('')
  }, [decision])

  if (!decision) return null
  const { entry, action } = decision
  const rejecting = action === 'reject'
  const withdrawing = !rejecting && entry.status === 'pending_approval'

  async function submit(event: FormEvent) {
    event.preventDefault()
    setBusy(true)
    try {
      if (rejecting) await api.rejectPerson(entry.id, reason.trim())
      else await api.retirePerson(entry.id, reason.trim())
      toast.success(
        rejecting
          ? `${entry.display_name} rejected. Recorded against you.`
          : `${entry.display_name} ${withdrawing ? 'withdrawn' : 'retired'} — no camera matches it any more.`,
      )
      await onDone()
    } catch (err) {
      toast.error(err)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Drawer
      open
      onClose={onClose}
      title={rejecting ? `Reject ${entry.display_name}` : `${withdrawing ? 'Withdraw' : 'Retire'} ${entry.display_name}`}
      description={
        rejecting
          ? 'A rejection must say why — it is the decision most worth reviewing later.'
          : 'Matching stops at once and the embedding is destroyed. Re-enrolling needs a new approval.'
      }
      width="w-[min(28rem,94vw)]"
    >
      <form onSubmit={submit} className="flex flex-col gap-4">
        <div className="flex items-center gap-3">
          <Portrait url={entry.photo_url} name={entry.display_name} size={56} />
          <EntryTitle entry={entry} />
        </div>
        <Field label="Reason">
          <Input
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            maxLength={1000}
            placeholder={rejecting ? 'The photo is not the person in the case file' : 'Found safe; case closed'}
            autoFocus
          />
        </Field>
        <div className="flex items-center gap-2">
          <Button type="submit" variant="destructive" disabled={busy || !reason.trim()}>
            {rejecting ? 'Reject' : withdrawing ? 'Withdraw' : 'Retire'}
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
