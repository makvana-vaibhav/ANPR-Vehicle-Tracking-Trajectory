/**
 * What each alarm is called, and which kind it counts as — one vocabulary for
 * every screen that lists alarms. Command's dock and the Alarms queue used to
 * name the same alarm two ways.
 */

import type { Alert } from '@/lib/types'

function capitalise(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1)
}

export type AlarmKind = 'watchlist' | 'journey' | 'camera' | 'person' | 'other'

/**
 * A persons-watchlist (face) match. Kept in its own lane: the default alarm
 * queue, the Overview and the tab badge are about vehicles and cameras, and a
 * face match is reached through Alarms → Persons. Nothing about the match or
 * its safeguards changes — only where it is listed.
 */
export function isPersonAlarm(alertType: string): boolean {
  return alertType === 'person_match'
}

/** The filter chip an alarm type counts under. */
export function alarmKind(alertType: string): AlarmKind {
  switch (alertType) {
    case 'watchlist_hit':
    case 'possible_match':
      return 'watchlist'
    case 'person_match':
      return 'person'
    case 'anomaly':
    case 'speed':
    case 'convoy':
      return 'journey'
    case 'camera_down':
      return 'camera'
    default:
      return 'other'
  }
}

/**
 * What an operator calls each alarm. Plain words, and never a verdict about a
 * person: a route that differs from the usual is a journey to explain, not a
 * suspect (CLAUDE.md §1, language discipline).
 */
export function alarmTitle(alert: Pick<Alert, 'alert_type' | 'camera_id'>): string {
  switch (alert.alert_type) {
    case 'watchlist_hit':
      return 'Watched vehicle read'
    case 'possible_match':
      return 'Possible watchlist match'
    case 'person_match':
      // Always "possible": a face that resembles an enrolled reference is a
      // lead for a person to check, never an identification.
      return 'Possible person match'
    case 'anomaly':
      return 'Journey to explain'
    case 'camera_down':
      // The health monitor raises one alarm for a whole integration that
      // stops answering — a recorder or a vendor's grid — and gives it no
      // camera, because it is one fault with one fix, not hundreds.
      return alert.camera_id ? 'Camera stopped sending video' : 'Integration stopped answering'
    case 'speed':
      return 'Speed to check'
    case 'convoy':
      return 'Vehicles travelling together'
    default:
      return capitalise(alert.alert_type.replace(/_/g, ' '))
  }
}
