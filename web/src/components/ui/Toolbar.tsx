/**
 * The filter row.
 *
 * Traffic, Vehicle Search, Audit, Cameras and the map rail each grew their own
 * version of "a labelled control sitting next to another labelled control",
 * and they disagreed about the label size, the gap, and whether the label was
 * a `<span>` or a `<Field>`. `Field` already owns the label-above-control case
 * for forms; this owns the toolbar case, where the controls are filters that
 * apply immediately rather than inputs that are submitted.
 */

import { useId, type ReactNode } from 'react'

export function Toolbar({ children }: { children: ReactNode }) {
  return (
    <div className="flex flex-wrap items-end gap-x-4 gap-y-3">{children}</div>
  )
}

/**
 * One labelled control inside a Toolbar.
 *
 * `group` for a row of buttons (a SegmentedControl): a `<label>` around
 * buttons hands the caption to the first one as its name, and a click on the
 * caption presses it — which reset the filter to its first option.
 */
export function ToolbarField({
  label,
  children,
  className = '',
  group = false,
}: {
  label: ReactNode
  children: ReactNode
  className?: string
  group?: boolean
}) {
  const id = useId()
  const caption = (
    <span
      id={group ? id : undefined}
      className="block text-[11px] font-medium uppercase tracking-[0.06em] text-muted-foreground"
    >
      {label}
    </span>
  )
  if (group) {
    return (
      <div role="group" aria-labelledby={id} className={`block ${className}`}>
        {caption}
        <div className="mt-1">{children}</div>
      </div>
    )
  }
  return (
    <label className={`block ${className}`}>
      {caption}
      <span className="mt-1 block">{children}</span>
    </label>
  )
}

/**
 * Pushes everything after it to the far edge of the toolbar.
 *
 * A plain `ml-auto` on the next child does the same thing, but only until
 * someone reorders the children — this says the intent out loud.
 */
export function ToolbarGap() {
  return <span className="ml-auto" />
}

/**
 * Horizontal tabs for switching between views of the same subject.
 *
 * Distinct from SegmentedControl, which filters one dataset (a time window, a
 * basemap). This swaps which panels are on screen, so it reads as navigation
 * and is built from real tab semantics.
 */
export function Tabs<T extends string>({
  tabs,
  value,
  onChange,
}: {
  tabs: { value: T; label: string; badge?: ReactNode }[]
  value: T
  onChange: (value: T) => void
}) {
  return (
    <div role="tablist" className="flex gap-1 border-b border-border">
      {tabs.map((tab) => {
        const active = tab.value === value
        return (
          <button
            key={tab.value}
            type="button"
            role="tab"
            aria-selected={active}
            onClick={() => onChange(tab.value)}
            className={`-mb-px flex items-center gap-1.5 border-b-2 px-3 py-2 text-[13px] transition ${
              active
                ? 'border-primary font-medium text-foreground'
                : 'border-transparent text-muted-foreground hover:border-border hover:text-foreground'
            }`}
          >
            {tab.label}
            {tab.badge}
          </button>
        )
      })}
    </div>
  )
}
