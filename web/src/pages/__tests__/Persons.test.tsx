/**
 * The persons watchlist screen: who may do what, four-eyes made visible, and
 * enrolment that says why a photo was refused.
 */

import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { ToastProvider } from '@/components/Toast'
import * as api from '@/lib/api'
import { PERMISSIONS } from '@/lib/permissions'
import type { PersonEntry, PersonGalleryStatus } from '@/lib/types'
import Persons, { categoryLabel, expiryLabel, reviewBlocker } from '@/pages/Persons'

const auth = vi.hoisted(() => ({ permissions: new Set<string>(), userId: 'u-me' }))
vi.mock('@/hooks/useAuth', () => ({
  useAuth: () => ({
    user: { id: auth.userId, username: 'me', role: 'supervisor', permissions: [...auth.permissions] },
    can: (permission: string) => auth.permissions.has(permission),
  }),
}))

function entry(id: string, overrides: Partial<PersonEntry> = {}): PersonEntry {
  return {
    id,
    display_name: `Entry ${id}`,
    category: 'missing',
    case_ref: `MP/2026/${id}`,
    purpose: 'Reported missing from Paldi on 10 Oct; family consent on file.',
    notes: null,
    status: 'active',
    valid_until: '2026-11-11T00:00:00Z',
    matchable: true,
    photo_url: `http://localhost:9000/nagarnetra-persons/persons/${id}/reference.jpg?X-Amz-Signature=s`,
    photo_purged: false,
    enrol_quality: { face_px: 110, detector_score: 0.94 },
    embedding_model: 'sface_2021dec',
    enrolled_by: 'u-other',
    enrolled_by_username: 'supervisor',
    enrolled_at: '2026-10-12T01:00:00Z',
    approved_by_username: 'admin',
    approved_at: '2026-10-12T01:05:00Z',
    rejected_by_username: null,
    rejected_at: null,
    rejection_reason: null,
    retired_by_username: null,
    retired_at: null,
    retired_reason: null,
    can_review: false,
    ...overrides,
  }
}

const ACTIVE = entry('a1')
const MINE_PENDING = entry('p1', {
  status: 'pending_approval',
  matchable: false,
  enrolled_by: 'u-me',
  enrolled_by_username: 'me',
  approved_by_username: null,
  approved_at: null,
})
const THEIRS_PENDING = entry('p2', {
  status: 'pending_approval',
  matchable: false,
  approved_by_username: null,
  approved_at: null,
  can_review: true,
})
const RETIRED = entry('r1', {
  status: 'retired',
  matchable: false,
  retired_by_username: 'supervisor',
  retired_reason: 'Found safe; case closed',
})

const GALLERY: PersonGalleryStatus = {
  active_entries: 1,
  pending_entries: 2,
  version: 'v1',
  published_at: '2026-10-12T01:05:00Z',
  publish_error: null,
  threshold: 0.45,
  min_frames: 2,
  min_margin: 0.05,
  model: 'sface_2021dec',
  model_threshold: 0.363,
  cameras: ['CAM-DEMO-02'],
  default_valid_days: 30,
  max_valid_days: 90,
  min_face_px: 80,
}

function renderPage() {
  return render(
    <ToastProvider>
      <MemoryRouter>
        <Persons />
      </MemoryRouter>
    </ToastProvider>,
  )
}

const section = (name: string) => screen.getByRole('region', { name })

describe('Persons page', () => {
  beforeEach(() => {
    // jsdom has no object URLs; the drawer previews the chosen photo with one.
    Object.assign(URL, { createObjectURL: vi.fn(() => 'blob:preview'), revokeObjectURL: vi.fn() })
    auth.permissions = new Set([
      PERMISSIONS.personRead,
      PERMISSIONS.personEnrol,
      PERMISSIONS.personApprove,
      PERMISSIONS.personRetire,
    ])
    vi.spyOn(api, 'getPersons').mockResolvedValue({
      items: [ACTIVE, MINE_PENDING, THEIRS_PENDING, RETIRED],
      total: 4,
      limit: 50,
      offset: 0,
      pending: 2,
    })
    vi.spyOn(api, 'getPersonGallery').mockResolvedValue(GALLERY)
    vi.spyOn(api, 'approvePerson').mockResolvedValue({ ...THEIRS_PENDING, status: 'active' })
    vi.spyOn(api, 'retirePerson').mockResolvedValue({ ...ACTIVE, status: 'retired' })
    vi.spyOn(api, 'rejectPerson').mockResolvedValue({ ...THEIRS_PENDING, status: 'rejected' })
    vi.spyOn(api, 'enrolPerson').mockResolvedValue(MINE_PENDING)
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('reads the list once on opening — every read is audited, so it never polls', async () => {
    renderPage()
    await screen.findByText('Entry a1')
    expect(api.getPersons).toHaveBeenCalledTimes(1)
    expect(api.getPersons).toHaveBeenCalledWith({ limit: 50 })
  })

  it('shows each entry with its photo, case and who enrolled and approved it', async () => {
    renderPage()
    await screen.findByText('Entry a1')
    const matched = section('Matched now')
    const photo = within(matched).getByAltText('Reference photo: Entry a1') as HTMLImageElement
    expect(photo.src).toContain('reference.jpg')
    expect(within(matched).getByText('MP/2026/a1')).toBeTruthy()
    expect(within(matched).getByText('approved by admin')).toBeTruthy()
    expect(within(matched).getByText('Missing person')).toBeTruthy()
  })

  it('makes four-eyes visible: no approve button on an entry you enrolled, and why', async () => {
    renderPage()
    await screen.findByText('Entry p1')
    const queue = section('Awaiting approval')
    const mine = within(queue).getByText('Entry p1').closest('li')!
    expect(within(mine).queryByRole('button', { name: 'Approve' })).toBeNull()
    expect(within(mine).getByText(/You enrolled this entry — a different account must approve/)).toBeTruthy()

    const theirs = within(queue).getByText('Entry p2').closest('li')!
    fireEvent.click(within(theirs).getByRole('button', { name: 'Approve' }))
    await waitFor(() => expect(api.approvePerson).toHaveBeenCalledWith('p2'))
  })

  it('will not retire without a reason', async () => {
    renderPage()
    await screen.findByText('Entry a1')
    fireEvent.click(within(section('Matched now')).getByRole('button', { name: 'Retire' }))
    const drawer = await screen.findByRole('dialog', { name: /Retire Entry a1/ })
    const submit = within(drawer).getByRole('button', { name: 'Retire' }) as HTMLButtonElement
    expect(submit.disabled).toBe(true)
    fireEvent.change(within(drawer).getByPlaceholderText('Found safe; case closed'), {
      target: { value: 'Found safe' },
    })
    fireEvent.click(submit)
    await waitFor(() => expect(api.retirePerson).toHaveBeenCalledWith('a1', 'Found safe'))
  })

  it('enrols with a photo and a stated purpose, and shows why a photo was refused', async () => {
    vi.mocked(api.enrolPerson).mockRejectedValueOnce(
      new api.ApiError(
        '3 faces were found in the photo. A reference photo must show exactly one person — crop it to the one face and try again.',
        422,
      ),
    )
    renderPage()
    await screen.findByText('Entry a1')
    fireEvent.click(screen.getByRole('button', { name: /Enrol a person/ }))
    const drawer = await screen.findByRole('dialog', { name: 'Enrol a person' })
    const photo = new File([new Uint8Array([0xff, 0xd8, 0xff])], 'ref.jpg', { type: 'image/jpeg' })
    fireEvent.change(within(drawer).getByLabelText('Reference photo'), { target: { files: [photo] } })
    fireEvent.change(within(drawer).getByLabelText(/Display name/), { target: { value: 'Asha' } })
    fireEvent.change(within(drawer).getByPlaceholderText('MP/2026/0142'), { target: { value: 'MP/2026/0999' } })
    const submit = within(drawer).getByRole('button', { name: /Enrol — pending approval/ }) as HTMLButtonElement
    // A purpose is required before anything is sent.
    expect(submit.disabled).toBe(true)
    fireEvent.change(within(drawer).getByLabelText('Purpose and legal basis'), {
      target: { value: 'Missing person report MP/2026/0999, family consent on file.' },
    })
    fireEvent.click(submit)
    expect(await within(drawer).findByRole('alert')).toBeTruthy()
    expect(within(drawer).getByRole('alert').textContent).toContain('exactly one person')

    fireEvent.click(submit)
    await waitFor(() => expect(api.enrolPerson).toHaveBeenCalledTimes(2))
    expect(vi.mocked(api.enrolPerson).mock.calls[1]![0]).toMatchObject({
      display_name: 'Asha',
      category: 'missing',
      case_ref: 'MP/2026/0999',
      valid_days: 30,
    })
  })

  it('offers a read-only role nothing to change', async () => {
    auth.permissions = new Set([PERMISSIONS.personRead])
    renderPage()
    await screen.findByText('Entry a1')
    expect(screen.queryByRole('button', { name: /Enrol a person/ })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Retire' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Approve' })).toBeNull()
    expect(screen.getByText(/Your role can read the persons watchlist but not change it/)).toBeTruthy()
  })

  it('keeps retired entries, quietly, with why they ended', async () => {
    renderPage()
    await screen.findByText('Entry r1')
    expect(within(section('No longer matched')).getByText('Found safe; case closed')).toBeTruthy()
  })
})

describe('persons vocabulary', () => {
  it('never labels a demonstration entry as wanted', () => {
    expect(categoryLabel('demo')).toBe('Demo — fictional case')
    expect(categoryLabel('wanted')).toBe('Wanted — warrant')
  })

  it('says how long an entry has left', () => {
    const now = Date.parse('2026-10-12T00:00:00Z')
    expect(expiryLabel('2026-10-22T00:00:00Z', now)).toBe('10 days left')
    expect(expiryLabel('2026-10-12T05:00:00Z', now)).toBe('expires today')
    expect(expiryLabel('2026-10-11T00:00:00Z', now)).toBe('expired')
  })

  it('names why a pending entry cannot be decided', () => {
    const pending = { status: 'pending_approval' as const, enrolled_by: 'u-me', can_review: false }
    expect(reviewBlocker(pending, 'u-me', true)).toMatch(/You enrolled this entry/)
    expect(reviewBlocker({ ...pending, enrolled_by: 'x' }, 'u-me', false)).toMatch(/person\.approve/)
    expect(reviewBlocker({ ...pending, enrolled_by: 'x', can_review: true }, 'u-me', true)).toBeNull()
  })
})
