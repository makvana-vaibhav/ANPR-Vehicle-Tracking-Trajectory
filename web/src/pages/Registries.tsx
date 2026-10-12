/**
 * Investigate · Registries — a plate in VAHAN and eGujCop/CCTNS, a licence in
 * SARTHI, a case or person reference in AFIS/NAFIS.
 *
 * Every answer on this screen is **reference data**: a fictional local
 * dataset standing in for systems this platform has no access to. The screen
 * says so above the forms, and every answer says so again beside itself,
 * from the response's own `source` — so a screenshot of any one answer still
 * carries the label.
 *
 * Every lookup is audited, with the case reference when one is given. The
 * query lives in the URL (`?plate=`, `?tab=licence&licence=`,
 * `?tab=afis&ref=`), so a lookup can be linked to from a sighting or an alarm
 * and opens already answered.
 */

import { useEffect, useState, type FormEvent, type ReactNode } from 'react'
import { useSearchParams } from 'react-router-dom'

import RegistryCard, { DocumentList, FlagList, ProvenanceLabel } from '@/components/RegistryCard'
import { SkeletonRows } from '@/components/Skeleton'
import {
  Button,
  EmptyState,
  ErrorBanner,
  Field,
  Input,
  PageHeader,
  Panel,
  Select,
  Tabs,
} from '@/components/ui'
import * as api from '@/lib/api'
import {
  OBSERVABLE_TYPES,
  formatDay,
  type AfisLookup,
  type LicenceLookup,
} from '@/lib/registries'

type Tab = 'vehicle' | 'licence' | 'afis'

const TYPE_WORDS: Record<(typeof OBSERVABLE_TYPES)[number], string> = {
  car: 'Car',
  motorcycle: 'Two-wheeler',
  truck: 'Truck / large SUV',
  bus: 'Bus',
  bicycle: 'Bicycle',
}

/** Keys from the committed reference dataset worth showing, one per state. */
const EXAMPLES: Record<Tab, { key: string; note: string }[]> = {
  vehicle: [
    { key: 'GJ03AB1234', note: 'watchlisted, open FIR' },
    { key: 'GJ06KM2219', note: 'blacklisted' },
    { key: 'GJ05NR3318', note: "a scooter's plate" },
    { key: 'GJ01XY7788', note: 'permit lapsed' },
  ],
  licence: [
    { key: 'GJ0520120018830', note: 'suspended' },
    { key: 'GJ1820060007712', note: 'lapsed' },
    { key: 'GJ0620160021904', note: 'transport lapsed' },
  ],
  afis: [
    { key: 'DEMO/FIR/2026/GNR/1187', note: 'records exist' },
    { key: 'DEMO/FIR/2026/AHM/0957', note: 'no record' },
  ],
}

function tabOf(params: URLSearchParams): Tab {
  const named = params.get('tab')
  if (named === 'vehicle' || named === 'licence' || named === 'afis') return named
  if (params.get('licence')) return 'licence'
  if (params.get('ref')) return 'afis'
  return 'vehicle'
}

export default function Registries() {
  const [params, setParams] = useSearchParams()
  const tab = tabOf(params)

  const plate = params.get('plate') ?? ''
  const licence = params.get('licence') ?? ''
  const reference = params.get('ref') ?? ''
  const caseRef = params.get('case') ?? ''
  const observed = {
    vehicle_type: params.get('type') ?? undefined,
    colour: params.get('colour') ?? undefined,
    make: params.get('make') ?? undefined,
  }

  const go = (next: Record<string, string>) => {
    const clean = Object.fromEntries(Object.entries(next).filter(([, v]) => v.trim() !== ''))
    setParams(clean)
  }

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="space-y-5 px-6 pb-8 pt-5">
        <PageHeader
          title="Registries"
          subtitle={
            <>
              <span>VAHAN · SARTHI · eGujCop/CCTNS · AFIS/NAFIS</span>
              <span className="text-faint">·</span>
              <span>reference data, every lookup audited</span>
            </>
          }
        />

        <p
          role="note"
          className="rounded-md border border-dashed border-muted-foreground/50 bg-secondary/40 px-4 py-2 text-[13px]"
        >
          <span className="font-semibold">Reference data — not live government systems.</span>{' '}
          <span className="text-muted-foreground">
            These lookups answer from a fictional local dataset (owners are “Reference Owner
            NNN”, case numbers start DEMO/ or REF/) behind the same interface a live VAHAN,
            SARTHI, eGujCop or AFIS connection would use. This platform has no access to the real
            registries.
          </span>
        </p>

        <div className="grid gap-5 xl:grid-cols-[22rem_minmax(0,1fr)]">
          <Panel className="h-fit p-0">
            <div className="px-2 pt-2">
              <Tabs
                value={tab}
                onChange={(next) => setParams({ tab: next })}
                tabs={[
                  { value: 'vehicle', label: 'Vehicle' },
                  { value: 'licence', label: 'Licence' },
                  { value: 'afis', label: 'AFIS reference' },
                ]}
              />
            </div>
            <div className="p-4">
              {tab === 'vehicle' && (
                <VehicleForm
                  key={`${plate}|${caseRef}`}
                  initial={{ plate, caseRef, ...observed }}
                  onSubmit={(v) =>
                    go({
                      tab: 'vehicle',
                      plate: v.plate,
                      type: v.vehicle_type ?? '',
                      colour: v.colour ?? '',
                      make: v.make ?? '',
                      case: v.caseRef,
                    })
                  }
                />
              )}
              {tab === 'licence' && (
                <KeyForm
                  key={`${licence}|${caseRef}`}
                  label="Licence number"
                  placeholder="GJ01 2019 0004217"
                  initial={licence}
                  caseRef={caseRef}
                  onSubmit={(key, c) => go({ tab: 'licence', licence: key, case: c })}
                />
              )}
              {tab === 'afis' && (
                <KeyForm
                  key={`${reference}|${caseRef}`}
                  label="Case or person reference"
                  placeholder="DEMO/FIR/2026/GNR/1187"
                  initial={reference}
                  caseRef={caseRef}
                  onSubmit={(key, c) => go({ tab: 'afis', ref: key, case: c })}
                />
              )}
              <Examples
                items={EXAMPLES[tab]}
                onPick={(key) =>
                  go(
                    tab === 'vehicle'
                      ? { tab, plate: key }
                      : tab === 'licence'
                        ? { tab, licence: key }
                        : { tab, ref: key },
                  )
                }
              />
            </div>
          </Panel>

          <div className="min-w-0">
            {tab === 'vehicle' &&
              (plate ? (
                <RegistryCard plate={plate} observed={observed} caseRef={caseRef || undefined} />
              ) : (
                <EmptyState
                  title="Look up a plate to see its registration and any FIR that names it."
                  hint="Add what the camera showed — class, colour, make — and the registration is checked against it."
                />
              ))}
            {tab === 'licence' &&
              (licence ? (
                <LicenceResult number={licence} caseRef={caseRef || undefined} />
              ) : (
                <EmptyState title="Look up a driving licence by its number." />
              ))}
            {tab === 'afis' &&
              (reference ? (
                <AfisResult reference={reference} caseRef={caseRef || undefined} />
              ) : (
                <EmptyState
                  title="Ask whether a fingerprint record exists for a case or person."
                  hint="Existence and reference only — no biometric data is held or shown."
                />
              ))}
          </div>
        </div>
      </div>
    </div>
  )
}

// ── Forms ────────────────────────────────────────────────────────────────

interface VehicleQuery {
  plate: string
  caseRef: string
  vehicle_type?: string
  colour?: string
  make?: string
}

function VehicleForm({
  initial,
  onSubmit,
}: {
  initial: VehicleQuery
  onSubmit: (query: VehicleQuery) => void
}) {
  const [plate, setPlate] = useState(initial.plate)
  const [type, setType] = useState(initial.vehicle_type ?? '')
  const [colour, setColour] = useState(initial.colour ?? '')
  const [make, setMake] = useState(initial.make ?? '')
  const [caseRef, setCaseRef] = useState(initial.caseRef)

  const submit = (e: FormEvent) => {
    e.preventDefault()
    if (!plate.trim()) return
    onSubmit({ plate: plate.trim(), caseRef: caseRef.trim(), vehicle_type: type, colour, make })
  }

  return (
    <form onSubmit={submit} className="space-y-3" aria-label="Vehicle lookup">
      <Field label="Plate">
        <Input
          value={plate}
          onChange={(e) => setPlate(e.target.value.toUpperCase())}
          placeholder="GJ03AB1234"
          autoComplete="off"
          spellCheck={false}
          className="font-mono"
        />
      </Field>
      <fieldset className="space-y-3 rounded-md border border-border p-3">
        <legend className="px-1 text-[11px] font-medium uppercase tracking-[0.06em] text-muted-foreground">
          What was seen · optional
        </legend>
        <Field label="Vehicle">
          <Select value={type} onChange={(e) => setType(e.target.value)}>
            <option value="">Not stated — use the latest sighting</option>
            {OBSERVABLE_TYPES.map((t) => (
              <option key={t} value={t}>
                {TYPE_WORDS[t]}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Colour">
          <Input value={colour} onChange={(e) => setColour(e.target.value)} placeholder="white" />
        </Field>
        <Field label="Make or model">
          <Input value={make} onChange={(e) => setMake(e.target.value)} placeholder="Swift" />
        </Field>
      </fieldset>
      <CaseField value={caseRef} onChange={setCaseRef} />
      <Button type="submit" disabled={!plate.trim()} className="w-full">
        Look up
      </Button>
    </form>
  )
}

function KeyForm({
  label,
  placeholder,
  initial,
  caseRef: initialCase,
  onSubmit,
}: {
  label: string
  placeholder: string
  initial: string
  caseRef: string
  onSubmit: (key: string, caseRef: string) => void
}) {
  const [key, setKey] = useState(initial)
  const [caseRef, setCaseRef] = useState(initialCase)
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault()
        if (key.trim()) onSubmit(key.trim(), caseRef.trim())
      }}
      className="space-y-3"
      aria-label={`${label} lookup`}
    >
      <Field label={label}>
        <Input
          value={key}
          onChange={(e) => setKey(e.target.value)}
          placeholder={placeholder}
          autoComplete="off"
          spellCheck={false}
          className="font-mono"
        />
      </Field>
      <CaseField value={caseRef} onChange={setCaseRef} />
      <Button type="submit" disabled={!key.trim()} className="w-full">
        Look up
      </Button>
    </form>
  )
}

function CaseField({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <Field label="Case reference" hint="Optional. Recorded with the lookup in the audit trail.">
      <Input value={value} onChange={(e) => onChange(e.target.value)} placeholder="DEMO/FIR/2026/…" />
    </Field>
  )
}

function Examples({
  items,
  onPick,
}: {
  items: { key: string; note: string }[]
  onPick: (key: string) => void
}) {
  return (
    <div className="mt-4 border-t border-border pt-3">
      <p className="text-[11px] text-faint">Examples from the reference dataset</p>
      <ul className="mt-1.5 space-y-1">
        {items.map((item) => (
          <li key={item.key}>
            <button
              type="button"
              onClick={() => onPick(item.key)}
              className="text-left text-xs text-primary hover:underline"
            >
              <span className="font-mono">{item.key}</span>
              <span className="ml-1.5 text-faint">{item.note}</span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  )
}

// ── Answers ──────────────────────────────────────────────────────────────

function useLookup<T>(fetch: () => Promise<T>, deps: unknown[]) {
  const [state, setState] = useState<{ data: T | null; error: string | null }>({
    data: null,
    error: null,
  })
  useEffect(() => {
    let cancelled = false
    setState({ data: null, error: null })
    fetch()
      .then((data) => {
        if (!cancelled) setState({ data, error: null })
      })
      .catch((err: unknown) => {
        if (!cancelled) setState({ data: null, error: err instanceof Error ? err.message : String(err) })
      })
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the caller names what the fetch depends on
  }, deps)
  return state
}

function ResultShell({
  title,
  aside,
  children,
}: {
  title: ReactNode
  aside: ReactNode
  children: ReactNode
}) {
  return (
    <section className="overflow-hidden rounded-lg border border-border bg-card">
      <header className="flex flex-wrap items-start justify-between gap-3 border-b border-border px-4 py-3">
        <div className="min-w-0">{title}</div>
        {aside}
      </header>
      {children}
    </section>
  )
}

function LicenceResult({ number, caseRef }: { number: string; caseRef?: string }) {
  const { data, error } = useLookup<LicenceLookup>(
    () => api.getLicenceRegistry(number, caseRef),
    [number, caseRef],
  )
  if (error) return <ErrorBanner>Licence lookup failed: {error}</ErrorBanner>
  if (!data) return <SkeletonRows rows={3} height="h-10" />
  const lic = data.licence
  return (
    <ResultShell
      title={
        <>
          <h2 className="font-mono text-[14px] font-semibold">{lic?.licence_number ?? number}</h2>
          <p className="text-xs text-muted-foreground">
            {lic ? `${lic.holder_name} · ${lic.holder_district}, ${lic.holder_state}` : 'No licence on record'}
          </p>
        </>
      }
      aside={<ProvenanceLabel source={data.source} sources={data.sources} provenance={data.provenance} />}
    >
      {!lic ? (
        <p className="px-4 py-4 text-[13px] text-muted-foreground">
          SARTHI holds no licence numbered {number} in the reference dataset.
        </p>
      ) : (
        <>
          {data.flags.length > 0 && (
            <div className="border-b border-border px-4 py-3">
              <FlagList flags={data.flags} />
            </div>
          )}
          <div className="grid gap-x-6 gap-y-4 px-4 py-3 md:grid-cols-2">
            <div className="text-[13px]">
              <h3 className="text-[11px] font-medium uppercase tracking-[0.06em] text-muted-foreground">
                Licence · SARTHI
              </h3>
              <p className="mt-2">
                Issued {formatDay(lic.issued_on)}
                <span className="block text-xs text-faint">{lic.issuing_authority}</span>
              </p>
              <p className="mt-2">
                Status{' '}
                <span className={lic.status === 'active' ? '' : 'font-medium text-priority-critical'}>
                  {lic.status}
                </span>
              </p>
              <ul className="mt-2 flex flex-wrap gap-1.5" aria-label="Classes of vehicle">
                {lic.classes.map((c) => (
                  <li
                    key={c.code}
                    title={c.label}
                    className="rounded border border-border bg-secondary/50 px-1.5 py-0.5 font-mono text-[11px]"
                  >
                    {c.code}
                  </li>
                ))}
              </ul>
            </div>
            <div>
              <h3 className="text-[11px] font-medium uppercase tracking-[0.06em] text-muted-foreground">
                Validity
              </h3>
              <DocumentList documents={lic.documents} />
            </div>
          </div>
        </>
      )}
      <footer className="border-t border-border px-4 py-2 text-[11px] text-faint">
        Validity judged on {formatDay(data.as_of)} (IST) · looked up {api.formatIST(data.queried_at)} IST ·
        audited
      </footer>
    </ResultShell>
  )
}

function AfisResult({ reference, caseRef }: { reference: string; caseRef?: string }) {
  const { data, error } = useLookup<AfisLookup>(
    () => api.getAfisRegistry(reference, caseRef),
    [reference, caseRef],
  )
  if (error) return <ErrorBanner>AFIS lookup failed: {error}</ErrorBanner>
  if (!data) return <SkeletonRows rows={2} height="h-10" />
  return (
    <ResultShell
      title={
        <>
          <h2 className="font-mono text-[14px] font-semibold">{reference}</h2>
          <p className={`text-[13px] font-medium ${data.record_exists ? 'text-foreground' : 'text-muted-foreground'}`}>
            {data.record_exists
              ? `${data.records.length} fingerprint record${data.records.length === 1 ? '' : 's'} exist${data.records.length === 1 ? 's' : ''}`
              : 'No fingerprint record'}
          </p>
        </>
      }
      aside={<ProvenanceLabel source={data.source} sources={data.sources} provenance={data.provenance} />}
    >
      {data.records.length > 0 && (
        <ul className="divide-y divide-border">
          {data.records.map((r) => (
            <li key={r.afis_reference} className="grid gap-1 px-4 py-2.5 text-[13px] sm:grid-cols-3">
              <span>
                <span className="block text-[11px] text-faint">AFIS reference</span>
                <span className="font-mono text-xs">{r.afis_reference}</span>
              </span>
              <span>
                <span className="block text-[11px] text-faint">NAFIS reference</span>
                <span className="font-mono text-xs">{r.nafis_reference ?? 'not matched nationally'}</span>
              </span>
              <span>
                <span className="block text-[11px] text-faint">Filed against</span>
                <span className="text-xs">
                  {r.reference}
                  {r.linked_fir_number && r.linked_fir_number !== r.reference && ` · FIR ${r.linked_fir_number}`}
                  {' · '}
                  {r.district}, {formatDay(r.recorded_on)}
                </span>
              </span>
            </li>
          ))}
        </ul>
      )}
      <footer className="border-t border-border px-4 py-2 text-[11px] text-faint">
        Existence and reference only — no biometric data is held or shown · looked up{' '}
        {api.formatIST(data.queried_at)} IST · audited
      </footer>
    </ResultShell>
  )
}
