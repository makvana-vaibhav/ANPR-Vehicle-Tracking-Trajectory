/**
 * The Investigate screen's address.
 *
 * `/vehicles?plate=…` is how the ⌘K palette and other screens open a journey,
 * so a link that is slightly off — spaced, lower case, a window that ends
 * before it starts — has to land on the vehicle it meant, or on a default the
 * screen shows, never on a silently wrong search.
 */

import { describe, expect, it } from 'vitest'

import {
  paramsFor,
  plateFromParams,
  toSearchPlate,
  windowFromParams,
} from '@/pages/vehicleSearchUrl'

describe('plateFromParams', () => {
  it('reads a plate however it was written', () => {
    expect(plateFromParams(new URLSearchParams('plate=GJ03AB1234'))).toBe('GJ03AB1234')
    expect(plateFromParams(new URLSearchParams('plate=gj%2003%20ab-1234'))).toBe('GJ03AB1234')
  })

  it('is null when the link names no plate', () => {
    expect(plateFromParams(new URLSearchParams(''))).toBeNull()
    expect(plateFromParams(new URLSearchParams('plate=%20-%20'))).toBeNull()
  })

  it('keeps letters and digits only, like every lookup', () => {
    expect(toSearchPlate('GJ.03 ab_1234')).toBe('GJ03AB1234')
  })
})

describe('windowFromParams', () => {
  it('takes an exact window', () => {
    expect(
      windowFromParams(new URLSearchParams('since=2026-10-11T00:00:00Z&until=2026-10-11T12:00:00Z')),
    ).toEqual({ since: '2026-10-11T00:00:00.000Z', until: '2026-10-11T12:00:00.000Z' })
  })

  it('takes a start alone, open to now', () => {
    expect(windowFromParams(new URLSearchParams('since=2026-10-11T00:00:00Z'))).toEqual({
      since: '2026-10-11T00:00:00.000Z',
      until: null,
    })
  })

  it('ignores a window it cannot read or that ends before it starts', () => {
    expect(windowFromParams(new URLSearchParams('since=yesterday'))).toBeNull()
    expect(
      windowFromParams(new URLSearchParams('since=2026-10-11T12:00:00Z&until=2026-10-11T00:00:00Z')),
    ).toBeNull()
    expect(windowFromParams(new URLSearchParams('until=2026-10-11T00:00:00Z'))).toBeNull()
  })
})

describe('paramsFor', () => {
  it('names the plate, keeps other parameters, and drops a stale window', () => {
    const next = paramsFor(
      new URLSearchParams('plate=OLD1234&since=2026-10-01T00:00:00Z&tab=x'),
      'GJ03AB1234',
      null,
    )
    expect(next.get('plate')).toBe('GJ03AB1234')
    expect(next.get('tab')).toBe('x')
    expect(next.has('since')).toBe(false)
  })

  it('carries an exact window, so the link means the same thing later', () => {
    const next = paramsFor(new URLSearchParams(''), 'GJ03AB1234', {
      since: '2026-10-11T00:00:00.000Z',
      until: null,
    })
    expect(next.get('since')).toBe('2026-10-11T00:00:00.000Z')
    expect(next.has('until')).toBe(false)
  })
})
