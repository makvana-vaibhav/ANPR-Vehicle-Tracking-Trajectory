/**
 * Transient notices.
 *
 * The rule worth pinning is the asymmetry: a success may vanish, because the
 * outcome is visible in whatever changed, but a failure stays until somebody
 * dismisses it — an unread failure is one the operator assumes did not happen.
 */

import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { ToastProvider, useToast } from '@/components/Toast'

function Trigger() {
  const toast = useToast()
  return (
    <>
      <button type="button" onClick={() => toast.success('Saved the change.')}>
        ok
      </button>
      <button type="button" onClick={() => toast.error(new Error('The API refused it.'))}>
        fail
      </button>
      <button type="button" onClick={() => toast.info('Heads up.')}>
        note
      </button>
    </>
  )
}

describe('ToastProvider', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('lets a success clear itself but keeps a failure until it is dismissed', () => {
    render(
      <ToastProvider>
        <Trigger />
      </ToastProvider>,
    )

    fireEvent.click(screen.getByText('ok'))
    fireEvent.click(screen.getByText('fail'))
    expect(screen.queryByText('Saved the change.')).toBeTruthy()
    expect(screen.queryByText('The API refused it.')).toBeTruthy()

    act(() => {
      vi.advanceTimersByTime(10_000)
    })
    expect(screen.queryByText('Saved the change.')).toBeNull()
    expect(screen.queryByText('The API refused it.')).toBeTruthy()

    fireEvent.click(screen.getByLabelText('Dismiss'))
    expect(screen.queryByText('The API refused it.')).toBeNull()
  })

  it('marks a failure with a word and as an alert, not by colour alone', () => {
    render(
      <ToastProvider>
        <Trigger />
      </ToastProvider>,
    )
    fireEvent.click(screen.getByText('fail'))
    const alert = screen.getByRole('alert')
    expect(alert.textContent).toContain('Failed')
    expect(alert.textContent).toContain('The API refused it.')
  })

  it('offers to clear a pile of notices at once', () => {
    render(
      <ToastProvider>
        <Trigger />
      </ToastProvider>,
    )
    fireEvent.click(screen.getByText('fail'))
    fireEvent.click(screen.getByText('fail'))
    expect(screen.queryByText(/Clear all/)).toBeNull()
    fireEvent.click(screen.getByText('note'))
    fireEvent.click(screen.getByText(/Clear all 3/))
    expect(screen.queryByText('The API refused it.')).toBeNull()
    expect(screen.queryByText('Heads up.')).toBeNull()
  })
})
