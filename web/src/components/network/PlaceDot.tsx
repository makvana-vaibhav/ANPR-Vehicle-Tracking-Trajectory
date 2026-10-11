/**
 * The map's camera marker, drawn small enough for a list row or a legend.
 *
 * The rail's lists and the legend must show exactly the mark the map shows —
 * a legend that draws "offline" differently from the map is a legend nobody
 * can use — so the glyphs live here, next to the constants the map's own
 * markers are built from.
 */

import { MARKER_FILL, type ClusterTone } from './mapClusters'

export function PlaceDot({
  tone = 'normal',
  size = 9,
  selected = false,
  className = '',
}: {
  tone?: ClusterTone
  /** Diameter of the dot itself; the rings sit outside it. */
  size?: number
  selected?: boolean
  className?: string
}) {
  const ring =
    tone === 'offline'
      ? 'border-status-offline'
      : tone === 'degraded'
        ? 'border-status-degraded'
        : null
  const box = size + 12
  return (
    <span
      aria-hidden="true"
      className={`relative inline-flex shrink-0 items-center justify-center ${className}`}
      style={{ width: box, height: box }}
    >
      {selected && (
        <span className="absolute inset-0 rounded-full border-[1.5px] border-primary" />
      )}
      {ring && (
        <span
          className={`absolute rounded-full border-[1.5px] ${ring}`}
          style={{ width: size + 7, height: size + 7 }}
        />
      )}
      <span
        className={`rounded-full ${tone === 'unknown' ? 'bg-faint' : ''}`}
        style={{
          width: size,
          height: size,
          background: tone === 'unknown' ? undefined : MARKER_FILL,
        }}
      />
    </span>
  )
}

/** A dashed amber ring: a camera whose position nobody knows. Never on the map. */
export function NoPositionGlyph({ className = '' }: { className?: string }) {
  return (
    <span
      aria-hidden="true"
      className={`inline-block h-3 w-3 shrink-0 rounded-full border-[1.5px] border-dashed border-priority-high ${className}`}
    />
  )
}
