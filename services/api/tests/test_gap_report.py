"""The gap report as CSV.

Fleet health's gap analysis, as a file someone can be sent: one row per gap,
each kind named, times in IST and UTC, a byte-order mark so a spreadsheet on a
Windows desk reads it, and an audit row per download. The analysis itself is
tested in `test_fleet_health.py`; what is pinned here is the file.
"""

from __future__ import annotations

import csv
import io
from datetime import UTC, datetime, timedelta

import pytest
from httpx import AsyncClient
from sqlalchemy import select

from app.db.session import SessionLocal
from app.models.registry import Camera, Department
from app.models.security import AuditLog
from app.routers import gap_report
from app.services import fleet

pytestmark = pytest.mark.integration

GENERATED = datetime(2026, 10, 12, 4, 30, tzinfo=UTC)


def _rows(body: str) -> list[dict[str, str]]:
    return list(csv.DictReader(io.StringIO(body.lstrip("﻿"))))


@pytest.fixture
async def a_camera() -> tuple[str, str]:
    """Any registered camera with an owning department, for a gap to name."""
    async with SessionLocal() as session:
        row = (
            await session.execute(
                select(Camera.camera_code, Department.code)
                .join(Department, Department.id == Camera.department_id)
                .order_by(Camera.camera_code)
                .limit(1)
            )
        ).first()
    if row is None:
        pytest.skip("no camera with a department — run scripts/seed.py")
    return row[0], row[1]


@pytest.fixture
def gaps(monkeypatch: pytest.MonkeyPatch, a_camera: tuple[str, str]):
    """A fixed analysis, one gap of each kind, so the file's shape is pinned
    whatever state the live fleet happens to be in."""
    code, _ = a_camera

    async def fixed(_session, *, hours: int = 24):
        return {
            "window_hours": hours,
            "generated_at": GENERATED.isoformat(),
            "summary": {
                "unavailable_cameras": 1,
                "districts_below_anpr_target": 1,
                "districts_with_no_cameras": 1,
                "unreliable_cameras": 1,
            },
            "availability_gaps": [
                {
                    "camera_code": code,
                    "name": "Offline camera",
                    "district": "Sabarmati",
                    "status": "offline",
                    "department": "MUNICIPAL",
                }
            ],
            "reliability_gaps": [
                {
                    "camera_code": code,
                    "name": "Flapping camera",
                    "district": None,
                    "probes": 40,
                    "uptime_pct": 57.5,
                    "reason": "Intermittent — repeatedly dropping in and out",
                }
            ],
            "coverage_gaps": [
                {"district": "Vatva", "reason": "No cameras registered in this district"}
            ],
            "capability_gaps": [
                {
                    "district": "Maninagar",
                    "cameras": 5,
                    "anpr_cameras": 1,
                    "online": 4,
                    "anpr_share": 0.2,
                    "availability_pct": 80.0,
                    "reason": "Only 20% of cameras in this district read plates (target 40%).",
                }
            ],
            "ageing_gaps": [
                {
                    "camera_code": code,
                    "name": "Old camera",
                    "district": "Dang",
                    "installed_on": "2014-03-01",
                    "age_years": 12.6,
                    "reason": "Installed 12.6 years ago (review after 5): due for inspection.",
                }
            ],
            "install_date_unknown": {
                "cameras": 1,
                "camera_codes": [code],
                "reason": "Install date not recorded; nothing is assumed.",
            },
            "geography": {
                "districts": 33,
                "position_unknown": [code],
                "recorded_footage": [],
                "outside_gujarat": [],
            },
            "district_coverage": [],
        }

    monkeypatch.setattr(fleet, "gap_analysis", fixed)


async def test_one_row_per_gap_each_kind_named(client: AsyncClient, auth_headers, gaps) -> None:
    response = await client.get("/api/v1/reports/gaps.csv", headers=await auth_headers("auditor"))
    assert response.status_code == 200, response.text
    assert response.headers["content-type"].startswith("text/csv")
    assert response.text.startswith("﻿"), "no byte-order mark"
    assert (
        'filename="gap-report-20261011-1000-to-20261012-1000.csv"'
        in (response.headers["content-disposition"])
    )
    rows = _rows(response.text)
    assert list(rows[0]) == gap_report.GAP_COLUMNS
    assert [r["gap_type"] for r in rows] == [
        "unavailable",
        "unreliable",
        "no_cameras",
        "below_anpr_target",
        "ageing",
        "install_date_unknown",
        "position_unknown",
    ]
    unavailable, unreliable, uncovered, thin, ageing, undated, unplaced = rows
    assert "no video" in unavailable["reason"]
    assert unreliable["uptime_pct"] == "57.5" and unreliable["probes"] == "40"
    assert uncovered["district"] == "Vatva" and uncovered["cameras"] == "0"
    assert thin["anpr_share_pct"] == "20.0" and thin["anpr_cameras"] == "1"
    assert ageing["installed_on"] == "2014-03-01" and ageing["age_years"] == "12.6"
    assert ageing["district"] == "Dang"
    assert undated["installed_on"] == "" and "nothing is assumed" in undated["reason"]
    assert undated["camera_name"], "a camera row without its name"
    assert "counted in no district" in unplaced["reason"]
    assert all(len(r) == len(gap_report.GAP_COLUMNS) for r in rows)


async def test_the_window_is_given_in_ist_and_utc(client: AsyncClient, auth_headers, gaps) -> None:
    rows = _rows(
        (await client.get("/api/v1/reports/gaps.csv", headers=await auth_headers("auditor"))).text
    )
    for row in rows:
        assert row["window_end_utc"] == "2026-10-12T04:30:00+00:00"
        assert row["window_end_ist"] == "2026-10-12 10:00:00"
        assert row["window_start_ist"] == "2026-10-11 10:00:00"


async def test_a_flapping_camera_carries_its_department_from_the_registry(
    client: AsyncClient, auth_headers, gaps, a_camera
) -> None:
    """The analysis does not report one for an unreliable camera; whoever is
    sent to fix it needs to know whose it is."""
    _, department = a_camera
    rows = _rows(
        (await client.get("/api/v1/reports/gaps.csv", headers=await auth_headers("auditor"))).text
    )
    assert rows[1]["department"] == department


async def test_every_download_is_audited(client: AsyncClient, auth_headers, gaps) -> None:
    before = datetime.now(UTC) - timedelta(seconds=1)
    await client.get(
        "/api/v1/reports/gaps.csv", params={"hours": 6}, headers=await auth_headers("analyst")
    )
    async with SessionLocal() as session:
        row = await session.scalar(
            select(AuditLog)
            .where(AuditLog.action == "report.gaps", AuditLog.ts >= before)
            .order_by(AuditLog.ts.desc())
            .limit(1)
        )
    assert row is not None
    assert row.username == "analyst"
    assert row.params["window_hours"] == 6 and row.params["rows"] == 7


async def test_the_live_analysis_exports(client: AsyncClient, auth_headers) -> None:
    """Unpatched, against whatever the fleet is doing now."""
    response = await client.get("/api/v1/reports/gaps.csv", headers=await auth_headers("auditor"))
    assert response.status_code == 200
    for row in _rows(response.text):
        assert row["gap_type"] in {
            "unavailable",
            "unreliable",
            "no_cameras",
            "below_anpr_target",
            "ageing",
            "install_date_unknown",
            "position_unknown",
        }
        assert row["reason"]


async def test_a_machine_identity_cannot_download_it(client: AsyncClient, auth_headers) -> None:
    response = await client.get(
        "/api/v1/reports/gaps.csv", headers=await auth_headers("api_client")
    )
    assert response.status_code == 403
