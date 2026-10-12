/**
 * Pursuit, on the Investigate screen: the cameras a vehicle can reach next,
 * kept under analysis while the operator follows it.
 *
 * Before a pursuit starts the panel shows the prediction alone — every camera
 * ranked, with an arrival window and why, and which it *would* pin — because
 * a pin opens a camera for analysis, and on the organisers' grid that spends
 * watch time: it happens only when someone presses Start. Once running, it
 * shows what is pinned, what was let go and when its stream closes, the reads
 * arriving live, and — in words — when the grid looks like it is refusing us,
 * including that this is inferred: the workers' login state is not visible to
 * the platform.
 */

import { useCallback, useEffect, useRef, useState } from 'react'

import { useToast } from '@/components/Toast'
import { Badge, Button, Icon, InfoHint, PlateChip, SegmentedControl, Spinner } from '@/components/ui'
import * as api from '@/lib/api'
import {
  ago,
  announcePursuitChange,
  etaText,
  istHM,
  PANEL_POLL_MS,
  PIN_TEXT,
  remaining,
  WINDOW_TEXT,
} from '@/lib/pursuit'
import type { Pursuit, PursuitPrediction } from '@/lib/types'

type Mode = 'loading' | 'preview' | 'active' | 'ended' | 'error'

const PIN_TONE: Partial<Record<PursuitPrediction['pin_state'], 'primary' | 'warning' | 'neutral'>> = {
  pinned: 'primary',
  would_pin: 'primary',
  waiting: 'warning',
  held: 'warning',
}

/** How many of the ranked cameras the panel lists. */
const SHOWN = 6

export default function PursuitPanel({
  plate,
  canSteer,
  onClose,
  onConfirmedRead,
  onPredictions,
}: {
  plate: string
  /** Holds `stream.view` and `search.execute`: may start, renew and stop. */
  canSteer: boolean
  onClose: () => void
  /** A read of the plate itself arrived: the journey on screen is out of date. */
  onConfirmedRead: () => void
  /** What the map should mark as the cameras it can reach next. */
  onPredictions?: (pursuit: Pursuit | null) => void
}) {
  const toast = useToast()
  const [mode, setMode] = useState<Mode>('loading')
  const [pursuit, setPursuit] = useState<Pursuit | null>(null)
  const [pins, setPins] = useState(2)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const confirmedSeen = useRef<number | null>(null)
  const onReadRef = useRef(onConfirmedRead)
  onReadRef.current = onConfirmedRead
  const onPredictionsRef = useRef(onPredictions)
  onPredictionsRef.current = onPredictions

  const show = useCallback((next: Pursuit | null, nextMode: Mode) => {
    setPursuit(next)
    setMode(nextMode)
    onPredictionsRef.current?.(next)
    if (next && nextMode === 'active') {
      const confirmed = next.sightings.filter((s) => s.kind === 'confirmed').length
      if (confirmedSeen.current !== null && confirmed > confirmedSeen.current) onReadRef.current()
      confirmedSeen.current = confirmed
    }
  }, [])

  const preview = useCallback(
    async (count?: number) => {
      try {
        show(await api.predictPursuit(plate, count), 'preview')
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err))
        setMode('error')
      }
    },
    [plate, show],
  )

  // Running already? The list carries no sightings, so asking it is not a
  // plate search; the detail is fetched (and audited) only if there is one.
  useEffect(() => {
    let cancelled = false
    confirmedSeen.current = null
    setMode('loading')
    void (async () => {
      try {
        const { pursuits } = await api.listPursuits()
        if (cancelled) return
        if (pursuits.some((p) => p.plate === plate)) {
          const detail = await api.getPursuit(plate)
          if (!cancelled) show(detail, 'active')
        } else {
          await preview()
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : String(err))
          setMode('error')
        }
      }
    })()
    return () => {
      cancelled = true
      onPredictionsRef.current?.(null)
    }
  }, [plate, preview, show])

  // While running, follow it: new reads, pins changing, the clock.
  useEffect(() => {
    if (mode !== 'active') return
    const timer = window.setInterval(() => {
      api
        .getPursuit(plate)
        .then((detail) => show(detail, 'active'))
        .catch((err: unknown) => {
          if (err instanceof api.ApiError && err.status === 404) {
            show(null, 'ended')
            announcePursuitChange()
          }
        })
    }, PANEL_POLL_MS)
    return () => window.clearInterval(timer)
  }, [mode, plate, show])

  async function act(run: () => Promise<void>) {
    setBusy(true)
    try {
      await run()
      announcePursuitChange()
    } catch (err) {
      toast.error(err)
    } finally {
      setBusy(false)
    }
  }

  const start = () =>
    act(async () => {
      show(await api.startPursuit(plate, pins), 'active')
      toast.success(`Pursuing ${plate}`)
    })
  const renew = () => act(async () => show(await api.renewPursuit(plate), 'active'))
  const stop = () =>
    act(async () => {
      const result = await api.stopPursuit(plate)
      show(null, 'ended')
      toast.success(
        result.released.length
          ? `Stopped. Released ${result.released.join(', ')}.`
          : 'Stopped. Nothing was pinned.',
      )
    })

  const capacity = pursuit?.policy.focus_capacity ?? 3
  const active = mode === 'active' && pursuit !== null

  return (
    <section
      aria-label="Pursuit"
      className={`rounded-lg border px-3 py-3 ${active ? 'border-primary/50 bg-primary/[0.04]' : 'border-border bg-card/60'}`}
    >
      <header className="flex items-center gap-2">
        <Icon name="live" size={15} className={active ? 'text-primary' : 'text-faint'} />
        <h2 className="text-[13px] font-semibold">Pursuit</h2>
        {active && pursuit && (
          <span className="flex items-center gap-1.5 rounded-full border border-primary/40 px-2 py-px font-mono text-[10px] text-primary">
            <span className="h-1.5 w-1.5 animate-pulse-alert rounded-full bg-primary" />
            {remaining(pursuit.expires_at)}
          </span>
        )}
        <span className="ml-auto flex items-center gap-1">
          <InfoHint label="How pursuit decides" align="right">
            From the last confirmed read, every camera with a known position is given an arrival
            window: straight-line distance over a speed band measured from observed journeys, or a
            stated default band where too few exist. Cameras the vehicle can reach in the next 15
            minutes are pinned, nearer first — the workers then analyse exactly those. At most{' '}
            {pursuit?.pins_wanted ?? pins} streams, counting released ones the workers keep open 5
            minutes; a pin is held at least 3 minutes; a pursuit ends 15 minutes after it starts
            unless renewed. Start, renew and stop are recorded in the audit trail.
          </InfoHint>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close the pursuit panel"
            title={active ? 'Close the panel — the pursuit keeps running' : 'Close'}
            className="rounded p-0.5 text-faint transition hover:text-foreground"
          >
            <Icon name="close" size={14} />
          </button>
        </span>
      </header>

      {mode === 'loading' && (
        <p className="mt-3 flex items-center gap-2 text-xs text-muted-foreground">
          <Spinner className="h-3.5 w-3.5" />
          Ranking the cameras it can reach next…
        </p>
      )}

      {mode === 'error' && <p className="mt-3 text-xs text-priority-high">{error}</p>}

      {mode === 'ended' && (
        <div className="mt-3 space-y-2 text-xs text-muted-foreground">
          <p>The pursuit has ended — stopped, or not renewed. Its pins lapse within a minute.</p>
          <Button size="sm" variant="outline" onClick={() => void preview()}>
            Show the prediction again
          </Button>
        </div>
      )}

      {pursuit && (mode === 'preview' || mode === 'active') && (
        <div className="mt-2.5 space-y-3">
          <LastSeen pursuit={pursuit} />

          {pursuit.notes.map((note) => (
            <p key={note} className="rounded-md border border-priority-high/30 bg-priority-high/[0.06] px-2.5 py-1.5 text-[11px] leading-snug text-priority-high">
              {note}
            </p>
          ))}

          <GridNote pursuit={pursuit} />

          {active ? (
            <Pins pursuit={pursuit} />
          ) : (
            <WouldPin pursuit={pursuit} />
          )}

          <Predictions pursuit={pursuit} />

          {active && <Sightings pursuit={pursuit} />}

          {active && pursuit.events.length > 0 && (
            <details>
              <summary className="cursor-pointer text-[11px] text-faint">What it has done</summary>
              <ul className="mt-1.5 space-y-0.5">
                {pursuit.events.map((event) => (
                  <li key={`${event.at}-${event.text}`} className="text-[11px] leading-snug text-muted-foreground">
                    <span className="font-mono text-faint">{istHM(event.at)}</span> {event.text}
                  </li>
                ))}
              </ul>
            </details>
          )}

          <p className="text-[10.5px] leading-snug text-faint">
            Speeds: {pursuit.basis.note}. Distances are straight lines, so arrival windows are
            estimates. {pursuit.excluded_unplaced > 0 && `${pursuit.excluded_unplaced} cameras with no known position are never ranked.`}
          </p>

          {canSteer ? (
            active ? (
              <div className="flex flex-wrap gap-2">
                <Button size="sm" variant="outline" disabled={busy} onClick={() => void renew()}>
                  <Icon name="refresh" size={12} />
                  Renew 15 min
                </Button>
                <Button size="sm" variant="destructive" disabled={busy} onClick={() => void stop()}>
                  Stop pursuit
                </Button>
              </div>
            ) : (
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-[11px] text-muted-foreground">Pin up to</span>
                <SegmentedControl
                  value={String(pins)}
                  onChange={(value) => {
                    setPins(Number(value))
                    void preview(Number(value))
                  }}
                  options={Array.from({ length: Math.max(1, capacity) }, (_, i) => ({
                    value: String(i + 1),
                    label: String(i + 1),
                  }))}
                />
                <Button size="sm" disabled={busy} onClick={() => void start()} className="ml-auto">
                  <Icon name="live" size={12} />
                  Start pursuit
                </Button>
              </div>
            )
          ) : (
            <p className="text-[11px] text-faint">
              Starting a pursuit opens cameras for analysis, which needs the right to watch live
              video (stream.view).
            </p>
          )}
        </div>
      )}
    </section>
  )
}

function LastSeen({ pursuit }: { pursuit: Pursuit }) {
  const anchor = pursuit.anchor
  if (!anchor) {
    return (
      <p className="text-xs leading-snug text-muted-foreground">
        Not read at a camera with a known position in the last 24 h — nothing to predict from yet.
        {pursuit.status === 'active' && ' Watching every analysed camera for it.'}
      </p>
    )
  }
  return (
    <div className="flex items-center gap-2.5">
      <div className="min-w-0 flex-1">
        <p className="eyebrow">Last seen</p>
        <p className="mt-0.5 font-mono text-xs text-foreground">
          {api.formatIST(anchor.seen_at, false)} IST · {anchor.camera_code}
        </p>
        <p className="truncate text-[11px] text-muted-foreground" title={anchor.camera_name}>
          {anchor.camera_name} · {ago(anchor.seen_at)}
        </p>
      </div>
      <PlateChip plate={pursuit.plate} size="xs" />
    </div>
  )
}

function GridNote({ pursuit }: { pursuit: Pursuit }) {
  const grid = pursuit.grid
  if (!grid.held) {
    return (
      <p className="flex items-start gap-1.5 text-[11px] leading-snug text-muted-foreground">
        <Icon name="check" size={12} className="mt-px text-primary" />
        <span>
          Grid answering
          {grid.last_grid_detection ? ` — last grid detection ${ago(grid.last_grid_detection)}` : ''}.
          <InfoHint label="What the platform can see of the grid" align="right">
            {grid.visibility}
          </InfoHint>
        </span>
      </p>
    )
  }
  return (
    <div className="rounded-md border border-priority-high/40 bg-priority-high/[0.07] px-2.5 py-2 text-[11px] leading-snug text-priority-high">
      <p className="flex items-center gap-1.5 font-medium">
        <Icon name="alert" size={12} />
        Grid cameras are not being pinned
        <InfoHint label="What the platform can see of the grid" align="right">
          {grid.visibility}
        </InfoHint>
      </p>
      <p className="mt-1 text-foreground/80">{grid.reason}</p>
      <p className="mt-1 text-faint">
        Inferred from detections — the workers' login state is not visible to the platform.
        {grid.hold_until && ` Held until ${istHM(grid.hold_until)} IST.`}
      </p>
    </div>
  )
}

function WouldPin({ pursuit }: { pursuit: Pursuit }) {
  const would = pursuit.would_pin ?? []
  return (
    <p className="text-xs leading-snug text-muted-foreground">
      {would.length > 0 ? (
        <>
          Starting would pin{' '}
          <span className="font-mono text-foreground">{would.join(', ')}</span> — the workers open
          and analyse them until the pursuit ends. Nothing is pinned until you start.
        </>
      ) : (
        <>Starting would pin no camera now — each camera below says why. It would still watch every analysed camera for the plate and advance when it is read.</>
      )}
    </p>
  )
}

function Pins({ pursuit }: { pursuit: Pursuit }) {
  return (
    <div>
      <p className="eyebrow">
        Pinned · {pursuit.pins.length} of {pursuit.pins_wanted}
      </p>
      {pursuit.pins.length === 0 ? (
        <p className="mt-1 text-[11px] text-faint">Nothing pinned now — each camera below says why.</p>
      ) : (
        <ul className="mt-1 space-y-0.5">
          {pursuit.pins.map((pin) => (
            <li key={pin.camera_code} className="flex items-center gap-2 font-mono text-[11px]">
              <Icon name="pin" size={12} className="text-primary" />
              <span className="text-foreground">{pin.camera_code}</span>
              <span className="text-faint">pinned {ago(pin.pinned_at)}</span>
              <span className="ml-auto text-faint">
                {pin.proven_at ? 'analysing — detections arriving' : pin.grid ? 'awaiting a detection' : ''}
              </span>
            </li>
          ))}
        </ul>
      )}
      {pursuit.released.length > 0 && (
        <ul className="mt-1 space-y-0.5">
          {pursuit.released.map((r) => (
            <li key={r.camera_code} className="text-[11px] text-faint">
              <span className="font-mono">{r.camera_code}</span> released {istHM(r.released_at)} — its
              stream stays open, unanalysed, until {istHM(r.closes_at)}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

function Predictions({ pursuit }: { pursuit: Pursuit }) {
  const shown = pursuit.predictions.slice(0, SHOWN)
  if (shown.length === 0) return null
  return (
    <div>
      <p className="eyebrow">Where it can be next</p>
      <ol className="mt-1.5 space-y-1">
        {shown.map((p) => (
          <li key={p.camera_code} className="rounded-md border border-border bg-background/40 px-2 py-1.5">
            <details>
              <summary className="flex cursor-pointer list-none items-center gap-2">
                <span className="w-4 shrink-0 font-mono text-[10px] text-faint">{p.rank}</span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-mono text-[11.5px] text-foreground">
                    {p.camera_code}
                    <span className="ml-1.5 font-sans text-muted-foreground">{p.camera_name}</span>
                  </span>
                  <span className="block font-mono text-[10.5px] text-faint">
                    {p.distance_km !== null ? `${p.approximate ? '~' : ''}${p.distance_km.toFixed(1)} km · ` : ''}
                    {etaText(p.eta_from, p.eta_to)} · {WINDOW_TEXT[p.window]}
                  </span>
                </span>
                <Badge tone={PIN_TONE[p.pin_state] ?? 'neutral'} title={p.pin_note}>
                  {PIN_TEXT[p.pin_state]}
                </Badge>
              </summary>
              <ul className="mt-1.5 space-y-0.5 pl-6">
                {p.reasons.map((reason) => (
                  <li key={reason} className="text-[11px] leading-snug text-muted-foreground">
                    {reason}
                  </li>
                ))}
                <li className="text-[11px] leading-snug text-foreground/80">{p.pin_note}</li>
              </ul>
            </details>
          </li>
        ))}
      </ol>
      {pursuit.predictions.length > SHOWN && (
        <p className="mt-1 text-[10.5px] text-faint">
          and {pursuit.predictions.length - SHOWN} more, ranked lower
        </p>
      )}
    </div>
  )
}

function Sightings({ pursuit }: { pursuit: Pursuit }) {
  return (
    <div>
      <p className="eyebrow">Reads since it started</p>
      {pursuit.sightings.length === 0 ? (
        <p className="mt-1 text-[11px] text-faint">
          None yet. A read of {pursuit.plate} on any analysed camera appears here and moves the
          pursuit on.
        </p>
      ) : (
        <ul className="mt-1 space-y-1">
          {pursuit.sightings.map((s) => (
            <li
              key={s.detection_id}
              className={`flex items-center gap-2 rounded-md px-2 py-1 text-[11px] ${
                s.kind === 'confirmed' ? 'bg-primary/[0.08]' : 'border border-dashed border-input'
              }`}
            >
              <PlateChip plate={s.plate} size="xs" candidate={s.kind === 'possible'} />
              <span className="min-w-0 flex-1">
                <span className="block font-mono text-foreground">
                  {api.formatIST(s.seen_at, false)} · {s.camera_code ?? 'unknown camera'}
                </span>
                <span className="block truncate text-faint" title={s.difference ?? undefined}>
                  {s.kind === 'confirmed'
                    ? s.advanced
                      ? 'read — the pursuit advanced from here'
                      : s.placed
                        ? 'read'
                        : 'read where the position is unknown'
                    : `possible: ${s.difference}`}
                </span>
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
