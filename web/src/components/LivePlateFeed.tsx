/**
 * Plates as they are read, newest first.
 *
 * This is the authoritative view of what the AI found — unlike the overlay,
 * nothing here depends on lining up with a moving picture. Each row carries
 * the evidence behind the reading: the crop it was read from, how many frames
 * were involved, whether they agreed, and whether the grammar had to repair
 * the string. An operator acting on a plate should be able to see how much to
 * trust it without leaving the screen.
 *
 * A plate that raised a watchlist alarm is drawn as one — the red ring on the
 * plate, the row tinted, and the reason in words — because that row is the
 * one on this screen that needs a person.
 *
 * `PlateReadRow` is the row on its own, so a read that came from the database
 * rather than the socket (what a camera read before its page was opened) is
 * drawn exactly like one that has just arrived.
 */

import type { ReactNode } from 'react'
import { Link } from 'react-router-dom'

import PlateCrop from '@/components/PlateCrop'
import { Badge, PlateChip, SeverityGlyph } from '@/components/ui'
import { liveTrackKey } from '@/lib/events'
import type { Detection, LiveVehicleEvent, Priority } from '@/lib/types'

/** Why a plate is flagged: the watchlist alarm it raised. */
export interface WatchHit {
  /** The plate as listed. Differs from the read on a near match. */
  listed: string | null
  /** The watchlist category ("stolen"), when the alarm carried it. */
  category: string | null
  /** False for a near match — a read one character from a listed plate. */
  exact: boolean
  priority: Priority
}

/** One read, from whichever source — a live event or a stored detection. */
export interface PlateRead {
  /** Stable for as long as the read describes one vehicle. */
  key: string
  plate: string
  confidence: number | null
  /** When the vehicle was seen, ISO UTC. Printed in IST. */
  at: string
  vehicleType: string | null
  cameraCode: string | null
  cropUrl: string | null
  frames: number | null
  agreement: number | null
  grammarValid: boolean | null
  ambiguous: boolean
  correctedFrom: string | null
  /** Live reads only: still in view, or settled and written to the database. */
  state: 'in-view' | 'settled' | null
}

/** A live vehicle event as a read. */
export function readFromEvent(event: LiveVehicleEvent): PlateRead {
  const plate = event.plate
  const evidence = plate.evidence ?? {}
  return {
    key: liveTrackKey(event),
    plate: plate.text,
    confidence: typeof plate.confidence === 'number' ? plate.confidence : null,
    // The capture instant, not the emit time: the reading is about the frame,
    // and the pipeline's own latency is no part of when the car was there.
    at: event.captured_at ?? event.event_time,
    vehicleType: event.vehicle?.type ?? null,
    cameraCode: event.source?.camera_id ?? null,
    cropUrl: event.evidence?.plate_crop_url ?? null,
    frames: typeof evidence.reads_total === 'number' ? evidence.reads_total : null,
    agreement: typeof evidence.agreement === 'number' ? evidence.agreement : null,
    grammarValid: typeof plate.grammar_valid === 'boolean' ? plate.grammar_valid : null,
    ambiguous: Boolean(plate.ambiguous),
    correctedFrom: plate.corrected_from ?? null,
    // Settled vs still-in-view matters: a completed read is the one that was
    // written to the database and matched against the watchlist.
    state: event.event === 'vehicle.completed' ? 'settled' : 'in-view',
  }
}

/** A stored detection as a read. Null when it carries no plate at all. */
export function readFromDetection(row: Detection): PlateRead | null {
  if (!row.plate) return null
  return {
    key: row.id,
    plate: row.plate,
    confidence: row.plate_confidence,
    at: row.ts,
    vehicleType: row.vehicle_type,
    cameraCode: row.camera_code,
    cropUrl: row.crop_url,
    frames: row.reads_total,
    agreement: row.agreement,
    grammarValid: row.grammar_valid,
    ambiguous: row.ambiguous,
    correctedFrom: row.corrected_from,
    state: null,
  }
}

/** `HH:MM:SS` in IST. Storage and transport stay UTC. */
export function timeIST(iso: string): string {
  const at = new Date(iso)
  if (Number.isNaN(at.getTime())) return '—'
  return at.toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hourCycle: 'h23' })
}

/** What the watch hit says, in words — never just a colour. */
function watchSentence(hit: WatchHit): string {
  if (!hit.exact) {
    return hit.listed
      ? `Near match to watched ${hit.listed} — verify`
      : 'Near match to a watched plate — verify'
  }
  return hit.category ? `On the watchlist · ${hit.category}` : 'On the watchlist'
}

/** The pipeline's working, for whoever hovers: frames, agreement, repair. */
function evidenceTitle(read: PlateRead): string | undefined {
  const parts: string[] = []
  if (read.confidence !== null) parts.push(`read ${read.confidence.toFixed(2)}`)
  if (read.frames !== null) {
    parts.push(`${read.frames} frame${read.frames === 1 ? '' : 's'}`)
    if (read.agreement !== null && read.frames > 1) parts.push(`${Math.round(read.agreement * 100)}% agree`)
  }
  if (read.state === 'settled') parts.push('settled')
  if (read.grammarValid === false) parts.push('not a valid plate format')
  if (read.correctedFrom) parts.push(`repaired from ${read.correctedFrom}`)
  return parts.length ? parts.join(' · ') : undefined
}

export function PlateReadRow({
  read,
  watch = null,
  showCamera = false,
  href = null,
}: {
  read: PlateRead
  watch?: WatchHit | null
  /** Show which camera the read came from. Off for a single-camera view. */
  showCamera?: boolean
  /** Where the plate leads — its journey — when the viewer may go there. */
  href?: string | null
}) {
  // A read the pipeline was not settled on must not look as certain as one it
  // was: dashed and greyed, as the plate chip draws a partial read.
  const unsettled = read.ambiguous || read.grammarValid === false

  const body: ReactNode = (
    <>
      <div className="flex min-w-0 items-center gap-2">
        <PlateChip plate={read.plate} size="sm" watched={watch !== null} partial={unsettled} />
        <PlateCrop url={read.cropUrl} plate={read.plate} height={24} className="min-w-0 max-w-[92px]" />
        <span className="ml-auto shrink-0 font-mono text-[11px] text-muted-foreground">
          {showCamera && read.cameraCode && `${read.cameraCode} · `}
          {timeIST(read.at)}
        </span>
      </div>

      {/* One quiet line: what it was, and how sure. The frame counts, the
          agreement and the grammar repair stay on the record (and in the
          chip's title) — a constable needs "car · 93%", not the pipeline's
          working. An uncertain read is drawn dashed and says so in a word. */}
      <div
        className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-faint"
        title={evidenceTitle(read)}
      >
        <span className="text-muted-foreground">{read.vehicleType ?? 'vehicle'}</span>
        {read.confidence !== null && (
          <span className="font-mono">{Math.round(read.confidence * 100)}%</span>
        )}
        {read.state === 'in-view' && <span className="text-primary">in view</span>}
        {unsettled && <Badge>{read.ambiguous ? 'ambiguous' : 'unsure'}</Badge>}
      </div>

      {watch && (
        <p className="mt-1.5 flex items-center gap-1.5 text-xs font-medium text-priority-critical">
          <SeverityGlyph priority={watch.priority} />
          {watchSentence(watch)}
        </p>
      )}
    </>
  )

  const shell = `block rounded-lg border px-2.5 py-2 transition ${
    watch
      ? 'border-priority-critical/45 bg-priority-critical/[0.07]'
      : 'border-border bg-card'
  }`

  return (
    <li>
      {href ? (
        <Link
          to={href}
          title="Every sighting of this plate, and the journey between them"
          className={`${shell} ${watch ? 'hover:border-priority-critical/70' : 'hover:border-input hover:bg-secondary/40'}`}
        >
          {body}
        </Link>
      ) : (
        <div className={shell}>{body}</div>
      )}
    </li>
  )
}

interface Props {
  events: LiveVehicleEvent[]
  /** Show which camera each read came from. Off for a single-camera view. */
  showCamera?: boolean
  emptyMessage?: string
  /** Plates, as stored, that have raised a watchlist alarm, and why. */
  watched?: ReadonlyMap<string, WatchHit>
  /** Where a plate leads, or null where the viewer may not follow it. */
  plateHref?: (plate: string) => string | null
}

export default function LivePlateFeed({
  events,
  showCamera = false,
  emptyMessage = 'No plates read yet.',
  watched,
  plateHref,
}: Props) {
  // `vehicle.observed` repeats for a vehicle still in view. Collapse to the
  // latest reading per vehicle, so the list is one row per car rather than one
  // per event the car produced.
  //
  // Keyed on the track, not on `vehicle_id`: the worker mints a fresh
  // `vehicle_id` per event, so the old key collapsed nothing at all and the
  // feed listed the same car once for every time it was re-read.
  const latest = new Map<string, LiveVehicleEvent>()
  for (const event of events) {
    const key = liveTrackKey(event)
    if (!latest.has(key)) latest.set(key, event)
  }
  const rows = [...latest.values()].map(readFromEvent)

  if (rows.length === 0) {
    return (
      <div className="flex min-h-28 items-center justify-center rounded-lg border border-dashed border-border px-6 py-8 text-center">
        <p className="text-xs text-muted-foreground">{emptyMessage}</p>
      </div>
    )
  }

  return (
    <ul className="space-y-1.5">
      {rows.map((read) => (
        <PlateReadRow
          key={read.key}
          read={read}
          watch={watched?.get(read.plate) ?? null}
          showCamera={showCamera}
          href={plateHref?.(read.plate) ?? null}
        />
      ))}
    </ul>
  )
}
