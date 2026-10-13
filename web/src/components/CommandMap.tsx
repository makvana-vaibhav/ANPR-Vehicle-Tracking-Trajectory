/**
 * The Command map: the whole network on one screen, and what it is doing.
 *
 * Three layers of fact, from quiet to loud:
 *
 *   places   every town with cameras, one marker each, sized by how many.
 *            Light grey — a camera that is answering is normal, and normal is
 *            not coloured.
 *   reading  a trail-coloured ring on the places whose cameras have read a
 *            plate in the last ten minutes, and a ripple each time one reads a
 *            plate live. The map is visibly working, or visibly not.
 *   trails   vehicles seen at two or more cameras, drawn as a contrail: faint
 *            where the vehicle was, bright where it was last seen. A journey
 *            the correlator could not believe is a dashed red line instead.
 *            Straight lines between cameras, never a guessed road.
 *
 * No basemap tiles at all, satellite included: this is the screen that has to
 * look right on a venue's hostile wifi, and Gujarat's district outlines from
 * the committed GeoJSON are all the ground it needs. Labels are HTML, because
 * MapLibre text needs a glyph server (CLAUDE.md §6).
 */

import { useEffect, useRef, useState } from 'react'
import maplibregl from 'maplibre-gl'
import 'maplibre-gl/dist/maplibre-gl.css'

import MapUnavailable from '@/components/MapUnavailable'
import { useEventStream } from '@/hooks/useEventStream'
import { GUJARAT_CENTER } from '@/lib/basemap'
import { createMap } from '@/lib/maps'
import type { Place } from '@/lib/places'
import { mapPalette, useTheme, type MapPalette } from '@/lib/theme'

/* Map paint cannot take Tailwind classes or CSS variables, so the colours come
   from lib/theme's palette for the current theme and are repainted when it
   changes. HTML markers use the CSS variables directly and follow by
   themselves. */

function trailGradient(palette: MapPalette, alpha: number): maplibregl.ExpressionSpecification {
  const [r, g, b] = palette.trailRgb
  return ['interpolate', ['linear'], ['line-progress'], 0, `rgba(${r}, ${g}, ${b}, 0)`, 1, `rgba(${r}, ${g}, ${b}, ${alpha})`]
}

/** Repaint every layer this map owns that exists yet. */
function paintMap(map: maplibregl.Map, palette: MapPalette): void {
  const set = (layer: string, property: string, value: unknown) => {
    if (map.getLayer(layer)) map.setPaintProperty(layer, property, value)
  }
  set('background', 'background-color', palette.ground)
  set('districts-fill', 'fill-color', palette.land)
  set('districts-line', 'line-color', palette.boundary)
  set('trail-glow', 'line-gradient', trailGradient(palette, 0.35))
  set('trail-line', 'line-gradient', trailGradient(palette, 0.95))
  set('trail-doubt', 'line-color', palette.critical)
  set('trail-heads', 'circle-color', palette.trail)
  set('trail-heads', 'circle-stroke-color', palette.ground)
}

export interface Trail {
  plate: string
  /** [lon, lat] per camera visited, in order. */
  coords: [number, number][]
  plausible: boolean
}

interface Props {
  places: Place[]
  /** Camera codes that have read a plate recently. */
  reading: Set<string>
  /** Camera ids with an open alarm. */
  alarmed: Set<string>
  trails: Trail[]
  selectedKey: string | null
  onSelect: (place: Place | null) => void
}

/** The districts are 330 KB and never change; fetch them once per session. */
let districtsCache: Promise<GeoJSON.FeatureCollection | null> | null = null
function loadDistricts(): Promise<GeoJSON.FeatureCollection | null> {
  districtsCache ??= fetch('/data/gujarat_districts.geojson')
    .then((r) => (r.ok ? (r.json() as Promise<GeoJSON.FeatureCollection>) : null))
    .catch(() => null)
  return districtsCache
}

function dotSize(count: number): number {
  if (count >= 8) return 14
  if (count >= 4) return 11
  if (count >= 2) return 9
  return 7
}

type Side = 'right' | 'left' | 'top' | 'bottom'

interface MarkerParts {
  marker: maplibregl.Marker
  root: HTMLDivElement
  ring: HTMLSpanElement
  halo: HTMLSpanElement
  label: HTMLSpanElement
  size: number
}

const RIPPLE_MIN_GAP_MS = 700

export default function CommandMap({
  places,
  reading,
  alarmed,
  trails,
  selectedKey,
  onSelect,
}: Props) {
  const container = useRef<HTMLDivElement>(null)
  const mapRef = useRef<maplibregl.Map | null>(null)
  const markers = useRef(new Map<string, MarkerParts>())
  const codeToPlace = useRef(new Map<string, string>())
  const lastRipple = useRef(new Map<string, number>())
  const onSelectRef = useRef(onSelect)
  const placesRef = useRef(places)
  const fitted = useRef(false)
  const [ready, setReady] = useState(false)
  const [unavailable, setUnavailable] = useState(false)
  const { subscribe } = useEventStream()
  const { resolved } = useTheme()
  const palette = mapPalette(resolved)
  const paletteRef = useRef(palette)
  paletteRef.current = palette

  onSelectRef.current = onSelect
  placesRef.current = places

  // ── The map, once ────────────────────────────────────────────────────
  useEffect(() => {
    if (!container.current || mapRef.current) return
    const map = createMap({
      container: container.current,
      style: {
        version: 8,
        sources: {},
        layers: [
          {
            id: 'background',
            type: 'background',
            paint: { 'background-color': paletteRef.current.ground },
          },
        ],
      },
      center: GUJARAT_CENTER,
      zoom: 6.2,
      minZoom: 4.5,
      maxZoom: 13,
      attributionControl: false,
      dragRotate: false,
      pitchWithRotate: false,
    })
    if (!map) {
      setUnavailable(true)
      return
    }
    map.touchZoomRotate.disableRotation()
    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'bottom-right')
    map.on('load', () => setReady(true))
    // A click on open ground clears the selection; a click on a marker is
    // handled by the marker and never reaches here.
    map.on('click', () => onSelectRef.current(null))
    mapRef.current = map

    // The map's box changes when the alarm dock or the window does; MapLibre
    // only notices the window.
    const observer = new ResizeObserver(() => map.resize())
    observer.observe(container.current)

    const owned = markers.current
    return () => {
      observer.disconnect()
      for (const parts of owned.values()) parts.marker.remove()
      owned.clear()
      map.remove()
      mapRef.current = null
    }
  }, [])

  // ── Ground: the districts ────────────────────────────────────────────
  useEffect(() => {
    if (!ready) return
    let cancelled = false
    void loadDistricts().then((districts) => {
      const map = mapRef.current
      if (cancelled || !map || !districts || map.getSource('districts')) return
      map.addSource('districts', { type: 'geojson', data: districts })
      const before = map.getLayer('trail-glow') ? 'trail-glow' : undefined
      map.addLayer(
        {
          id: 'districts-fill',
          type: 'fill',
          source: 'districts',
          paint: { 'fill-color': paletteRef.current.land },
        },
        before,
      )
      map.addLayer(
        {
          id: 'districts-line',
          type: 'line',
          source: 'districts',
          paint: { 'line-color': paletteRef.current.boundary, 'line-width': 0.8 },
        },
        before,
      )
    })
    return () => {
      cancelled = true
    }
  }, [ready])

  // ── Trails ───────────────────────────────────────────────────────────
  useEffect(() => {
    const map = mapRef.current
    if (!ready || !map) return

    const lines: GeoJSON.FeatureCollection = {
      type: 'FeatureCollection',
      features: trails.map((t) => ({
        type: 'Feature',
        properties: { plate: t.plate, plausible: t.plausible },
        geometry: { type: 'LineString', coordinates: t.coords },
      })),
    }
    const heads: GeoJSON.FeatureCollection = {
      type: 'FeatureCollection',
      features: trails
        .filter((t) => t.plausible && t.coords.length > 0)
        .map((t) => ({
          type: 'Feature',
          properties: { plate: t.plate },
          geometry: { type: 'Point', coordinates: t.coords[t.coords.length - 1] ?? [0, 0] },
        })),
    }

    const lineSource = map.getSource('trails') as maplibregl.GeoJSONSource | undefined
    if (lineSource) {
      lineSource.setData(lines)
      ;(map.getSource('trail-heads') as maplibregl.GeoJSONSource | undefined)?.setData(heads)
      return
    }

    // lineMetrics is what lets the colour run along the line — faint at the
    // first sighting, full at the last — which is the whole idea of a trail.
    map.addSource('trails', { type: 'geojson', data: lines, lineMetrics: true })
    map.addSource('trail-heads', { type: 'geojson', data: heads })
    const gradient = (alpha: number) => trailGradient(paletteRef.current, alpha)
    map.addLayer({
      id: 'trail-glow',
      type: 'line',
      source: 'trails',
      filter: ['==', ['get', 'plausible'], true],
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: { 'line-width': 8, 'line-blur': 5, 'line-gradient': gradient(0.35) },
    })
    map.addLayer({
      id: 'trail-line',
      type: 'line',
      source: 'trails',
      filter: ['==', ['get', 'plausible'], true],
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: { 'line-width': 2.2, 'line-gradient': gradient(0.95) },
    })
    // A journey that cannot be believed is still drawn — hiding it would
    // hide the one thing an operator should look at — but never as a trail.
    map.addLayer({
      id: 'trail-doubt',
      type: 'line',
      source: 'trails',
      filter: ['==', ['get', 'plausible'], false],
      paint: {
        'line-color': paletteRef.current.critical,
        'line-width': 1.6,
        'line-opacity': 0.8,
        'line-dasharray': [2, 2.5],
      },
    })
    map.addLayer({
      id: 'trail-heads',
      type: 'circle',
      source: 'trail-heads',
      paint: {
        'circle-radius': 3.5,
        'circle-color': paletteRef.current.trail,
        'circle-stroke-color': paletteRef.current.ground,
        'circle-stroke-width': 1.5,
      },
    })
  }, [ready, trails])

  // ── Places ───────────────────────────────────────────────────────────
  useEffect(() => {
    const map = mapRef.current
    if (!ready || !map) return

    const wanted = new Set(places.map((p) => p.key))
    for (const [key, parts] of markers.current) {
      if (!wanted.has(key)) {
        parts.marker.remove()
        markers.current.delete(key)
      }
    }

    codeToPlace.current = new Map()
    for (const place of places) {
      for (const camera of place.cameras) {
        codeToPlace.current.set(camera.camera_code.toLowerCase(), place.key)
      }
      const size = dotSize(place.cameras.length)
      let parts = markers.current.get(place.key)
      if (!parts || parts.size !== size) {
        parts?.marker.remove()
        parts = buildMarker(place, size, () => {
          const current = placesRef.current.find((p) => p.key === place.key)
          if (current) onSelectRef.current(current)
        })
        parts.marker.addTo(map)
        markers.current.set(place.key, parts)
      }
      parts.marker.setLngLat([place.lon, place.lat])
      const count = place.cameras.length
      parts.label.innerHTML = ''
      parts.label.append(document.createTextNode(place.name))
      if (count > 1) {
        const n = document.createElement('span')
        n.className = 'ml-1.5 font-mono text-[11px] text-faint'
        n.textContent = String(count)
        parts.label.append(n)
      }
      parts.root.setAttribute(
        'aria-label',
        `${place.name}: ${count} camera${count === 1 ? '' : 's'}`,
      )
    }

    // Frame the network the first time it is known, not on every refresh —
    // an operator who has zoomed in should stay zoomed in.
    if (!fitted.current && places.length > 0) {
      fitted.current = true
      if (places.length === 1) {
        const only = places[0]
        if (only) map.jumpTo({ center: [only.lon, only.lat], zoom: 10 })
      } else {
        const bounds = new maplibregl.LngLatBounds()
        for (const p of places) bounds.extend([p.lon, p.lat])
        map.fitBounds(bounds, {
          // Clear of the counters above and the legend below.
          padding: { top: 150, bottom: 130, left: 90, right: 110 },
          maxZoom: 8.5,
          duration: 0,
        })
      }
    }
    layoutLabels(map, places, markers.current)
  }, [ready, places])

  // The theme changed: repaint what MapLibre draws. Markers follow by CSS.
  useEffect(() => {
    const map = mapRef.current
    if (!ready || !map) return
    paintMap(map, palette)
  }, [ready, palette])

  // Rings: reading, alarm, selected. Cheap enough to run on every change.
  useEffect(() => {
    for (const place of places) {
      const parts = markers.current.get(place.key)
      if (!parts) continue
      const isAlarmed = place.cameras.some((c) => alarmed.has(c.id))
      const isReading = place.cameras.some((c) => reading.has(c.camera_code))
      parts.ring.style.display = isAlarmed || isReading ? 'block' : 'none'
      parts.ring.style.borderColor = isAlarmed ? 'hsl(var(--priority-critical))' : 'hsl(var(--primary))'
      parts.halo.style.display = place.key === selectedKey ? 'block' : 'none'
      parts.label.classList.toggle('text-foreground', place.key === selectedKey)
      parts.label.classList.toggle('text-muted-foreground', place.key !== selectedKey)
    }
  }, [places, reading, alarmed, selectedKey])

  // Labels move out of each other's way whenever the view changes.
  useEffect(() => {
    const map = mapRef.current
    if (!ready || !map) return
    const relayout = () => layoutLabels(map, placesRef.current, markers.current)
    map.on('moveend', relayout)
    map.on('resize', relayout)
    return () => {
      map.off('moveend', relayout)
      map.off('resize', relayout)
    }
  }, [ready])

  // ── A ripple for every plate read, as it is read ─────────────────────
  useEffect(
    () =>
      subscribe((event) => {
        if (event.event !== 'vehicle.completed') return
        if (!event.plate?.readable || !event.plate.text) return
        const key = codeToPlace.current.get((event.source?.camera_id ?? '').toLowerCase())
        if (!key) return
        const now = performance.now()
        if (now - (lastRipple.current.get(key) ?? -Infinity) < RIPPLE_MIN_GAP_MS) return
        lastRipple.current.set(key, now)
        const parts = markers.current.get(key)
        if (!parts) return
        const ripple = document.createElement('span')
        ripple.className =
          'pointer-events-none absolute left-1/2 top-1/2 animate-ripple rounded-full border border-primary'
        const d = parts.size + 10
        ripple.style.width = `${d}px`
        ripple.style.height = `${d}px`
        ripple.addEventListener('animationend', () => ripple.remove())
        parts.root.append(ripple)
      }),
    [subscribe],
  )

  return (
    <>
      <div ref={container} className="absolute inset-0" />
      {unavailable && <MapUnavailable />}
    </>
  )
}

function buildMarker(place: Place, size: number, onClick: () => void): MarkerParts {
  const root = document.createElement('div')
  // No `relative` here: MapLibre positions a marker absolutely, and a class
  // that overrode it stacked every marker below the one added before it.
  root.className = 'cursor-pointer'
  root.style.width = `${size}px`
  root.style.height = `${size}px`
  root.setAttribute('role', 'button')
  root.tabIndex = 0

  const dot = document.createElement('span')
  dot.className = 'absolute inset-0 rounded-full shadow-[0_0_0_2px_hsl(var(--background))]'
  dot.style.background = 'hsl(var(--place))'

  const ring = document.createElement('span')
  ring.className = 'pointer-events-none absolute left-1/2 top-1/2 rounded-full border-[1.5px]'
  ring.style.width = `${size + 9}px`
  ring.style.height = `${size + 9}px`
  ring.style.transform = 'translate(-50%, -50%)'
  ring.style.display = 'none'

  const halo = document.createElement('span')
  halo.className =
    'pointer-events-none absolute left-1/2 top-1/2 rounded-full border border-foreground/60'
  halo.style.width = `${size + 18}px`
  halo.style.height = `${size + 18}px`
  halo.style.transform = 'translate(-50%, -50%)'
  halo.style.display = 'none'

  const label = document.createElement('span')
  label.className =
    'pointer-events-none absolute whitespace-nowrap text-[12px] leading-none text-muted-foreground [text-shadow:0_1px_2px_hsl(var(--background)),0_0_6px_hsl(var(--background))]'
  if (place.cameras.length >= 4) label.classList.add('font-medium', 'text-[13px]')

  root.append(halo, ring, dot, label)
  const activate = (event: Event) => {
    event.stopPropagation()
    onClick()
  }
  root.addEventListener('click', activate)
  root.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ' ') activate(event)
  })

  // A marker must have a position before it is added to a map.
  const marker = new maplibregl.Marker({ element: root, anchor: 'center' }).setLngLat([
    place.lon,
    place.lat,
  ])
  return { marker, root, ring, halo, label, size }
}

interface Box {
  x: number
  y: number
  w: number
  h: number
}

function overlaps(a: Box, b: Box): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h
}

/**
 * Put each label on the first side of its dot where it collides with nothing
 * already placed — dots first, then labels, biggest town first. A small town
 * whose every side is taken keeps its dot and loses its label until the
 * operator zooms in; a label drawn over another is worse than none.
 */
function layoutLabels(
  map: maplibregl.Map,
  places: Place[],
  markers: Map<string, MarkerParts>,
): void {
  const taken: Box[] = []
  const projected = places.map((place) => {
    const p = map.project([place.lon, place.lat])
    const parts = markers.get(place.key)
    const r = (parts?.size ?? 8) / 2 + 3
    taken.push({ x: p.x - r, y: p.y - r, w: 2 * r, h: 2 * r })
    return { place, p, parts }
  })

  for (const { place, p, parts } of projected) {
    if (!parts) continue
    const { label, size } = parts
    const w = label.offsetWidth
    const h = label.offsetHeight
    const gap = 7
    const half = size / 2
    const options: [Side, Box][] = [
      ['right', { x: p.x + half + gap, y: p.y - h / 2, w, h }],
      ['left', { x: p.x - half - gap - w, y: p.y - h / 2, w, h }],
      ['top', { x: p.x - w / 2, y: p.y - half - gap - h, w, h }],
      ['bottom', { x: p.x - w / 2, y: p.y + half + gap, w, h }],
    ]
    // A big town keeps its label even when crowded: its name is the one an
    // operator is looking for.
    const chosen =
      options.find(([, box]) => !taken.some((t) => overlaps(t, box))) ??
      (place.cameras.length >= 4 ? options[0] : undefined)
    if (!chosen) {
      label.style.visibility = 'hidden'
      continue
    }
    label.style.visibility = 'visible'
    taken.push(chosen[1])
    placeLabel(label, chosen[0], size, gap)
  }
}

function placeLabel(label: HTMLSpanElement, side: Side, size: number, gap: number): void {
  label.style.left = label.style.right = label.style.top = label.style.bottom = ''
  if (side === 'right' || side === 'left') {
    label.style.top = '50%'
    label.style.transform = 'translateY(-50%)'
    if (side === 'right') label.style.left = `${size + gap}px`
    else label.style.right = `${size + gap}px`
  } else {
    label.style.left = '50%'
    label.style.transform = 'translateX(-50%)'
    if (side === 'top') label.style.bottom = `${size + gap}px`
    else label.style.top = `${size + gap}px`
  }
}
