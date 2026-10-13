/**
 * How many alarms are open, and how many of them are critical.
 *
 * The count on the Alarms tab used to be the number of alerts this browser had
 * seen arrive on the socket since the page loaded — labelled "unacknowledged"
 * and neither: it never went down when one was handled, and it was zero for an
 * operator who signed in after the alarm fired. This asks the API for the open
 * ones, refreshes on a slow timer, and refreshes immediately when an alert
 * arrives live, which is the moment an operator is looking.
 */

import { useCallback, useEffect, useState } from 'react'

import { useAuth } from '@/hooks/useAuth'
import { useEventStream } from '@/hooks/useEventStream'
import { isPersonAlarm } from '@/lib/alarms'
import * as api from '@/lib/api'
import { PERMISSIONS } from '@/lib/permissions'

const REFRESH_MS = 30_000

export interface OpenAlarms {
  /** Null until the first answer, and for a role that cannot read alerts. */
  open: number | null
  critical: number
}

export function useOpenAlarms(): OpenAlarms {
  const { can } = useAuth()
  const { alerts } = useEventStream()
  const allowed = can(PERMISSIONS.alertRead)
  const [state, setState] = useState<OpenAlarms>({ open: null, critical: 0 })

  const load = useCallback(async () => {
    if (!allowed) return
    try {
      // Sorted most severe first, so every critical alarm is on the first
      // page unless more than 200 are open at once — at which point the
      // badge would not change what anyone does.
      //
      // Persons-watchlist matches are left out: they have their own lane on
      // the Alarms screen (Persons), and the badge counts what the default
      // queue shows — vehicles and cameras.
      const page = await api.getAlerts({ open_only: true, sort: 'priority', limit: 200 })
      const persons = page.items.filter((a) => isPersonAlarm(a.alert_type)).length
      setState({
        open: Math.max(0, page.total - persons),
        critical: page.items.filter((a) => a.priority === 'critical' && !isPersonAlarm(a.alert_type))
          .length,
      })
    } catch {
      // The badge is a convenience; the Alarms screen reports its own errors.
    }
  }, [allowed])

  useEffect(() => {
    void load()
    const timer = window.setInterval(() => void load(), REFRESH_MS)
    return () => window.clearInterval(timer)
  }, [load])

  useEffect(() => {
    if (alerts.length > 0) void load()
  }, [alerts, load])

  return state
}
