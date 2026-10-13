/**
 * Alarm triage.
 *
 * What these pin is what an operator relies on without looking: the alarm a
 * link names is the one on screen, a key acts on the alarm that is selected
 * and no other, a false positive is never sent without the reason the API
 * demands, and a role is offered only the steps it may take.
 */

import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { ToastProvider } from '@/components/Toast'
import * as api from '@/lib/api'
import { PERMISSIONS } from '@/lib/permissions'
import type { Alert, AlertPage, Camera, CameraPage, LiveAlertEvent, WatchlistEntry } from '@/lib/types'
import Alerts, {
  ageLabel,
  alarmKind,
  alarmTitle,
  collapseReasons,
  filterByKind,
  groupQueue,
  parseKind,
  parseScope,
  reconcileSelection,
  splitNotes,
} from '@/pages/Alerts'

const auth = vi.hoisted(() => ({ permissions: new Set<string>(), userId: 'user-me' }))
vi.mock('@/hooks/useAuth', () => ({
  useAuth: () => ({
    user: { id: auth.userId, username: 'operator', role: 'supervisor', permissions: [...auth.permissions] },
    can: (permission: string) => auth.permissions.has(permission),
  }),
}))

const stream = vi.hoisted(() => ({ alerts: [] as LiveAlertEvent[] }))
vi.mock('@/hooks/useEventStream', () => ({
  useEventStream: () => ({ alerts: stream.alerts }),
}))

const EVERYTHING = [
  PERMISSIONS.alertRead,
  PERMISSIONS.alertAcknowledge,
  PERMISSIONS.alertDispatch,
  PERMISSIONS.alertClose,
  PERMISSIONS.watchlistRead,
  PERMISSIONS.searchExecute,
  PERMISSIONS.streamView,
]

function alarm(id: string, overrides: Partial<Alert> = {}): Alert {
  return {
    id,
    created_at: '2026-10-11T14:45:06Z',
    alert_type: 'watchlist_hit',
    priority: 'critical',
    plate_normalised: 'GJ03AB1234',
    confidence: 0.93,
    status: 'new',
    camera_id: 'cam-1',
    detection_id: 'det-1',
    watchlist_id: 'wl-1',
    acknowledged_by: null,
    acknowledged_at: null,
    notes: null,
    crop_url: null,
    reasons: null,
    ...overrides,
  }
}

const HIT = alarm('alarm-hit')
const JOURNEY = alarm('alarm-journey', {
  alert_type: 'anomaly',
  priority: 'high',
  plate_normalised: 'GJ01XY0001',
  confidence: null,
  detection_id: null,
  watchlist_id: null,
  notes: 'CAM-01 → CAM-02: this leg is not physically plausible (implausible_speed)',
  reasons: [
    {
      factor: 'impossible_hop',
      detail: 'CAM-01 → CAM-02: this leg is not physically plausible (implausible_speed)',
    },
  ],
})
const CAMERA_DOWN = alarm('alarm-camera', {
  alert_type: 'camera_down',
  priority: 'medium',
  plate_normalised: null,
  confidence: null,
  camera_id: 'cam-2',
  detection_id: null,
  watchlist_id: null,
  notes: 'CAM-02 (Paldi Circle) unreachable: timeout',
})

function camera(id: string, code: string): Camera {
  return {
    id,
    camera_code: code,
    name: `${code} junction`,
    department_code: null,
    department_name: null,
    vms_name: null,
    vms_vendor: null,
    corridor: null,
    district: 'Ahmedabad',
    city: 'Ahmedabad',
    junction: 'Paldi Circle',
    address: null,
    lat: 23.0,
    lon: 72.5,
    heading_deg: null,
    camera_type: null,
    protocol: null,
    resolution: null,
    fps: null,
    anpr_enabled: true,
    status: 'online',
    installed_on: null,
    tags: null,
    has_stream: true,
    source_file: null,
    created_at: '2026-09-01T00:00:00Z',
    updated_at: '2026-09-01T00:00:00Z',
  }
}

const ENTRY: WatchlistEntry = {
  id: 'wl-1',
  plate_normalised: 'GJ03AB1234',
  category: 'stolen',
  priority: 'critical',
  case_ref: 'FIR/2026/RJT/0412',
  remarks: 'Reported stolen from Kalawad Road',
  valid_from: null,
  valid_to: null,
  active: true,
  added_by: null,
  created_at: '2026-09-13T03:07:59Z',
}

function page(items: Alert[]): AlertPage {
  return { items, total: items.length, limit: 100, offset: 0 }
}

function Where() {
  const location = useLocation()
  return <output data-testid="where">{location.search}</output>
}

function renderAt(path: string) {
  return render(
    <ToastProvider>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route
            path="/alerts"
            element={
              <>
                <Alerts />
                <Where />
              </>
            }
          />
        </Routes>
      </MemoryRouter>
    </ToastProvider>,
  )
}

const shownTitle = () => screen.findByRole('heading', { level: 2 })
const where = () => screen.getByTestId('where').textContent ?? ''
const queue = () => screen.getByRole('complementary', { name: 'Alarm queue' })

describe('Alerts page', () => {
  beforeEach(() => {
    auth.permissions = new Set(EVERYTHING)
    stream.alerts = []
    vi.spyOn(api, 'getAlerts').mockResolvedValue(page([HIT, JOURNEY, CAMERA_DOWN]))
    vi.spyOn(api, 'getCameras').mockResolvedValue({
      items: [camera('cam-1', 'CAM-01'), camera('cam-2', 'CAM-02')],
      total: 2,
      limit: 500,
      offset: 0,
    } as CameraPage)
    vi.spyOn(api, 'getWatchlist').mockResolvedValue([ENTRY])
    vi.spyOn(api, 'getAlert').mockRejectedValue(new Error('No such alert'))
    vi.spyOn(api, 'transitionAlert').mockImplementation(async (id, status) => ({
      ...HIT,
      id,
      status,
    }))
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('reads the open queue, most severe first', async () => {
    renderAt('/alerts')
    await shownTitle()
    expect(api.getAlerts).toHaveBeenCalledWith(
      expect.objectContaining({ open_only: true, sort: 'priority', limit: 100, offset: 0 }),
    )
  })

  it('shows the most severe alarm when no alarm is named', async () => {
    renderAt('/alerts')
    expect((await shownTitle()).textContent).toBe('Watched vehicle read')
  })

  it('shows the alarm a link names, not the first in the queue', async () => {
    renderAt('/alerts?alert=alarm-journey')
    await waitFor(async () => expect((await shownTitle()).textContent).toBe('Journey to explain'))
    expect(screen.getByText('Impossible leg', { selector: 'span' })).toBeTruthy()
  })

  it('keeps the address on the alarm the operator picks, replacing rather than adding history', async () => {
    renderAt('/alerts?alert=alarm-journey')
    await waitFor(async () => expect((await shownTitle()).textContent).toBe('Journey to explain'))

    fireEvent.click(within(queue()).getByText('Camera stopped sending video'))
    await waitFor(() => expect(where()).toBe('?alert=alarm-camera'))
    expect((await shownTitle()).textContent).toBe('Camera stopped sending video')
  })

  it('moves with j and k in queue order, and the address follows', async () => {
    renderAt('/alerts')
    await shownTitle()

    fireEvent.keyDown(window, { key: 'j' })
    await waitFor(() => expect(where()).toBe('?alert=alarm-journey'))
    fireEvent.keyDown(window, { key: 'j' })
    await waitFor(() => expect(where()).toBe('?alert=alarm-camera'))
    fireEvent.keyDown(window, { key: 'k' })
    await waitFor(() => expect(where()).toBe('?alert=alarm-journey'))
  })

  it('waits for a linked alarm it has not loaded, and selects it when it arrives', async () => {
    const view = renderAt('/alerts?alert=alarm-late')
    expect(await screen.findByText('That alarm is not in this list.')).toBeTruthy()

    const late = alarm('alarm-late', { priority: 'low', alert_type: 'possible_match', plate_normalised: 'GJ03AB1284' })
    vi.mocked(api.getAlerts).mockResolvedValue(page([HIT, JOURNEY, CAMERA_DOWN, late]))
    stream.alerts = [
      {
        event: 'alert.raised',
        alert_id: 'alarm-late',
        alert_type: 'possible_match',
        priority: 'low',
        plate: 'GJ03AB1284',
        confidence: 0.9,
        status: 'new',
        camera_id: 'cam-1',
        detection_id: 'det-2',
        created_at: '2026-10-11T15:00:00Z',
        notes: null,
        reasons: null,
      },
    ]
    view.rerender(
      <ToastProvider>
        <MemoryRouter initialEntries={['/alerts?alert=alarm-late']}>
          <Routes>
            <Route path="/alerts" element={<Alerts />} />
          </Routes>
        </MemoryRouter>
      </ToastProvider>,
    )
    await waitFor(async () => expect((await shownTitle()).textContent).toBe('Possible watchlist match'))
  })

  it('finds a linked alarm closed since, and opens the list it now belongs to', async () => {
    vi.mocked(api.getAlert).mockResolvedValue(alarm('alarm-old', { status: 'closed' }))
    renderAt('/alerts?alert=alarm-old')
    await waitFor(() => expect(where()).toContain('status=closed'))
    expect(api.getAlert).toHaveBeenCalledWith('alarm-old')
    expect(where()).toContain('alert=alarm-old')
  })

  it('acknowledges the selected alarm with a, and says so in plate form', async () => {
    renderAt('/alerts?alert=alarm-hit')
    await shownTitle()

    fireEvent.keyDown(window, { key: 'a' })
    await waitFor(() => expect(api.transitionAlert).toHaveBeenCalledWith('alarm-hit', 'acknowledged', undefined))
    expect(await screen.findByText('GJ 03 AB 1234 acknowledged. Recorded against you.')).toBeTruthy()
  })

  it('names a camera alarm by its camera, never "null"', async () => {
    renderAt('/alerts?alert=alarm-camera')
    await waitFor(async () => expect((await shownTitle()).textContent).toBe('Camera stopped sending video'))

    fireEvent.keyDown(window, { key: 'a' })
    expect(await screen.findByText('CAM-02 acknowledged. Recorded against you.')).toBeTruthy()
  })

  it('asks why before sending a false positive, then sends the reason with it', async () => {
    renderAt('/alerts?alert=alarm-hit')
    await shownTitle()

    fireEvent.keyDown(window, { key: 'f' })
    // A Field's label carries its hint too, so match the start of it.
    const reason = await screen.findByLabelText(/^Why is this a false positive\?/)
    expect(api.transitionAlert).not.toHaveBeenCalled()

    fireEvent.change(reason, { target: { value: 'The crop shows a different plate' } })
    fireEvent.keyDown(reason, { key: 'Enter' })
    await waitFor(() =>
      expect(api.transitionAlert).toHaveBeenCalledWith(
        'alarm-hit',
        'false_positive',
        'The crop shows a different plate',
      ),
    )
  })

  it('sends a note typed for any other step with that step', async () => {
    renderAt('/alerts?alert=alarm-hit')
    await shownTitle()

    fireEvent.change(screen.getByLabelText(/^Note for the record/), {
      target: { value: 'Matched against the crop' },
    })
    fireEvent.click(screen.getByRole('button', { name: /Acknowledge/ }))
    await waitFor(() =>
      expect(api.transitionAlert).toHaveBeenCalledWith('alarm-hit', 'acknowledged', 'Matched against the crop'),
    )
  })

  it('offers a role only the steps it holds, by button and by key', async () => {
    auth.permissions = new Set([PERMISSIONS.alertRead, PERMISSIONS.alertAcknowledge])
    renderAt('/alerts?alert=alarm-hit')
    await shownTitle()

    expect(screen.getByRole('button', { name: /Acknowledge/ })).toBeTruthy()
    expect(screen.queryByRole('button', { name: /False positive/ })).toBeNull()

    fireEvent.keyDown(window, { key: 'f' })
    expect(screen.queryByLabelText(/^Why is this a false positive\?/)).toBeNull()
    expect(api.transitionAlert).not.toHaveBeenCalled()
  })

  it('says when a role can read an alarm but not move it', async () => {
    auth.permissions = new Set([PERMISSIONS.alertRead])
    renderAt('/alerts?alert=alarm-hit')
    await shownTitle()
    expect(screen.getByText(/your role cannot advance this alarm/)).toBeTruthy()
  })

  it('draws the alarms on one plate together', async () => {
    const second = alarm('alarm-hit-journey', {
      alert_type: 'anomaly',
      priority: 'low',
      watchlist_id: null,
      reasons: [{ factor: 'rare_transition', detail: 'CAM-01 → CAM-09 has been made by 0 vehicle(s)' }],
    })
    vi.mocked(api.getAlerts).mockResolvedValue(page([HIT, JOURNEY, CAMERA_DOWN, second]))
    renderAt('/alerts')
    await shownTitle()
    expect(within(queue()).getByText('2 alarms · one vehicle')).toBeTruthy()
  })

  it('filters by kind, with counts from what is loaded', async () => {
    renderAt('/alerts')
    await shownTitle()
    const cameras = within(queue()).getByRole('radio', { name: /Cameras/ })
    expect(cameras.textContent).toContain('1')

    fireEvent.click(cameras)
    await waitFor(async () => expect((await shownTitle()).textContent).toBe('Camera stopped sending video'))
    expect(within(queue()).queryByText('Watched vehicle read')).toBeNull()
  })

  it('reads every status when asked, and puts the choice in the address', async () => {
    renderAt('/alerts')
    await shownTitle()
    fireEvent.change(screen.getByLabelText('Which alarms'), { target: { value: 'all' } })
    await waitFor(() => expect(where()).toContain('status=all'))
    await waitFor(() =>
      expect(api.getAlerts).toHaveBeenLastCalledWith(
        expect.not.objectContaining({ open_only: true }),
      ),
    )
  })

  it('shows the watchlist entry behind a hit', async () => {
    renderAt('/alerts?alert=alarm-hit')
    await shownTitle()
    // Named in the entry and again in why the alarm fired.
    expect((await screen.findAllByText('FIR/2026/RJT/0412')).length).toBeGreaterThan(0)
    expect(screen.getByText('Reported stolen from Kalawad Road')).toBeTruthy()
    expect(api.getWatchlist).toHaveBeenCalledWith(expect.objectContaining({ active_only: 'false' }))
  })

  it('reports a queue it could not read rather than showing an empty one', async () => {
    vi.mocked(api.getAlerts).mockRejectedValue(new Error('API unreachable'))
    renderAt('/alerts')
    expect(await screen.findByText(/Could not read the alarms: API unreachable/)).toBeTruthy()
    expect(screen.queryByText('Nothing open.')).toBeNull()
  })
})

describe('alarm vocabulary', () => {
  it('sorts types into the filter chips', () => {
    expect(alarmKind('watchlist_hit')).toBe('watchlist')
    expect(alarmKind('possible_match')).toBe('watchlist')
    expect(alarmKind('anomaly')).toBe('journey')
    expect(alarmKind('camera_down')).toBe('camera')
    expect(alarmKind('something_new')).toBe('other')
  })

  it('never calls a journey a suspect', () => {
    expect(alarmTitle({ alert_type: 'anomaly', camera_id: 'c' })).toBe('Journey to explain')
  })

  it('tells a camera from a whole integration', () => {
    expect(alarmTitle({ alert_type: 'camera_down', camera_id: 'c' })).toBe('Camera stopped sending video')
    expect(alarmTitle({ alert_type: 'camera_down', camera_id: null })).toBe('Integration stopped answering')
  })

  it('reads the status filter from the address, defaulting to the open queue', () => {
    expect(parseScope(null)).toBe('open')
    expect(parseScope('closed')).toBe('closed')
    expect(parseScope('nonsense')).toBe('open')
  })

  it('writes an age the way an operator says it', () => {
    const now = Date.parse('2026-10-11T12:00:00Z')
    expect(ageLabel('2026-10-11T11:59:30Z', now)).toBe('just now')
    expect(ageLabel('2026-10-11T11:54:00Z', now)).toBe('6 min')
    expect(ageLabel('2026-10-11T10:45:00Z', now)).toBe('1 h 15 min')
    expect(ageLabel('2026-10-11T10:00:00Z', now)).toBe('2 h')
    expect(ageLabel('2026-10-09T09:00:00Z', now)).toBe('2 d 3 h')
  })
})

describe('reasons and notes', () => {
  it('folds a repeated reason into one line with a count', () => {
    const leg = { factor: 'impossible_hop', detail: 'A → B: not plausible' }
    const slow = { factor: 'slow_transition', detail: 'B → C took 68s' }
    expect(collapseReasons([leg, slow, leg, leg])).toEqual([
      { reason: leg, count: 3 },
      { reason: slow, count: 1 },
    ])
  })

  it('does not repeat an anomaly’s reasons as a note, and keeps what came after', () => {
    expect(
      splitNotes({
        alert_type: 'anomaly',
        reasons: [{ factor: 'rare_transition', detail: 'rare' }, { factor: 'slow_transition', detail: 'slow' }],
        notes: 'rare; slow\nClosed: replay loop',
      }),
    ).toEqual({ cause: null, notes: ['Closed: replay loop'] })
  })

  it('treats every line on an exact hit as an operator’s', () => {
    expect(splitNotes({ alert_type: 'watchlist_hit', reasons: null, notes: 'Checked the crop' })).toEqual({
      cause: null,
      notes: ['Checked the crop'],
    })
  })

  it('keeps the platform’s cause apart, without its machine tag', () => {
    expect(
      splitNotes({
        alert_type: 'camera_down',
        reasons: null,
        notes: 'Integration unreachable: Grid — 30 cameras. [vms:a3d4-22c3]\nClosed automatically.',
      }),
    ).toEqual({ cause: 'Integration unreachable: Grid — 30 cameras.', notes: ['Closed automatically.'] })
  })
})

describe('the queue', () => {
  it('groups by plate where the worst alarm falls, and keeps cameras together', () => {
    const groups = groupQueue([
      alarm('1', { plate_normalised: 'AAA1111', priority: 'critical' }),
      alarm('2', { plate_normalised: null, alert_type: 'camera_down', priority: 'high' }),
      alarm('3', { plate_normalised: 'BBB2222', priority: 'high' }),
      alarm('4', { plate_normalised: 'AAA1111', priority: 'medium' }),
      alarm('5', { plate_normalised: null, alert_type: 'camera_down', priority: 'medium' }),
    ])
    expect(groups.map((g) => [g.kind, g.alerts.map((a) => a.id)])).toEqual([
      ['vehicle', ['1', '4']],
      ['cameras', ['2', '5']],
      ['vehicle', ['3']],
    ])
  })

  it('keeps the selected alarm when the queue changes around it', () => {
    expect(
      reconcileSelection({ selectedId: 'b', visibleIds: ['new', 'a', 'b'], seenId: 'b', advance: null }),
    ).toBe('b')
  })

  it('starts on the most severe', () => {
    expect(reconcileSelection({ selectedId: null, visibleIds: ['a', 'b'], seenId: null, advance: null })).toBe('a')
  })

  it('moves to the next alarm after closing one here', () => {
    expect(
      reconcileSelection({
        selectedId: 'b',
        visibleIds: ['a', 'c'],
        seenId: 'b',
        advance: { from: 'b', next: 'c' },
      }),
    ).toBe('c')
  })

  it('falls back to the most severe when the shown alarm is closed elsewhere', () => {
    expect(reconcileSelection({ selectedId: 'b', visibleIds: ['a', 'c'], seenId: 'b', advance: null })).toBe('a')
  })

  it('waits for a linked alarm it has never seen', () => {
    expect(reconcileSelection({ selectedId: 'z', visibleIds: ['a'], seenId: null, advance: null })).toBe('z')
    expect(reconcileSelection({ selectedId: 'z', visibleIds: [], seenId: null, advance: null })).toBe('z')
  })

  it('lets go of an alarm once nothing is left', () => {
    expect(reconcileSelection({ selectedId: 'b', visibleIds: [], seenId: 'b', advance: null })).toBeNull()
  })
})

describe('a possible person match', () => {
  const MATCH = alarm('alarm-person', {
    alert_type: 'person_match',
    priority: 'high',
    plate_normalised: null,
    confidence: null,
    camera_id: 'cam-1',
    detection_id: null,
    watchlist_id: null,
    similarity: 0.73,
    notes: 'The captured face scored 0.73 against the enrolled reference photo',
    reasons: [
      {
        factor: 'face_similarity',
        detail:
          "The captured face scored 0.73 against the enrolled reference photo (cosine similarity). This deployment requires 0.45; the model's published threshold is 0.363.",
      },
      { factor: 'frames_agreed', detail: '3 analysed frames of the same face agreed on this entry over 1.0 s (2 required).' },
      {
        factor: 'watchlist_entry',
        detail: 'The entry is a demonstration entry with a fictional case, under case DEMO/PERSONS/001 (fictional), approved by admin.',
      },
    ],
  })

  const EVIDENCE = {
    alert_id: 'alarm-person',
    person: {
      id: 'person-1',
      display_name: 'Demo subject — stock footage',
      category: 'demo',
      case_ref: 'DEMO/PERSONS/001 (fictional)',
      purpose: 'Demonstration of the persons watchlist.',
      notes: null,
      status: 'active' as const,
      valid_until: '2026-10-19T00:00:00Z',
      matchable: true,
      photo_url: 'http://localhost:9000/nagarnetra-persons/persons/p/reference.jpg?X-Amz-Signature=a',
      photo_purged: false,
      enrol_quality: { face_px: 110 },
      embedding_model: 'sface_2021dec',
      enrolled_by: 'u-sup',
      enrolled_by_username: 'supervisor',
      enrolled_at: '2026-10-12T01:00:00Z',
      approved_by_username: 'admin',
      approved_at: '2026-10-12T01:01:00Z',
      rejected_by_username: null,
      rejected_at: null,
      rejection_reason: null,
      retired_by_username: null,
      retired_at: null,
      retired_reason: null,
      can_review: false,
    },
    face_url: 'http://localhost:9000/nagarnetra-persons/faces/2026/10/12/CAM-DEMO-02/x.jpg?X-Amz-Signature=b',
    face_purged: false,
    similarity: 0.73,
    threshold: 0.45,
    model_threshold: 0.363,
    frames_agreed: 3,
    frames_required: 2,
    captured_at: '2026-10-12T01:31:05Z',
    camera_id: 'cam-1',
    notice: 'A possible match, not an identification. A person must compare the two faces before anyone acts.',
  }

  beforeEach(() => {
    auth.permissions = new Set([...EVERYTHING, PERMISSIONS.personRead])
    stream.alerts = []
    vi.spyOn(api, 'getAlerts').mockResolvedValue(page([MATCH]))
    vi.spyOn(api, 'getCameras').mockResolvedValue({
      items: [camera('cam-1', 'CAM-DEMO-02')],
      total: 1,
      limit: 500,
      offset: 0,
    } as CameraPage)
    vi.spyOn(api, 'getWatchlist').mockResolvedValue([])
    vi.spyOn(api, 'getAlert').mockRejectedValue(new Error('No such alert'))
    vi.spyOn(api, 'getPersonMatch').mockResolvedValue(EVIDENCE)
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('is called a possible person match and has a lane of its own', () => {
    expect(alarmTitle({ alert_type: 'person_match', camera_id: 'cam-1' })).toBe('Possible person match')
    expect(alarmKind('person_match')).toBe('person')
  })

  it('is left out of the default queue and shown under Persons', async () => {
    vi.spyOn(api, 'getAlerts').mockResolvedValue(page([HIT, MATCH]))
    renderAt('/alerts')
    await waitFor(() => expect(within(queue()).getAllByText('Watched vehicle read').length).toBe(1))
    expect(within(queue()).queryByText('Possible person match')).toBeNull()
    fireEvent.click(within(queue()).getByRole('radio', { name: /Persons/ }))
    await waitFor(() => expect(within(queue()).getAllByText('Possible person match').length).toBe(1))
    expect(within(queue()).queryByText('Watched vehicle read')).toBeNull()
  })

  it('opens the persons lane from ?kind=persons', async () => {
    vi.spyOn(api, 'getAlerts').mockResolvedValue(page([HIT, MATCH]))
    renderAt('/alerts?kind=persons')
    await waitFor(() => expect(within(queue()).getAllByText('Possible person match').length).toBe(1))
    expect(within(queue()).queryByText('Watched vehicle read')).toBeNull()
  })

  it('filters by kind with face matches only in their own lane', () => {
    const all = [HIT, MATCH, CAMERA_DOWN]
    expect(filterByKind(all, 'all').map((a) => a.id)).toEqual(['alarm-hit', 'alarm-camera'])
    expect(filterByKind(all, 'person').map((a) => a.id)).toEqual(['alarm-person'])
    expect(parseKind('persons')).toBe('person')
    expect(parseKind(null)).toBe('all')
  })

  it('shows the enrolled face and the captured face side by side, with the rule above them', async () => {
    renderAt('/alerts?alert=alarm-person')
    await waitFor(async () => expect((await shownTitle()).textContent).toBe('Possible person match'))
    expect(screen.getByRole('note').textContent).toContain(
      'A person must confirm this match before anyone acts.',
    )
    const reference = (await screen.findByAltText('Enrolled reference')) as HTMLImageElement
    const captured = screen.getByAltText('Captured by the camera') as HTMLImageElement
    expect(reference.src).toContain('reference.jpg')
    expect(captured.src).toContain('/faces/')
    expect(api.getPersonMatch).toHaveBeenCalledWith('alarm-person')
    // The score is a similarity against a threshold, never a percentage.
    expect(screen.getAllByText('0.73').length).toBeGreaterThan(0)
    expect(screen.queryByText(/73%/)).toBeNull()
    expect(screen.getByText('Demo subject — stock footage')).toBeTruthy()
    expect(screen.getByText('Face similarity', { selector: 'span' })).toBeTruthy()
    expect(screen.getByText(/Compare the two faces yourself/)).toBeTruthy()
  })

  it('reads the evidence once per alarm opened, not on every refresh', async () => {
    renderAt('/alerts?alert=alarm-person')
    await screen.findByAltText('Enrolled reference')
    expect(api.getPersonMatch).toHaveBeenCalledTimes(1)
  })

  it('shows a role without person.read the alarm but never the faces', async () => {
    auth.permissions = new Set(EVERYTHING)
    renderAt('/alerts?alert=alarm-person')
    await waitFor(async () => expect((await shownTitle()).textContent).toBe('Possible person match'))
    expect(screen.getAllByText(/person\.read/).length).toBeGreaterThan(0)
    expect(screen.queryByAltText('Enrolled reference')).toBeNull()
    expect(api.getPersonMatch).not.toHaveBeenCalled()
  })
})
