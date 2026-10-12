/**
 * The permission strings, mirroring `app/core/rbac.py`.
 *
 * ## What this is and is not
 *
 * This is **not** where access is decided. Every one of these is enforced by
 * the API on every request, and that enforcement is the security boundary —
 * anything here is trivially bypassed by anyone willing to open a console.
 *
 * What it buys is an interface that tells the truth. Showing an auditor a
 * "Vehicle Search" tab that answers 403, or an analyst an "Add to watchlist"
 * form that refuses on submit, teaches operators that the system is broken and
 * that error messages are noise. Hiding what a role cannot use is a usability
 * decision that happens to align with the security model, and it is stated
 * that way round deliberately.
 *
 * Names are duplicated from the backend rather than generated because there
 * are about two dozen of them and they change about once a phase; the RBAC test suite
 * asserts the matrix, and `lib/__tests__/nav.test.ts` asserts every screen's
 * permission is one of these strings.
 */

export const PERMISSIONS = {
  cameraCreate: 'camera.create',
  cameraRead: 'camera.read',
  cameraUpdate: 'camera.update',
  cameraDelete: 'camera.delete',

  streamView: 'stream.view',

  watchlistCreate: 'watchlist.create',
  watchlistRead: 'watchlist.read',
  watchlistUpdate: 'watchlist.update',
  watchlistDelete: 'watchlist.delete',

  // The persons watchlist. Reading shows photographs of people, so it is its
  // own grant; enrolling, approving and retiring are separate again, and the
  // API refuses an approval by the account that enrolled the entry.
  personRead: 'person.read',
  personEnrol: 'person.enrol',
  personApprove: 'person.approve',
  personRetire: 'person.retire',

  alertRead: 'alert.read',
  alertAcknowledge: 'alert.acknowledge',
  alertDispatch: 'alert.dispatch',
  alertClose: 'alert.close',

  searchExecute: 'search.execute',

  analyticsRead: 'analytics.read',

  userCreate: 'user.create',
  userRead: 'user.read',
  userUpdate: 'user.update',
  userDelete: 'user.delete',

  auditRead: 'audit.read',
} as const

export type Permission = (typeof PERMISSIONS)[keyof typeof PERMISSIONS]

/**
 * Human wording for a role, for the "signed in as" chip.
 *
 * An operator should be able to see at a glance what they are allowed to do,
 * because "why can't I see the watchlist?" is otherwise a support call.
 */
export const ROLE_SUMMARY: Record<string, string> = {
  admin: 'Full access, including users and audit',
  supervisor: 'Manage cameras, both watchlists and the full alert lifecycle',
  operator: 'Watch cameras, acknowledge alerts, search vehicles',
  analyst: 'Read cameras, watchlists and alerts; search vehicles',
  auditor: 'Read-only, plus the audit trail',
  api_client: 'Machine identity — camera onboarding only',
}
