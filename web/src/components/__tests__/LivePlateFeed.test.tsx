import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { describe, expect, it } from 'vitest'

import LivePlateFeed from '@/components/LivePlateFeed'
import { spacedPlate } from '@/lib/plates'
import type { LiveVehicleEvent } from '@/lib/types'

/**
 * A plate as the feed prints it — drawn as a plate, in its four groups. Looking
 * for the stored string would find nothing, and an assertion that it is
 * *absent* would then pass without testing anything.
 */
const drawn = (plate: string) => spacedPlate(plate)

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
    expect(screen.getByText(drawn('GJ01AB1234'))).toBeDefined()
    expect(screen.queryByText(drawn('GJ01AB1Z34'))).toBeNull()
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
    expect(screen.getByText(drawn('GJ05CD5678'))).toBeDefined()
    expect(screen.getByText(drawn('GJ01AB1234'))).toBeDefined()
  })

  it('prints when the car was seen in IST, from the capture instant', () => {
    // 14:00:00 UTC is 19:30:00 in Kolkata. The capture time, not the emit
    // time: the pipeline's own latency is no part of when the car was there.
    const event = { ...reading('GJ01AB1234', 'cam.aaaaaa'), captured_at: '2026-10-11T14:00:00Z' }
    event.event_time = '2026-10-11T14:00:01Z'
    render(<LivePlateFeed events={[event]} />)
    expect(screen.getByText('19:30:00')).toBeDefined()
  })

  it('says in words that a plate raised a watchlist alarm, and rings it', () => {
    render(
      <LivePlateFeed
        events={[reading('GJ01AB1234', 'cam.aaaaaa')]}
        watched={
          new Map([
            ['GJ01AB1234', { listed: 'GJ01AB1234', category: 'stolen', exact: true, priority: 'critical' }],
          ])
        }
      />,
    )
    expect(screen.getByText('On the watchlist · stolen')).toBeDefined()
    const chip = screen.getByText(drawn('GJ01AB1234')).closest('.plate-chip')
    expect(chip?.className).toContain('is-watched')
  })

  it('calls a near match a near match', () => {
    render(
      <LivePlateFeed
        events={[reading('GJ01AB1235', 'cam.aaaaaa')]}
        watched={
          new Map([
            ['GJ01AB1235', { listed: 'GJ01AB1234', category: 'stolen', exact: false, priority: 'high' }],
          ])
        }
      />,
    )
    expect(screen.getByText('Near match to watched GJ01AB1234 — verify')).toBeDefined()
  })

  it('does not flag a plate nothing has alarmed on', () => {
    render(<LivePlateFeed events={[reading('GJ01AB1234', 'cam.aaaaaa')]} watched={new Map()} />)
    expect(screen.queryByText(/watchlist/i)).toBeNull()
    const chip = screen.getByText(drawn('GJ01AB1234')).closest('.plate-chip')
    expect(chip?.className).not.toContain('is-watched')
  })

  it('draws a read the pipeline was not settled on as partial', () => {
    const unsure = reading('GJ01AB1234', 'cam.aaaaaa')
    unsure.plate.ambiguous = true
    render(<LivePlateFeed events={[unsure]} />)
    const chip = screen.getByText(drawn('GJ01AB1234')).closest('.plate-chip')
    expect(chip?.className).toContain('is-partial')
    expect(screen.getByText('ambiguous')).toBeDefined()
  })

  it('leads a plate to its journey when told where it leads', () => {
    render(
      <MemoryRouter>
        <LivePlateFeed
          events={[reading('GJ01AB1234', 'cam.aaaaaa')]}
          plateHref={(plate) => `/vehicles?plate=${plate}`}
        />
      </MemoryRouter>,
    )
    expect(screen.getByRole('link').getAttribute('href')).toBe('/vehicles?plate=GJ01AB1234')
  })
})
