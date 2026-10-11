/**
 * Sightings at cameras whose position is not known.
 *
 * Real reads of the plate, so they are shown — a sighting that cannot be
 * placed must be visibly unplaced, not dropped — but never on the map and
 * never in a distance or a speed. Five of the organisers' grid cameras name
 * places the gazetteer could not find; one of them reads more plates than
 * any other, so a vehicle seen there is often seen nowhere else.
 */

import { SectionLabel, InfoHint } from '@/components/ui'
import * as api from '@/lib/api'
import type { UnplacedSighting } from '@/lib/types'

export default function UnplacedSightings({
  sightings,
  note,
}: {
  sightings: UnplacedSighting[]
  note: string
}) {
  return (
    <section>
      <SectionLabel>
        Seen where the camera&rsquo;s position is unknown
        <InfoHint>{note}</InfoHint>
      </SectionLabel>
      <ul className="mt-1.5 space-y-1.5">
        {sightings.map((sighting) => (
          <li
            key={sighting.detection_id}
            className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5 rounded-md border border-dashed border-border bg-card px-3 py-2"
          >
            <span className="font-mono text-xs font-semibold">{sighting.camera_code}</span>
            <span className="truncate text-[11px] text-muted-foreground">
              {sighting.camera_name}
            </span>
            <span className="text-[11px] text-muted-foreground">
              {api.formatIST(sighting.seen_at)}
            </span>
            <span className="text-[11px] text-muted-foreground">
              conf {sighting.plate_confidence.toFixed(2)}
            </span>
            <span className="ml-auto text-[11px] text-muted-foreground">not on the map</span>
          </li>
        ))}
      </ul>
    </section>
  )
}
