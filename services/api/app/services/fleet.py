"""Fleet health rollups and gap analysis.

Gap-analysis reports are a named Model 1 requirement. The question they answer
is the one a police commissioner actually asks: *where are we blind?* — which
is a different question from *which cameras are broken*.

Five kinds of gap are reported:

* **Availability gaps** — cameras that exist but are not delivering video.
* **Reliability gaps** — cameras that keep dropping in and out.
* **Coverage gaps** — Gujarat districts with no camera at all.
* **Capability gaps** — districts with cameras but little or no ANPR coverage,
  so a vehicle can cross them without ever being read.
* **Ageing infrastructure** — cameras installed long enough ago to be due for
  review, and, said plainly, cameras whose install date nobody recorded.

Districts are Gujarat's 33, from the committed boundary file
(``data/seed/gujarat_districts.geojson``), and a camera belongs to the district
its registered position falls in — not to whatever its free-text ``district``
says, which on 12 Oct read "Ahmadabad" for the grid and "Sabarmati" (a taluka)
for the demonstration feed. A camera whose position is unknown, or which only
replays recorded footage, covers nowhere and is counted apart, by name.
"""

from __future__ import annotations

import json
import uuid
from datetime import UTC, date, datetime, timedelta
from functools import lru_cache
from pathlib import Path
from typing import Any

from geoalchemy2 import Geometry
from sqlalchemy import Float, and_, case, cast, func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.adapters.base import STATUS_HOLD_ERRORS
from app.core.logging import get_logger
from app.models.intelligence import Alert
from app.models.registry import Camera, CameraHealth, Department, VmsInstance

log = get_logger("api.fleet")

#: A district whose ANPR share falls below this is flagged as a capability gap.
ANPR_COVERAGE_TARGET = 0.40

#: Uptime below this over the reporting window is "unreliable" — a camera that
#: works two thirds of the time is not one an investigation can depend on.
UPTIME_RELIABILITY_TARGET = 0.90

#: A camera installed longer ago than this is due for review: analogue-era
#: optics and recorders past their service life are where night reads and
#: frame drops come from. A judgement, stated as one, not a measurement.
AGEING_AFTER_YEARS = 5

#: Tags of a camera whose position nobody knows; it covers no district.
UNPLACED_TAG = "placement:unknown"
#: Tags of a camera that replays a recording; it covers no real place.
RECORDED_TAGS = ("recorded-footage", "not-a-real-camera")

#: How far back the latest probe is looked for when deciding whether a
#: camera's status is being held at its last known value.
STALE_LOOKBACK = timedelta(minutes=15)
#: How far back a camera's last answered probe is looked for.
CONFIRMED_LOOKBACK = timedelta(hours=24)

#: Where the district boundaries are. Mounted at /data/seed in the containers;
#: beside the repository when run from a checkout.
_DISTRICT_FILES = (
    Path("/data/seed/gujarat_districts.geojson"),
    Path(__file__).resolve().parents[4] / "data" / "seed" / "gujarat_districts.geojson",
)


# ── Status staleness ──────────────────────────────────────────────────


def _answered() -> Any:
    """Probes that got an answer about the camera, good or bad."""
    return or_(
        CameraHealth.error_code.is_(None),
        CameraHealth.error_code.not_in(sorted(STATUS_HOLD_ERRORS)),
    )


async def status_staleness(
    session: AsyncSession, camera_ids: list[uuid.UUID] | None = None
) -> dict[uuid.UUID, dict[str, Any]]:
    """Cameras whose shown status is the last known one, and since when.

    A camera is stale when its latest probe could not ask about it at all —
    its integration refused our session or did not answer — so the health
    monitor left its status alone (see `health_monitor`). For each, the cause
    and when a probe last got an answer about it.
    """
    since = datetime.now(UTC) - STALE_LOOKBACK
    latest = (
        select(CameraHealth.camera_id, CameraHealth.reachable, CameraHealth.error_code)
        .distinct(CameraHealth.camera_id)
        .where(CameraHealth.ts >= since)
        .order_by(CameraHealth.camera_id, CameraHealth.ts.desc())
    )
    if camera_ids is not None:
        if not camera_ids:
            return {}
        latest = latest.where(CameraHealth.camera_id.in_(camera_ids))
    held = {
        camera_id: error_code
        for camera_id, reachable, error_code in (await session.execute(latest)).all()
        if not reachable and error_code in STATUS_HOLD_ERRORS
    }
    if not held:
        return {}

    confirmed_since = datetime.now(UTC) - CONFIRMED_LOOKBACK
    last_answer = (
        select(CameraHealth.ts)
        .where(
            CameraHealth.camera_id == Camera.id,
            CameraHealth.ts >= confirmed_since,
            _answered(),
        )
        .order_by(CameraHealth.ts.desc())
        .limit(1)
        .correlate(Camera)
        .scalar_subquery()
    )
    rows = (
        await session.execute(
            select(Camera.id, Camera.vms_id, last_answer).where(Camera.id.in_(list(held)))
        )
    ).all()
    return {
        camera_id: {"error_code": held[camera_id], "confirmed_at": confirmed, "vms_id": vms_id}
        for camera_id, vms_id, confirmed in rows
    }


async def annotate_staleness(session: AsyncSession, cameras: list[Any]) -> None:
    """Mark each camera (a `CameraOut`) whose status is held at its last known value."""
    stale = await status_staleness(session, [c.id for c in cameras])
    for camera in cameras:
        entry = stale.get(camera.id)
        if entry is not None:
            camera.status_stale_reason = entry["error_code"]
            camera.status_confirmed_at = entry["confirmed_at"]


async def _integration_states(
    session: AsyncSession, stale: dict[uuid.UUID, dict[str, Any]]
) -> list[dict[str, Any]]:
    """One line per integration that could not be asked about its cameras."""
    by_vms: dict[uuid.UUID, list[dict[str, Any]]] = {}
    for entry in stale.values():
        if entry["vms_id"] is not None:
            by_vms.setdefault(entry["vms_id"], []).append(entry)
    if not by_vms:
        return []
    names = {
        vms_id: (name, vendor)
        for vms_id, name, vendor in (
            await session.execute(
                select(VmsInstance.id, VmsInstance.name, VmsInstance.vendor).where(
                    VmsInstance.id.in_(list(by_vms))
                )
            )
        ).all()
    }
    states = []
    for vms_id, entries in by_vms.items():
        open_alert = await session.scalar(
            select(Alert.created_at)
            .where(
                Alert.alert_type == "camera_down",
                Alert.camera_id.is_(None),
                Alert.status.in_(("new", "acknowledged", "dispatched")),
                Alert.notes.like(f"%vms:{vms_id}%"),
            )
            .order_by(Alert.created_at.desc())
            .limit(1)
        )
        codes = {entry["error_code"] for entry in entries}
        confirmed = [e["confirmed_at"] for e in entries if e["confirmed_at"] is not None]
        name, vendor = names.get(vms_id, (str(vms_id), None))
        states.append(
            {
                "vms_id": str(vms_id),
                "name": name,
                "vendor": vendor,
                "state": "refused" if "grid_refused" in codes else "unreachable",
                "error_code": "grid_refused" if "grid_refused" in codes else sorted(codes)[0],
                "cameras_held": len(entries),
                # The last moment any of its cameras got an answer.
                "last_answered_at": max(confirmed).isoformat() if confirmed else None,
                "alarm_open_since": open_alert.isoformat() if open_alert else None,
            }
        )
    return sorted(states, key=lambda s: -int(s["cameras_held"]))


async def fleet_health(session: AsyncSession) -> dict[str, Any]:
    """Live fleet rollup for the dashboard and `/health/fleet`."""
    status_rows = (
        await session.execute(select(Camera.status, func.count(Camera.id)).group_by(Camera.status))
    ).all()
    by_status = {status or "unknown": count for status, count in status_rows}
    total = sum(by_status.values())

    # Per-department health, so a commissioner can see which department's
    # estate is degrading rather than only a statewide average.
    dept_rows = (
        await session.execute(
            select(
                func.coalesce(Department.code, "UNASSIGNED"),
                func.count(Camera.id),
                func.count(case((Camera.status == "online", 1))),
                func.count(case((Camera.status == "offline", 1))),
                func.count(case((Camera.status == "degraded", 1))),
            )
            .select_from(Camera)
            .outerjoin(Department, Camera.department_id == Department.id)
            .group_by(Department.code)
            .order_by(func.count(Camera.id).desc())
        )
    ).all()

    vendor_rows = (
        await session.execute(
            select(
                func.coalesce(VmsInstance.vendor, "unassigned"),
                func.count(Camera.id),
                func.count(case((Camera.status == "online", 1))),
            )
            .select_from(Camera)
            .outerjoin(VmsInstance, Camera.vms_id == VmsInstance.id)
            .group_by(VmsInstance.vendor)
            .order_by(func.count(Camera.id).desc())
        )
    ).all()

    # Most common failure reasons in the last hour. Grouping by error code is
    # what turns "31 cameras down" into "one expired credential", because a
    # whole department failing with `unauthorized` has a single cause.
    since = datetime.now(UTC) - timedelta(hours=1)
    error_rows = (
        await session.execute(
            select(CameraHealth.error_code, func.count())
            .where(
                and_(
                    CameraHealth.ts >= since,
                    CameraHealth.error_code.is_not(None),
                )
            )
            .group_by(CameraHealth.error_code)
            .order_by(func.count().desc())
            .limit(10)
        )
    ).all()

    online = by_status.get("online", 0)
    offline = by_status.get("offline", 0)
    degraded = by_status.get("degraded", 0)
    unknown = by_status.get("unknown", 0)

    # A camera we have never successfully reached is *not yet integrated* — it
    # is registered, but no live feed is attached. Averaging those into
    # availability would understate the health of the estate we actually run,
    # and overstate the size of the outage when something genuinely breaks.
    # Both numbers are reported so neither can mislead.
    integrated = online + offline + degraded

    stale = await status_staleness(session)

    return {
        "total": total,
        "online": online,
        "offline": offline,
        "degraded": degraded,
        "unknown": unknown,
        "integrated": integrated,
        "awaiting_integration": unknown,
        # Cameras shown at their last known status because their integration
        # could not be asked this time — a count across the states above.
        "stale": len(stale),
        "integrations": await _integration_states(session, stale),
        "availability_pct": round(online / total * 100, 1) if total else 0.0,
        "integrated_availability_pct": (
            round(online / integrated * 100, 1) if integrated else None
        ),
        "by_department": [
            {
                "department": code,
                "total": count,
                "online": on,
                "offline": off,
                "degraded": deg,
                "availability_pct": round(on / count * 100, 1) if count else 0.0,
            }
            for code, count, on, off, deg in dept_rows
        ],
        "by_vendor": [
            {
                "vendor": vendor,
                "total": count,
                "online": on,
                "availability_pct": round(on / count * 100, 1) if count else 0.0,
            }
            for vendor, count, on in vendor_rows
        ],
        "top_errors": [{"error_code": code, "count": count} for code, count in error_rows],
        "generated_at": datetime.now(UTC).isoformat(),
    }


async def camera_health_history(
    session: AsyncSession, camera_id: uuid.UUID, *, hours: int = 24, limit: int = 500
) -> list[dict[str, Any]]:
    """Recent probe history for one camera — the detail-page sparklines."""
    since = datetime.now(UTC) - timedelta(hours=hours)
    rows = (
        await session.execute(
            select(
                CameraHealth.ts,
                CameraHealth.reachable,
                CameraHealth.fps_actual,
                CameraHealth.latency_ms,
                CameraHealth.bitrate_kbps,
                CameraHealth.error_code,
            )
            .where(and_(CameraHealth.camera_id == camera_id, CameraHealth.ts >= since))
            .order_by(CameraHealth.ts.desc())
            .limit(limit)
        )
    ).all()

    return [
        {
            "ts": ts.isoformat(),
            "reachable": reachable,
            "fps_actual": fps,
            "latency_ms": latency,
            "bitrate_kbps": bitrate,
            "error_code": error,
        }
        for ts, reachable, fps, latency, bitrate, error in rows
    ]


async def uptime_summary(
    session: AsyncSession, camera_id: uuid.UUID, *, hours: int = 24
) -> dict[str, Any]:
    """Uptime percentage and average latency for one camera.

    Uptime is over the probes that got an answer. A probe its integration
    refused said nothing about the camera, so it is counted apart
    (`not_asked`) rather than as the camera being down.
    """
    since = datetime.now(UTC) - timedelta(hours=hours)
    answered = _answered()
    row = (
        await session.execute(
            select(
                func.count(case((answered, 1))),
                func.count(case((and_(answered, CameraHealth.reachable.is_(True)), 1))),
                func.count(),
                func.avg(CameraHealth.latency_ms),
                func.avg(CameraHealth.fps_actual),
            ).where(and_(CameraHealth.camera_id == camera_id, CameraHealth.ts >= since))
        )
    ).one()

    probes, reachable, every, avg_latency, avg_fps = row
    return {
        "window_hours": hours,
        "probes": probes or 0,
        "not_asked": (every or 0) - (probes or 0),
        "uptime_pct": round(reachable / probes * 100, 1) if probes else None,
        "avg_latency_ms": round(float(avg_latency), 1) if avg_latency else None,
        "avg_fps": round(float(avg_fps), 1) if avg_fps else None,
    }


# ── Geography ─────────────────────────────────────────────────────────


@lru_cache(maxsize=1)
def gujarat_districts() -> tuple[tuple[str, Any], ...]:
    """Gujarat's 33 districts as (name, prepared polygon), read once.

    Empty when the boundary file is missing, which the gap report then says
    rather than inventing a geography.
    """
    from shapely.geometry import shape
    from shapely.prepared import prep

    for path in _DISTRICT_FILES:
        if path.exists():
            features = json.loads(path.read_text(encoding="utf-8")).get("features") or []
            return tuple(
                (str(f["properties"]["district"]), prep(shape(f["geometry"])))
                for f in features
                if f.get("geometry") and (f.get("properties") or {}).get("district")
            )
    log.warning("fleet.district_boundaries_missing", looked_in=[str(p) for p in _DISTRICT_FILES])
    return ()


def district_at(lat: float | None, lon: float | None) -> str | None:
    """The Gujarat district a point falls in, or None outside every one."""
    if lat is None or lon is None:
        return None
    from shapely.geometry import Point

    point = Point(lon, lat)
    for name, polygon in gujarat_districts():
        if polygon.contains(point):
            return name
    return None


def _years_between(start: date, end: date) -> float:
    return round((end - start).days / 365.25, 1)


async def gap_analysis(session: AsyncSession, *, hours: int = 24) -> dict[str, Any]:
    """Where the estate is blind.

    A named Model 1 deliverable. Distinguishes failure modes that need
    different responses: fix the camera, steady it, install a camera, add
    plate reading, or replace ageing equipment.
    """
    now = datetime.now(UTC)
    since = now - timedelta(hours=hours)
    districts = gujarat_districts()

    # ── Every camera, placed in its district by position ─────────────
    geometry = cast(Camera.location, Geometry)
    cameras = (
        await session.execute(
            select(
                Camera.id,
                Camera.camera_code,
                Camera.name,
                Camera.district,
                Camera.status,
                Camera.anpr_enabled,
                Camera.installed_on,
                Camera.tags,
                func.ST_Y(geometry),
                func.ST_X(geometry),
                func.coalesce(Department.code, "UNASSIGNED"),
            )
            .outerjoin(Department, Camera.department_id == Department.id)
            .order_by(Camera.camera_code)
            .limit(100_000)
        )
    ).all()

    district_of: dict[str, str | None] = {}
    position_unknown: list[str] = []
    recorded: list[str] = []
    outside: list[str] = []
    per_district: dict[str, dict[str, int]] = {
        name: {"cameras": 0, "anpr": 0, "online": 0} for name, _ in districts
    }
    for _id, code, _name, text_district, status, anpr, _installed, tags, lat, lon, _dept in cameras:
        tag_set = set(tags or ())
        if tag_set & set(RECORDED_TAGS):
            recorded.append(code)
            district_of[code] = None
            continue
        if UNPLACED_TAG in tag_set:
            position_unknown.append(code)
            district_of[code] = None
            continue
        where = district_at(lat, lon) if districts else text_district
        district_of[code] = where
        if where is None:
            outside.append(code)
            continue
        counts = per_district.setdefault(where, {"cameras": 0, "anpr": 0, "online": 0})
        counts["cameras"] += 1
        counts["anpr"] += 1 if anpr else 0
        counts["online"] += 1 if status == "online" else 0

    # ── Availability: cameras registered but not delivering ──────────
    availability_gaps = [
        {
            "camera_code": code,
            "name": name,
            "district": district_of.get(code) or text_district,
            "status": status,
            "department": dept,
        }
        for _id, code, name, text_district, status, *_rest, dept in cameras
        if status in ("offline", "degraded")
    ][:500]

    # ── Capability and coverage, per district ────────────────────────
    capability_gaps = []
    coverage_gaps = []
    district_coverage = []
    for name, counts in sorted(per_district.items(), key=lambda kv: (-kv[1]["cameras"], kv[0])):
        total, anpr, online = counts["cameras"], counts["anpr"], counts["online"]
        share = anpr / total if total else 0.0
        entry = {
            "district": name,
            "cameras": total,
            "anpr_cameras": anpr,
            "online": online,
            "anpr_share": round(share, 3),
            "availability_pct": round(online / total * 100, 1) if total else 0.0,
        }
        district_coverage.append(entry)
        if total == 0:
            coverage_gaps.append(
                {
                    "district": name,
                    "reason": (
                        "No camera with a known position in this district. A vehicle can "
                        "cross it without being seen."
                    ),
                }
            )
        elif share < ANPR_COVERAGE_TARGET:
            capability_gaps.append(
                {
                    **entry,
                    "reason": (
                        f"Only {round(share * 100)}% of cameras in this district read "
                        f"plates (target {round(ANPR_COVERAGE_TARGET * 100)}%). A vehicle "
                        "can cross it without being recorded."
                    ),
                }
            )

    # ── Reliability: cameras that flap ───────────────────────────────
    # Over the probes that got an answer: a probe the integration refused is
    # the integration's outage, reported once as such, not the camera's.
    answered = _answered()
    answered_count = func.count(case((answered, 1)))
    reachable_count = func.count(case((and_(answered, CameraHealth.reachable.is_(True)), 1)))
    flapping_rows = (
        await session.execute(
            select(
                Camera.camera_code,
                Camera.name,
                Camera.district,
                answered_count,
                reachable_count,
            )
            .join(CameraHealth, CameraHealth.camera_id == Camera.id)
            .where(CameraHealth.ts >= since)
            .group_by(Camera.camera_code, Camera.name, Camera.district)
            .having(
                and_(
                    answered_count >= 5,
                    cast(reachable_count, Float) / cast(answered_count, Float)
                    < UPTIME_RELIABILITY_TARGET,
                )
            )
            .order_by(cast(reachable_count, Float) / cast(answered_count, Float))
            .limit(100)
        )
    ).all()

    # ── Ageing infrastructure ────────────────────────────────────────
    today = now.date()
    ageing_gaps = []
    undated: list[str] = []
    for _id, code, name, text_district, *_r, installed, _tags, _lat, _lon, _dept in cameras:
        if installed is None:
            undated.append(code)
            continue
        age = _years_between(installed, today)
        if age >= AGEING_AFTER_YEARS:
            ageing_gaps.append(
                {
                    "camera_code": code,
                    "name": name,
                    "district": district_of.get(code) or text_district,
                    "installed_on": installed.isoformat(),
                    "age_years": age,
                    "reason": (
                        f"Installed {age} years ago (review after {AGEING_AFTER_YEARS}): "
                        "optics, recorder and power supply are due for inspection."
                    ),
                }
            )
    ageing_gaps.sort(key=lambda g: -float(g["age_years"]))

    return {
        "window_hours": hours,
        "generated_at": now.isoformat(),
        "geography": {
            "basis": (
                f"Gujarat's {len(districts)} districts; each camera is placed in the "
                "district its registered position falls in."
                if districts
                else "District boundaries unavailable: districts are as typed in the registry."
            ),
            "districts": len(districts),
            "position_unknown": position_unknown,
            "recorded_footage": recorded,
            "outside_gujarat": outside,
        },
        "summary": {
            "unavailable_cameras": len(availability_gaps),
            "districts_below_anpr_target": len(capability_gaps),
            "districts_with_no_cameras": len(coverage_gaps),
            "unreliable_cameras": len(flapping_rows),
            "ageing_cameras": len(ageing_gaps),
            "install_date_unknown": len(undated),
        },
        "availability_gaps": availability_gaps,
        "capability_gaps": capability_gaps,
        "coverage_gaps": coverage_gaps,
        "reliability_gaps": [
            {
                "camera_code": code,
                "name": name,
                "district": district_of.get(code) or district,
                "probes": probes,
                "uptime_pct": round(reachable / probes * 100, 1) if probes else 0.0,
                "reason": "Intermittent — repeatedly dropping in and out",
            }
            for code, name, district, probes, reachable in flapping_rows
        ],
        "ageing_gaps": ageing_gaps,
        "install_date_unknown": {
            "cameras": len(undated),
            "camera_codes": undated[:500],
            "reason": (
                "Install date not recorded, so the age of this equipment cannot be "
                "judged. Ask the owning department; nothing is assumed."
            ),
        },
        "district_coverage": district_coverage,
    }
