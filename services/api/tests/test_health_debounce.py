"""The health monitor stays calm, and honest, while an integration swings.

On 12 Oct the organisers' grid alternated between accepting and refusing our
session every few minutes (its watch-time cooldown). The monitor answered every
swing: thirty cameras flipped to "unknown" and back, a catalogue fetch that
waited behind thirty probes flipped them to "degraded", and the integration
alarm opened and closed eleven times in one hour.

These tests replay recorded sequences of probe results through the code the
monitor runs (`health_monitor.apply_probes`) and pin what must happen instead:
a probe that could not ask leaves a camera's status as last known (stale), the
integration gets one alarm raised once and closed once, every status change
needs N agreeing probes, and the AI workers' own video counts as an answer.
"""

from __future__ import annotations

import json
import time
import uuid
from datetime import UTC, datetime, timedelta
from types import SimpleNamespace

import pytest
import redis.asyncio as aioredis
from httpx import AsyncClient
from sqlalchemy import delete, func, select

from app.adapters.base import STATUS_HOLD_ERRORS, HealthProbe
from app.adapters.sandbox import HostedGridAdapter
from app.core.config import settings as app_settings
from app.db.session import SessionLocal
from app.models.enums import AlertType
from app.models.intelligence import Alert, Detection
from app.models.registry import Camera, CameraHealth, VmsInstance
from app.services import fleet, grid_session, health_monitor
from app.services.grid_session import CatalogueCache

# ── Recorded sequences ────────────────────────────────────────────────
#
# One letter per sweep (15 s apart), read off SBX-cam22's camera_health rows
# between 09:01 and 09:35 IST on 12 Oct 2026. A = the grid's catalogue
# answered; R = it refused our session. The old monitor raised five
# integration alarms in this window and closed four of them.
GRID_0901_0935 = (
    "A" * 28 + "R" * 3 + "A" * 4 + "R" * 67 + "A" * 3 + "R" * 5 + "A" * 3 + "R" * 3 + "A" * 10
)

#: Thresholds as deployed (.env: HEALTH_OFFLINE_AFTER_FAILURES=2) and the defaults.
DOWN, CHANGE, INTEGRATION_DOWN, INTEGRATION_UP = 2, 3, 4, 20


@pytest.fixture(autouse=True)
def thresholds(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setattr(app_settings, "health_offline_after_failures", DOWN)
    monkeypatch.setattr(app_settings, "health_status_change_after_probes", CHANGE)
    monkeypatch.setattr(app_settings, "health_integration_down_after_sweeps", INTEGRATION_DOWN)
    monkeypatch.setattr(app_settings, "health_integration_recover_after_sweeps", INTEGRATION_UP)
    health_monitor.reset_state()
    yield
    health_monitor.reset_state()


def answered(**kw: object) -> HealthProbe:
    return HealthProbe(reachable=True, fps_actual=25.0, **kw)


def refused() -> HealthProbe:
    return HealthProbe(
        reachable=False,
        error_code="grid_refused",
        detail="the grid refused us: watch time limit reached — please wait for your cooldown",
    )


def offline() -> HealthProbe:
    return HealthProbe(reachable=False, error_code="reported_offline")


# ── The status decision, without a database ───────────────────────────


class TestDebounce:
    def test_a_refusal_never_moves_a_camera(self) -> None:
        camera = uuid.uuid4()
        for letter in GRID_0901_0935:
            probe = answered() if letter == "A" else refused()
            assert health_monitor._should_flip(camera, probe, "online") is None

    def test_a_camera_last_known_offline_stays_offline_through_a_refusal(self) -> None:
        camera = uuid.uuid4()
        for _ in range(30):
            assert health_monitor._should_flip(camera, refused(), "offline") is None

    def test_going_offline_needs_n_consecutive_probes(self) -> None:
        camera = uuid.uuid4()
        assert health_monitor._should_flip(camera, offline(), "online") is None
        assert health_monitor._should_flip(camera, offline(), "online") == "offline"

    def test_one_good_probe_between_bad_ones_does_not_recover(self) -> None:
        camera = uuid.uuid4()
        sequence = [answered(), answered(), offline(), answered(), answered()]
        assert [health_monitor._should_flip(camera, p, "offline") for p in sequence] == [None] * 5
        # The last two answers are a streak; a third in a row completes it.
        assert health_monitor._should_flip(camera, answered(), "offline") == "online"

    def test_a_refusal_neither_counts_nor_breaks_a_streak(self) -> None:
        camera = uuid.uuid4()
        flips = [
            health_monitor._should_flip(camera, p, "offline")
            for p in (answered(), refused(), answered(), refused(), refused(), answered())
        ]
        assert flips == [None, None, None, None, None, "online"]

    def test_degraded_is_debounced_too(self) -> None:
        camera = uuid.uuid4()
        slow = answered(frame_drop_pct=40.0)
        flips = [health_monitor._should_flip(camera, slow, "online") for _ in range(CHANGE)]
        assert flips == [None] * (CHANGE - 1) + ["degraded"]

    def test_an_operator_probe_that_could_not_ask_keeps_the_status(self) -> None:
        assert health_monitor.status_after_manual_probe("online", refused()) == "online"
        assert health_monitor.status_after_manual_probe("online", offline()) == "offline"

    def test_hold_errors_are_integration_errors(self) -> None:
        from app.adapters.base import INTEGRATION_ERRORS

        assert STATUS_HOLD_ERRORS <= INTEGRATION_ERRORS
        assert "grid_refused" in STATUS_HOLD_ERRORS


class TestGridProbe:
    """What the grid's adapter reports, from its catalogue cache — no network."""

    @pytest.fixture
    def cache(self, monkeypatch: pytest.MonkeyPatch) -> CatalogueCache:
        fresh = CatalogueCache()
        monkeypatch.setattr(grid_session, "catalogue", fresh)
        return fresh

    def _camera(self) -> SimpleNamespace:
        return SimpleNamespace(camera_code="SBX-cam01", tags=["grid-id:cam01"])

    async def test_a_refusal_is_reported_as_one(self, cache: CatalogueCache) -> None:
        cache.put_failure("the grid refused us: watch time limit reached", refused=True)
        probe = await HostedGridAdapter(name="t", base_url="https://grid.test").probe_health(
            self._camera()
        )
        assert probe.error_code == "grid_refused"
        assert probe.status.value == "unknown"

    async def test_a_network_fault_is_not_a_refusal(self, cache: CatalogueCache) -> None:
        cache.put_failure("connection reset", refused=False)
        probe = await HostedGridAdapter(name="t", base_url="https://grid.test").probe_health(
            self._camera()
        )
        assert probe.error_code == "sandbox_unreachable"

    async def test_catalogue_time_is_never_the_cameras_latency(self, cache: CatalogueCache) -> None:
        """5,880 grid probes crossed the 4 s "degraded" line in 12 hours by
        queueing behind one catalogue fetch."""
        cache.put([{"id": "cam01", "name": "01 Chiman bhai Bridge", "live": True}])
        probe = await HostedGridAdapter(name="t", base_url="https://grid.test").probe_health(
            self._camera()
        )
        assert probe.reachable and probe.latency_ms is None
        assert probe.status.value == "online"
        assert "catalogue answered in" in (probe.detail or "")


# ── Replays through the monitor, against the database ─────────────────


@pytest.fixture
async def grid():
    """A throwaway integration with three cameras, removed afterwards.

    The live monitor sweeps every camera in the registry, these included. Its
    adapter points at a port nothing listens on, so the live monitor's own
    probes of them are `vms_unreachable` — held — and never move them while a
    replay runs.
    """
    tag = uuid.uuid4().hex[:6]
    async with SessionLocal() as session:
        vms = VmsInstance(
            name=f"ZZTEST grid {tag}",
            vendor="generic",
            adapter_type="vendor_api",
            base_url="http://127.0.0.1:9",
            status="online",
        )
        session.add(vms)
        await session.flush()
        cameras = [
            Camera(
                camera_code=f"ZZTEST-HM-{tag}-{i}",
                name=f"Test junction {i}",
                vms_id=vms.id,
                location="SRID=4326;POINT(72.5636 23.0146)",
                status="online",
                anpr_enabled=True,
                tags=["zztest"],
            )
            for i in range(3)
        ]
        session.add_all(cameras)
        await session.commit()
        vms_id, ids = vms.id, [c.id for c in cameras]
    yield vms_id, ids
    async with SessionLocal() as session:
        await session.execute(delete(Alert).where(Alert.camera_id.in_(ids)))
        await session.execute(delete(Alert).where(Alert.notes.like(f"%vms:{vms_id}%")))
        await session.execute(delete(Detection).where(Detection.camera_id.in_(ids)))
        await session.execute(delete(Camera).where(Camera.id.in_(ids)))
        await session.execute(delete(VmsInstance).where(VmsInstance.id == vms_id))
        await session.commit()


async def _sweep(
    ids: list[uuid.UUID],
    probes: dict[uuid.UUID, HealthProbe] | HealthProbe,
    evidence: dict[uuid.UUID, str] | None = None,
) -> dict[str, int]:
    async with SessionLocal() as session:
        cameras = list(
            (
                await session.scalars(
                    select(Camera).where(Camera.id.in_(ids)).order_by(Camera.camera_code)
                )
            ).all()
        )
        asked = [(c, probes[c.id] if isinstance(probes, dict) else probes) for c in cameras]
        return await health_monitor.apply_probes(session, asked, evidence=evidence or {})


async def _integration_alerts(vms_id: uuid.UUID) -> list[Alert]:
    async with SessionLocal() as session:
        return list(
            (
                await session.scalars(
                    select(Alert)
                    .where(
                        Alert.alert_type == AlertType.CAMERA_DOWN.value,
                        Alert.camera_id.is_(None),
                        Alert.notes.like(f"%vms:{vms_id}%"),
                    )
                    .order_by(Alert.created_at)
                )
            ).all()
        )


async def _statuses(ids: list[uuid.UUID]) -> set[str]:
    async with SessionLocal() as session:
        return set((await session.scalars(select(Camera.status).where(Camera.id.in_(ids)))).all())


@pytest.mark.integration
class TestReplay:
    async def test_the_recorded_morning_raises_one_alarm_and_moves_no_camera(self, grid) -> None:
        vms_id, ids = grid
        for letter in GRID_0901_0935:
            await _sweep(ids, answered() if letter == "A" else refused())
            assert await _statuses(ids) == {"online"}, "a refusal moved a camera"

        alarms = await _integration_alerts(vms_id)
        assert len(alarms) == 1, [a.notes for a in alarms]
        assert alarms[0].status == "new", "closed by a few minutes of answers between refusals"
        assert "refusing our session" in (alarms[0].notes or "")
        assert alarms[0].priority == "medium"

        # Every probe is still on record, refusals included.
        async with SessionLocal() as session:
            recorded = await session.scalar(
                select(func.count())
                .select_from(CameraHealth)
                .where(
                    CameraHealth.camera_id.in_(ids),
                    # Not the live monitor's own probes of these cameras.
                    (CameraHealth.error_code.is_(None))
                    | (CameraHealth.error_code == "grid_refused"),
                )
            )
        assert recorded == len(GRID_0901_0935) * len(ids)

    async def test_the_alarm_closes_once_after_a_steady_recovery(self, grid) -> None:
        vms_id, ids = grid
        for _ in range(INTEGRATION_DOWN):
            await _sweep(ids, refused())
        assert len(await _integration_alerts(vms_id)) == 1
        for i in range(INTEGRATION_UP):
            await _sweep(ids, answered())
            alarm = (await _integration_alerts(vms_id))[0]
            expected = "closed" if i == INTEGRATION_UP - 1 else "new"
            assert alarm.status == expected, f"after {i + 1} answered sweeps"
        assert "Closed automatically" in (alarm.notes or "")
        # A refusal after that is a new incident — after the debounce, not at once.
        for _ in range(INTEGRATION_DOWN - 1):
            await _sweep(ids, refused())
        assert len(await _integration_alerts(vms_id)) == 1

    async def test_held_cameras_read_as_stale_with_their_last_answer(
        self, grid, client: AsyncClient, auth_headers
    ) -> None:
        _vms_id, ids = grid
        await _sweep(ids, answered())
        await _sweep(ids, refused())
        async with SessionLocal() as session:
            stale = await fleet.status_staleness(session, ids)
        assert set(stale) == set(ids)
        assert all(s["error_code"] in STATUS_HOLD_ERRORS for s in stale.values())
        assert all(s["confirmed_at"] is not None for s in stale.values())

        body = (
            await client.get(f"/api/v1/cameras/{ids[0]}", headers=await auth_headers("operator"))
        ).json()
        assert body["status"] == "online"
        assert body["status_stale_reason"] in STATUS_HOLD_ERRORS
        assert body["status_confirmed_at"]

    async def test_a_camera_down_alarm_waits_for_the_debounce_and_is_not_reopened(
        self, grid
    ) -> None:
        _vms_id, ids = grid
        target = ids[0]

        def with_target(probe: HealthProbe) -> dict[uuid.UUID, HealthProbe]:
            # Fresh probes every sweep, as the monitor makes them.
            return {target: probe, **{i: answered() for i in ids[1:]}}

        async def alarms() -> list[Alert]:
            async with SessionLocal() as session:
                return list(
                    (await session.scalars(select(Alert).where(Alert.camera_id == target))).all()
                )

        # offline, answered, offline: never two in a row — no alarm.
        # Made as each sweep runs, never ahead: two probes made in the same
        # microsecond would share (camera, ts), which the table rejects.
        for make in (offline, answered, offline):
            await _sweep(ids, with_target(make()))
        assert await alarms() == []
        await _sweep(ids, with_target(offline()))
        assert [a.status for a in await alarms()] == ["new"]
        # Two answers, a relapse, two answers: not steady — stays open, no second alarm.
        for make in (answered, answered, offline, answered, answered):
            await _sweep(ids, with_target(make()))
        assert [a.status for a in await alarms()] == ["new"]
        await _sweep(ids, with_target(answered()))
        assert [a.status for a in await alarms()] == ["closed"]

    async def test_a_workers_video_is_an_answer(self, grid, monkeypatch) -> None:
        """While the grid refuses, a camera an AI worker is decoding is answering."""
        _vms_id, ids = grid
        key = f"zztest:ai:workers:{uuid.uuid4().hex[:6]}"
        monkeypatch.setattr(health_monitor, "AI_WORKER_STATS_KEY", key)
        async with SessionLocal() as session:
            codes = list(
                (
                    await session.scalars(
                        select(Camera.camera_code)
                        .where(Camera.id.in_(ids))
                        .order_by(Camera.camera_code)
                    )
                ).all()
            )
            session.add(
                Detection(
                    id=uuid.uuid4(),
                    ts=datetime.now(UTC) - timedelta(seconds=20),
                    camera_id=ids[1],
                    track_id="zztest:1",
                )
            )
            await session.commit()
        client = aioredis.from_url(app_settings.redis_url, decode_responses=True)
        try:
            await client.hset(
                key,
                "zz/1",
                json.dumps({"reported_at": time.time(), "open_cameras": [codes[0]]}),
            )
            await client.hset(
                key,
                "stale/1",
                json.dumps({"reported_at": time.time() - 600, "open_cameras": [codes[2]]}),
            )
            async with SessionLocal() as session:
                cameras = list(
                    (await session.scalars(select(Camera).where(Camera.id.in_(ids)))).all()
                )
                evidence = await health_monitor.worker_evidence(session, cameras)
                summary = await health_monitor.apply_probes(
                    session, [(c, refused()) for c in cameras]
                )
        finally:
            await client.delete(key)
            await client.aclose()

        assert "receiving its video" in evidence[ids[0]]
        assert "read a vehicle here" in evidence[ids[1]]
        assert ids[2] not in evidence, "a worker report ten minutes old is not evidence"
        assert summary["witnessed"] == 2 and summary["held"] == 1
        async with SessionLocal() as session:
            stale = await fleet.status_staleness(session, ids)
        assert set(stale) == {ids[2]}


# ── Fleet health says it in the same words ────────────────────────────


@pytest.mark.integration
async def test_fleet_health_reports_the_integration_once(
    grid, client: AsyncClient, auth_headers
) -> None:
    vms_id, ids = grid
    for _ in range(INTEGRATION_DOWN):
        await _sweep(ids, refused())
    body = (await client.get("/api/v1/health/fleet", headers=await auth_headers("operator"))).json()
    mine = [i for i in body["integrations"] if i["vms_id"] == str(vms_id)]
    assert len(mine) == 1
    # "refused" unless the live monitor's own probe of these (unreachable)
    # landed last; either way, one line for the integration.
    assert mine[0]["state"] in ("refused", "unreachable") and mine[0]["cameras_held"] == 3
    assert mine[0]["alarm_open_since"]
    assert body["stale"] >= 3
