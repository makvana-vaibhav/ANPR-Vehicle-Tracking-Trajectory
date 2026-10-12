/**
 * Pursuit's words for the screen: every time in IST, and a countdown that
 * never claims time a pursuit does not have.
 */

import { describe, expect, it } from 'vitest'

import { ago, etaText, istHM, remaining } from '@/lib/pursuit'

const NOW = Date.parse('2026-10-12T02:00:00Z') // 07:30 IST

describe('pursuit times', () => {
  it('renders in IST on a 24-hour clock, midnight as 00', () => {
    expect(istHM('2026-10-12T02:00:00Z')).toBe('07:30')
    expect(istHM('2026-10-11T18:30:00Z')).toBe('00:00')
  })

  it('gives an arrival window, or says why there is none', () => {
    expect(etaText('2026-10-12T02:05:00Z', '2026-10-12T02:20:00Z')).toBe('07:35–07:50 IST')
    expect(etaText(null, null)).toBe('no arrival time: distance unknown')
  })

  it('counts down, and says when it has ended', () => {
    expect(remaining('2026-10-12T02:12:00Z', NOW)).toBe('12 min left')
    expect(remaining('2026-10-12T02:00:40Z', NOW)).toBe('40 s left')
    expect(remaining('2026-10-12T01:59:00Z', NOW)).toBe('ended')
  })

  it('says how long ago', () => {
    expect(ago('2026-10-12T01:57:00Z', NOW)).toBe('3 min ago')
    expect(ago('2026-10-12T01:59:30Z', NOW)).toBe('30 s ago')
  })
})
