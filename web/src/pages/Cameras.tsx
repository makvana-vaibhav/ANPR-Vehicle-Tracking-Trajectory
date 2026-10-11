/**
 * Network · Cameras — the registry: every camera, where its pictures come
 * from, whether anyone knows where it stands, and the forms that onboard,
 * amend and retire them.
 *
 * This replaced a read-only "Integration layer" screen that listed the
 * federated VMS instances and the adapters reaching them. It was accurate and
 * it was useless: it told an operator what the platform *could* integrate
 * without letting them integrate anything. The federation evidence is still
 * here, at the bottom, where it costs a strip of screen rather than a tab.
 *
 * Looking at the fleet is the common act and onboarding the rare one, so the
 * page opens on the table and the forms slide over it. CSV import sits beside
 * the single-camera form because a city onboards estates, not cameras — but a
 * person adding one camera should not have to build a spreadsheet to do it.
 *
 * The form asks for a stream URL and says why: a camera without one is a
 * registry record that can never be watched or analysed. That is a legitimate
 * thing to record, and it should be a decision rather than an accident — the
 * registry used to hold 250 of them by default.
 *
 * `?camera=<CODE>` opens that camera's detail beside the table (the search
 * palette links here) and `?filter=unplaced` shows only the cameras with no
 * known position. Both follow the screen, so the address bar is always a link
 * to what is on it. Nothing is opened by default.
 */

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from 'react'
import { useSearchParams } from 'react-router-dom'

import CameraPanel from '@/components/CameraPanel'
import { SkeletonRows } from '@/components/Skeleton'
import { useToast } from '@/components/Toast'
import {
  amendment,
  countByStatus,
  departmentOptions,
  fetchAllCameras,
  filterCameras,
  findCamera,
  isFiltered,
  NO_FILTER,
  placeLine,
  positionKind,
  readCameraParam,
  readPositionFilter,
  SOURCE_LABEL,
  sourceKind,
  STATUS_LABEL,
  STATUS_ORDER,
  tagsAfterPlacing,
  UNASSIGNED,
  vendorWords,
  withParams,
  type CameraFilter,
  type PositionFilter,
  type SourceKind,
} from '@/components/network/cameraFacts'
import { NoPositionGlyph } from '@/components/network/PlaceDot'
import {
  Badge,
  Button,
  Checkbox,
  Drawer,
  EmptyState,
  ErrorBanner,
  Field,
  Icon,
  InfoHint,
  Input,
  PageHeader,
  Panel,
  SectionLabel,
  SegmentedControl,
  Select,
  StatTile,
  StatusBadge,
  Table,
  Td,
  Th,
  Thead,
  Toolbar,
  ToolbarField,
  Tr,
} from '@/components/ui'
import { useAuth } from '@/hooks/useAuth'
import * as api from '@/lib/api'
import { PERMISSIONS } from '@/lib/permissions'
import { isUnplaced } from '@/lib/places'
import type { Camera, Department, VmsInstance } from '@/lib/types'

/** Which slide-over is open, if any. */
type Drawered = 'none' | 'camera' | 'import'

/** Rows per page. The table pages rather than growing without bound. */
const PAGE_SIZE = 50

/** Gujarat's bounding box, mirroring the server-side validator. Checked here
 *  too so a typo is caught while the operator is still looking at the field,
 *  rather than as a 422 after they press the button. */
const BOUNDS = { latMin: 20.0, latMax: 24.8, lonMin: 68.1, lonMax: 74.5 }

/** The values `Protocol` in app/models/enums.py actually accepts.
 *
 * This list previously read `['rtsp', 'http', 'hls', 'onvif']`. Two of those
 * are not members of the enum, so choosing either produced a 422 on save with
 * no hint that the dropdown had offered an impossible option. `http`/`hls`
 * describe how the *browser* is served video, which is the gateway's business
 * and never a property of the upstream camera. */
const PROTOCOLS = ['rtsp', 'onvif', 'vendor_api'] as const

const SOURCE_TONE: Record<SourceKind, 'neutral' | 'warning' | 'danger'> = {
  grid: 'neutral',
  stream: 'neutral',
  // A replayed clip is not a camera; it must never pass for one.
  recorded: 'warning',
  none: 'danger',
}

const EMPTY = {
  camera_code: '',
  name: '',
  lat: '',
  lon: '',
  district: '',
  city: '',
  junction: '',
  department_code: '',
  heading_deg: '',
  camera_type: 'fixed',
  protocol: 'rtsp',
  stream_url: '',
  /** 'live' → pull an RTSP/ONVIF URL. 'recorded' → replay a clip from the
   *  video directory. One camera, two ways to give it pictures. */
  source_kind: 'live' as 'live' | 'recorded',
  source_file: '',
  resolution: '1920x1080',
  fps: '15',
  anpr_enabled: true,
}

type Form = typeof EMPTY
type LocalFilter = Omit<CameraFilter, 'position'>

export default function Cameras() {
  const toast = useToast()
  const { can } = useAuth()
  const mayCreate = can(PERMISSIONS.cameraCreate)
  const mayUpdate = can(PERMISSIONS.cameraUpdate)
  const mayDelete = can(PERMISSIONS.cameraDelete)

  const [params, setParams] = useSearchParams()
  const cameraCode = readCameraParam(params)
  const position = readPositionFilter(params)

  const [drawer, setDrawer] = useState<Drawered>('none')
  const [cameras, setCameras] = useState<Camera[]>([])
  const [departments, setDepartments] = useState<Department[]>([])
  const [vms, setVms] = useState<VmsInstance[]>([])
  const [adapters, setAdapters] = useState<Record<string, string>>({})
  const [sourceVideos, setSourceVideos] = useState<api.SourceVideo[]>([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [form, setForm] = useState<Form>({ ...EMPTY })
  const [editing, setEditing] = useState<Camera | null>(null)
  const [filter, setFilter] = useState<LocalFilter>(NO_FILTER)
  const [page, setPage] = useState(0)

  const load = useCallback(async () => {
    try {
      const [fleet, depts, instances, adapterInfo, clips] = await Promise.all([
        fetchAllCameras(),
        api.getDepartments(),
        api.getVmsInstances(),
        api.getAdapters(),
        // An empty list is a legitimate answer — no footage on this machine —
        // so a failure here must not take the whole page down with it. The
        // form falls back to the live-URL path, which is all it ever had.
        api.getSourceVideos().catch(() => [] as api.SourceVideo[]),
      ])
      setCameras(fleet)
      setDepartments(depts)
      setVms(instances)
      setAdapters(adapterInfo.adapters)
      setSourceVideos(clips)
      setLoadError(null)
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  // ── URL state ────────────────────────────────────────────────────────
  const setCameraParam = useCallback(
    (code: string | null) => {
      setParams((prev) => withParams(prev, { camera: code }), { replace: true })
    },
    [setParams],
  )
  const setPosition = useCallback(
    (value: PositionFilter) => {
      setParams((prev) => withParams(prev, { filter: value || null }), { replace: true })
    },
    [setParams],
  )

  // ── What is shown ────────────────────────────────────────────────────
  const fullFilter = useMemo<CameraFilter>(() => ({ ...filter, position }), [filter, position])
  const shown = useMemo(() => filterCameras(cameras, fullFilter), [cameras, fullFilter])
  const counts = useMemo(() => countByStatus(cameras), [cameras])
  const unplacedCount = useMemo(() => cameras.filter((c) => isUnplaced(c)).length, [cameras])
  const sourceCounts = useMemo(() => {
    const out: Record<SourceKind, number> = { grid: 0, recorded: 0, stream: 0, none: 0 }
    for (const camera of cameras) out[sourceKind(camera)] += 1
    return out
  }, [cameras])
  const { departments: ownedBy, unassigned } = useMemo(() => departmentOptions(cameras), [cameras])
  const selected = findCamera(cameras, cameraCode)

  const pageCount = Math.max(1, Math.ceil(shown.length / PAGE_SIZE))
  const safePage = Math.min(page, pageCount - 1)
  const visible = shown.slice(safePage * PAGE_SIZE, safePage * PAGE_SIZE + PAGE_SIZE)

  useEffect(() => {
    setPage(0)
  }, [fullFilter])

  // A camera opened by a link is brought into view once, on the page it is on.
  const tableRef = useRef<HTMLDivElement>(null)
  const revealed = useRef<string | null>(null)
  useEffect(() => {
    if (!selected) {
      revealed.current = null
      return
    }
    if (revealed.current === selected.id) return
    revealed.current = selected.id
    const index = shown.findIndex((c) => c.id === selected.id)
    if (index < 0) return
    setPage(Math.floor(index / PAGE_SIZE))
    window.requestAnimationFrame(() => {
      const rows = tableRef.current?.querySelectorAll<HTMLElement>('[data-camera]') ?? []
      for (const row of rows) {
        if (row.dataset.camera === selected.camera_code) row.scrollIntoView?.({ block: 'nearest' })
      }
    })
  }, [selected, shown])

  // ── Forms ────────────────────────────────────────────────────────────
  const set = (key: keyof Form, value: string | boolean) =>
    setForm((current) => ({ ...current, [key]: value }))

  function startCreate() {
    setEditing(null)
    setForm({ ...EMPTY })
    setDrawer('camera')
  }

  function startEdit(camera: Camera) {
    const unknown = isUnplaced(camera)
    setEditing(camera)
    setForm({
      camera_code: camera.camera_code,
      name: camera.name,
      // A camera with no known position sits at a placeholder; showing those
      // numbers would invite saving them back as if they were a position.
      lat: unknown ? '' : String(camera.lat),
      lon: unknown ? '' : String(camera.lon),
      district: camera.district ?? '',
      city: camera.city ?? '',
      junction: camera.junction ?? '',
      department_code: camera.department_code ?? '',
      heading_deg: camera.heading_deg == null ? '' : String(camera.heading_deg),
      camera_type: camera.camera_type ?? '',
      protocol: camera.protocol ?? '',
      // Blank, always. The API never returns the URL — see Camera.has_stream —
      // so anything shown here would be an invention. Left empty it means
      // "keep whatever is configured".
      stream_url: '',
      // `source_file` *is* returned, so unlike the URL this can be shown and
      // edited truthfully, and a camera already replaying a clip opens on the
      // recorded tab with that clip selected.
      source_kind: camera.source_file ? 'recorded' : 'live',
      source_file: camera.source_file ?? '',
      resolution: camera.resolution ?? '',
      fps: camera.fps == null ? '' : String(camera.fps),
      anpr_enabled: camera.anpr_enabled,
    })
    setDrawer('camera')
  }

  const closeForm = useCallback(() => {
    setEditing(null)
    setForm({ ...EMPTY })
    setDrawer('none')
  }, [])

  async function submit(event: FormEvent) {
    event.preventDefault()
    const latText = form.lat.trim()
    const lonText = form.lon.trim()
    const keepUnplaced = editing !== null && isUnplaced(editing) && !latText && !lonText

    let coords: { lat: number; lon: number } | null = null
    if (!keepUnplaced) {
      const lat = Number(latText)
      const lon = Number(lonText)
      if (!latText || !lonText || !Number.isFinite(lat) || !Number.isFinite(lon)) {
        toast.error(
          editing && isUnplaced(editing)
            ? 'Enter both latitude and longitude to place this camera, or leave both blank'
            : 'Latitude and longitude are required',
        )
        return
      }
      if (lat < BOUNDS.latMin || lat > BOUNDS.latMax || lon < BOUNDS.lonMin || lon > BOUNDS.lonMax) {
        toast.error(`(${lat}, ${lon}) is outside Gujarat. Check the values are not swapped.`)
        return
      }
      coords = { lat, lon }
    }

    const recorded = form.source_kind === 'recorded'
    if (recorded && !form.source_file) {
      toast.error('Choose a recorded clip, or switch back to a live stream URL')
      return
    }

    const body: Partial<api.CameraInput> = {
      name: form.name.trim(),
      district: form.district.trim() || null,
      city: form.city.trim() || null,
      junction: form.junction.trim() || null,
      department_code: form.department_code || null,
      heading_deg: form.heading_deg === '' ? null : Number(form.heading_deg),
      camera_type: form.camera_type || null,
      protocol: form.protocol || null,
      // The two source kinds are exclusive in the form: picking a recorded
      // clip clears the URL and vice versa, so a camera cannot end up with a
      // live URL and a clip both claiming to be its pictures.
      stream_url: recorded ? null : form.stream_url.trim() || null,
      source_file: recorded ? form.source_file || null : null,
      resolution: form.resolution.trim() || null,
      fps: form.fps === '' ? null : Number(form.fps),
      anpr_enabled: form.anpr_enabled,
      ...(coords ?? {}),
    }

    setBusy(true)
    try {
      if (editing) {
        // An empty field means "leave the configured source alone", not
        // "clear it" — the form cannot show the current URL, so blank cannot
        // mean delete without silently disconnecting cameras on every edit.
        if (!form.stream_url.trim()) delete body.stream_url
        const changes = amendment(editing, body)
        if (changes.lat !== undefined) {
          // Typed-in coordinates answer what the grid's placement tag
          // recorded as unknown; a stale tag would keep the camera off the
          // map, or pinned to its town's centre, after it was placed.
          const tags = tagsAfterPlacing(editing.tags)
          if (tags && tags.length !== (editing.tags ?? []).length) changes.tags = tags
        }
        if (Object.keys(changes).length === 0) {
          toast.info('Nothing changed')
          closeForm()
          return
        }
        // camera_code is the estate-wide identity and never sent on an edit:
        // renaming it would detach every detection recorded against it.
        await api.updateCamera(editing.id, changes)
        toast.success(`${editing.camera_code} updated`)
      } else {
        const created: api.CameraInput = {
          ...(body as api.CameraInput),
          camera_code: form.camera_code.trim().toUpperCase(),
          name: form.name.trim(),
          lat: coords?.lat ?? 0,
          lon: coords?.lon ?? 0,
          anpr_enabled: form.anpr_enabled,
        }
        await api.createCamera(created)
        toast.success(
          created.anpr_enabled && (created.stream_url || created.source_file)
            ? `${created.camera_code} onboarded — plate reading starts within a minute`
            : `${created.camera_code} onboarded as a registry record (no stream)`,
        )
      }
      closeForm()
      await load()
    } catch (err) {
      toast.error(err)
    } finally {
      setBusy(false)
    }
  }

  async function remove(camera: Camera) {
    if (
      !window.confirm(
        `Remove ${camera.camera_code} from the registry?\n\n` +
          'Its recorded detections stay, but stop being attributable to a camera.',
      )
    ) {
      return
    }
    try {
      await api.deleteCamera(camera.id)
      toast.success(`${camera.camera_code} removed`)
      if (selected?.id === camera.id) setCameraParam(null)
      await load()
    } catch (err) {
      toast.error(err)
    }
  }

  const setLocal = <K extends keyof LocalFilter>(key: K, value: LocalFilter[K]) =>
    setFilter((current) => ({ ...current, [key]: value }))
  const filtered = isFiltered(fullFilter)
  // With a camera open the table shares the screen with its panel, which
  // carries Edit, Remove and plate reading itself; the table gives up those
  // columns rather than squeezing every other one.
  const compact = Boolean(cameraCode)
  const showActions = (mayUpdate || mayDelete) && !compact
  const editingUnplaced = editing !== null && isUnplaced(editing)

  return (
    <div className="flex min-h-0 flex-1">
      <div className="flex min-w-0 flex-1 flex-col">
        {/* ── Header and filters ─────────────────────────────────── */}
        <div className="shrink-0 space-y-4 px-6 pb-4 pt-5">
          <PageHeader
            title="Cameras"
            subtitle={
              <>
                <span>{cameras.length} registered</span>
                <span className="text-faint">·</span>
                <span>{cameras.filter((c) => c.anpr_enabled).length} enabled for plates</span>
                {unplacedCount > 0 && (
                  <>
                    <span className="text-faint">·</span>
                    <button
                      type="button"
                      onClick={() => setPosition('unplaced')}
                      className="text-priority-high hover:underline"
                    >
                      {unplacedCount} without a position
                    </button>
                  </>
                )}
                <InfoHint label="What onboarding a camera does">
                  A camera appears on the map, starts being health-probed, and joins the plate
                  reading fleet if it has a video source and analysis is enabled. A registry
                  record without a source can never be watched or analysed — a legitimate thing
                  to record, but it should be a decision rather than an accident.
                </InfoHint>
              </>
            }
            actions={
              mayCreate && (
                <>
                  <Button variant="outline" onClick={() => setDrawer('import')}>
                    <Icon name="download" size={14} className="rotate-180" />
                    Import CSV
                  </Button>
                  <Button onClick={startCreate}>
                    <Icon name="plus" size={14} />
                    Onboard camera
                  </Button>
                </>
              )
            }
          />

          <Toolbar>
            <ToolbarField label="Search">
              <div className="w-52">
                <Input
                  value={filter.search}
                  onChange={(e) => setLocal('search', e.target.value)}
                  placeholder="Code, name or town"
                  aria-label="Filter cameras"
                />
              </div>
            </ToolbarField>
            <FilterGroup label="Status">
              <SegmentedControl
                value={filter.status}
                onChange={(v) => setLocal('status', v)}
                options={[
                  { value: '' as const, label: 'All' },
                  ...STATUS_ORDER.map((status) => ({
                    value: status,
                    label: `${status === 'unknown' ? 'Unknown' : STATUS_LABEL[status]} ${counts[status]}`,
                    title: STATUS_LABEL[status],
                  })),
                ]}
              />
            </FilterGroup>
            <FilterGroup label="Source">
              <SegmentedControl
                value={filter.source}
                onChange={(v) => setLocal('source', v)}
                options={[
                  { value: '' as const, label: 'All' },
                  ...(['grid', 'recorded', 'stream', 'none'] as SourceKind[])
                    .filter((kind) => sourceCounts[kind] > 0 || filter.source === kind)
                    .map((kind) => ({ value: kind, label: `${SOURCE_LABEL[kind]} ${sourceCounts[kind]}` })),
                ]}
              />
            </FilterGroup>
            <FilterGroup label="Position">
              <SegmentedControl
                value={position}
                onChange={setPosition}
                options={[
                  { value: '' as const, label: 'All' },
                  { value: 'placed' as const, label: `Placed ${cameras.length - unplacedCount}` },
                  { value: 'unplaced' as const, label: `Without a position ${unplacedCount}` },
                ]}
              />
            </FilterGroup>
            <ToolbarField label="Department">
              <div className="w-44">
                <Select
                  value={filter.department}
                  onChange={(e) => setLocal('department', e.target.value)}
                >
                  <option value="">All departments</option>
                  {ownedBy.map((d) => (
                    <option key={d.code} value={d.code}>
                      {d.code} ({d.count})
                    </option>
                  ))}
                  {unassigned > 0 && <option value={UNASSIGNED}>Unassigned ({unassigned})</option>}
                </Select>
              </div>
            </ToolbarField>
            {filtered && (
              <Button
                variant="ghost"
                size="sm"
                className="mb-0.5"
                onClick={() => {
                  setFilter(NO_FILTER)
                  setPosition('')
                }}
              >
                <Icon name="close" size={12} />
                Clear
              </Button>
            )}
          </Toolbar>
        </div>

        {/* ── The fleet ───────────────────────────────────────────── */}
        <div ref={tableRef} className="min-h-0 flex-1 space-y-4 overflow-y-auto px-6 pb-6">
          {loadError && <ErrorBanner>{loadError}</ErrorBanner>}

          {position === 'unplaced' && unplacedCount > 0 && (
            <div className="flex items-start gap-3 rounded-lg border border-priority-high/30 bg-priority-high/[0.06] px-4 py-3">
              <NoPositionGlyph className="mt-1" />
              <div className="text-xs leading-relaxed text-muted-foreground">
                <p className="text-[13px] font-medium text-foreground">
                  {unplacedCount} camera{unplacedCount === 1 ? ' has' : 's have'} no known position
                </p>
                <p className="mt-0.5">
                  The organisers’ grid publishes them without a town, so the map lists them beside
                  it rather than drawing them anywhere.
                  {mayUpdate && ' Edit one and enter its latitude and longitude to place it.'}
                </p>
              </div>
            </div>
          )}

          {loading ? (
            <SkeletonRows rows={8} height="h-10" />
          ) : shown.length === 0 ? (
            <EmptyState
              title={filtered ? 'No camera matches these filters.' : 'No cameras registered.'}
              hint={
                filtered
                  ? 'Clear a filter to widen the list.'
                  : mayCreate
                    ? 'Onboard one, or import an estate from CSV.'
                    : undefined
              }
            />
          ) : (
            <>
              <Table>
                <Thead>
                  <tr>
                    <Th>Code</Th>
                    <Th>Camera</Th>
                    <Th>Status</Th>
                    <Th>Source</Th>
                    <Th>Position</Th>
                    {!compact && <Th className="text-right">Plates</Th>}
                    {showActions && (
                      <Th>
                        <span className="sr-only">Actions</span>
                      </Th>
                    )}
                  </tr>
                </Thead>
                <tbody>
                  {visible.map((camera) => {
                    const isSelected = selected?.id === camera.id
                    const where = placeLine(camera)
                    return (
                      <Tr
                        key={camera.id}
                        data-camera={camera.camera_code}
                        aria-selected={isSelected}
                        tabIndex={0}
                        onClick={() => setCameraParam(isSelected ? null : camera.camera_code)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') setCameraParam(camera.camera_code)
                        }}
                        className={`cursor-pointer outline-none focus-visible:bg-secondary/40 ${
                          isSelected
                            ? 'bg-primary/[0.07] shadow-[inset_2px_0_0_hsl(var(--primary))] hover:bg-primary/[0.09]'
                            : ''
                        }`}
                      >
                        <Td className="whitespace-nowrap font-mono text-xs tracking-wide">
                          {camera.camera_code}
                        </Td>
                        <Td>
                          <p className={`truncate ${compact ? 'max-w-[14rem]' : 'max-w-[20rem]'}`}>
                            {camera.name}
                          </p>
                          {where && (
                            <p
                              className={`truncate text-[11px] text-faint ${compact ? 'max-w-[14rem]' : 'max-w-[20rem]'}`}
                            >
                              {where}
                            </p>
                          )}
                        </Td>
                        <Td className="whitespace-nowrap">
                          <StatusBadge status={camera.status} label={STATUS_LABEL[camera.status]} />
                        </Td>
                        <Td className="whitespace-nowrap">
                          <Badge tone={SOURCE_TONE[sourceKind(camera)]}>
                            {SOURCE_LABEL[sourceKind(camera)]}
                          </Badge>
                        </Td>
                        <Td className="whitespace-nowrap">
                          <PositionCell camera={camera} />
                        </Td>
                        {!compact && (
                          <Td className="text-right text-xs">
                            {camera.anpr_enabled ? (
                              <span className="text-muted-foreground">On</span>
                            ) : (
                              <span className="text-faint">Off</span>
                            )}
                          </Td>
                        )}
                        {showActions && (
                          <Td className="text-right">
                            <span className="flex justify-end gap-1">
                              {mayUpdate && (
                                <Button
                                  variant="ghost"
                                  size="sm"
                                  onClick={(e) => {
                                    e.stopPropagation()
                                    startEdit(camera)
                                  }}
                                >
                                  Edit
                                </Button>
                              )}
                              {mayDelete && (
                                <Button
                                  variant="ghost"
                                  size="sm"
                                  className="hover:text-status-offline"
                                  onClick={(e) => {
                                    e.stopPropagation()
                                    void remove(camera)
                                  }}
                                >
                                  Remove
                                </Button>
                              )}
                            </span>
                          </Td>
                        )}
                      </Tr>
                    )
                  })}
                </tbody>
              </Table>

              <div className="flex items-center justify-between gap-3 text-xs text-faint">
                <span>
                  {safePage * PAGE_SIZE + 1}–{Math.min(shown.length, (safePage + 1) * PAGE_SIZE)} of{' '}
                  {shown.length}
                  {filtered && ` · ${cameras.length} registered`}
                </span>
                {pageCount > 1 && (
                  <span className="flex items-center gap-1.5">
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={safePage === 0}
                      onClick={() => setPage(safePage - 1)}
                    >
                      <Icon name="chevronLeft" size={13} />
                      Previous
                    </Button>
                    <span className="font-mono">
                      {safePage + 1}/{pageCount}
                    </span>
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={safePage >= pageCount - 1}
                      onClick={() => setPage(safePage + 1)}
                    >
                      Next
                      <Icon name="chevronRight" size={13} />
                    </Button>
                  </span>
                )}
              </div>
            </>
          )}

          <FederationStrip vms={vms} adapters={adapters} />
        </div>
      </div>

      {/* ── One camera ────────────────────────────────────────────── */}
      {cameraCode && !loading && (
        <aside
          aria-label="Camera details"
          className="flex w-[24rem] shrink-0 flex-col border-l border-border bg-chrome"
        >
          {selected ? (
            <CameraPanel
              key={selected.id}
              camera={selected}
              context="registry"
              onClose={() => setCameraParam(null)}
              onRefresh={() => void load()}
              onEdit={mayUpdate ? () => startEdit(selected) : undefined}
              onRemove={mayDelete ? () => void remove(selected) : undefined}
            />
          ) : (
            <div className="p-4">
              <EmptyState
                title={`No camera ${cameraCode} in the registry.`}
                hint="It may have been removed, or the link mistyped."
              />
              <Button variant="outline" size="sm" className="mt-3" onClick={() => setCameraParam(null)}>
                Close
              </Button>
            </div>
          )}
        </aside>
      )}

      {/* ── Onboarding / amendment ────────────────────────────────── */}
      <Drawer
        open={drawer === 'camera'}
        onClose={closeForm}
        title={editing ? `Amend ${editing.camera_code}` : 'Onboard a camera'}
        description={
          editing
            ? 'The camera code is the estate-wide identity and cannot be changed.'
            : 'A code, a name, a position and a video source.'
        }
      >
        {(editing ? mayUpdate : mayCreate) && (
          <form onSubmit={submit} className="space-y-5">
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Camera code" hint="Unique, estate-wide">
                <Input
                  required
                  disabled={Boolean(editing)}
                  value={form.camera_code}
                  onChange={(e) => set('camera_code', e.target.value.toUpperCase())}
                  placeholder="CAM-00301"
                  className="font-mono"
                />
              </Field>
              <Field label="Name" hint="What an operator will recognise">
                <Input
                  required
                  value={form.name}
                  onChange={(e) => set('name', e.target.value)}
                  placeholder="Kalawad Road Junction"
                />
              </Field>
            </div>

            <div>
              <SectionLabel>Position</SectionLabel>
              {editingUnplaced && (
                <p className="mt-1.5 text-xs leading-relaxed text-priority-high">
                  No position on record. Enter one to place this camera on the map, or leave both
                  blank to keep it listed without one.
                </p>
              )}
              <div className="mt-2 grid gap-3 sm:grid-cols-2">
                <Field label="Latitude" hint={`${BOUNDS.latMin} – ${BOUNDS.latMax}`}>
                  <Input
                    required={!editingUnplaced}
                    type="number"
                    step="any"
                    value={form.lat}
                    onChange={(e) => set('lat', e.target.value)}
                    placeholder={editingUnplaced ? 'Not known' : '22.2863'}
                    className="font-mono"
                  />
                </Field>
                <Field label="Longitude" hint={`${BOUNDS.lonMin} – ${BOUNDS.lonMax}`}>
                  <Input
                    required={!editingUnplaced}
                    type="number"
                    step="any"
                    value={form.lon}
                    onChange={(e) => set('lon', e.target.value)}
                    placeholder={editingUnplaced ? 'Not known' : '70.7728'}
                    className="font-mono"
                  />
                </Field>
                <Field label="District">
                  <Input
                    value={form.district}
                    onChange={(e) => set('district', e.target.value)}
                    placeholder="Rajkot"
                  />
                </Field>
                <Field label="City">
                  <Input
                    value={form.city}
                    onChange={(e) => set('city', e.target.value)}
                    placeholder="Rajkot"
                  />
                </Field>
                <Field label="Junction">
                  <Input
                    value={form.junction}
                    onChange={(e) => set('junction', e.target.value)}
                    placeholder="Kalawad Road @ KKV Chowk"
                  />
                </Field>
                <Field
                  label="Heading"
                  hint="Degrees the camera faces; used to reject impossible route hops"
                >
                  <Input
                    type="number"
                    min={0}
                    max={359}
                    value={form.heading_deg}
                    onChange={(e) => set('heading_deg', e.target.value)}
                    placeholder="90"
                  />
                </Field>
              </div>
            </div>

            {/* Where this camera's pictures come from. A live URL is the
                real-deployment path; a recorded clip is how footage shot on
                a phone becomes a camera without editing .env and restarting
                a container. */}
            <div>
              <SectionLabel>Video source</SectionLabel>
              <div className="mt-2 space-y-3">
                <SegmentedControl
                  className="w-fit"
                  value={form.source_kind}
                  onChange={(v) => set('source_kind', v)}
                  options={[
                    { value: 'live', label: 'Live stream URL' },
                    { value: 'recorded', label: 'Recorded video' },
                  ]}
                />
                {form.source_kind === 'live' ? (
                  <Field
                    label="Stream URL"
                    hint={
                      editing
                        ? editing.has_stream
                          ? 'A source is configured. Leave blank to keep it, or type a new one to replace it — the existing URL is never sent to the browser.'
                          : 'This camera has no source, so it can never be watched or analysed. Add one here.'
                        : 'RTSP or ONVIF. Without one the camera is a registry record that can never be watched or analysed.'
                    }
                  >
                    <Input
                      value={form.stream_url}
                      onChange={(e) => set('stream_url', e.target.value)}
                      placeholder="rtsp://10.0.0.24:554/Streaming/Channels/101"
                      className="font-mono text-xs"
                    />
                  </Field>
                ) : (
                  <Field
                    label="Recorded clip"
                    hint={
                      sourceVideos.length === 0
                        ? 'No clips found in the video directory. Drop an .mp4 into data/videos/ and reopen this form.'
                        : 'Replayed on a loop as this camera’s feed. Copy the file into data/videos/ and it appears here.'
                    }
                  >
                    <Select
                      value={form.source_file}
                      onChange={(e) => set('source_file', e.target.value)}
                      disabled={sourceVideos.length === 0}
                    >
                      <option value="">Select a clip…</option>
                      {sourceVideos.map((v) => (
                        <option key={v.filename} value={v.filename}>
                          {v.filename} ({api.formatBytes(v.size_bytes)})
                        </option>
                      ))}
                    </Select>
                  </Field>
                )}
              </div>
            </div>

            <div>
              <SectionLabel>Ownership and hardware</SectionLabel>
              <div className="mt-2 grid gap-3 sm:grid-cols-2">
                <Field label="Department">
                  <Select
                    value={form.department_code}
                    onChange={(e) => set('department_code', e.target.value)}
                  >
                    <option value="">Unassigned</option>
                    {departments.map((d) => (
                      <option key={d.code} value={d.code}>
                        {d.name}
                      </option>
                    ))}
                  </Select>
                </Field>
                <Field label="Type">
                  <Select
                    value={form.camera_type}
                    onChange={(e) => set('camera_type', e.target.value)}
                  >
                    {form.camera_type === '' && <option value="">Not recorded</option>}
                    {['fixed', 'ptz', 'anpr', 'dome', 'thermal'].map((t) => (
                      <option key={t} value={t}>
                        {t}
                      </option>
                    ))}
                  </Select>
                </Field>
                <Field label="Protocol">
                  <Select value={form.protocol} onChange={(e) => set('protocol', e.target.value)}>
                    {form.protocol === '' && <option value="">Not recorded</option>}
                    {PROTOCOLS.map((p) => (
                      <option key={p} value={p}>
                        {p}
                      </option>
                    ))}
                  </Select>
                </Field>
                <Field label="Resolution">
                  <Input
                    value={form.resolution}
                    onChange={(e) => set('resolution', e.target.value)}
                    placeholder="1920x1080"
                  />
                </Field>
                <Field label="Frame rate">
                  <Input
                    type="number"
                    min={1}
                    max={120}
                    value={form.fps}
                    onChange={(e) => set('fps', e.target.value)}
                    placeholder="15"
                  />
                </Field>
              </div>
            </div>

            <Checkbox
              checked={form.anpr_enabled}
              onChange={(e) => set('anpr_enabled', e.target.checked)}
              label={
                <>
                  Analyse this camera for number plates{' '}
                  <span className="text-xs text-muted-foreground">
                    — the worker picks it up on its next discovery pass
                  </span>
                </>
              }
            />

            <div className="flex items-center gap-2 border-t border-border pt-4">
              <Button type="submit" disabled={busy}>
                {busy ? 'Saving…' : editing ? 'Save changes' : 'Onboard camera'}
              </Button>
              <Button variant="ghost" onClick={closeForm}>
                Cancel
              </Button>
            </div>
          </form>
        )}
      </Drawer>

      {/* ── Bulk onboarding ──────────────────────────────────────── */}
      <Drawer
        open={drawer === 'import'}
        onClose={() => setDrawer('none')}
        title="Onboard an estate from CSV"
        description="Validated first. Nothing is written until you say so."
      >
        <CsvImport
          allowed={mayCreate}
          onDone={async () => {
            await load()
            setDrawer('none')
          }}
        />
      </Drawer>
    </div>
  )
}

/**
 * A captioned row of segmented choices.
 *
 * Not a ToolbarField: that wraps its control in a <label>, and a label around
 * a segmented control names only the first segment — which then also catches
 * every click on the caption, silently resetting the filter. A group with an
 * accessible name is what a set of choices is.
 */
function FilterGroup({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div role="group" aria-label={label}>
      <span className="block text-[11px] font-medium uppercase tracking-[0.06em] text-muted-foreground">
        {label}
      </span>
      <div className="mt-1">{children}</div>
    </div>
  )
}

function PositionCell({ camera }: { camera: Camera }) {
  const kind = positionKind(camera)
  if (kind === 'unknown') return <Badge tone="warning">Not known</Badge>
  if (kind === 'town') {
    return (
      <span className="text-xs text-muted-foreground" title="The grid gives the town, not the junction">
        Town centre
      </span>
    )
  }
  return (
    <span className="coord whitespace-nowrap text-[11px] text-faint">
      {camera.lat.toFixed(4)}, {camera.lon.toFixed(4)}
    </span>
  )
}

/**
 * CSV onboarding.
 *
 * Validate-first is the default, and deliberately: a file of four thousand
 * cameras is not something an operator should commit to before seeing what it
 * will do. The dry run reports exactly what a real run would, writing nothing.
 *
 * Valid rows are committed even when others fail. Rejecting a whole estate
 * because three rows have a typo is how bulk onboarding becomes a thing people
 * avoid using.
 */
function CsvImport({ onDone, allowed }: { onDone: () => Promise<void>; allowed: boolean }) {
  const toast = useToast()
  const [file, setFile] = useState<File | null>(null)
  const [result, setResult] = useState<api.BulkUploadResult | null>(null)
  const [busy, setBusy] = useState(false)

  async function run(dryRun: boolean) {
    if (!file) return
    setBusy(true)
    try {
      const outcome = await api.bulkUploadCameras(file, dryRun)
      setResult(outcome)
      if (!dryRun) {
        toast.success(`${outcome.created} created, ${outcome.updated} updated`)
        await onDone()
      }
    } catch (err) {
      toast.error(err)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="space-y-5">
      <p className="text-xs leading-relaxed text-muted-foreground">
        Required columns: <code className="font-mono text-foreground">camera_code</code>,{' '}
        <code className="font-mono text-foreground">name</code>,{' '}
        <code className="font-mono text-foreground">lat</code>,{' '}
        <code className="font-mono text-foreground">lon</code>. Everything else is optional and
        unknown columns are ignored, so a department’s own spreadsheet export usually works
        unmodified. A sample sits in{' '}
        <code className="font-mono text-foreground">data/seed/sample_cameras.csv</code>.
      </p>

      <label className="block">
        <span className="eyebrow">File</span>
        <input
          type="file"
          accept=".csv,text/csv"
          disabled={!allowed}
          onChange={(e) => {
            setFile(e.target.files?.[0] ?? null)
            setResult(null)
          }}
          className="mt-1.5 block w-full rounded-md border border-dashed border-input bg-background px-3 py-3 text-[13px] text-muted-foreground file:mr-3 file:rounded-md file:border-0 file:bg-secondary file:px-3 file:py-1.5 file:text-[13px] file:font-medium file:text-foreground hover:border-muted-foreground/60"
        />
      </label>

      <div className="flex gap-2">
        <Button variant="outline" onClick={() => void run(true)} disabled={!file || busy || !allowed}>
          {busy ? 'Checking…' : 'Validate only'}
        </Button>
        <Button onClick={() => void run(false)} disabled={!file || busy || !allowed}>
          Import
        </Button>
      </div>

      {result && (
        <div className="space-y-3">
          {result.dry_run && <Badge tone="warning">Validation only — nothing was written</Badge>}
          <div className="grid grid-cols-3 gap-2">
            <StatTile label={result.dry_run ? 'Would create' : 'Created'} value={result.created} />
            <StatTile label={result.dry_run ? 'Would update' : 'Updated'} value={result.updated} />
            <StatTile
              label="Rejected"
              value={result.failed}
              tone={result.failed ? 'bad' : undefined}
            />
          </div>

          {result.errors.length > 0 && (
            <Table>
              <Thead>
                <tr>
                  <Th>Row</Th>
                  <Th>Code</Th>
                  <Th>Why it was rejected</Th>
                </tr>
              </Thead>
              <tbody>
                {result.errors.map((row) => (
                  <Tr key={`${row.row}-${row.camera_code ?? ''}`}>
                    <Td className="font-mono text-xs">{row.row}</Td>
                    <Td className="font-mono text-xs">{row.camera_code ?? '—'}</Td>
                    <Td className="text-xs text-status-offline">{row.errors.join('; ')}</Td>
                  </Tr>
                ))}
              </tbody>
            </Table>
          )}
        </div>
      )}
    </div>
  )
}

/**
 * The federation evidence, kept.
 *
 * This was a whole tab. It is real and it matters — one adapter interface
 * reaching every kind of recorder a city already runs is how cameras get
 * federated rather than replaced — but it is reference information, not
 * something anyone acts on, and a tab implied otherwise.
 */
function FederationStrip({
  vms,
  adapters,
}: {
  vms: VmsInstance[]
  adapters: Record<string, string>
}) {
  return (
    <Panel>
      <SectionLabel>
        Federation
        <InfoHint>
          Departmental recorders stay authoritative for their own video. This platform holds
          their metadata and resolves streams on demand, so the central tier carries events, not
          video — which is what lets a city deployment run on commodity hardware.
        </InfoHint>
      </SectionLabel>

      <div className="mt-3 grid gap-6 md:grid-cols-2">
        <div>
          <p className="text-xs text-faint">Connected systems</p>
          <ul className="mt-2 space-y-1.5 text-xs">
            {vms.map((instance) => (
              <li key={instance.id} className="flex items-baseline justify-between gap-3">
                <span className="truncate text-[13px]">{instance.name}</span>
                <span className="shrink-0 text-muted-foreground">
                  {vendorWords(instance.vendor)}
                  <span className="ml-1.5 font-mono text-faint">{instance.camera_count}</span>
                </span>
              </li>
            ))}
            {vms.length === 0 && <li className="text-faint">No federated systems registered.</li>}
          </ul>
        </div>
        <div>
          <p className="text-xs text-faint">Available adapters</p>
          <ul className="mt-2 flex flex-wrap gap-1.5">
            {Object.entries(adapters).map(([key, description]) => (
              <li
                key={key}
                title={description}
                className="rounded border border-border bg-secondary/40 px-2 py-0.5 font-mono text-[11px] text-muted-foreground"
              >
                {key}
              </li>
            ))}
          </ul>
        </div>
      </div>
    </Panel>
  )
}
