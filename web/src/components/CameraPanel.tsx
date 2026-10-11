/**
 * One camera, in full: its state, where it stands, where its pictures come
 * from, how it has answered, and — for a role that may — its live view.
 *
 * Shown in the map's side panel and beside the registry table, so the same
 * camera reads the same way wherever it is opened. The caller supplies the
 * container; this fills its height and scrolls its own body.
 *
 * Nothing here opens video or probes a camera by itself — both are a click.
 * A grid camera's watch time is rationed by its operators, and a panel that
 * started a stream on selection would spend it on every passing click.
 *
 * Opening a stream asks the API for a short-lived, camera-scoped token, and
 * that issuance writes an audit row. The panel says so, because a system that
 * records who watched what should be visible about it rather than quietly
 * logging in the background.
 */

import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { Link } from 'react-router-dom'

import StreamPlayer from '@/components/StreamPlayer'
import {
  placeLine,
  positionKind,
  probeErrorWords,
  SOURCE_DETAIL,
  SOURCE_LABEL,
  sourceKind,
  STATUS_EXPLANATION,
  STATUS_LABEL,
  vendorWords,
} from '@/components/network/cameraFacts'
import { NoPositionGlyph } from '@/components/network/PlaceDot'
import { Badge, Button, Icon, SectionLabel, StatusBadge } from '@/components/ui'
import { useAuth } from '@/hooks/useAuth'
import * as api from '@/lib/api'
import { PERMISSIONS } from '@/lib/permissions'
import type { Camera, CameraHealthHistory, StreamGrant } from '@/lib/types'

/** Probes drawn in the strip — about a quarter of an hour at the usual cadence. */
const STRIP_PROBES = 60

interface Props {
  camera: Camera
  /** Where the panel is shown, so its cross-links point at the other screen. */
  context: 'map' | 'registry'
  onClose: () => void
  /** After a probe, so the caller can reload the camera's status. */
  onRefresh: () => void
  /** A way back to the list this camera was picked from. */
  back?: { label: string; onClick: () => void }
  /** Registry actions. Rendered only when given; the caller checks permission. */
  onEdit?: () => void
  onRemove?: () => void
}

export default function CameraPanel({
  camera,
  context,
  onClose,
  onRefresh,
  back,
  onEdit,
  onRemove,
}: Props) {
  const { can } = useAuth()
  const [health, setHealth] = useState<CameraHealthHistory | null>(null)
  const [healthFailed, setHealthFailed] = useState(false)
  const [stream, setStream] = useState<StreamGrant | null>(null)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<string | null>(null)

  const mayWatch = can(PERMISSIONS.streamView)
  const mayProbe = can(PERMISSIONS.cameraUpdate)
  const source = sourceKind(camera)
  const position = positionKind(camera)
  const where = placeLine(camera)

  // Recorded history only — reading it touches the database, never the camera.
  useEffect(() => {
    let cancelled = false
    setHealth(null)
    setHealthFailed(false)
    setStream(null)
    setMessage(null)
    api
      .getCameraHealth(camera.id)
      .then((body) => {
        if (!cancelled) setHealth(body)
      })
      .catch(() => {
        if (!cancelled) setHealthFailed(true)
      })
    return () => {
      cancelled = true
    }
  }, [camera.id])

  const handleProbe = useCallback(async () => {
    setBusy(true)
    setMessage(null)
    try {
      const result = await api.probeCamera(camera.id)
      const code = result.error_code ? String(result.error_code) : null
      setMessage(
        [
          `Probe: ${String(result.status)}`,
          code ? probeErrorWords(code) : null,
          result.latency_ms ? `${String(result.latency_ms)} ms` : null,
        ]
          .filter(Boolean)
          .join(' · '),
      )
      setHealth(await api.getCameraHealth(camera.id))
      onRefresh()
    } catch (err) {
      setMessage(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }, [camera.id, onRefresh])

  const handleOpenStream = useCallback(async () => {
    setBusy(true)
    setMessage(null)
    try {
      setStream(await api.openStream(camera.id))
    } catch (err) {
      setMessage(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }, [camera.id])

  const code = encodeURIComponent(camera.camera_code)

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* ── Identity ─────────────────────────────────────────────── */}
      <header className="shrink-0 border-b border-border px-4 pb-3.5 pt-3">
        <div className="flex items-center justify-between gap-3">
          {back ? (
            <button
              type="button"
              onClick={back.onClick}
              className="-ml-1 inline-flex min-w-0 items-center gap-1 rounded px-1 py-0.5 text-xs text-muted-foreground transition hover:text-foreground"
            >
              <Icon name="chevronLeft" size={14} />
              <span className="truncate">{back.label}</span>
            </button>
          ) : (
            <span className="eyebrow">Camera</span>
          )}
          <button
            type="button"
            onClick={onClose}
            aria-label="Close camera details"
            className="rounded p-1 text-muted-foreground transition hover:bg-secondary hover:text-foreground"
          >
            <Icon name="close" size={16} />
          </button>
        </div>

        <p className="camera-code mt-2 text-xs text-muted-foreground">{camera.camera_code}</p>
        <h2 className="mt-0.5 text-[15px] font-semibold leading-snug">{camera.name}</h2>
        {where && <p className="mt-0.5 text-xs text-faint">{where}</p>}

        <div className="mt-3 flex flex-wrap items-center gap-1.5">
          <StatusBadge status={camera.status} label={STATUS_LABEL[camera.status]} />
          <Badge tone={source === 'recorded' || source === 'none' ? 'warning' : 'neutral'}>
            {SOURCE_LABEL[source]}
          </Badge>
          {position === 'unknown' && <Badge tone="warning">No position</Badge>}
          {!camera.anpr_enabled && <Badge>Plates off</Badge>}
        </div>
        <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
          {STATUS_EXPLANATION[camera.status]}
        </p>
      </header>

      <div className="min-h-0 flex-1 space-y-5 overflow-y-auto px-4 py-4">
        {/* ── Live view ──────────────────────────────────────────── */}
        <section>
          <SectionLabel>Live view</SectionLabel>
          <div className="mt-2">
            {!mayWatch ? (
              <Note>
                Your role does not include <span className="font-mono">stream.view</span>.
                Analysts and auditors work from recorded reads rather than live video.
              </Note>
            ) : camera.status !== 'online' ? (
              // Honesty over a broken button: with no feed answering, "play"
              // would produce a black rectangle and no explanation.
              <Note>
                <p>
                  {camera.status === 'unknown'
                    ? 'Nothing to play while its state cannot be told. The live view opens once the camera answers a probe.'
                    : 'This camera is not delivering video, so there is nothing to play.'}
                </p>
                {mayProbe && (
                  <Button
                    variant="outline"
                    size="sm"
                    className="mt-2"
                    disabled={busy}
                    onClick={() => void handleProbe()}
                  >
                    <Icon name="refresh" size={13} />
                    {busy ? 'Probing…' : 'Probe now'}
                  </Button>
                )}
              </Note>
            ) : stream ? (
              <>
                <StreamPlayer
                  whepUrl={stream.whep_url}
                  hlsUrl={stream.hls_url}
                  // Federated grids publish HLS on 443 and WebRTC on a port
                  // most networks block. Trying WHEP first there costs the
                  // operator a visible failure before the fallback that was
                  // always going to win, so go straight to what works.
                  preferHls={Boolean(stream.hls_url && !stream.whep_url?.includes('localhost'))}
                  cameraCode={stream.camera_code}
                />
                <p className="mt-2 text-[11px] leading-relaxed text-faint">
                  Viewing token scoped to this camera, valid {stream.expires_in}s. Recorded in
                  the audit trail as <span className="font-mono text-muted-foreground">camera.view</span>.
                </p>
              </>
            ) : (
              <>
                <Button className="w-full" disabled={busy} onClick={() => void handleOpenStream()}>
                  <Icon name="play" size={13} />
                  {busy ? 'Requesting access…' : 'Open live view'}
                </Button>
                <p className="mt-1.5 text-[11px] leading-relaxed text-faint">
                  Opening the stream is recorded in the audit trail.
                  {source === 'grid' && ' Grid watch time is rationed — close it when done.'}
                </p>
              </>
            )}
          </div>
        </section>

        {/* ── Health ─────────────────────────────────────────────── */}
        <section>
          <SectionLabel
            action={
              <Link to={`/health?camera=${code}`} className="text-[11px] text-primary hover:underline">
                Probe history
              </Link>
            }
          >
            Health · last 24 h
          </SectionLabel>
          {health ? (
            <HealthSummary health={health} />
          ) : healthFailed ? (
            <p className="mt-2 text-xs text-faint">Probe history could not be loaded.</p>
          ) : (
            <div className="mt-2 h-[4.5rem] animate-pulse rounded-md bg-secondary/50" />
          )}
          {mayProbe && camera.status === 'online' && (
            <Button
              variant="outline"
              size="sm"
              className="mt-3"
              disabled={busy}
              onClick={() => void handleProbe()}
            >
              <Icon name="refresh" size={13} />
              {busy ? 'Probing…' : 'Probe now'}
            </Button>
          )}
          {message && (
            <p className="mt-2 rounded-md border border-border bg-secondary/40 px-3 py-2 font-mono text-[11px] leading-relaxed">
              {message}
            </p>
          )}
        </section>

        {/* ── Position ───────────────────────────────────────────── */}
        <section>
          <SectionLabel>Position</SectionLabel>
          <div className="mt-2 text-xs leading-relaxed text-muted-foreground">
            {position === 'unknown' ? (
              <div className="rounded-md border border-priority-high/30 bg-priority-high/[0.06] px-3 py-2.5">
                <p className="flex items-center gap-2 font-medium text-priority-high">
                  <NoPositionGlyph />
                  Not known
                </p>
                <p className="mt-1">
                  The grid gives no town for this camera, so it is not drawn on the map — a dot
                  anywhere would claim a place nobody knows.
                </p>
                {onEdit ? (
                  <Button variant="outline" size="sm" className="mt-2" onClick={onEdit}>
                    Add a position
                  </Button>
                ) : can(PERMISSIONS.cameraUpdate) ? (
                  <Link
                    to={`/cameras?camera=${code}`}
                    className="mt-2 inline-block text-primary hover:underline"
                  >
                    Add a position in the registry
                  </Link>
                ) : null}
              </div>
            ) : (
              <>
                <p>
                  {position === 'town'
                    ? `Town centre only. The grid publishes ${camera.city || camera.district || 'a town'}, not the junction, so the camera is drawn at the town’s centre with any others placed there.`
                    : 'Placed at its junction.'}
                </p>
                <p className="coord mt-1 text-[11px] text-faint">
                  {camera.lat.toFixed(5)}, {camera.lon.toFixed(5)}
                  {camera.heading_deg !== null && ` · facing ${camera.heading_deg}°`}
                </p>
              </>
            )}
          </div>
        </section>

        {/* ── Source and integration ─────────────────────────────── */}
        <section>
          <SectionLabel>Source and integration</SectionLabel>
          <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
            {SOURCE_DETAIL[source]}
            {camera.source_file && (
              <span className="mt-1 block font-mono text-[11px] text-faint">{camera.source_file}</span>
            )}
          </p>
          <dl className="mt-3 space-y-1.5">
            <Row label="Department" value={camera.department_name ?? camera.department_code ?? 'Unassigned'} />
            <Row label="Recorder" value={camera.vms_name} />
            <Row
              label="Integration"
              value={camera.vms_vendor ? vendorWords(camera.vms_vendor) : null}
              mono={camera.vms_vendor ?? undefined}
            />
            <Row label="Type" value={camera.camera_type} />
            <Row label="Protocol" value={camera.protocol} />
            <Row
              label="Picture"
              value={
                [camera.resolution, camera.fps ? `${camera.fps} fps` : null]
                  .filter(Boolean)
                  .join(' · ') || null
              }
            />
            <Row label="Plate reading" value={camera.anpr_enabled ? 'Enabled' : 'Not enabled'} />
          </dl>
        </section>
      </div>

      {/* ── Elsewhere ─────────────────────────────────────────────── */}
      <footer className="flex shrink-0 flex-wrap items-center gap-2 border-t border-border px-4 py-3">
        {mayWatch && (
          <LinkButton to={`/anpr?camera=${code}`} icon="video">
            Live ANPR
          </LinkButton>
        )}
        {context === 'registry' ? (
          position !== 'unknown' && (
            <LinkButton to={`/map?camera=${code}`} icon="map">
              On the map
            </LinkButton>
          )
        ) : (
          <LinkButton to={`/cameras?camera=${code}`} icon="camera">
            In the registry
          </LinkButton>
        )}
        {(onEdit || onRemove) && <span className="ml-auto" />}
        {onEdit && (
          <Button variant="outline" size="sm" onClick={onEdit}>
            Edit
          </Button>
        )}
        {onRemove && (
          <Button variant="destructive" size="sm" onClick={onRemove}>
            Remove
          </Button>
        )}
      </footer>
    </div>
  )
}

function HealthSummary({ health }: { health: CameraHealthHistory }) {
  const { uptime } = health
  // Newest on the right, as a timeline reads.
  const strip = health.history.slice(0, STRIP_PROBES).reverse()
  const failed = strip.filter((h) => h.reachable !== true).length

  return (
    <>
      <dl className="mt-2 grid grid-cols-3 gap-2">
        <Figure label="Uptime" value={uptime.uptime_pct !== null ? `${uptime.uptime_pct}%` : '—'} />
        <Figure label="Probes" value={uptime.probes.toLocaleString('en-IN')} />
        <Figure
          label="Latency"
          value={uptime.avg_latency_ms !== null ? `${Math.round(uptime.avg_latency_ms)} ms` : '—'}
        />
      </dl>
      {strip.length > 0 ? (
        <div className="mt-3">
          <div
            className="flex h-5 gap-px overflow-hidden rounded"
            role="img"
            aria-label={`Last ${strip.length} probes: ${strip.length - failed} answered, ${failed} not`}
          >
            {strip.map((h, i) => (
              <span
                key={`${h.ts}-${i}`}
                title={`${api.formatIST(h.ts)} — ${
                  h.reachable ? 'answered' : h.error_code ? probeErrorWords(h.error_code) : 'no answer'
                }`}
                className={`flex-1 ${h.reachable ? 'bg-muted-foreground/35' : 'bg-status-offline/80'}`}
              />
            ))}
          </div>
          <p className="mt-1 text-[11px] text-faint">
            One bar per probe, newest on the right · red did not answer
          </p>
        </div>
      ) : (
        <p className="mt-2 text-xs text-faint">Not probed in the last 24 hours.</p>
      )}
    </>
  )
}

function Figure({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border border-border bg-card px-2.5 py-2">
      <dt className="text-[10px] font-medium uppercase tracking-[0.06em] text-faint">{label}</dt>
      <dd className="mt-0.5 font-mono text-sm">{value}</dd>
    </div>
  )
}

function Note({ children }: { children: ReactNode }) {
  return (
    <div className="rounded-md border border-border bg-secondary/30 px-3 py-2.5 text-xs leading-relaxed text-muted-foreground">
      {children}
    </div>
  )
}

function Row({
  label,
  value,
  mono,
}: {
  label: string
  value: string | null | undefined
  /** A machine name shown faintly after the human one. */
  mono?: string
}) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className="shrink-0 text-xs text-faint">{label}</dt>
      <dd className="min-w-0 truncate text-right text-[13px]">
        {value ?? '—'}
        {mono && value && <span className="ml-1.5 font-mono text-[11px] text-faint">{mono}</span>}
      </dd>
    </div>
  )
}

function LinkButton({
  to,
  icon,
  children,
}: {
  to: string
  icon: 'video' | 'map' | 'camera'
  children: ReactNode
}) {
  return (
    <Link
      to={to}
      className="inline-flex h-7 items-center gap-1.5 rounded-md border border-input px-2.5 text-xs font-medium text-foreground transition hover:border-muted-foreground/60 hover:bg-secondary/60"
    >
      <Icon name={icon} size={13} />
      {children}
    </Link>
  )
}
