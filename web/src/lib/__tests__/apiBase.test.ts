import { describe, expect, it } from 'vitest'

import { resolveApiBase } from '@/lib/apiBase'

describe('resolveApiBase', () => {
  it('keeps the configured API on a plain-HTTP page (the :8080 demo)', () => {
    expect(resolveApiBase('http://localhost:8000', 'http:')).toBe('http://localhost:8000')
  })

  it('uses its own origin on an HTTPS page rather than an http:// API', () => {
    expect(resolveApiBase('http://localhost:8000', 'https:')).toBe('')
  })

  it('keeps an https:// API on an HTTPS page', () => {
    expect(resolveApiBase('https://api.example', 'https:')).toBe('https://api.example')
  })

  it('leaves a same-origin build alone', () => {
    expect(resolveApiBase('', 'https:')).toBe('')
    expect(resolveApiBase('', 'http:')).toBe('')
  })
})
