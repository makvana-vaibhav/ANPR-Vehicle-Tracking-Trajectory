/**
 * The password checklist on the change-password screen.
 *
 * It mirrors `app/core/password_policy.py` as a courtesy to the person
 * typing. These pin that it agrees with the server: a rule shown as met that
 * the server then refuses teaches people the checklist lies, and a rule shown
 * as unmet that the server would accept teaches them to ignore it.
 */

import { describe, expect, it } from 'vitest'

import { passwordChecks, type PasswordCheck } from '@/pages/passwordPolicy'

function state(checks: PasswordCheck[]): Record<PasswordCheck['id'], boolean> {
  return Object.fromEntries(checks.map((c) => [c.id, c.ok])) as Record<PasswordCheck['id'], boolean>
}

describe('passwordChecks', () => {
  it('shows nothing as met before anything is typed', () => {
    const checks = state(passwordChecks('', '', '', 'admin'))
    expect(Object.values(checks).some(Boolean)).toBe(false)
  })

  it('meets every rule for a good password typed twice', () => {
    const checks = state(passwordChecks('Tr4ffic-lights!x', 'Tr4ffic-lights!x', 'old one', 'admin'))
    expect(checks).toEqual({
      length: true,
      username: true,
      pattern: true,
      distinct: true,
      differs: true,
      match: true,
    })
  })

  it('refuses a password built on the username, as the server does', () => {
    expect(state(passwordChecks('Admin@2026-xyz', '', '', 'admin')).username).toBe(false)
    // The server compares letters only, so digits and symbols around the
    // name do not hide it.
    expect(state(passwordChecks('9a-d-m-i-n!Q7zz', '', '', 'admin')).username).toBe(false)
  })

  it('compares the username as the server does, letters only', () => {
    // `insp.desai` keeps its dot, so it can never appear in a letters-only
    // string — the server lets this through, and so must the checklist.
    expect(state(passwordChecks('InspDesai-2026!', '', '', 'insp.desai')).username).toBe(true)
  })

  it('catches the runs the server refuses', () => {
    expect(state(passwordChecks('aaaaaaaaaaaaaa', '', '', 'x')).pattern).toBe(false)
    expect(state(passwordChecks('Gate-Qwerty-77!', '', '', 'x')).pattern).toBe(false)
    expect(state(passwordChecks('Gate-123456-xy', '', '', 'x')).pattern).toBe(false)
    expect(state(passwordChecks('Gate-135792-xy', '', '', 'x')).pattern).toBe(true)
  })

  it('needs twelve characters and six different ones', () => {
    const short = state(passwordChecks('Ab1!Ab1!', '', '', 'x'))
    expect(short.length).toBe(false)
    const padded = state(passwordChecks('abababababab', '', '', 'x'))
    expect(padded.length).toBe(true)
    expect(padded.distinct).toBe(false)
  })

  it('requires the new password to differ from the current one and to be typed the same twice', () => {
    const same = state(passwordChecks('Tr4ffic-lights!x', 'Tr4ffic-lights!x', 'Tr4ffic-lights!x', 'x'))
    expect(same.differs).toBe(false)
    const mismatch = state(passwordChecks('Tr4ffic-lights!x', 'Tr4ffic-lights!y', '', 'x'))
    expect(mismatch.match).toBe(false)
  })
})
