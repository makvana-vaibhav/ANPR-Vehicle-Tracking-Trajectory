/**
 * A route request sends only the window it was given.
 *
 * `new URLSearchParams({ until: undefined })` sends the word "undefined",
 * which the API refuses as a timestamp. That broke the printable report,
 * whose window has no end unless one is chosen — and a test that mocked the
 * request could not see it, so this one looks at the URL itself.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'

import { getVehicleRoute, getVehicleRouteGeoJSON } from '@/lib/api'

describe('route requests', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  function captureUrl(): { url: () => string } {
    let seen = ''
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        seen = String(input)
        return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } })
      }),
    )
    return { url: () => seen }
  }

  it('leaves out an end that was not given', async () => {
    const capture = captureUrl()
    await getVehicleRoute('GJ03AB1234', { since: '2026-10-11T00:00:00Z', until: undefined })
    expect(capture.url()).toContain('since=2026-10-11T00%3A00%3A00Z')
    expect(capture.url()).not.toContain('until')
  })

  it('does the same for the drawn route', async () => {
    const capture = captureUrl()
    await getVehicleRouteGeoJSON('GJ03AB1234', { since: '2026-10-11T00:00:00Z', until: undefined })
    expect(capture.url()).toContain('format=geojson')
    expect(capture.url()).not.toContain('undefined')
  })
})
