"""Alert deduplication shared across consumer replicas, through Redis.

Ingest scales by adding consumers to one Redis consumer group. With the dedup
window held in each process's memory, two replicas that were each handed one
sighting of the same stolen car raised two alarms for it. These tests run two
dedupers — and two consumers — that share nothing but Redis, and assert one
alarm.

Every key is under a per-test prefix inside the `nagarnetra:dedup:` namespace,
so nothing here can touch a live claim.
"""

from __future__ import annotations

import asyncio
import uuid
from datetime import UTC, datetime, timedelta
from typing import Any

import pytest
import redis.asyncio as aioredis
from sqlalchemy import delete, func, select

from app.core.config import settings
from app.db.session import SessionLocal
from app.models.enums import Priority
from app.models.intelligence import Alert, Detection, Watchlist
from app.services import alert_fanout, watchlist
from app.services.alerts import DEDUP_KEY_PREFIX, SharedAlertDeduper
from app.services.event_consumer import EventConsumer
from app.services.watchlist import WatchlistEntry, WatchlistIndex, _deletion_variants

pytestmark = pytest.mark.asyncio


def _prefix() -> str:
    return f"{DEDUP_KEY_PREFIX}:test-{uuid.uuid4().hex[:8]}"


async def _keys(prefix: str) -> list[str]:
    client = aioredis.from_url(settings.redis_url, decode_responses=True)
    try:
        return sorted([key async for key in client.scan_iter(f"{prefix}:*")])
    finally:
        await client.aclose()


@pytest.fixture
async def replicas():
    """Two dedupers sharing one Redis namespace and nothing else."""
    prefix = _prefix()
    a, b = SharedAlertDeduper(prefix=prefix), SharedAlertDeduper(prefix=prefix)
    yield a, b
    await a.clear()
    await b.clear()
    assert await _keys(prefix) == [], "a test left dedup keys behind"


class TestSharedWindow:
    async def test_keys_live_under_the_dedup_namespace(self, replicas) -> None:
        a, _ = replicas
        await a.claim("GJ03AB1234", "CAM-1", uuid.uuid4())
        keys = await _keys(a.prefix)
        assert keys == [f"{a.prefix}:watchlist:GJ03AB1234:CAM-1"]
        assert keys[0].startswith("nagarnetra:dedup:")

    async def test_racing_replicas_raise_once(self, replicas) -> None:
        """Both see the hit at the same instant; exactly one may raise it."""
        a, b = replicas
        ids = [uuid.uuid4() for _ in range(10)]
        results = await asyncio.gather(
            *(
                (a if i % 2 else b).claim("GJ03AB1234", "CAM-1", alert_id)
                for i, alert_id in enumerate(ids)
            )
        )
        winners = [ids[i] for i, hit in enumerate(results) if hit is None]
        assert len(winners) == 1
        # Every loser was pointed at the winner's alert.
        assert {hit.alert_id for hit in results if hit is not None} == {winners[0]}

    async def test_a_repeat_on_the_other_replica_is_counted_on_the_original(self, replicas) -> None:
        a, b = replicas
        original = uuid.uuid4()
        assert await a.claim("GJ03AB1234", "CAM-1", original) is None
        first = await b.claim("GJ03AB1234", "CAM-1", uuid.uuid4())
        second = await b.claim("GJ03AB1234", "CAM-1", uuid.uuid4())
        assert first is not None and second is not None
        assert first.alert_id == second.alert_id == original
        assert (first.repeats, second.repeats) == (1, 2)

    async def test_another_camera_or_kind_is_a_new_alert(self, replicas) -> None:
        a, b = replicas
        assert await a.claim("GJ03AB1234", "CAM-1", uuid.uuid4()) is None
        assert await b.claim("GJ03AB1234", "CAM-2", uuid.uuid4()) is None
        assert await b.claim("GJ03AB1234", "CAM-1", uuid.uuid4(), kind="anomaly") is None

    async def test_the_window_expires(self) -> None:
        prefix = _prefix()
        a = SharedAlertDeduper(window=timedelta(milliseconds=300), prefix=prefix)
        b = SharedAlertDeduper(window=timedelta(milliseconds=300), prefix=prefix)
        try:
            assert await a.claim("GJ03AB1234", "CAM-1", uuid.uuid4()) is None
            assert await b.claim("GJ03AB1234", "CAM-1", uuid.uuid4()) is not None
            await asyncio.sleep(0.45)
            assert await b.claim("GJ03AB1234", "CAM-1", uuid.uuid4()) is None
        finally:
            await a.clear()
            await b.clear()


class TestReleaseOnRollback:
    async def test_a_failed_transaction_gives_its_claim_back(self, replicas) -> None:
        """Otherwise the retry finds the dead claim and the alarm never exists."""
        a, b = replicas
        with pytest.raises(RuntimeError):
            async with a.unit():
                assert await a.claim("GJ03AB1234", "CAM-1", uuid.uuid4()) is None
                raise RuntimeError("commit failed")
        assert await _keys(a.prefix) == []
        assert await b.claim("GJ03AB1234", "CAM-1", uuid.uuid4()) is None

    async def test_a_committed_unit_keeps_its_claim(self, replicas) -> None:
        a, b = replicas
        async with a.unit():
            assert await a.claim("GJ03AB1234", "CAM-1", uuid.uuid4()) is None
        assert await b.claim("GJ03AB1234", "CAM-1", uuid.uuid4()) is not None

    async def test_release_never_deletes_someone_elses_claim(self, replicas) -> None:
        """A claim that expired and was re-claimed elsewhere is not ours to drop."""
        a, _ = replicas
        with pytest.raises(RuntimeError):
            async with a.unit():
                await a.claim("GJ03AB1234", "CAM-1", uuid.uuid4())
                client = aioredis.from_url(settings.redis_url, decode_responses=True)
                try:
                    await client.set(
                        a.key("watchlist", "GJ03AB1234", "CAM-1"), '{"someone": "else"}'
                    )
                finally:
                    await client.aclose()
                raise RuntimeError("commit failed")
        assert await _keys(a.prefix) == [f"{a.prefix}:watchlist:GJ03AB1234:CAM-1"]
        client = aioredis.from_url(settings.redis_url, decode_responses=True)
        try:
            await client.delete(a.key("watchlist", "GJ03AB1234", "CAM-1"))
        finally:
            await client.aclose()


class TestRedisUnavailable:
    async def test_falls_back_to_this_process_rather_than_failing_open_or_shut(self) -> None:
        """No alert is suppressed for want of a cache, and repeats still fold."""
        d = SharedAlertDeduper(redis_url="redis://127.0.0.1:1/0", prefix=_prefix())
        first = uuid.uuid4()
        assert await d.claim("GJ03AB1234", "CAM-1", first) is None
        repeat = await d.claim("GJ03AB1234", "CAM-1", uuid.uuid4())
        assert repeat is not None and repeat.alert_id == first


# ── Two consumers, one database ──────────────────────────────────────────

PLATE = "ZZ99DD0001"
CAMERA = "CAM-TEST-DEDUP"


def _event(vehicle_id: int) -> dict[str, Any]:
    return {
        "schema": "ailab.vehicle.event.v1",
        "event": "vehicle.completed",
        "event_time": datetime.now(UTC).isoformat(),
        "source": {"camera_id": CAMERA, "name": CAMERA},
        "vehicle": {"vehicle_id": vehicle_id, "type": "car", "confidence": 0.9},
        "plate": {"text": PLATE, "confidence": 0.95, "grammar_valid": True},
        "evidence": {"reads": []},
    }


@pytest.fixture
async def watchlisted(monkeypatch):
    """The test plate on the watchlist, without waking the live index.

    The row exists because alerts reference it by foreign key; it is inactive so
    the running platform's index never loads it. The consumers here match
    against an index built in memory.
    """
    entry_id = uuid.uuid4()
    async with SessionLocal() as session:
        session.add(
            Watchlist(
                id=entry_id,
                plate_normalised=PLATE,
                category="test",
                priority=Priority.CRITICAL.value,
                case_ref="TEST/DEDUP",
                active=False,
            )
        )
        await session.commit()

    entry = WatchlistEntry(
        id=entry_id,
        plate=PLATE,
        category="test",
        priority=Priority.CRITICAL.value,
        case_ref="TEST/DEDUP",
        valid_from=None,
        valid_to=None,
    )
    index = WatchlistIndex()
    index.exact[PLATE] = [entry]
    for variant in _deletion_variants(PLATE):
        index.variants.setdefault(variant, []).append(entry)
    index.entry_count = 1
    index._dirty = False
    index.loaded_at = 1e12
    monkeypatch.setattr(watchlist, "index", index)

    published: list[dict[str, Any]] = []

    async def record(payload: dict[str, Any]) -> None:
        # Never onto the real fan-out channel: operators would see a test alarm.
        published.append(payload)

    monkeypatch.setattr(alert_fanout, "publish", record)
    yield published

    async with SessionLocal() as session:
        await session.execute(delete(Alert).where(Alert.plate_normalised == PLATE))
        await session.execute(delete(Detection).where(Detection.plate_normalised == PLATE))
        await session.execute(delete(Watchlist).where(Watchlist.id == entry_id))
        await session.commit()


class TestTwoConsumers:
    async def test_two_replicas_handed_the_same_car_raise_one_alarm(
        self, watchlisted, replicas
    ) -> None:
        a, b = replicas
        first, second = EventConsumer(deduper=a), EventConsumer(deduper=b)

        await asyncio.gather(
            first._persist_batch([_event(1)]),
            second._persist_batch([_event(2)]),
        )

        async with SessionLocal() as session:
            alerts = (
                await session.execute(
                    select(func.count()).select_from(Alert).where(Alert.plate_normalised == PLATE)
                )
            ).scalar_one()
            sightings = (
                await session.execute(
                    select(func.count())
                    .select_from(Detection)
                    .where(Detection.plate_normalised == PLATE)
                )
            ).scalar_one()
        assert sightings == 2, "both sightings are history, whichever replica stored them"
        assert alerts == 1, f"{alerts} alarms for one car at one camera"
        assert len(watchlisted) == 1
        assert first.alerts_raised + second.alerts_raised == 1

    async def test_the_alarm_names_the_claimed_id(self, watchlisted, replicas) -> None:
        a, b = replicas
        consumer = EventConsumer(deduper=a)
        await consumer._persist_batch([_event(1)])
        repeat = await b.claim(PLATE, CAMERA, uuid.uuid4())
        assert repeat is not None
        assert str(repeat.alert_id) == watchlisted[0]["alert_id"]
