/**
 * The registries lookup page.
 *
 * The screen says it is reference data before anything is asked; the query
 * lives in the URL, so a link opens already answered; a licence and an AFIS
 * reference answer with their own provenance; and AFIS shows existence and a
 * reference, nothing more.
 */

import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'

import * as api from '@/lib/api'
import type { AfisLookup, LicenceLookup, VehicleLookup } from '@/lib/registries'
import Registries from '@/pages/Registries'

function Where() {
  return <output data-testid="where">{useLocation().search}</output>
}

function renderAt(url: string) {
  return render(
    <MemoryRouter initialEntries={[url]}>
      <Routes>
        <Route
          path="/registries"
          element={
            <>
              <Registries />
              <Where />
            </>
          }
        />
      </Routes>
    </MemoryRouter>,
  )
}

const VAHAN: VehicleLookup = {
  source: 'reference',
  provenance: 'Reference data — not a live VAHAN or eGujCop/CCTNS query.',
  sources: [
    { registry: 'VAHAN', answers: 'Vehicle registration', source: 'reference', provenance: '…' },
    { registry: 'eGujCop/CCTNS', answers: 'FIRs', source: 'reference', provenance: '…' },
  ],
  query: 'GJ03AB1234',
  plate: 'GJ03AB1234',
  as_of: '2026-10-12',
  queried_at: '2026-10-12T02:00:00Z',
  found: false,
  registration: null,
  firs: [],
  sighting: null,
  checks: [],
  mismatch: false,
  flags: [],
}

const SARTHI: LicenceLookup = {
  source: 'reference',
  provenance: 'Reference data — not a live SARTHI query.',
  sources: [{ registry: 'SARTHI', answers: 'Driving licence', source: 'reference', provenance: '…' }],
  query: 'GJ0520120018830',
  as_of: '2026-10-12',
  queried_at: '2026-10-12T02:00:00Z',
  found: true,
  licence: {
    licence_number: 'GJ0520120018830',
    holder_name: 'Reference Holder 002',
    holder_district: 'Surat',
    holder_state: 'Gujarat',
    issuing_authority: 'RTO Surat (GJ05)',
    issued_on: '2012-09-14',
    classes: [
      { code: 'MCWG', label: 'Motorcycle with gear' },
      { code: 'LMV', label: 'Light motor vehicle' },
    ],
    status: 'suspended',
    status_reason: 'Suspended under MV Act 19.',
    documents: [
      {
        document: 'non_transport',
        label: 'Non-transport validity',
        valid_until: '2032-09-13',
        state: 'valid',
        days_remaining: 2163,
      },
    ],
  },
  flags: [
    {
      severity: 'critical',
      code: 'licence_suspended',
      label: 'Licence suspended',
      detail: 'Suspended under MV Act 19.',
    },
  ],
}

const AFIS: AfisLookup = {
  source: 'reference',
  provenance:
    'Reference data — not a live AFIS/NAFIS query. Existence and reference only: no biometric data is held or returned.',
  sources: [{ registry: 'AFIS/NAFIS', answers: 'Fingerprint record existence', source: 'reference', provenance: '…' }],
  query: 'DEMO/FIR/2026/GNR/1187',
  queried_at: '2026-10-12T02:00:00Z',
  record_exists: true,
  records: [
    {
      reference: 'DEMO/PER/2026/0004',
      afis_reference: 'REF-AFIS-GJ-2026-011871',
      nafis_reference: 'REF-NAFIS-2026-0000878',
      linked_fir_number: 'DEMO/FIR/2026/GNR/1187',
      district: 'Gandhinagar',
      recorded_on: '2026-10-04',
    },
    {
      reference: 'DEMO/FIR/2026/GNR/1187',
      afis_reference: 'REF-AFIS-GJ-2026-011870',
      nafis_reference: null,
      linked_fir_number: 'DEMO/FIR/2026/GNR/1187',
      district: 'Gandhinagar',
      recorded_on: '2026-10-02',
    },
  ],
}

describe('Registries', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('says it is reference data before anything is asked, and asks nothing by itself', () => {
    const get = vi.spyOn(api, 'getVehicleRegistry')
    renderAt('/registries')
    expect(screen.getByRole('note').textContent).toContain('Reference data — not live government systems.')
    expect(get).not.toHaveBeenCalled()
  })

  it('opens a linked plate already answered', async () => {
    const get = vi.spyOn(api, 'getVehicleRegistry').mockResolvedValue(VAHAN)
    renderAt('/registries?plate=GJ03AB1234')
    expect(await screen.findByText('No registration on record')).toBeTruthy()
    expect(get).toHaveBeenCalledWith('GJ03AB1234', expect.objectContaining({ case_ref: undefined }))
  })

  it('puts what was seen and the case into the URL and the lookup', async () => {
    const get = vi.spyOn(api, 'getVehicleRegistry').mockResolvedValue(VAHAN)
    renderAt('/registries')
    fireEvent.change(screen.getByPlaceholderText('GJ03AB1234'), { target: { value: 'gj05nr3318' } })
    fireEvent.change(screen.getByLabelText('Vehicle'), { target: { value: 'car' } })
    fireEvent.change(screen.getByPlaceholderText('white'), { target: { value: 'blue' } })
    fireEvent.change(screen.getByPlaceholderText('DEMO/FIR/2026/…'), { target: { value: 'DEMO/X/1' } })
    fireEvent.click(screen.getByRole('button', { name: 'Look up' }))
    await waitFor(() =>
      expect(get).toHaveBeenCalledWith('GJ05NR3318', {
        detection_id: undefined,
        vehicle_type: 'car',
        colour: 'blue',
        make: undefined,
        case_ref: 'DEMO/X/1',
      }),
    )
    const where = new URLSearchParams(screen.getByTestId('where').textContent ?? '')
    expect(where.get('plate')).toBe('GJ05NR3318')
    expect(where.get('type')).toBe('car')
    expect(where.get('case')).toBe('DEMO/X/1')
  })

  it('answers a licence with its status, its classes and its own provenance', async () => {
    vi.spyOn(api, 'getLicenceRegistry').mockResolvedValue(SARTHI)
    renderAt('/registries?tab=licence&licence=GJ0520120018830')
    expect(await screen.findByText('Reference Holder 002 · Surat, Gujarat')).toBeTruthy()
    expect(screen.getByText('Licence suspended')).toBeTruthy()
    expect(screen.getByText('MCWG')).toBeTruthy()
    expect(screen.getByTestId('registry-provenance').textContent).toContain(
      'Reference data — not a live SARTHI query',
    )
  })

  it('answers AFIS with existence and references only', async () => {
    const get = vi.spyOn(api, 'getAfisRegistry').mockResolvedValue(AFIS)
    renderAt('/registries?tab=afis&ref=DEMO%2FFIR%2F2026%2FGNR%2F1187')
    expect(await screen.findByText('2 fingerprint records exist')).toBeTruthy()
    expect(get).toHaveBeenCalledWith('DEMO/FIR/2026/GNR/1187', undefined)
    expect(screen.getByText('REF-AFIS-GJ-2026-011871')).toBeTruthy()
    expect(screen.getByText('not matched nationally')).toBeTruthy()
    expect(screen.getByText(/no biometric data is held or shown/)).toBeTruthy()
  })

  it('offers examples from the reference dataset for the open tab', async () => {
    const get = vi.spyOn(api, 'getAfisRegistry').mockResolvedValue({ ...AFIS, record_exists: false, records: [] })
    renderAt('/registries?tab=afis')
    fireEvent.click(screen.getByRole('button', { name: /DEMO\/FIR\/2026\/AHM\/0957/ }))
    expect(await screen.findByText('No fingerprint record')).toBeTruthy()
    expect(get).toHaveBeenCalledWith('DEMO/FIR/2026/AHM/0957', undefined)
  })
})
