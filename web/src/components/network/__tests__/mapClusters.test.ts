/**
 * Grouping cameras for the map.
 *
 * What it must never do: draw an unplaced camera, hide how many cameras share
 * a town's centre, or name a town-centre marker after a junction it is not at.
 */

import { describe, expect, it } from 'vitest'

import {
  clusterName,
  clusterSpots,
  clusterTone,
  dotSize,
  spotsOf,
  statusSummary,
} from '@/components/network/mapClusters'

import { camera, DEMO, unplaced } from './fixtures'

/** A flat projection: one degree is 100 px, so distances are easy to reason about. */
const flat = (lon: number, lat: number) => ({ x: lon * 100, y: -lat * 100 })

const ahmedabad = ['SBX-cam01', 'SBX-cam02', 'SBX-cam03'].map((code) => camera(code))
const junagadh = ['SBX-cam06', 'SBX-cam08'].map((code) =>
  camera(code, { city: 'Junagadh', district: 'Junagadh', lat: 21.5222, lon: 70.4579 }),
)

describe('spotsOf', () => {
  it('groups cameras registered at one coordinate, largest first', () => {
    const spots = spotsOf([...junagadh, ...ahmedabad, DEMO])
    expect(spots.map((s) => s.cameras.length)).toEqual([3, 2, 1])
    expect(spots[0]?.cameras.map((c) => c.camera_code)).toEqual(['SBX-cam01', 'SBX-cam02', 'SBX-cam03'])
  })

  it('never includes a camera whose position is not known', () => {
    const spots = spotsOf([unplaced('SBX-cam20'), unplaced('SBX-cam22', { tags: null }), DEMO])
    expect(spots.flatMap((s) => s.cameras.map((c) => c.camera_code))).toEqual(['CAM-DEMO-01'])
  })
})

describe('clusterSpots', () => {
  it('keeps a town centre as one co-located marker with every camera in it', () => {
    const [cluster] = clusterSpots(spotsOf(ahmedabad), flat, 20)
    expect(cluster?.cameras).toHaveLength(3)
    expect(cluster?.colocated).toBe(true)
    expect(cluster?.townLevel).toBe(true)
    expect(cluster?.name).toBe('Ahmedabad')
  })

  it('merges a nearby camera at this zoom, anchored on the bigger group', () => {
    // The demo camera is ~1.6 px from the town centre in this projection.
    const clusters = clusterSpots(spotsOf([...ahmedabad, DEMO]), flat, 20)
    expect(clusters).toHaveLength(1)
    const [cluster] = clusters
    expect(cluster?.cameras).toHaveLength(4)
    expect(cluster?.spots).toBe(2)
    expect(cluster?.colocated).toBe(false)
    expect(cluster?.townLevel).toBe(false)
    expect([cluster?.lat, cluster?.lon]).toEqual([23.0225, 72.5714])
  })

  it('separates them once zoomed in far enough', () => {
    const zoomedIn = (lon: number, lat: number) => ({ x: lon * 100_000, y: -lat * 100_000 })
    const clusters = clusterSpots(spotsOf([...ahmedabad, DEMO]), zoomedIn, 20)
    expect(clusters.map((c) => c.cameras.length).sort()).toEqual([1, 3])
  })

  it('keeps distant towns apart', () => {
    const clusters = clusterSpots(spotsOf([...ahmedabad, ...junagadh]), flat, 20)
    expect(clusters.map((c) => c.name)).toEqual(['Ahmedabad', 'Junagadh'])
  })
})

describe('clusterName', () => {
  it('names a single placed camera for its junction', () => {
    expect(clusterName([DEMO])).toBe('Ashram Road @ Paldi')
  })

  it('names a single town-centre camera for its town, not a junction it is not at', () => {
    expect(clusterName([camera('SBX-cam21', { city: 'Patan', junction: 'Dethali Char Rasta' })])).toBe('Patan')
  })

  it('names a group for the town most of it is in', () => {
    expect(clusterName([...ahmedabad, junagadh[0]!])).toBe('Ahmedabad')
  })
})

describe('clusterTone', () => {
  it('is plain when everything answers', () => {
    expect(clusterTone([{ status: 'online' }, { status: 'online' }])).toBe('normal')
  })

  it('is plain when some answer and some cannot be told', () => {
    expect(clusterTone([{ status: 'online' }, { status: 'unknown' }])).toBe('normal')
  })

  it('is dim only when nothing there can be told', () => {
    expect(clusterTone([{ status: 'unknown' }, { status: 'unknown' }])).toBe('unknown')
  })

  it('rings the worst problem: offline over degraded', () => {
    expect(clusterTone([{ status: 'degraded' }, { status: 'offline' }])).toBe('offline')
    expect(clusterTone([{ status: 'online' }, { status: 'degraded' }])).toBe('degraded')
  })
})

describe('marker size and summary', () => {
  it('grows with the number of cameras', () => {
    expect([1, 2, 4, 9].map(dotSize)).toEqual([7, 9, 11, 14])
  })

  it('summarises states without the zeros', () => {
    expect(statusSummary([{ status: 'online' }, { status: 'unknown' }, { status: 'unknown' }])).toBe(
      '1 online · 2 state unknown',
    )
  })
})
