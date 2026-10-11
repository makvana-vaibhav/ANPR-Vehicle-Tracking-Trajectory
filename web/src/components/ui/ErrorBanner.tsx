/** An error that stays on screen — see Toast.tsx's note on why failures are
 *  not auto-dismissed. Used for the handful of screens where the error
 *  blocks the whole view rather than one action within it. */

import type { ReactNode } from 'react'

export function ErrorBanner({ children }: { children: ReactNode }) {
  return (
    <p role="alert" className="rounded-md border border-status-offline/40 bg-status-offline/[0.08] px-4 py-2 text-[13px] text-status-offline">
      {children}
    </p>
  )
}
