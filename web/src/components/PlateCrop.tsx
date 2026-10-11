/**
 * The plate crop behind a detection or an alert.
 *
 * Why this is a component rather than an `<img>`: a crop is allowed to be
 * missing, and it must be missing *quietly*.
 *
 * The worker returns a crop's object key synchronously and uploads the bytes on
 * a background thread, so for a second or so after a detection the signed URL
 * points at an object that does not exist yet. An upload can also fail
 * outright. Left to an ordinary `<img>`, both cases — and even the ordinary
 * gap before a good image finishes loading — render as the browser's own
 * broken-image icon next to its `alt` text sitting in the row, which reads as
 * "the system is broken" rather than "the photograph has not landed".
 *
 * So nothing is mounted into the page until the image has already loaded
 * successfully: an offscreen probe does the fetching, and only a load that
 * succeeds gets a visible `<img>` at all. Pending and failed look identical —
 * nothing here, or the caller's `fallback` — and the visible image never has a
 * chance to flash its alt text. A crop is evidence *about* a sighting, never
 * the sighting itself, and its absence must not undermine the alert it belongs
 * to.
 *
 * One more case the URL alone hides: the same photograph arrives under a new
 * URL every time a list is re-read, because a presigned link carries its own
 * signing time. Treating each as a new image blanked the crop on every refresh
 * of a live list. A link to the *same object* keeps the photograph on screen
 * while the new one is fetched; only a different object starts again from
 * nothing.
 */

import { useEffect, useState, type ReactNode } from 'react'

interface Props {
  url: string | null
  plate: string | null
  /** Rendered height in pixels. Plates are wide and short. */
  height?: number
  className?: string
  /**
   * Shown in place of the image while there is none to show — no crop, still
   * uploading, or failed. Nothing by default, which is what a table row wants;
   * a view that reserves room for the photograph passes a sentence saying why
   * the room is empty.
   */
  fallback?: ReactNode
}

/** The stored object a signed link points at — the link minus its signature. */
function objectOf(url: string): string {
  return url.split('?')[0] ?? url
}

export default function PlateCrop({
  url,
  plate,
  height = 34,
  className = '',
  fallback = null,
}: Props) {
  // The URL whose image is known to have loaded, and so is safe to show.
  const [shown, setShown] = useState<string | null>(null)

  useEffect(() => {
    if (!url) {
      setShown(null)
      return
    }
    // A new object starts back at nothing rather than keeping the last one on
    // screen — a stale crop from a different sighting is worse than a blank.
    // A re-signed link to the same object is the same photograph, so it stays.
    setShown((current) => (current !== null && objectOf(current) === objectOf(url) ? current : null))

    const probe = new Image()
    probe.onload = () => setShown(url)
    probe.src = url
    return () => {
      probe.onload = null
    }
  }, [url])

  if (!shown) return <>{fallback}</>

  return (
    <img
      // Already sitting in the browser's cache from the probe above, so this
      // paints immediately rather than fetching a second time.
      src={shown}
      alt={plate ? `Number plate crop for ${plate}` : 'Number plate crop'}
      height={height}
      style={{ height }}
      className={`w-auto max-w-full rounded-md border border-border bg-background object-contain ${className}`}
    />
  )
}
