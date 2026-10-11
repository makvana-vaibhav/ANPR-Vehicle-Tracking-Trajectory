/**
 * ⌘K: go anywhere by typing what you know.
 *
 * Three things an operator types into a search box, and this answers all
 * three: a plate ("GJ03AB1234" — open its journey), a camera ("cam10",
 * "Paldi" — open it live), or a screen ("watchlist"). The plate is recognised
 * from its shape, so nobody has to say which kind of thing they typed.
 *
 * It only offers what the role can open. A camera link goes to Live for a
 * role that may watch video, and to the camera registry for one that may not.
 */

import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { useNavigate } from 'react-router-dom'

import { Icon, PlateChip, type IconName } from '@/components/ui'
import { useAuth } from '@/hooks/useAuth'
import * as api from '@/lib/api'
import { visiblePages, WORKSPACES } from '@/lib/nav'
import { PERMISSIONS } from '@/lib/permissions'
import { isIndianPlate, looksLikePlate, normalisePlate } from '@/lib/plates'
import type { Camera } from '@/lib/types'

interface Result {
  key: string
  group: 'Vehicle' | 'Cameras' | 'Screens' | 'Account'
  label: string
  detail?: string
  icon?: IconName
  plate?: string
  run: () => void
}

const MAX_CAMERAS = 6

export default function CommandPalette({
  open,
  onClose,
}: {
  open: boolean
  onClose: () => void
}) {
  const { can, signOut } = useAuth()
  const navigate = useNavigate()
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const [cameras, setCameras] = useState<Camera[] | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)

  // Cameras are fetched the first time the palette opens, not on every page
  // load — most sessions never open it.
  useEffect(() => {
    if (!open || cameras !== null || !can(PERMISSIONS.cameraRead)) return
    let cancelled = false
    api
      .getCameras({ limit: '500' })
      .then((page) => {
        if (!cancelled) setCameras(page.items)
      })
      .catch(() => {
        if (!cancelled) setCameras([])
      })
    return () => {
      cancelled = true
    }
  }, [open, cameras, can])

  useEffect(() => {
    if (!open) return
    setQuery('')
    setActive(0)
    // After the dialog has painted, or the focus lands on nothing.
    const id = window.setTimeout(() => inputRef.current?.focus(), 0)
    return () => window.clearTimeout(id)
  }, [open])

  const results = useMemo<Result[]>(() => {
    const text = query.trim()
    const needle = text.toLowerCase()
    const go = (to: string) => () => {
      onClose()
      navigate(to)
    }
    const out: Result[] = []

    const cameraResults: Result[] = []
    if (needle && cameras) {
      const watch = can(PERMISSIONS.streamView)
      const matches = cameras
        .filter((c) =>
          [c.camera_code, c.name, c.junction, c.city, c.district]
            .filter(Boolean)
            .some((field) => String(field).toLowerCase().includes(needle)),
        )
        .slice(0, MAX_CAMERAS)
      for (const c of matches) {
        cameraResults.push({
          key: `camera:${c.id}`,
          group: 'Cameras',
          label: c.camera_code,
          detail: [c.junction || c.name, c.city ?? 'position not known'].join(' · '),
          icon: 'camera',
          run: go(
            watch
              ? `/anpr?camera=${encodeURIComponent(c.camera_code)}`
              : `/cameras?camera=${encodeURIComponent(c.camera_code)}`,
          ),
        })
      }
    }

    // "cam10" has letters and digits too. A reading with the Indian shape is
    // a plate before anything else; any other plate-like text is offered as
    // a plate only after the cameras it also matches, or alone if it matches
    // none.
    const plate = normalisePlate(text)
    const indian = isIndianPlate(plate)
    const plateResult: Result[] =
      text && looksLikePlate(text) && can(PERMISSIONS.searchExecute) && (indian || cameraResults.length === 0)
        ? [
            {
              key: `plate:${plate}`,
              group: 'Vehicle',
              label: 'Find this vehicle',
              detail: 'Every sighting, and the journey between them',
              plate,
              run: go(`/vehicles?plate=${encodeURIComponent(plate)}`),
            },
          ]
        : []
    out.push(...(indian ? [...plateResult, ...cameraResults] : [...cameraResults, ...plateResult]))

    for (const workspace of WORKSPACES) {
      for (const page of visiblePages(workspace, can)) {
        const label = page.label === workspace.label ? page.label : `${workspace.label} · ${page.label}`
        const haystack = `${label} ${workspace.hint}`.toLowerCase()
        if (needle && !haystack.includes(needle)) continue
        out.push({
          key: `page:${page.to}`,
          group: 'Screens',
          label,
          detail: workspace.hint,
          icon: workspace.icon,
          run: go(page.to),
        })
      }
    }

    const account: Result[] = [
      { key: 'password', group: 'Account', label: 'Change password', icon: 'key', run: go('/password') },
      {
        key: 'signout',
        group: 'Account',
        label: 'Sign out',
        icon: 'logout',
        run: () => {
          onClose()
          void signOut()
        },
      },
    ]
    out.push(...account.filter((r) => !needle || r.label.toLowerCase().includes(needle)))
    return out
  }, [query, cameras, can, navigate, onClose, signOut])

  // Keep the highlighted row inside the list as results change under it.
  useEffect(() => {
    setActive((i) => Math.min(i, Math.max(results.length - 1, 0)))
  }, [results.length])

  useEffect(() => {
    listRef.current
      ?.querySelector<HTMLElement>(`[data-index="${active}"]`)
      ?.scrollIntoView?.({ block: 'nearest' })
  }, [active])

  if (!open) return null

  function onKeyDown(event: KeyboardEvent) {
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      setActive((i) => (results.length ? (i + 1) % results.length : 0))
    } else if (event.key === 'ArrowUp') {
      event.preventDefault()
      setActive((i) => (results.length ? (i - 1 + results.length) % results.length : 0))
    } else if (event.key === 'Enter') {
      event.preventDefault()
      results[active]?.run()
    } else if (event.key === 'Escape') {
      event.preventDefault()
      onClose()
    }
  }

  let lastGroup: string | null = null

  return (
    <div className="fixed inset-0 z-50 flex justify-center px-4 pt-[12vh] print:hidden">
      <button
        type="button"
        aria-label="Close search"
        onClick={onClose}
        className="absolute inset-0 cursor-default bg-background/70 backdrop-blur-[2px]"
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Search"
        onKeyDown={onKeyDown}
        className="relative flex max-h-[70vh] w-[min(640px,100%)] flex-col overflow-hidden rounded-xl border border-input bg-popover shadow-2xl"
      >
        <div className="flex h-12 shrink-0 items-center gap-3 border-b border-border px-4">
          <Icon name="search" size={17} className="text-faint" />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => {
              setQuery(e.target.value)
              setActive(0)
            }}
            placeholder="A plate, a camera, or a screen"
            aria-label="Search"
            aria-controls="palette-results"
            aria-activedescendant={results[active] ? `palette-${active}` : undefined}
            className="min-w-0 flex-1 bg-transparent text-[15px] text-foreground outline-none placeholder:text-faint"
            spellCheck={false}
            autoComplete="off"
          />
          <span className="kbd">esc</span>
        </div>

        <div ref={listRef} id="palette-results" role="listbox" className="min-h-0 flex-1 overflow-y-auto p-2">
          {results.length === 0 ? (
            <p className="px-3 py-6 text-center text-[13px] text-faint">
              Nothing matches “{query}”.
            </p>
          ) : (
            results.map((result, index) => {
              const header = result.group !== lastGroup ? result.group : null
              lastGroup = result.group
              const selected = index === active
              return (
                <div key={result.key}>
                  {header && (
                    <p className="px-3 pb-1 pt-2.5 text-[11px] font-medium uppercase tracking-[0.06em] text-faint">
                      {header}
                    </p>
                  )}
                  <button
                    type="button"
                    id={`palette-${index}`}
                    role="option"
                    aria-selected={selected}
                    data-index={index}
                    onMouseMove={() => setActive(index)}
                    onClick={result.run}
                    className={`flex w-full items-center gap-3 rounded-md px-3 py-2 text-left transition ${
                      selected ? 'bg-secondary' : ''
                    }`}
                  >
                    {result.plate ? (
                      <PlateChip plate={result.plate} size="sm" />
                    ) : (
                      result.icon && (
                        <Icon
                          name={result.icon}
                          size={16}
                          className={selected ? 'text-primary' : 'text-faint'}
                        />
                      )
                    )}
                    <span className="min-w-0 flex-1">
                      <span
                        className={`block truncate text-[13px] ${
                          result.group === 'Cameras' ? 'font-mono' : ''
                        }`}
                      >
                        {result.label}
                      </span>
                      {result.detail && (
                        <span className="block truncate text-xs text-faint">{result.detail}</span>
                      )}
                    </span>
                    {selected && <Icon name="arrowRight" size={14} className="text-faint" />}
                  </button>
                </div>
              )
            })
          )}
        </div>

        <div className="flex shrink-0 items-center gap-4 border-t border-border px-4 py-2 text-[11px] text-faint">
          <span className="flex items-center gap-1.5">
            <span className="kbd">↑</span>
            <span className="kbd">↓</span>
            move
          </span>
          <span className="flex items-center gap-1.5">
            <span className="kbd">↵</span>
            open
          </span>
          <span className="ml-auto">Type a plate to find the vehicle</span>
        </div>
      </div>
    </div>
  )
}
