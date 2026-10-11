/**
 * Downloading an export.
 *
 * A link cannot carry the Authorization header, so exports are fetched and
 * saved from a blob — which is three places for a refusal to vanish into
 * silence. The server's reason must reach the operator.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { ApiError, downloadExport, setTokens } from '@/lib/api'

describe('downloadExport', () => {
  const clicked: string[] = []

  beforeEach(() => {
    setTokens('access-token', null)
    clicked.length = 0
    // jsdom has no object URLs and does not navigate on click.
    Object.assign(URL, {
      createObjectURL: vi.fn(() => 'blob:report'),
      revokeObjectURL: vi.fn(),
    })
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
      this: HTMLAnchorElement,
    ) {
      clicked.push(this.download)
    })
  })

  afterEach(() => {
    vi.restoreAllMocks()
    setTokens(null, null)
  })

  it('saves the file under the name the server gave it, sending the token', async () => {
    const fetchMock = vi.fn(async () =>
      new Response('plate,visit\n', {
        status: 200,
        headers: {
          'content-type': 'text/csv',
          'content-disposition': 'attachment; filename="route-GJ03AB1234-20261011.csv"',
        },
      }),
    )
    vi.stubGlobal('fetch', fetchMock)

    const name = await downloadExport('/api/v1/reports/vehicle/GJ03AB1234.csv', {
      since: '2026-10-11T00:00:00Z',
      until: undefined,
    })

    expect(name).toBe('route-GJ03AB1234-20261011.csv')
    expect(clicked).toEqual(['route-GJ03AB1234-20261011.csv'])
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toContain('since=2026-10-11T00%3A00%3A00Z')
    expect(url).not.toContain('until')
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer access-token')
  })

  it("passes the server's reason on rather than a bare status", async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(JSON.stringify({ detail: '61,240 plate reads in this window' }), {
          status: 422,
          headers: { 'content-type': 'application/json' },
        }),
      ),
    )

    await expect(downloadExport('/api/v1/reports/plates.csv')).rejects.toThrow(
      new ApiError('61,240 plate reads in this window', 422),
    )
    expect(clicked).toEqual([])
  })
})
