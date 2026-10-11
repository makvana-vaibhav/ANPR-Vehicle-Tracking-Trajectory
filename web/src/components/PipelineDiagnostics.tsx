/**
 * Measured pipeline latency, so optimisation can be checked rather than claimed.
 *
 * ## Why this exists
 *
 * "The overlay feels delayed" is a symptom with at least four possible causes,
 * and they need completely different fixes:
 *
 *   * the worker is falling behind and reading old frames  → AI latency
 *   * events are slow reaching the browser                 → transport latency
 *   * the *picture* is behind, so a prompt box still looks late → video latency
 *   * the browser is dropping frames rendering it          → render latency
 *
 * Guessing between them wasted real time on this project: a codec mismatch
 * pushed video onto HLS's multi-second buffer and looked exactly like an AI
 * problem. Every number here is taken from a timestamp the pipeline already
 * carries — none is estimated, and where a figure cannot be measured it is
 * shown as `—` rather than filled in with something plausible.
 *
 * ## What each number means
 *
 * **AI** — `latency_ms` on the event: capture-to-event, measured by the worker
 * across decode, detection, tracking, plate detection, OCR and consensus. This
 * is the pipeline's own figure and the one to optimise. Sampled from the
 * live-boxes batches as well as from readings: a batch carries the same
 * capture-to-publish figure, and it arrives several times a second where a
 * reading may not arrive for a minute.
 *
 * **Transport** — event creation to arrival in this browser: Redis, the API's
 * consumer, the fan-out and the socket. Computed from `event_time` against
 * local receipt, so it includes any clock skew between container and host;
 * treated as indicative, not exact, and labelled as such.
 *
 * **Video** — how far behind the source the *picture* is, from whatever the
 * transport can be asked. HLS is stamped: MediaMTX writes
 * `EXT-X-PROGRAM-DATE-TIME` into the playlist, so the player can name the
 * wall-clock moment the displayed frame was captured at. WebRTC carries no such
 * tag but does report how long it has been holding frames and the round trip to
 * the gateway, which is the same quantity by another route. Either way it is
 * measured; where neither is available this prints `—` rather than the "few
 * hundred milliseconds" it would be fair to guess.
 *
 * **End-to-end** — AI + transport. The figure that decides whether a box can
 * land on the right vehicle.
 */

import { useEffect, useRef, useState } from 'react'

import type { LiveTrackBatchEvent, LiveVehicleEvent } from '@/lib/types'

interface Props {
  /** Newest-first, as the event stream delivers them. */
  events: LiveVehicleEvent[]
  /** Capture clock of the frame on screen, or null when unavailable. */
  videoClock?: (() => number | null) | null
  /** Which transport the player settled on, for context. */
  transport?: string | null
  /**
   * The newest live-boxes batch for the same camera. Each one that arrives is
   * a sample. Remount the panel (a `key`) when the camera changes, so one
   * camera's samples never describe another.
   */
  batch?: LiveTrackBatchEvent | null
}

/** Rolling window. Long enough to be stable, short enough to react. */
const SAMPLE_LIMIT = 40

/** One measured message: its capture-to-publish, and its trip here. */
interface Sample {
  aiMs: number | null
  hopMs: number | null
}

/** A hop outside this is clock skew between container and host, not a trip. */
function plausibleHop(created: number, arrived: number): number | null {
  if (!Number.isFinite(created)) return null
  const hop = arrived - created
  // Negative means the container clock is ahead of the host's. Report
  // nothing rather than a nonsense figure.
  return hop >= 0 && hop < 60_000 ? hop : null
}

export function percentile(values: number[], fraction: number): number | null {
  if (values.length === 0) return null
  const ordered = [...values].sort((a, b) => a - b)
  const index = Math.min(
    ordered.length - 1,
    Math.max(0, Math.round(fraction * (ordered.length - 1))),
  )
  return ordered[index] ?? null
}

function ms(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return '—'
  return `${Math.round(value)} ms`
}

export default function PipelineDiagnostics({
  events,
  videoClock,
  transport,
  batch = null,
}: Props) {
  // Arrival times are recorded per event key as they are seen, so transport
  // latency is measured rather than inferred from the render pass.
  const arrivalsRef = useRef(new Map<string, number>())
  // Batches are sampled as they arrive rather than buffered: only the newest
  // is ever handed over, so each one has to be measured on its way past.
  const batchSamplesRef = useRef<Sample[]>([])
  const [, setTick] = useState(0)

  // A slow repaint, so the video lag moves even while no reading arrives. The
  // figures are recomputed on every render rather than memoised on the
  // events: memoised, this repaint re-rendered the panel and recomputed
  // nothing, and the video lag sat frozen until the next reading. A few dozen
  // samples cost nothing to sort, and this panel must not itself cost latency.
  useEffect(() => {
    const timer = window.setInterval(() => setTick((t) => t + 1), 1_000)
    return () => window.clearInterval(timer)
  }, [])

  useEffect(() => {
    if (!batch) return
    const samples = batchSamplesRef.current
    samples.push({
      aiMs: typeof batch.latency_ms === 'number' ? batch.latency_ms : null,
      hopMs: plausibleHop(Date.parse(batch.event_time), Date.now()),
    })
    if (samples.length > SAMPLE_LIMIT) samples.splice(0, samples.length - SAMPLE_LIMIT)
  }, [batch])

  const arrivals = arrivalsRef.current
  const now = Date.now()

  const ai: number[] = []
  const transportMs: number[] = []

  for (const event of events.slice(0, SAMPLE_LIMIT)) {
    const key = `${event.event_time}:${event.vehicle?.vehicle_id ?? ''}`
    let arrived = arrivals.get(key)
    if (arrived === undefined) {
      arrived = now
      arrivals.set(key, arrived)
    }

    if (typeof event.latency_ms === 'number') ai.push(event.latency_ms)

    const hop = plausibleHop(Date.parse(event.event_time), arrived)
    if (hop !== null) transportMs.push(hop)
  }

  for (const sample of batchSamplesRef.current) {
    if (sample.aiMs !== null) ai.push(sample.aiMs)
    if (sample.hopMs !== null) transportMs.push(sample.hopMs)
  }

  // Bound the arrival map: it is keyed per event and would otherwise grow
  // for as long as the page is open.
  if (arrivals.size > SAMPLE_LIMIT * 8) {
    const live = new Set(events.map((e) => `${e.event_time}:${e.vehicle?.vehicle_id ?? ''}`))
    for (const key of arrivals.keys()) if (!live.has(key)) arrivals.delete(key)
  }

  const videoNow = videoClock?.() ?? null
  const aiP50 = percentile(ai, 0.5)
  const transportP50 = percentile(transportMs, 0.5)
  const stats = {
    samples: ai.length,
    aiP50,
    aiP90: percentile(ai, 0.9),
    transportP50,
    videoLag: videoNow === null ? null : now - videoNow,
    endToEnd: aiP50 !== null && transportP50 !== null ? aiP50 + transportP50 : null,
  }

  const figures: Array<{ label: string; hint: string; value: string }> = [
    { label: 'AI p50', hint: 'capture → event', value: ms(stats.aiP50) },
    { label: 'AI p90', hint: 'capture → event', value: ms(stats.aiP90) },
    { label: 'Transport', hint: 'event → browser', value: ms(stats.transportP50) },
    { label: 'Video', hint: 'behind source', value: ms(stats.videoLag) },
    { label: 'End-to-end', hint: 'AI + transport', value: ms(stats.endToEnd) },
  ]

  return (
    <section
      aria-label="Pipeline latency"
      className="rounded-lg border border-border bg-card px-3.5 py-3"
    >
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <h3 className="text-[13px] font-semibold">Pipeline latency</h3>
        <span className="font-mono text-[11px] text-faint">
          {transport ?? '—'} · {stats.samples} samples
        </span>
      </div>
      <dl className="mt-2.5 grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-3 xl:grid-cols-5">
        {figures.map((figure) => (
          <div key={figure.label} className="min-w-0">
            <dt className="text-[11px] font-medium uppercase tracking-[0.06em] text-muted-foreground">
              {figure.label}
              <span className="block text-[10px] font-normal normal-case tracking-normal text-faint">
                {figure.hint}
              </span>
            </dt>
            <dd className="mt-1 font-mono text-[15px] leading-none text-foreground">
              {figure.value}
            </dd>
          </div>
        ))}
      </dl>
      {stats.videoLag === null && (
        <p className="mt-3 text-xs leading-snug text-faint">
          Neither transport has reported a capture clock yet — HLS before its
          first playlist, or WebRTC before its first statistics sample. Not
          estimated in the meantime.
        </p>
      )}
    </section>
  )
}
