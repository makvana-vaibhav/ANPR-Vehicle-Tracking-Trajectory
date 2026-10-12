"""City traffic analytics — the endpoints in `app/routers/analytics.py`.

Every test here builds its own `vehicle_tracks` / `detections` rows rather
than relying on whatever the simulator happens to have produced, for two
reasons. First, the properties under test are precise numeric claims ("a
plate with many snapshots counts once", "an implausible leg is excluded, not
averaged") that a live, concurrently-running demo cannot guarantee. Second,
using a fixed historical window (2024-03-04, a date the simulator will never
touch) isolates every test from whatever real detections are landing in the
database while the suite runs, with no mocking required — this hits the real
Postgres/TimescaleDB the router queries.

Camera identity is borrowed from the real seeded fleet (`make seed`) rather
than constructed here, because a `Camera` row carries a PostGIS `Geography`
location that is fiddly to build by hand and irrelevant to what these tests
are checking.
"""

from __future__ import annotations

import uuid
from datetime import UTC, datetime, timedelta

import pytest
from httpx import AsyncClient
from sqlalchemy import text

from app.db.session import SessionLocal
from app.models.intelligence import Detection, VehicleTrack
from app.services.recorded_footage import live_only_sql, sql_params

pytestmark = pytest.mark.integration

# A fixed past hour nothing else in this system will ever write to. Every
# synthetic row below lives inside [WINDOW_START, WINDOW_END) or the baseline
# lookback before it, so a query scoped to this window sees exactly what a
# test put there and nothing the simulator produced this run.
WINDOW_START = datetime(2024, 3, 4, 8, 0, 0, tzinfo=UTC)
WINDOW_END = WINDOW_START + timedelta(hours=1)

#: Plates used by this file, prefixed so cleanup can find them precisely
#: without touching anything a real search or the simulator wrote.
PLATE_PREFIX = "ZZANALYTICS"


def _plate(suffix: str) -> str:
    return f"{PLATE_PREFIX}{suffix}"


def _hop(
    camera_code: str,
    arrived_at: datetime,
    *,
    distance_m: float = 3_000.0,
    elapsed_s: float = 300.0,
    implied_kmph: float | None = 36.0,
    plausible: bool = True,
) -> dict:
    """One entry of `vehicle_tracks.hops -> 'hops'`, shaped exactly like
    `correlator.Hop.to_dict()` — see that function for the authoritative
    field list. Only the fields `_LEGS_SQL` actually extracts are included."""
    return {
        "camera_code": camera_code,
        "arrived_at": arrived_at.isoformat(),
        "distance_m": distance_m,
        "elapsed_s": elapsed_s,
        "implied_kmph": implied_kmph,
        "plausible": plausible,
    }


async def _insert_track(plate: str, created_at: datetime, hops: list[dict]) -> None:
    """One `vehicle_tracks` snapshot. `hops[0]` never contributes a leg — the
    router's `lag()` window needs a *from* camera, which the first hop in a
    journey does not have — so callers wanting N legs must pass N+1 hops."""
    async with SessionLocal() as session:
        session.add(
            VehicleTrack(
                id=uuid.uuid4(),
                plate_normalised=plate,
                hops={"hops": hops},
                hop_count=len(hops),
                created_at=created_at,
            )
        )
        await session.commit()


async def _insert_detections(camera_id: uuid.UUID, timestamps: list[datetime]) -> None:
    async with SessionLocal() as session:
        for i, ts in enumerate(timestamps):
            session.add(
                Detection(
                    id=uuid.uuid4(),
                    ts=ts,
                    camera_id=camera_id,
                    track_id=f"analytics-test-{uuid.uuid4().hex[:8]}-{i}",
                )
            )
        await session.commit()


async def _cleanup() -> None:
    async with SessionLocal() as session:
        await session.execute(
            text("DELETE FROM vehicle_tracks WHERE plate_normalised LIKE :p"),
            {"p": f"{PLATE_PREFIX}%"},
        )
        await session.execute(text("DELETE FROM detections WHERE track_id LIKE 'analytics-test-%'"))
        await session.commit()


@pytest.fixture(autouse=True)
async def _clean_synthetic_rows():
    """Belt and braces: clean before (a previous crashed run may have left
    rows) and after (leave the shared dev database as it was found)."""
    await _cleanup()
    yield
    await _cleanup()


#: Binds `:tag` in `coalesce(:tag = ANY(tags), false)` — a camera replaying a
#: recorded clip, the same test `app.services.recorded_footage` applies. Every
#: endpoint here leaves such cameras out by default, so fixtures that expect
#: their rows counted must borrow live cameras only.
RECORDED = {"tag": "recorded-footage"}


@pytest.fixture
async def cameras() -> list[dict]:
    """Three real live cameras from the seeded fleet, corridor included.

    Borrowing real rows sidesteps constructing a `Geography` location by
    hand; which three cameras they are does not matter to any test below.
    """
    async with SessionLocal() as session:
        rows = (
            await session.execute(
                text(
                    "SELECT id, camera_code, corridor FROM cameras "
                    "WHERE corridor IS NOT NULL AND NOT coalesce(:tag = ANY(tags), false) "
                    "ORDER BY camera_code LIMIT 3"
                ),
                RECORDED,
            )
        ).mappings()
        result = [dict(r) for r in rows]
    if len(result) < 3:
        pytest.skip("fewer than 3 corridor-tagged cameras seeded — run scripts/seed.py")
    return result


@pytest.fixture
async def same_corridor_pair(cameras: list[dict]) -> tuple[dict, dict] | None:
    """Two seeded cameras sharing a corridor, for the group_by=corridor test."""
    async with SessionLocal() as session:
        rows = (
            await session.execute(
                text(
                    "SELECT id, camera_code, corridor FROM cameras "
                    "WHERE corridor IS NOT NULL AND NOT coalesce(:tag = ANY(tags), false) "
                    "ORDER BY corridor, camera_code"
                ),
                RECORDED,
            )
        ).mappings()
        by_corridor: dict[str, list[dict]] = {}
        for row in rows:
            by_corridor.setdefault(row["corridor"], []).append(dict(row))
    for members in by_corridor.values():
        if len(members) >= 2:
            return members[0], members[1]
    pytest.skip("no corridor has 2+ seeded cameras")


class TestAccessControl:
    async def test_unauthenticated_is_refused(self, client: AsyncClient) -> None:
        for path in ("flow", "speed", "routes", "travel-time", "hotspots", "heatmap"):
            response = await client.get(f"/api/v1/analytics/{path}")
            assert response.status_code == 401, path

    @pytest.mark.parametrize("role", ["admin", "supervisor", "operator", "analyst", "auditor"])
    async def test_every_operational_role_can_read(
        self, client: AsyncClient, auth_headers, role: str
    ) -> None:
        """The matrix in rbac.py grants ANALYTICS_READ to every role except
        api_client — analytics identifies no one, so there is no
        separation-of-duties reason to withhold it, unlike search."""
        response = await client.get("/api/v1/analytics/flow", headers=await auth_headers(role))
        assert response.status_code == 200, f"{role}: {response.text}"

    async def test_api_client_is_denied(self, client: AsyncClient, auth_headers) -> None:
        """The one role that is only a camera-onboarding credential."""
        response = await client.get(
            "/api/v1/analytics/flow", headers=await auth_headers("api_client")
        )
        assert response.status_code == 403


class TestFlowEndpoint:
    async def test_counts_vehicles_in_the_window(
        self, client: AsyncClient, auth_headers, cameras: list[dict]
    ) -> None:
        camera = cameras[0]
        await _insert_detections(
            camera["id"],
            [WINDOW_START + timedelta(minutes=m) for m in (5, 10, 15)],
        )
        # One detection deliberately outside the window: it must not be counted.
        await _insert_detections(camera["id"], [WINDOW_START - timedelta(hours=2)])

        response = await client.get(
            "/api/v1/analytics/flow",
            params={
                "since": WINDOW_START.isoformat(),
                "until": WINDOW_END.isoformat(),
                "bucket": "15m",
            },
            headers=await auth_headers("operator"),
        )
        assert response.status_code == 200, response.text
        body = response.json()

        assert body["total_vehicles"] == 3
        series = next(s for s in body["series"] if s["key"] == camera["camera_code"])
        assert series["total"] == 3
        assert sum(p["vehicles"] for p in series["points"]) == 3

    async def test_bucket_param_sets_bucket_seconds(
        self, client: AsyncClient, auth_headers
    ) -> None:
        response = await client.get(
            "/api/v1/analytics/flow",
            params={
                "since": WINDOW_START.isoformat(),
                "until": WINDOW_END.isoformat(),
                "bucket": "1h",
            },
            headers=await auth_headers("operator"),
        )
        assert response.status_code == 200
        assert response.json()["window"]["bucket_seconds"] == 3600

    async def test_an_unknown_bucket_falls_back_to_the_default(
        self, client: AsyncClient, auth_headers
    ) -> None:
        """`BUCKETS.get(bucket, BUCKETS["15m"])` is a deliberate silent
        fallback, not a validation gap — `bucket` is interpolated into SQL, so
        a closed lookup with a safe default is what keeps that safe."""
        response = await client.get(
            "/api/v1/analytics/flow",
            params={
                "since": WINDOW_START.isoformat(),
                "until": WINDOW_END.isoformat(),
                "bucket": "not-a-real-bucket",
            },
            headers=await auth_headers("operator"),
        )
        assert response.status_code == 200
        assert response.json()["window"]["bucket_seconds"] == 900

    async def test_group_by_corridor_merges_cameras_on_the_same_corridor(
        self, client: AsyncClient, auth_headers, same_corridor_pair: tuple[dict, dict]
    ) -> None:
        first, second = same_corridor_pair
        await _insert_detections(first["id"], [WINDOW_START + timedelta(minutes=1)])
        await _insert_detections(
            second["id"],
            [WINDOW_START + timedelta(minutes=2), WINDOW_START + timedelta(minutes=3)],
        )

        response = await client.get(
            "/api/v1/analytics/flow",
            params={
                "since": WINDOW_START.isoformat(),
                "until": WINDOW_END.isoformat(),
                "group_by": "corridor",
                "corridor": first["corridor"],
            },
            headers=await auth_headers("operator"),
        )
        assert response.status_code == 200, response.text
        body = response.json()
        assert body["group_by"] == "corridor"

        series = [s for s in body["series"] if s["key"] == first["corridor"]]
        assert len(series) == 1, "grouping by corridor must not split one corridor in two"
        assert series[0]["total"] == 3

    async def test_an_invalid_group_by_is_rejected(self, client: AsyncClient, auth_headers) -> None:
        response = await client.get(
            "/api/v1/analytics/flow",
            params={"group_by": "district"},
            headers=await auth_headers("operator"),
        )
        assert response.status_code == 422


class TestSpeedEndpoint:
    """`_LEGS_SQL`'s `DISTINCT ON (plate_normalised) ... ORDER BY created_at
    DESC` is the guard against the documented trap: `vehicle_tracks` holds one
    row per journey *advance*, and exploding it directly inflates every figure
    by however many times a journey was re-persisted while still moving.
    """

    async def test_only_the_latest_snapshot_per_plate_is_counted(
        self, client: AsyncClient, auth_headers, cameras: list[dict]
    ) -> None:
        a, b = cameras[0]["camera_code"], cameras[1]["camera_code"]
        arrived = WINDOW_START + timedelta(minutes=20)
        plate = _plate("DEDUP")

        # Three re-persisted snapshots of the *same* journey — the shape
        # route_history.snapshot actually produces as a vehicle keeps moving
        # and its route is written again on every advance.
        for offset in (0, 1, 2):
            await _insert_track(
                plate,
                created_at=WINDOW_START + timedelta(seconds=offset),
                hops=[
                    _hop(a, arrived - timedelta(minutes=5)),
                    _hop(b, arrived, implied_kmph=36.0),
                ],
            )

        response = await client.get(
            "/api/v1/analytics/speed",
            params={"since": WINDOW_START.isoformat(), "until": WINDOW_END.isoformat()},
            headers=await auth_headers("analyst"),
        )
        assert response.status_code == 200, response.text
        segment = _find_segment(response.json(), a, b)

        assert segment is not None
        assert segment["samples"] == 1, (
            "three snapshots of one journey must count as one leg, not three — "
            "this is the exact trap CLAUDE.md names for vehicle_tracks"
        )
        # One sample is below MIN_SPEED_SAMPLES (3): a single vehicle is an
        # anecdote, not a published figure.
        assert segment["status"] == "insufficient_data"
        assert segment["median_kmph"] is None

    async def test_status_becomes_ok_once_enough_distinct_journeys_exist(
        self, client: AsyncClient, auth_headers, cameras: list[dict]
    ) -> None:
        a, b = cameras[0]["camera_code"], cameras[1]["camera_code"]
        arrived = WINDOW_START + timedelta(minutes=20)

        for i, kmph in enumerate((30.0, 35.0, 40.0)):
            await _insert_track(
                _plate(f"OK{i}"),
                created_at=WINDOW_START,
                hops=[
                    _hop(a, arrived - timedelta(minutes=5)),
                    _hop(b, arrived, implied_kmph=kmph),
                ],
            )

        response = await client.get(
            "/api/v1/analytics/speed",
            params={"since": WINDOW_START.isoformat(), "until": WINDOW_END.isoformat()},
            headers=await auth_headers("analyst"),
        )
        segment = _find_segment(response.json(), a, b)

        assert segment is not None
        assert segment["samples"] == 3
        assert segment["status"] == "ok"
        assert segment["median_kmph"] == 35.0

    async def test_implausible_legs_are_excluded_not_averaged_in(
        self, client: AsyncClient, auth_headers, cameras: list[dict]
    ) -> None:
        a, b, c = (cam["camera_code"] for cam in cameras)
        arrived = WINDOW_START + timedelta(minutes=20)

        await _insert_track(
            _plate("IMPLAUSIBLE"),
            created_at=WINDOW_START,
            hops=[
                _hop(a, arrived - timedelta(minutes=10)),
                _hop(b, arrived - timedelta(minutes=5), implied_kmph=32.0, plausible=True),
                # A replayed clip's signature: two cameras kilometres apart,
                # seconds apart — the correlator already flagged this False.
                _hop(
                    c,
                    arrived,
                    distance_m=4_000.0,
                    elapsed_s=2.0,
                    implied_kmph=7_200.0,
                    plausible=False,
                ),
            ],
        )

        response = await client.get(
            "/api/v1/analytics/speed",
            params={"since": WINDOW_START.isoformat(), "until": WINDOW_END.isoformat()},
            headers=await auth_headers("analyst"),
        )
        assert response.status_code == 200, response.text
        body = response.json()

        assert body["provenance"]["legs_excluded_implausible"] >= 1
        assert body["provenance"]["legs_considered"] >= 2

        # The implausible leg contributes no SegmentSpeed at all — it is
        # discarded before a segment entry is ever created, not published
        # with a low-confidence status. A caller who does not read the
        # provenance block must still be unable to average a fabricated
        # 7200 km/h into anything.
        assert _find_segment(body, b, c) is None
        for corridor in body["corridors"]:
            for segment in corridor["segments"]:
                assert segment["median_kmph"] != 7_200.0


def _find_segment(speed_body: dict, from_camera: str, to_camera: str) -> dict | None:
    for corridor in speed_body["corridors"]:
        for segment in corridor["segments"]:
            if segment["from_camera"] == from_camera and segment["to_camera"] == to_camera:
                return segment
    return None


class TestRouteDensityEndpoint:
    async def test_journeys_counts_distinct_plates_not_snapshots(
        self, client: AsyncClient, auth_headers, cameras: list[dict]
    ) -> None:
        """`journeys` is `len(set of plates)`, so it cannot by itself catch a
        broken DISTINCT ON — a set collapses duplicates whether or not the SQL
        does. `median_gap_seconds` is built from a plain list of every leg
        *row* returned, so it is the field that actually regresses if
        `_LEGS_SQL` ever stops deduplicating: giving each re-persisted
        snapshot a different `elapsed_s` makes a leaked duplicate visible in
        the median rather than only in a count that cannot show it.
        """
        a, b = cameras[0]["camera_code"], cameras[1]["camera_code"]
        arrived = WINDOW_START + timedelta(minutes=20)

        # Three re-persisted snapshots of the same journey, as if the elapsed
        # time were re-estimated on each advance. Only the latest (300s)
        # should survive DISTINCT ON.
        for offset, elapsed in ((0, 100.0), (1, 100.0), (2, 300.0)):
            await _insert_track(
                _plate("ROUTE-DEDUP"),
                created_at=WINDOW_START + timedelta(seconds=offset),
                hops=[
                    _hop(a, arrived - timedelta(minutes=5), elapsed_s=elapsed),
                    _hop(b, arrived, elapsed_s=elapsed),
                ],
            )
        # A second, genuinely different plate on the same route.
        await _insert_track(
            _plate("ROUTE-SECOND"),
            created_at=WINDOW_START,
            hops=[
                _hop(a, arrived - timedelta(minutes=5), elapsed_s=300.0),
                _hop(b, arrived, elapsed_s=300.0),
            ],
        )

        response = await client.get(
            "/api/v1/analytics/routes",
            params={"since": WINDOW_START.isoformat(), "until": WINDOW_END.isoformat()},
            headers=await auth_headers("analyst"),
        )
        assert response.status_code == 200, response.text
        body = response.json()

        pair = next(p for p in body["pairs"] if p["from_camera"] == a and p["to_camera"] == b)
        assert pair["journeys"] == 2, (
            "one re-persisted journey plus one distinct journey is two "
            "vehicles on this route, not four"
        )
        assert pair["median_gap_seconds"] == 300.0, (
            "the stale 100s snapshots of ROUTE-DEDUP must not reach the "
            "median — only its latest (300s) snapshot should, alongside "
            "ROUTE-SECOND's 300s. A leaked duplicate would pull this to 200."
        )


class TestTravelTimeEndpoint:
    async def test_insufficient_history_with_no_baseline(
        self, client: AsyncClient, auth_headers, cameras: list[dict]
    ) -> None:
        a, b = cameras[0]["camera_code"], cameras[1]["camera_code"]
        arrived = WINDOW_START + timedelta(minutes=20)
        await _insert_track(
            _plate("NOHISTORY"),
            created_at=WINDOW_START,
            hops=[
                _hop(a, arrived - timedelta(minutes=5), elapsed_s=280.0),
                _hop(b, arrived, elapsed_s=280.0),
            ],
        )

        response = await client.get(
            "/api/v1/analytics/travel-time",
            params={"since": WINDOW_START.isoformat(), "until": WINDOW_END.isoformat()},
            headers=await auth_headers("supervisor"),
        )
        assert response.status_code == 200, response.text
        segment = _find_travel_segment(response.json(), a, b)

        assert segment is not None
        assert segment["status"] == "insufficient_history"
        assert segment["current_seconds"] is not None
        assert segment["baseline_seconds"] is None
        assert segment["baseline_samples"] == 0

    async def test_insufficient_data_with_baseline_but_no_current_leg(
        self, client: AsyncClient, auth_headers, cameras: list[dict]
    ) -> None:
        a, b = cameras[1]["camera_code"], cameras[2]["camera_code"]
        # Five distinct days in the 7-day lookback before WINDOW_START, all at
        # the same hour-of-day the current window covers (08:00-09:00) — the
        # baseline is a same-time-of-day comparison, not a daily average.
        for day_offset, i in zip(range(1, 6), range(5), strict=True):
            baseline_arrived = WINDOW_START - timedelta(days=day_offset) + timedelta(minutes=30)
            await _insert_track(
                _plate(f"BASELINE{i}"),
                created_at=baseline_arrived,
                hops=[
                    _hop(a, baseline_arrived - timedelta(minutes=5), elapsed_s=300.0),
                    _hop(b, baseline_arrived, elapsed_s=300.0),
                ],
            )
        # Nothing at all for this pair inside [WINDOW_START, WINDOW_END).

        response = await client.get(
            "/api/v1/analytics/travel-time",
            params={"since": WINDOW_START.isoformat(), "until": WINDOW_END.isoformat()},
            headers=await auth_headers("supervisor"),
        )
        assert response.status_code == 200, response.text
        segment = _find_travel_segment(response.json(), a, b)

        assert segment is not None
        assert segment["status"] == "insufficient_data"
        assert segment["current_seconds"] is None
        assert segment["baseline_seconds"] is not None
        assert segment["baseline_samples"] == 5
        assert segment["baseline_days"] == 5

    async def test_ok_with_a_delta_once_both_exist(
        self, client: AsyncClient, auth_headers, cameras: list[dict]
    ) -> None:
        a, b = cameras[0]["camera_code"], cameras[2]["camera_code"]

        for day_offset, i in zip(range(1, 6), range(5), strict=True):
            baseline_arrived = WINDOW_START - timedelta(days=day_offset) + timedelta(minutes=30)
            await _insert_track(
                _plate(f"OKBASE{i}"),
                created_at=baseline_arrived,
                hops=[
                    _hop(a, baseline_arrived - timedelta(minutes=5), elapsed_s=300.0),
                    _hop(b, baseline_arrived, elapsed_s=300.0),
                ],
            )
        # Current leg takes noticeably longer than the 300s baseline — the
        # delta must come out positive (slower than normal).
        current_arrived = WINDOW_START + timedelta(minutes=20)
        await _insert_track(
            _plate("OKCURRENT"),
            created_at=WINDOW_START,
            hops=[
                _hop(a, current_arrived - timedelta(minutes=10), elapsed_s=600.0),
                _hop(b, current_arrived, elapsed_s=600.0),
            ],
        )

        response = await client.get(
            "/api/v1/analytics/travel-time",
            params={"since": WINDOW_START.isoformat(), "until": WINDOW_END.isoformat()},
            headers=await auth_headers("supervisor"),
        )
        segment = _find_travel_segment(response.json(), a, b)

        assert segment is not None
        assert segment["status"] == "ok"
        assert segment["current_seconds"] == 600.0
        assert segment["baseline_seconds"] == 300.0
        assert segment["delta_pct"] == 100.0, "600s against a 300s baseline is 100% slower"

    async def test_never_reports_a_zero_delta_for_missing_history(
        self, client: AsyncClient, auth_headers
    ) -> None:
        """`docs/PROGRESS.md`'s honesty rule: a young database must render as
        'insufficient history', never as a silently-substituted zero delta."""
        response = await client.get(
            "/api/v1/analytics/travel-time",
            params={"since": WINDOW_START.isoformat(), "until": WINDOW_END.isoformat()},
            headers=await auth_headers("supervisor"),
        )
        assert response.status_code == 200
        for segment in response.json()["segments"]:
            if segment["status"] == "insufficient_history":
                assert segment["delta_pct"] is None


def _find_travel_segment(body: dict, from_camera: str, to_camera: str) -> dict | None:
    for segment in body["segments"]:
        if segment["from_camera"] == from_camera and segment["to_camera"] == to_camera:
            return segment
    return None


class TestHotspotsEndpoint:
    async def test_ranks_by_volume_and_reports_intensity_relative_to_the_busiest(
        self, client: AsyncClient, auth_headers, cameras: list[dict]
    ) -> None:
        busy, quiet = cameras[0], cameras[1]
        await _insert_detections(
            busy["id"], [WINDOW_START + timedelta(minutes=m) for m in range(4)]
        )
        await _insert_detections(quiet["id"], [WINDOW_START + timedelta(minutes=1)])

        response = await client.get(
            "/api/v1/analytics/hotspots",
            params={"since": WINDOW_START.isoformat(), "until": WINDOW_END.isoformat()},
            headers=await auth_headers("operator"),
        )
        assert response.status_code == 200, response.text
        by_code = {h["camera_code"]: h for h in response.json()["by_volume"]}

        assert by_code[busy["camera_code"]]["vehicles"] == 4
        assert by_code[busy["camera_code"]]["intensity"] == 1.0
        assert by_code[quiet["camera_code"]]["vehicles"] == 1
        assert by_code[quiet["camera_code"]]["intensity"] == pytest.approx(0.25)

    async def test_volume_is_never_relabelled_as_slowdown(
        self, client: AsyncClient, auth_headers, cameras: list[dict]
    ) -> None:
        """Without a baseline, `by_slowdown` must be empty with a status
        explaining why — not silently filled with the volume ranking."""
        await _insert_detections(cameras[0]["id"], [WINDOW_START + timedelta(minutes=1)])

        response = await client.get(
            "/api/v1/analytics/hotspots",
            params={"since": WINDOW_START.isoformat(), "until": WINDOW_END.isoformat()},
            headers=await auth_headers("operator"),
        )
        body = response.json()
        assert body["by_slowdown"] == []
        assert body["slowdown_status"] == "insufficient_history"
        assert "not a congestion measure" in body["note"]


class TestHeatmapEndpoint:
    async def test_returns_valid_geojson_weighted_by_volume(
        self, client: AsyncClient, auth_headers, cameras: list[dict]
    ) -> None:
        camera = cameras[0]
        await _insert_detections(
            camera["id"], [WINDOW_START + timedelta(minutes=m) for m in range(3)]
        )

        response = await client.get(
            "/api/v1/analytics/heatmap",
            params={"since": WINDOW_START.isoformat(), "until": WINDOW_END.isoformat()},
            headers=await auth_headers("analyst"),
        )
        assert response.status_code == 200, response.text
        body = response.json()

        assert body["type"] == "FeatureCollection"
        feature = next(
            f for f in body["features"] if f["properties"]["camera_code"] == camera["camera_code"]
        )
        assert feature["type"] == "Feature"
        assert feature["geometry"]["type"] == "Point"
        assert len(feature["geometry"]["coordinates"]) == 2
        assert feature["properties"]["vehicles"] == 3
        assert body["max_vehicles"] >= 3


# ── recorded footage ──────────────────────────────────────────────────
#
# CAM-DEMO-01 replays a 15-second clip on a loop and was ~93% of every vehicle
# Insights reported. Every figure now leaves cameras tagged `recorded-footage`
# out unless `include_recorded=true`, and says so in `recorded_footage`.


@pytest.fixture
async def live_and_recorded() -> tuple[dict, dict, dict]:
    """Two live cameras and one tagged `recorded-footage`, borrowed from the
    registry like every other camera in this file. No corridor is needed —
    these tests group by camera."""
    async with SessionLocal() as session:
        live = [
            dict(r)
            for r in (
                await session.execute(
                    text(
                        "SELECT id, camera_code FROM cameras "
                        "WHERE NOT coalesce(:tag = ANY(tags), false) "
                        "ORDER BY camera_code LIMIT 2"
                    ),
                    RECORDED,
                )
            ).mappings()
        ]
        recorded = (
            (
                await session.execute(
                    text(
                        "SELECT id, camera_code FROM cameras "
                        "WHERE :tag = ANY(tags) ORDER BY camera_code LIMIT 1"
                    ),
                    RECORDED,
                )
            )
            .mappings()
            .first()
        )
    if len(live) < 2 or recorded is None:
        pytest.skip("needs two live cameras and one tagged recorded-footage — run scripts/seed.py")
    return live[0], live[1], dict(recorded)


async def _recorded_codes() -> list[str]:
    async with SessionLocal() as session:
        rows = await session.execute(
            text("SELECT camera_code FROM cameras WHERE :tag = ANY(tags)"), RECORDED
        )
        return sorted(code for (code,) in rows)


def _in_window(**extra: str) -> dict[str, str]:
    return {"since": WINDOW_START.isoformat(), "until": WINDOW_END.isoformat(), **extra}


#: Every endpoint that reports a traffic figure, with parameters that keep it
#: inside the synthetic window. The forecast takes an instant, not a window.
TRAFFIC_ENDPOINTS: dict[str, dict[str, str]] = {
    "/api/v1/analytics/flow": _in_window(),
    "/api/v1/analytics/speed": _in_window(),
    "/api/v1/analytics/routes": _in_window(),
    "/api/v1/analytics/travel-time": _in_window(),
    "/api/v1/analytics/hotspots": _in_window(),
    "/api/v1/analytics/heatmap": _in_window(),
    "/api/v1/analytics/traffic": _in_window(),
    "/api/v1/analytics/traffic/history": _in_window(),
    "/api/v1/predictions/congestion": {"at": WINDOW_END.isoformat()},
}


class TestRecordedFootage:
    async def test_the_predicate_drops_only_recordings(self) -> None:
        """`tags` is nullable, and `NOT (tag = ANY(NULL))` is NULL — which a
        WHERE clause treats as false. Untagged cameras must survive it."""
        cases = [
            (None, False, True),
            ([], False, True),
            (["demo", "arterial"], False, True),
            (["demo", "recorded-footage"], False, False),
            (["demo", "recorded-footage"], True, True),
        ]
        # The product's own predicate, verbatim — interpolating it is the point.
        query = text(
            f"SELECT {live_only_sql('c')} FROM (SELECT CAST(:tags AS text[]) AS tags) c"  # noqa: S608
        )
        async with SessionLocal() as session:
            for tags, include, expected in cases:
                kept = (
                    await session.execute(
                        query, {"tags": tags, **sql_params(include_recorded=include)}
                    )
                ).scalar()
                assert kept is expected, (tags, include)

    @pytest.mark.parametrize("path", list(TRAFFIC_ENDPOINTS))
    async def test_every_traffic_figure_says_whether_recordings_are_in_it(
        self, client: AsyncClient, auth_headers, path: str
    ) -> None:
        codes = await _recorded_codes()
        headers = await auth_headers("analyst")

        default = await client.get(path, params=TRAFFIC_ENDPOINTS[path], headers=headers)
        assert default.status_code == 200, default.text
        assert default.json()["recorded_footage"] == {
            "included": False,
            "cameras": codes,
            "excluded_cameras": codes,
        }

        included = await client.get(
            path, params={**TRAFFIC_ENDPOINTS[path], "include_recorded": "true"}, headers=headers
        )
        assert included.status_code == 200, included.text
        assert included.json()["recorded_footage"] == {
            "included": True,
            "cameras": codes,
            "excluded_cameras": [],
        }

    async def test_flow_counts_live_cameras_only_unless_asked(
        self, client: AsyncClient, auth_headers, live_and_recorded: tuple[dict, dict, dict]
    ) -> None:
        live, _, recorded = live_and_recorded
        await _insert_detections(live["id"], [WINDOW_START + timedelta(minutes=m) for m in (1, 2)])
        await _insert_detections(
            recorded["id"], [WINDOW_START + timedelta(minutes=m) for m in (3, 4, 5)]
        )
        headers = await auth_headers("operator")

        default = (
            await client.get("/api/v1/analytics/flow", params=_in_window(), headers=headers)
        ).json()
        totals = {s["key"]: s["total"] for s in default["series"]}
        assert totals.get(live["camera_code"]) == 2
        assert recorded["camera_code"] not in totals
        assert recorded["camera_code"] in default["recorded_footage"]["excluded_cameras"]

        included = (
            await client.get(
                "/api/v1/analytics/flow",
                params=_in_window(include_recorded="true"),
                headers=headers,
            )
        ).json()
        totals = {s["key"]: s["total"] for s in included["series"]}
        assert totals.get(live["camera_code"]) == 2
        assert totals.get(recorded["camera_code"]) == 3
        assert included["total_vehicles"] == default["total_vehicles"] + 3

    async def test_hotspots_heatmap_and_history_leave_the_recording_out(
        self, client: AsyncClient, auth_headers, live_and_recorded: tuple[dict, dict, dict]
    ) -> None:
        live, _, recorded = live_and_recorded
        await _insert_detections(live["id"], [WINDOW_START + timedelta(minutes=1)])
        await _insert_detections(
            recorded["id"], [WINDOW_START + timedelta(minutes=m) for m in (2, 3, 4, 5)]
        )
        headers = await auth_headers("operator")

        async def codes_and_history(**extra: str) -> tuple[set[str], set[str], int]:
            hotspots = (
                await client.get(
                    "/api/v1/analytics/hotspots", params=_in_window(**extra), headers=headers
                )
            ).json()
            heatmap = (
                await client.get(
                    "/api/v1/analytics/heatmap", params=_in_window(**extra), headers=headers
                )
            ).json()
            history = (
                await client.get(
                    "/api/v1/analytics/traffic/history",
                    params=_in_window(group_by="camera", **extra),
                    headers=headers,
                )
            ).json()
            return (
                {h["camera_code"] for h in hotspots["by_volume"]},
                {f["properties"]["camera_code"] for f in heatmap["features"]},
                sum(p["vehicles"] for p in history["points"]),
            )

        hot, heat, vehicles = await codes_and_history()
        assert live["camera_code"] in hot and live["camera_code"] in heat
        assert recorded["camera_code"] not in hot and recorded["camera_code"] not in heat

        hot_all, heat_all, vehicles_all = await codes_and_history(include_recorded="true")
        assert recorded["camera_code"] in hot_all and recorded["camera_code"] in heat_all
        assert vehicles_all == vehicles + 4

    async def test_legs_touching_a_recording_are_left_out(
        self, client: AsyncClient, auth_headers, live_and_recorded: tuple[dict, dict, dict]
    ) -> None:
        """A leg into or out of a recording is the loop's timing, not a road's.
        The live leg beside it is unaffected."""
        a, b, recorded = (camera["camera_code"] for camera in live_and_recorded)
        snapshot_at = WINDOW_START + timedelta(minutes=50)
        await _insert_track(
            _plate("RECLEG"),
            snapshot_at,
            [
                _hop(a, WINDOW_START + timedelta(minutes=10)),
                _hop(recorded, WINDOW_START + timedelta(minutes=20)),
                _hop(b, WINDOW_START + timedelta(minutes=30)),
            ],
        )
        await _insert_track(
            _plate("LIVELEG"),
            snapshot_at,
            [
                _hop(a, WINDOW_START + timedelta(minutes=10)),
                _hop(b, WINDOW_START + timedelta(minutes=30)),
            ],
        )
        headers = await auth_headers("analyst")

        async def pairs_and_legs(**extra: str) -> tuple[set[tuple[str, str]], int]:
            routes = (
                await client.get(
                    "/api/v1/analytics/routes", params=_in_window(**extra), headers=headers
                )
            ).json()
            speed = (
                await client.get(
                    "/api/v1/analytics/speed", params=_in_window(**extra), headers=headers
                )
            ).json()
            return (
                {(p["from_camera"], p["to_camera"]) for p in routes["pairs"]},
                speed["provenance"]["legs_considered"],
            )

        pairs, legs = await pairs_and_legs()
        assert (a, b) in pairs
        assert not any(recorded in pair for pair in pairs)

        pairs_all, legs_all = await pairs_and_legs(include_recorded="true")
        assert {(a, b), (a, recorded), (recorded, b)} <= pairs_all
        assert legs_all == legs + 2
