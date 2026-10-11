"""Reports an investigator can file: one vehicle's route, and every plate read in a window.

The submission asks for "a report listing detected vehicles or plates with
timestamps", and the live test ends in one: track a designated vehicle, then
hand over where it was seen. These are CSV because CSV is what survives being
emailed, opened in a spreadsheet and attached to a case file. The printable
route report is a page in the command centre (`/reports/vehicle/:plate`),
built from the same route endpoint.

Three rules every report here keeps:

* **Times twice.** IST for the reader, UTC beside it for the record — the
  platform's rule is UTC inside and IST at the edge, and a report is both.
* **Nothing dropped.** A sighting at a camera with no known position is a row,
  marked as such, with no coordinates and no speed. A window too large to
  export is refused with its size rather than silently cut.
* **Every export is audited.** A report is a plate search with a download
  button, and the audit rule covers it the same way.
"""

from __future__ import annotations

import csv
import io
import uuid
from datetime import UTC, datetime, timedelta
from typing import Annotated, Any
from zoneinfo import ZoneInfo

from fastapi import APIRouter, Depends, HTTPException, Query, Request, Response, status
from geoalchemy2 import Geometry
from sqlalchemy import func, select

from app.api.deps import CurrentUserDep, DbSession
from app.core.rbac import Permission, require_permission
from app.models.intelligence import Detection
from app.models.registry import Camera, Department
from app.schemas.intelligence import normalise_plate
from app.services import audit, correlator

router = APIRouter(prefix="/api/v1/reports", tags=["reports"])

IST = ZoneInfo("Asia/Kolkata")

#: The largest export served. Over it the request is refused with the count,
#: so the caller narrows the window rather than receiving a report that
#: quietly stops part-way through.
MAX_ROWS = 50_000

#: When no window is given. Matches the route endpoint's.
DEFAULT_WINDOW = timedelta(days=1)

#: What a flag means, for a reader without the codebase.
FLAG_WORDS = {
    "implausible_speed": "faster than any vehicle could have driven",
    "impossible_simultaneous": "seen at two places at the same instant",
    "unobserved_gap": "over an hour unobserved",
    "heading_conflict": "against the camera's direction",
    "co_located": "cameras at the same spot",
    "revisit": "back at a camera already passed",
}

ROUTE_COLUMNS = [
    "plate",
    "visit",
    "camera_code",
    "camera_name",
    "department",
    "district",
    "city",
    "latitude",
    "longitude",
    "arrived_ist",
    "departed_ist",
    "arrived_utc",
    "departed_utc",
    "dwell_s",
    "sightings",
    "best_read_confidence",
    "km_from_previous",
    "minutes_from_previous",
    "implied_kmph",
    "plausible",
    "notes",
    "evidence_detection_id",
]

PLATE_COLUMNS = [
    "time_ist",
    "time_utc",
    "plate",
    "read_confidence",
    "vehicle_type",
    "camera_code",
    "camera_name",
    "department",
    "district",
    "city",
    "latitude",
    "longitude",
    "detection_id",
]


def _ist(ts: datetime) -> str:
    return ts.astimezone(IST).strftime("%Y-%m-%d %H:%M:%S")


def _utc(ts: datetime) -> str:
    return ts.astimezone(UTC).isoformat(timespec="seconds")


def _csv(columns: list[str], rows: list[list[Any]], filename: str) -> Response:
    """A CSV download. UTF-8 with a byte-order mark, so a spreadsheet on a
    Windows desk shows camera names in Gujarati as text rather than mojibake."""
    buffer = io.StringIO()
    writer = csv.writer(buffer)
    writer.writerow(columns)
    writer.writerows(rows)
    return Response(
        content="﻿" + buffer.getvalue(),
        media_type="text/csv; charset=utf-8",
        headers={
            "Content-Disposition": f'attachment; filename="{filename}"',
            "Cache-Control": "no-store",
        },
    )


async def _departments(session: DbSession, camera_ids: set[uuid.UUID]) -> dict[uuid.UUID, str]:
    if not camera_ids:
        return {}
    rows = await session.execute(
        select(Camera.id, Department.name)
        .join(Department, Department.id == Camera.department_id, isouter=True)
        .where(Camera.id.in_(camera_ids))
    )
    return {camera_id: name for camera_id, name in rows.all() if name}


def _window(since: datetime | None, until: datetime | None) -> tuple[datetime, datetime]:
    window_to = until or datetime.now(UTC)
    window_from = since or (window_to - DEFAULT_WINDOW)
    if window_from >= window_to:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="The window's start must be before its end.",
        )
    return window_from, window_to


def _stamp(ts: datetime) -> str:
    return ts.astimezone(IST).strftime("%Y%m%d-%H%M")


@router.get(
    "/vehicle/{plate}.csv",
    dependencies=[Depends(require_permission(Permission.SEARCH_EXECUTE))],
    summary="A vehicle's route as CSV: every camera it was seen at, in order",
)
async def vehicle_report_csv(
    plate: str,
    session: DbSession,
    user: CurrentUserDep,
    request: Request,
    since: Annotated[datetime | None, Query(description="UTC lower bound")] = None,
    until: Annotated[datetime | None, Query(description="UTC upper bound")] = None,
) -> Response:
    """One row per visit to a camera, in the order they happened.

    A visit is consecutive sightings at one camera (the route's hops). Each
    row after the first carries the leg that led to it — straight-line
    distance, time, the speed those imply, and whether that speed was
    believable — because those are what turn a list of sightings into a
    route, and what a reader would otherwise have to work out by hand.

    Sightings at cameras with no known position follow the route, one row
    each, marked and without coordinates or speeds.
    """
    normalised = normalise_plate(plate)
    if len(normalised) < 4:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="A plate needs at least four alphanumeric characters to search on.",
        )
    window_from, window_to = _window(since, until)
    route = await correlator.build_route(session, normalised, window_from, window_to)
    departments = await _departments(
        session, {h.camera_id for h in route.hops} | {s.camera_id for s in route.unplaced}
    )

    rows: list[list[Any]] = []
    for index, hop in enumerate(route.hops, start=1):
        notes = "; ".join(FLAG_WORDS.get(flag, flag) for flag in hop.flags)
        rows.append(
            [
                normalised,
                index,
                hop.camera_code,
                hop.camera_name,
                departments.get(hop.camera_id, ""),
                hop.district or "",
                hop.city or "",
                round(hop.lat, 6),
                round(hop.lon, 6),
                _ist(hop.arrived_at),
                _ist(hop.departed_at),
                _utc(hop.arrived_at),
                _utc(hop.departed_at),
                round(hop.dwell_s, 1),
                hop.sightings,
                round(hop.best_confidence, 3),
                round(hop.distance_m / 1000.0, 3) if hop.distance_m is not None else "",
                round(hop.elapsed_s / 60.0, 1) if hop.elapsed_s is not None else "",
                round(hop.implied_kmph, 1) if hop.implied_kmph is not None else "",
                "yes" if hop.plausible else "no",
                notes,
                str(hop.best_detection_id) if hop.best_detection_id else "",
            ]
        )
    for sighting in route.unplaced:
        rows.append(
            [
                normalised,
                "",
                sighting.camera_code,
                sighting.camera_name,
                departments.get(sighting.camera_id, ""),
                sighting.district or "",
                sighting.city or "",
                "",
                "",
                _ist(sighting.ts),
                _ist(sighting.ts),
                _utc(sighting.ts),
                _utc(sighting.ts),
                0.0,
                1,
                round(sighting.plate_confidence, 3),
                "",
                "",
                "",
                "",
                "camera position unknown: not on the route",
                str(sighting.detection_id),
            ]
        )

    await audit.record_plate_search(
        request=request,
        user=user,
        query=normalised,
        filters={
            "action": "report.route.csv",
            "from": window_from.isoformat(),
            "to": window_to.isoformat(),
        },
        result_count=len(rows),
    )
    return _csv(
        ROUTE_COLUMNS,
        rows,
        f"route-{normalised}-{_stamp(window_from)}-to-{_stamp(window_to)}.csv",
    )


@router.get(
    "/plates.csv",
    dependencies=[Depends(require_permission(Permission.SEARCH_EXECUTE))],
    summary="Every plate read in a time window as CSV, optionally for one camera",
)
async def plates_report_csv(
    session: DbSession,
    user: CurrentUserDep,
    request: Request,
    since: Annotated[datetime | None, Query(description="UTC lower bound")] = None,
    until: Annotated[datetime | None, Query(description="UTC upper bound")] = None,
    camera_id: Annotated[uuid.UUID | None, Query(description="Restrict to one camera")] = None,
    plate: Annotated[str | None, Query(description="Only this plate, normalised for you")] = None,
    min_confidence: Annotated[float | None, Query(ge=0.0, le=1.0)] = None,
) -> Response:
    """The detected-plates listing the submission asks for: one row per read.

    Readable plates only — a vehicle with no plate read is a detection, not a
    plate, and this report is the plate list. Refused, with the count, when
    the window holds more than `MAX_ROWS`.
    """
    window_from, window_to = _window(since, until)
    normalised = normalise_plate(plate) if plate else None

    location = Camera.location.cast(Geometry)
    conditions = [
        Detection.ts >= window_from,
        Detection.ts <= window_to,
        Detection.plate_normalised.isnot(None),
        Detection.plate_normalised != "",
    ]
    if camera_id is not None:
        conditions.append(Detection.camera_id == camera_id)
    if normalised:
        conditions.append(Detection.plate_normalised == normalised)
    if min_confidence is not None:
        conditions.append(Detection.plate_confidence >= min_confidence)

    total = (
        await session.execute(select(func.count()).select_from(Detection).where(*conditions))
    ).scalar_one()
    if total > MAX_ROWS:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=(
                f"{total:,} plate reads in this window; a report holds at most "
                f"{MAX_ROWS:,}. Narrow the window or choose one camera."
            ),
        )

    query = (
        select(
            Detection.ts,
            Detection.plate_normalised,
            Detection.plate_confidence,
            Detection.vehicle_type,
            Camera.camera_code,
            Camera.name,
            Department.name,
            Camera.district,
            Camera.city,
            func.ST_Y(location),
            func.ST_X(location),
            Camera.tags,
            Detection.id,
        )
        .join(Camera, Camera.id == Detection.camera_id)
        .join(Department, Department.id == Camera.department_id, isouter=True)
        .where(*conditions)
        .order_by(Detection.ts.asc())
        .limit(MAX_ROWS)
    )
    rows: list[list[Any]] = []
    for row in (await session.execute(query)).all():
        # A placeholder position is not a location, and a report is the last
        # place to let one pass for one.
        placed = row[9] is not None and correlator.UNPLACED_TAG not in (row[11] or ())
        rows.append(
            [
                _ist(row[0]),
                _utc(row[0]),
                row[1],
                round(row[2], 3) if row[2] is not None else "",
                row[3] or "",
                row[4],
                row[5],
                row[6] or "",
                row[7] or "",
                row[8] or "",
                round(row[9], 6) if placed else "",
                round(row[10], 6) if placed else "",
                str(row[12]),
            ]
        )

    filters = {
        "action": "report.plates.csv",
        "from": window_from.isoformat(),
        "to": window_to.isoformat(),
        "camera_id": str(camera_id) if camera_id else None,
    }
    if normalised:
        await audit.record_plate_search(
            request=request, user=user, query=normalised, filters=filters, result_count=total
        )
    else:
        # No plate to name, but a list of every vehicle on the network in a
        # window is the larger disclosure, not the smaller.
        await audit.record(
            action="report.plates",
            user=user,
            request=request,
            resource_type="detection",
            params={**filters, "results": total},
        )
    scope = normalised or "all-plates"
    return _csv(
        PLATE_COLUMNS,
        rows,
        f"plates-{scope}-{_stamp(window_from)}-to-{_stamp(window_to)}.csv",
    )
