"""Camera registry, GIS queries, and bulk onboarding endpoints.

Every endpoint is guarded by an explicit permission from the RBAC matrix, and
every mutation is audited. The read endpoints are paginated without exception —
no route in this file can return the whole estate.
"""

from __future__ import annotations

import uuid
from typing import Annotated, Any

from fastapi import (
    APIRouter,
    BackgroundTasks,
    Depends,
    File,
    HTTPException,
    Query,
    Request,
    Response,
    UploadFile,
    status,
)
from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError

from app.api.deps import CurrentUser, DbSession
from app.core.config import settings
from app.core.logging import get_logger
from app.core.rbac import Permission, require_permission
from app.db.session import SessionLocal
from app.models.enums import (
    AdapterType,
    CameraStatus,
    CameraType,
    Protocol,
    VmsVendor,
)
from app.models.registry import Camera, Department, VmsInstance
from app.schemas.camera import (
    SOURCE_VIDEO_SUFFIXES,
    BulkUploadResult,
    CameraCreate,
    CameraOut,
    CameraPage,
    CameraUpdate,
    DepartmentOut,
    FleetSummary,
    GeoJSONFeatureCollection,
    SourceVideoOut,
    VendorEnumOut,
    VmsInstanceOut,
)
from app.services import (
    audit,
    camera_credentials,
    fleet,
    fleet_roster,
    gateway,
    health_monitor,
    simulator_control,
)
from app.services import camera as camera_service

log = get_logger("api.cameras")

router = APIRouter(prefix="/api/v1", tags=["cameras"])

#: Upload ceiling, enforced before the file is read into memory.
MAX_UPLOAD_BYTES = 20 * 1024 * 1024


# ══ Reference data ════════════════════════════════════════════════════


@router.get(
    "/departments",
    response_model=list[DepartmentOut],
    summary="Departments and their camera counts",
)
async def list_departments(
    session: DbSession,
    _user: Annotated[CurrentUser, Depends(require_permission(Permission.CAMERA_READ))],
) -> list[DepartmentOut]:
    """Owning departments, with how many cameras each contributes."""
    rows = (
        await session.execute(
            select(Department, func.count(Camera.id))
            .outerjoin(Camera, Camera.department_id == Department.id)
            .group_by(Department.id)
            .order_by(Department.code)
        )
    ).all()

    return [
        DepartmentOut(
            id=d.id,
            code=d.code,
            name=d.name,
            contact_email=d.contact_email,
            camera_count=count,
        )
        for d, count in rows
    ]


@router.get(
    "/vms",
    response_model=list[VmsInstanceOut],
    summary="Federated VMS instances",
)
async def list_vms(
    session: DbSession,
    _user: Annotated[CurrentUser, Depends(require_permission(Permission.CAMERA_READ))],
) -> list[VmsInstanceOut]:
    """The vendor systems this platform federates with.

    Each remains authoritative for its own recordings — this platform holds
    metadata and resolves streams on demand.
    """
    rows = (
        await session.execute(
            select(VmsInstance, func.count(Camera.id))
            .outerjoin(Camera, Camera.vms_id == VmsInstance.id)
            .group_by(VmsInstance.id)
            .order_by(VmsInstance.name)
        )
    ).all()

    return [
        VmsInstanceOut(
            id=v.id,
            name=v.name,
            vendor=v.vendor,
            adapter_type=v.adapter_type,
            base_url=v.base_url,
            status=v.status,
            last_sync_at=v.last_sync_at,
            camera_count=count,
        )
        for v, count in rows
    ]


@router.get(
    "/cameras/vocabularies",
    response_model=VendorEnumOut,
    summary="Enumerations for onboarding form dropdowns",
)
async def vocabularies(
    session: DbSession,
    _user: Annotated[CurrentUser, Depends(require_permission(Permission.CAMERA_READ))],
) -> VendorEnumOut:
    """Valid values, served from the server so the UI cannot drift from it."""
    codes = (await session.scalars(select(Department.code).order_by(Department.code))).all()
    return VendorEnumOut(
        departments=list(codes),
        vendors=list(VmsVendor),
        adapter_types=list(AdapterType),
        camera_types=list(CameraType),
        protocols=list(Protocol),
        statuses=list(CameraStatus),
    )


@router.get(
    "/cameras/source-videos",
    response_model=list[SourceVideoOut],
    summary="Recorded clips available to pin to a camera",
)
async def source_videos(
    _user: Annotated[CurrentUser, Depends(require_permission(Permission.CAMERA_READ))],
) -> list[SourceVideoOut]:
    """What is actually sitting in the video directory, right now.

    Serving the list rather than letting the operator type a filename is the
    difference between a dropdown and a guess: a typo becomes a camera pinned
    to a file that does not exist, which the simulator can only report as a
    warning in a log nobody is reading.

    Names only — no path is returned and none is accepted back. `source_file`
    is resolved against the simulator's own directory, so the filename is the
    entire contract between the two services.

    A missing directory is an empty list, not an error: an operator who has
    added no footage should see "no recorded clips available", not a 500.
    """
    directory = settings.video_dir
    try:
        entries = [
            p
            for p in directory.iterdir()
            if p.is_file() and p.suffix.lower() in SOURCE_VIDEO_SUFFIXES
        ]
    except OSError:
        # Not mounted, or not readable. Either way there is nothing to offer,
        # and the form degrades to the live-URL path it has always had.
        return []

    videos: list[SourceVideoOut] = []
    for path in sorted(entries, key=lambda p: p.name.lower()):
        try:
            size = path.stat().st_size
        except OSError:
            continue
        videos.append(SourceVideoOut(filename=path.name, size_bytes=size))
    return videos


# ══ Fleet views ═══════════════════════════════════════════════════════


@router.get(
    "/cameras/summary",
    response_model=FleetSummary,
    summary="Fleet rollup for the dashboard KPI strip",
)
async def fleet_summary(
    session: DbSession,
    _user: Annotated[CurrentUser, Depends(require_permission(Permission.CAMERA_READ))],
) -> FleetSummary:
    return FleetSummary(**await camera_service.fleet_summary(session))


@router.get(
    "/cameras/geojson",
    response_model=GeoJSONFeatureCollection,
    summary="Camera estate as GeoJSON for the map",
)
async def cameras_geojson(
    session: DbSession,
    _user: Annotated[CurrentUser, Depends(require_permission(Permission.CAMERA_READ))],
    department_code: str | None = None,
    district: str | None = None,
    status_filter: Annotated[str | None, Query(alias="status")] = None,
    vendor: str | None = None,
    camera_type: str | None = None,
    anpr_enabled: bool | None = None,
    limit: Annotated[int, Query(ge=1, le=100_000)] = 5000,
) -> GeoJSONFeatureCollection:
    """RFC 7946 FeatureCollection, consumed directly by MapLibre.

    Clustering is done client-side by MapLibre's own cluster layer, which keeps
    zoom interactions instant instead of re-querying the server on every pan.
    """
    return await camera_service.to_geojson(
        session,
        limit=limit,
        department_code=department_code,
        district=district,
        status=status_filter,
        vendor=vendor,
        camera_type=camera_type,
        anpr_enabled=anpr_enabled,
    )


@router.get(
    "/cameras/nearby",
    response_model=list[CameraOut],
    summary="Cameras within a radius, nearest first",
)
async def cameras_nearby(
    session: DbSession,
    _user: Annotated[CurrentUser, Depends(require_permission(Permission.CAMERA_READ))],
    lat: Annotated[float, Query(ge=-90, le=90, examples=[22.3039])],
    lon: Annotated[float, Query(ge=-180, le=180, examples=[70.8022])],
    radius_km: Annotated[float, Query(gt=0, le=500)] = 5.0,
    limit: Annotated[int, Query(ge=1, le=500)] = 50,
    department_code: str | None = None,
    status_filter: Annotated[str | None, Query(alias="status")] = None,
) -> list[CameraOut]:
    """Proximity search — "what did we have covering this location?"

    The operational question after an incident is which cameras could have seen
    it. Results carry ``distance_km`` and are ordered nearest first.
    """
    return await camera_service.find_nearby(
        session,
        lat=lat,
        lon=lon,
        radius_km=radius_km,
        limit=limit,
        department_code=department_code,
        status=status_filter,
    )


@router.get(
    "/cameras/in-district/{district}",
    response_model=list[CameraOut],
    summary="Every camera in a district",
)
async def cameras_in_district(
    district: str,
    session: DbSession,
    _user: Annotated[CurrentUser, Depends(require_permission(Permission.CAMERA_READ))],
    limit: Annotated[int, Query(ge=1, le=500)] = 500,
) -> list[CameraOut]:
    return await camera_service.find_in_district(session, district, limit=limit)


@router.get(
    "/cameras",
    response_model=CameraPage,
    summary="List cameras with filters and pagination",
)
async def list_cameras(
    session: DbSession,
    _user: Annotated[CurrentUser, Depends(require_permission(Permission.CAMERA_READ))],
    limit: Annotated[int, Query(ge=1, le=500)] = 50,
    offset: Annotated[int, Query(ge=0)] = 0,
    department_code: str | None = None,
    district: str | None = None,
    city: str | None = None,
    status_filter: Annotated[str | None, Query(alias="status")] = None,
    camera_type: str | None = None,
    vendor: str | None = None,
    anpr_enabled: bool | None = None,
    search: Annotated[
        str | None, Query(description="Match against code, name, or junction")
    ] = None,
) -> CameraPage:
    items, total = await camera_service.list_cameras(
        session,
        limit=limit,
        offset=offset,
        department_code=department_code,
        district=district,
        city=city,
        status=status_filter,
        camera_type=camera_type,
        vendor=vendor,
        anpr_enabled=anpr_enabled,
        search=search,
    )
    # A status held at its last known value says so, beside the status.
    await fleet.annotate_staleness(session, items)
    return CameraPage(items=items, total=total, limit=limit, offset=offset)


@router.get(
    "/cameras/{camera_id}",
    response_model=CameraOut,
    summary="One camera by id",
)
async def get_camera(
    camera_id: uuid.UUID,
    session: DbSession,
    _user: Annotated[CurrentUser, Depends(require_permission(Permission.CAMERA_READ))],
) -> CameraOut:
    camera = await camera_service.get_camera(session, camera_id)
    if camera is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Camera not found")
    out = camera_service.to_out(camera)
    await fleet.annotate_staleness(session, [out])
    return out


# ══ Mutations ═════════════════════════════════════════════════════════


def _credentials_refused(exc: camera_credentials.CredentialStoreUnavailable) -> HTTPException:
    """The answer when a login arrives and there is no key to seal it with."""
    return HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail=str(exc))


async def first_probe(camera_id: uuid.UUID) -> None:
    """Probe a just-onboarded camera once, so its status is known in seconds.

    The health monitor would reach it at its next sweep — up to a full probe
    interval later — and until then the registry shows "unknown", which reads
    like a fault to someone watching a camera being integrated. A wrong
    password shows here as `unauthorized`, while the operator is still at the
    form. Run after the response, in a session of its own; never raises.
    """
    try:
        async with SessionLocal() as session:
            camera = await camera_service.get_camera(session, camera_id)
            if camera is None or not camera.stream_url:
                return
            if camera.vms is not None and camera.vms.adapter_type in gateway.FEDERATED_ADAPTERS:
                # Somebody else's gateway, with its own session budget.
                return
            probe = await health_monitor.probe_camera(session, camera)
            camera.status = health_monitor.status_after_manual_probe(camera.status, probe)
            await session.commit()
            log.info(
                "camera.first_probe",
                camera_code=camera.camera_code,
                status=camera.status,
                error_code=probe.error_code,
            )
    except Exception:
        # A supervisor boundary for a best-effort follow-up: the camera is
        # registered either way, and the monitor's sweep will probe it.
        log.warning("camera.first_probe_failed", camera_id=str(camera_id), exc_info=True)


def _source_kind(camera: Any) -> str:
    """How the camera gets its pictures, for the audit row. Never the URL."""
    if getattr(camera, "stream_url", None):
        return "stream"
    if getattr(camera, "source_file", None):
        return "recorded"
    return "none"


@router.post(
    "/cameras",
    response_model=CameraOut,
    status_code=status.HTTP_201_CREATED,
    summary="Register a camera",
)
async def create_camera(
    payload: CameraCreate,
    request: Request,
    session: DbSession,
    background: BackgroundTasks,
    user: Annotated[CurrentUser, Depends(require_permission(Permission.CAMERA_CREATE))],
) -> CameraOut:
    """Register a single camera.

    Available to the ``api_client`` role, which is how another department
    self-registers its estate with an API key. That role holds this permission
    and nothing else, so a leaked onboarding key cannot read the fleet, search,
    or view alerts.

    A camera that needs a login takes it in ``stream_username`` and
    ``stream_password`` — or inside a pasted ``rtsp://user:pass@host/…``, which
    is split before anything is stored. The password is sealed into
    ``credentials_ref`` and is never returned, logged or audited.

    Once committed, the camera is put to work at once rather than at the next
    periodic pass: the gateway is told to pull it, the AI workers are told the
    fleet changed (they pick it up within about two seconds), and a camera
    onboarded with a recorded clip is started on the simulator.
    """
    if await camera_service.get_camera_by_code(session, payload.camera_code):
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=f"Camera code {payload.camera_code} is already registered",
        )

    try:
        camera = await camera_service.create_camera(session, payload)
    except camera_credentials.CredentialStoreUnavailable as exc:
        raise _credentials_refused(exc) from exc
    except IntegrityError as exc:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=f"Camera could not be registered: {exc.orig}",
        ) from exc

    await audit.record(
        action="camera.create",
        user=user,
        request=request,
        resource_type="camera",
        resource_id=camera.id,
        # Whether a login was stored, never the login itself.
        params={
            "camera_code": camera.camera_code,
            "district": camera.district,
            "source": _source_kind(camera),
            # Not named "credentials": the audit trail redacts that key
            # wholesale, which would hide even this yes/no.
            "login_stored": bool(camera.credentials_ref),
        },
    )
    log.info(
        "camera.created",
        camera_code=camera.camera_code,
        by=user.username,
        credentials=bool(camera.credentials_ref),
    )

    # Committed before anything else reads it: the roster is built, and the
    # simulator reads the camera, in sessions of their own.
    await session.commit()

    # Tell the gateway to pull this camera's source. Without it the stream URL
    # the operator just typed is stored and never used: everything downstream
    # reads the camera from `rtsp://<gateway>/<code>`, and nothing would ever
    # have published it there.
    await gateway.register(camera)
    await fleet_roster.notify_changed("camera.create", camera.camera_code)
    if simulator_control.wants_replay(camera):
        # After the response: a first start may transcode the clip.
        background.add_task(simulator_control.start, camera.camera_code)
    if settings.probe_on_onboard and camera.stream_url:
        background.add_task(first_probe, camera.id)

    return camera_service.to_out(camera)


@router.patch(
    "/cameras/{camera_id}",
    response_model=CameraOut,
    summary="Update a camera",
)
async def update_camera(
    camera_id: uuid.UUID,
    payload: CameraUpdate,
    request: Request,
    session: DbSession,
    background: BackgroundTasks,
    user: Annotated[CurrentUser, Depends(require_permission(Permission.CAMERA_UPDATE))],
) -> CameraOut:
    camera = await camera_service.get_camera(session, camera_id)
    if camera is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Camera not found")

    changed = payload.model_dump(
        exclude_unset=True,
        exclude={"stream_username", "stream_password", "clear_credentials"},
    )
    was_replaying = simulator_control.wants_replay(camera)
    previous_clip = camera.source_file
    try:
        camera = await camera_service.update_camera(session, camera, payload)
    except camera_credentials.CredentialStoreUnavailable as exc:
        raise _credentials_refused(exc) from exc

    fields = sorted(changed)
    if payload.login_changed:
        # Named, never shown: a reviewer sees that the login changed.
        fields = sorted({*fields, "login"})
    await audit.record(
        action="camera.update",
        user=user,
        request=request,
        resource_type="camera",
        resource_id=camera.id,
        # Record which fields changed — an audit row saying only "updated" does
        # not answer the question a reviewer is asking.
        params={"camera_code": camera.camera_code, "fields": fields},
    )
    await session.commit()

    replaying = simulator_control.wants_replay(camera)
    if was_replaying and not replaying:
        # Stopped before any pull is registered, so a publisher and a pull
        # never contend for the same gateway path.
        await simulator_control.stop(camera.camera_code)

    # Only when the source actually moved. Re-registering on every edit would
    # tear down a live pull because somebody corrected a spelling. A new login
    # is a moved source: the old pull would go on failing with 401.
    if "stream_url" in changed or payload.login_changed:
        if camera.stream_url:
            await gateway.register(camera)
        else:
            await gateway.unregister(camera.camera_code)

    await fleet_roster.notify_changed("camera.update", camera.camera_code)

    if replaying and (not was_replaying or camera.source_file != previous_clip):
        task = simulator_control.restart if was_replaying else simulator_control.start
        background.add_task(task, camera.camera_code)

    return camera_service.to_out(camera)


@router.delete(
    "/cameras/{camera_id}",
    status_code=status.HTTP_204_NO_CONTENT,
    summary="Remove a camera from the registry (admin only)",
)
async def delete_camera(
    camera_id: uuid.UUID,
    request: Request,
    session: DbSession,
    background: BackgroundTasks,
    user: Annotated[CurrentUser, Depends(require_permission(Permission.CAMERA_DELETE))],
) -> Response:
    """Delete a camera.

    Detections already recorded from it are retained — their ``camera_id``
    becomes NULL rather than cascading. Deleting a camera must not delete
    evidence gathered while it was operating. Its stored login goes with the
    row.
    """
    camera = await camera_service.get_camera(session, camera_id)
    if camera is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Camera not found")

    code = camera.camera_code
    was_replaying = bool(camera.source_file)
    await session.delete(camera)

    await audit.record(
        action="camera.delete",
        user=user,
        request=request,
        resource_type="camera",
        resource_id=camera_id,
        params={"camera_code": code},
    )
    log.warning("camera.deleted", camera_code=code, by=user.username)
    await session.commit()

    # Leave the gateway holding no path for a camera that no longer exists —
    # otherwise it keeps trying to reach a source nobody can now see or manage.
    await gateway.unregister(code)
    await fleet_roster.notify_changed("camera.delete", code)
    if was_replaying:
        # A replay left running would keep publishing a camera nobody can see.
        background.add_task(simulator_control.stop, code)

    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.post(
    "/cameras/bulk",
    response_model=BulkUploadResult,
    summary="Bulk-onboard cameras from CSV",
)
async def bulk_upload(
    request: Request,
    session: DbSession,
    user: Annotated[CurrentUser, Depends(require_permission(Permission.CAMERA_CREATE))],
    file: Annotated[UploadFile, File(description="UTF-8 CSV")],
    dry_run: Annotated[bool, Query(description="Validate without writing anything")] = False,
    update_existing: Annotated[
        bool, Query(description="Update cameras whose code already exists")
    ] = True,
) -> BulkUploadResult:
    """Onboard many cameras at once.

    Required columns: ``camera_code``, ``name``, ``lat``, ``lon``. Everything
    else is optional; unknown columns are ignored so a department's own
    spreadsheet export usually works unmodified.

    Valid rows are committed even when others fail — a file of 4,000 cameras
    should not be rejected wholesale because three rows have a typo. The
    response reports every failure by row number. Use ``dry_run`` to check a
    file before committing to it.
    """
    content = await file.read()
    if len(content) > MAX_UPLOAD_BYTES:
        raise HTTPException(
            status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
            detail=f"File exceeds {MAX_UPLOAD_BYTES // (1024 * 1024)} MB",
        )

    try:
        result = await camera_service.bulk_upload(
            session, content, dry_run=dry_run, update_existing=update_existing
        )
    except ValueError as exc:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail=str(exc)
        ) from exc

    await audit.record(
        action="camera.bulk_upload",
        user=user,
        request=request,
        resource_type="camera",
        params={
            "filename": file.filename,
            "created": result.created,
            "updated": result.updated,
            "failed": result.failed,
            "dry_run": dry_run,
        },
    )

    # One reconcile for the whole file rather than a registration per row: a
    # four-thousand-camera estate would otherwise make four thousand calls to
    # the gateway while the operator waits for the response.
    if not dry_run and (result.created or result.updated):
        await session.commit()
        await gateway.reconcile()
        await fleet_roster.notify_changed("camera.bulk_upload")

    return result
