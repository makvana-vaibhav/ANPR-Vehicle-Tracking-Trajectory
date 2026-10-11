/**
 * The product mark: a trail curving up into the point it trails behind.
 *
 * A literal contrail — the same shape the product's own map draws when it
 * shows where a vehicle has been — so the mark and the product argue the same
 * point rather than being two unrelated decisions. The trail is drawn fainter
 * than the head, as the map draws it: older is quieter.
 *
 * Single colour, via `currentColor` — set the wrapper's text colour rather
 * than passing one in, so it inherits the one accent this product allows
 * itself rather than becoming a second place a colour is chosen.
 */
export function BrandMark({
  size = 18,
  className = '',
}: {
  /** Height in px; the mark is wider than it is tall. */
  size?: number
  className?: string
}) {
  return (
    <svg
      viewBox="0 0 26 18"
      width={(size * 26) / 18}
      height={size}
      fill="none"
      aria-hidden="true"
      focusable="false"
      className={`shrink-0 ${className}`}
    >
      <path
        d="M1 15C7 15 9 4 17 4"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        opacity="0.55"
      />
      <circle cx="21" cy="4" r="3" fill="currentColor" />
    </svg>
  )
}
