/**
 * The workspaces and who sees them.
 *
 * A tab a role cannot use teaches that role that this system's errors are
 * noise, so the map from screen to permission is worth pinning: every screen
 * names a permission the API actually has, a role lands on the first screen
 * it can open, and a report opened from Investigate still counts as being in
 * Investigate.
 */

import { describe, expect, it } from 'vitest'

import { landingFor, locate, NAV_ITEMS, visiblePages, WORKSPACES } from '@/lib/nav'
import { PERMISSIONS, type Permission } from '@/lib/permissions'

const KNOWN = new Set<string>(Object.values(PERMISSIONS))
const everything = () => true
const only =
  (...allowed: Permission[]) =>
  (permission: Permission) =>
    allowed.includes(permission)

describe('workspaces', () => {
  it('ask only for permissions the API defines', () => {
    for (const page of NAV_ITEMS) expect(KNOWN.has(page.needs)).toBe(true)
  })

  it('give every screen exactly one home', () => {
    const paths = NAV_ITEMS.map((page) => page.to)
    expect(new Set(paths).size).toBe(paths.length)
  })

  it('lead with the Overview', () => {
    expect(WORKSPACES[0]?.key).toBe('command')
    expect(landingFor(everything)).toBe('/dashboard')
  })
})

describe('landingFor', () => {
  it('sends a role to the first screen it can open', () => {
    expect(landingFor(only(PERMISSIONS.auditRead))).toBe('/audit')
    expect(landingFor(only(PERMISSIONS.searchExecute, PERMISSIONS.alertRead))).toBe('/vehicles')
  })

  it('has somewhere to send a role that can open nothing', () => {
    expect(landingFor(() => false)).toBe('/no-access')
  })
})

describe('visiblePages', () => {
  it('hides the screens a role cannot use', () => {
    const alarms = WORKSPACES.find((w) => w.key === 'alarms')
    expect(alarms).toBeDefined()
    if (!alarms) return
    expect(visiblePages(alarms, only(PERMISSIONS.alertRead)).map((p) => p.to)).toEqual(['/alerts'])
    expect(visiblePages(alarms, everything).map((p) => p.to)).toEqual([
      '/alerts',
      '/watchlist',
      '/persons',
    ])
  })

  it('shows the persons watchlist only to a role that may see faces', () => {
    const alarms = WORKSPACES.find((w) => w.key === 'alarms')
    if (!alarms) throw new Error('no alarms workspace')
    const plateOnly = only(PERMISSIONS.alertRead, PERMISSIONS.watchlistRead)
    expect(visiblePages(alarms, plateOnly).map((p) => p.to)).not.toContain('/persons')
    expect(
      visiblePages(alarms, only(PERMISSIONS.alertRead, PERMISSIONS.personRead)).map((p) => p.to),
    ).toContain('/persons')
  })
})

describe('locate', () => {
  it('finds the workspace a screen belongs to', () => {
    expect(locate('/watchlist')?.workspace.key).toBe('alarms')
    expect(locate('/persons')?.workspace.key).toBe('alarms')
    expect(locate('/health')?.workspace.key).toBe('network')
    expect(locate('/dashboard')?.page.to).toBe('/dashboard')
  })

  it('keeps a report inside the workspace it was opened from', () => {
    const here = locate('/reports/vehicle/GJ03AB1234')
    expect(here?.workspace.key).toBe('investigate')
    expect(here?.page.to).toBe('/vehicles')
  })

  it('does not match a path that merely starts with the same letters', () => {
    expect(locate('/alertsarchive')).toBeNull()
    expect(locate('/password')).toBeNull()
  })
})
