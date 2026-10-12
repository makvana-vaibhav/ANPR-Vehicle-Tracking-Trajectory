/**
 * Which reads a route's evidence crops come from.
 *
 * Each visit on a route names its clearest read (`best_detection_id`), and the
 * crop shown for the visit is that read's. A busy plate has hundreds of reads,
 * though, and the detections endpoint pages newest first, 200 at most: asking
 * for "this plate's reads" returned the latest 200 and missed the best read of
 * every visit but the last few. Asking only for reads at least as confident as
 * the weakest visit's best read leaves out the noise and keeps every one of
 * them — the Investigate screen worked this out first, and the printed report
 * now asks the same way.
 */

import type { VehicleRoute } from '@/lib/types'

/** The route rounds confidences to four decimals; the table does not. */
const ROUNDING_MARGIN = 0.001

/**
 * The lowest read confidence a request for a route's crops must admit, or
 * null when the route holds no reads to show a crop for.
 */
export function evidenceFloor(
  route: Pick<VehicleRoute, 'hops' | 'unplaced_sightings'>,
): number | null {
  const confidences = [
    ...route.hops.map((h) => h.plate_confidence),
    ...route.unplaced_sightings.map((s) => s.plate_confidence),
  ]
  if (confidences.length === 0) return null
  return Math.max(0, Math.min(...confidences) - ROUNDING_MARGIN)
}
