/**
 * Sightings at cameras whose position is not known.
 *
 * Real reads of the plate, so they are shown — a sighting that cannot be
 * placed must be visibly unplaced, not dropped — but never on the map and
 * never in a distance or a speed. Five of the organisers' grid cameras name
 * places the gazetteer could not find; one of them reads more plates than
 * any other, so a vehicle seen there is often seen nowhere else.
 *
 * Drawn with the design language's mark for a camera whose position is
 * unknown — a dashed ring — and a dashed card, so it never reads as one of
 * the numbered visits on the route beside it.
 */

import PlateCrop from '@/components/PlateCrop'
import { InfoHint, PlateChip } from '@/components/ui'
import * as api from '@/lib/api'
import type { UnplacedSighting } from '@/lib/types'

/** The IST day, shown beside the time when a list crosses midnight. */
const day = new Intl.DateTimeFormat('en-IN', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short' })

export default function UnplacedSightings({
  sightings,
  crops = {},
  plate = null,
  withDate = true,
}: {
  sightings: UnplacedSighting[]
  /** Evidence crops by detection id, where they are known. */
  crops?: Record<string, string | null>
  plate?: string | null
  /** Show the day beside each time — off when every read is on one day. */
  withDate?: boolean
}) {
  return (
    <section>
      <h3 className="eyebrow flex items-center gap-1 px-1.5">
        Position unknown
        <InfoHint label="Why these are not on the map">
          Real reads of this plate, at cameras whose location has not been confirmed. They are
          listed here rather than drawn on the map, and no distance or speed is measured to them.
        </InfoHint>
      </h3>
      <ul className="mt-2 space-y-1.5">
        {sightings.map((sighting) => (
          <li
            key={sighting.detection_id}
            className="grid grid-cols-[22px_minmax(0,1fr)_auto] gap-x-2.5 rounded-lg border border-dashed border-input bg-card/60 px-2.5 py-2"
          >
            <span
              aria-hidden="true"
              className="mt-0.5 h-[18px] w-[18px] self-start justify-self-center rounded-full border-[1.5px] border-dashed border-priority-high"
            />
            <div className="min-w-0">
              <p className="flex items-baseline gap-1.5 font-mono text-xs">
                <span className="text-foreground">{api.formatIST(sighting.seen_at, false)}</span>
                <span className="text-faint">·</span>
                <span className="truncate font-medium text-foreground">{sighting.camera_code}</span>
              </p>
              <p className="truncate text-xs text-muted-foreground" title={sighting.camera_name}>
                {sighting.camera_name}
              </p>
              {/* An analyst's included candidate: a different plate was read. */}
              {sighting.read_as && (
                <p className="mt-1 flex flex-wrap items-center gap-1.5 text-[11px] text-primary">
                  <span className="font-medium uppercase tracking-[0.06em]">Candidate</span>
                  <span className="text-faint">read as</span>
                  <PlateChip plate={sighting.read_as} size="xs" candidate />
                </p>
              )}
              <p className="mt-0.5 flex flex-wrap gap-x-2.5 font-mono text-[11px] text-faint">
                <span>read {sighting.plate_confidence.toFixed(2)}</span>
                {withDate && <span>{day.format(new Date(sighting.seen_at))}</span>}
                <span>not on the map</span>
              </p>
            </div>
            <div className="flex items-start pt-0.5">
              <PlateCrop
                url={crops[sighting.detection_id] ?? null}
                plate={sighting.read_as ?? plate}
                height={26}
              />
            </div>
          </li>
        ))}
      </ul>
    </section>
  )
}
