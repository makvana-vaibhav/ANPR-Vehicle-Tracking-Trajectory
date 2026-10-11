"""Reports: the route of one vehicle, and the plates read in a window, as CSV.

The submission asks for a report of detected plates with timestamps, and the
live test ends by handing one over. What these pin is what makes a report
fileable: every visit in order with the leg that led to it, times in IST and
UTC, nothing silently dropped — a sighting at a camera with no known position
is a row, not a gap — and an audit row for every export.

The sightings are timestamped in May 2024, where nothing real is, so the
route-history daemon (which looks back six hours) never sees them.
"""

from __future__ import annotations

import csv
import io
import uuid
from datetime import UTC, datetime, timedelta

import pytest
from httpx import AsyncClient
from sqlalchemy import select, text

from app.db.session import SessionLocal
from app.models.intelligence import Detection
from app.models.security import AuditLog
from app.routers import reports

pytestmark = pytest.mark.integration

PREFIX = "ZZREPORT"
T0 = datetime(2024, 5, 6, 8, 0, 0, tzinfo=UTC)
WINDOW = {"since": "2024-05-06T07:00:00Z", "until": "2024-05-06T11:00:00Z"}


def _rows(body: str) -> list[dict[str, str]]:
    return list(csv.DictReader(io.StringIO(body.lstrip("﻿"))))


@pytest.fixture
async def journey():
    """One plate seen twice at a placed camera, once at another placed camera
    over 10 km away, and once at a camera whose position is a placeholder."""
    async with SessionLocal() as session:
        pair = (
            await session.execute(
                text(
                    "SELECT a.id AS a_id, a.camera_code AS a_code,"
                    " b.id AS b_id, b.camera_code AS b_code FROM cameras a"
                    " JOIN cameras b ON a.camera_code < b.camera_code"
                    " WHERE a.location IS NOT NULL AND b.location IS NOT NULL"
                    " AND NOT ('placement:unknown' = ANY(a.tags))"
                    " AND NOT ('placement:unknown' = ANY(b.tags))"
                    " AND ST_Distance(a.location::geography, b.location::geography) > 10000"
                    " ORDER BY a.camera_code, b.camera_code LIMIT 1"
                )
            )
        ).mappings().first()
        unplaced = (
            await session.execute(
                text(
                    "SELECT id, camera_code FROM cameras"
                    " WHERE 'placement:unknown' = ANY(tags) ORDER BY camera_code LIMIT 1"
                )
            )
        ).mappings().first()
    if pair is None or unplaced is None:
        pytest.skip("needs two placed cameras 10 km apart and one unplaced — run the grid sync")

    plate = f"{PREFIX}{uuid.uuid4().hex[:4].upper()}"
    sightings = [
        (pair["a_id"], T0, 0.81),
        (pair["a_id"], T0 + timedelta(seconds=30), 0.97),
        (pair["b_id"], T0 + timedelta(minutes=40), 0.88),
        (unplaced["id"], T0 + timedelta(minutes=50), 0.9),
    ]
    ids = [uuid.uuid4() for _ in sightings]
    async with SessionLocal() as session:
        for detection_id, (camera_id, ts, confidence) in zip(ids, sightings, strict=True):
            session.add(
                Detection(
                    id=detection_id,
                    ts=ts,
                    camera_id=camera_id,
                    track_id=f"report-test-{detection_id.hex[:8]}",
                    plate_normalised=plate,
                    plate_confidence=confidence,
                    vehicle_type="car",
                )
            )
        await session.commit()
    yield {
        "plate": plate,
        "a": pair["a_code"],
        "b": pair["b_code"],
        "unplaced": unplaced["camera_code"],
        "ids": ids,
    }
    async with SessionLocal() as session:
        await session.execute(
            text("DELETE FROM detections WHERE plate_normalised LIKE :p"), {"p": f"{PREFIX}%"}
        )
        await session.commit()


class TestTheRouteReport:
    async def test_every_visit_in_order_with_the_leg_that_led_to_it(
        self, client: AsyncClient, auth_headers, journey
    ) -> None:
        response = await client.get(
            f"/api/v1/reports/vehicle/{journey['plate']}.csv",
            params=WINDOW,
            headers=await auth_headers("analyst"),
        )
        assert response.status_code == 200, response.text
        assert response.headers["content-type"].startswith("text/csv")
        assert journey["plate"] in response.headers["content-disposition"]

        rows = _rows(response.text)
        assert [r["camera_code"] for r in rows] == [journey["a"], journey["b"], journey["unplaced"]]
        first, second, unplaced = rows

        # Two sightings 30 s apart at one camera are one visit, evidenced by
        # the better read of the two.
        assert first["visit"] == "1" and first["sightings"] == "2"
        assert first["best_read_confidence"] == "0.97"
        assert first["evidence_detection_id"] == str(journey["ids"][1])
        assert first["km_from_previous"] == ""

        assert second["visit"] == "2"
        assert float(second["km_from_previous"]) > 10
        assert second["minutes_from_previous"] == "39.5"
        # Whichever two cameras the fleet offers, the verdict must be the one
        # the speed implies — and say why when it is "no".
        kmph = float(second["implied_kmph"])
        assert kmph == pytest.approx(float(second["km_from_previous"]) / (39.5 / 60), rel=0.01)
        if kmph > 150:
            assert second["plausible"] == "no"
            assert "faster than any vehicle" in second["notes"]
        else:
            assert second["plausible"] == "yes"

    async def test_a_sighting_at_an_unplaced_camera_is_a_row_not_a_gap(
        self, client: AsyncClient, auth_headers, journey
    ) -> None:
        response = await client.get(
            f"/api/v1/reports/vehicle/{journey['plate']}.csv",
            params=WINDOW,
            headers=await auth_headers("analyst"),
        )
        unplaced = _rows(response.text)[-1]
        assert unplaced["visit"] == ""
        assert unplaced["latitude"] == "" and unplaced["longitude"] == ""
        assert unplaced["implied_kmph"] == ""
        assert "position unknown" in unplaced["notes"]
        assert unplaced["evidence_detection_id"] == str(journey["ids"][3])

    async def test_times_are_given_in_ist_and_utc(
        self, client: AsyncClient, auth_headers, journey
    ) -> None:
        response = await client.get(
            f"/api/v1/reports/vehicle/{journey['plate']}.csv",
            params=WINDOW,
            headers=await auth_headers("analyst"),
        )
        first = _rows(response.text)[0]
        assert first["arrived_ist"] == "2024-05-06 13:30:00"
        assert first["arrived_utc"] == "2024-05-06T08:00:00+00:00"

    async def test_the_export_is_audited(
        self, client: AsyncClient, auth_headers, journey
    ) -> None:
        await client.get(
            f"/api/v1/reports/vehicle/{journey['plate']}.csv",
            params=WINDOW,
            headers=await auth_headers("analyst"),
        )
        async with SessionLocal() as session:
            row = await session.scalar(
                select(AuditLog)
                .where(AuditLog.action == "search.plate", AuditLog.resource_id == journey["plate"])
                .order_by(AuditLog.ts.desc())
                .limit(1)
            )
        assert row is not None
        assert row.params["filters"]["action"] == "report.route.csv"
        assert row.username == "analyst"

    async def test_the_route_itself_keeps_the_placeholder_off_the_map(
        self, client: AsyncClient, auth_headers, journey
    ) -> None:
        """The bug under the report: a placeholder camera used to be a hop at
        the centre of the state, with a distance and a speed to it."""
        response = await client.get(
            f"/api/v1/vehicles/{journey['plate']}/route",
            params=WINDOW,
            headers=await auth_headers("analyst"),
        )
        body = response.json()
        assert [h["camera_code"] for h in body["hops"]] == [journey["a"], journey["b"]]
        assert [s["camera_code"] for s in body["unplaced_sightings"]] == [journey["unplaced"]]

    async def test_a_plate_too_short_to_search_is_refused(
        self, client: AsyncClient, auth_headers
    ) -> None:
        response = await client.get(
            "/api/v1/reports/vehicle/GJ.csv", headers=await auth_headers("analyst")
        )
        assert response.status_code == 422

    async def test_it_needs_the_right_to_search(self, client: AsyncClient, auth_headers) -> None:
        response = await client.get(
            "/api/v1/reports/vehicle/GJ03AB1234.csv", headers=await auth_headers("auditor")
        )
        assert response.status_code == 403


class TestThePlateList:
    async def test_one_row_per_read_in_the_window(
        self, client: AsyncClient, auth_headers, journey
    ) -> None:
        response = await client.get(
            "/api/v1/reports/plates.csv",
            params={**WINDOW, "plate": journey["plate"]},
            headers=await auth_headers("analyst"),
        )
        assert response.status_code == 200, response.text
        rows = _rows(response.text)
        assert [r["detection_id"] for r in rows] == [str(i) for i in journey["ids"]]
        assert rows[0]["time_ist"] == "2024-05-06 13:30:00"
        assert rows[-1]["latitude"] == "", "a placeholder position passed off as a location"
        assert rows[0]["latitude"] != ""

    async def test_a_window_too_large_is_refused_with_its_size(
        self, client: AsyncClient, auth_headers, journey, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """Refused rather than quietly cut: a truncated report reads as complete."""
        monkeypatch.setattr(reports, "MAX_ROWS", 2)
        response = await client.get(
            "/api/v1/reports/plates.csv",
            params={**WINDOW, "plate": journey["plate"]},
            headers=await auth_headers("analyst"),
        )
        assert response.status_code == 422
        assert "4 plate reads" in response.json()["detail"]

    async def test_a_window_that_ends_before_it_starts_is_refused(
        self, client: AsyncClient, auth_headers
    ) -> None:
        response = await client.get(
            "/api/v1/reports/plates.csv",
            params={"since": WINDOW["until"], "until": WINDOW["since"]},
            headers=await auth_headers("analyst"),
        )
        assert response.status_code == 422

    async def test_a_list_without_a_plate_is_audited_too(
        self, client: AsyncClient, auth_headers, journey
    ) -> None:
        """Every vehicle on the network in a window is the larger disclosure."""
        await client.get(
            "/api/v1/reports/plates.csv", params=WINDOW, headers=await auth_headers("analyst")
        )
        async with SessionLocal() as session:
            row = await session.scalar(
                select(AuditLog)
                .where(AuditLog.action == "report.plates")
                .order_by(AuditLog.ts.desc())
                .limit(1)
            )
        assert row is not None
        assert row.params["results"] >= 4
