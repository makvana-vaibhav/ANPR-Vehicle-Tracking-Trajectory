/**
 * The registry card.
 *
 * Where the answer came from is on the card and comes from the response;
 * expired is amber with the diamond and a word; a blacklist or an open FIR
 * is red with the triangle; a disagreement with the camera says why; and the
 * card fetches — and so audits — once per distinct question.
 */

import { render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import RegistryCard, { RegistryCardView } from '@/components/RegistryCard'
import * as api from '@/lib/api'
import type { VehicleLookup } from '@/lib/registries'

const SOURCES: VehicleLookup['sources'] = [
  {
    registry: 'VAHAN',
    answers: 'Vehicle registration',
    source: 'reference',
    provenance: 'Reference data — not a live VAHAN query.',
  },
  {
    registry: 'eGujCop/CCTNS',
    answers: 'FIRs naming the vehicle',
    source: 'reference',
    provenance: 'Reference data — not a live eGujCop/CCTNS query.',
  },
]

function lookup(changes: Partial<VehicleLookup> = {}): VehicleLookup {
  return {
    source: 'reference',
    provenance:
      'Reference data — not a live VAHAN or eGujCop/CCTNS query. A fictional local dataset.',
    sources: SOURCES,
    query: 'GJ01RV4827',
    plate: 'GJ01RV4827',
    as_of: '2026-10-12',
    queried_at: '2026-10-12T02:00:00Z',
    found: true,
    registration: {
      plate: 'GJ01RV4827',
      owner_name: 'Reference Owner 002',
      owner_district: 'Ahmedabad',
      owner_state: 'Gujarat',
      registering_authority: 'RTO Ahmedabad (GJ01)',
      registration_status: 'ACTIVE',
      vehicle_class: 'Motor Car (LMV)',
      vehicle_category: 'car',
      maker: 'Maruti Suzuki',
      model: 'Swift VXI',
      colour: 'Solid Fire Red',
      fuel: 'Petrol',
      manufacture_year: 2019,
      registered_on: '2019-07-02',
      documents: [
        { document: 'registration', label: 'Registration', valid_until: '2034-07-01', state: 'valid', days_remaining: 2819 },
        { document: 'fitness', label: 'Fitness certificate', valid_until: null, state: 'not_applicable', days_remaining: null },
        { document: 'insurance', label: 'Insurance', valid_until: '2026-07-01', state: 'expired', days_remaining: -103 },
        { document: 'puc', label: 'PUC certificate', valid_until: '2026-10-30', state: 'expiring', days_remaining: 18 },
      ],
      hypothecated: false,
      financier: null,
      blacklisted: false,
      blacklist_reason: null,
    },
    firs: [],
    sighting: null,
    checks: [
      {
        field: 'vehicle_class',
        label: 'Vehicle class',
        registered: 'Motor Car (LMV)',
        observed: null,
        observed_source: null,
        outcome: 'not_compared',
        reason: 'No sighting of this plate to compare against.',
      },
    ],
    mismatch: false,
    flags: [
      {
        severity: 'high',
        code: 'insurance_expired',
        label: 'Insurance expired',
        detail: 'Lapsed 1 Jul 2026, 103 days ago.',
      },
    ],
    ...changes,
  }
}

describe('RegistryCard', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('says it is reference data, not a live VAHAN query, on the card itself', () => {
    render(<RegistryCardView lookup={lookup()} />)
    const label = screen.getByTestId('registry-provenance')
    expect(label.textContent).toContain('Reference data — not a live VAHAN or eGujCop/CCTNS query')
    expect(label.dataset.source).toBe('reference')
  })

  it('takes the label from the response, so a live answer would say live', () => {
    const live = SOURCES.map((s) => ({ ...s, source: 'live' as const }))
    render(<RegistryCardView lookup={lookup({ source: 'live', sources: live })} />)
    const label = screen.getByTestId('registry-provenance')
    expect(label.textContent).toContain('Live VAHAN + eGujCop/CCTNS query')
    expect(label.textContent).not.toContain('Reference')
  })

  it('draws an expired document amber, with the diamond and a word', () => {
    const { container } = render(<RegistryCardView lookup={lookup()} />)
    const insurance = container.querySelector('[data-state="expired"]')!
    expect(insurance.textContent).toContain('Insurance')
    expect(insurance.textContent).toContain('Expired 1 Jul 2026')
    expect(insurance.textContent).toContain('103 days ago')
    expect(insurance.querySelector('.text-priority-high svg')).not.toBeNull()
    // Expiring soon is the quiet ring, not amber.
    const puc = container.querySelector('[data-state="expiring"]')!
    expect(puc.querySelector('.text-priority-high')).toBeNull()
    expect(puc.textContent).toContain('18 days left')
    // Valid is grey: no glyph at all.
    expect(container.querySelector('[data-state="valid"] svg')).toBeNull()
  })

  it('puts a blacklist and an open FIR first, red, with the triangle and their reasons', () => {
    const { container } = render(
      <RegistryCardView
        lookup={lookup({
          firs: [
            {
              fir_number: 'DEMO/FIR/2026/AHM/0957',
              police_station: 'Reference Police Station 11, Ahmedabad City',
              district: 'Ahmedabad',
              state: 'Gujarat',
              registered_on: '2026-10-03',
              sections: ['BNS 303(2)'],
              status: 'under_investigation',
              status_label: 'under investigation',
              open: true,
              vehicle_role: 'stolen',
              vehicle_role_label: 'reported stolen',
              summary: 'Reference record — car reported stolen.',
            },
          ],
          flags: [
            { severity: 'critical', code: 'fir_linked', label: 'FIR-linked', detail: 'FIR DEMO/FIR/2026/AHM/0957: vehicle reported stolen.' },
            { severity: 'critical', code: 'blacklisted', label: 'Blacklisted', detail: 'Road tax unpaid.' },
            { severity: 'high', code: 'insurance_expired', label: 'Insurance expired', detail: 'Lapsed 1 Jul 2026.' },
          ],
        })}
      />,
    )
    const flags = within(screen.getByRole('list', { name: 'Needs attention' })).getAllByRole('listitem')
    expect(flags.map((f) => f.dataset.severity)).toEqual(['critical', 'critical', 'high'])
    const [fir0, blacklist] = flags as [HTMLElement, HTMLElement, HTMLElement]
    expect(fir0.textContent).toContain('FIR-linked')
    expect(blacklist.textContent).toContain('Road tax unpaid.')
    // The triangle: critical's shape, so red is never the only signal.
    expect(fir0.querySelector('.text-priority-critical svg path')?.getAttribute('d')).toMatch(/^M5 0\.8/)
    const fir = container.querySelector('[data-open="true"]')!
    expect(fir.textContent).toContain('Open')
    expect(fir.textContent).toContain('BNS 303(2)')
  })

  it('flags a disagreement with what was seen, with its reason', () => {
    const { container } = render(
      <RegistryCardView
        lookup={lookup({
          mismatch: true,
          checks: [
            {
              field: 'vehicle_class',
              label: 'Vehicle class',
              registered: 'M-Cycle/Scooter (2WN)',
              observed: 'car',
              observed_source: 'sighting',
              outcome: 'mismatch',
              reason: 'Registered as a two-wheeler, but a car was seen carrying this plate.',
            },
            {
              field: 'colour',
              label: 'Colour',
              registered: 'Solid Fire Red',
              observed: 'maroon',
              observed_source: 'officer',
              outcome: 'match',
              reason: 'Both red.',
            },
          ],
        })}
      />,
    )
    const mismatch = container.querySelector('[data-outcome="mismatch"]')!
    expect(mismatch.textContent).toContain('Mismatch')
    expect(mismatch.textContent).toContain('seen car (sighting)')
    expect(mismatch.textContent).toContain('a car was seen carrying this plate')
    expect(mismatch.querySelector('.text-priority-high svg')).not.toBeNull()
    const match = container.querySelector('[data-outcome="match"]')!
    expect(match.textContent).toContain('Matches')
    expect(match.textContent).not.toContain('Both red.')
  })

  it('says plainly when there is no registration, and still says where it looked', () => {
    render(
      <RegistryCardView
        lookup={lookup({ found: false, registration: null, checks: [], flags: [], plate: 'GJ99ZZ0001' })}
      />,
    )
    expect(screen.getByText('No registration on record')).toBeTruthy()
    expect(screen.getByText('None in the reference dataset.')).toBeTruthy()
    expect(screen.getByTestId('registry-provenance')).toBeTruthy()
  })

  it('fetches once per question, passing what was seen and the sighting', async () => {
    const get = vi.spyOn(api, 'getVehicleRegistry').mockResolvedValue(lookup())
    const { rerender } = render(
      <RegistryCard plate="GJ01RV4827" detectionId="d-1" observed={{ colour: 'white' }} caseRef="DEMO/1" />,
    )
    await screen.findByText('Maruti Suzuki Swift VXI')
    // A fresh `observed` object with the same values is the same question.
    rerender(
      <RegistryCard plate="GJ01RV4827" detectionId="d-1" observed={{ colour: 'white' }} caseRef="DEMO/1" />,
    )
    await waitFor(() => expect(get).toHaveBeenCalledTimes(1))
    expect(get).toHaveBeenCalledWith('GJ01RV4827', {
      detection_id: 'd-1',
      vehicle_type: undefined,
      colour: 'white',
      make: undefined,
      case_ref: 'DEMO/1',
    })
  })

  it('says a failed lookup failed, rather than showing an empty record', async () => {
    vi.spyOn(api, 'getVehicleRegistry').mockRejectedValue(new Error('The VAHAN reference dataset could not be read.'))
    render(<RegistryCard plate="GJ01RV4827" />)
    expect((await screen.findByRole('alert')).textContent).toContain('could not be read')
  })
})
