/** The dashed-border placeholder shown when a list genuinely has nothing in
 *  it — as opposed to loading, which is a Skeleton, or failing, which is an
 *  ErrorBanner. Distinguishing the three is what keeps an empty screen from
 *  reading as a broken one. */

import type { ReactNode } from 'react'

export function EmptyState({
  title,
  hint,
  className = '',
}: {
  title: ReactNode
  hint?: ReactNode
  className?: string
}) {
  return (
    <div className={`rounded-lg border border-dashed border-border px-6 py-8 text-center ${className}`}>
      <p className="text-[13px] text-muted-foreground">{title}</p>
      {hint && <p className="mt-1 text-xs text-faint">{hint}</p>}
    </div>
  )
}
