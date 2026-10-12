"""Publishing events to the platform's stream, and holding them through an outage.

The fake Redis below can be taken down and brought back. What is asserted is
what an operator is promised: a sighting made while the link to the centre is
down reaches the platform once it is back, in the order it was seen; the camera
thread is never made to wait for the network; and when the spool's bounds are
exhausted the loss is counted, oldest first, rather than hidden.
"""

from __future__ import annotations

import json
import threading
import time
from collections.abc import Callable
from pathlib import Path
from typing import Any

import pytest
import redis

from ai_worker.publisher import DiskSpool, RedisEventSink

STREAM = "nagarnetra:events:detections"


class FakePipeline:
    def __init__(self, owner: FakeRedis) -> None:
        self.owner = owner
        self.queued: list[tuple[str, dict[str, Any]]] = []

    def xadd(self, key: str, fields: dict[str, Any], **kwargs: Any) -> None:
        self.queued.append((key, fields))

    def execute(self, raise_on_error: bool = True) -> list[Any]:
        return self.owner.execute(self.queued)


class FakeRedis:
    """A bus that can be switched off, hung, or made to refuse entries."""

    def __init__(self) -> None:
        self.entries: list[tuple[str, dict[str, Any]]] = []
        self.up = True
        self.hang_s = 0.0
        self.attempts = 0
        self.closed = False
        self._lock = threading.Lock()

    def pipeline(self, transaction: bool = True) -> FakePipeline:
        return FakePipeline(self)

    def execute(self, queued: list[tuple[str, dict[str, Any]]]) -> list[Any]:
        self.attempts += 1
        if self.hang_s:
            time.sleep(self.hang_s)
        if not self.up:
            raise redis.ConnectionError("bus down")
        with self._lock:
            self.entries.extend(queued)
            return [f"{len(self.entries)}-0" for _ in queued]

    def close(self) -> None:
        self.closed = True

    def plates(self) -> list[str]:
        return [
            json.loads(fields["payload"])["plate"]["text"] for _, fields in self.entries
        ]


def event(plate: str = "GJ03AB1234", kind: str = "vehicle.completed") -> dict[str, Any]:
    return {"event": kind, "plate": {"text": plate}, "source": {"camera_id": "CAM-1"}}


def wait_until(condition: Callable[[], bool], timeout: float = 5.0) -> None:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if condition():
            return
        time.sleep(0.01)
    raise AssertionError("condition not met in time")


def make_sink(fake: FakeRedis, **kwargs: Any) -> RedisEventSink:
    kwargs.setdefault("retry_initial_s", 0.01)
    kwargs.setdefault("retry_max_s", 0.05)
    return RedisEventSink("redis://unused", STREAM, client=fake, **kwargs)


@pytest.fixture
def fake() -> FakeRedis:
    return FakeRedis()


class TestHealthyBus:
    def test_publishes_json_to_the_stream(self, fake: FakeRedis) -> None:
        sink = make_sink(fake)
        sink.emit(event())
        assert sink.flush()
        key, fields = fake.entries[0]
        assert key == STREAM
        assert json.loads(fields["payload"])["plate"]["text"] == "GJ03AB1234"
        sink.close()

    def test_counts_by_kind(self, fake: FakeRedis) -> None:
        sink = make_sink(fake)
        sink.emit(event(kind="vehicle.observed"))
        sink.emit(event())
        sink.emit(event())
        assert sink.flush()
        assert sink.by_kind == {"vehicle.observed": 1, "vehicle.completed": 2}
        assert sink.written == 3
        assert sink.published == 3
        assert sink.spooled == 0
        sink.close()

    def test_order_is_kept(self, fake: FakeRedis) -> None:
        sink = make_sink(fake)
        for i in range(500):
            sink.emit(event(f"P{i:04d}"))
        assert sink.flush()
        assert fake.plates() == [f"P{i:04d}" for i in range(500)]
        sink.close()

    def test_close_is_safe_and_closes_the_client(self, fake: FakeRedis) -> None:
        sink = make_sink(fake)
        sink.close()
        assert fake.closed


class TestOutage:
    def test_events_seen_during_an_outage_arrive_in_order_once_it_ends(
        self, fake: FakeRedis
    ) -> None:
        sink = make_sink(fake)
        sink.emit(event("BEFORE"))
        assert sink.flush()

        fake.up = False
        for i in range(10):
            sink.emit(event(f"DURING{i}"))
        wait_until(lambda: sink.publish_failures >= 1)
        assert fake.plates() == ["BEFORE"], "nothing may land while the bus is down"
        assert sink.stats()["held"] == 10
        assert sink.stats()["outage_seconds"] >= 0.0

        fake.up = True
        sink.emit(event("AFTER"))
        assert sink.flush()
        assert fake.plates() == ["BEFORE", *[f"DURING{i}" for i in range(10)], "AFTER"]
        # AFTER queued behind the backlog before the outage was known to be over,
        # so it counts as held too.
        assert sink.spooled >= 10
        assert sink.replayed == sink.spooled
        assert sink.dropped == 0
        assert sink.stats()["outage_seconds"] == 0.0
        sink.close()

    def test_emit_never_waits_for_a_hung_bus(self, fake: FakeRedis) -> None:
        """The camera thread must not stall because the network has."""
        fake.hang_s = 1.0
        fake.up = False
        sink = make_sink(fake)
        started = time.perf_counter()
        for i in range(200):
            sink.emit(event(f"P{i}"))
        elapsed = time.perf_counter() - started
        assert elapsed < 0.25, f"200 emits took {elapsed:.2f}s against a hung bus"
        fake.hang_s = 0.0
        fake.up = True
        assert sink.flush(timeout=10)
        assert len(fake.entries) == 200
        sink.close()

    def test_backoff_is_not_defeated_by_a_stream_of_emits(
        self, fake: FakeRedis
    ) -> None:
        """A steady flow of sightings must not turn retries into a hammer."""
        fake.up = False
        sink = make_sink(fake, retry_initial_s=0.2, retry_max_s=0.2)
        deadline = time.monotonic() + 1.0
        while time.monotonic() < deadline:
            sink.emit(event())
            time.sleep(0.002)
        assert fake.attempts <= 8, f"{fake.attempts} attempts in 1s with a 0.2s backoff"
        fake.up = True
        assert sink.flush()
        sink.close()

    def test_ephemeral_events_are_not_spooled(self, fake: FakeRedis) -> None:
        """Live boxes replayed later would draw on video they no longer describe."""
        fake.up = False
        sink = make_sink(fake)
        sink.emit(event("HELD"))
        wait_until(lambda: sink.publish_failures >= 1)
        for _ in range(5):
            sink.emit({"event": "camera.tracks", "tracks": []})
            sink.emit(event("LIVE", kind="vehicle.observed"))
        fake.up = True
        assert sink.flush()
        assert fake.plates() == ["HELD"]
        assert sink.ephemeral_dropped == 10
        assert sink.dropped == 0
        sink.close()

    def test_memory_bound_drops_the_oldest_and_counts_it(self, fake: FakeRedis) -> None:
        fake.up = False
        sink = make_sink(fake, spool_max_events=5)
        sink.emit(event("E0"))
        wait_until(lambda: sink.publish_failures >= 1)
        for i in range(1, 8):
            sink.emit(event(f"E{i}"))
        assert sink.dropped == 3
        fake.up = True
        assert sink.flush()
        assert fake.plates() == ["E3", "E4", "E5", "E6", "E7"]
        assert sink.spooled == 8
        assert sink.replayed + sink.dropped == sink.spooled
        sink.close()

    def test_byte_bound_is_enforced(self, fake: FakeRedis) -> None:
        fake.up = False
        one = len(json.dumps(event("E0")))
        sink = make_sink(fake, spool_max_bytes=one * 3)
        sink.emit(event("E0"))
        wait_until(lambda: sink.publish_failures >= 1)
        for i in range(1, 6):
            sink.emit(event(f"E{i}"))
        assert sink.stats()["memory_bytes"] <= one * 3
        fake.up = True
        assert sink.flush()
        assert fake.plates() == ["E3", "E4", "E5"]
        sink.close()


class TestDiskOverflow:
    def test_overflow_goes_to_disk_and_comes_back_in_order(
        self, fake: FakeRedis, tmp_path: Path
    ) -> None:
        fake.up = False
        sink = make_sink(fake, spool_max_events=3, spool_dir=tmp_path)
        for i in range(20):
            sink.emit(event(f"E{i:02d}"))
        wait_until(lambda: sink.publish_failures >= 1)
        stats = sink.stats()
        assert stats["disk_events"] > 0, "overflow should have reached the disk"
        assert any(tmp_path.glob("seg-*.jsonl"))
        fake.up = True
        assert sink.flush()
        assert fake.plates() == [f"E{i:02d}" for i in range(20)]
        assert sink.dropped == 0
        assert sink.replayed == sink.spooled
        assert not list(tmp_path.glob("seg-*.jsonl")), "drained segments are removed"
        sink.close()

    def test_disk_budget_evicts_whole_oldest_segments(self, tmp_path: Path) -> None:
        line = json.dumps(event("E000"))
        disk = DiskSpool(tmp_path, max_bytes=(len(line) + 1) * 25, segment_events=10)
        evicted = sum(disk.append(json.dumps(event(f"E{i:03d}"))) for i in range(40))
        assert evicted == 20  # two whole segments of ten
        assert disk.events == 20
        first, torn = disk.pop_oldest()
        assert torn == 0
        assert json.loads(first[0])["plate"]["text"] == "E020"

    def test_what_is_held_at_shutdown_is_replayed_by_the_next_process(
        self, fake: FakeRedis, tmp_path: Path
    ) -> None:
        fake.up = False
        sink = make_sink(fake, spool_max_events=4, spool_dir=tmp_path)
        for i in range(10):
            sink.emit(event(f"E{i}"))
        wait_until(lambda: sink.publish_failures >= 1)
        sink.close(timeout=0.2)
        assert len(fake.entries) == 0

        fake.up = True
        restarted = make_sink(fake, spool_max_events=4, spool_dir=tmp_path)
        assert restarted.recovered == 10
        assert restarted.flush()
        assert fake.plates() == [f"E{i}" for i in range(10)]
        restarted.close()

    def test_a_line_torn_by_a_crash_is_skipped_and_counted(
        self, tmp_path: Path
    ) -> None:
        good = json.dumps(event("GOOD"))
        (tmp_path / "seg-001000000000.jsonl").write_text(
            f"{good}\n{good[:20]}\n", encoding="utf-8"
        )
        disk = DiskSpool(tmp_path, max_bytes=1 << 20)
        payloads, torn = disk.pop_oldest()
        assert [json.loads(p)["plate"]["text"] for p in payloads] == ["GOOD"]
        assert torn == 1

    def test_without_a_disk_spool_shutdown_losses_are_counted(
        self, fake: FakeRedis
    ) -> None:
        fake.up = False
        sink = make_sink(fake)
        for i in range(3):
            sink.emit(event(f"E{i}"))
        wait_until(lambda: sink.publish_failures >= 1)
        sink.close(timeout=0.2)
        assert sink.dropped == 3


class TestStats:
    def test_stats_carry_every_counter(self, fake: FakeRedis) -> None:
        sink = make_sink(fake)
        stats = sink.stats()
        for key in (
            "written",
            "published",
            "publish_failures",
            "spooled",
            "replayed",
            "dropped",
            "ephemeral_dropped",
            "recovered",
            "held",
            "memory_events",
            "memory_bytes",
            "disk_events",
            "disk_bytes",
        ):
            assert key in stats
        sink.close()
