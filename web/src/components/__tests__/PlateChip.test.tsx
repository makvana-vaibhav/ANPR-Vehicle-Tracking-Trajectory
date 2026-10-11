/**
 * The plate chip: spaced as painted, the IND strip only where it belongs, and
 * a watched vehicle marked as one.
 */

import { render } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { PlateChip } from '@/components/ui'

describe('PlateChip', () => {
  it('draws an Indian plate with its strip, grouped as painted', () => {
    const { container } = render(<PlateChip plate="GJ03AB1234" />)
    expect(container.querySelector('.plate-strip')?.textContent).toBe('IND')
    expect(container.querySelector('.plate-text')?.textContent).toBe('GJ 03 AB 1234')
  })

  it('does not put an IND strip on a plate that is not Indian', () => {
    const { container } = render(<PlateChip plate="FJ14ZHY" />)
    expect(container.querySelector('.plate-strip')).toBeNull()
    expect(container.querySelector('.plate-text')?.textContent).toBe('FJ14ZHY')
  })

  it('marks a watched vehicle, and says so to a pointer', () => {
    const { container } = render(<PlateChip plate="GJ03AB1234" watched />)
    const chip = container.querySelector('.plate-chip')
    expect(chip?.classList.contains('is-watched')).toBe(true)
    expect(chip?.getAttribute('title')).toContain('watchlist')
  })
})
