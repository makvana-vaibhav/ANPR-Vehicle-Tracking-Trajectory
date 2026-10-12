/**
 * Making a map that cannot take the screen down with it.
 *
 * MapLibre draws with WebGL, and `new maplibregl.Map()` throws when the
 * browser cannot give it a context — graphics acceleration switched off, a
 * GPU process that crashed, a locked-down kiosk browser, a headless test. An
 * exception thrown inside a React effect unmounts the whole application, so a
 * map that could not start used to leave the operator a blank page with no top
 * bar and no way anywhere else. A map that fails now says so, in its own box,
 * and every other figure on the screen keeps working.
 */

import maplibregl, { type MapOptions } from 'maplibre-gl'

/** A map, or null when this browser cannot draw one. Never throws. */
export function createMap(options: MapOptions): maplibregl.Map | null {
  try {
    return new maplibregl.Map(options)
  } catch (err) {
    console.warn('Map unavailable: WebGL could not be started', err)
    return null
  }
}
