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
  decide,
  decideCandidate,
  decisionsFromParams,
  NO_DECISIONS,
  paramsFor,
  paramsWithDecisions,
  plateFromParams,
  recalledDecisions,
  rememberDecisions,
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

// ── Candidate decisions, carried in the address ──────────────────────

const A = '0b6d6f4e-3c1a-4f7e-9a51-aaaaaaaaaaaa'
const B = '0b6d6f4e-3c1a-4f7e-9a51-bbbbbbbbbbbb'

describe('decisionsFromParams', () => {
  it('reads included and dismissed detection ids', () => {
    expect(decisionsFromParams(new URLSearchParams(`include=${A}&dismiss=${B}`))).toEqual({
      include: [A],
      dismiss: [B],
    })
  })

  it('ignores anything that is not a detection id, and repeats', () => {
    expect(
      decisionsFromParams(new URLSearchParams(`include=${A},${A},drop-table,123`)).include,
    ).toEqual([A])
  })

  it('treats a read both included and dismissed as included — the reversible reading', () => {
    expect(decisionsFromParams(new URLSearchParams(`include=${A}&dismiss=${A}`))).toEqual({
      include: [A],
      dismiss: [],
    })
  })
})

describe('writing decisions', () => {
  it('writes the lists and leaves no empty parameter behind', () => {
    const next = paramsWithDecisions(new URLSearchParams(`plate=X&dismiss=${B}`), {
      include: [A, B],
      dismiss: [],
    })
    expect(next.get('include')).toBe(`${A},${B}`)
    expect(next.has('dismiss')).toBe(false)
    expect(next.get('plate')).toBe('X')
  })

  it('makes include and dismiss replace each other, and undo clear both', () => {
    const included = decide(NO_DECISIONS, A, 'include')
    expect(included).toEqual({ include: [A], dismiss: [] })
    expect(decide(included, A, 'dismiss')).toEqual({ include: [], dismiss: [A] })
    expect(decide(included, A, 'undo')).toEqual(NO_DECISIONS)
  })

  it('finds a candidate by any of its reads', () => {
    // Included under one read; undone from the visit, whose best read is another.
    const decisions = { include: [B], dismiss: [] }
    expect(decideCandidate(decisions, [A, B], 'undo')).toEqual(NO_DECISIONS)
  })

  it('belongs to one plate: opening another drops them, the same one keeps them', () => {
    const current = new URLSearchParams(`plate=GJ03AB1234&include=${A}`)
    expect(paramsFor(current, 'MH12DE1433', null).has('include')).toBe(false)
    expect(paramsFor(current, 'GJ03AB1234', null).get('include')).toBe(A)
  })

  it('remembers them for this tab, per plate', () => {
    window.sessionStorage.clear()
    expect(recalledDecisions('GJ03AB1234')).toEqual(NO_DECISIONS)
    rememberDecisions('GJ03AB1234', { include: [A], dismiss: [B] })
    expect(recalledDecisions('GJ03AB1234')).toEqual({ include: [A], dismiss: [B] })
    expect(recalledDecisions('MH12DE1433')).toEqual(NO_DECISIONS)
  })
})
