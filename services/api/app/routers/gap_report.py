"""The gap report as a file: where the network is blind, to hand to whoever fixes it.

Fleet health shows the gap analysis on screen (`GET /api/v1/health/gaps`); an
operations lead needs it as something to email to a department, attach to a
maintenance ticket or put in a monthly review. Same analysis
(`app.services.fleet.gap_analysis`), same window, one row per gap.

It follows the reports' conventions (`app/routers/reports.py`, whose CSV
helpers it uses): UTF-8 with a byte-order mark, times in IST and UTC, every
export audited. It lives in its own module under the same `/api/v1/reports`
prefix only so that the vehicle reports and this one can change independently.

The kinds of gap are kept apart in ``gap_type`` — ``unavailable``,
``unreliable``, ``no_cameras``, ``below_anpr_target``, ``ageing``,
``install_date_unknown`` and ``position_unknown``, the Fleet health tabs'
words — because each needs a different response — fix the camera, steady a
flapping one, install a camera, add plate reading, replace old equipment, or
ask the owner for a fact the registry lacks — and a reader filtering the sheet
should be able to hand each list to the person who acts on it. Districts are
Gujarat's 33, by each camera's position (`fleet.gap_analysis`).
"""

from __future__ import annotations

from datetime import datetime, timedelta
from typing import Annotated, Any

from fastapi import APIRouter, Depends, Query, Request, Response
from sqlalchemy import and_, func, select

from app.api.deps import CurrentUserDep, DbSession
from app.core.rbac import Permission, require_permission
from app.models.registry import Camera, CameraHealth, Department
from app.routers.reports import _csv, _ist, _stamp, _utc
from app.services import audit, fleet

router = APIRouter(prefix="/api/v1/reports", tags=["reports"])

GAP_COLUMNS = [
    "gap_type",
    "camera_code",
    "camera_name",
    "district",
    "department",
    "status",
    "cameras",
    "anpr_cameras",
    "online",
    "anpr_share_pct",
    "availability_pct",
    "probes",
    "uptime_pct",
    "installed_on",
    "age_years",
    "last_answered_ist",
    "last_answered_utc",
    "reason",
    "window_start_ist",
    "window_end_ist",
    "window_start_utc",
    "window_end_utc",
]

_STATUS_REASON = {
    "offline": "Offline: the integration answers, but the camera delivers no video.",
    "degraded": "Degraded: video arrives late, or drops frames.",
}


async def _camera_facts(
    session: DbSession, codes: set[str], since: datetime
) -> dict[str, tuple[str, datetime | None, str]]:
    """Each gap camera's owning department, when it last answered a probe
    inside the window, and its name.

    The last-answered time is bounded by the window on purpose: it reads the
    health hypertable through its (camera, time) index for a handful of
    cameras, never their whole history.
    """
    if not codes:
        return {}
    answered = (
        select(
            CameraHealth.camera_id.label("camera_id"),
            func.max(CameraHealth.ts).label("ts"),
        )
        .where(
            and_(
                CameraHealth.camera_id.in_(select(Camera.id).where(Camera.camera_code.in_(codes))),
                CameraHealth.ts >= since,
                CameraHealth.reachable.is_(True),
            )
        )
        .group_by(CameraHealth.camera_id)
        .subquery()
    )
    rows = (
        await session.execute(
            select(
                Camera.camera_code,
                func.coalesce(Department.code, "UNASSIGNED"),
                answered.c.ts,
                Camera.name,
            )
            .outerjoin(Department, Department.id == Camera.department_id)
            .outerjoin(answered, answered.c.camera_id == Camera.id)
            .where(Camera.camera_code.in_(codes))
        )
    ).all()
    return {code: (department, ts, name) for code, department, ts, name in rows}


def _gap_rows(
    gaps: dict[str, Any],
    cameras: dict[str, tuple[str, datetime | None, str]],
    window: tuple[datetime, datetime],
) -> list[list[Any]]:
    start, end = window
    window_cells = [_ist(start), _ist(end), _utc(start), _utc(end)]

    def answered_cells(code: str) -> list[str]:
        ts = cameras.get(code, ("", None, ""))[1]
        return [_ist(ts), _utc(ts)] if ts else ["", ""]

    rows: list[list[Any]] = []
    for g in gaps["availability_gaps"]:
        rows.append(
            [
                "unavailable",
                g["camera_code"],
                g["name"],
                g["district"] or "",
                g["department"],
                g["status"],
                "",
                "",
                "",
                "",
                "",
                "",
                "",
                "",
                "",
                *answered_cells(g["camera_code"]),
                _STATUS_REASON.get(g["status"], f"Camera {g['status']}."),
                *window_cells,
            ]
        )
    for g in gaps["reliability_gaps"]:
        rows.append(
            [
                "unreliable",
                g["camera_code"],
                g["name"],
                g["district"] or "",
                cameras.get(g["camera_code"], ("", None, ""))[0],
                "",
                "",
                "",
                "",
                "",
                "",
                g["probes"],
                g["uptime_pct"],
                "",
                "",
                *answered_cells(g["camera_code"]),
                g["reason"],
                *window_cells,
            ]
        )
    for g in gaps["coverage_gaps"]:
        rows.append(
            [
                "no_cameras",
                "",
                "",
                g["district"],
                "",
                "",
                0,
                0,
                0,
                "",
                "",
                "",
                "",
                "",
                "",
                "",
                "",
                g["reason"],
                *window_cells,
            ]
        )
    for g in gaps["capability_gaps"]:
        rows.append(
            [
                "below_anpr_target",
                "",
                "",
                g["district"],
                "",
                "",
                g["cameras"],
                g["anpr_cameras"],
                g["online"],
                round(g["anpr_share"] * 100, 1),
                g["availability_pct"],
                "",
                "",
                "",
                "",
                "",
                "",
                g["reason"],
                *window_cells,
            ]
        )
    for g in gaps.get("ageing_gaps", []):
        rows.append(
            [
                "ageing",
                g["camera_code"],
                g["name"],
                g["district"] or "",
                cameras.get(g["camera_code"], ("", None, ""))[0],
                "",
                "",
                "",
                "",
                "",
                "",
                "",
                "",
                g["installed_on"],
                g["age_years"],
                *answered_cells(g["camera_code"]),
                g["reason"],
                *window_cells,
            ]
        )
    undated = gaps.get("install_date_unknown") or {}
    for code in undated.get("camera_codes", []):
        rows.append(
            _camera_only_row("install_date_unknown", code, cameras, undated["reason"], window_cells)
        )
    for code in (gaps.get("geography") or {}).get("position_unknown", []):
        rows.append(
            _camera_only_row(
                "position_unknown",
                code,
                cameras,
                "Position not known, so this camera is counted in no district. "
                "Survey it, or ask its owner.",
                window_cells,
            )
        )
    return rows


def _camera_only_row(
    gap_type: str,
    code: str,
    cameras: dict[str, tuple[str, datetime | None, str]],
    reason: str,
    window_cells: list[str],
) -> list[Any]:
    """A gap that is a fact the registry lacks about one camera."""
    ts = cameras.get(code, ("", None, ""))[1]
    return [
        gap_type,
        code,
        cameras.get(code, ("", None, ""))[2],
        "",
        cameras.get(code, ("", None, ""))[0],
        *([""] * 10),
        _ist(ts) if ts else "",
        _utc(ts) if ts else "",
        reason,
        *window_cells,
    ]


@router.get(
    "/gaps.csv",
    dependencies=[Depends(require_permission(Permission.CAMERA_READ))],
    summary="The gap report as CSV: every place the network is blind, and why",
)
async def gap_report_csv(
    session: DbSession,
    user: CurrentUserDep,
    request: Request,
    hours: Annotated[int, Query(ge=1, le=720, description="Reporting window")] = 24,
) -> Response:
    """One row per gap: unavailable and unreliable cameras, Gujarat districts
    with no camera, districts below the plate-reading target, ageing cameras,
    and cameras whose install date or position the registry does not hold.

    Each camera row carries when that camera last answered a probe inside the
    window, blank when it did not answer at all — the first thing whoever is
    sent to fix it will ask.
    """
    gaps = await fleet.gap_analysis(session, hours=hours)
    window_end = datetime.fromisoformat(gaps["generated_at"])
    window = (window_end - timedelta(hours=hours), window_end)
    codes = (
        {g["camera_code"] for g in gaps["availability_gaps"]}
        | {g["camera_code"] for g in gaps["reliability_gaps"]}
        | {g["camera_code"] for g in gaps.get("ageing_gaps", [])}
        | set((gaps.get("install_date_unknown") or {}).get("camera_codes", []))
        | set((gaps.get("geography") or {}).get("position_unknown", []))
    )
    cameras = await _camera_facts(session, codes, window[0])
    rows = _gap_rows(gaps, cameras, window)

    await audit.record(
        action="report.gaps",
        user=user,
        request=request,
        resource_type="fleet",
        params={"window_hours": hours, "rows": len(rows), "summary": gaps["summary"]},
    )
    return _csv(
        GAP_COLUMNS,
        rows,
        f"gap-report-{_stamp(window[0])}-to-{_stamp(window[1])}.csv",
    )
