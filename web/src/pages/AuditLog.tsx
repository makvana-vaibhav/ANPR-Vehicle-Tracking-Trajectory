/**
 * The audit trail.
 *
 * This is the screen that answers "who looked at whom", which for a
 * surveillance platform is the question that matters most after "does it
 * work". `AUDIT_READ` existed as a permission from Phase 1 with nothing behind
 * it; this is what it was always gating.
 *
 * Reading this page is itself recorded. That is deliberate and not hidden — a
 * reviewer who leaves no trace is a hole in the very control the page exists
 * to provide, and the note at the top says so rather than letting somebody
 * discover it in their own entry later.
 *
 * Two consequences of that are handled here rather than left to surprise:
 *
 * - **Every fetch writes a row.** The username filter used to refetch on each
 *   keystroke, so typing a name wrote one audit row per letter. It now waits
 *   for the typing to stop.
 * - **Pages are offsets into a table that is growing at the top** — by one row
 *   for every page turned, at least. A row can therefore appear at the foot of
 *   one page and the head of the next; the id column is there so a reviewer
 *   can see that it is the same entry.
 */

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'

import { SkeletonRows } from '@/components/Skeleton'
import {
  Button,
  Drawer,
  EmptyState,
  ErrorBanner,
  Icon,
  InfoHint,
  Input,
  PageHeader,
  SegmentedControl,
  Select,
  SeverityGlyph,
  Table,
  Td,
  Th,
  Thead,
  Toolbar,
  ToolbarField,
  Tr,
} from '@/components/ui'
import * as api from '@/lib/api'
import { downloadCsv, stampedName } from '@/lib/csv'
import type { AuditEntry } from '@/lib/types'

const WINDOWS = [
  { value: '1', label: '1 h', hours: 1 },
  { value: '24', label: '24 h', hours: 24 },
  { value: '168', label: '7 d', hours: 168 },
  { value: '720', label: '30 d', hours: 720 },
] as const

/**
 * The actions worth filtering to, in the order a reviewer asks for them.
 * Each value is a prefix the API matches with `startswith`.
 *
 * Stream opens are `camera.view` — the row written when a viewing token is
 * issued (`services/audit.py: record_stream_open`). This entry used to filter
 * on `stream.`, which no action has ever started with, so it always showed an
 * empty trail for the most privacy-sensitive act on the platform.
 */
const ACTIONS = [
  { label: 'Everything', value: '' },
  { label: 'Plate searches', value: 'search.' },
  { label: 'Vehicle journeys', value: 'vehicle.' },
  { label: 'Stream opens', value: 'camera.view' },
  { label: 'Watchlist changes', value: 'watchlist.' },
  { label: 'Alert actions', value: 'alert.' },
  { label: 'Sign-ins and refusals', value: 'auth.' },
  { label: 'Account admin', value: 'user.' },
  { label: 'Cameras, incl. stream opens', value: 'camera.' },
  { label: 'Audit reads', value: 'audit.' },
] as const

/**
 * The result vocabulary is `AuditResult` in `models/enums.py`: success,
 * denied, error. This screen used to style a `failure` that the API never
 * writes, so every error row rendered as an ordinary one.
 */
const RESULTS = [
  { label: 'Any result', value: '' },
  { label: 'Success', value: 'success' },
  { label: 'Denied', value: 'denied' },
  { label: 'Error', value: 'error' },
] as const

const PAGE_SIZE = 100

/** Typing pauses this long before the username filter is applied. */
const USER_FILTER_DEBOUNCE_MS = 450

const IST_DAY = new Intl.DateTimeFormat('en-IN', {
  timeZone: 'Asia/Kolkata',
  day: '2-digit',
  month: 'short',
})
const IST_TIME = new Intl.DateTimeFormat('en-IN', {
  timeZone: 'Asia/Kolkata',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hour12: false,
})

function ResultMark({ result }: { result: string }) {
  if (result === 'denied') {
    return (
      <span className="inline-flex items-center gap-1.5 text-priority-high">
        <SeverityGlyph priority="high" size={8} />
        denied
      </span>
    )
  }
  if (result === 'error') {
    return (
      <span className="inline-flex items-center gap-1.5 text-priority-critical">
        <SeverityGlyph priority="critical" size={8} />
        error
      </span>
    )
  }
  return <span className="text-faint">{result}</span>
}

/** `search.plate` → a quiet category and the verb that matters. */
function ActionName({ action }: { action: string }) {
  const dot = action.indexOf('.')
  if (dot < 0) return <span className="font-mono text-xs">{action}</span>
  return (
    <span className="font-mono text-xs">
      <span className="text-faint">{action.slice(0, dot + 1)}</span>
      <span className="text-foreground">{action.slice(dot + 1)}</span>
    </span>
  )
}

export default function AuditLog() {
  const [entries, setEntries] = useState<AuditEntry[]>([])
  const [total, setTotal] = useState(0)
  const [hours, setHours] = useState<number>(24)
  const [action, setAction] = useState('')
  const [result, setResult] = useState('')
  const [userInput, setUserInput] = useState('')
  const [username, setUsername] = useState('')
  const [offset, setOffset] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadedOnce, setLoadedOnce] = useState(false)
  const [selected, setSelected] = useState<AuditEntry | null>(null)

  // Responses can arrive out of order when filters change quickly; only the
  // newest request may write to the screen.
  const sequence = useRef(0)

  const load = useCallback(async () => {
    const mine = ++sequence.current
    setLoading(true)
    try {
      const page = await api.getAudit({
        action: action || undefined,
        username: username || undefined,
        result: result || undefined,
        since: new Date(Date.now() - hours * 3_600_000).toISOString(),
        limit: PAGE_SIZE,
        offset,
      })
      if (mine !== sequence.current) return
      setEntries(page.items)
      setTotal(page.total)
      setError(null)
    } catch (err) {
      if (mine !== sequence.current) return
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      if (mine === sequence.current) {
        setLoading(false)
        setLoadedOnce(true)
      }
    }
  }, [action, username, result, hours, offset])

  useEffect(() => {
    void load()
  }, [load])

  // Each fetch writes an audit row of its own, so the name filter applies
  // once typing pauses rather than once per letter.
  useEffect(() => {
    const next = userInput.trim()
    if (next === username) return
    const timer = window.setTimeout(() => {
      setUsername(next)
      setOffset(0)
    }, USER_FILTER_DEBOUNCE_MS)
    return () => window.clearTimeout(timer)
  }, [userInput, username])

  const first = total === 0 ? 0 : offset + 1
  const last = offset + entries.length
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE))
  const page = Math.floor(offset / PAGE_SIZE) + 1
  const windowLabel = WINDOWS.find((w) => w.hours === hours)?.label ?? ''
  const filtered = Boolean(action || result || username)

  function filterTo(change: { action?: string; username?: string }) {
    if (change.action !== undefined) setAction(change.action)
    if (change.username !== undefined) {
      setUserInput(change.username)
      setUsername(change.username)
    }
    setOffset(0)
    setSelected(null)
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden px-6 pb-5 pt-5">
      <div className="shrink-0">
        <PageHeader
          title="Audit trail"
          subtitle={
            <>
              <span className="font-mono">
                {!loadedOnce
                  ? 'loading…'
                  : `${first.toLocaleString('en-IN')}–${last.toLocaleString('en-IN')} of ${total.toLocaleString('en-IN')}`}
              </span>
              <span>{filtered ? 'matching' : 'entries'}, last {windowLabel}</span>
              <span className="text-muted-foreground/40">·</span>
              <span className="inline-flex items-center gap-1.5 text-foreground">
                <Icon name="eye" size={13} className="text-muted-foreground" />
                Opening this page is recorded
              </span>
              <InfoHint label="Why reading the audit trail is itself audited">
                This platform tracks the movement of private vehicles, so who
                looked at what is part of the record. A reviewer who left no
                trace would be a hole in the very control this page exists to
                provide — which is said here rather than left for somebody to
                discover in their own entry later. Every page you turn adds a
                row at the top, so an entry can repeat across a page boundary;
                the id column tells you when it has.
              </InfoHint>
            </>
          }
          actions={
            <Toolbar>
              <ToolbarField label="Action">
                <Select
                  value={action}
                  onChange={(e) => {
                    setAction(e.target.value)
                    setOffset(0)
                  }}
                  className="h-8 py-0"
                >
                  {ACTIONS.map((a) => (
                    <option key={a.value} value={a.value}>
                      {a.label}
                    </option>
                  ))}
                  {/* An exact action picked from an entry's detail. Without
                      its own option the select would show "Everything" while
                      filtering to one action — the screen contradicting
                      itself. */}
                  {!ACTIONS.some((a) => a.value === action) && (
                    <option value={action}>{action}</option>
                  )}
                </Select>
              </ToolbarField>

              <ToolbarField label="Result">
                <Select
                  value={result}
                  onChange={(e) => {
                    setResult(e.target.value)
                    setOffset(0)
                  }}
                  className="h-8 py-0"
                >
                  {RESULTS.map((r) => (
                    <option key={r.value} value={r.value}>
                      {r.label}
                    </option>
                  ))}
                </Select>
              </ToolbarField>

              <ToolbarField label="User" className="w-36">
                <Input
                  value={userInput}
                  onChange={(e) => setUserInput(e.target.value)}
                  placeholder="exact username"
                  autoCapitalize="none"
                  spellCheck={false}
                  className="h-8 py-0 font-mono"
                />
              </ToolbarField>

              <ToolbarField label="Window" group>
                <SegmentedControl
                  className="h-8"
                  value={String(hours)}
                  onChange={(v) => {
                    setHours(Number(v))
                    setOffset(0)
                  }}
                  options={WINDOWS.map((w) => ({ value: w.value, label: w.label }))}
                />
              </ToolbarField>

              <Button
                variant="outline"
                disabled={entries.length === 0}
                onClick={() =>
                  downloadCsv(stampedName('audit'), entries, [
                    { header: 'id', value: (e) => e.id },
                    { header: 'timestamp_utc', value: (e) => e.ts },
                    { header: 'username', value: (e) => e.username },
                    { header: 'user_id', value: (e) => e.user_id },
                    { header: 'role', value: (e) => e.role },
                    { header: 'action', value: (e) => e.action },
                    { header: 'resource_type', value: (e) => e.resource_type },
                    { header: 'resource_id', value: (e) => e.resource_id },
                    { header: 'ip', value: (e) => e.ip },
                    { header: 'result', value: (e) => e.result },
                    { header: 'params', value: (e) => e.params },
                  ])
                }
                title="Export the rows on this page. Timestamps are UTC in the file; the table displays IST."
              >
                <Icon name="download" size={15} />
                Export page
              </Button>
            </Toolbar>
          }
        />
      </div>

      {error && (
        <div className="mt-4 shrink-0">
          <ErrorBanner>{error}</ErrorBanner>
        </div>
      )}

      <div className="mt-4 flex min-h-0 flex-1 flex-col overflow-hidden rounded-lg border border-border bg-card">
        {!loadedOnce ? (
          <div className="p-4">
            <SkeletonRows rows={10} height="h-8" />
          </div>
        ) : entries.length === 0 ? (
          <div className="p-4">
            <EmptyState
              title="Nothing matching in this window."
              hint={filtered ? 'Widen the window or clear a filter.' : undefined}
            />
          </div>
        ) : (
          <div
            className={`min-h-0 flex-1 overflow-auto transition-opacity ${loading ? 'opacity-60' : ''}`}
          >
            <Table bare className="min-w-[980px]">
              <Thead>
                <tr>
                  {(
                    [
                      ['#', 'w-20'],
                      ['When (IST)', 'w-40'],
                      ['Who', ''],
                      ['Action', ''],
                      ['Target', ''],
                      ['From', ''],
                      ['Result', ''],
                      ['', 'w-10'],
                    ] as const
                  ).map(([label, width], i) => (
                    <Th
                      key={i}
                      className={`sticky top-0 z-10 bg-card shadow-[inset_0_-1px_0_hsl(var(--border))] ${width}`}
                    >
                      {label || <span className="sr-only">Detail</span>}
                    </Th>
                  ))}
                </tr>
              </Thead>
              <tbody>
                {entries.map((entry) => (
                  <Tr
                    key={entry.id}
                    onClick={() => setSelected(entry)}
                    className={`cursor-pointer ${selected?.id === entry.id ? 'bg-secondary/50' : ''}`}
                  >
                    <Td className="font-mono text-[11px] text-faint">{entry.id}</Td>
                    <Td className="whitespace-nowrap">
                      <span className="text-[11px] text-faint">{IST_DAY.format(new Date(entry.ts))}</span>{' '}
                      <span className="font-mono text-xs">{IST_TIME.format(new Date(entry.ts))}</span>
                    </Td>
                    <Td className="whitespace-nowrap">
                      <span className="font-mono text-xs text-foreground">
                        {entry.username ?? '—'}
                      </span>
                      {entry.role && (
                        <span className="ml-1.5 text-[11px] text-faint">{entry.role}</span>
                      )}
                    </Td>
                    <Td className="whitespace-nowrap">
                      <ActionName action={entry.action} />
                    </Td>
                    <Td className="max-w-[18rem]">
                      <span className="block truncate text-xs" title={entry.resource_id ?? undefined}>
                        <span className="text-faint">{entry.resource_type ?? '—'}</span>
                        {entry.resource_id && (
                          <span className="ml-1.5 font-mono text-muted-foreground">
                            {entry.resource_id}
                          </span>
                        )}
                      </span>
                    </Td>
                    <Td className="whitespace-nowrap font-mono text-[11px] text-muted-foreground">
                      {entry.ip ?? '—'}
                    </Td>
                    <Td className="whitespace-nowrap text-xs">
                      <ResultMark result={entry.result} />
                    </Td>
                    {/* The row opens on click; this is the same thing for a
                        keyboard, which cannot click a table row. */}
                    <Td className="text-right">
                      <button
                        type="button"
                        onClick={(event) => {
                          event.stopPropagation()
                          setSelected(entry)
                        }}
                        aria-label={`Open entry ${entry.id}`}
                        className="rounded p-0.5 text-faint transition hover:bg-secondary hover:text-foreground"
                      >
                        <Icon name="chevronRight" size={14} />
                      </button>
                    </Td>
                  </Tr>
                ))}
              </tbody>
            </Table>
          </div>
        )}

        {loadedOnce && total > 0 && (
          <div className="flex shrink-0 items-center gap-3 border-t border-border px-4 py-2 text-xs text-muted-foreground">
            <span className="font-mono">
              {first.toLocaleString('en-IN')}–{last.toLocaleString('en-IN')}
            </span>
            <span>of {total.toLocaleString('en-IN')}</span>
            <span className="ml-auto font-mono text-faint">
              page {page} / {pages}
            </span>
            <Button
              variant="outline"
              size="sm"
              disabled={offset === 0 || loading}
              onClick={() => setOffset((o) => Math.max(0, o - PAGE_SIZE))}
            >
              <Icon name="chevronLeft" size={14} />
              Newer
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={last >= total || loading}
              onClick={() => setOffset((o) => o + PAGE_SIZE)}
            >
              Older
              <Icon name="chevronRight" size={14} />
            </Button>
          </div>
        )}
      </div>

      <Drawer
        open={selected !== null}
        title={selected ? `Entry ${selected.id}` : ''}
        description={selected ? <span className="font-mono">{selected.action}</span> : undefined}
        onClose={() => setSelected(null)}
        width="w-[min(34rem,94vw)]"
      >
        {selected && <EntryDetail entry={selected} onFilter={filterTo} />}
      </Drawer>
    </div>
  )
}

function EntryDetail({
  entry,
  onFilter,
}: {
  entry: AuditEntry
  onFilter: (change: { action?: string; username?: string }) => void
}) {
  const when = new Date(entry.ts)
  return (
    <div className="space-y-5">
      <dl className="divide-y divide-border/70 rounded-md border border-border text-[13px]">
        <Fact label="When">
          <span className="font-mono text-xs">
            {api.formatIST(entry.ts)} IST
            <span className="block text-[11px] text-faint">{when.toISOString()}</span>
          </span>
        </Fact>
        <Fact label="Who">
          <span className="font-mono text-xs">{entry.username ?? '—'}</span>
          {entry.role && <span className="ml-1.5 text-xs text-faint">{entry.role}</span>}
          {entry.user_id && (
            <span className="block break-all font-mono text-[11px] text-faint">
              {entry.user_id}
            </span>
          )}
        </Fact>
        <Fact label="Action">
          <ActionName action={entry.action} />
        </Fact>
        <Fact label="Target">
          <span className="text-xs text-faint">{entry.resource_type ?? '—'}</span>
          {entry.resource_id && (
            <span className="block break-all font-mono text-xs">{entry.resource_id}</span>
          )}
        </Fact>
        <Fact label="From">
          <span className="font-mono text-xs">{entry.ip ?? '—'}</span>
        </Fact>
        <Fact label="Result">
          <span className="text-xs">
            <ResultMark result={entry.result} />
          </span>
        </Fact>
      </dl>

      <section>
        <p className="eyebrow">Parameters</p>
        {entry.params && Object.keys(entry.params).length > 0 ? (
          <pre className="mt-2 max-h-[45vh] overflow-auto whitespace-pre-wrap break-all rounded-md border border-border bg-background px-3 py-2.5 font-mono text-[11px] leading-relaxed text-muted-foreground">
            {JSON.stringify(entry.params, null, 2)}
          </pre>
        ) : (
          <p className="mt-2 text-xs text-faint">No parameters were recorded with this entry.</p>
        )}
      </section>

      <div className="flex flex-wrap gap-2 border-t border-border pt-4">
        {entry.username && (
          <Button variant="outline" size="sm" onClick={() => onFilter({ username: entry.username ?? '' })}>
            <Icon name="filter" size={14} />
            Everything by {entry.username}
          </Button>
        )}
        <Button variant="outline" size="sm" onClick={() => onFilter({ action: entry.action })}>
          <Icon name="filter" size={14} />
          Every {entry.action}
        </Button>
      </div>
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
