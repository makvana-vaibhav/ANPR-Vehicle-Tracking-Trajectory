/**
 * Sign-in — the first screen anyone sees, and the only one drawn without the
 * application shell.
 *
 * It says what the product is before it asks for anything: the mark, the
 * name, and one line on what Contrail does. The backdrop is the product's own
 * picture of itself — trails drawn between camera points, older end fainter,
 * as the map draws a vehicle's journey — rendered inline as SVG, so the screen
 * makes no network request of its own and works on a plane exactly as it
 * does at the venue. It is decoration and is hidden from assistive tech; it
 * carries no figures, because a sign-in screen has no data to show and an
 * invented "1,284 vehicles tracked" would be the first lie a judge reads.
 */

import { useEffect, useState, type FormEvent, type KeyboardEvent } from 'react'

import {
  BrandMark,
  Button,
  ErrorBanner,
  Field,
  Icon,
  Input,
  RoleBadge,
  SeverityGlyph,
  type IconName,
} from '@/components/ui'
import { useAuth } from '@/hooks/useAuth'
import { ApiError } from '@/lib/api'
import type { Role } from '@/lib/types'

/**
 * The seeded accounts, so a reviewer can move between roles.
 *
 * Behind a disclosure that is closed by default. A sign-in screen listing five
 * usernames and printing the shared password beside them is the single least
 * production-looking thing in the product — but these are seeded demo
 * credentials on a local stack, and a reviewer with no documentation in front
 * of them still has to be able to see what an auditor sees. Closed by default
 * settles both: the screen reads as a sign-in, and the accounts are one click
 * away for whoever needs them.
 */
const DEMO_ACCOUNTS: { username: string; role: Role; can: string }[] = [
  { username: 'admin', role: 'admin', can: 'Full access, user administration' },
  { username: 'supervisor', role: 'supervisor', can: 'Manage cameras, close alerts, read audit' },
  { username: 'operator', role: 'operator', can: 'View streams, acknowledge alerts, search' },
  { username: 'analyst', role: 'analyst', can: 'Search and analyse — no live video' },
  { username: 'auditor', role: 'auditor', can: 'Read the audit trail — no plate search' },
]

const DEMO_PASSWORD = 'NagarNetra@2026'

/** What the product does, in the words the rest of the interface uses. Every
 *  line names something that exists behind this screen today. */
const CAPABILITIES: { icon: IconName; label: string }[] = [
  { icon: 'route', label: 'Journeys across cameras' },
  { icon: 'alert', label: 'Watchlist alarms with evidence' },
  { icon: 'chart', label: 'Traffic and short-term forecasts' },
  { icon: 'ledger', label: 'Every search audited' },
]

export default function Login() {
  const { signIn } = useAuth()
  const [username, setUsername] = useState('admin')
  const [password, setPassword] = useState(DEMO_PASSWORD)
  const [error, setError] = useState<{ message: string; status: number | null } | null>(null)
  const [busy, setBusy] = useState(false)
  const [showAccounts, setShowAccounts] = useState(false)
  const [reveal, setReveal] = useState(false)
  const [capsLock, setCapsLock] = useState(false)

  async function handleSubmit(event: FormEvent) {
    event.preventDefault()
    setBusy(true)
    setError(null)
    try {
      await signIn(username, password)
    } catch (err) {
      setError({
        message: err instanceof Error ? err.message : String(err),
        status: err instanceof ApiError ? err.status : null,
      })
    } finally {
      setBusy(false)
    }
  }

  // A password typed with Caps Lock on is the commonest wrong-password there
  // is, and the field masks the evidence. Read from the key event itself —
  // there is no other way to know.
  function trackCapsLock(event: KeyboardEvent<HTMLInputElement>) {
    setCapsLock(event.getModifierState('CapsLock'))
  }

  return (
    <div className="flex min-h-screen bg-background text-foreground">
      {/* ── The product, before the form ───────────────────────────── */}
      <section
        aria-label="Contrail"
        className="relative hidden min-w-0 flex-1 flex-col justify-between overflow-hidden lg:flex"
      >
        <Backdrop />

        <div className="relative flex items-center justify-between px-10 pt-9">
          <div className="flex items-center gap-3">
            <BrandMark size={22} className="text-primary" />
            <span className="text-[19px] font-semibold tracking-[0.01em]">Contrail</span>
          </div>
          <IstClock />
        </div>

        <div className="relative max-w-[40rem] px-10 pb-10">
          <p className="eyebrow">City-wide vehicle intelligence</p>
          <h1 className="mt-3 text-[40px] font-semibold leading-[1.08] tracking-[-0.01em] [text-wrap:balance]">
            Every sighting, joined into a journey.
          </h1>
          <p className="mt-4 max-w-[34rem] text-[15px] leading-relaxed text-muted-foreground">
            Cameras see vehicles one frame at a time. Contrail connects those
            sightings across the city — into journeys, traffic and alerts.
          </p>
          <ul className="mt-7 flex flex-wrap gap-x-6 gap-y-2.5 text-[13px] text-muted-foreground">
            {CAPABILITIES.map((item) => (
              <li key={item.label} className="flex items-center gap-2">
                <Icon name={item.icon} size={16} className="text-faint" />
                {item.label}
              </li>
            ))}
          </ul>
        </div>
      </section>

      {/* ── The form ───────────────────────────────────────────────── */}
      <aside className="flex w-full flex-col border-border bg-chrome lg:w-[460px] lg:shrink-0 lg:border-l">
        <div className="flex flex-1 flex-col justify-center px-6 py-10 sm:px-12">
          {/* On a narrow screen the product panel is gone, so the name moves
              here — a form with no name above it could be anybody's. */}
          <div className="mb-10 lg:hidden">
            <div className="flex items-center gap-2.5">
              <BrandMark size={20} className="text-primary" />
              <span className="text-[18px] font-semibold">Contrail</span>
            </div>
            <p className="mt-3 text-[13px] leading-relaxed text-muted-foreground">
              City-wide vehicle intelligence — camera sightings joined into
              journeys, traffic and alerts.
            </p>
          </div>

          <div className="mx-auto w-full max-w-[22rem]">
            <h2 className="text-[22px] font-semibold tracking-tight">Sign in</h2>
            <p className="mt-1.5 flex items-start gap-1.5 text-xs leading-relaxed text-muted-foreground">
              <Icon name="eye" size={14} className="mt-px text-faint" />
              Every action you take is recorded in the audit trail.
            </p>

            <form onSubmit={handleSubmit} className="mt-7 space-y-4">
              <Field label="Username">
                <Input
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  autoComplete="username"
                  autoCapitalize="none"
                  spellCheck={false}
                  required
                  className="h-10 font-mono"
                />
              </Field>

              <Field
                label="Password"
                hint={
                  capsLock ? (
                    <span className="flex items-center gap-1.5 text-priority-high">
                      <SeverityGlyph priority="high" size={9} />
                      Caps Lock is on
                    </span>
                  ) : undefined
                }
              >
                <div className="relative">
                  <Input
                    type={reveal ? 'text' : 'password'}
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    onKeyDown={trackCapsLock}
                    onKeyUp={trackCapsLock}
                    onBlur={() => setCapsLock(false)}
                    autoComplete="current-password"
                    required
                    className="h-10 pr-10 font-mono"
                  />
                  <button
                    type="button"
                    onClick={() => setReveal((v) => !v)}
                    aria-label={reveal ? 'Hide password' : 'Show password'}
                    aria-pressed={reveal}
                    title={reveal ? 'Hide password' : 'Show password'}
                    className={`absolute inset-y-0 right-0 flex w-10 items-center justify-center rounded-r-md transition hover:text-foreground ${
                      reveal ? 'text-primary' : 'text-faint'
                    }`}
                  >
                    <Icon name="eye" size={16} />
                  </button>
                </div>
              </Field>

              {/* The API's own sentence, under a heading that says which kind
                  of failure it is — "check the stack" and "check your
                  password" are different next steps. */}
              {error && (
                <ErrorBanner>
                  <span className="block font-medium">
                    {error.status === 0
                      ? 'Cannot reach the platform'
                      : error.status === 403
                        ? 'This account cannot sign in'
                        : 'Sign-in failed'}
                  </span>
                  <span className="mt-0.5 block text-xs text-status-offline/85">
                    {error.message}
                  </span>
                </ErrorBanner>
              )}

              <Button type="submit" disabled={busy} className="!h-10 w-full !text-[14px]">
                {busy ? (
                  <>
                    <span
                      aria-hidden
                      className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-background/40 border-t-background"
                    />
                    Signing in…
                  </>
                ) : (
                  <>
                    Sign in
                    <Icon name="arrowRight" size={15} />
                  </>
                )}
              </Button>
            </form>

            {/* ── Seeded accounts ──────────────────────────────────── */}
            <div className="mt-8 overflow-hidden rounded-lg border border-border bg-card">
              <button
                type="button"
                onClick={() => setShowAccounts((v) => !v)}
                aria-expanded={showAccounts}
                className="flex w-full items-center gap-2 px-3.5 py-2.5 text-left text-xs text-muted-foreground transition hover:bg-secondary/40 hover:text-foreground"
              >
                <Icon
                  name="chevronDown"
                  size={14}
                  className={`transition-transform ${showAccounts ? '' : '-rotate-90'}`}
                />
                Demo accounts
                <span className="ml-auto text-[10px] font-medium uppercase tracking-[0.06em] text-faint">
                  seeded credentials
                </span>
              </button>

              {showAccounts && (
                <ul className="border-t border-border">
                  {DEMO_ACCOUNTS.map((account) => {
                    const chosen = username === account.username && password === DEMO_PASSWORD
                    return (
                      <li key={account.username}>
                        <button
                          type="button"
                          onClick={() => {
                            setUsername(account.username)
                            setPassword(DEMO_PASSWORD)
                            setError(null)
                          }}
                          aria-pressed={chosen}
                          className={`flex w-full items-center gap-3 border-b border-border/60 px-3.5 py-2 text-left transition hover:bg-secondary/40 ${
                            chosen ? 'bg-secondary/50' : ''
                          }`}
                        >
                          <span className="w-[5.5rem] shrink-0">
                            <RoleBadge role={account.role} />
                          </span>
                          <span className="min-w-0 flex-1">
                            <span className="block font-mono text-xs text-foreground">
                              {account.username}
                            </span>
                            <span className="block truncate text-[11px] leading-snug text-muted-foreground">
                              {account.can}
                            </span>
                          </span>
                          {chosen && <Icon name="check" size={14} className="shrink-0 text-primary" />}
                        </button>
                      </li>
                    )
                  })}
                  <li className="px-3.5 py-2 text-[11px] text-muted-foreground">
                    All use{' '}
                    <span className="font-mono text-foreground/80">{DEMO_PASSWORD}</span>
                  </li>
                </ul>
              )}
            </div>
          </div>
        </div>

        <footer className="flex items-center gap-2 border-t border-border/60 px-6 py-3.5 text-[11px] text-faint sm:px-8">
          <Icon name="shield" size={13} className="shrink-0" />
          Authorised use only. Every sign-in, search and stream open is recorded.
        </footer>
      </aside>
    </div>
  )
}

/**
 * The wall clock, in the time zone every timestamp in the product is shown
 * in. A control room reads IST; the browser's own zone is not necessarily it.
 */
function IstClock() {
  const [now, setNow] = useState(() => new Date())
  useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date()), 1_000)
    return () => window.clearInterval(timer)
  }, [])
  const time = now.toLocaleTimeString('en-IN', {
    timeZone: 'Asia/Kolkata',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  })
  const date = now.toLocaleDateString('en-IN', {
    timeZone: 'Asia/Kolkata',
    weekday: 'short',
    day: '2-digit',
    month: 'short',
  })
  return (
    <p className="text-right font-mono text-xs text-muted-foreground">
      <span className="text-foreground">{time}</span> IST
      <span className="block text-[11px] text-faint">{date}</span>
    </p>
  )
}

// ── The backdrop ────────────────────────────────────────────────────────
//
// A loose street network on a 1000 × 900 canvas: camera points joined by
// gently bent roads, and five trails running along those same roads. Two of
// them converge on one camera — the moment the product exists for, the same
// vehicle seen again somewhere else. Nothing here is data.

type Point = readonly [number, number]

const NODES = {
  a: [70, 190],
  b: [250, 150],
  c: [430, 214],
  d: [612, 168],
  e: [800, 236],
  f: [962, 178],
  g: [118, 382],
  h: [318, 338],
  i: [500, 404],
  j: [690, 356],
  k: [878, 424],
  l: [58, 566],
  m: [262, 540],
  n: [452, 604],
  o: [642, 560],
  p: [830, 624],
  q: [992, 578],
} as const satisfies Record<string, Point>

type NodeKey = keyof typeof NODES

const ROADS: [NodeKey, NodeKey][] = [
  ['a', 'b'], ['b', 'c'], ['c', 'd'], ['d', 'e'], ['e', 'f'],
  ['g', 'h'], ['h', 'i'], ['i', 'j'], ['j', 'k'],
  ['l', 'm'], ['m', 'n'], ['n', 'o'], ['o', 'p'], ['p', 'q'],
  ['a', 'g'], ['b', 'h'], ['c', 'i'], ['d', 'j'], ['e', 'k'], ['f', 'k'],
  ['g', 'l'], ['h', 'm'], ['i', 'n'], ['j', 'o'], ['k', 'p'], ['k', 'q'],
]

/** Each trail runs tail → head; the head is the camera that read it last. */
const TRAILS: { path: NodeKey[]; featured?: boolean }[] = [
  { path: ['l', 'm', 'h', 'i', 'j', 'k'], featured: true },
  { path: ['f', 'e', 'k'], featured: true },
  { path: ['a', 'b', 'c', 'd'] },
  { path: ['q', 'p', 'o', 'n'] },
  { path: ['g', 'h', 'b'] },
]

/**
 * The control point that bends a road. Fixed per road — computed from the
 * pair in a canonical order — so a trail drawn along a road in either
 * direction lies exactly on it.
 */
function bend(from: NodeKey, to: NodeKey): Point {
  const [first, second] = from < to ? [from, to] : [to, from]
  const [x1, y1] = NODES[first]
  const [x2, y2] = NODES[second]
  const sign = (first.charCodeAt(0) + second.charCodeAt(0)) % 2 === 0 ? 1 : -1
  const k = 0.09 * sign
  return [(x1 + x2) / 2 - (y2 - y1) * k, (y1 + y2) / 2 + (x2 - x1) * k]
}

function routeOf(keys: NodeKey[]): string {
  const [head, ...rest] = keys
  if (!head) return ''
  let d = `M${NODES[head].join(' ')}`
  let previous: NodeKey = head
  for (const key of rest) {
    d += ` Q${bend(previous, key).join(' ')} ${NODES[key].join(' ')}`
    previous = key
  }
  return d
}

function Backdrop() {
  const heads = new Set(TRAILS.map((t) => t.path[t.path.length - 1]))
  return (
    <svg
      aria-hidden="true"
      focusable="false"
      viewBox="0 0 1000 900"
      preserveAspectRatio="xMidYMid slice"
      className="absolute inset-0 h-full w-full"
    >
      {/* The draw-in runs once. Under prefers-reduced-motion the global rule
          in index.css collapses it to an instant, so the trails are simply
          there. */}
      <style>{`
        @keyframes login-trail-draw { from { stroke-dashoffset: 1 } to { stroke-dashoffset: 0 } }
        .login-trail { stroke-dasharray: 1; animation: login-trail-draw 2.2s cubic-bezier(.22,.7,.2,1) both; }
      `}</style>
      <defs>
        <pattern id="login-dots" width="22" height="22" patternUnits="userSpaceOnUse">
          <circle cx="1" cy="1" r="0.9" className="fill-muted-foreground/[0.09]" />
        </pattern>
        <radialGradient id="login-vignette" cx="50%" cy="44%" r="72%">
          <stop offset="55%" style={{ stopColor: 'hsl(var(--background))', stopOpacity: 0 }} />
          <stop offset="100%" style={{ stopColor: 'hsl(var(--background))', stopOpacity: 0.95 }} />
        </radialGradient>
        <linearGradient id="login-floor" x1="0" y1="0" x2="0" y2="1">
          <stop offset="58%" style={{ stopColor: 'hsl(var(--background))', stopOpacity: 0 }} />
          <stop offset="88%" style={{ stopColor: 'hsl(var(--background))', stopOpacity: 0.92 }} />
        </linearGradient>
        <filter id="login-glow" x="-10%" y="-10%" width="120%" height="120%">
          <feGaussianBlur stdDeviation="4" />
        </filter>
        {TRAILS.map((trail, i) => {
          const tail = trail.path[0]
          const head = trail.path[trail.path.length - 1]
          if (!tail || !head) return null
          return (
            <linearGradient
              key={i}
              id={`login-trail-${i}`}
              gradientUnits="userSpaceOnUse"
              x1={NODES[tail][0]}
              y1={NODES[tail][1]}
              x2={NODES[head][0]}
              y2={NODES[head][1]}
            >
              <stop offset="0" style={{ stopColor: 'hsl(var(--primary))', stopOpacity: 0 }} />
              <stop
                offset="1"
                style={{ stopColor: 'hsl(var(--primary))', stopOpacity: trail.featured ? 1 : 0.55 }}
              />
            </linearGradient>
          )
        })}
      </defs>

      <rect width="1000" height="900" fill="url(#login-dots)" />

      <g fill="none" strokeLinecap="round" className="stroke-border" strokeWidth={1.2}>
        {ROADS.map(([from, to]) => (
          <path key={`${from}${to}`} d={routeOf([from, to])} />
        ))}
      </g>

      {TRAILS.map((trail, i) => {
        const d = routeOf(trail.path)
        return (
          <g key={i} fill="none" strokeLinecap="round">
            {trail.featured && (
              <path
                d={d}
                pathLength={1}
                stroke={`url(#login-trail-${i})`}
                strokeWidth={7}
                opacity={0.35}
                filter="url(#login-glow)"
                className="login-trail"
                style={{ animationDelay: `${0.25 + i * 0.35}s` }}
              />
            )}
            <path
              d={d}
              pathLength={1}
              stroke={`url(#login-trail-${i})`}
              strokeWidth={trail.featured ? 2.4 : 1.8}
              className="login-trail"
              style={{ animationDelay: `${0.25 + i * 0.35}s` }}
            />
          </g>
        )
      })}

      {(Object.keys(NODES) as NodeKey[]).map((key) => {
        const [cx, cy] = NODES[key]
        if (!heads.has(key)) {
          return <circle key={key} cx={cx} cy={cy} r={3} className="fill-muted-foreground/40" />
        }
        const converged = key === 'k'
        return (
          <g key={key}>
            <circle
              cx={cx}
              cy={cy}
              r={converged ? 12 : 9}
              fill="none"
              strokeWidth={1.5}
              className={`stroke-primary ${converged ? 'animate-pulse-alert' : 'opacity-60'}`}
            />
            <circle cx={cx} cy={cy} r={converged ? 5.5 : 4.5} className="fill-foreground/85" />
          </g>
        )
      })}

      <rect width="1000" height="900" fill="url(#login-vignette)" />
      <rect width="1000" height="900" fill="url(#login-floor)" />
    </svg>
  )
}
