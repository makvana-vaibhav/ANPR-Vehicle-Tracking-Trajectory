/** @type {import('tailwindcss').Config} */

// Contrail command centre theme.
//
// Dark by default: this is a wall-mounted operations display in a control room,
// not a document. The palette is shadcn/ui-compatible (HSL CSS variables in
// src/styles/index.css) so components drop in without restyling.
//
// Status colours are semantic and used consistently everywhere a camera, alert,
// or route hop is rendered — an operator learns them once.
export default {
  darkMode: ['class'],
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    container: {
      center: true,
      padding: '1.5rem',
      screens: { '2xl': '1600px' },
    },
    extend: {
      colors: {
        border: 'hsl(var(--border))',
        input: 'hsl(var(--input))',
        ring: 'hsl(var(--ring))',
        background: 'hsl(var(--background))',
        foreground: 'hsl(var(--foreground))',
        primary: {
          DEFAULT: 'hsl(var(--primary))',
          foreground: 'hsl(var(--primary-foreground))',
        },
        secondary: {
          DEFAULT: 'hsl(var(--secondary))',
          foreground: 'hsl(var(--secondary-foreground))',
        },
        destructive: {
          DEFAULT: 'hsl(var(--destructive))',
          foreground: 'hsl(var(--destructive-foreground))',
        },
        muted: {
          DEFAULT: 'hsl(var(--muted))',
          foreground: 'hsl(var(--muted-foreground))',
        },
        // Tertiary text: captions and units.
        faint: 'hsl(var(--faint))',
        accent: {
          DEFAULT: 'hsl(var(--accent))',
          foreground: 'hsl(var(--accent-foreground))',
        },
        popover: {
          DEFAULT: 'hsl(var(--popover))',
          foreground: 'hsl(var(--popover-foreground))',
        },
        card: {
          DEFAULT: 'hsl(var(--card))',
          foreground: 'hsl(var(--card-foreground))',
        },

        // ── Semantic status palette ──────────────────────────────────
        // Camera fleet state, alert priority, and route-hop confidence all
        // map onto these. Never hardcode a status colour in a component.
        status: {
          online: 'hsl(var(--status-online))',
          offline: 'hsl(var(--status-offline))',
          degraded: 'hsl(var(--status-degraded))',
          unknown: 'hsl(var(--status-unknown))',
        },
        priority: {
          critical: 'hsl(var(--priority-critical))',
          high: 'hsl(var(--priority-high))',
          medium: 'hsl(var(--priority-medium))',
          low: 'hsl(var(--priority-low))',
          // Text on a filled severity badge.
          'critical-ink': 'hsl(var(--priority-critical-ink))',
          'high-ink': 'hsl(var(--priority-high-ink))',
          'medium-ink': 'hsl(var(--priority-medium-ink))',
        },
        // Top bar and docked side panels.
        chrome: 'hsl(var(--chrome))',
        // A camera or a stop drawn on a map.
        place: 'hsl(var(--place))',

        // ── Chart series ─────────────────────────────────────────────
        // Categorical identity for chart marks, and nothing else. Kept apart
        // from `status` and `priority` on purpose: see the note in index.css.
        // Assigned in fixed slot order, never cycled.
        chart: {
          1: 'hsl(var(--chart-1))',
          2: 'hsl(var(--chart-2))',
          3: 'hsl(var(--chart-3))',
          4: 'hsl(var(--chart-4))',
          other: 'hsl(var(--chart-other))',
        },
      },
      borderRadius: {
        lg: 'var(--radius)',
        md: 'calc(var(--radius) - 2px)',
        sm: 'calc(var(--radius) - 4px)',
      },
      fontFamily: {
        // All three faces are self-hosted and imported in src/styles/index.css.
        // The names here must match the `font-family` those @font-face rules
        // declare — a name that loads nothing falls through to system-ui
        // silently, which this product did for months.
        //
        // IBM Plex Sans for the interface: engineered, plain, real tabular
        // figures — a screen made almost entirely of counts and timestamps.
        sans: [
          'IBM Plex Sans',
          'system-ui',
          '-apple-system',
          'Segoe UI',
          'sans-serif',
        ],
        // Timestamps, camera codes and coordinates are read character by
        // character — they belong in a monospace face.
        mono: [
          'IBM Plex Mono',
          'SFMono-Regular',
          'Menlo',
          'monospace',
        ],
        // Number plates only. Condensed and bold, like the plate itself.
        plate: ['Barlow Condensed', 'Arial Narrow', 'sans-serif'],
      },
      keyframes: {
        'pulse-alert': {
          '0%, 100%': { opacity: '1' },
          '50%': { opacity: '0.45' },
        },
        'ticker-in': {
          from: { opacity: '0', transform: 'translateY(-6px)' },
          to: { opacity: '1', transform: 'translateY(0)' },
        },
        // A plate read at a place on the map: one ring, expanding and fading.
        ripple: {
          from: { opacity: '0.9', transform: 'translate(-50%, -50%) scale(0.5)' },
          to: { opacity: '0', transform: 'translate(-50%, -50%) scale(2.6)' },
        },
      },
      animation: {
        // Critical alerts pulse until acknowledged.
        'pulse-alert': 'pulse-alert 1.4s ease-in-out infinite',
        'ticker-in': 'ticker-in 220ms ease-out',
        ripple: 'ripple 1.4s cubic-bezier(0.2, 0.6, 0.3, 1) forwards',
      },
    },
  },
  plugins: [],
}
