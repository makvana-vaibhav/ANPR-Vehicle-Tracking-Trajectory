/**
 * The workspaces, and the screens inside each.
 *
 * Eleven screens in one flat list said nothing about which belong together.
 * Six workspaces say what each is for — what is happening now (Command, Live),
 * what already happened (Investigate), what needs someone (Alarms), the
 * estate itself (Network), the roads in aggregate (Insights) — and a seventh,
 * Admin, that most roles never see.
 *
 * A screen appears only to a role that can use it. An auditor shown "Vehicle
 * search" only to be refused on arrival learns that this system's errors are
 * noise, which is an expensive thing to teach a control room. A workspace
 * with no usable screen is not shown at all.
 */

import type { IconName } from '@/components/ui'
import { PERMISSIONS, type Permission } from '@/lib/permissions'

export interface NavPage {
  to: string
  label: string
  /** The permission that makes the screen usable at all. */
  needs: Permission
  /** Other paths that belong to this screen (a report opened from it). */
  also?: string[]
}

export interface Workspace {
  key: string
  label: string
  icon: IconName
  /** What the workspace is for, in a few words — shown in the search palette. */
  hint: string
  pages: NavPage[]
}

export const WORKSPACES: Workspace[] = [
  {
    key: 'command',
    label: 'Command',
    icon: 'dashboard',
    hint: 'The state of the network, now',
    pages: [{ to: '/dashboard', label: 'Command', needs: PERMISSIONS.cameraRead }],
  },
  {
    key: 'live',
    label: 'Live',
    icon: 'video',
    hint: 'Watch a camera and its plate reads',
    pages: [{ to: '/anpr', label: 'Live ANPR', needs: PERMISSIONS.streamView }],
  },
  {
    key: 'investigate',
    label: 'Investigate',
    icon: 'search',
    hint: "A vehicle's journey, its sightings and its registration",
    pages: [
      {
        to: '/vehicles',
        label: 'Vehicles',
        needs: PERMISSIONS.searchExecute,
        also: ['/reports/vehicle'],
      },
      // VAHAN, SARTHI, eGujCop and AFIS lookups — reference data, labelled.
      { to: '/registries', label: 'Registries', needs: PERMISSIONS.searchExecute },
    ],
  },
  {
    key: 'alarms',
    label: 'Alarms',
    icon: 'alert',
    hint: 'What needs a person, most severe first',
    pages: [
      { to: '/alerts', label: 'Alarms', needs: PERMISSIONS.alertRead },
      { to: '/watchlist', label: 'Watchlist', needs: PERMISSIONS.watchlistRead },
      // Faces, not plates: its own screen and its own grant, because reading
      // it shows photographs of people.
      { to: '/persons', label: 'Persons', needs: PERMISSIONS.personRead },
    ],
  },
  {
    key: 'network',
    label: 'Network',
    icon: 'map',
    hint: 'Cameras, where they are, and their health',
    pages: [
      { to: '/map', label: 'Map', needs: PERMISSIONS.cameraRead },
      { to: '/cameras', label: 'Cameras', needs: PERMISSIONS.cameraRead },
      { to: '/health', label: 'Fleet health', needs: PERMISSIONS.cameraRead },
    ],
  },
  {
    key: 'insights',
    label: 'Insights',
    icon: 'chart',
    hint: 'Traffic: flow, speed, congestion',
    pages: [{ to: '/traffic', label: 'Traffic', needs: PERMISSIONS.analyticsRead }],
  },
  {
    key: 'admin',
    label: 'Admin',
    icon: 'shield',
    hint: 'Accounts and the audit trail',
    pages: [
      { to: '/users', label: 'Accounts', needs: PERMISSIONS.userRead },
      { to: '/audit', label: 'Audit trail', needs: PERMISSIONS.auditRead },
    ],
  },
]

/** Every screen, flattened, in workspace order — used to pick a landing screen. */
export const NAV_ITEMS: NavPage[] = WORKSPACES.flatMap((w) => w.pages)

/** The screens of a workspace this role can open. */
export function visiblePages(
  workspace: Workspace,
  can: (permission: Permission) => boolean,
): NavPage[] {
  return workspace.pages.filter((page) => can(page.needs))
}

/** Where a role should land: the first screen it can open, in workspace order. */
export function landingFor(can: (permission: Permission) => boolean): string {
  return NAV_ITEMS.find((item) => can(item.needs))?.to ?? '/no-access'
}

function pageMatches(page: NavPage, pathname: string): boolean {
  return [page.to, ...(page.also ?? [])].some(
    (path) => pathname === path || pathname.startsWith(`${path}/`),
  )
}

/** The workspace and screen a path belongs to, if any. */
export function locate(pathname: string): { workspace: Workspace; page: NavPage } | null {
  for (const workspace of WORKSPACES) {
    const page = workspace.pages.find((p) => pageMatches(p, pathname))
    if (page) return { workspace, page }
  }
  return null
}
