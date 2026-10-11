/**
 * A refused playlist says why.
 *
 * The organisers' grid allows one session per IP, and while another session
 * held our address every grid camera failed with "nothing is publishing this
 * camera" — which sent an operator to look at a working camera.
 */

import { describe, expect, it } from 'vitest'

import { refusalOf } from '@/components/StreamPlayer'

function request(body: string): XMLHttpRequest {
  const xhr = new XMLHttpRequest()
  Object.defineProperty(xhr, 'responseText', { value: body })
  return xhr
}

describe('refusalOf', () => {
  it("reports what the grid said, through the API's detail", () => {
    const xhr = request(
      JSON.stringify({ detail: 'The grid refused this stream (403): one session per IP' }),
    )
    expect(refusalOf(502, xhr)).toBe('The grid refused this stream (403): one session per IP')
  })

  it('says nothing for a path that is simply not published yet', () => {
    expect(refusalOf(404, request(JSON.stringify({ detail: 'Not Found' })))).toBeNull()
  })

  it('says nothing when there is no reason to give', () => {
    expect(refusalOf(502, request('<html>Bad Gateway</html>'))).toBeNull()
    expect(refusalOf(undefined, request('{}'))).toBeNull()
    expect(refusalOf(502, undefined)).toBeNull()
  })
})
