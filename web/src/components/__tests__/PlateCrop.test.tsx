/**
 * The plate crop: shown only once it has loaded, quiet when it has not, and
 * steady across a refresh that re-signs the same photograph's link.
 */

import { act, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import PlateCrop from '@/components/PlateCrop'

/** A stand-in for the browser's Image: loads only when a test says so. */
class ProbeImage {
  static made: ProbeImage[] = []
  onload: (() => void) | null = null
  src = ''
  constructor() {
    ProbeImage.made.push(this)
  }
}

const loadLatest = () =>
  act(() => {
    ProbeImage.made.at(-1)?.onload?.()
  })

describe('PlateCrop', () => {
  beforeEach(() => {
    ProbeImage.made = []
    vi.stubGlobal('Image', ProbeImage)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('shows nothing — or the fallback — until the photograph has loaded', () => {
    render(
      <PlateCrop
        url="https://store/crops/a.jpg?X-Amz-Signature=1"
        plate="GJ03AB1234"
        fallback={<span>waiting for the crop</span>}
      />,
    )
    expect(screen.queryByRole('img')).toBeNull()
    expect(screen.getByText('waiting for the crop')).toBeTruthy()

    loadLatest()
    expect(screen.getByRole('img').getAttribute('src')).toBe('https://store/crops/a.jpg?X-Amz-Signature=1')
    expect(screen.queryByText('waiting for the crop')).toBeNull()
  })

  it('renders nothing at all without a fallback, as a table row wants', () => {
    const { container } = render(<PlateCrop url={null} plate={null} />)
    expect(container.innerHTML).toBe('')
  })

  it('keeps the photograph on screen when only the signature changes', () => {
    const view = render(<PlateCrop url="https://store/crops/a.jpg?X-Amz-Signature=1" plate="P" />)
    loadLatest()

    view.rerender(<PlateCrop url="https://store/crops/a.jpg?X-Amz-Signature=2" plate="P" />)
    expect(screen.getByRole('img').getAttribute('src')).toBe('https://store/crops/a.jpg?X-Amz-Signature=1')

    loadLatest()
    expect(screen.getByRole('img').getAttribute('src')).toBe('https://store/crops/a.jpg?X-Amz-Signature=2')
  })

  it('never shows one sighting’s crop against another', () => {
    const view = render(<PlateCrop url="https://store/crops/a.jpg?X-Amz-Signature=1" plate="P" />)
    loadLatest()

    view.rerender(<PlateCrop url="https://store/crops/b.jpg?X-Amz-Signature=1" plate="Q" />)
    expect(screen.queryByRole('img')).toBeNull()
  })
})
