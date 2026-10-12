/**
 * What the registries say about a plate — VAHAN for the registration,
 * eGujCop/CCTNS for any FIR that names it — beside what a camera saw.
 *
 * Three things an officer needs from it, in the order they need them:
 *
 *   1. **Anything that needs a person**, first and in the severity language:
 *      a blacklist or an open FIR in red with the triangle, an expired
 *      document or a disagreement with the camera in amber with the diamond,
 *      a document about to lapse as the quiet ring. Always a glyph and a
 *      word, never colour alone, and always the reason.
 *   2. **Whether this is the vehicle the plate belongs to.** The registration
 *      is compared with the sighting (its class) and with anything the
 *      officer read off the crop (colour, make). A scooter's plate on a car
 *      is the classic cloned plate; the card says so and says why — as a
 *      disagreement between two records, never as a verdict on the vehicle.
 *   3. **Where the answer came from.** Every answer today is reference data,
 *      not a live VAHAN query, and the label saying so is on the card itself,
 *      built from the response's own `source` — not a footnote somewhere else.
 *
 * Self-contained: give it a plate (and, if you hold one, the sighting's
 * detection id or what was seen) and it fetches, audits and draws. Every
 * fetch writes an audit row, so it fetches once per distinct input.
 */

import { useEffect, useState, type ReactNode } from 'react'

import { SkeletonRows } from '@/components/Skeleton'
import { ErrorBanner, InfoHint, PlateChip, SeverityGlyph } from '@/components/ui'
import * as api from '@/lib/api'
import {
  DOCUMENT_STATE_WORDS,
  SEVERITY_TEXT,
  documentSeverity,
  formatDay,
  provenanceLabel,
  relativeDays,
  type FirRecord,
  type Observed,
  type RegistryCheck,
  type RegistryDocument,
  type RegistryFlag,
  type RegistrySource,
  type SourceLabel,
  type VehicleLookup,
} from '@/lib/registries'

export interface RegistryCardProps {
  plate: string
  /** The sighting to compare against — an alarm's or a search hit's detection.
   *  Without it, the API compares with the plate's latest sighting. */
  detectionId?: string
  /** What an officer saw in the evidence; wins over the sighting, field by field. */
  observed?: Observed
  /** Recorded in the audit trail with the lookup. */
  caseRef?: string
  className?: string
}

type Load =
  | { status: 'loading' }
  | { status: 'ready'; lookup: VehicleLookup }
  | { status: 'failed'; message: string }

export default function RegistryCard({
  plate,
  detectionId,
  observed,
  caseRef,
  className = '',
}: RegistryCardProps) {
  const [load, setLoad] = useState<Load>({ status: 'loading' })
  // Primitives, so a caller passing a fresh `observed` object each render
  // does not refetch — and write another audit row — every time.
  const seenType = observed?.vehicle_type || undefined
  const seenColour = observed?.colour || undefined
  const seenMake = observed?.make || undefined

  useEffect(() => {
    let cancelled = false
    setLoad({ status: 'loading' })
    api
      .getVehicleRegistry(plate, {
        detection_id: detectionId,
        vehicle_type: seenType,
        colour: seenColour,
        make: seenMake,
        case_ref: caseRef,
      })
      .then((lookup) => {
        if (!cancelled) setLoad({ status: 'ready', lookup })
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setLoad({ status: 'failed', message: err instanceof Error ? err.message : String(err) })
        }
      })
    return () => {
      cancelled = true
    }
  }, [plate, detectionId, seenType, seenColour, seenMake, caseRef])

  if (load.status === 'loading') {
    return (
      <section className={`rounded-lg border border-border bg-card p-4 ${className}`}>
        <SkeletonRows rows={3} height="h-10" />
      </section>
    )
  }
  if (load.status === 'failed') {
    return (
      <section className={className}>
        <ErrorBanner>Registry lookup failed: {load.message}</ErrorBanner>
      </section>
    )
  }
  return <RegistryCardView lookup={load.lookup} className={className} />
}

// ── The card, from a lookup ─────────────────────────────────────────────

export function RegistryCardView({
  lookup,
  className = '',
}: {
  lookup: VehicleLookup
  className?: string
}) {
  const reg = lookup.registration
  return (
    <section
      aria-label={`Registry record for ${lookup.plate}`}
      className={`overflow-hidden rounded-lg border border-border bg-card ${className}`}
    >
      <header className="flex flex-wrap items-start justify-between gap-3 border-b border-border px-4 py-3">
        <div className="flex min-w-0 items-center gap-3">
          <PlateChip plate={lookup.plate} size="md" />
          <div className="min-w-0">
            <h2 className="truncate text-[14px] font-semibold">
              {reg ? `${reg.maker} ${reg.model}` : 'No registration on record'}
            </h2>
            <p className="truncate text-xs text-muted-foreground">
              {reg
                ? `${reg.vehicle_class} · ${reg.colour} · ${reg.fuel}`
                : `VAHAN holds no registration for ${lookup.plate}.`}
            </p>
          </div>
        </div>
        <ProvenanceLabel
          source={lookup.source}
          sources={lookup.sources}
          provenance={lookup.provenance}
        />
      </header>

      {lookup.flags.length > 0 && (
        <div className="border-b border-border px-4 py-3">
          <FlagList flags={lookup.flags} />
        </div>
      )}

      {reg && (
        <div className="grid gap-x-6 gap-y-4 px-4 py-3 md:grid-cols-2">
          <div>
            <GroupLabel>Registration · VAHAN</GroupLabel>
            <dl className="mt-2 grid grid-cols-[7.5rem_minmax(0,1fr)] gap-x-3 gap-y-1.5 text-[13px]">
              <Fact term="Owner">
                {reg.owner_name}
                <span className="block text-xs text-faint">
                  {reg.owner_district}, {reg.owner_state} · district only
                </span>
              </Fact>
              <Fact term="Registered">
                {formatDay(reg.registered_on)}
                <span className="block text-xs text-faint">{reg.registering_authority}</span>
              </Fact>
              <Fact term="Status">
                <span className={reg.registration_status === 'ACTIVE' ? '' : 'text-priority-high'}>
                  {reg.registration_status.toLowerCase()}
                </span>
              </Fact>
              {reg.manufacture_year !== null && <Fact term="Made">{reg.manufacture_year}</Fact>}
              <Fact term="Hypothecation">
                {reg.hypothecated ? `Hypothecated to ${reg.financier ?? 'a financier'}` : 'None'}
              </Fact>
              {reg.blacklisted && (
                <Fact term="Blacklist">
                  <span className="text-priority-critical">{reg.blacklist_reason ?? 'Blacklisted'}</span>
                </Fact>
              )}
            </dl>
          </div>
          <div>
            <GroupLabel>Documents</GroupLabel>
            <DocumentList documents={reg.documents} />
          </div>
        </div>
      )}

      {reg && lookup.checks.length > 0 && (
        <div className="border-t border-border px-4 py-3">
          <GroupLabel
            info="The registration compared with what was seen carrying the plate: the sighting's vehicle class, and the colour and make when the pipeline or an officer supplied them. Only differences the detector can really tell — two wheels from four, a bus from a car — count. A mismatch is a disagreement between two records, not a finding about the vehicle: check the crop."
          >
            Against what was seen
          </GroupLabel>
          {lookup.sighting && (
            <p className="mt-1 text-xs text-faint">
              Sighting at {lookup.sighting.camera_code ?? 'an unregistered camera'} ·{' '}
              {api.formatIST(lookup.sighting.seen_at)} IST
            </p>
          )}
          <CheckList checks={lookup.checks} />
        </div>
      )}

      <div className="border-t border-border px-4 py-3">
        <GroupLabel>FIRs naming this vehicle · eGujCop/CCTNS</GroupLabel>
        {lookup.firs.length === 0 ? (
          <p className="mt-2 text-xs text-faint">None in the reference dataset.</p>
        ) : (
          <ul className="mt-2 space-y-2">
            {lookup.firs.map((fir) => (
              <FirRow key={fir.fir_number} fir={fir} />
            ))}
          </ul>
        )}
      </div>

      <footer className="border-t border-border px-4 py-2 text-[11px] text-faint">
        Validity judged on {formatDay(lookup.as_of)} (IST) · looked up{' '}
        {api.formatIST(lookup.queried_at)} IST · audited
      </footer>
    </section>
  )
}

// ── Parts, shared with the registries page ──────────────────────────────

/** The label that sits beside every registry answer. Not optional, not small print. */
export function ProvenanceLabel({
  source,
  sources,
  provenance,
}: {
  source: SourceLabel
  sources: RegistrySource[]
  provenance: string
}) {
  return (
    <p
      data-testid="registry-provenance"
      data-source={source}
      // Neutral on purpose: red, amber and blue are reserved for severity, and
      // where an answer came from is a fact about it, not an alarm. The dashed
      // edge is what sets it apart from the record's own content.
      className="inline-flex max-w-full items-center gap-1.5 rounded border border-dashed border-muted-foreground/50 bg-secondary/40 px-2 py-1 text-[11px] font-medium text-foreground"
    >
      <span>{provenanceLabel(source, sources)}</span>
      <InfoHint label="Where this answer came from" align="right">
        {provenance}
      </InfoHint>
    </p>
  )
}

export function FlagList({ flags }: { flags: RegistryFlag[] }) {
  return (
    <ul className="space-y-2" aria-label="Needs attention">
      {flags.map((flag, i) => (
        <li key={`${flag.code}-${i}`} data-severity={flag.severity} className="flex gap-2.5">
          <span className={`mt-[3px] ${SEVERITY_TEXT[flag.severity]}`}>
            <SeverityGlyph priority={flag.severity} size={10} />
          </span>
          <span className="min-w-0">
            <span className={`text-[13px] font-semibold ${SEVERITY_TEXT[flag.severity]}`}>
              {flag.label}
            </span>
            <span className="block text-xs text-muted-foreground">{flag.detail}</span>
          </span>
        </li>
      ))}
    </ul>
  )
}

export function DocumentList({ documents }: { documents: RegistryDocument[] }) {
  return (
    <ul className="mt-2 space-y-1.5">
      {documents.map((doc) => {
        const severity = documentSeverity(doc.state)
        const quiet = doc.state === 'not_applicable'
        return (
          <li
            key={doc.document}
            data-state={doc.state}
            className="grid grid-cols-[minmax(0,1fr)_auto] items-baseline gap-3 text-[13px]"
          >
            <span className={quiet ? 'text-faint' : ''}>{doc.label}</span>
            <span className="flex items-baseline gap-1.5 text-right">
              {severity && (
                <span className={`self-center ${SEVERITY_TEXT[severity]}`}>
                  <SeverityGlyph priority={severity} />
                </span>
              )}
              <span className={severity ? `font-medium ${SEVERITY_TEXT[severity]}` : 'text-muted-foreground'}>
                {doc.state === 'valid'
                  ? `Valid to ${formatDay(doc.valid_until)}`
                  : doc.state === 'expired'
                    ? `Expired ${formatDay(doc.valid_until)}`
                    : doc.state === 'expiring'
                      ? `Expires ${formatDay(doc.valid_until)}`
                      : DOCUMENT_STATE_WORDS[doc.state]}
              </span>
              {(doc.state === 'expired' || doc.state === 'expiring') && (
                <span className="font-mono text-[11px] text-faint">{relativeDays(doc.days_remaining)}</span>
              )}
            </span>
          </li>
        )
      })}
    </ul>
  )
}

const OUTCOME_WORDS: Record<RegistryCheck['outcome'], string> = {
  match: 'Matches',
  mismatch: 'Mismatch',
  not_compared: 'Not compared',
}

function CheckList({ checks }: { checks: RegistryCheck[] }) {
  return (
    <ul className="mt-2 space-y-2.5">
      {checks.map((check) => (
        <li key={check.field} data-outcome={check.outcome} className="text-[13px]">
          <div className="flex flex-wrap items-baseline justify-between gap-x-3">
            <span>
              {check.label}
              <span className="ml-2 text-xs text-faint">
                registered {check.registered}
                {check.observed && (
                  <>
                    {' '}
                    · seen <span className="text-foreground">{check.observed}</span>
                    {check.observed_source && ` (${check.observed_source})`}
                  </>
                )}
              </span>
            </span>
            <span
              className={`inline-flex items-center gap-1.5 text-xs font-medium ${
                check.outcome === 'mismatch'
                  ? 'text-priority-high'
                  : check.outcome === 'match'
                    ? 'text-muted-foreground'
                    : 'text-faint'
              }`}
            >
              {check.outcome === 'mismatch' && <SeverityGlyph priority="high" />}
              {OUTCOME_WORDS[check.outcome]}
            </span>
          </div>
          {check.outcome !== 'match' && (
            <p className={`mt-0.5 text-xs ${check.outcome === 'mismatch' ? 'text-muted-foreground' : 'text-faint'}`}>
              {check.reason}
            </p>
          )}
        </li>
      ))}
    </ul>
  )
}

function FirRow({ fir }: { fir: FirRecord }) {
  return (
    <li data-open={fir.open} className="flex gap-2.5">
      <span className={`mt-[3px] ${fir.open ? 'text-priority-critical' : 'text-muted-foreground'}`}>
        <SeverityGlyph priority={fir.open ? 'critical' : 'low'} size={10} />
      </span>
      <span className="min-w-0 text-[13px]">
        <span className="font-mono text-xs">{fir.fir_number}</span>
        <span className={`ml-2 text-xs font-medium ${fir.open ? 'text-priority-critical' : 'text-muted-foreground'}`}>
          {fir.open ? 'Open' : 'Closed'} · {fir.status_label}
        </span>
        <span className="block text-xs text-muted-foreground">
          {fir.police_station} · registered {formatDay(fir.registered_on)} · vehicle{' '}
          {fir.vehicle_role_label} · {fir.sections.join(', ')}
        </span>
        <span className="block text-xs text-faint">{fir.summary}</span>
      </span>
    </li>
  )
}

function GroupLabel({ children, info }: { children: ReactNode; info?: ReactNode }) {
  return (
    <h3 className="flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-[0.06em] text-muted-foreground">
      {children}
      {info && <InfoHint>{info}</InfoHint>}
    </h3>
  )
}

function Fact({ term, children }: { term: string; children: ReactNode }) {
  return (
    <>
      <dt className="text-xs text-faint">{term}</dt>
      <dd className="min-w-0">{children}</dd>
    </>
  )
}
