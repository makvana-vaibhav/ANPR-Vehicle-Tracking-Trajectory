/**
 * API client behaviour.
 *
 * The token handling matters: an operator must not be signed out mid-incident
 * because an access token expired, and credentials must not outlive the
 * browser session on a shared control-room workstation.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { ApiError, getAccessToken, isAuthenticated, logout, setTokens } from '@/lib/api'

describe('token storage', () => {
  beforeEach(() => setTokens(null, null))
  afterEach(() => setTokens(null, null))

  it('reports unauthenticated with no token', () => {
    expect(isAuthenticated()).toBe(false)
    expect(getAccessToken()).toBeNull()
  })

  it('holds tokens once set', () => {
    setTokens('access-abc', 'refresh-xyz')
    expect(isAuthenticated()).toBe(true)
    expect(getAccessToken()).toBe('access-abc')
  })

  it('clears tokens on sign out', () => {
    setTokens('access-abc', 'refresh-xyz')
    setTokens(null, null)
    expect(isAuthenticated()).toBe(false)
  })

  it('uses sessionStorage, not localStorage', () => {
    // Credentials must not survive the browser session on a shared
    // control-room machine.
    setTokens('access-abc', 'refresh-xyz')

    expect(window.sessionStorage.getItem('contrail.access_token')).toBe('access-abc')
    // jsdom does not always expose localStorage; when it does, it must be
    // empty — optional chaining keeps the assertion meaningful either way.
    expect(window.localStorage?.getItem('contrail.access_token') ?? null).toBeNull()
  })

  it('survives storage being unavailable', () => {
    // Private-browsing mode throws on access; tokens then live in memory only.
    const spy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('storage disabled')
    })
    expect(() => setTokens('a', 'b')).not.toThrow()
    expect(getAccessToken()).toBe('a')
    spy.mockRestore()
  })
})

describe('ApiError', () => {
  it('carries the HTTP status for callers to branch on', () => {
    const error = new ApiError('Forbidden', 403, { detail: 'nope' })
    expect(error.status).toBe(403)
    expect(error.name).toBe('ApiError')
    expect(error).toBeInstanceOf(Error)
  })
})

describe('logout', () => {
  afterEach(() => {
    setTokens(null, null)
    vi.unstubAllGlobals()
  })

  it('revokes the refresh token while still signed in, then forgets both', async () => {
    setTokens('access-abc', 'refresh-xyz')
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ detail: 'Signed out' }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)

    await logout()

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toContain('/api/v1/auth/logout')
    expect(new Headers(init.headers).get('Authorization')).toBe('Bearer access-abc')
    expect(JSON.parse(String(init.body))).toEqual({ refresh_token: 'refresh-xyz' })
    expect(isAuthenticated()).toBe(false)
  })

  it('still signs out locally when the server cannot be reached', async () => {
    setTokens('access-abc', 'refresh-xyz')
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new TypeError('network down')
    }))
    await logout()
    expect(isAuthenticated()).toBe(false)
  })
})
