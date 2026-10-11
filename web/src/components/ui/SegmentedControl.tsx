/** A row of mutually-exclusive choices — time windows, basemap picks,
 *  status filters. VehicleSearch and AuditLog each hand-rolled the same
 *  "1h / 24h / 7d / 30d" control independently; this is the one they both
 *  should have been.
 *
 *  The chosen option is raised, not painted in the accent: a filter is a
 *  setting, and the accent is reserved for the trail and for what is live. */

export function SegmentedControl<T extends string>({
  options,
  value,
  onChange,
  disabledValues,
  fill = false,
  className = '',
}: {
  options: { value: T; label: string; title?: string }[]
  value: T
  onChange: (value: T) => void
  disabledValues?: T[]
  /** Stretch to the container's width, the options sharing it equally. */
  fill?: boolean
  /** For matching the height of a neighbouring control in a toolbar row. */
  className?: string
}) {
  return (
    <div
      role="radiogroup"
      className={`flex gap-0.5 rounded-md border border-border bg-background/60 p-0.5 ${fill ? 'w-full [&>button]:flex-1' : ''} ${className}`}
    >
      {options.map((opt) => {
        const active = value === opt.value
        return (
          <button
            key={opt.value}
            type="button"
            role="radio"
            aria-checked={active}
            title={opt.title}
            disabled={disabledValues?.includes(opt.value)}
            onClick={() => onChange(opt.value)}
            className={`rounded-[5px] px-2.5 py-1 text-xs transition disabled:cursor-not-allowed disabled:opacity-40 ${
              active
                ? 'bg-secondary text-foreground shadow-[inset_0_0_0_1px_hsl(var(--input))]'
                : 'text-muted-foreground hover:bg-secondary/50 hover:text-foreground'
            }`}
          >
            {opt.label}
          </button>
        )
      })}
    </div>
  )
}
