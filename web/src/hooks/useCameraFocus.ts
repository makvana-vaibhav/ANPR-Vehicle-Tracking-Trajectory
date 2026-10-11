/**
 * Say a camera is on screen, so the ANPR workers analyse it first.
 *
 * One machine cannot read plates on the whole grid at once, so the workers run
 * a short always-on list and rotate the rest — which left the camera an
 * operator had just opened waiting minutes for its turn, showing video with no
 * boxes on it. While a camera is shown here the page sends a heartbeat, and
 * the worker that owns the camera puts it first.
 *
 * A heartbeat rather than one request, so a closed tab or a dropped connection
 * lets it lapse on its own (45 s after the last one, server-side). Sent only
 * while the tab is visible: a camera in a background tab is not being watched.
 * Failures are ignored — a lost heartbeat costs seconds of priority and is no
 * reason to put an error on the screen of the person watching.
 */

import { useEffect } from 'react'

import * as api from '@/lib/api'

/** How often the open camera says it is on screen. */
export const FOCUS_HEARTBEAT_MS = 15_000

export function useCameraFocus(cameraId: string | null): void {
  useEffect(() => {
    if (!cameraId) return
    const send = () => {
      if (document.visibilityState === 'visible') {
        void api.focusCamera(cameraId).catch(() => undefined)
      }
    }
    send()
    const timer = window.setInterval(send, FOCUS_HEARTBEAT_MS)
    document.addEventListener('visibilitychange', send)
    return () => {
      window.clearInterval(timer)
      document.removeEventListener('visibilitychange', send)
    }
  }, [cameraId])
}
