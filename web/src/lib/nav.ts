/**
 * The workspaces, and the screens inside each.
 *
 * Named for the job a constable or control-room operator came to do, in plain
 * words: see the network (Overview), watch cameras (Live), look a vehicle up
 * (Search), handle what needs a person (Alarms), look after the cameras
 * (Cameras). Traffic figures and administration are secondary and share one
 * last tab, More. Every route keeps its path — only the labels and grouping
 * changed — so deep links and the browser flows still land.
 *
 * A screen appears only to a role that can use it. An auditor shown "Search"
 * only to be refused on arrival learns that this system's errors are noise,
 * which is an expensive thing to teach a control room. A workspace with no
 * usable screen is not shown at all.
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
    label: 'Overview',
    icon: 'dashboard',
    hint: 'Map, open alarms and plates being read',
    pages: [{ to: '/dashboard', label: 'Overview', needs: PERMISSIONS.cameraRead }],
  },
  {
    key: 'live',
    label: 'Live',
    icon: 'video',
    hint: 'Watch a camera and the plates it reads',
    pages: [{ to: '/anpr', label: 'Live cameras', needs: PERMISSIONS.streamView }],
  },
  {
    key: 'investigate',
    label: 'Search',
    icon: 'search',
    hint: 'Find a vehicle by plate and see where it has been',
    pages: [
      {
        to: '/vehicles',
        label: 'Search vehicle',
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
    hint: 'Watched vehicles seen, and cameras that stopped',
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
    label: 'Cameras',
    icon: 'camera',
    hint: 'Where the cameras are, their health, adding one',
    pages: [
      { to: '/map', label: 'Map', needs: PERMISSIONS.cameraRead },
      { to: '/cameras', label: 'All cameras', needs: PERMISSIONS.cameraRead },
      { to: '/health', label: 'Health', needs: PERMISSIONS.cameraRead },
    ],
  },
  {
    key: 'more',
    label: 'More',
    icon: 'chart',
    hint: 'Traffic figures, accounts and the audit trail',
    pages: [
      { to: '/traffic', label: 'Traffic', needs: PERMISSIONS.analyticsRead },
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
