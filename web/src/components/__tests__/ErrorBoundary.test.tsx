/**
 * A screen that throws keeps the rest of the application, and a map that
 * cannot get WebGL fails in its own box instead of taking the page with it.
 */

import { render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import ErrorBoundary from '@/components/ErrorBoundary'

vi.mock('maplibre-gl', () => ({
  default: {
    Map: vi.fn(() => {
      throw new Error('{"statusMessage":"Could not create a WebGL context"}')
    }),
  },
}))

function Broken(): JSX.Element {
  throw new Error('the screen broke')
}

describe('ErrorBoundary', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('shows what failed and the ways out, instead of a blank window', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    render(
      <ErrorBoundary>
        <Broken />
      </ErrorBoundary>,
    )
    expect(screen.getByText('This screen stopped working')).toBeTruthy()
    expect(screen.getByText('the screen broke')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Try again' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Go to Command' })).toBeTruthy()
  })

  it('renders its children when nothing is wrong', () => {
    render(
      <ErrorBoundary>
        <p>all well</p>
      </ErrorBoundary>,
    )
    expect(screen.getByText('all well')).toBeTruthy()
  })
})

describe('createMap', () => {
  it('returns no map, rather than throwing, when WebGL is refused', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { createMap } = await import('@/lib/maps')
    const map = createMap({ container: document.createElement('div'), style: { version: 8, sources: {}, layers: [] } })
    expect(map).toBeNull()
  })
})
