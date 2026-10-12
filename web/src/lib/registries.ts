/**
 * External registries — VAHAN, SARTHI, eGujCop/CCTNS, AFIS/NAFIS.
 *
 * The response shapes of `/api/v1/registries/*` (services/api/app/schemas/
 * registries.py), and the words and severities the screen draws them with.
 *
 * Every answer today is **reference data**: a fictional local dataset standing
 * in for systems this platform has no access to. The API says so in `source`
 * and `provenance` on every response, and the screen repeats it beside every
 * answer — `provenanceLabel` is the one place that wording is decided.
 */

import type { Priority } from '@/lib/types'

export type RegistrySourceKind = 'reference' | 'live'
export type SourceLabel = RegistrySourceKind | 'mixed'

export interface RegistrySource {
  registry: string
  answers: string
  source: RegistrySourceKind
  provenance: string
}

export type DocumentState = 'valid' | 'expiring' | 'expired' | 'not_on_record' | 'not_applicable'

export interface RegistryDocument {
  document: string
  label: string
  valid_until: string | null
  state: DocumentState
  days_remaining: number | null
}

export interface RegistryFlag {
  severity: Priority
  code: string
  label: string
  detail: string
}

export interface Registration {
  plate: string
  owner_name: string
  owner_district: string
  owner_state: string
  registering_authority: string
  registration_status: string
  vehicle_class: string
  vehicle_category: string
  maker: string
  model: string
  colour: string
  fuel: string
  manufacture_year: number | null
  registered_on: string
  documents: RegistryDocument[]
  hypothecated: boolean
  financier: string | null
  blacklisted: boolean
  blacklist_reason: string | null
}

export interface FirRecord {
  fir_number: string
  police_station: string
  district: string
  state: string
  registered_on: string
  sections: string[]
  status: string
  status_label: string
  open: boolean
  vehicle_role: string
  vehicle_role_label: string
  summary: string
}

export interface RegistrySighting {
  detection_id: string
  seen_at: string
  camera_code: string | null
  camera_name: string | null
  vehicle_type: string | null
  vehicle_colour: string | null
  plate_confidence: number | null
}

export type CheckOutcome = 'match' | 'mismatch' | 'not_compared'

export interface RegistryCheck {
  field: string
  label: string
  registered: string
  observed: string | null
  observed_source: 'sighting' | 'officer' | null
  outcome: CheckOutcome
  reason: string
}

interface LookupBase {
  source: SourceLabel
  provenance: string
  sources: RegistrySource[]
  query: string
  queried_at: string
}

export interface VehicleLookup extends LookupBase {
  plate: string
  as_of: string
  found: boolean
  registration: Registration | null
  firs: FirRecord[]
  sighting: RegistrySighting | null
  checks: RegistryCheck[]
  mismatch: boolean
  flags: RegistryFlag[]
}

export interface Licence {
  licence_number: string
  holder_name: string
  holder_district: string
  holder_state: string
  issuing_authority: string
  issued_on: string
  classes: { code: string; label: string }[]
  status: string
  status_reason: string | null
  documents: RegistryDocument[]
}

export interface LicenceLookup extends LookupBase {
  as_of: string
  found: boolean
  licence: Licence | null
  flags: RegistryFlag[]
}

export interface AfisRecord {
  reference: string
  afis_reference: string
  nafis_reference: string | null
  linked_fir_number: string | null
  district: string
  recorded_on: string
}

export interface AfisLookup extends LookupBase {
  record_exists: boolean
  records: AfisRecord[]
}

/** What an officer saw in the evidence, compared with the registration. */
export interface Observed {
  vehicle_type?: string
  colour?: string
  make?: string
}

/** Detector classes an observation may name — the API refuses anything else. */
export const OBSERVABLE_TYPES = ['car', 'motorcycle', 'truck', 'bus', 'bicycle'] as const

// ── Provenance ─────────────────────────────────────────────────────────

/**
 * The short label that sits beside every answer.
 *
 * "Reference data — not a live VAHAN query" for the dataset that answers
 * today; were a live connector ever wired, the API would say `live` and this
 * would say so instead. Built from the response, never assumed.
 */
export function provenanceLabel(source: SourceLabel, sources: RegistrySource[]): string {
  const names = sources.map((s) => s.registry)
  const joined = names.length > 1 ? `${names.slice(0, -1).join(', ')} or ${names[names.length - 1]}` : names[0] ?? 'registry'
  if (source === 'reference') return `Reference data — not a live ${joined} query`
  if (source === 'live') return `Live ${names.join(' + ')} query`
  return sources
    .map((s) => `${s.registry}: ${s.source === 'reference' ? 'reference data' : 'live'}`)
    .join(' · ')
}

// ── Severity ───────────────────────────────────────────────────────────

/**
 * How a document's state is drawn. Expired and missing are amber with the
 * diamond and a word; expiring soon is the quiet ring; valid and not
 * applicable carry no glyph at all — grey when normal.
 */
export function documentSeverity(state: DocumentState): Priority | null {
  if (state === 'expired' || state === 'not_on_record') return 'high'
  if (state === 'expiring') return 'low'
  return null
}

export const DOCUMENT_STATE_WORDS: Record<DocumentState, string> = {
  valid: 'Valid',
  expiring: 'Expiring',
  expired: 'Expired',
  not_on_record: 'No record',
  not_applicable: 'Not applicable',
}

export const SEVERITY_TEXT: Record<Priority, string> = {
  critical: 'text-priority-critical',
  high: 'text-priority-high',
  medium: 'text-priority-medium',
  low: 'text-muted-foreground',
}

// ── Dates ──────────────────────────────────────────────────────────────

const DAY = new Intl.DateTimeFormat('en-IN', {
  day: 'numeric',
  month: 'short',
  year: 'numeric',
  timeZone: 'UTC',
})

/**
 * A calendar date ("2026-07-01") as "1 Jul 2026". Read and written in UTC
 * on purpose: a date has no time of day, and letting the browser's zone near
 * it moves it a day for anyone west of Greenwich.
 */
export function formatDay(iso: string | null): string {
  if (!iso) return '—'
  const [y, m, d] = iso.split('-').map(Number)
  if (!y || !m || !d) return iso
  return DAY.format(new Date(Date.UTC(y, m - 1, d)))
}

/** "18 days left", "103 days ago", "today". */
export function relativeDays(days: number | null): string {
  if (days === null) return ''
  if (days === 0) return 'ends today'
  const n = Math.abs(days)
  const unit = n === 1 ? 'day' : 'days'
  return days > 0 ? `${n.toLocaleString('en-IN')} ${unit} left` : `${n.toLocaleString('en-IN')} ${unit} ago`
}

/** Path segments for a reference that carries slashes ("DEMO/FIR/2026/…"),
 *  each encoded on its own so the slashes survive every proxy on the way. */
export function referencePath(reference: string): string {
  return reference
    .trim()
    .split('/')
    .filter(Boolean)
    .map(encodeURIComponent)
    .join('/')
}
