import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import LivePlateFeed from '@/components/LivePlateFeed'
import type { LiveVehicleEvent } from '@/lib/types'

function reading(plate: string, runId: string, trackId = 5, vehicleId = 1): LiveVehicleEvent {
  return {
    event: 'vehicle.observed',
    event_time: '2026-10-11T14:00:00Z',
    run_id: runId,
    source: { camera_id: 'SBX-cam04' },
    vehicle: {
      vehicle_id: vehicleId,
      track_ids: [trackId],
      type: 'car',
      confidence: 0.9,
      bbox: { x1: 0, y1: 0, x2: 10, y2: 10, w: 10, h: 10 },
      first_seen_s: 1,
      last_seen_s: 2,
    },
    plate: {
      text: plate,
      confidence: 0.92,
      readable: true,
      grammar_valid: true,
      ambiguous: false,
      corrected_from: null,
      format: 'in_current',
    },
  }
}

describe('LivePlateFeed', () => {
  it('shows one row per car when the same car is read again', () => {
    // Newest first, as the stream delivers them.
    render(
      <LivePlateFeed
        events={[reading('GJ01AB1234', 'cam.aaaaaa', 5, 2), reading('GJ01AB1Z34', 'cam.aaaaaa', 5, 1)]}
      />,
    )
    expect(screen.getByText('GJ01AB1234')).toBeDefined()
    expect(screen.queryByText('GJ01AB1Z34')).toBeNull()
  })

  it('keeps an earlier car when a new tracker run reuses its track id', () => {
    // Track ids restart whenever the tracker is rebuilt. Keyed on camera and
    // track alone, the next run's track 5 replaced this car's row and its
    // reading disappeared from the feed.
    render(
      <LivePlateFeed
        events={[reading('GJ05CD5678', 'cam.bbbbbb', 5, 9), reading('GJ01AB1234', 'cam.aaaaaa', 5, 1)]}
      />,
    )
    expect(screen.getByText('GJ05CD5678')).toBeDefined()
    expect(screen.getByText('GJ01AB1234')).toBeDefined()
  })
})
