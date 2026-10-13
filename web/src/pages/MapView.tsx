/**
 * Network · Map — every camera with a known position, where it is, and
 * whether it needs someone.
 *
 * The map is the spine and the side panel says what the map cannot: the
 * cameras grouped by place, the ones whose position nobody knows (listed,
 * never drawn), and the full record of whichever camera is open. Filters
 * live in the panel too, so the map keeps the whole screen.
 *
 * `?camera=<CODE>` opens a camera and flies to it; the URL follows the
 * selection, so a link to what is on screen is the address bar. Nothing is
 * opened by default: selection is always a click or a link.
 */

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from 'react'
import { Link, useSearchParams } from 'react-router-dom'

import CameraMap, { type CameraMapHandle, type FramePadding } from '@/components/CameraMap'
import CameraPanel from '@/components/CameraPanel'
import { SkeletonRows } from '@/components/Skeleton'
import {
  countByStatus,
  departmentOptions,
  fetchAllCameras,
  filterCameras,
  findCamera,
  isFiltered,
  NO_FILTER,
  readCameraParam,
  STATUS_LABEL,
  STATUS_ORDER,
  UNASSIGNED,
  vendorOptions,
  vendorWords,
  withParams,
  type CameraFilter,
} from '@/components/network/cameraFacts'
import {
  CONGESTION_COLOUR,
  HEATMAP_STOPS,
  NO_FIGURE_COLOUR,
  clusterTone,
  dotSize,
  statusSummary,
  type MapCluster,
} from '@/components/network/mapClusters'
import { NoPositionGlyph, PlaceDot } from '@/components/network/PlaceDot'
import {
  Button,
  Checkbox,
  EmptyState,
  ErrorBanner,
  Icon,
  InfoHint,
  Input,
  SectionLabel,
  SegmentedControl,
  Select,
  Spinner,
  StatusDot,
} from '@/components/ui'
import { useAuth } from '@/hooks/useAuth'
import * as api from '@/lib/api'
import type { Basemap } from '@/lib/basemap'
import { PERMISSIONS } from '@/lib/permissions'
import { groupPlaces, isUnplaced, type Place } from '@/lib/places'
import type { Camera, CameraStatus, CongestionLevel } from '@/lib/types'

/** Fleet state is re-read on the health monitor's cadence. */
const REFRESH_MS = 30_000

/** Room the floating tiles and legend take, so framing never hides a camera under them. */
const FRAME_PADDING: FramePadding = { top: 140, bottom: 110, left: 70, right: 70 }

/** A list of cameras opened in the side panel, from a marker or a place. */
interface Group {
  title: string
  /** Why these cameras are together, in one line. */
  caption: string
  cameraIds: string[]
}

function distinctPositions(cameras: Camera[]): number {
  return new Set(cameras.map((c) => `${c.lat.toFixed(5)},${c.lon.toFixed(5)}`)).size
}

function groupCaption(name: string, cameras: Camera[], townLevel: boolean): string {
  const positions = distinctPositions(cameras)
  if (positions > 1) {
    return `${cameras.length} cameras at ${positions} positions in and around ${name}.`
  }
  return townLevel
    ? `All ${cameras.length} share the town’s centre: the grid publishes ${name}, not the junction, so no zoom separates them.`
    : `All ${cameras.length} are registered at one point.`
}

export default function MapView() {
  const { can } = useAuth()
  const [params, setParams] = useSearchParams()
  const selectedCode = readCameraParam(params)

  const [cameras, setCameras] = useState<Camera[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [districts, setDistricts] = useState<GeoJSON.FeatureCollection | null>(null)
  const [filter, setFilter] = useState<CameraFilter>(NO_FILTER)
  const [group, setGroup] = useState<Group | null>(null)
  const [district, setDistrict] = useState<string | null>(null)
  const mapRef = useRef<CameraMapHandle>(null)
  const unplacedRef = useRef<HTMLElement>(null)

  // The offline outline by default: it is what the map must look like on a
  // venue's wifi, and it is what keeps the status marks the brightest thing
  // on screen. Satellite is one click away and falls back on its own when
  // the imagery host cannot be reached.
  const [basemap, setBasemap] = useState<Basemap>('offline')
  const [satelliteDown, setSatelliteDown] = useState(false)
  const handleSatelliteUnavailable = useCallback(() => {
    setSatelliteDown(true)
    setBasemap('offline')
  }, [])

  // Detection density, fetched on demand — an operator who never asks for it
  // should not pay for the query.
  const mayReadAnalytics = can(PERMISSIONS.analyticsRead)
  const [showHeatmap, setShowHeatmap] = useState(false)
  const [heatmap, setHeatmap] = useState<GeoJSON.FeatureCollection | null>(null)

  useEffect(() => {
    if (!showHeatmap || heatmap) return
    let cancelled = false
    void api
      .getAnalyticsHeatmap()
      .then((body) => {
        if (cancelled) return
        setHeatmap({ type: 'FeatureCollection', features: body.features } as GeoJSON.FeatureCollection)
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [showHeatmap, heatmap])

  // Corridor traffic state, on the same on-demand terms. Grouped by corridor
  // because that is what the road linework is keyed on.
  const [showTraffic, setShowTraffic] = useState(false)
  const [corridorTraffic, setCorridorTraffic] = useState<Record<string, CongestionLevel> | null>(null)

  useEffect(() => {
    if (!showTraffic) return
    let cancelled = false
    void api
      .getTrafficState({ group_by: 'corridor' })
      .then((body) => {
        if (cancelled) return
        // Only corridors with a level. One without is left out entirely so the
        // layer draws it as "no figure" rather than as flowing — a road
        // nothing was measured on must not look calm.
        const levels: Record<string, CongestionLevel> = {}
        for (const zone of body.zones) {
          if (zone.congestion) levels[zone.key] = zone.congestion
        }
        setCorridorTraffic(levels)
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [showTraffic])

  // District boundaries are a static asset: fetched once, cached by the
  // browser, and served from our own origin — no tile server involved.
  useEffect(() => {
    fetch('/data/gujarat_districts.geojson')
      .then((r) => (r.ok ? (r.json() as Promise<GeoJSON.FeatureCollection>) : null))
      .then(setDistricts)
      .catch(() => setDistricts(null))
  }, [])

  const load = useCallback(async () => {
    try {
      setCameras(await fetchAllCameras())
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }, [])

  useEffect(() => {
    void load()
    const timer = window.setInterval(() => void load(), REFRESH_MS)
    return () => window.clearInterval(timer)
  }, [load])

  // ── What is shown ────────────────────────────────────────────────────
  const all = useMemo(() => cameras ?? [], [cameras])
  const shown = useMemo(() => filterCameras(all, filter), [all, filter])
  const placed = useMemo(() => shown.filter((c) => !isUnplaced(c)), [shown])
  const unplaced = useMemo(() => shown.filter((c) => isUnplaced(c)), [shown])
  const places = useMemo(() => groupPlaces(placed).places, [placed])
  const counts = useMemo(() => countByStatus(all), [all])
  const unplacedTotal = useMemo(() => all.filter((c) => isUnplaced(c)).length, [all])
  const byId = useMemo(() => new Map(all.map((c) => [c.id, c])), [all])

  const selected = findCamera(all, selectedCode)
  const groupCameras = useMemo(
    () => (group ? group.cameraIds.map((id) => byId.get(id)).filter((c): c is Camera => !!c) : []),
    [group, byId],
  )
  const selectedIds = useMemo(
    () => new Set(selected ? [selected.id] : groupCameras.map((c) => c.id)),
    [selected, groupCameras],
  )

  // ── Selection ────────────────────────────────────────────────────────
  const setCameraParam = useCallback(
    (code: string | null) => {
      setParams((prev) => withParams(prev, { camera: code }), { replace: true })
    },
    [setParams],
  )

  // Fly to a camera opened by a link or from the side panel — but not to one
  // clicked on the map, which is already where the operator is looking.
  const flownFor = useRef<string | null>(null)
  useEffect(() => {
    if (!selected) {
      flownFor.current = null
      return
    }
    if (flownFor.current === selected.camera_code) return
    flownFor.current = selected.camera_code
    mapRef.current?.focusCamera(selected)
  }, [selected])

  const clearSelection = useCallback(() => {
    setGroup(null)
    setCameraParam(null)
  }, [setCameraParam])

  const handleMarker = useCallback(
    (cluster: MapCluster) => {
      const [only] = cluster.cameras
      if (cluster.cameras.length === 1 && only) {
        flownFor.current = only.camera_code
        setGroup(null)
        setCameraParam(only.camera_code)
        return
      }
      setGroup({
        title: cluster.name,
        caption: groupCaption(cluster.name, cluster.cameras, cluster.townLevel),
        cameraIds: cluster.cameras.map((c) => c.id),
      })
      setCameraParam(null)
      // Several positions this zoom cannot separate: zoom until it can.
      if (!cluster.colocated) mapRef.current?.frameCameras(cluster.cameras)
    },
    [setCameraParam],
  )

  const openPlace = useCallback(
    (place: Place) => {
      const [only] = place.cameras
      if (place.cameras.length === 1 && only) {
        setGroup(null)
        setCameraParam(only.camera_code)
        return
      }
      const townLevel = place.cameras.every((c) => c.tags?.includes('placement:city'))
      setGroup({
        title: place.name,
        caption: groupCaption(place.name, place.cameras, townLevel),
        cameraIds: place.cameras.map((c) => c.id),
      })
      setCameraParam(null)
      mapRef.current?.frameCameras(place.cameras)
    },
    [setCameraParam],
  )

  const showUnplaced = useCallback(() => {
    clearSelection()
    window.requestAnimationFrame(() =>
      unplacedRef.current?.scrollIntoView?.({ behavior: 'smooth', block: 'start' }),
    )
  }, [clearSelection])

  const known = counts.online + counts.offline + counts.degraded
  const attention = counts.offline + counts.degraded

  // ── Side panel ───────────────────────────────────────────────────────
  let panel: ReactNode
  if (selected) {
    panel = (
      <CameraPanel
        key={selected.id}
        camera={selected}
        context="map"
        onClose={clearSelection}
        onRefresh={() => void load()}
        back={
          group
            ? { label: `${group.title} · ${groupCameras.length}`, onClick: () => setCameraParam(null) }
            : undefined
        }
      />
    )
  } else if (selectedCode && cameras) {
    panel = (
      <div className="p-4">
        <EmptyState
          title={`No camera ${selectedCode} in the registry.`}
          hint="It may have been removed, or the link mistyped."
        />
        <Button variant="outline" size="sm" className="mt-3" onClick={clearSelection}>
          All cameras
        </Button>
      </div>
    )
  } else if (group && groupCameras.length > 0) {
    panel = (
      <GroupList
        group={group}
        cameras={groupCameras}
        onBack={() => setGroup(null)}
        onClose={clearSelection}
        onPick={(camera) => setCameraParam(camera.camera_code)}
      />
    )
  } else {
    panel = (
      <Overview
        loading={cameras === null}
        all={all}
        shown={shown}
        counts={counts}
        filter={filter}
        onFilter={setFilter}
        places={places}
        unplaced={unplaced}
        unplacedRef={unplacedRef}
        onOpenPlace={openPlace}
        onOpenCamera={(camera) => setCameraParam(camera.camera_code)}
      />
    )
  }

  return (
    <div className="flex min-h-0 flex-1">
      {/* ── Map ─────────────────────────────────────────────────────── */}
      <div className="relative min-w-0 flex-1 overflow-hidden bg-background">
        <CameraMap
          ref={mapRef}
          cameras={placed}
          districts={districts}
          basemap={basemap}
          onSatelliteUnavailable={handleSatelliteUnavailable}
          heatmap={heatmap}
          showHeatmap={showHeatmap}
          corridorTraffic={corridorTraffic}
          showTraffic={showTraffic}
          selectedIds={selectedIds}
          onSelect={handleMarker}
          onClearSelection={clearSelection}
          onDistrictHover={setDistrict}
          framePadding={FRAME_PADDING}
        />

        {cameras === null && !error && (
          <div className="absolute inset-0 z-20 flex items-center justify-center bg-background/60">
            <Spinner />
          </div>
        )}

        {/* Figures and layer controls, over the map's top edge. */}
        <div className="pointer-events-none absolute inset-x-3 top-3 z-10 flex flex-wrap items-start gap-2">
          {/* Two short facts, not three tiles: how much of the estate is on
              the map, and whether it is answering. Offline and degraded are
              named only when there are some — normal is quiet. */}
          <div className="pointer-events-auto flex flex-wrap gap-2">
            {cameras && (
              <>
                <MapFact>
                  {all.length - unplacedTotal} of {all.length} on the map
                </MapFact>
                <MapFact
                  tone={all.length > 0 && known === 0 ? 'warn' : undefined}
                  title="Only cameras whose state is known are counted. A camera behind an integration that is not answering (the grid refusing our login, say) is unknown, not offline."
                >
                  {counts.online} of {known} answering
                  {counts.unknown > 0 && <span className="text-faint"> · {counts.unknown} unknown</span>}
                </MapFact>
                {attention > 0 && (
                  <MapFact tone={counts.offline > 0 ? 'bad' : 'warn'}>
                    {counts.offline} offline · {counts.degraded} degraded
                  </MapFact>
                )}
              </>
            )}
          </div>

          <div className="pointer-events-auto ml-auto w-[13.5rem] rounded-lg border border-border bg-card p-2.5 shadow-lg">
            <SegmentedControl
              className="w-fit"
              value={basemap}
              onChange={setBasemap}
              disabledValues={satelliteDown ? ['satellite'] : undefined}
              options={[
                {
                  value: 'offline',
                  label: 'Offline',
                  title: 'Local district outlines — no tile server, no network',
                },
                {
                  value: 'satellite',
                  label: 'Satellite',
                  title: satelliteDown
                    ? 'Imagery host unreachable — offline basemap in use'
                    : 'Esri World Imagery',
                },
              ]}
            />
            <p className="mt-1.5 text-[11px] leading-snug text-faint">
              {basemap === 'satellite'
                ? 'Esri World Imagery · needs the network'
                : satelliteDown
                  ? 'Imagery unreachable · offline basemap'
                  : 'Offline basemap · no external requests'}
            </p>
            {mayReadAnalytics && (
              <div className="mt-2 space-y-1.5 border-t border-border pt-2">
                <LayerToggle
                  checked={showHeatmap}
                  onChange={setShowHeatmap}
                  label="Detection density"
                  info="Weighted by vehicles read over the last 6 hours. The camera markers stay on top, so a camera is never hidden underneath it."
                />
                <LayerToggle
                  checked={showTraffic}
                  onChange={setShowTraffic}
                  label="Corridor traffic"
                  info="The Ahmedabad corridors the analytics are keyed on, coloured by congestion. Faint means no figure for that road in this window — not free-flowing."
                />
              </div>
            )}
          </div>
        </div>

        {error && (
          <div className="absolute left-1/2 top-[7.5rem] z-20 w-max max-w-[90%] -translate-x-1/2 shadow-lg">
            <ErrorBanner>{error}</ErrorBanner>
          </div>
        )}

        {/* Legend: the marks exactly as the map draws them. */}
        <div className="absolute bottom-10 left-3 z-10 flex max-w-[calc(100%-7rem)] flex-wrap items-center gap-x-3.5 gap-y-1.5 rounded-lg border border-border bg-card px-3 py-2 text-[11px] text-muted-foreground shadow-lg">
          <LegendItem glyph={<PlaceDot size={7} />}>Camera</LegendItem>
          <LegendItem glyph={<PlaceDot size={14} />}>Several at one place</LegendItem>
          <LegendItem glyph={<PlaceDot tone="unknown" size={7} />}>State unknown</LegendItem>
          <LegendItem glyph={<PlaceDot tone="offline" size={7} />}>Offline</LegendItem>
          <LegendItem glyph={<PlaceDot tone="degraded" size={7} />}>Degraded</LegendItem>
          <LegendItem glyph={<PlaceDot selected size={7} />}>Selected</LegendItem>
          {unplacedTotal > 0 && (
            <button
              type="button"
              onClick={showUnplaced}
              className="flex items-center gap-1.5 border-l border-border pl-3.5 text-priority-high transition hover:underline"
            >
              <NoPositionGlyph />
              {unplacedTotal} without a position
            </button>
          )}
          {showHeatmap && (
            <span className="flex basis-full items-center gap-2 border-t border-border pt-1.5">
              Detection density
              <span className="font-mono text-faint">fewer</span>
              <span
                aria-hidden="true"
                className="h-1.5 w-24 rounded-full"
                style={{
                  background: `linear-gradient(90deg, ${HEATMAP_STOPS.map(([at, colour]) => `${colour} ${at * 100}%`).join(', ')})`,
                }}
              />
              <span className="font-mono text-faint">more</span>
            </span>
          )}
          {showTraffic && (
            <span className="flex basis-full flex-wrap items-center gap-x-3 gap-y-1 border-t border-border pt-1.5">
              Corridor traffic
              {(Object.keys(CONGESTION_COLOUR) as CongestionLevel[]).map((level) => (
                <LegendItem key={level} glyph={<LineKey colour={CONGESTION_COLOUR[level]} />}>
                  {level === 'free' ? 'Flowing' : level.charAt(0).toUpperCase() + level.slice(1)}
                </LegendItem>
              ))}
              <LegendItem glyph={<LineKey colour={NO_FIGURE_COLOUR} />}>No figure</LegendItem>
            </span>
          )}
        </div>

        {district && (
          <div className="pointer-events-none absolute bottom-3 left-1/2 z-10 -translate-x-1/2 rounded-md border border-border bg-card px-2.5 py-1 text-xs shadow-lg">
            <span className="eyebrow mr-1.5">District</span>
            {district}
          </div>
        )}
      </div>

      {/* ── Side panel ──────────────────────────────────────────────── */}
      <aside
        aria-label="Cameras"
        className="flex w-[22rem] shrink-0 flex-col border-l border-border bg-chrome"
      >
        {panel}
      </aside>
    </div>
  )
}

// ── The side panel's default view ─────────────────────────────────────────

function Overview({
  loading,
  all,
  shown,
  counts,
  filter,
  onFilter,
  places,
  unplaced,
  unplacedRef,
  onOpenPlace,
  onOpenCamera,
}: {
  loading: boolean
  all: Camera[]
  shown: Camera[]
  counts: Record<CameraStatus, number>
  filter: CameraFilter
  onFilter: (filter: CameraFilter) => void
  places: Place[]
  unplaced: Camera[]
  unplacedRef: RefObject<HTMLElement>
  onOpenPlace: (place: Place) => void
  onOpenCamera: (camera: Camera) => void
}) {
  const { departments, unassigned } = useMemo(() => departmentOptions(all), [all])
  const vendors = useMemo(() => vendorOptions(all), [all])
  const filtered = isFiltered(filter)
  const set = <K extends keyof CameraFilter>(key: K, value: CameraFilter[K]) =>
    onFilter({ ...filter, [key]: value })

  return (
    <>
      <div className="shrink-0 space-y-2.5 border-b border-border px-4 pb-4 pt-3.5">
        <div className="flex items-baseline justify-between gap-3">
          <h2 className="text-[15px] font-semibold">Cameras</h2>
          <span className="text-xs text-faint">
            {loading
              ? 'loading…'
              : filtered
                ? `${shown.length} of ${all.length} shown`
                : `${all.length} registered`}
          </span>
        </div>
        <Input
          value={filter.search}
          onChange={(e) => set('search', e.target.value)}
          placeholder="Code, name or town"
          aria-label="Filter cameras by code, name or town"
        />
        <div className="grid grid-cols-2 gap-2">
          <Select
            aria-label="Status"
            value={filter.status}
            onChange={(e) => set('status', e.target.value as CameraFilter['status'])}
          >
            <option value="">Any status</option>
            {STATUS_ORDER.map((status) => (
              <option key={status} value={status}>
                {STATUS_LABEL[status]} ({counts[status]})
              </option>
            ))}
          </Select>
          <Select
            aria-label="Department"
            value={filter.department}
            onChange={(e) => set('department', e.target.value)}
          >
            <option value="">Any department</option>
            {departments.map((d) => (
              <option key={d.code} value={d.code}>
                {d.code} ({d.count})
              </option>
            ))}
            {unassigned > 0 && <option value={UNASSIGNED}>Unassigned ({unassigned})</option>}
          </Select>
          <Select
            aria-label="Integration"
            value={filter.vendor}
            onChange={(e) => set('vendor', e.target.value)}
          >
            <option value="">Any integration</option>
            {vendors.map((vendor) => (
              <option key={vendor} value={vendor}>
                {vendorWords(vendor)}
              </option>
            ))}
          </Select>
          <div className="flex items-center">
            <Checkbox
              checked={filter.anprOnly}
              onChange={(e) => set('anprOnly', e.target.checked)}
              label="Plate reading only"
              labelClassName="gap-2 text-xs text-muted-foreground"
            />
          </div>
        </div>
        {filtered && (
          <Button variant="ghost" size="sm" className="-ml-2" onClick={() => onFilter(NO_FILTER)}>
            <Icon name="close" size={12} />
            Clear filters
          </Button>
        )}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {loading ? (
          <div className="p-4">
            <SkeletonRows rows={6} height="h-8" />
          </div>
        ) : (
          <>
            <section className="px-4 pb-4 pt-3.5">
              <SectionLabel
                action={<span className="font-mono text-[11px] text-faint">{places.length}</span>}
              >
                Places
                <InfoHint>
                  Cameras grouped by town. The organisers’ grid publishes most cameras with a town
                  and no junction, so a town’s cameras share its centre on the map.
                </InfoHint>
              </SectionLabel>
              {places.length === 0 ? (
                <p className="mt-2 text-xs text-faint">No placed camera matches these filters.</p>
              ) : (
                <ul className="mt-1.5 space-y-px">
                  {places.map((place) => (
                    <li key={place.key}>
                      <button
                        type="button"
                        onClick={() => onOpenPlace(place)}
                        className="flex w-full items-center gap-2 rounded-md px-1.5 py-1 text-left transition hover:bg-secondary/60"
                      >
                        <span className="flex w-7 justify-center">
                          <PlaceDot
                            tone={clusterTone(place.cameras)}
                            size={dotSize(place.cameras.length)}
                          />
                        </span>
                        <span className="min-w-0 flex-1 truncate text-[13px]">{place.name}</span>
                        <span className="font-mono text-[11px] text-faint">
                          {place.cameras.length}
                        </span>
                        <Icon name="chevronRight" size={14} className="text-faint" />
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </section>

            <section ref={unplacedRef} className="scroll-mt-2 border-t border-border px-4 pb-4 pt-3.5">
              <SectionLabel
                action={
                  <Link
                    to="/cameras?filter=unplaced"
                    className="text-[11px] text-primary hover:underline"
                  >
                    In the registry
                  </Link>
                }
              >
                <NoPositionGlyph />
                Without a position
                <span className="font-mono text-faint">{unplaced.length}</span>
              </SectionLabel>
              <p className="mt-1.5 text-xs leading-relaxed text-faint">
                The grid publishes these with no town, so they are not drawn. A dot anywhere
                would claim a place nobody knows.
              </p>
              {unplaced.length > 0 && (
                <ul className="mt-2 space-y-px">
                  {unplaced.map((camera) => (
                    <li key={camera.id}>
                      <button
                        type="button"
                        onClick={() => onOpenCamera(camera)}
                        className="flex w-full items-center gap-2.5 rounded-md px-1.5 py-1.5 text-left transition hover:bg-secondary/60"
                      >
                        <StatusDot status={camera.status} />
                        <span className="camera-code shrink-0 text-[11px] text-muted-foreground">
                          {camera.camera_code}
                        </span>
                        <span className="min-w-0 flex-1 truncate text-[13px]">{camera.name}</span>
                        <Icon name="chevronRight" size={14} className="text-faint" />
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          </>
        )}
      </div>
    </>
  )
}

// ── A group's cameras ─────────────────────────────────────────────────────

function GroupList({
  group,
  cameras,
  onBack,
  onClose,
  onPick,
}: {
  group: Group
  cameras: Camera[]
  onBack: () => void
  onClose: () => void
  onPick: (camera: Camera) => void
}) {
  return (
    <>
      <header className="shrink-0 border-b border-border px-4 pb-3.5 pt-3">
        <div className="flex items-center justify-between gap-3">
          <button
            type="button"
            onClick={onBack}
            className="-ml-1 inline-flex items-center gap-1 rounded px-1 py-0.5 text-xs text-muted-foreground transition hover:text-foreground"
          >
            <Icon name="chevronLeft" size={14} />
            All places
          </button>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="rounded p-1 text-muted-foreground transition hover:bg-secondary hover:text-foreground"
          >
            <Icon name="close" size={16} />
          </button>
        </div>
        <h2 className="mt-2 text-[15px] font-semibold leading-snug">
          {group.title}
          <span className="ml-2 font-mono text-[13px] font-normal text-faint">{cameras.length}</span>
        </h2>
        <p className="mt-0.5 text-xs text-muted-foreground">{statusSummary(cameras)}</p>
        <p className="mt-2 text-xs leading-relaxed text-faint">{group.caption}</p>
      </header>
      <ul className="min-h-0 flex-1 space-y-1.5 overflow-y-auto p-3">
        {cameras.map((camera) => (
          <li key={camera.id}>
            <button
              type="button"
              onClick={() => onPick(camera)}
              className="flex w-full items-center gap-3 rounded-lg border border-border bg-card px-3 py-2.5 text-left transition hover:border-muted-foreground/40 hover:bg-secondary/30"
            >
              <StatusDot status={camera.status} />
              <span className="min-w-0 flex-1">
                <span className="camera-code block text-[11px] text-muted-foreground">
                  {camera.camera_code}
                </span>
                <span className="block truncate text-[13px]">{camera.name}</span>
              </span>
              <Icon name="chevronRight" size={14} className="shrink-0 text-faint" />
            </button>
          </li>
        ))}
      </ul>
    </>
  )
}

// ── Small parts ───────────────────────────────────────────────────────────

function LayerToggle({
  checked,
  onChange,
  label,
  info,
}: {
  checked: boolean
  onChange: (value: boolean) => void
  label: string
  info: string
}) {
  return (
    <div className="flex items-center gap-1">
      <Checkbox
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        label={label}
        labelClassName="gap-2 text-xs"
      />
      <InfoHint align="right">{info}</InfoHint>
    </div>
  )
}

function LegendItem({ glyph, children }: { glyph: ReactNode; children: ReactNode }) {
  return (
    <span className="flex items-center gap-1.5">
      <span className="flex h-5 min-w-5 items-center justify-center">{glyph}</span>
      {children}
    </span>
  )
}

/** A short stroke in a road colour, the way the corridor layer draws it. */
function LineKey({ colour }: { colour: string }) {
  return (
    <span aria-hidden="true" className="h-[3px] w-4 rounded-full" style={{ background: colour }} />
  )
}

/** One fact over the map, as a pill — the Overview's shape. */
function MapFact({
  children,
  tone,
  title,
}: {
  children: ReactNode
  tone?: 'warn' | 'bad'
  title?: string
}) {
  return (
    <span
      title={title}
      className={`inline-flex h-9 items-center gap-2 rounded-full border bg-card px-3.5 text-[13px] shadow-lg ${
        tone === 'bad'
          ? 'border-priority-critical/50 text-priority-critical'
          : tone === 'warn'
            ? 'border-priority-high/50 text-priority-high'
            : 'border-border text-foreground'
      }`}
    >
      <span
        className={`h-2 w-2 shrink-0 rounded-full ${
          tone === 'bad' ? 'bg-priority-critical' : tone === 'warn' ? 'bg-priority-high' : 'bg-primary'
        }`}
      />
      {children}
    </span>
  )
}
