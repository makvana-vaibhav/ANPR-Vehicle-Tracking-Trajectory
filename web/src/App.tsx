/** Command centre shell: navigation, session, and routing. */

import { useEffect, useState } from 'react'
import { Navigate, Route, Routes, useLocation } from 'react-router-dom'

import CommandPalette from '@/components/CommandPalette'
import ErrorBoundary from '@/components/ErrorBoundary'
import TopBar from '@/components/TopBar'
import { ToastProvider } from '@/components/Toast'
import { Spinner } from '@/components/ui'
import Alerts from '@/pages/Alerts'
import TrafficIntelligence from '@/pages/TrafficIntelligence'
import AuditLog from '@/pages/AuditLog'
import ChangePassword from '@/pages/ChangePassword'
import Dashboard from '@/pages/Dashboard'
import FleetHealthPage from '@/pages/FleetHealth'
import Cameras from '@/pages/Cameras'
import LiveAnpr from '@/pages/LiveAnpr'
import Login from '@/pages/Login'
import MapView from '@/pages/MapView'
import Users from '@/pages/Users'
import VehicleReport from '@/pages/VehicleReport'
import VehicleSearch from '@/pages/VehicleSearch'
import Watchlist from '@/pages/Watchlist'
import Persons from '@/pages/Persons'
import Registries from '@/pages/Registries'
import RequirePermission from '@/components/RequirePermission'
import { useAuth } from '@/hooks/useAuth'
import { EventStreamProvider } from '@/hooks/useEventStream'
import { landingFor } from '@/lib/nav'
import { PERMISSIONS } from '@/lib/permissions'

export default function App() {
  const { user, loading } = useAuth()

  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background">
        <Spinner />
      </div>
    )
  }

  if (!user) {
    return <Login />
  }

  // The provider sits above the shell because the top bar itself shows the
  // open alarm count and the feed's own connection state. One socket serves
  // every screen inside it.
  return (
    <EventStreamProvider>
      <ToastProvider>
        <Shell />
      </ToastProvider>
    </EventStreamProvider>
  )
}

/** Typing into a field must never be hijacked by a shortcut. */
function isEditable(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  return (
    target.isContentEditable ||
    target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement ||
    target instanceof HTMLSelectElement
  )
}

function Shell() {
  const { can } = useAuth()
  // Where to send someone whose role cannot open the default screen.
  const landing = landingFor(can)
  const [searchOpen, setSearchOpen] = useState(false)
  // Keys the error boundary: moving to another screen clears a failed one.
  const { pathname } = useLocation()

  // ⌘K / Ctrl K from anywhere, and "/" when not typing — the two shortcuts
  // operators bring with them from every other tool.
  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault()
        setSearchOpen((v) => !v)
      } else if (event.key === '/' && !isEditable(event.target)) {
        event.preventDefault()
        setSearchOpen(true)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  return (
    <div className="flex h-screen flex-col overflow-hidden bg-background print:block print:h-auto print:overflow-visible print:bg-white">
      <TopBar onOpenSearch={() => setSearchOpen(true)} />
      <CommandPalette open={searchOpen} onClose={() => setSearchOpen(false)} />

      {/* min-h-0 so a page that scrolls its own panels cannot push the
          window into scrolling — a flex child defaults to min-content. */}
      <main className="flex min-h-0 min-w-0 flex-1 flex-col print:block">
        <ErrorBoundary key={pathname}>
        <Routes>
          <Route path="/" element={<Navigate to={landing} replace />} />
          <Route
            path="/dashboard"
            element={
              <RequirePermission anyOf={[PERMISSIONS.cameraRead]} label="The dashboard">
                <Dashboard />
              </RequirePermission>
            }
          />
          <Route
            path="/map"
            element={
              <RequirePermission anyOf={[PERMISSIONS.cameraRead]} label="The GIS map">
                <MapView />
              </RequirePermission>
            }
          />
          <Route
            path="/traffic"
            element={
              <RequirePermission anyOf={[PERMISSIONS.analyticsRead]} label="Traffic intelligence">
                <TrafficIntelligence />
              </RequirePermission>
            }
          />
          <Route
            path="/anpr"
            element={
              <RequirePermission anyOf={[PERMISSIONS.streamView]} label="Live ANPR">
                <LiveAnpr />
              </RequirePermission>
            }
          />
          <Route
            path="/alerts"
            element={
              <RequirePermission anyOf={[PERMISSIONS.alertRead]} label="Alerts">
                <Alerts />
              </RequirePermission>
            }
          />
          <Route
            path="/vehicles"
            element={
              <RequirePermission
                anyOf={[PERMISSIONS.searchExecute]}
                label="Vehicle search"
              >
                <VehicleSearch />
              </RequirePermission>
            }
          />
          <Route
            path="/reports/vehicle/:plate"
            element={
              <RequirePermission
                anyOf={[PERMISSIONS.searchExecute]}
                label="Vehicle report"
              >
                <VehicleReport />
              </RequirePermission>
            }
          />
          <Route
            path="/watchlist"
            element={
              <RequirePermission
                anyOf={[PERMISSIONS.watchlistRead]}
                label="The watchlist"
              >
                <Watchlist />
              </RequirePermission>
            }
          />
          <Route
            path="/registries"
            element={
              <RequirePermission anyOf={[PERMISSIONS.searchExecute]} label="Registry lookups">
                <Registries />
              </RequirePermission>
            }
          />
          <Route
            path="/persons"
            element={
              <RequirePermission anyOf={[PERMISSIONS.personRead]} label="The persons watchlist">
                <Persons />
              </RequirePermission>
            }
          />
          <Route
            path="/health"
            element={
              <RequirePermission anyOf={[PERMISSIONS.cameraRead]} label="Fleet health">
                <FleetHealthPage />
              </RequirePermission>
            }
          />
          <Route
            path="/cameras"
            element={
              <RequirePermission anyOf={[PERMISSIONS.cameraRead]} label="Cameras">
                <Cameras />
              </RequirePermission>
            }
          />
          {/* The screen was called Integration until it grew the ability to
              actually onboard something. Old links should still land. */}
          <Route path="/integration" element={<Navigate to="/cameras" replace />} />
          {/* Analytics absorbed the traffic feature rather than sitting beside
              it — the two described the same roads. Same reasoning. */}
          <Route path="/analytics" element={<Navigate to="/traffic" replace />} />
          <Route
            path="/users"
            element={
              <RequirePermission anyOf={[PERMISSIONS.userRead]} label="Account administration">
                <Users />
              </RequirePermission>
            }
          />
          <Route
            path="/audit"
            element={
              <RequirePermission anyOf={[PERMISSIONS.auditRead]} label="The audit trail">
                <AuditLog />
              </RequirePermission>
            }
          />
          {/* Every signed-in account can change its own password; there is no
              permission for it because needing one would be circular. */}
          <Route path="/password" element={<ChangePassword />} />
          {/* Where a role that can open no screen at all lands (a machine
              identity signing in by hand). Without its own route, the
              catch-all below sent it back here forever. */}
          <Route
            path="/no-access"
            element={
              <RequirePermission anyOf={[PERMISSIONS.cameraRead]} label="The command centre">
                <Navigate to="/" replace />
              </RequirePermission>
            }
          />
          <Route path="*" element={<Navigate to={landing} replace />} />
        </Routes>
        </ErrorBoundary>
      </main>
    </div>
  )
}
