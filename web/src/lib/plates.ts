/**
 * How a plate is written for people.
 *
 * Stored and transported without spaces (`GJ03AB1234`), because that is the
 * form every comparison needs. Printed the way it is painted on the plate —
 * state, district, series, number — because a run of ten characters is
 * misread far more often than four short groups.
 */

const INDIAN = /^([A-Z]{2})(\d{1,2})([A-Z]{0,3})(\d{1,4})$/

/** `GJ03AB1234` → `GJ 03 AB 1234`. Anything that is not an Indian
 *  registration (a UK demo plate, a partial read) is returned unchanged. */
export function spacedPlate(plate: string): string {
  const match = INDIAN.exec(plate)
  return match ? match.slice(1).filter(Boolean).join(' ') : plate
}

/** Whether a reading has the shape of an Indian registration — state,
 *  district, series, number. The recorded demo clip is a UK road, and its
 *  plates must not be drawn with an IND strip they do not carry. */
export function isIndianPlate(plate: string): boolean {
  return INDIAN.test(plate)
}

/**
 * Whether free text typed into a search box is plausibly a plate rather than
 * a camera or a place. Letters and digits both, four to eleven characters once
 * spaces and dashes are dropped.
 */
export function looksLikePlate(text: string): boolean {
  const compact = normalisePlate(text)
  return /^[A-Z0-9]{4,11}$/.test(compact) && /[A-Z]/.test(compact) && /\d/.test(compact)
}

/** The stored form: upper case, no spaces, dashes or dots. */
export function normalisePlate(text: string): string {
  return text.toUpperCase().replace(/[\s\-.]/g, '')
}
