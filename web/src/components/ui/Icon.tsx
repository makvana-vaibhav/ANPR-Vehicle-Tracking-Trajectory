/**
 * The product's icon set, drawn here rather than installed.
 *
 * Two reasons it is hand-rolled. An icon package is a runtime dependency and a
 * tree-shaking problem for the sake of a few dozen glyphs, and the obvious packages
 * (Lucide, Feather) carry a look that reads as "default choice" — every
 * dashboard built this year uses them.
 *
 * Every path is drawn on the same 24×24 grid at the same 1.5 stroke, with round
 * caps and joins, so the set looks like one hand. `currentColor` throughout: an
 * icon takes the colour of the text it sits beside, and never carries a colour
 * of its own.
 */

import type { SVGProps } from 'react'

export type IconName =
  | 'dashboard'
  | 'map'
  | 'video'
  | 'alert'
  | 'chart'
  | 'search'
  | 'bookmark'
  | 'pulse'
  | 'camera'
  | 'users'
  | 'ledger'
  | 'chevronLeft'
  | 'chevronDown'
  | 'info'
  | 'close'
  | 'arrowRight'
  | 'logout'
  | 'key'
  | 'grid'
  | 'route'
  | 'clock'
  | 'check'
  | 'plus'
  | 'download'
  | 'eye'
  | 'shield'
  | 'sliders'
  | 'external'
  | 'play'
  | 'pause'
  | 'chevronRight'
  | 'chevronUp'
  | 'command'
  | 'pin'
  | 'layers'
  | 'bell'
  | 'filter'
  | 'refresh'
  | 'live'
  | 'sun'
  | 'moon'
  | 'monitor'

/**
 * Path data only — every wrapper attribute is applied once, below, so a glyph
 * cannot drift from the set by carrying its own stroke width or cap style.
 */
const PATHS: Record<IconName, string> = {
  dashboard: 'M4 4h6v7H4zM14 4h6v4h-6zM14 12h6v8h-6zM4 15h6v5H4z',
  map: 'M9 4 3 6.5v13L9 17l6 3 6-2.5v-13L15 7zM9 4v13M15 7v13',
  video: 'M3 7a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2zM15 10l6-3.5v11L15 14z',
  alert: 'M12 4 3 19h18zM12 10v4M12 17h.01',
  chart: 'M4 20V10M10 20V4M16 20v-7M22 20H2',
  search: 'M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14zM20 20l-4.2-4.2',
  bookmark: 'M6 4h12v16l-6-4-6 4z',
  pulse: 'M2 12h4l3-7 4 14 3-7h6',
  camera: 'M3 8a2 2 0 0 1 2-2h2.5l1.5-2h6l1.5 2H19a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2zM12 16a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7z',
  users: 'M9 11a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7zM2 20c0-3.3 3.1-5.5 7-5.5s7 2.2 7 5.5M17 4.5a3.5 3.5 0 0 1 0 7M18 14.8c2.4.6 4 2.3 4 5.2',
  ledger: 'M5 3h11l3 3v15H5zM8 8h7M8 12h7M8 16h4',
  chevronLeft: 'm14 6-6 6 6 6',
  chevronDown: 'm6 9 6 6 6-6',
  info: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM12 11v5M12 8h.01',
  close: 'm6 6 12 12M18 6 6 18',
  arrowRight: 'M4 12h15M13 6l6 6-6 6',
  logout: 'M15 4h3a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-3M10 8l-4 4 4 4M6 12h11',
  key: 'M15 4a5 5 0 1 0-4.6 7L9 12.4 7.4 14 6 12.6 4 14.6 5.5 16 4 17.5 6 19.5 12.6 13A5 5 0 0 0 15 4zM16.5 7.5h.01',
  grid: 'M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z',
  route: 'M8 18a2 2 0 1 1-4 0 2 2 0 0 1 4 0zM20 6a2 2 0 1 1-4 0 2 2 0 0 1 4 0zM8 18h6a3 3 0 0 0 0-6h-4a3 3 0 0 1 0-6h6',
  clock: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM12 7v5l3 2',
  check: 'm5 12.5 4.5 4.5L19 7.5',
  plus: 'M12 5v14M5 12h14',
  download: 'M12 4v11M7 10.5l5 5 5-5M5 20h14',
  eye: 'M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12zM12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z',
  shield: 'M12 3 5 6v5.5c0 4.2 3 8 7 9.5 4-1.5 7-5.3 7-9.5V6z',
  sliders: 'M4 6h9M17 6h3M4 12h3M11 12h9M4 18h11M19 18h1M15 4v4M9 10v4M17 16v4',
  external: 'M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5',
  play: 'M7 5v14l12-7z',
  pause: 'M8 5v14M16 5v14',
  chevronRight: 'm10 6 6 6-6 6',
  chevronUp: 'm6 15 6-6 6 6',
  command: 'M9 6a3 3 0 1 0-3 3h12a3 3 0 1 0-3-3v12a3 3 0 1 0 3-3H6a3 3 0 1 0 3 3z',
  pin: 'M12 21s-7-6.2-7-11.5a7 7 0 0 1 14 0C19 14.8 12 21 12 21zM12 12a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5z',
  layers: 'm12 3 9 5-9 5-9-5zM3 13l9 5 9-5',
  bell: 'M6 16v-5a6 6 0 1 1 12 0v5l1.5 2h-15zM10 20.5a2 2 0 0 0 4 0',
  filter: 'M4 5h16l-6 7.5V19l-4 1.5v-8z',
  refresh: 'M20 11a8 8 0 0 0-14.8-4M4 4v4h4M4 13a8 8 0 0 0 14.8 4M20 20v-4h-4',
  live: 'M7.8 16.2a6 6 0 0 1 0-8.4M16.2 7.8a6 6 0 0 1 0 8.4M4.9 19.1a10 10 0 0 1 0-14.2M19.1 4.9a10 10 0 0 1 0 14.2M12 13a1 1 0 1 0 0-2 1 1 0 0 0 0 2z',
  sun: 'M12 16a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4',
  moon: 'M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5z',
  monitor: 'M3 5h18v11H3zM8 20h8M12 16v4',
}

interface IconProps extends Omit<SVGProps<SVGSVGElement>, 'name'> {
  name: IconName
  /** Edge length in px. The nav rail uses 18; inline hints use 14. */
  size?: number
}

export function Icon({ name, size = 18, className = '', ...rest }: IconProps) {
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      // Decorative by default: every icon in this product sits beside its own
      // label, so announcing it twice is noise. A caller using an icon as the
      // only content of a control passes its own aria-label and overrides this.
      aria-hidden="true"
      focusable="false"
      className={`shrink-0 ${className}`}
      {...rest}
    >
      <path d={PATHS[name]} />
    </svg>
  )
}
