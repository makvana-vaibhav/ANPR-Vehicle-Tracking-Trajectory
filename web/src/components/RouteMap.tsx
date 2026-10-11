/**
 * A reconstructed journey, drawn.
 *
 * ## The one thing this must not do
 *
 * It must not draw a route that looks like it followed the roads. The
 * correlator has no road network: it knows a vehicle was at camera A and later
 * at camera B, and nothing whatever about the path between them. Rendering a
 * smooth road-shaped line would be the map asserting evidence that does not
 * exist, and a route map is exactly the artefact somebody would put in front of
 * a court.
 *
 * So every leg is **straight** — literally what is known: two endpoints — and
 * the legend on the map says in words that these are not the roads driven.
 * The legs used to be dashed for the same reason. The trail is now one solid
 * line that fades towards its oldest end (a contrail: which way the vehicle
 * went, and where it was last, at a glance), because MapLibre cannot dash a
 * gradient; the dashes are kept for what the platform does not believe.
 *
 * Legs the correlator could not believe are cut out of the trail and drawn red
 * and dashed, labelled with why. They are the ones worth looking at — an
 * impossible leg is what a cloned plate looks like.
 *
 * Every label is HTML: a symbol layer would need a glyph server (CLAUDE.md §6).
 */

import maplibregl, { type ExpressionSpecification } from 'maplibre-gl'
import 'maplibre-gl/dist/maplibre-gl.css'
import {
  forwardRef,
  useCallback,
  useEffect,
  useId,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react'

import {
  groupStops,
  journeyTrail,
  legSummary,
  sequenceLabel,
  stopCaption,
  timelineTicks,
  trailGradient,
  travelledTrail,
  type StopGroup,
} from '@/components/routeTrail'
import { Icon, SegmentedControl } from '@/components/ui'
import * as api from '@/lib/api'
import {
  applyBasemap,
  baseStyle,
  GUJARAT_CENTER,
  satelliteReachable,
  type Basemap,
} from '@/lib/basemap'
import { buildTimeline, istClock, journeySeconds, positionAt } from '@/lib/journey'
import type { RouteHop } from '@/lib/types'

/*
  The map's palette. MapLibre paint specs cannot take Tailwind classes, so the
  tokens they need are restated here, once: TRAIL is --primary, IMPOSSIBLE is
  --priority-critical, GROUND is --background, and STOP is the light grey the
  design language gives a camera on a map. Retune them with index.css.
*/
const TRAIL_RGB = [92, 200, 255] as const // #5CC8FF
const TRAIL = '#5CC8FF'
const IMPOSSIBLE = '#FF5C55'
const GROUND = '#0A0E13'
const STOP = '#C9D3DD'
// The offline basemap: land a step above the ground, its edges and the city's
// arterial roads a step above that — context, never competing with a trail.
const LAND = '#0F1620'
const LAND_EDGE = '#1F2A36'
const ROAD = '#2A3644'

const EMPTY: GeoJSON.FeatureCollection = { type: 'FeatureCollection', features: [] }

/**
 * Wall-clock seconds the whole journey takes to play back.
 *
 * Playback is **proportional to real elapsed time**, not one step per hop: a
 * four-minute leg takes eight times as long to cross as a thirty-second one.
 * Stepping uniformly per hop would be easier and would quietly misrepresent the
 * journey, making a vehicle that sat at a junction for ten minutes look like it
 * drove straight through.
 */
const PLAYBACK_SECONDS = 16

/** Past this many labelled legs, only impossible and selected legs keep a label. */
const MAX_LEG_LABELS = 4

export interface RouteMapHandle {
  /** Play the journey from its first sighting. */
  replay: () => void
  pause: () => void
  /** Frame the whole journey again after the operator has panned away. */
  fit: () => void
  /** Centre on one visit. */
  focus: (sequence: number) => void
}

interface Props {
  hops: RouteHop[]
  /** The basemap to start on; the operator can switch, and satellite falls back by itself. */
  basemap?: Basemap
  /** The visit hovered or selected beside the map, ringed on it. */
  activeSequence?: number | null
  onSelectHop?: (sequence: number) => void
  /** So a replay control elsewhere on the page can say what it will do. */
  onPlayingChange?: (playing: boolean) => void
  /**
   * Drawn over the map — a prompt before any search, or why there is nothing
   * to draw. The layer ignores the pointer; interactive children opt back in
   * with `pointer-events-auto`.
   */
  children?: ReactNode
}

function lineOf(coordinates: [number, number][]): GeoJSON.FeatureCollection {
  return coordinates.length < 2
    ? EMPTY
    : {
        type: 'FeatureCollection',
        features: [{ type: 'Feature', geometry: { type: 'LineString', coordinates }, properties: {} }],
      }
}

function setData(m: maplibregl.Map, source: string, data: GeoJSON.FeatureCollection) {
  ;(m.getSource(source) as maplibregl.GeoJSONSource | undefined)?.setData(data)
}

/** Radius of a stop's dot, wide enough for the visit numbers it carries. */
function radiusFor(label: string): number {
  if (label.length <= 1) return 9
  if (label.length <= 3) return 11
  if (label.length <= 5) return 13
  return 15
}

type Look = 'start' | 'end' | 'via' | 'impossible'

function lookOf(group: StopGroup): Look {
  return group.impossible ? 'impossible' : group.role
}

/** Ink for the visit numbers, against each look's fill (see the paint spec). */
const NUMBER_INK: Record<Look, string> = {
  start: 'text-foreground',
  via: 'text-background',
  end: 'text-primary-foreground',
  impossible: 'text-priority-critical',
}

const TAG = 'pointer-events-none absolute left-full top-1/2 ml-2 -translate-y-1/2 whitespace-nowrap rounded bg-background/80 px-1.5 py-0.5 font-mono text-[10px] font-normal shadow'

const LEG_TAG = 'pointer-events-none whitespace-nowrap rounded px-1.5 py-0.5 font-mono text-[10px] shadow'

const RouteMap = forwardRef<RouteMapHandle, Props>(function RouteMap(
  { hops, basemap = 'satellite', activeSequence = null, onSelectHop, onPlayingChange, children },
  ref,
) {
  const container = useRef<HTMLDivElement>(null)
  const map = useRef<maplibregl.Map | null>(null)
  const stopMarkers = useRef<{ group: StopGroup; marker: maplibregl.Marker; tag: HTMLElement }[]>([])
  const legMarkers = useRef<{ sequence: number; impossible: boolean; marker: maplibregl.Marker }[]>([])
  const vehicle = useRef<maplibregl.Marker | null>(null)
  const legend = useRef<HTMLDivElement>(null)
  // React's ids carry colons, which an SVG `url(#…)` reference can trip on.
  const swatch = `route-trail-${useId().replace(/:/g, '')}`
  const [ready, setReady] = useState(false)
  const [choice, setChoice] = useState<Basemap>(basemap)
  const [effective, setEffective] = useState<Basemap>(basemap)

  // The latest callbacks, read by marker handlers created once per journey —
  // otherwise every hover in the list would rebuild every marker.
  const onSelect = useRef(onSelectHop)
  onSelect.current = onSelectHop
  const active = useRef(activeSequence)
  active.current = activeSequence

  // ── Playback ────────────────────────────────────────────────────────
  const [playing, setPlaying] = useState(false)
  /** Position along the journey, in seconds since the first sighting. */
  const [playhead, setPlayhead] = useState(0)

  const timeline = useMemo(() => buildTimeline(hops), [hops])
  const groups = useMemo(() => groupStops(hops), [hops])
  const totalSeconds = journeySeconds(timeline)
  // Playing a vehicle that never left one camera would be a dot sitting still
  // for sixteen seconds; the timeline below still shows when it came back.
  const canPlay = totalSeconds > 0 && groups.length > 1
  const engaged = canPlay && (playing || playhead > 0)

  useEffect(() => {
    onPlayingChange?.(playing)
  }, [playing, onPlayingChange])

  // Reset when a different journey is loaded.
  useEffect(() => {
    setPlaying(false)
    setPlayhead(0)
  }, [hops])

  // Advance the playhead. requestAnimationFrame rather than setInterval so the
  // marker moves smoothly and stops costing anything when the tab is hidden.
  useEffect(() => {
    if (!playing || totalSeconds <= 0) return
    let frame = 0
    let previous = performance.now()
    const rate = totalSeconds / PLAYBACK_SECONDS

    const tick = (now: number) => {
      const delta = (now - previous) / 1000
      previous = now
      setPlayhead((current) => {
        const next = current + delta * rate
        if (next >= totalSeconds) {
          setPlaying(false)
          return totalSeconds
        }
        return next
      })
      frame = requestAnimationFrame(tick)
    }
    frame = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(frame)
  }, [playing, totalSeconds])

  const togglePlay = useCallback(() => {
    if (!canPlay) return
    // Replay from the start once it has run to the end, rather than sitting on
    // the final frame doing nothing when pressed.
    if (!playing && playhead >= totalSeconds) setPlayhead(0)
    setPlaying((p) => !p)
  }, [canPlay, playing, playhead, totalSeconds])

  const frame = useCallback(
    (duration = 600) => {
      const m = map.current
      if (!m) return
      // The journey usually arrives in the same render that resizes this
      // map's column (the summary above it grows, the sightings appear
      // beside it). MapLibre would frame against its old size and cut the
      // ends off, so it measures again first.
      m.resize()
      if (groups.length === 0) {
        m.easeTo({ center: GUJARAT_CENTER, zoom: 6.2, duration })
      } else if (groups.length === 1) {
        const only = groups[0]!
        m.easeTo({ center: [only.lon, only.lat], zoom: Math.max(m.getZoom(), 14), duration })
      } else {
        const bounds = new maplibregl.LngLatBounds()
        for (const g of groups) bounds.extend([g.lon, g.lat])
        // Clear of the legend at the top, and wider on the right, where each
        // stop's label hangs off its dot.
        const top = 28 + (legend.current?.offsetHeight ?? 0)
        m.fitBounds(bounds, {
          padding: { top, bottom: 40, left: 56, right: 150 },
          maxZoom: 15,
          duration,
        })
      }
    },
    [groups],
  )

  useImperativeHandle(
    ref,
    () => ({
      replay: () => {
        if (!canPlay) return
        setPlayhead(0)
        setPlaying(true)
      },
      pause: () => setPlaying(false),
      fit: () => frame(),
      focus: (sequence: number) => {
        const hop = hops[sequence]
        if (hop) map.current?.easeTo({ center: [hop.lon, hop.lat], duration: 500 })
      },
    }),
    [canPlay, frame, hops],
  )

  // ── Create the map once ─────────────────────────────────────────────
  useEffect(() => {
    if (map.current || !container.current) return
    const m = new maplibregl.Map({
      container: container.current,
      style: baseStyle({ ground: GROUND }),
      center: GUJARAT_CENTER,
      zoom: 6.2,
      attributionControl: false,
    })
    m.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'bottom-right')
    m.addControl(new maplibregl.AttributionControl({ compact: true }), 'bottom-left')
    m.on('load', () => setReady(true))
    map.current = m

    // The page lays this map out in a column that changes width when the
    // sightings appear beside it; MapLibre only notices window resizes.
    const observer =
      typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(() => m.resize())
    observer?.observe(container.current)

    return () => {
      observer?.disconnect()
      m.remove()
      map.current = null
    }
  }, [])

  // Satellite is an enhancement; a venue with hostile wifi still gets a map.
  useEffect(() => {
    if (!ready || choice !== 'satellite') {
      setEffective(choice)
      return
    }
    let cancelled = false
    void satelliteReachable().then((ok) => {
      if (!cancelled) setEffective(ok ? 'satellite' : 'offline')
    })
    return () => {
      cancelled = true
    }
  }, [ready, choice])

  useEffect(() => {
    if (ready && map.current) applyBasemap(map.current, effective)
  }, [ready, effective])

  // ── The offline basemap: districts and the city's arterial roads ─────
  //
  // Both from committed files under /data — no tile server, no network — and
  // laid beneath the satellite raster, so they show exactly when it does not.
  useEffect(() => {
    const m = map.current
    if (!m || !ready || m.getSource('context-land')) return
    m.addSource('context-land', { type: 'geojson', data: EMPTY })
    m.addSource('context-roads', { type: 'geojson', data: EMPTY })
    m.addLayer(
      { id: 'context-land', type: 'fill', source: 'context-land', paint: { 'fill-color': LAND } },
      'satellite',
    )
    m.addLayer(
      {
        id: 'context-land-edge',
        type: 'line',
        source: 'context-land',
        paint: {
          'line-color': LAND_EDGE,
          'line-width': ['interpolate', ['linear'], ['zoom'], 6, 0.8, 12, 1.4],
        },
      },
      'satellite',
    )
    m.addLayer(
      {
        id: 'context-roads',
        type: 'line',
        source: 'context-roads',
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: {
          'line-color': ROAD,
          'line-width': ['interpolate', ['linear'], ['zoom'], 9, 0.8, 15, 3],
        },
      },
      'satellite',
    )
    let cancelled = false
    for (const [source, file] of [
      ['context-land', '/data/gujarat_districts.geojson'],
      ['context-roads', '/data/ahmedabad_corridors.geojson'],
    ] as const) {
      void fetch(file)
        .then((r) => (r.ok ? r.json() : null))
        .then((data: GeoJSON.FeatureCollection | null) => {
          if (!cancelled && data && map.current) setData(map.current, source, data)
        })
        .catch(() => undefined)
    }
    return () => {
      cancelled = true
    }
  }, [ready])

  // ── Layers, created once ────────────────────────────────────────────
  useEffect(() => {
    const m = map.current
    if (!m || !ready || m.getSource('route-trail')) return

    // `lineMetrics` is what lets a line carry a gradient along its length.
    m.addSource('route-trail', { type: 'geojson', data: EMPTY, lineMetrics: true })
    m.addSource('route-travelled', { type: 'geojson', data: EMPTY, lineMetrics: true })
    m.addSource('route-impossible', { type: 'geojson', data: EMPTY })
    m.addSource('route-stops', { type: 'geojson', data: EMPTY })

    const placeholder: ExpressionSpecification = [
      'interpolate',
      ['linear'],
      ['line-progress'],
      0,
      TRAIL,
      1,
      TRAIL,
    ]
    const round = { 'line-cap': 'round', 'line-join': 'round' } as const

    m.addLayer({
      id: 'trail-glow',
      type: 'line',
      source: 'route-trail',
      layout: round,
      paint: {
        'line-width': 9,
        'line-blur': 6,
        'line-opacity': 0.35,
        'line-gradient': placeholder,
      },
    })
    m.addLayer({
      id: 'trail',
      type: 'line',
      source: 'route-trail',
      layout: round,
      paint: { 'line-width': 3, 'line-gradient': placeholder },
    })
    m.addLayer({
      id: 'impossible-legs',
      type: 'line',
      source: 'route-impossible',
      layout: { 'line-cap': 'butt', 'line-join': 'round' },
      paint: { 'line-color': IMPOSSIBLE, 'line-width': 2, 'line-dasharray': [2.5, 2] },
    })
    m.addLayer({
      id: 'travelled-glow',
      type: 'line',
      source: 'route-travelled',
      layout: round,
      paint: {
        'line-width': 10,
        'line-blur': 6,
        'line-opacity': 0.5,
        'line-gradient': placeholder,
      },
    })
    m.addLayer({
      id: 'travelled',
      type: 'line',
      source: 'route-travelled',
      layout: round,
      paint: { 'line-width': 3.5, 'line-gradient': placeholder },
    })
    // The selected visit's ring, a gap away from its dot.
    m.addLayer({
      id: 'stop-halo',
      type: 'circle',
      source: 'route-stops',
      paint: {
        'circle-radius': ['+', ['get', 'radius'], 5],
        'circle-color': 'rgba(0, 0, 0, 0)',
        'circle-stroke-color': TRAIL,
        'circle-stroke-width': 2,
        'circle-stroke-opacity': ['case', ['boolean', ['feature-state', 'active'], false], 1, 0],
      },
    })
    // First sighting hollow, last filled in the trail colour, the rest the
    // camera grey; reached by an impossible leg, ringed red.
    m.addLayer({
      id: 'stop-dot',
      type: 'circle',
      source: 'route-stops',
      paint: {
        'circle-radius': ['get', 'radius'],
        'circle-color': [
          'match',
          ['get', 'look'],
          'start',
          GROUND,
          'impossible',
          GROUND,
          'end',
          TRAIL,
          STOP,
        ],
        'circle-stroke-color': [
          'match',
          ['get', 'look'],
          'start',
          STOP,
          'impossible',
          IMPOSSIBLE,
          GROUND,
        ],
        'circle-stroke-width': ['match', ['get', 'look'], ['start', 'impossible'], 2, 1.5],
      },
    })
  }, [ready])

  // ── Draw the journey ────────────────────────────────────────────────
  useEffect(() => {
    const m = map.current
    if (!m || !ready || !m.getSource('route-trail')) return

    for (const { marker } of stopMarkers.current) marker.remove()
    for (const { marker } of legMarkers.current) marker.remove()
    stopMarkers.current = []
    legMarkers.current = []

    // The trail: every sighting in time order, brightness by time.
    const trail = journeyTrail(hops, timeline)
    const gradient = trailGradient(trail.vertices, trail.believed, TRAIL_RGB)
    setData(m, 'route-trail', gradient ? lineOf(hops.map((h) => [h.lon, h.lat])) : EMPTY)
    if (gradient) {
      m.setPaintProperty('trail', 'line-gradient', gradient)
      m.setPaintProperty('trail-glow', 'line-gradient', gradient)
    }

    // One feature per leg the correlator disbelieved, drawn over the gap the
    // trail leaves for it.
    const impossible: GeoJSON.Feature[] = []
    for (let i = 1; i < hops.length; i += 1) {
      const from = hops[i - 1]!
      const to = hops[i]!
      if (to.plausible) continue
      impossible.push({
        type: 'Feature',
        geometry: {
          type: 'LineString',
          coordinates: [
            [from.lon, from.lat],
            [to.lon, to.lat],
          ],
        },
        properties: { sequence: i },
      })
    }
    setData(m, 'route-impossible', { type: 'FeatureCollection', features: impossible })

    // ── Stops: the dot is paint, the numbers and labels are HTML ──
    const labels = groups.map((g) => sequenceLabel(g.hops))
    setData(m, 'route-stops', {
      type: 'FeatureCollection',
      features: groups.map((g, i) => ({
        type: 'Feature',
        id: g.id,
        geometry: { type: 'Point', coordinates: [g.lon, g.lat] },
        properties: { look: lookOf(g), radius: radiusFor(labels[i]!) },
      })),
    })
    m.removeFeatureState({ source: 'route-stops' })

    groups.forEach((group, i) => {
      const label = labels[i]!
      const radius = radiusFor(label)
      const first = hops[group.hops[0]!]!
      const element = document.createElement('button')
      element.type = 'button'
      // No `position` class here: MapLibre places the marker absolutely, and a
      // `relative` would drop every marker into normal flow, each one drawn
      // further below its dot than the last. Absolute also anchors the label.
      element.className = `flex cursor-pointer items-center justify-center rounded-full font-mono text-[10px] font-semibold leading-none ${NUMBER_INK[lookOf(group)]}`
      element.style.width = `${radius * 2}px`
      element.style.height = `${radius * 2}px`
      element.textContent = label
      element.setAttribute(
        'aria-label',
        `${group.hops.length === 1 ? 'Visit' : 'Visits'} ${label} at ${group.camera_codes.join(', ')}`,
      )
      element.title = `${group.camera_codes.join(', ')} — ${first.camera_name}`

      const tag = document.createElement('span')
      tag.className = `${TAG} text-foreground`
      tag.textContent = stopCaption(group, api.formatIST(first.arrived_at, false).slice(0, 5))
      element.appendChild(tag)

      // Clicking a camera visited more than once steps through its visits.
      element.addEventListener('click', (event) => {
        event.stopPropagation()
        const current = active.current
        const at = current === null ? -1 : group.hops.indexOf(current)
        const next = group.hops[(at + 1) % group.hops.length]!
        onSelect.current?.(next)
      })

      stopMarkers.current.push({
        group,
        tag,
        marker: new maplibregl.Marker({ element, anchor: 'center' })
          .setLngLat([group.lon, group.lat])
          .addTo(m),
      })
    })

    // ── Leg labels: what each leg implies, at its midpoint ──
    // A leg out and the leg back share a midpoint; their labels stack.
    const atMidpoint = new Map<string, number>()
    for (let i = 1; i < hops.length; i += 1) {
      const hop = hops[i]!
      const text = legSummary(hop)
      if (!text) continue
      const from = hops[i - 1]!
      const element = document.createElement('span')
      element.className = hop.plausible
        ? `${LEG_TAG} bg-background/80 text-muted-foreground`
        : `${LEG_TAG} border border-priority-critical/50 bg-background/90 text-priority-critical`
      element.textContent = text
      const mid: [number, number] = [(from.lon + hop.lon) / 2, (from.lat + hop.lat) / 2]
      const key = `${mid[0].toFixed(4)},${mid[1].toFixed(4)}`
      const stacked = atMidpoint.get(key) ?? 0
      atMidpoint.set(key, stacked + 1)
      legMarkers.current.push({
        sequence: i,
        impossible: !hop.plausible,
        marker: new maplibregl.Marker({ element, anchor: 'center', offset: [0, stacked * 20] })
          .setLngLat(mid)
          .addTo(m),
      })
    }

    frame()
  }, [ready, hops, timeline, groups, frame])

  // ── The selected visit: ring it, brighten its label, show its leg ────
  useEffect(() => {
    const m = map.current
    if (!m || !ready || !m.getSource('route-stops')) return
    m.removeFeatureState({ source: 'route-stops' })
    for (const { group, tag } of stopMarkers.current) {
      const on = activeSequence !== null && group.hops.includes(activeSequence)
      if (on) m.setFeatureState({ source: 'route-stops', id: group.id }, { active: true })
      tag.className = `${TAG} ${on ? 'text-primary' : 'text-foreground'}`
    }
    const few = legMarkers.current.length <= MAX_LEG_LABELS
    for (const { sequence, impossible, marker } of legMarkers.current) {
      const shown = few || impossible || sequence === activeSequence
      marker.getElement().style.display = shown ? '' : 'none'
    }
  }, [ready, activeSequence, hops])

  // ── Playback: the vehicle, and the contrail it leaves ───────────────
  useEffect(() => {
    const m = map.current
    if (!m || !ready || !m.getSource('route-travelled')) return

    // While a journey plays, the whole trail steps back so the part already
    // travelled reads as the thing moving.
    m.setPaintProperty('trail', 'line-opacity', engaged ? 0.3 : 1)
    m.setPaintProperty('trail-glow', 'line-opacity', engaged ? 0.08 : 0.35)

    const here = engaged ? positionAt(hops, timeline, playhead) : null
    const travelled = here ? travelledTrail(hops, timeline, playhead, here) : null
    const gradient = travelled
      ? trailGradient(travelled.vertices, travelled.believed, TRAIL_RGB, 0.04)
      : null
    setData(
      m,
      'route-travelled',
      gradient && travelled ? lineOf(travelled.vertices.map((v) => [v.lon, v.lat])) : EMPTY,
    )
    if (gradient) {
      m.setPaintProperty('travelled', 'line-gradient', gradient)
      m.setPaintProperty('travelled-glow', 'line-gradient', gradient)
    }

    // The vehicle itself. Only while a journey is being played back — a static
    // marker sitting on the first camera would read as a sighting.
    if (!here) {
      vehicle.current?.remove()
      vehicle.current = null
      return
    }
    if (!vehicle.current) {
      const element = document.createElement('div')
      element.className =
        'pointer-events-none h-3.5 w-3.5 rounded-full border-2 border-background bg-primary shadow-lg ring-4 ring-primary/30'
      element.title = 'Vehicle position, interpolated between sightings'
      vehicle.current = new maplibregl.Marker({ element }).setLngLat(here).addTo(m)
    } else {
      vehicle.current.setLngLat(here)
    }
  }, [ready, hops, timeline, playhead, engaged])

  // Remove the vehicle marker when the component goes away.
  useEffect(
    () => () => {
      vehicle.current?.remove()
      vehicle.current = null
    },
    [],
  )

  const impossibleCount = hops.filter((h, i) => i > 0 && !h.plausible).length

  return (
    <div className="flex h-full min-h-0 w-full flex-col">
      <div className="relative min-h-0 flex-1 overflow-hidden">
        <div ref={container} className="absolute inset-0" />

        {/* The legend is also the map's caption: what a line here does and
            does not claim, on the map itself, where a screenshot keeps it. */}
        {groups.length > 1 && (
          <div
            ref={legend}
            className="pointer-events-auto absolute left-3 top-3 z-10 max-w-[300px] rounded-lg border border-border bg-card/95 px-3 py-2.5 text-xs text-muted-foreground shadow-lg backdrop-blur"
          >
            <ul className="space-y-1.5">
              <li className="flex items-center gap-2">
                <svg
                  width="22"
                  height="8"
                  viewBox="0 0 22 8"
                  aria-hidden="true"
                  className="shrink-0 text-primary"
                >
                  {/* In user space: a level line has no height, and a gradient
                      sized to its bounding box would paint nothing. */}
                  <defs>
                    <linearGradient id={swatch} gradientUnits="userSpaceOnUse" x1="1" y1="0" x2="21" y2="0">
                      <stop offset="0" stopColor="currentColor" stopOpacity="0.2" />
                      <stop offset="1" stopColor="currentColor" stopOpacity="1" />
                    </linearGradient>
                  </defs>
                  <path d="M1 4h20" stroke={`url(#${swatch})`} strokeWidth="2.5" strokeLinecap="round" />
                </svg>
                Read by its plate, oldest faintest
              </li>
              {impossibleCount > 0 && (
                <li className="flex items-center gap-2 text-priority-critical">
                  <svg width="22" height="8" viewBox="0 0 22 8" aria-hidden="true" className="shrink-0">
                    <path d="M1 4h20" stroke="currentColor" strokeWidth="2" strokeDasharray="4 3" />
                  </svg>
                  Impossible leg — needs explaining
                </li>
              )}
              <li className="flex items-center gap-2">
                <span className="flex w-[22px] shrink-0 items-center justify-between">
                  <span className="h-2.5 w-2.5 rounded-full border-2 border-foreground/80 bg-background" />
                  <span className="h-2.5 w-2.5 rounded-full bg-primary" />
                </span>
                First and last sighting
              </li>
            </ul>
            <p className="mt-2 border-t border-border pt-2 leading-snug text-faint">
              Straight legs between cameras,{' '}
              <strong className="font-medium text-muted-foreground">not the roads driven</strong>:
              every distance and speed is a lower bound.
            </p>
          </div>
        )}

        <div className="pointer-events-auto absolute right-3 top-3 z-10 flex flex-col items-end gap-1.5">
          <SegmentedControl
            className="bg-card/90 shadow-lg backdrop-blur"
            value={choice}
            onChange={setChoice}
            options={[
              { value: 'satellite', label: 'Satellite', title: 'Aerial imagery, when the network allows' },
              { value: 'offline', label: 'Offline', title: 'Committed district and road outlines — no network needed' },
            ]}
          />
          {effective === 'offline' && choice === 'satellite' && (
            <span className="rounded bg-card/90 px-2 py-0.5 text-[11px] text-priority-high shadow">
              Satellite unreachable — offline basemap
            </span>
          )}
          {groups.length > 1 && (
            <button
              type="button"
              onClick={() => frame()}
              className="flex items-center gap-1.5 rounded-md border border-border bg-card/90 px-2 py-1 text-[11px] text-muted-foreground shadow-lg backdrop-blur transition hover:text-foreground"
            >
              <Icon name="route" size={13} />
              Fit journey
            </button>
          )}
        </div>

        <div className="pointer-events-none absolute inset-0 z-20">{children}</div>
      </div>

      {hops.length > 1 && totalSeconds > 0 && (
        <Timeline
          hops={hops}
          timeline={timeline}
          totalSeconds={totalSeconds}
          playhead={playhead}
          playing={playing}
          engaged={engaged}
          canPlay={canPlay}
          lastIndex={hops.length - 1}
          activeSequence={activeSequence}
          onToggle={togglePlay}
          onScrub={(seconds) => {
            setPlaying(false)
            setPlayhead(seconds)
          }}
          onSelectHop={(i) => onSelect.current?.(i)}
        />
      )}
    </div>
  )
})

export default RouteMap

/**
 * The journey along a clock: each sighting where it happened in time, so the
 * gaps between reads are visible as gaps. Doubles as the playback scrubber.
 */
function Timeline({
  hops,
  timeline,
  totalSeconds,
  playhead,
  playing,
  engaged,
  canPlay,
  lastIndex,
  activeSequence,
  onToggle,
  onScrub,
  onSelectHop,
}: {
  hops: RouteHop[]
  timeline: number[]
  totalSeconds: number
  playhead: number
  playing: boolean
  engaged: boolean
  canPlay: boolean
  lastIndex: number
  activeSequence: number | null
  onToggle: () => void
  onScrub: (seconds: number) => void
  onSelectHop: (sequence: number) => void
}) {
  const start = hops[0]!.arrived_at
  const ticks = useMemo(() => timelineTicks(start, totalSeconds), [start, totalSeconds])
  const pct = (seconds: number) => `${Math.min(100, Math.max(0, (seconds / totalSeconds) * 100))}%`

  return (
    <section aria-label="Timeline" className="shrink-0 border-t border-border bg-chrome px-4 pb-2.5 pt-2">
      <div className="flex items-center gap-3">
        <span className="eyebrow">Timeline</span>
        <span className="hidden truncate text-xs text-faint md:inline">
          gaps are stretches where no camera read the plate
        </span>
        <span className="ml-auto font-mono text-xs tabular-nums text-foreground">
          {istClock(start, engaged ? playhead : 0)}
          <span className="ml-1 text-faint">IST</span>
        </span>
      </div>

      <div className="mt-1.5 flex items-center gap-3">
        <button
          type="button"
          onClick={onToggle}
          disabled={!canPlay}
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-input text-foreground transition hover:bg-secondary disabled:cursor-not-allowed disabled:opacity-40"
          aria-label={playing ? 'Pause journey playback' : 'Play journey playback'}
          title={
            canPlay
              ? playing
                ? 'Pause'
                : 'Play the journey, in proportion to real time'
              : 'Every sighting is at one camera — there is no movement to play'
          }
        >
          <Icon name={playing ? 'pause' : 'play'} size={14} />
        </button>

        <div className="relative h-10 min-w-0 flex-1 rounded has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring/70">
          {/* The track, and how far along it playback has reached. */}
          <div className="absolute inset-x-0 top-[11px] h-0.5 rounded bg-border" />
          {engaged && (
            <div
              className="absolute left-0 top-[11px] h-0.5 rounded bg-primary/70"
              style={{ width: pct(playhead) }}
            />
          )}

          {/* Clock ticks: round IST times, so the spacing reads as time. */}
          {ticks.map((tick) => {
            const at = tick.at / totalSeconds
            // Labels at either end hang inwards rather than off the track.
            const shift = at > 0.94 ? '-translate-x-full text-right' : at < 0.06 ? '' : '-translate-x-1/2 text-center'
            const mark = at > 0.94 ? 'ml-auto' : at < 0.06 ? '' : 'mx-auto'
            return (
              <span
                key={tick.at}
                className={`pointer-events-none absolute top-[19px] font-mono text-[10px] text-faint ${shift}`}
                style={{ left: pct(tick.at) }}
              >
                <span className={`mb-0.5 block h-1.5 w-px bg-border ${mark}`} />
                {tick.label}
              </span>
            )
          })}

          {/* The scrubber: an ordinary range input, so the keyboard drives it,
              laid under the sightings so they stay clickable. */}
          <input
            type="range"
            min={0}
            max={Math.max(1, Math.round(totalSeconds))}
            step={1}
            value={Math.round(playhead)}
            disabled={!canPlay}
            onChange={(event) => onScrub(Number(event.target.value))}
            className="absolute inset-x-0 top-0 h-6 w-full cursor-pointer opacity-0 disabled:cursor-default"
            aria-label="Journey timeline"
          />

          {hops.map((hop, i) => {
            const isActive = activeSequence === i
            const look =
              i > 0 && !hop.plausible
                ? 'border-2 border-priority-critical bg-background'
                : i === lastIndex
                  ? 'bg-primary'
                  : i === 0
                    ? 'border-2 border-foreground/80 bg-background'
                    : 'bg-foreground/80'
            return (
              <button
                key={`${hop.camera_id}-${hop.arrived_at}`}
                type="button"
                onClick={() => onSelectHop(i)}
                title={`${i + 1} · ${api.formatIST(hop.arrived_at, false)} · ${hop.camera_code}`}
                aria-label={`Visit ${i + 1}, ${hop.camera_code}`}
                className={`absolute top-[6px] h-3 w-3 -translate-x-1/2 rounded-full transition ${look} ${
                  isActive ? 'ring-2 ring-primary ring-offset-2 ring-offset-chrome' : ''
                }`}
                style={{ left: pct(timeline[i] ?? 0) }}
              />
            )
          })}

          {engaged && (
            <span
              className="pointer-events-none absolute top-[2px] h-5 w-0.5 -translate-x-1/2 rounded bg-primary"
              style={{ left: pct(playhead) }}
            />
          )}
        </div>
      </div>
    </section>
  )
}
