/** The bordered card shell used for forms and grouped sections everywhere.
 *  One radius, one border weight, one background — the shape-consistency
 *  rule that made every hand-rolled `rounded-md border border-border
 *  bg-card p-4` block worth naming. */

import type { HTMLAttributes, ReactNode } from 'react'

import { InfoHint } from './InfoHint'

export function Panel({ className = '', ...rest }: HTMLAttributes<HTMLDivElement>) {
  return <div className={`rounded-lg border border-border bg-card p-4 ${className}`} {...rest} />
}

/**
 * A panel that owns the remaining height and scrolls its own body.
 *
 * The pattern a wall display needs: the page itself never scrolls, so a list
 * that outgrows its box scrolls inside the box and the surrounding layout
 * holds still. Without this every long list pushed the panels below it off the
 * bottom of a screen nobody is going to scroll.
 */
export function ScrollPanel({
  title,
  info,
  caption,
  action,
  children,
  className = '',
  bodyClassName = '',
}: {
  title: string
  info?: ReactNode
  /** A few words of scope beside the title ("3 open · most severe first"). */
  caption?: ReactNode
  action?: ReactNode
  children: ReactNode
  className?: string
  bodyClassName?: string
}) {
  return (
    <section
      className={`flex min-h-0 flex-col overflow-hidden rounded-lg border border-border bg-card ${className}`}
    >
      <div className="flex shrink-0 items-center gap-3 border-b border-border px-4 py-2.5">
        <h2 className="flex items-center gap-1.5 text-[13px] font-semibold">
          {title}
          {info && <InfoHint>{info}</InfoHint>}
        </h2>
        {caption && <span className="truncate text-xs text-faint">{caption}</span>}
        {action && <div className="ml-auto shrink-0">{action}</div>}
      </div>
      <div className={`min-h-0 flex-1 overflow-y-auto p-3 ${bodyClassName}`}>{children}</div>
    </section>
  )
}

export function PanelHeader({
  title,
  info,
  caption,
  action,
}: {
  title: string
  /** Methodology and caveats — anything that would otherwise be a paragraph. */
  info?: ReactNode
  /** A handful of words of scope. Not a place to explain the panel. */
  caption?: ReactNode
  action?: ReactNode
}) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <div className="min-w-0">
        <h2 className="flex items-center gap-1.5 text-[13px] font-semibold">
          {title}
          {info && <InfoHint>{info}</InfoHint>}
        </h2>
        {caption && <p className="mt-0.5 text-xs text-faint">{caption}</p>}
      </div>
      {action}
    </div>
  )
}
