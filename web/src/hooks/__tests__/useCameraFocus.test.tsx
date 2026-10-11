/**
 * The camera on screen asks to be analysed, for exactly as long as it is on
 * screen. Too little and an operator watches a feed with no boxes on it; too
 * much and a camera nobody is looking at holds an inference slot.
 */

import { renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { FOCUS_HEARTBEAT_MS, useCameraFocus } from '@/hooks/useCameraFocus'
import * as api from '@/lib/api'

function setVisibility(state: DocumentVisibilityState): void {
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: state })
}

const spyOnFocus = () => vi.spyOn(api, 'focusCamera').mockResolvedValue(undefined)

describe('useCameraFocus', () => {
  let focus: ReturnType<typeof spyOnFocus>

  beforeEach(() => {
    vi.useFakeTimers()
    setVisibility('visible')
    focus = spyOnFocus()
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
    setVisibility('visible')
  })

  it('asks as soon as a camera is shown, then keeps asking', () => {
    renderHook(() => useCameraFocus('cam-1'))
    expect(focus).toHaveBeenCalledTimes(1)
    expect(focus).toHaveBeenLastCalledWith('cam-1')

    vi.advanceTimersByTime(FOCUS_HEARTBEAT_MS * 2)
    expect(focus).toHaveBeenCalledTimes(3)
  })

  it('stops asking once the camera is closed', () => {
    const { unmount } = renderHook(() => useCameraFocus('cam-1'))
    unmount()
    vi.advanceTimersByTime(FOCUS_HEARTBEAT_MS * 3)
    expect(focus).toHaveBeenCalledTimes(1)
  })

  it('asks for the new camera when the operator switches', () => {
    const { rerender } = renderHook(({ id }) => useCameraFocus(id), {
      initialProps: { id: 'cam-1' },
    })
    rerender({ id: 'cam-2' })
    vi.advanceTimersByTime(FOCUS_HEARTBEAT_MS)
    expect(focus.mock.calls.map((call) => call[0])).toEqual(['cam-1', 'cam-2', 'cam-2'])
  })

  it('says nothing from a tab nobody is looking at', () => {
    setVisibility('hidden')
    renderHook(() => useCameraFocus('cam-1'))
    vi.advanceTimersByTime(FOCUS_HEARTBEAT_MS * 2)
    expect(focus).not.toHaveBeenCalled()

    setVisibility('visible')
    document.dispatchEvent(new Event('visibilitychange'))
    expect(focus).toHaveBeenCalledTimes(1)
  })

  it('asks for nothing when no camera is shown', () => {
    renderHook(() => useCameraFocus(null))
    vi.advanceTimersByTime(FOCUS_HEARTBEAT_MS)
    expect(focus).not.toHaveBeenCalled()
  })

  it('does not surface a failed heartbeat', async () => {
    focus.mockRejectedValue(new Error('network'))
    renderHook(() => useCameraFocus('cam-1'))
    await vi.advanceTimersByTimeAsync(FOCUS_HEARTBEAT_MS)
    expect(focus).toHaveBeenCalledTimes(2)
  })
})
