"""The Prometheus exposition: format, labels, and that each source is read.

What matters beyond "it parses": the route label is a template (a plate in a
label would leak it into the monitoring system and mint a series per vehicle),
the edge workers' and ingest consumers' counters are read from the hashes they
publish, and a camera with no plate read reports the horizon, not nothing —
the always-on alert needs a number to compare.
"""

from __future__ import annotations

import json
import time
import uuid
from datetime import UTC, datetime, timedelta

import pytest
import redis.asyncio as aioredis
from httpx import AsyncClient
from prometheus_client.parser import text_string_to_metric_families
from sqlalchemy import delete

from app.core.config import settings
from app.db.session import SessionLocal
from app.models.intelligence import Detection
from app.models.registry import Camera
from app.services import metrics

pytestmark = pytest.mark.asyncio


def samples(text: str) -> list[tuple[str, dict[str, str], float]]:
    return [
        (sample.name, dict(sample.labels), sample.value)
        for family in text_string_to_metric_families(text)
        for sample in family.samples
    ]


class TestEndpoint:
    async def test_serves_the_text_format(self, client: AsyncClient) -> None:
        response = await client.get("/metrics/prometheus")
        assert response.status_code == 200
        assert response.headers["content-type"].startswith("text/plain")
        names = {name for name, _, _ in samples(response.text)}
        for expected in (
            "contrail_alerts_raised_total",
            "contrail_alerts_open",
            "contrail_event_stream_length",
            "contrail_ingest_workers",
            "contrail_websocket_clients",
            "contrail_camera_last_plate_read_age_seconds",
            "process_cpu_seconds_total",
        ):
            assert expected in names, f"{expected} missing from the exposition"

    async def test_the_json_metrics_endpoint_is_unchanged(self, client: AsyncClient) -> None:
        """The load test reads it as JSON."""
        response = await client.get("/metrics")
        assert response.status_code == 200
        assert "ingest" in response.json()

    async def test_routes_are_labelled_by_template_never_by_value(
        self, client: AsyncClient, auth_headers
    ) -> None:
        headers = await auth_headers("admin")
        await client.get("/api/v1/vehicles/ZZ99PR0001/route", headers=headers)
        metrics.collector._snapshot.taken_at = 0.0
        text = (await client.get("/metrics/prometheus")).text
        routes = {
            labels["route"]
            for name, labels, _ in samples(text)
            if name == "contrail_http_requests_total"
        }
        assert "/api/v1/vehicles/{plate}/route" in routes
        assert not [route for route in routes if "ZZ99PR0001" in route]

    async def test_unrouted_requests_share_one_label(self, client: AsyncClient) -> None:
        await client.get(f"/no-such-path-{uuid.uuid4().hex}")
        text = (await client.get("/metrics/prometheus")).text
        assert any(
            name == "contrail_http_requests_total" and labels["route"] == "<unmatched>"
            for name, labels, _ in samples(text)
        )


@pytest.fixture
async def stats_keys():
    """Hashes of our own, so the live workers' entries are never touched."""
    suffix = uuid.uuid4().hex[:8]
    keys = (f"nagarnetra:test:{suffix}:ai", f"nagarnetra:test:{suffix}:ingest")
    yield keys
    client = aioredis.from_url(settings.redis_url, decode_responses=True)
    try:
        await client.delete(*keys)
    finally:
        await client.aclose()


class TestWorkerStats:
    async def test_edge_and_ingest_counters_are_read_from_their_hashes(self, stats_keys) -> None:
        ai_key, ingest_key = stats_keys
        now = time.time()
        client = aioredis.from_url(settings.redis_url, decode_responses=True)
        try:
            await client.hset(
                ai_key,
                "0/3",
                json.dumps(
                    {
                        "worker": "0/3",
                        "reported_at": now - 3,
                        "assigned": 11,
                        "open": 4,
                        "analysing": 2,
                        "slots": 2,
                        "cpu_seconds": 1234.5,
                        "threads": 41,
                        "rss_bytes": 1_500_000_000,
                        "inference_budget_threads": 6,
                        "by_kind": {"vehicle.completed": 7, "camera.tracks": 900},
                        "spool": {
                            "published": 900,
                            "publish_failures": 2,
                            "spooled": 5,
                            "replayed": 3,
                            "dropped": 1,
                            "ephemeral_dropped": 40,
                            "held": 1,
                            "memory_bytes": 2048,
                            "disk_bytes": 0,
                        },
                    }
                ),
            )
            # A worker that stopped reporting long ago must not be counted.
            await client.hset(
                ai_key, "1/3", json.dumps({"worker": "1/3", "reported_at": now - 3600})
            )
            await client.hset(
                ingest_key,
                "api-test",
                json.dumps(
                    {
                        "worker": "api-test",
                        "reported_at": now,
                        "consumed": 100,
                        "persisted": 40,
                        "failed": 1,
                        "latency": {"p50_ms": 120.0, "p95_ms": 900.0, "p99_ms": 2000.0},
                    }
                ),
            )
        finally:
            await client.aclose()

        collector = metrics.SnapshotCollector(
            ai_stats_key=ai_key, ingest_stats_key=ingest_key, min_refresh_s=0.0
        )
        await collector.refresh()
        got = {
            (sample.name, tuple(sorted(sample.labels.items()))): sample.value
            for family in collector.collect()
            for sample in family.samples
        }

        assert got[("contrail_ai_worker_cpu_seconds_total", (("worker", "0/3"),))] == 1234.5
        assert got[("contrail_ai_worker_spool_dropped_total", (("worker", "0/3"),))] == 1
        assert got[("contrail_ai_worker_replayed_total", (("worker", "0/3"),))] == 3
        assert got[("contrail_ai_worker_cameras", (("state", "analysing"), ("worker", "0/3")))] == 2
        assert 0 <= got[("contrail_ai_worker_stats_age_seconds", (("worker", "0/3"),))] < 60
        assert not [k for k in got if ("worker", "1/3") in k[1]], "a stale worker was reported"
        assert got[("contrail_ingest_persisted_total", (("worker", "api-test"),))] == 40
        assert got[("contrail_ingest_failed_total", (("worker", "api-test"),))] == 1
        assert (
            got[("contrail_ingest_latency_ms", (("quantile", "0.95"), ("worker", "api-test")))]
            == 900.0
        )


@pytest.fixture
async def quiet_and_busy_cameras():
    codes = (f"CAM-TEST-PROM-Q{uuid.uuid4().hex[:4]}", f"CAM-TEST-PROM-B{uuid.uuid4().hex[:4]}")
    async with SessionLocal() as session:
        cameras = [
            Camera(
                camera_code=code,
                name=f"Test {code}",
                district="TEST",
                location="SRID=4326;POINT(72.5 23.0)",
                status="unknown",
                anpr_enabled=True,
            )
            for code in codes
        ]
        session.add_all(cameras)
        await session.flush()
        session.add(
            Detection(
                id=uuid.uuid4(),
                ts=datetime.now(UTC) - timedelta(seconds=90),
                camera_id=cameras[1].id,
                track_id=f"{codes[1]}:1",
                plate_normalised="ZZ99PR0002",
            )
        )
        await session.commit()
        ids = [c.id for c in cameras]
    yield codes
    async with SessionLocal() as session:
        await session.execute(delete(Detection).where(Detection.camera_id.in_(ids)))
        await session.execute(delete(Camera).where(Camera.id.in_(ids)))
        await session.commit()


class TestCameraFreshness:
    async def test_last_plate_age_per_camera(self, quiet_and_busy_cameras) -> None:
        quiet, busy = quiet_and_busy_cameras
        collector = metrics.SnapshotCollector(min_refresh_s=0.0)
        await collector.refresh()
        ages = {
            sample.labels["camera"]: sample.value
            for family in collector.collect()
            if family.name == "contrail_camera_last_plate_read_age_seconds"
            for sample in family.samples
        }
        assert 80 <= ages[busy] <= 200
        assert ages[quiet] == metrics.LAST_READ_HORIZON_S, "no read reports the horizon"

    async def test_always_on_cameras_are_labelled(
        self, quiet_and_busy_cameras, monkeypatch
    ) -> None:
        quiet, _ = quiet_and_busy_cameras
        monkeypatch.setattr(settings, "ai_worker_always_on", quiet.lower())
        collector = metrics.SnapshotCollector(min_refresh_s=0.0)
        await collector.refresh()
        labels = {
            sample.labels["camera"]: sample.labels["always_on"]
            for family in collector.collect()
            if family.name == "contrail_camera_last_plate_read_age_seconds"
            for sample in family.samples
        }
        assert labels[quiet] == "true"
