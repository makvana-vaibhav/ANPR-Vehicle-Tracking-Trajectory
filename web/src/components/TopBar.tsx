/**
 * The top bar: brand, workspaces, search, feed state, account.
 *
 * It replaced a left rail of eleven screens in three groups. The rail took a
 * column from every page — the map and the video wall most of all, which are
 * the two screens that most want the width — and listed screens rather than
 * jobs. Workspaces are jobs; the screens inside one appear as a second row
 * only while that workspace is open.
 *
 * Search sits in the bar because it is the fastest way anywhere: a plate, a
 * camera or a screen, from any page, with ⌘K. See CommandPalette.
 */

import { useEffect, useRef, useState } from 'react'
import { Link, NavLink, useLocation } from 'react-router-dom'

import { BrandMark, Icon } from '@/components/ui'
import { useAuth } from '@/hooks/useAuth'
import { useEventStream } from '@/hooks/useEventStream'
import { useOpenAlarms } from '@/hooks/useOpenAlarms'
import { landingFor, locate, visiblePages, WORKSPACES } from '@/lib/nav'
import { ROLE_SUMMARY } from '@/lib/permissions'

/** "⌘K" on a Mac, "Ctrl K" elsewhere — the hint should name the keys the
 *  operator actually has. */
export function shortcutLabel(): string {
  const platform =
    typeof navigator === 'undefined'
      ? ''
      : ((navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData
          ?.platform ?? navigator.platform)
  return /mac|iphone|ipad/i.test(platform) ? '⌘K' : 'Ctrl K'
}

export default function TopBar({ onOpenSearch }: { onOpenSearch: () => void }) {
  const { can } = useAuth()
  const { pathname } = useLocation()
  const here = locate(pathname)

  const workspaces = WORKSPACES.map((w) => ({ ...w, usable: visiblePages(w, can) })).filter(
    (w) => w.usable.length > 0,
  )
  const current = here ? workspaces.find((w) => w.key === here.workspace.key) : undefined
  const subPages = current?.usable ?? []

  // The tab names the screen, so a wall of browser tabs can be told apart.
  const screen = here?.page.label
  useEffect(() => {
    document.title = screen ? `${screen} · Contrail` : 'Contrail'
  }, [screen])

  return (
    <header className="shrink-0 border-b border-border bg-chrome print:hidden">
      {/* Wraps below md: the workspaces drop to a scrolling row of their own
          rather than running off the edge of a phone. */}
      <div className="flex min-h-[52px] flex-wrap items-center gap-x-4 px-4 md:flex-nowrap">
        <Link
          to={landingFor(can)}
          className="flex shrink-0 items-center gap-2 text-[15px] font-semibold tracking-[0.01em] text-foreground"
        >
          <BrandMark size={16} className="text-primary" />
          Contrail
        </Link>

        <nav
          aria-label="Workspaces"
          className="order-last -mx-4 flex h-11 w-[calc(100%+2rem)] items-stretch gap-0.5 overflow-x-auto border-t border-border/60 px-2 md:order-none md:mx-0 md:h-auto md:w-auto md:self-stretch md:overflow-visible md:border-0 md:px-0"
        >
          {workspaces.map((w) => {
            const active = current?.key === w.key
            return (
              <Link
                key={w.key}
                to={w.usable[0]?.to ?? '/'}
                aria-current={active ? 'page' : undefined}
                title={w.hint}
                className={`flex shrink-0 items-center gap-2 border-b-2 px-2.5 text-[13px] transition xl:px-3 ${
                  active
                    ? 'border-primary font-medium text-foreground'
                    : 'border-transparent text-muted-foreground hover:text-foreground'
                }`}
              >
                <Icon name={w.icon} size={16} className="hidden md:block lg:hidden" />
                {/* Words on a phone's own row and on a wide screen; icons only
                    in the squeeze between, where the row has to share. */}
                <span className="md:hidden lg:inline">{w.label}</span>
                {w.key === 'alarms' && <AlarmCount />}
              </Link>
            )
          })}
        </nav>

        <button
          type="button"
          onClick={onOpenSearch}
          aria-label="Search plates, cameras and screens"
          className="my-2 flex h-[34px] min-w-0 flex-1 basis-24 items-center gap-2.5 rounded-lg border border-input bg-background px-2.5 text-left text-[13px] text-faint transition hover:border-muted-foreground/50 md:my-0 md:max-w-[420px]"
        >
          <Icon name="search" size={15} />
          <span className="hidden truncate sm:inline">Plate, camera or screen</span>
          <span className="kbd ml-auto hidden sm:inline-flex">{shortcutLabel()}</span>
        </button>

        <div className="ml-auto flex shrink-0 items-center gap-3">
          <FeedPill />
          <AccountMenu />
        </div>
      </div>

      {/* The screens of the open workspace — only when there is a choice. */}
      {current && subPages.length > 1 && (
        <nav
          aria-label={`${current.label} screens`}
          className="flex h-10 items-center gap-1 overflow-x-auto border-t border-border/60 px-4"
        >
          <span className="mr-2 text-[11px] font-medium uppercase tracking-[0.06em] text-faint">
            {current.label}
          </span>
          {subPages.map((page) => (
            <NavLink
              key={page.to}
              to={page.to}
              className={({ isActive }) =>
                `whitespace-nowrap rounded-md px-2.5 py-1 text-[13px] transition ${
                  isActive || here?.page.to === page.to
                    ? 'bg-secondary text-foreground shadow-[inset_0_0_0_1px_hsl(var(--input))]'
                    : 'text-muted-foreground hover:bg-secondary/50 hover:text-foreground'
                }`
              }
            >
              {page.label}
            </NavLink>
          ))}
        </nav>
      )}
    </header>
  )
}

/**
 * Open alarms, on the tab itself — an operator watching one camera has to
 * learn that another just fired without being on the Alarms screen. Red only
 * when one of them is critical; otherwise a quiet count.
 */
function AlarmCount() {
  const { open, critical } = useOpenAlarms()
  if (!open) return null
  return (
    <span
      aria-label={`${open} open alarms${critical ? `, ${critical} critical` : ''}`}
      className={`inline-flex h-[18px] min-w-[18px] items-center justify-center rounded-full px-1.5 font-mono text-[11px] font-medium ${
        critical
          ? 'bg-priority-critical text-priority-critical-ink'
          : 'bg-secondary text-foreground shadow-[inset_0_0_0_1px_hsl(var(--input))]'
      }`}
    >
      {open}
    </span>
  )
}

/**
 * The live event feed's state, on every screen.
 *
 * Every counter in this product is historical and none of them stops looking
 * healthy when the pipeline dies. This is the one indicator that says whether
 * what you are looking at is still being updated.
 */
function FeedPill() {
  const { status } = useEventStream()
  const live = status === 'live'
  const label =
    status === 'live'
      ? 'Live'
      : status === 'connecting'
        ? 'Connecting'
        : status === 'reconnecting'
          ? 'Reconnecting'
          : 'Offline'
  return (
    <span
      title={
        live
          ? 'Connected to the live event feed — reads and alarms arrive as they happen'
          : 'Not connected to the live event feed — every figure on screen is historical and nothing new will appear until it reconnects'
      }
      className={`inline-flex h-7 items-center gap-2 rounded-full border px-2.5 text-xs ${
        live
          ? 'border-border text-muted-foreground'
          : 'border-priority-high/40 bg-priority-high/10 text-priority-high'
      }`}
    >
      <span
        className={`h-[7px] w-[7px] rounded-full ${
          live ? 'animate-pulse-alert bg-primary' : 'bg-priority-high'
        }`}
      />
      <span className="hidden md:inline">{label}</span>
    </span>
  )
}

function initialsOf(name: string): string {
  const words = name.trim().split(/[\s._-]+/).filter(Boolean)
  if (words.length >= 2) return `${words[0]?.charAt(0) ?? ''}${words[1]?.charAt(0) ?? ''}`.toUpperCase()
  return name.slice(0, 2).toUpperCase()
}

function AccountMenu() {
  const { user, signOut } = useAuth()
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  // A menu that only closes by re-clicking its own trigger is a menu that gets
  // left open behind whatever the operator does next.
  useEffect(() => {
    if (!open) return
    function onPointerDown(event: MouseEvent) {
      if (!ref.current?.contains(event.target as Node)) setOpen(false)
    }
    function onKey(event: KeyboardEvent) {
      if (event.key === 'Escape') setOpen(false)
    }
    window.addEventListener('mousedown', onPointerDown)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('mousedown', onPointerDown)
      window.removeEventListener('keydown', onKey)
    }
  }, [open])

  if (!user) return null
  const display = user.full_name || user.username
  const mustChange = Boolean(user.must_change_password)

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-haspopup="menu"
        aria-label={`Signed in as ${display}`}
        className="flex items-center gap-2 rounded-full py-0.5 pl-0.5 pr-1.5 text-muted-foreground transition hover:bg-secondary/60 hover:text-foreground"
      >
        <span
          aria-hidden
          className="relative grid h-[30px] w-[30px] place-items-center rounded-full bg-secondary text-[11px] font-semibold text-foreground"
        >
          {initialsOf(display)}
          {/* A password an administrator set is a shared secret, and nothing
              this account does is attributable until it is replaced. */}
          {mustChange && (
            <span className="absolute -right-0.5 -top-0.5 h-2.5 w-2.5 rounded-full bg-priority-high ring-2 ring-chrome" />
          )}
        </span>
        <span className="hidden max-w-[10rem] truncate text-xs xl:inline">{display}</span>
        <Icon name="chevronDown" size={13} className="hidden xl:block" />
      </button>

      {open && (
        <div
          role="menu"
          className="absolute right-0 top-[calc(100%+6px)] z-50 w-64 overflow-hidden rounded-lg border border-border bg-popover shadow-2xl"
        >
          <div className="border-b border-border px-3 py-2.5">
            <p className="truncate text-[13px] font-medium">{display}</p>
            <p className="mt-0.5 font-mono text-[11px] text-faint">
              {user.username} · {user.role}
            </p>
            <p className="mt-1.5 text-xs leading-snug text-muted-foreground">
              {ROLE_SUMMARY[user.role] ?? ''}
            </p>
          </div>
          <Link
            to="/password"
            role="menuitem"
            onClick={() => setOpen(false)}
            className="flex items-center gap-2 px-3 py-2 text-[13px] transition hover:bg-secondary"
          >
            <Icon name="key" size={15} />
            {mustChange ? 'Set your password' : 'Change password'}
            {mustChange && <span className="ml-auto h-1.5 w-1.5 rounded-full bg-priority-high" />}
          </Link>
          <button
            type="button"
            role="menuitem"
            onClick={() => void signOut()}
            className="flex w-full items-center gap-2 border-t border-border px-3 py-2 text-[13px] transition hover:bg-secondary"
          >
            <Icon name="logout" size={15} />
            Sign out
          </button>
        </div>
      )}
    </div>
  )
}
