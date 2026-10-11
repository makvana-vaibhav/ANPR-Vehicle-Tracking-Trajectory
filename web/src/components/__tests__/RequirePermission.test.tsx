/**
 * The permission gate.
 *
 * A screen a role cannot use must say so legibly — which permission is
 * missing, under which role — rather than render, fire requests and fail. And
 * a role that can use it must get the screen itself, untouched.
 */

import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { describe, expect, it, vi } from 'vitest'

import RequirePermission from '@/components/RequirePermission'
import { PERMISSIONS } from '@/lib/permissions'

const auth = vi.hoisted(() => ({
  granted: [] as string[],
}))

vi.mock('@/hooks/useAuth', () => ({
  useAuth: () => ({
    user: { username: 'analyst', full_name: 'A. Analyst', role: 'analyst', permissions: auth.granted },
    can: (permission: string) => auth.granted.includes(permission),
  }),
}))

function renderGate() {
  return render(
    <MemoryRouter>
      <RequirePermission anyOf={[PERMISSIONS.auditRead]} label="The audit trail">
        <p>the protected screen</p>
      </RequirePermission>
    </MemoryRouter>,
  )
}

describe('RequirePermission', () => {
  it('names the screen, the role and the missing permission instead of rendering it', () => {
    auth.granted = [PERMISSIONS.searchExecute]
    renderGate()

    expect(screen.queryByText('the protected screen')).toBeNull()
    expect(screen.getByRole('heading').textContent).toContain('The audit trail')
    expect(screen.getByText('analyst', { selector: 'dd span' })).toBeTruthy()
    expect(screen.getByText(PERMISSIONS.auditRead)).toBeTruthy()
    expect(screen.getByRole('link').textContent).toContain('Back to what you can see')
  })

  it('renders the screen for a role that holds the permission', () => {
    auth.granted = [PERMISSIONS.auditRead]
    renderGate()
    expect(screen.getByText('the protected screen')).toBeTruthy()
    expect(screen.queryByRole('link')).toBeNull()
  })
})
