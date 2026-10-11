/**
 * A vehicle's movement report, for printing or saving as PDF.
 *
 * The live test ends by handing over where a designated vehicle was seen, and
 * the submission asks for a report of detected plates with timestamps. This
 * is that document for one plate: every visit in order, the leg that led to
 * it, the clearest plate crop from each visit, and the notes a reader needs
 * to avoid over-reading it. The same rows download as CSV beside it.
 *
 * It is light whatever the app's theme — it is paper — so its colours are
 * the palette's own rather than the theme's tokens, chosen once here.
 *
 * Every number on it is the route endpoint's, unchanged. Opening it is a
 * plate search, and the audit log records it as one.
 */

import { useEffect, useMemo, useState } from 'react'
import { useNavigate, useParams, useSearchParams } from 'react-router-dom'

import { useToast } from '@/components/Toast'
import { Button, ErrorBanner, Spinner } from '@/components/ui'
import { useAuth } from '@/hooks/useAuth'
import * as api from '@/lib/api'
import type { RouteHop, VehicleRoute } from '@/lib/types'

/** What a flag means, in words a reader without the codebase will follow. */
const FLAG_WORDS: Record<string, string> = {
  implausible_speed: 'faster than any vehicle could have driven',
  impossible_simultaneous: 'seen at two places at the same instant',
  unobserved_gap: 'over an hour unobserved',
  heading_conflict: "against the camera's direction",
  co_located: 'cameras at the same spot',
  revisit: 'back at a camera already passed',
}

function istStamp(iso: string): string {
  return api.formatIST(iso)
}

function minutes(seconds: number): string {
  if (seconds < 90) return `${Math.round(seconds)} s`
  const m = Math.round(seconds / 60)
  return m < 120 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60} min`
}

/** GJ03AB1234 → GJ 03 AB 1234, when it has the Indian shape; as read otherwise. */
export function spacedPlate(plate: string): string {
  const match = /^([A-Z]{2})(\d{1,2})([A-Z]{0,3})(\d{1,4})$/.exec(plate)
  return match ? match.slice(1).filter(Boolean).join(' ') : plate
}

/** A plate drawn as a plate: white, black border, the blue IND strip. */
function PlateChip({ plate }: { plate: string }) {
  return (
    <span className="inline-flex items-stretch overflow-hidden rounded border-2 border-zinc-900 bg-white font-mono text-zinc-900">
      <span className="flex items-center bg-blue-700 px-1.5 text-[10px] font-bold text-white">
        IND
      </span>
      <span className="px-3 py-1 text-2xl font-bold tracking-[0.12em]">{spacedPlate(plate)}</span>
    </span>
  )
}

/**
 * The visits drawn to scale on a plain grid — no map tiles, so it prints the
 * same everywhere and needs no network. Straight legs, as the route claims;
 * a leg the correlator could not believe is red and dashed.
 */
function RouteSketch({ hops }: { hops: RouteHop[] }) {
  const W = 680
  const H = 280
  const PAD = 40
  if (hops.length === 0) return null

  const meanLat = hops.reduce((sum, h) => sum + h.lat, 0) / hops.length
  const kx = Math.cos((meanLat * Math.PI) / 180)
  const xs = hops.map((h) => h.lon * kx)
  const ys = hops.map((h) => h.lat)
  const spanX = Math.max(...xs) - Math.min(...xs)
  const spanY = Math.max(...ys) - Math.min(...ys)
  const scale = Math.min(
    spanX > 0 ? (W - 2 * PAD) / spanX : Infinity,
    spanY > 0 ? (H - 2 * PAD) / spanY : Infinity,
  )
  const s = Number.isFinite(scale) ? scale : 0
  const ox = (W - spanX * s) / 2
  const oy = (H - spanY * s) / 2
  const points = hops.map((h) => ({
    x: ox + (h.lon * kx - Math.min(...xs)) * s,
    y: oy + (Math.max(...ys) - h.lat) * s,
  }))
  // Cameras at the same spot share a point; their labels stack rather than
  // printing over one another.
  const stacked = new Map<string, number>()
  const labelOffset = points.map((p) => {
    const key = `${Math.round(p.x)}:${Math.round(p.y)}`
    const n = stacked.get(key) ?? 0
    stacked.set(key, n + 1)
    return n
  })

  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      className="h-auto w-full max-w-full rounded border border-zinc-300 bg-zinc-50"
      role="img"
      aria-label={`The ${hops.length} visits in order, joined by straight legs`}
    >
      {points.slice(1).map((p, i) => {
        const from = points[i]!
        const believed = hops[i + 1]!.plausible
        return (
          <line
            key={`leg-${i}`}
            x1={from.x}
            y1={from.y}
            x2={p.x}
            y2={p.y}
            stroke={believed ? '#0369a1' : '#dc2626'}
            strokeWidth={2}
            strokeDasharray={believed ? undefined : '6 4'}
          />
        )
      })}
      {points.map((p, i) => (
        <g key={`visit-${i}`}>
          <circle
            cx={p.x}
            cy={p.y}
            r={10}
            fill={hops[i]!.plausible ? '#0369a1' : '#dc2626'}
            stroke="#ffffff"
            strokeWidth={2}
          />
          <text x={p.x} y={p.y + 3.5} textAnchor="middle" fontSize={10} fontWeight={700} fill="#ffffff">
            {i + 1}
          </text>
          <text
            x={p.x + 14}
            y={p.y + 4 + labelOffset[i]! * 13}
            fontSize={11}
            fontFamily="ui-monospace, monospace"
            fill="#18181b"
          >
            {hops[i]!.camera_code}
          </text>
        </g>
      ))}
    </svg>
  )
}

export default function VehicleReport() {
  const { plate = '' } = useParams()
  const [params] = useSearchParams()
  const navigate = useNavigate()
  const toast = useToast()
  const { user } = useAuth()
  const since = params.get('since') ?? undefined
  const until = params.get('until') ?? undefined

  const [route, setRoute] = useState<VehicleRoute | null>(null)
  const [crops, setCrops] = useState<Record<string, string | null>>({})
  const [departments, setDepartments] = useState<Record<string, string>>({})
  const [error, setError] = useState<string | null>(null)
  const prepared = useMemo(() => new Date().toISOString(), [])

  useEffect(() => {
    let cancelled = false
    async function load() {
      try {
        const window = { since, until }
        const [document, detections, cameras] = await Promise.all([
          api.getVehicleRoute(plate, window),
          api.getDetections({ plate, since, until, limit: 200 }),
          api.getCameras({ limit: '500' }),
        ])
        if (cancelled) return
        setRoute(document)
        setCrops(Object.fromEntries(detections.items.map((d) => [d.id, d.crop_url ?? null])))
        setDepartments(
          Object.fromEntries(
            cameras.items.filter((c) => c.department_name).map((c) => [c.id, c.department_name!]),
          ),
        )
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err))
      }
    }
    void load()
    return () => {
      cancelled = true
    }
  }, [plate, since, until])

  // YYYYMMDD-HHMM in IST: en-CA orders the date parts year first.
  const reference = `${plate}-${new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  })
    .format(new Date(prepared))
    .replace(/[^0-9]/g, '')
    .replace(/^(\d{8})/, '$1-')}`
  const flagsPresent = useMemo(
    () => [...new Set((route?.hops ?? []).flatMap((h) => h.flags))],
    [route],
  )

  async function downloadCsv() {
    try {
      toast.success(`Downloaded ${await api.downloadRouteReport(plate, { since, until })}`)
    } catch (err) {
      toast.error(err)
    }
  }

  return (
    <div className="h-full overflow-y-auto bg-zinc-200 p-6 print:h-auto print:overflow-visible print:bg-white print:p-0">
      <style>{'@page { size: A4; margin: 12mm; }'}</style>

      <div className="mx-auto mb-4 flex max-w-[210mm] flex-wrap gap-2 print:hidden">
        <Button variant="outline" onClick={() => navigate(-1)}>
          ← Back
        </Button>
        <Button variant="outline" className="ml-auto" onClick={() => void downloadCsv()}>
          Download CSV
        </Button>
        <Button onClick={() => window.print()} disabled={!route}>
          Print or save as PDF
        </Button>
      </div>

      {error && (
        <div className="mx-auto max-w-[210mm]">
          <ErrorBanner>{error}</ErrorBanner>
        </div>
      )}

      {!route && !error && (
        <div className="flex justify-center py-20">
          <Spinner />
        </div>
      )}

      {route && (
        <article className="mx-auto max-w-[210mm] space-y-6 bg-white p-10 text-[13px] leading-relaxed text-zinc-900 shadow print:max-w-none print:p-0 print:shadow-none">
          <header className="space-y-3 border-b-2 border-zinc-900 pb-4">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-zinc-600">
                Contrail · Vehicle movement report
              </p>
              <p className="font-mono text-[11px] text-zinc-600">Ref {reference}</p>
            </div>
            <PlateChip plate={route.plate} />
            <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-0.5 text-[12px]">
              <dt className="text-zinc-600">Window</dt>
              <dd>
                {route.window.from ? istStamp(route.window.from) : 'the last 24 hours'} to{' '}
                {route.window.to ? istStamp(route.window.to) : `${istStamp(prepared)} (prepared)`} IST
              </dd>
              <dt className="text-zinc-600">Prepared</dt>
              <dd>
                {istStamp(prepared)} IST
                {user ? ` by ${user.full_name || user.username} (${user.role})` : ''}
              </dd>
            </dl>
          </header>

          <section>
            <h2 className="mb-2 text-[11px] font-semibold uppercase tracking-[0.14em] text-zinc-600">
              Summary
            </h2>
            {route.hop_count === 0 && route.unplaced_sightings.length === 0 ? (
              <p>This plate was not read in the window.</p>
            ) : (
              <dl className="grid grid-cols-2 gap-x-6 gap-y-1 sm:grid-cols-3 print:grid-cols-3">
                <Fact label="First seen" value={route.first_seen ? istStamp(route.first_seen) : '—'} />
                <Fact label="Last seen" value={route.last_seen ? istStamp(route.last_seen) : '—'} />
                <Fact
                  label="Cameras on the route"
                  value={`${route.camera_count} (${route.hop_count} visit${route.hop_count === 1 ? '' : 's'})`}
                />
                <Fact label="Straight-line distance" value={`at least ${route.distance_km} km`} />
                <Fact label="Elapsed" value={minutes(route.duration_s)} />
                <Fact
                  label="Average speed"
                  value={route.average_kmph !== null ? `at least ${route.average_kmph} km/h` : '—'}
                />
                <Fact label="Weakest read" value={route.confidence.toFixed(2)} />
                <Fact
                  label="Legs needing explanation"
                  value={route.is_plausible ? 'none' : String(route.flagged_hop_count)}
                />
                <Fact
                  label="Seen where position unknown"
                  value={String(route.unplaced_sightings.length)}
                />
              </dl>
            )}
          </section>

          {route.hops.length > 0 && (
            <section className="print:break-inside-avoid">
              <h2 className="mb-2 text-[11px] font-semibold uppercase tracking-[0.14em] text-zinc-600">
                Route, to scale
              </h2>
              <RouteSketch hops={route.hops} />
              <p className="mt-1 text-[11px] text-zinc-600">
                Straight legs between cameras, not the roads driven. Red dashed legs are ones the
                platform could not believe; see the notes column.
              </p>
            </section>
          )}

          {route.hops.length > 0 && (
            <section>
              <h2 className="mb-2 text-[11px] font-semibold uppercase tracking-[0.14em] text-zinc-600">
                Visits, in order
              </h2>
              <table className="w-full border-collapse text-[11.5px]">
                <thead>
                  <tr className="border-b border-zinc-900 text-left">
                    <th className="py-1 pr-2">#</th>
                    <th className="py-1 pr-2">Time (IST)</th>
                    <th className="py-1 pr-2">Camera</th>
                    <th className="py-1 pr-2">Reads</th>
                    <th className="py-1 pr-2">Evidence</th>
                    <th className="py-1">Leg from previous</th>
                  </tr>
                </thead>
                <tbody>
                  {route.hops.map((hop, i) => {
                    const crop = hop.best_detection_id ? crops[hop.best_detection_id] : null
                    return (
                      <tr
                        key={`${hop.camera_id}-${hop.arrived_at}`}
                        className={`border-b border-zinc-200 align-top print:break-inside-avoid ${
                          hop.plausible ? '' : 'bg-red-50'
                        }`}
                      >
                        <td className="py-1.5 pr-2 font-bold">{i + 1}</td>
                        <td className="py-1.5 pr-2 whitespace-nowrap">
                          {api.formatIST(hop.arrived_at)}
                          {hop.dwell_s > 0 && (
                            <span className="block text-zinc-600">
                              to {api.formatIST(hop.departed_at, false)}
                            </span>
                          )}
                        </td>
                        <td className="py-1.5 pr-2">
                          <span className="font-mono font-semibold">{hop.camera_code}</span>
                          <span className="block">{hop.camera_name}</span>
                          <span className="block text-zinc-600">
                            {[hop.city, hop.district].filter(Boolean).join(', ')}
                            {departments[hop.camera_id] ? ` · ${departments[hop.camera_id]}` : ''}
                          </span>
                        </td>
                        <td className="py-1.5 pr-2 whitespace-nowrap">
                          {hop.sightings} · best {hop.plate_confidence.toFixed(2)}
                        </td>
                        <td className="py-1.5 pr-2">
                          {crop ? (
                            <img
                              src={crop}
                              alt={`Plate read at ${hop.camera_code}`}
                              className="h-10 max-w-[140px] rounded border border-zinc-300 object-contain"
                            />
                          ) : (
                            <span className="text-zinc-500">no crop</span>
                          )}
                        </td>
                        <td className="py-1.5">
                          {hop.distance_km !== null && hop.elapsed_s !== null ? (
                            <>
                              ≥ {hop.distance_km} km in {minutes(hop.elapsed_s)}
                              {hop.implied_kmph !== null && ` · ≥ ${Math.round(hop.implied_kmph)} km/h`}
                            </>
                          ) : (
                            <span className="text-zinc-500">start</span>
                          )}
                          {hop.flags.length > 0 && (
                            <span className={`block ${hop.plausible ? 'text-zinc-600' : 'font-semibold text-red-700'}`}>
                              {hop.flags.map((f) => FLAG_WORDS[f] ?? f).join('; ')}
                            </span>
                          )}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </section>
          )}

          {route.unplaced_sightings.length > 0 && (
            <section>
              <h2 className="mb-2 text-[11px] font-semibold uppercase tracking-[0.14em] text-zinc-600">
                Also seen where the camera&rsquo;s position is unknown
              </h2>
              <table className="w-full border-collapse text-[11.5px]">
                <thead>
                  <tr className="border-b border-zinc-900 text-left">
                    <th className="py-1 pr-2">Time (IST)</th>
                    <th className="py-1 pr-2">Camera</th>
                    <th className="py-1 pr-2">Read</th>
                    <th className="py-1">Evidence</th>
                  </tr>
                </thead>
                <tbody>
                  {route.unplaced_sightings.map((s) => (
                    <tr key={s.detection_id} className="border-b border-zinc-200 align-top print:break-inside-avoid">
                      <td className="py-1.5 pr-2 whitespace-nowrap">{api.formatIST(s.seen_at)}</td>
                      <td className="py-1.5 pr-2">
                        <span className="font-mono font-semibold">{s.camera_code}</span>
                        <span className="block">{s.camera_name}</span>
                        {departments[s.camera_id] && (
                          <span className="block text-zinc-600">{departments[s.camera_id]}</span>
                        )}
                      </td>
                      <td className="py-1.5 pr-2">{s.plate_confidence.toFixed(2)}</td>
                      <td className="py-1.5">
                        {crops[s.detection_id] ? (
                          <img
                            src={crops[s.detection_id]!}
                            alt={`Plate read at ${s.camera_code}`}
                            className="h-10 max-w-[140px] rounded border border-zinc-300 object-contain"
                          />
                        ) : (
                          <span className="text-zinc-500">no crop</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
          )}

          <section className="space-y-1.5 border-t border-zinc-300 pt-4 text-[11px] text-zinc-700 print:break-inside-avoid">
            <h2 className="text-[11px] font-semibold uppercase tracking-[0.14em] text-zinc-600">
              Reading this report
            </h2>
            <p>
              The route is inferred from where the plate was read. Distances are straight lines
              between cameras, so every distance and speed here is a lower bound on what was
              driven.
            </p>
            {route.unplaced_sightings.length > 0 && <p>{route.unplaced_note}</p>}
            <p>
              The platform reads plates only on cameras it is analysing at the time, and on this
              deployment that is a few at a time. A camera that was not being analysed could not
              have read the plate: absence from this report is not evidence the vehicle was absent.
            </p>
            {flagsPresent.length > 0 && (
              <p>
                Notes on legs:{' '}
                {flagsPresent.map((f) => `${FLAG_WORDS[f] ?? f}`).join('; ')}. A leg that is
                faster than any vehicle could drive usually means a misread or a cloned plate, and
                is shown rather than removed.
              </p>
            )}
            <p>
              Each read&rsquo;s confidence is the plate reader&rsquo;s agreement across frames, from
              0 to 1. Preparing this report was recorded in the platform&rsquo;s audit log.
            </p>
          </section>
        </article>
      )}
    </div>
  )
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-[10px] uppercase tracking-wider text-zinc-600">{label}</dt>
      <dd className="font-medium">{value}</dd>
    </div>
  )
}
