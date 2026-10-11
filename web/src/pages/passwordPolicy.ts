/**
 * The password policy, as the change-password screen shows it to the person
 * typing. Kept beside the screen rather than in it so it can be tested on its
 * own, and so the screen module exports only its component.
 */

export const MIN_LENGTH = 12
export const MAX_LENGTH = 256
const MIN_DISTINCT = 6

/**
 * The patterns `app/core/password_policy.py` refuses regardless of length.
 * Mirrored, not imported — the API is the authority on all of this, and this
 * list exists so the rules are known before the form is submitted, not after.
 * If the two ever disagree, the server's refusal is the one that counts.
 */
const WEAK_PATTERNS = [
  /^(.)\1+$/,
  /\b(qwerty|asdfgh|zxcvbn)/i,
  /(012345|123456|234567|345678|456789|987654|876543)/,
]

export interface PasswordCheck {
  id: 'length' | 'username' | 'pattern' | 'distinct' | 'differs' | 'match'
  label: string
  ok: boolean
}

/**
 * The password policy as a checklist, evaluated as the person types.
 *
 * A courtesy and never the check — the policy module says the same from the
 * other side. Every rule here is one the server enforces, written to agree
 * with it exactly (the username rule compares against letters only, as the
 * server does). The one server rule not mirrored is "not a credential
 * published in this repository": that list belongs to the server, and a copy
 * here would drift from it.
 */
export function passwordChecks(
  next: string,
  confirm: string,
  current: string,
  username: string,
): PasswordCheck[] {
  const typed = next.length > 0
  const letters = next.toLowerCase().replace(/[^a-z]/g, '')
  const name = username.toLowerCase()
  return [
    {
      id: 'length',
      label: `At least ${MIN_LENGTH} characters`,
      ok: next.length >= MIN_LENGTH && next.length <= MAX_LENGTH,
    },
    {
      id: 'username',
      label: 'Does not contain your username',
      ok: typed && !(name.length >= 3 && letters.includes(name)),
    },
    {
      id: 'pattern',
      label: 'No repeated character, keyboard run or digit run',
      ok: typed && !WEAK_PATTERNS.some((pattern) => pattern.test(next)),
    },
    {
      id: 'distinct',
      label: `At least ${MIN_DISTINCT} different characters`,
      ok: new Set(next).size >= MIN_DISTINCT,
    },
    {
      id: 'differs',
      label: 'Different from your current password',
      ok: typed && next !== current,
    },
    {
      id: 'match',
      label: 'Both new entries match',
      ok: typed && next === confirm,
    },
  ]
}
