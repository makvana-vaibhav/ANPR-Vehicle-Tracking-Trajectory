"""`/api/v1/analytics/traffic` says when its bounded read stopped short.

The endpoint reads at most `MAX_OBSERVATION_ROWS` detections. It used to read
them oldest first and say nothing, so a window holding 27,000 vehicles was
reported as "20,000 vehicles" — for 24 h and for 7 d alike — and every road
figure described the start of the window rather than now. The web screen
mirrored the cap to guess when that had happened. The response now carries
`truncated`, `rows_read` and `rows_total`, and the read is newest first.

Rows are synthetic, in a fixed hour of 2024 nothing else writes to (the same
isolation `test_analytics.py` uses), on a camera borrowed from the registry.
"""

from __future__ import annotations

import uuid
from datetime import UTC, datetime, timedelta

import pytest
from httpx import AsyncClient
from sqlalchemy import text

from app.db.session import SessionLocal
from app.models.intelligence import Detection
from app.routers import analytics

pytestmark = pytest.mark.integration

WINDOW_START = datetime(2024, 3, 5, 9, 0, 0, tzinfo=UTC)
WINDOW_END = WINDOW_START + timedelta(hours=1)
TRACK_PREFIX = "traffic-read-test-"

#: Five vehicles, one a minute, each stopped long enough to be listed as a
#: possible obstruction — which is the one place the response names the
#: individual rows it read, so the test can see *which* rows those were.
SEEN_AT = [WINDOW_START + timedelta(minutes=m) for m in (1, 2, 3, 4, 5)]


async def _cleanup() -> None:
    async with SessionLocal() as session:
        await session.execute(
            text("DELETE FROM detections WHERE track_id LIKE :p"), {"p": f"{TRACK_PREFIX}%"}
        )
        await session.commit()


@pytest.fixture(autouse=True)
async def _synthetic_rows():
    await _cleanup()
    async with SessionLocal() as session:
        camera_id = (
            await session.execute(text("SELECT id FROM cameras ORDER BY camera_code LIMIT 1"))
        ).scalar()
        if camera_id is None:
            pytest.skip("no camera registered — run scripts/seed.py")
        for index, ts in enumerate(SEEN_AT):
            session.add(
                Detection(
                    id=uuid.uuid4(),
                    ts=ts,
                    camera_id=camera_id,
                    track_id=f"{TRACK_PREFIX}{uuid.uuid4().hex[:8]}-{index}",
                    vehicle_type="car",
                    direction="stationary",
                    dwell_s=600.0,
                )
            )
        await session.commit()
    yield
    await _cleanup()


async def _traffic(client: AsyncClient, auth_headers) -> dict:
    response = await client.get(
        "/api/v1/analytics/traffic",
        params={"since": WINDOW_START.isoformat(), "until": WINDOW_END.isoformat()},
        headers=await auth_headers("analyst"),
    )
    assert response.status_code == 200, response.text
    return response.json()


class TestTheBoundedRead:
    async def test_a_window_over_the_cap_says_so_and_keeps_the_latest(
        self, client: AsyncClient, auth_headers, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.setattr(analytics, "MAX_OBSERVATION_ROWS", 3)

        body = await _traffic(client, auth_headers)

        assert body["truncated"] is True
        assert body["rows_read"] == 3
        assert body["rows_total"] == 5, "the true count, not the cap"
        assert body["total_vehicles"] == 3, "the figures are built on what was read"
        read = sorted(
            datetime.fromisoformat(o["last_seen"].replace("Z", "+00:00"))
            for o in body["possible_obstructions"]
        )
        assert read == SEEN_AT[-3:], "newest first: the latest traffic is what was read"

    async def test_a_window_under_the_cap_is_complete(
        self, client: AsyncClient, auth_headers, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.setattr(analytics, "MAX_OBSERVATION_ROWS", 10)

        body = await _traffic(client, auth_headers)

        assert body["truncated"] is False
        assert body["rows_read"] == body["rows_total"] == body["total_vehicles"] == 5

    async def test_a_window_holding_exactly_the_cap_is_not_truncated(
        self, client: AsyncClient, auth_headers, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """A full read is not evidence of a short one — the count decides."""
        monkeypatch.setattr(analytics, "MAX_OBSERVATION_ROWS", 5)

        body = await _traffic(client, auth_headers)

        assert body["truncated"] is False
        assert body["rows_read"] == body["rows_total"] == 5
