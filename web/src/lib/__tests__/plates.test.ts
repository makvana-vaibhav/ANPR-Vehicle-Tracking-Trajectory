/**
 * Telling a plate from anything else an operator types, and writing one the
 * way it is painted.
 */

import { describe, expect, it } from 'vitest'

import { isIndianPlate, looksLikePlate, normalisePlate, spacedPlate } from '@/lib/plates'

describe('normalisePlate', () => {
  it('produces the stored form from however it was typed', () => {
    expect(normalisePlate('gj-03 ab.1234')).toBe('GJ03AB1234')
  })
})

describe('looksLikePlate', () => {
  it('accepts a plate typed with or without spaces', () => {
    expect(looksLikePlate('GJ03AB1234')).toBe(true)
    expect(looksLikePlate('gj 03 ab 1234')).toBe(true)
    expect(looksLikePlate('FJ14ZHY')).toBe(true)
  })

  it('refuses a place name, a bare number and anything too short', () => {
    expect(looksLikePlate('Paldi')).toBe(false)
    expect(looksLikePlate('1234')).toBe(false)
    expect(looksLikePlate('A1')).toBe(false)
  })
})

describe('isIndianPlate', () => {
  it('knows the Indian shape from a foreign one', () => {
    expect(isIndianPlate('GJ03AB1234')).toBe(true)
    expect(isIndianPlate('GJ1A1234')).toBe(true)
    expect(isIndianPlate('FJ14ZHY')).toBe(false)
  })
})

describe('spacedPlate', () => {
  it('groups an Indian plate as it is painted, and leaves others as read', () => {
    expect(spacedPlate('GJ03AB1234')).toBe('GJ 03 AB 1234')
    expect(spacedPlate('FJ14ZHY')).toBe('FJ14ZHY')
  })
})
