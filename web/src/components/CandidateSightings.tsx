/**
 * "Possibly the same vehicle": reads of a slightly different plate.
 *
 * The vehicle asked about is often in the database one or two characters off
 * — `8` for `B`, a character lost off a dirty plate. Each candidate here comes
 * with its reasons, in words: which characters differ and whether that is a
 * common misreading, how confidently it was read, whether it fits the
 * confirmed route in time and space, what kind of vehicle it was.
 *
 * Nothing here is part of the journey until an analyst says so. **Include**
 * puts it on the route as a dashed candidate leg, labelled as such on the
 * map, in the sightings, the CSV and the printed report; **Dismiss** puts it
 * away. Both are deliberate acts, recorded in the audit trail, and both can
 * be undone.
 *
 * A read inside a confirmed visit — the same pass, read two ways — is the
 * strongest sign of a misreading and adds nothing to where the vehicle went,
 * so those are folded away beneath the ones that would.
 */

import PlateCrop from '@/components/PlateCrop'
import { Badge, Button, Icon, InfoHint, PlateChip, Spinner } from '@/components/ui'
import * as api from '@/lib/api'
import type { CandidateReport, CandidateSighting } from '@/lib/types'
import type { Decisions } from '@/pages/vehicleSearchUrl'

export type Decision = 'include' | 'dismiss' | 'undo'

const STRENGTH: Record<CandidateSighting['strength'], { label: string; tone: 'primary' | 'neutral' | 'warning' }> = {
  strong: { label: 'Strong lead', tone: 'primary' },
  possible: { label: 'Possible', tone: 'neutral' },
  weak: { label: 'Weak', tone: 'warning' },
}

const TONE: Record<string, { icon: 'check' | 'alert' | 'info'; className: string }> = {
  for: { icon: 'check', className: 'text-primary' },
  against: { icon: 'alert', className: 'text-priority-high' },
  neutral: { icon: 'info', className: 'text-faint' },
}

const day = new Intl.DateTimeFormat('en-IN', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short' })

/** Whether a decision names this candidate — by any of its reads. */
export function decided(candidate: CandidateSighting, ids: string[]): boolean {
  return candidate.detection_ids.some((id) => ids.includes(id)) || ids.includes(candidate.detection_id)
}

export default function CandidateSightings({
  plate,
  report,
  loading,
  decisions,
  busy,
  onDecide,
  withDate,
}: {
  plate: string
  report: CandidateReport | null
  loading: boolean
  decisions: Decisions
  /** The candidate whose decision is being recorded. */
  busy: string | null
  onDecide: (candidate: CandidateSighting, decision: Decision) => void
  withDate: boolean
}) {
  const all = report?.candidates ?? []
  const dismissed = all.filter((c) => decided(c, decisions.dismiss) && !decided(c, decisions.include))
  const open = all.filter((c) => !dismissed.includes(c))
  const journey = open.filter((c) => c.fit.status !== 'same_visit')
  const samePass = open.filter((c) => c.fit.status === 'same_visit')

  const card = (candidate: CandidateSighting) => (
    <CandidateCard
      key={candidate.detection_id}
      candidate={candidate}
      included={decided(candidate, decisions.include)}
      busy={busy === candidate.detection_id}
      withDate={withDate}
      onDecide={onDecide}
    />
  )

  return (
    <section aria-label="Possibly the same vehicle">
      <h3 className="eyebrow flex items-center gap-1 px-1.5">
        Possibly the same vehicle
        <InfoHint label="What a candidate is" align="right">
          Reads of a plate one or two characters from <span className="font-mono">{plate}</span>, or
          a few common misreadings away (0/O/D/Q, 1/I/L, 2/Z, 5/S, 6/G, 8/B, 4/A). None is part of
          the journey unless you include it, and an included one stays marked as a candidate on the
          map, in this list, the CSV and the printed report. Each include or dismiss is recorded in
          the audit trail.
        </InfoHint>
        {report && report.total > 0 && (
          <span className="ml-auto font-mono text-[10px] normal-case tracking-normal text-faint">
            {report.total}
          </span>
        )}
      </h3>

      {loading && !report ? (
        <p className="mt-2 flex items-center gap-2 px-1.5 text-xs text-muted-foreground">
          <Spinner className="h-3.5 w-3.5" />
          Looking for near reads…
        </p>
      ) : all.length === 0 ? (
        <p className="mt-2 px-1.5 text-xs leading-relaxed text-faint">
          No read within two characters of it in this window.
        </p>
      ) : (
        <>
          {journey.length > 0 ? (
            <ul className="mt-2 space-y-1.5">{journey.map(card)}</ul>
          ) : (
            <p className="mt-2 px-1.5 text-xs leading-relaxed text-faint">
              None would add a place or a time to the journey.
            </p>
          )}

          {samePass.length > 0 && (
            <details className="mt-2 px-1.5">
              <summary className="cursor-pointer text-[11px] leading-snug text-muted-foreground">
                {samePass.length} read{samePass.length === 1 ? '' : 's'} inside a confirmed visit —
                the same pass read differently, which adds nothing to where it went
              </summary>
              <ul className="mt-2 space-y-1.5">{samePass.map(card)}</ul>
            </details>
          )}

          {dismissed.length > 0 && (
            <details className="mt-2 px-1.5">
              <summary className="cursor-pointer text-[11px] text-faint">
                {dismissed.length} dismissed
              </summary>
              <ul className="mt-1.5 space-y-1">
                {dismissed.map((candidate) => (
                  <li key={candidate.detection_id} className="flex items-center gap-2 text-[11px]">
                    <PlateChip plate={candidate.read_as} size="xs" candidate />
                    <span className="min-w-0 flex-1 truncate font-mono text-faint">
                      {candidate.camera_code} · {api.formatIST(candidate.arrived_at, false)}
                    </span>
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={busy === candidate.detection_id}
                      onClick={() => onDecide(candidate, 'undo')}
                    >
                      Undo
                    </Button>
                  </li>
                ))}
              </ul>
            </details>
          )}

          {report && report.total > all.length && (
            <p className="mt-2 px-1.5 text-[11px] text-faint">
              The {all.length} likeliest of {report.total}.
            </p>
          )}
        </>
      )}
    </section>
  )
}

function CandidateCard({
  candidate,
  included,
  busy,
  withDate,
  onDecide,
}: {
  candidate: CandidateSighting
  included: boolean
  busy: boolean
  withDate: boolean
  onDecide: (candidate: CandidateSighting, decision: Decision) => void
}) {
  const strength = STRENGTH[candidate.strength]
  const reasons = candidate.reasons.filter((r) => r.factor !== 'plate')
  return (
    <li
      aria-label={`Candidate ${candidate.read_as} at ${candidate.camera_code}`}
      className={`grid grid-cols-[minmax(0,1fr)_auto] gap-x-2.5 rounded-lg border border-dashed px-2.5 py-2 ${
        included ? 'border-primary/60 bg-primary/[0.06]' : 'border-input bg-card/60'
      }`}
    >
      <div className="min-w-0">
        <p className="flex items-baseline gap-1.5 font-mono text-xs">
          <span className="text-foreground">{api.formatIST(candidate.arrived_at, false)}</span>
          {withDate && <span className="text-faint">{day.format(new Date(candidate.arrived_at))}</span>}
          <span className="text-faint">·</span>
          <span className="truncate font-medium text-foreground">{candidate.camera_code}</span>
        </p>
        <p className="truncate text-xs text-muted-foreground" title={candidate.camera_name}>
          {candidate.camera_name}
          {candidate.city ? ` · ${candidate.city}` : ''}
          {!candidate.placed && ' · position unknown'}
        </p>
        <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
          <PlateChip plate={candidate.read_as} size="xs" candidate title="As read — a candidate, not a confirmed read" />
          <Badge tone={strength.tone}>{strength.label}</Badge>
        </div>
        <p className="mt-1 text-[11px] leading-snug text-foreground">{candidate.difference}</p>
        <ul className="mt-1 space-y-0.5">
          {reasons.map((reason) => {
            const tone = TONE[reason.tone] ?? TONE.neutral!
            return (
              <li key={reason.factor} className={`flex gap-1.5 text-[11px] leading-snug ${tone.className}`}>
                <Icon name={tone.icon} size={12} className="mt-px shrink-0" />
                <span className={reason.tone === 'neutral' ? 'text-muted-foreground' : ''}>{reason.detail}</span>
              </li>
            )
          })}
        </ul>
        <div className="mt-2 flex flex-wrap items-center gap-1.5">
          {included ? (
            <>
              <span className="flex items-center gap-1 text-[11px] font-medium text-primary">
                <Icon name="route" size={12} />
                In the journey, as a candidate
              </span>
              <Button size="sm" variant="ghost" disabled={busy} onClick={() => onDecide(candidate, 'undo')}>
                Undo
              </Button>
            </>
          ) : (
            <>
              <Button size="sm" variant="outline" disabled={busy} onClick={() => onDecide(candidate, 'include')}>
                <Icon name="plus" size={12} />
                Include in journey
              </Button>
              <Button size="sm" variant="ghost" disabled={busy} onClick={() => onDecide(candidate, 'dismiss')}>
                Dismiss
              </Button>
            </>
          )}
          {busy && <Spinner className="h-3 w-3" />}
        </div>
      </div>
      <div className="flex items-start pt-0.5">
        <PlateCrop url={candidate.crop_url} plate={candidate.read_as} height={26} />
      </div>
    </li>
  )
}
