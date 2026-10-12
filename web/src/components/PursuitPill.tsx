/**
 * "Pursuit: GJ… · 12 min left" in the top bar, on every screen, while one
 * runs — and a link back to its panel.
 *
 * A pursuit keeps cameras open for analysis on the operator's behalf, and on
 * the organisers' grid that spends watch time; something that does that must
 * not be forgettable on another screen. Shown to a role that may run plate
 * searches; the list it reads carries no sightings.
 */

import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'

import { useAuth } from '@/hooks/useAuth'
import { istHM, remaining, useActivePursuits } from '@/lib/pursuit'

export default function PursuitPill() {
  const { can } = useAuth()
  const pursuits = useActivePursuits(can('search.execute'))
  // The time left moves between polls — and is measured from now whenever
  // the list changes, not from when the bar first mounted.
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    setNow(Date.now())
    if (pursuits.length === 0) return
    const timer = window.setInterval(() => setNow(Date.now()), 15_000)
    return () => window.clearInterval(timer)
  }, [pursuits])

  const live = pursuits.filter((p) => new Date(p.expires_at).getTime() > now)
  const first = live[0]
  if (!first) return null
  const others = live.length - 1

  return (
    <Link
      to={`/vehicles?plate=${encodeURIComponent(first.plate)}&pursuit=1`}
      title={`Pursuing ${first.plate} — started by ${first.started_by}, ends ${istHM(first.expires_at)} IST unless renewed${
        first.pins.length ? `; pinned ${first.pins.join(', ')}` : '; nothing pinned'
      }`}
      className="inline-flex h-7 max-w-[19rem] items-center gap-2 rounded-full border border-primary/50 bg-primary/10 px-2.5 text-xs text-primary transition hover:bg-primary/15"
    >
      <span className="h-[7px] w-[7px] shrink-0 animate-pulse-alert rounded-full bg-primary" />
      <span className="truncate">
        <span className="hidden sm:inline">Pursuit: </span>
        <span className="font-mono font-medium">{first.plate}</span>
        <span className="text-primary/80"> · {remaining(first.expires_at, now)}</span>
        {others > 0 && <span className="text-primary/80"> · +{others}</span>}
      </span>
    </Link>
  )
}
