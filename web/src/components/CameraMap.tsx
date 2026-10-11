/**
 * The Network map: every camera with a known position, and whether it needs
 * someone.
 *
 * ── Basemaps ────────────────────────────────────────────────────────────
 * Two, switchable, because they serve different needs:
 *
 *   offline    Gujarat's 33 district boundaries from a 330 KB local GeoJSON,
 *              drawn as faint outlines on the dark ground. No tile server, no
 *              external request, renders identically on a plane or at a venue
 *              with hostile wifi. The default.
 *   satellite  Esri World Imagery + place labels. Real aerial imagery, so a
 *              junction on screen is recognisably the junction it claims to
 *              be. Needs the network: probed before use, and abandoned for
 *              the offline basemap, with a visible note, when unreachable.
 *
 * ── Markers ─────────────────────────────────────────────────────────────
 * HTML, one per group of cameras this zoom cannot separate (see
 * network/mapClusters): a light-grey dot sized by camera count, with its
 * place's name and count beside it. Colour only where a person is needed —
 * a red ring where a camera is offline, amber where one is degraded — and a
 * dim dot where no camera's state can be told. The trail-coloured ring is
 * the selection. Cameras with no known position are never drawn; the page
 * lists them instead.
 *
 * ── No GL text ──────────────────────────────────────────────────────────
 * MapLibre symbol layers need a `glyphs` font endpoint, which would be
 * another network dependency. Every label here is HTML instead.
 */

import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react'
import maplibregl from 'maplibre-gl'
import 'maplibre-gl/dist/maplibre-gl.css'

import { placeLine, STATUS_LABEL } from '@/components/network/cameraFacts'
import {
  CONGESTION_COLOUR,
  HEATMAP_STOPS,
  MARKER_FILL,
  MARKER_FILL_DIM,
  NO_FIGURE_COLOUR,
  clusterSpots,
  clusterTone,
  dotSize,
  spotsOf,
  statusSummary,
  type MapCluster,
} from '@/components/network/mapClusters'
import { Icon, StatusBadge } from '@/components/ui'
import { baseStyle, GUJARAT_CENTER, satelliteReachable, type Basemap } from '@/lib/basemap'
import { isUnplaced } from '@/lib/places'
import type { Camera, CongestionLevel } from '@/lib/types'

/* Map paint cannot take Tailwind classes, so the tokens it needs are repeated
   here by value — keep them in step with styles/index.css. */
const GROUND = '#0A0E13' // --background
const LAND = '#0F1620' // a step above the ground, below a panel
const BOUNDARY = '#1F2A36' // just above --border
const BOUNDARY_ON_IMAGERY = '#C9D3DD' // the marker grey, faint, so outlines survive bright imagery

/** Room the page's own overlays take at each edge, when framing cameras. */
export interface FramePadding {
  top: number
  bottom: number
  left: number
  right: number
}

const DEFAULT_PADDING: FramePadding = { top: 120, bottom: 90, left: 70, right: 70 }

export interface CameraMapHandle {
  /** Fly to one camera, closer in than the current view if need be. */
  focusCamera: (camera: Camera) => void
  /** Frame a set of cameras: zoom until they separate, or onto their one spot. */
  frameCameras: (cameras: Camera[]) => void
}

interface Props {
  /** The cameras to draw. Any without a known position are skipped. */
  cameras: Camera[]
  districts: GeoJSON.FeatureCollection | null
  basemap: Basemap
  onSatelliteUnavailable?: () => void
  /** Detection density, from `/analytics/heatmap` — GeoJSON points weighted
   *  by an `intensity` property (0-1), so MapLibre can take it directly. */
  heatmap?: GeoJSON.FeatureCollection | null
  showHeatmap?: boolean
  /** Congestion level per corridor name, from `/analytics/traffic`. Drives
   *  the colour of the road linework; a corridor absent from this map is
   *  drawn as "no figure" rather than as flowing. */
  corridorTraffic?: Record<string, CongestionLevel> | null
  showTraffic?: boolean
  /** Ids of the selected camera, or of every camera in a selected group. */
  selectedIds: ReadonlySet<string>
  onSelect: (cluster: MapCluster) => void
  /** A click on open ground. */
  onClearSelection?: () => void
  /** The district under the pointer, for the page to name; null on leaving. */
  onDistrictHover?: (district: string | null) => void
  framePadding?: FramePadding
}

interface MarkerParts {
  marker: maplibregl.Marker
  root: HTMLDivElement
  dot: HTMLSpanElement
  statusRing: HTMLSpanElement
  selectRing: HTMLSpanElement
  label: HTMLSpanElement
  /** Dot diameter. */
  size: number
  /** The clickable box around it — never smaller than a fingertip. */
  hit: number
}

interface Hover {
  cluster: MapCluster
  x: number
  y: number
  size: number
}

const CameraMap = forwardRef<CameraMapHandle, Props>(function CameraMap(
  {
    cameras,
    districts,
    basemap,
    onSatelliteUnavailable,
    heatmap = null,
    showHeatmap = false,
    corridorTraffic = null,
    showTraffic = false,
    selectedIds,
    onSelect,
    onClearSelection,
    onDistrictHover,
    framePadding = DEFAULT_PADDING,
  },
  ref,
) {
  const container = useRef<HTMLDivElement>(null)
  const mapRef = useRef<maplibregl.Map | null>(null)
  const markers = useRef(new Map<string, MarkerParts>())
  const clustersRef = useRef<MapCluster[]>([])
  const fitted = useRef(false)
  const [ready, setReady] = useState(false)
  const [hover, setHover] = useState<Hover | null>(null)

  // Latest props, for handlers registered once with MapLibre or a marker and
  // for sources that arrive after the props they should be drawn with.
  const latest = useRef({
    cameras,
    selectedIds,
    basemap,
    corridorTraffic,
    showTraffic,
    framePadding,
    onSelect,
    onClearSelection,
    onDistrictHover,
  })
  latest.current = {
    cameras,
    selectedIds,
    basemap,
    corridorTraffic,
    showTraffic,
    framePadding,
    onSelect,
    onClearSelection,
    onDistrictHover,
  }

  // ── The map, once ────────────────────────────────────────────────────
  useEffect(() => {
    if (!container.current || mapRef.current) return
    const map = new maplibregl.Map({
      container: container.current,
      style: baseStyle({ ground: GROUND, dim: true }),
      center: GUJARAT_CENTER,
      zoom: 6.6,
      minZoom: 4.5,
      maxZoom: 18,
      attributionControl: false,
      // A camera estate is read north-up; a map that rotates under a stray
      // right-drag only ever confuses.
      dragRotate: false,
      pitchWithRotate: false,
    })
    map.touchZoomRotate.disableRotation()
    // Zoom buttons are drawn by this component, in the console's own chrome.
    // MapLibre's scale and attribution are kept — the scale's arithmetic and
    // the imagery credit are theirs to get right — and restyled in place:
    // maplibre-gl.css paints them white, and the attribution's rule is more
    // specific than a utility, hence the `!`.
    map.addControl(new maplibregl.AttributionControl({ compact: false }), 'bottom-right')
    map.addControl(new maplibregl.ScaleControl({ maxWidth: 110, unit: 'metric' }), 'bottom-left')
    for (const el of map.getContainer().querySelectorAll<HTMLElement>('.maplibregl-ctrl-scale')) {
      el.classList.add('rounded-b-sm', 'border', 'border-t-0', 'border-input', 'bg-card/90', 'text-faint')
    }
    for (const el of map.getContainer().querySelectorAll<HTMLElement>('.maplibregl-ctrl-attrib')) {
      el.classList.add('!bg-card/80', 'text-[10px]', 'text-faint')
    }
    map.on('load', () => setReady(true))
    // A click on a marker is stopped by the marker; this only sees open ground.
    map.on('click', () => latest.current.onClearSelection?.())
    map.on('movestart', () => setHover(null))
    mapRef.current = map

    // The map's box changes when the page's side panel does; MapLibre only
    // notices the window.
    const observer = new ResizeObserver(() => map.resize())
    observer.observe(container.current)

    const owned = markers.current
    return () => {
      observer.disconnect()
      for (const parts of owned.values()) parts.marker.remove()
      owned.clear()
      map.remove()
      mapRef.current = null
      fitted.current = false
      setReady(false)
    }
  }, [])

  // ── Ground: the districts ────────────────────────────────────────────
  useEffect(() => {
    const map = mapRef.current
    if (!map || !ready || !districts || map.getSource('districts')) return

    map.addSource('districts', { type: 'geojson', data: districts })
    // Beneath any analytics layer already on the map.
    const before = overlayFloor(map)
    map.addLayer(
      { id: 'district-fill', type: 'fill', source: 'districts', paint: { 'fill-color': LAND } },
      before,
    )
    map.addLayer(
      {
        id: 'district-hover',
        type: 'fill',
        source: 'districts',
        paint: { 'fill-color': MARKER_FILL, 'fill-opacity': 0.05 },
        filter: ['==', ['get', 'district'], ''],
      },
      before,
    )
    map.addLayer(
      {
        id: 'district-outline',
        type: 'line',
        source: 'districts',
        paint: {
          'line-color': BOUNDARY,
          'line-width': ['interpolate', ['linear'], ['zoom'], 6, 0.7, 12, 1.4],
        },
      },
      before,
    )
    styleBasemap(map, latest.current.basemap)

    let hovered = ''
    map.on('mousemove', 'district-fill', (event) => {
      const name = String(event.features?.[0]?.properties?.district ?? '')
      if (name === hovered) return
      hovered = name
      map.setFilter('district-hover', ['==', ['get', 'district'], name])
      latest.current.onDistrictHover?.(name || null)
    })
    map.on('mouseleave', 'district-fill', () => {
      hovered = ''
      map.setFilter('district-hover', ['==', ['get', 'district'], ''])
      latest.current.onDistrictHover?.(null)
    })
  }, [ready, districts])

  // ── Detection-density heatmap (traffic analytics) ───────────────────
  //
  // A second weighting of the same points the markers already draw, not a
  // different dataset — see HeatmapResponse's own docstring. Built once the
  // data arrives and updated in place after that; visibility is a separate
  // effect so toggling it never touches the source. The markers are HTML, so
  // they always sit above it.
  useEffect(() => {
    const map = mapRef.current
    if (!map || !ready || !heatmap) return

    const existing = map.getSource('analytics-heatmap') as maplibregl.GeoJSONSource | undefined
    if (existing) {
      existing.setData(heatmap)
      return
    }
    map.addSource('analytics-heatmap', { type: 'geojson', data: heatmap })
    map.addLayer(
      {
        id: 'analytics-heatmap-layer',
        type: 'heatmap',
        source: 'analytics-heatmap',
        layout: { visibility: showHeatmap ? 'visible' : 'none' },
        paint: {
          // `intensity` is already 0-1, relative to the busiest camera in the
          // window — exactly what a heatmap weight wants.
          'heatmap-weight': ['coalesce', ['get', 'intensity'], 0],
          'heatmap-intensity': ['interpolate', ['linear'], ['zoom'], 6, 1, 14, 3],
          'heatmap-radius': ['interpolate', ['linear'], ['zoom'], 6, 16, 14, 40],
          'heatmap-opacity': 0.8,
          'heatmap-color': [
            'interpolate',
            ['linear'],
            ['heatmap-density'],
            ...HEATMAP_STOPS.flat(),
          ] as unknown as maplibregl.ExpressionSpecification,
        },
      },
      // Below the corridor linework, so a road stays readable over the glow.
      map.getLayer('corridor-traffic-layer') ? 'corridor-traffic-layer' : undefined,
    )
  }, [ready, heatmap, showHeatmap])

  useEffect(() => {
    const map = mapRef.current
    if (!map || !ready || !map.getLayer('analytics-heatmap-layer')) return
    map.setLayoutProperty('analytics-heatmap-layer', 'visibility', showHeatmap ? 'visible' : 'none')
  }, [ready, showHeatmap])

  // ── Corridor traffic state ──────────────────────────────────────────
  //
  // The corridors the Ahmedabad fleet was laid out on, coloured by
  // congestion. Linework comes from `web/public/data/ahmedabad_corridors.geojson`
  // (`scripts/filter_corridor_roads.py`, filtered from the OSM arterial
  // network); the colour from `/analytics/traffic`, joined on the OSM road
  // name, which is exactly what `cameras.corridor` holds. A local file like
  // the districts, so the offline guarantee holds — and fetched only the
  // first time the layer is switched on.
  useEffect(() => {
    const map = mapRef.current
    if (!map || !ready || !showTraffic || map.getSource('corridor-traffic')) return

    let cancelled = false
    void fetch('/data/ahmedabad_corridors.geojson')
      .then((r) => (r.ok ? (r.json() as Promise<GeoJSON.FeatureCollection>) : null))
      .then((data) => {
        const m = mapRef.current
        if (cancelled || !data || !m || m.getSource('corridor-traffic')) return
        m.addSource('corridor-traffic', { type: 'geojson', data })
        m.addLayer({
          id: 'corridor-traffic-layer',
          type: 'line',
          source: 'corridor-traffic',
          layout: {
            // The toggle may have been switched off again while this loaded.
            visibility: latest.current.showTraffic ? 'visible' : 'none',
            'line-cap': 'round',
            'line-join': 'round',
          },
          paint: {
            // Recoloured from `corridorTraffic` by the effect below. Until
            // then every road is "no figure" — never the flowing grey, which
            // would read as "measured, and fine" on a road nothing measured.
            'line-color': NO_FIGURE_COLOUR,
            'line-width': ['interpolate', ['linear'], ['zoom'], 9, 1.2, 14, 2.5],
            'line-opacity': 0.9,
          },
        })
        // The figures may well have arrived before the linework did.
        paintCorridors(m, latest.current.corridorTraffic)
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [ready, showTraffic])

  // Recolour without rebuilding: a `match` over the corridor name carried on
  // each line feature. Rebuilding the source on every poll would re-parse
  // hundreds of features for a colour change.
  useEffect(() => {
    const map = mapRef.current
    if (!map || !ready) return
    paintCorridors(map, corridorTraffic)
  }, [ready, corridorTraffic])

  useEffect(() => {
    const map = mapRef.current
    if (!map || !ready || !map.getLayer('corridor-traffic-layer')) return
    map.setLayoutProperty('corridor-traffic-layer', 'visibility', showTraffic ? 'visible' : 'none')
  }, [ready, showTraffic])

  // ── Basemap switching ───────────────────────────────────────────────
  useEffect(() => {
    const map = mapRef.current
    if (!map || !ready) return
    styleBasemap(map, basemap)
  }, [ready, basemap])

  // Fall back before the operator is left staring at a blank map.
  useEffect(() => {
    if (basemap !== 'satellite') return
    let cancelled = false
    void satelliteReachable().then((ok) => {
      if (!ok && !cancelled) onSatelliteUnavailable?.()
    })
    return () => {
      cancelled = true
    }
  }, [basemap, onSatelliteUnavailable])

  // ── Markers ─────────────────────────────────────────────────────────
  const paintMarkers = useCallback(() => {
    const selected = latest.current.selectedIds
    for (const cluster of clustersRef.current) {
      const parts = markers.current.get(cluster.key)
      if (!parts) continue
      const tone = clusterTone(cluster.cameras)
      parts.dot.style.background = tone === 'unknown' ? MARKER_FILL_DIM : MARKER_FILL
      parts.statusRing.classList.toggle('hidden', tone !== 'offline' && tone !== 'degraded')
      parts.statusRing.classList.toggle('border-status-offline', tone === 'offline')
      parts.statusRing.classList.toggle('border-status-degraded', tone === 'degraded')
      const isSelected = cluster.cameras.some((camera) => selected.has(camera.id))
      parts.selectRing.classList.toggle('hidden', !isSelected)
      parts.label.classList.toggle('text-foreground', isSelected)
      parts.label.classList.toggle('text-muted-foreground', !isSelected)
      parts.root.style.zIndex = isSelected ? '2' : ''
    }
  }, [])

  const showHover = useCallback((key: string | null) => {
    const map = mapRef.current
    if (key === null || !map) {
      setHover(null)
      return
    }
    const cluster = clustersRef.current.find((c) => c.key === key)
    const parts = markers.current.get(key)
    if (!cluster || !parts) return
    const p = map.project([cluster.lon, cluster.lat])
    // Keep the card inside the map: it is centred on the marker, and a
    // marker near either edge would otherwise push half of it out of view.
    const width = map.getContainer().clientWidth
    const half = 140
    const x = width > 2 * half ? Math.min(Math.max(p.x, half), width - half) : p.x
    setHover({ cluster, x, y: p.y, size: parts.size })
  }, [])

  const activate = useCallback((key: string) => {
    const cluster = clustersRef.current.find((c) => c.key === key)
    if (!cluster) return
    setHover(null)
    latest.current.onSelect(cluster)
  }, [])

  const recluster = useCallback(() => {
    const map = mapRef.current
    if (!map) return
    const clusters = clusterSpots(spotsOf(latest.current.cameras), (lon, lat) =>
      map.project([lon, lat]),
    )
    clustersRef.current = clusters

    const wanted = new Set(clusters.map((c) => c.key))
    for (const [key, parts] of markers.current) {
      if (!wanted.has(key)) {
        parts.marker.remove()
        markers.current.delete(key)
      }
    }
    for (const cluster of clusters) {
      const size = dotSize(cluster.cameras.length)
      let parts = markers.current.get(cluster.key)
      if (!parts || parts.size !== size) {
        parts?.marker.remove()
        parts = buildMarker(cluster.key, size, { activate, hover: showHover })
        parts.marker.setLngLat([cluster.lon, cluster.lat]).addTo(map)
        markers.current.set(cluster.key, parts)
      } else {
        parts.marker.setLngLat([cluster.lon, cluster.lat])
      }
      fillLabel(parts.label, cluster)
      parts.root.setAttribute('aria-label', describe(cluster))
    }
    paintMarkers()
    layoutLabels(map, clusters, markers.current)
  }, [activate, paintMarkers, showHover])

  useEffect(() => {
    const map = mapRef.current
    if (!map || !ready) return
    // Frame the network the first time it is known, not on every refresh — an
    // operator who has zoomed in should stay zoomed in.
    if (!fitted.current) {
      const spots = spotsOf(cameras)
      if (spots.length > 0) {
        fitted.current = true
        frame(
          map,
          spots.map((s) => [s.lon, s.lat]),
          latest.current.framePadding,
          8.5,
          0,
        )
      }
    }
    recluster()
  }, [ready, cameras, recluster])

  useEffect(() => {
    if (ready) paintMarkers()
  }, [ready, selectedIds, paintMarkers])

  // Groups change with zoom; labels move out of each other's way with it.
  useEffect(() => {
    const map = mapRef.current
    if (!map || !ready) return
    const relayout = () => layoutLabels(map, clustersRef.current, markers.current)
    map.on('zoomend', recluster)
    map.on('resize', relayout)
    // Labels were measured in the fallback face if the webfont was still on
    // its way; measure again once it is here.
    void document.fonts?.ready.then(relayout)
    return () => {
      map.off('zoomend', recluster)
      map.off('resize', relayout)
    }
  }, [ready, recluster])

  useImperativeHandle(
    ref,
    () => ({
      focusCamera(camera) {
        const map = mapRef.current
        if (!map || isUnplaced(camera)) return
        // An explicit request outranks the first-load framing.
        fitted.current = true
        // Close enough to separate a camera from its town's centre, far
        // enough out that the district outlines still give it a place.
        map.flyTo({
          center: [camera.lon, camera.lat],
          zoom: Math.max(map.getZoom(), 11),
          duration: 900,
        })
      },
      frameCameras(list) {
        const map = mapRef.current
        if (!map) return
        const coords = list
          .filter((camera) => !isUnplaced(camera))
          .map((camera) => [camera.lon, camera.lat] as [number, number])
        if (coords.length === 0) return
        fitted.current = true
        frame(map, coords, latest.current.framePadding, 14, 900)
      },
    }),
    [],
  )

  return (
    <div className="absolute inset-0">
      <div ref={container} className="absolute inset-0" />
      {hover && <MarkerTooltip hover={hover} />}
      <div className="absolute bottom-8 right-3 z-10 flex flex-col overflow-hidden rounded-md border border-border bg-card shadow-lg">
        <button
          type="button"
          aria-label="Zoom in"
          onClick={() => mapRef.current?.zoomIn()}
          className="flex h-8 w-8 items-center justify-center text-muted-foreground transition hover:bg-secondary hover:text-foreground"
        >
          <Icon name="plus" size={15} />
        </button>
        <button
          type="button"
          aria-label="Zoom out"
          onClick={() => mapRef.current?.zoomOut()}
          className="flex h-8 w-8 items-center justify-center border-t border-border text-muted-foreground transition hover:bg-secondary hover:text-foreground"
        >
          <span aria-hidden="true" className="h-[1.5px] w-[11px] rounded-full bg-current" />
        </button>
      </div>
    </div>
  )
})

export default CameraMap

// ── Marker construction ─────────────────────────────────────────────────

function buildMarker(
  key: string,
  size: number,
  on: { activate: (key: string) => void; hover: (key: string | null) => void },
): MarkerParts {
  const hit = Math.max(24, size + 12)

  const root = document.createElement('div')
  // No `relative` here: MapLibre positions the marker with
  // `.maplibregl-marker { position: absolute }`, and Tailwind's utilities load
  // after maplibre-gl.css, so `relative` would win and drop every marker into
  // document flow — each one pushed down by the height of the ones before it.
  // Absolute positioning already makes it the containing block for its parts.
  root.className = 'group cursor-pointer rounded-full'
  root.style.width = `${hit}px`
  root.style.height = `${hit}px`
  root.setAttribute('role', 'button')
  root.tabIndex = 0

  const centred = 'pointer-events-none absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 rounded-full'

  const selectRing = document.createElement('span')
  selectRing.className = `${centred} hidden border-[1.5px] border-primary`
  selectRing.style.width = `${size + 18}px`
  selectRing.style.height = `${size + 18}px`

  const statusRing = document.createElement('span')
  statusRing.className = `${centred} hidden border-[1.5px]`
  statusRing.style.width = `${size + 9}px`
  statusRing.style.height = `${size + 9}px`

  const dot = document.createElement('span')
  dot.className = `${centred} shadow-[0_0_0_2px_hsl(var(--background))] transition-transform duration-150 group-hover:scale-125`
  dot.style.width = `${size}px`
  dot.style.height = `${size}px`
  dot.style.background = MARKER_FILL

  const label = document.createElement('span')
  label.className =
    'pointer-events-none absolute whitespace-nowrap text-[12px] leading-none text-muted-foreground [text-shadow:0_1px_2px_hsl(var(--background)),0_0_6px_hsl(var(--background))]'

  root.append(selectRing, statusRing, dot, label)

  const select = (event: Event) => {
    // Stopped here so the map's own click — which clears the selection —
    // never sees a click on a marker.
    event.stopPropagation()
    event.preventDefault()
    on.activate(key)
  }
  root.addEventListener('click', select)
  root.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ' ') select(event)
  })
  root.addEventListener('mouseenter', () => on.hover(key))
  root.addEventListener('mouseleave', () => on.hover(null))
  root.addEventListener('focus', () => on.hover(key))
  root.addEventListener('blur', () => on.hover(null))

  // A marker must have a position before it is added to a map; the caller
  // sets the real one straight away.
  const marker = new maplibregl.Marker({ element: root, anchor: 'center' }).setLngLat([0, 0])
  return { marker, root, dot, statusRing, selectRing, label, size, hit }
}

function fillLabel(label: HTMLSpanElement, cluster: MapCluster): void {
  // Text nodes, never innerHTML: names come from a third party's catalogue.
  label.replaceChildren(document.createTextNode(cluster.name))
  const count = cluster.cameras.length
  if (count > 1) {
    const n = document.createElement('span')
    n.className = 'ml-1.5 font-mono text-[11px] text-faint'
    n.textContent = String(count)
    label.append(n)
  }
  label.classList.toggle('font-medium', count >= 4)
  label.classList.toggle('text-[13px]', count >= 4)
  label.classList.toggle('text-[12px]', count < 4)
}

function describe(cluster: MapCluster): string {
  const count = cluster.cameras.length
  return `${cluster.name}: ${count} camera${count === 1 ? '' : 's'}, ${statusSummary(cluster.cameras)}`
}

// ── Label placement ─────────────────────────────────────────────────────

interface Box {
  x: number
  y: number
  w: number
  h: number
}

type Side = 'right' | 'left' | 'top' | 'bottom'

function overlaps(a: Box, b: Box): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h
}

/**
 * Put each label on the first side of its dot where it collides with nothing
 * already placed — dots first, then labels, biggest group first. A small
 * place whose every side is taken keeps its dot and loses its label until
 * the operator zooms in; a label drawn over another is worse than none.
 */
function layoutLabels(
  map: maplibregl.Map,
  clusters: MapCluster[],
  markers: Map<string, MarkerParts>,
): void {
  const taken: Box[] = []
  const placed = clusters.map((cluster) => {
    const p = map.project([cluster.lon, cluster.lat])
    const parts = markers.get(cluster.key)
    const r = (parts?.size ?? 8) / 2 + 3
    taken.push({ x: p.x - r, y: p.y - r, w: 2 * r, h: 2 * r })
    return { cluster, p, parts }
  })

  for (const { cluster, p, parts } of placed) {
    if (!parts) continue
    const { label, size, hit } = parts
    const w = label.offsetWidth
    const h = label.offsetHeight
    // Far enough out to clear the selection ring, which is the widest part.
    const reach = (size + 18) / 2 + 3
    const options: [Side, Box][] = [
      ['right', { x: p.x + reach, y: p.y - h / 2, w, h }],
      ['left', { x: p.x - reach - w, y: p.y - h / 2, w, h }],
      ['top', { x: p.x - w / 2, y: p.y - reach - h, w, h }],
      ['bottom', { x: p.x - w / 2, y: p.y + reach, w, h }],
    ]
    // A big place keeps its label even when crowded: its name is the one an
    // operator is looking for.
    const chosen =
      options.find(([, box]) => !taken.some((t) => overlaps(t, box))) ??
      (cluster.cameras.length >= 4 ? options[0] : undefined)
    if (!chosen) {
      label.style.visibility = 'hidden'
      continue
    }
    label.style.visibility = 'visible'
    taken.push(chosen[1])
    placeLabel(label, chosen[0], hit / 2 + reach)
  }
}

/** `offset` is measured from the marker box's edge-centre to the label. */
function placeLabel(label: HTMLSpanElement, side: Side, offset: number): void {
  label.style.left = label.style.right = label.style.top = label.style.bottom = ''
  if (side === 'right' || side === 'left') {
    label.style.top = '50%'
    label.style.transform = 'translateY(-50%)'
    label.style[side === 'right' ? 'left' : 'right'] = `${offset}px`
  } else {
    label.style.left = '50%'
    label.style.transform = 'translateX(-50%)'
    label.style[side === 'top' ? 'bottom' : 'top'] = `${offset}px`
  }
}

// ── Map helpers ─────────────────────────────────────────────────────────

/** The lowest analytics layer, so the ground can be slid in beneath it. */
function overlayFloor(map: maplibregl.Map): string | undefined {
  for (const id of ['analytics-heatmap-layer', 'corridor-traffic-layer']) {
    if (map.getLayer(id)) return id
  }
  return undefined
}

function setVisible(map: maplibregl.Map, id: string, visible: boolean): void {
  if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', visible ? 'visible' : 'none')
}

function styleBasemap(map: maplibregl.Map, basemap: Basemap): void {
  const satellite = basemap === 'satellite'
  setVisible(map, 'satellite', satellite)
  setVisible(map, 'satellite-labels', satellite)
  // The imagery's own place names sit exactly where the grid's town-centre
  // cameras are, so at full strength every such town is named twice. Faded,
  // they still name the towns with no camera.
  if (map.getLayer('satellite-labels')) {
    map.setPaintProperty('satellite-labels', 'raster-opacity', 0.45)
  }
  // The land fill would hide the imagery; the outlines stay in both modes,
  // because district context is half of what this map is for.
  setVisible(map, 'district-fill', !satellite)
  setVisible(map, 'district-hover', !satellite)
  if (map.getLayer('district-outline')) {
    map.setPaintProperty('district-outline', 'line-color', satellite ? BOUNDARY_ON_IMAGERY : BOUNDARY)
    map.setPaintProperty('district-outline', 'line-opacity', satellite ? 0.4 : 1)
  }
}

function paintCorridors(
  map: maplibregl.Map,
  levels: Record<string, CongestionLevel> | null | undefined,
): void {
  if (!map.getLayer('corridor-traffic-layer')) return
  const entries = Object.entries(levels ?? {})
  const pairs = entries.flatMap(([corridor, level]) => [
    corridor,
    CONGESTION_COLOUR[level] ?? NO_FIGURE_COLOUR,
  ])
  // `match` needs at least one case; with nothing measured the whole network
  // stays "no figure". Measured roads are drawn heavier than unmeasured ones.
  const measured = entries.map(([corridor]) => corridor)
  map.setPaintProperty(
    'corridor-traffic-layer',
    'line-color',
    pairs.length > 0 ? ['match', ['get', 'corridor'], ...pairs, NO_FIGURE_COLOUR] : NO_FIGURE_COLOUR,
  )
  map.setPaintProperty(
    'corridor-traffic-layer',
    'line-width',
    measured.length > 0
      ? [
          'interpolate',
          ['linear'],
          ['zoom'],
          9,
          ['match', ['get', 'corridor'], measured, 2.4, 1.2],
          14,
          ['match', ['get', 'corridor'], measured, 6, 2.5],
        ]
      : ['interpolate', ['linear'], ['zoom'], 9, 1.2, 14, 2.5],
  )
}

/** Frame coordinates: onto the spot when they share one, else fit them all. */
function frame(
  map: maplibregl.Map,
  coords: [number, number][],
  padding: FramePadding,
  maxZoom: number,
  duration: number,
): void {
  const [first] = coords
  if (!first) return
  const distinct = new Set(coords.map(([lon, lat]) => `${lon.toFixed(5)},${lat.toFixed(5)}`))
  if (distinct.size === 1) {
    map.easeTo({
      center: first,
      zoom: Math.max(map.getZoom(), Math.min(maxZoom, 11)),
      duration,
    })
    return
  }
  const bounds = new maplibregl.LngLatBounds(first, first)
  for (const coord of coords) bounds.extend(coord)
  map.fitBounds(bounds, { padding, maxZoom, duration })
}

// ── Hover card ──────────────────────────────────────────────────────────

function MarkerTooltip({ hover }: { hover: Hover }) {
  const { cluster } = hover
  const [only] = cluster.cameras
  const below = hover.y < 150
  const count = cluster.cameras.length
  const spread = cluster.colocated
    ? cluster.townLevel
      ? 'All at the town’s centre: the grid gives no junction'
      : 'All registered at one point'
    : `${cluster.spots} positions, too close to separate at this zoom`

  return (
    <div
      className={`pointer-events-none absolute z-20 -translate-x-1/2 ${below ? '' : '-translate-y-full'}`}
      style={{
        left: hover.x,
        top: below ? hover.y + hover.size / 2 + 14 : hover.y - hover.size / 2 - 14,
      }}
    >
      <div className="w-max max-w-[17rem] rounded-md border border-border bg-popover px-3 py-2 shadow-xl">
        {count === 1 && only ? (
          <>
            <div className="flex items-center gap-2">
              <span className="camera-code text-[11px] text-muted-foreground">{only.camera_code}</span>
              <StatusBadge status={only.status} label={STATUS_LABEL[only.status]} />
            </div>
            <p className="mt-1 text-[13px] leading-snug text-foreground">{only.name}</p>
            {placeLine(only) && <p className="mt-0.5 text-[11px] text-faint">{placeLine(only)}</p>}
            {cluster.townLevel && (
              <p className="mt-1 text-[11px] text-faint">Position known to the town only</p>
            )}
          </>
        ) : (
          <>
            <p className="text-[13px] font-medium text-foreground">
              {cluster.name}
              <span className="ml-1.5 font-mono text-[11px] font-normal text-faint">{count}</span>
            </p>
            <p className="mt-0.5 text-[11px] text-muted-foreground">{statusSummary(cluster.cameras)}</p>
            <p className="mt-1 text-[11px] text-faint">{spread}</p>
          </>
        )}
      </div>
    </div>
  )
}
