"""Pursuit: ranking the cameras a vehicle can reach next, and pinning them.

Two halves. The ranking and the pin planner are pure, and are tested here on
the registry's real camera positions (copied from the live registry on 12 Oct
2026), because a distance or a window that is wrong on real geography is the
bug that matters. The endpoints and the keeper are tested against the real
Redis and database — with every pursuit key and the focus key moved to a
per-test prefix, so neither the live keeper nor the AI workers can see a
pursuit a test starts, and no grid camera is ever opened by a test.
"""

from __future__ import annotations

import dataclasses
import json
import time
import uuid
from collections.abc import AsyncGenerator, Callable
from datetime import UTC, datetime, timedelta
from typing import Any

import pytest
from httpx import AsyncClient
from sqlalchemy import delete, func, select

from app.db.session import SessionLocal
from app.models.intelligence import Detection
from app.models.registry import Camera
from app.models.security import AuditLog
from app.services import focus, pursuit
from app.services.pursuit import (
    Anchor,
    Context,
    FleetCamera,
    GridHold,
    Pin,
    PursuitState,
    plan_pins,
    predict,
    speed_basis,
)

NOW = datetime(2026, 10, 12, 4, 0, tzinfo=UTC)

# ─────────────────────────────────────────────────────────────────────
# The registry's positions, 12 Oct 2026
# ─────────────────────────────────────────────────────────────────────
PALDI = (23.00937, 72.56212)
AHMEDABAD = (23.0225, 72.5714)  # town-level: the grid names a town, not a junction
ADALAJ = (23.1645, 72.581)
DEHGAM = (23.1693, 72.8206)
JUNAGADH = (21.5222, 70.4579)
PATAN = (23.8493, 72.1266)
STATE_CENTRE = (22.2587, 71.1924)  # where an unplaced camera is put


def camera(
    code: str,
    at: tuple[float, float],
    *,
    grid: bool = True,
    town_level: bool = True,
    placed: bool = True,
    recorded: bool = False,
    always_on: bool = False,
    anpr: bool = True,
    vehicles: int = 0,
    plates: int = 0,
) -> FleetCamera:
    return FleetCamera(
        camera_id=str(uuid.uuid5(uuid.NAMESPACE_DNS, code)),
        code=code,
        name=code,
        city=None,
        lat=at[0],
        lon=at[1],
        placed=placed,
        town_level=town_level,
        anpr=anpr,
        grid=grid,
        recorded=recorded,
        always_on=always_on,
        vehicles_7d=vehicles,
        plates_7d=plates,
    )


def fleet() -> list[FleetCamera]:
    """The live fleet's shape: the recorded clip, the grid, its always-on three."""
    return [
        camera(
            "CAM-DEMO-01",
            PALDI,
            grid=False,
            town_level=False,
            recorded=True,
            always_on=True,
            vehicles=44_000,
            plates=17_000,
        ),
        camera("SBX-cam01", AHMEDABAD, vehicles=71),  # an overview: reads nothing
        camera("SBX-cam03", AHMEDABAD),
        camera("SBX-cam04", AHMEDABAD, vehicles=13),
        camera("SBX-cam15", AHMEDABAD, vehicles=55, plates=1),
        camera("SBX-cam12", ADALAJ, vehicles=1),
        camera("SBX-cam24", DEHGAM),
        camera("SBX-cam06", JUNAGADH, vehicles=4),
        camera("SBX-cam10", JUNAGADH, always_on=True, vehicles=1503, plates=118),
        camera("SBX-cam21", PATAN, always_on=True, vehicles=640, plates=130),
        camera("SBX-cam20", STATE_CENTRE, placed=False),
        camera("SBX-cam22", STATE_CENTRE, placed=False, always_on=True, vehicles=605, plates=275),
    ]


def anchor_at(code: str, at: tuple[float, float], seen: datetime, **kwargs: Any) -> Anchor:
    return Anchor(
        camera_id=str(uuid.uuid5(uuid.NAMESPACE_DNS, code)),
        camera_code=code,
        camera_name=code,
        lat=at[0],
        lon=at[1],
        town_level=kwargs.get("town_level", True),
        recorded=kwargs.get("recorded", False),
        seen_at=seen,
        detection_id="d",
    )


DEFAULT = speed_basis([])


def ranked_codes(items: list[pursuit.Predicted]) -> list[str]:
    return [item.camera.code for item in items]


# ─────────────────────────────────────────────────────────────────────
# Ranking
# ─────────────────────────────────────────────────────────────────────
class TestSpeedBand:
    def test_falls_back_to_the_stated_default_with_too_few_journeys(self) -> None:
        basis = speed_basis([30.0] * (pursuit.MIN_BAND_SAMPLES - 1))
        assert basis.kind == "default"
        assert (basis.low_kmph, basis.high_kmph) == pursuit.DEFAULT_BAND_KMPH
        assert "default band" in basis.note

    def test_uses_the_middle_of_what_was_observed(self) -> None:
        basis = speed_basis([float(s) for s in range(10, 60)])
        assert basis.kind == "observed_network"
        assert basis.samples == 50
        assert 13 <= basis.low_kmph <= 16 and 53 <= basis.high_kmph <= 56

    def test_ignores_speeds_no_vehicle_drives(self) -> None:
        assert speed_basis([500.0] * 20).kind == "default"


class TestPredict:
    def test_never_ranks_the_camera_that_read_it_or_one_with_no_position(self) -> None:
        anchor = anchor_at("SBX-cam12", ADALAJ, NOW)
        codes = ranked_codes(predict(anchor, fleet(), NOW, DEFAULT))
        assert "SBX-cam12" not in codes
        assert "SBX-cam20" not in codes and "SBX-cam22" not in codes

    def test_distances_are_straight_lines_between_the_real_positions(self) -> None:
        anchor = anchor_at("CAM-DEMO-01", PALDI, NOW, town_level=False, recorded=True)
        by_code = {p.camera.code: p for p in predict(anchor, fleet(), NOW, DEFAULT)}
        assert by_code["SBX-cam04"].distance_km == pytest.approx(1.74, abs=0.01)
        assert by_code["SBX-cam12"].distance_km == pytest.approx(17.36, abs=0.05)
        assert by_code["SBX-cam06"].distance_km == pytest.approx(272.4, abs=0.5)
        # The grid places these at the town's centre, and the reasons say so.
        assert by_code["SBX-cam04"].approximate
        assert "town's centre" in by_code["SBX-cam04"].reasons[0]

    @pytest.mark.parametrize(
        ("minutes_later", "window"),
        [(1, "soon"), (5, "open"), (15, "passed")],
    )
    def test_the_arrival_window_moves_with_the_clock(self, minutes_later: int, window: str) -> None:
        # 1.74 km at 10-60 km/h: between 1.7 and 10.4 minutes after the sighting.
        anchor = anchor_at("CAM-DEMO-01", PALDI, NOW, town_level=False)
        now = NOW + timedelta(minutes=minutes_later)
        by_code = {p.camera.code: p for p in predict(anchor, fleet(), now, DEFAULT)}
        assert by_code["SBX-cam04"].window == window
        assert by_code["SBX-cam06"].window == "later"  # Junagadh is hours away

    def test_the_window_is_computed_from_the_band(self) -> None:
        anchor = anchor_at("CAM-DEMO-01", PALDI, NOW, town_level=False)
        item = next(
            p for p in predict(anchor, fleet(), NOW, DEFAULT) if p.camera.code == "SBX-cam12"
        )
        assert item.eta_from is not None and item.eta_to is not None
        assert (item.eta_from - NOW).total_seconds() == pytest.approx(17.36 / 60 * 3600, rel=0.01)
        assert (item.eta_to - NOW).total_seconds() == pytest.approx(17.36 / 10 * 3600, rel=0.01)

    def test_observed_journeys_between_a_pair_replace_the_band(self) -> None:
        anchor = anchor_at("CAM-DEMO-01", PALDI, NOW, town_level=False)
        pairs = {("CAM-DEMO-01", "SBX-cam12"): [1500.0, 1600.0, 1800.0]}
        item = next(
            p for p in predict(anchor, fleet(), NOW, DEFAULT, pairs) if p.camera.code == "SBX-cam12"
        )
        assert item.basis == "observed_pair"
        assert item.eta_from == NOW + timedelta(seconds=1500)
        assert item.eta_to == NOW + timedelta(seconds=1800)

    def test_two_cameras_at_one_town_centre_have_no_distance_to_claim(self) -> None:
        anchor = anchor_at("SBX-cam03", AHMEDABAD, NOW)
        item = next(
            p for p in predict(anchor, fleet(), NOW, DEFAULT) if p.camera.code == "SBX-cam04"
        )
        assert item.window == "town" and item.distance_km is None
        assert "not known" in item.reasons[0]

    def test_reachable_first_nearer_first_and_overview_cameras_after_readers(self) -> None:
        anchor = anchor_at("CAM-DEMO-01", PALDI, NOW, town_level=False)
        ranked = predict(anchor, fleet(), NOW + timedelta(minutes=5), DEFAULT)
        windows = [p.window for p in ranked]
        assert windows == sorted(windows, key=lambda w: pursuit._WINDOW_ORDER[w])
        ahmedabad = [p.camera.code for p in ranked if p.distance_km and p.distance_km < 2]
        assert ahmedabad[-1] == "SBX-cam01", "an overview camera goes after the readers"
        assert [p.rank for p in ranked] == list(range(1, len(ranked) + 1))

    def test_says_when_a_camera_needs_no_pin_or_cannot_help(self) -> None:
        anchor = anchor_at("SBX-cam12", ADALAJ, NOW)
        by_code = {p.camera.code: p for p in predict(anchor, fleet(), NOW, DEFAULT)}
        assert any("needs no pin" in r for r in by_code["SBX-cam10"].reasons)
        assert any("recorded clip" in r for r in by_code["CAM-DEMO-01"].reasons)
        assert any("read no plate" in r for r in by_code["SBX-cam01"].reasons)
        assert not by_code["SBX-cam10"].pinnable
        assert not by_code["CAM-DEMO-01"].pinnable
        assert not by_code["SBX-cam01"].pinnable


# ─────────────────────────────────────────────────────────────────────
# Pins
# ─────────────────────────────────────────────────────────────────────
def ranking(minutes_later: float = 5) -> list[pursuit.Predicted]:
    """From Paldi, a few minutes on: the Ahmedabad cameras are reachable."""
    anchor = anchor_at("CAM-DEMO-01", PALDI, NOW, town_level=False)
    return predict(anchor, fleet(), NOW + timedelta(minutes=minutes_later), DEFAULT)


def pin(code: str, minutes_ago: float, *, grid: bool = True) -> Pin:
    return Pin(
        camera_code=code,
        camera_id=str(uuid.uuid5(uuid.NAMESPACE_DNS, code)),
        pinned_at=NOW + timedelta(minutes=5) - timedelta(minutes=minutes_ago),
        grid=grid,
    )


def plan(**kwargs: Any) -> pursuit.PinPlan:
    arguments: dict[str, Any] = {
        "wanted": 2,
        "capacity": 3,
        "now": NOW + timedelta(minutes=5),
        "own_lingering": {},
        "lingering": {},
    }
    arguments.update(kwargs)
    ranked = arguments.pop("ranked", None) or ranking()
    pins = arguments.pop("pins", [])
    return plan_pins(ranked, pins, **arguments)


class TestPlanPins:
    def test_pins_the_top_reachable_cameras_and_no_more(self) -> None:
        result = plan()
        assert [i.camera.code for i in result.add] == ["SBX-cam03", "SBX-cam04"]
        assert not result.keep and not result.release

    def test_never_more_than_the_workers_capacity(self) -> None:
        result = plan(wanted=3, capacity=1)
        assert len(result.add) == 1
        assert all("focus streams are all in use" in why for why in result.waiting.values())

    def test_never_pins_an_always_on_recorded_or_overview_camera(self) -> None:
        added = {i.camera.code for i in plan(wanted=3).add}
        assert added.isdisjoint({"SBX-cam10", "SBX-cam21", "CAM-DEMO-01", "SBX-cam01"})

    def test_keeps_a_young_pin_that_has_dropped_out_of_the_ranking(self) -> None:
        young = pin("SBX-cam24", minutes_ago=1)  # Dehgam: not reachable in 15 min
        result = plan(pins=[young])
        assert young in result.keep, "hysteresis: a pin is held at least MIN_PIN_S"

    def test_lets_an_old_pin_go_once_it_has_dropped_out(self) -> None:
        old = pin("SBX-cam24", minutes_ago=10)
        result = plan(pins=[old])
        assert [(p.camera_code, why) for p, why in result.release] == [
            ("SBX-cam24", "no longer among the likeliest next cameras")
        ]

    def test_keeps_an_old_pin_still_near_the_top(self) -> None:
        old = pin("SBX-cam15", minutes_ago=10)  # rank 3, inside the hysteresis band
        result = plan(pins=[old])
        assert old in result.keep

    def test_a_released_stream_counts_until_the_workers_close_it(self) -> None:
        released = {
            "SBX-cam24": NOW + timedelta(minutes=4),
            "SBX-cam06": NOW + timedelta(minutes=4),
        }
        result = plan(own_lingering=released, lingering=released)
        assert not result.add
        assert all("already holds 2 streams open" in why for why in result.waiting.values())

    def test_re_pinning_a_stream_still_open_costs_nothing(self) -> None:
        released = {"SBX-cam03": NOW + timedelta(minutes=4)}
        result = plan(own_lingering=released, lingering=released, capacity=1)
        assert [i.camera.code for i in result.add] == ["SBX-cam03"]

    def test_cameras_on_someone_screen_use_the_capacity(self) -> None:
        result = plan(others_open=frozenset({"SBX-cam10", "SBX-cam21"}), capacity=3)
        assert len(result.add) == 1

    def test_holds_grid_pins_and_lets_existing_ones_go(self) -> None:
        held = pin("SBX-cam03", minutes_ago=0.5)
        result = plan(pins=[held], grid_hold=True, hold_note="the grid is refusing us")
        assert not result.add and not result.keep
        assert result.release == [(held, "the grid is refusing us")]

    def test_lets_go_of_a_pin_the_workers_were_not_let_in_to(self) -> None:
        stuck = pin("SBX-cam03", minutes_ago=5)
        result = plan(pins=[stuck], unproven={"SBX-cam03": "no detection"})
        assert result.release == [(stuck, "no detection")]

    def test_a_blocked_pursuit_pins_nothing(self) -> None:
        existing = pin("SBX-cam04", minutes_ago=1)
        result = plan(pins=[existing], blocked="recorded clip")
        assert not result.add and not result.keep
        assert result.release == [(existing, "recorded clip")]

    def test_the_labels_say_why_each_camera_is_or_is_not_pinned(self) -> None:
        # From Adalaj, so the recorded clip at Paldi is among the ranked.
        anchor = anchor_at("SBX-cam12", ADALAJ, NOW)
        ranked = predict(anchor, fleet(), NOW + timedelta(minutes=5), DEFAULT)
        result = plan(ranked=ranked, wanted=1)
        pinned = {i.camera.code for i in result.add}
        pursuit.label_pins(ranked, pinned, result.waiting, grid_hold=False, hold_note="")
        states = {p.camera.code: p.pin_state for p in ranked}
        assert states["SBX-cam03"] == "pinned"
        assert states["SBX-cam04"] == "ranked_lower"
        assert states["SBX-cam10"] == "always_on"
        assert states["CAM-DEMO-01"] == "recorded"
        assert states["SBX-cam01"] == "reads_no_plates"
        assert states["SBX-cam06"] == "outside_window"


def context(**kwargs: Any) -> Context:
    values: dict[str, Any] = {
        "now": NOW,
        "cameras": fleet(),
        "basis": DEFAULT,
        "pair_seconds": {},
        "last_grid_detection": NOW - timedelta(minutes=1),
        "on_screen": frozenset(),
        "lingering": {},
        "hold": GridHold(),
        "capacity": 3,
    }
    values.update(kwargs)
    return Context(**values)


class TestGridHold:
    def test_detections_from_the_grid_mean_it_is_letting_us_in(self) -> None:
        assert context().grid_hold() == (False, "")

    def test_silence_from_the_grid_holds_its_pins_and_says_it_is_inferred(self) -> None:
        held, why = context(last_grid_detection=NOW - timedelta(minutes=11)).grid_hold()
        assert held
        assert "No grid camera has produced a detection for 11 min" in why
        assert "what a refused login looks like" in why

    def test_a_hold_lasts_until_it_ends(self) -> None:
        hold = GridHold(until=NOW + timedelta(minutes=2), streak=1, reason="SBX-cam03 stalled.")
        held, why = context(hold=hold).grid_hold()
        assert held and why.startswith("SBX-cam03 stalled.")
        assert not context(hold=hold, now=NOW + timedelta(minutes=3)).grid_hold()[0]


class TestStep:
    async def test_a_recorded_clip_never_spends_a_pin(self) -> None:
        state = pursuit.new_state("ZZTEST01", "t", "t", 2, NOW)
        state.anchor = anchor_at("CAM-DEMO-01", PALDI, NOW - timedelta(minutes=3), recorded=True)
        await pursuit.step(None, state, context(), dry_run=True)  # type: ignore[arg-type]
        states = {p["camera_code"]: p["pin_state"] for p in state.predictions}
        assert "would_pin" not in states.values()
        assert states["SBX-cam03"] == "held"
        assert "recorded clip" in pursuit.describe(state, NOW)["notes"][0]

    async def test_a_grid_that_went_quiet_is_held_in_the_panel(self) -> None:
        state = pursuit.new_state("ZZTEST01", "t", "t", 2, NOW)
        state.anchor = anchor_at("SBX-cam12", ADALAJ, NOW - timedelta(minutes=3))
        await pursuit.step(
            None,  # type: ignore[arg-type]
            state,
            context(last_grid_detection=None),
            dry_run=True,
        )
        body = pursuit.describe(state, NOW)
        assert body["grid"]["held"] is True
        assert "cannot see the AI workers' login state" in body["grid"]["visibility"]


class TestState:
    def test_survives_a_round_trip_through_redis(self) -> None:
        state = pursuit.new_state("ZZTEST01", "operator", "u", 2, NOW)
        state.anchor = anchor_at("SBX-cam12", ADALAJ, NOW)
        state.pins = [pin("SBX-cam03", 1)]
        state.released = {"SBX-cam24": NOW}
        state.note(NOW, "Started.")
        again = PursuitState.from_json(state.to_json())
        assert again.to_json() == state.to_json()

    def test_pins_are_clamped_to_the_workers_focus_capacity(self) -> None:
        assert pursuit.clamp_pins(10) == pursuit.settings.focus_max_streams
        assert pursuit.clamp_pins(None) == pursuit.DEFAULT_PINS
        assert pursuit.clamp_pins(0) == pursuit.DEFAULT_PINS


# ─────────────────────────────────────────────────────────────────────
# Over HTTP and through the keeper — with every key moved aside
# ─────────────────────────────────────────────────────────────────────
PLATE = "ZZPURSUIT1"
NEAR_PLATE = "ZZPURSU1T1"  # I read as 1


def synthetic_fleet() -> list[FleetCamera]:
    """Synthetic cameras at real positions, none of them real: the anchor at
    Adalaj, two pinnable cameras, a grid camera, and an always-on one."""
    return [
        camera("ZZT-ADALAJ", ADALAJ, grid=False, vehicles=100, plates=40),
        camera("ZZT-AHMEDABAD", AHMEDABAD, grid=False, vehicles=100, plates=40),
        camera("ZZT-DEHGAM", DEHGAM, grid=False, vehicles=100, plates=40),
        camera("ZZT-GRID", AHMEDABAD, grid=True, vehicles=100, plates=40),
        camera("ZZT-ALWAYS", PALDI, grid=False, always_on=True, vehicles=100, plates=40),
    ]


@pytest.fixture
async def isolated(monkeypatch: pytest.MonkeyPatch) -> AsyncGenerator[dict[str, Any], None]:
    """Pursuit and focus keys under a throwaway prefix; the fleet synthetic."""
    tag = uuid.uuid4().hex[:8]
    monkeypatch.setattr(pursuit, "KEY_PREFIX", f"nagarnetra:test:{tag}:pursuit")
    monkeypatch.setattr(focus, "FOCUS_KEY", f"nagarnetra:test:{tag}:focus")
    setup: dict[str, Any] = {
        "cameras": synthetic_fleet(),
        "last_grid_detection": datetime.now(UTC) - timedelta(minutes=1),
        "anchor": "ZZT-ADALAJ",
        "recorded": False,
    }

    async def fake_context(_session: Any, now: datetime | None = None) -> Context:
        now = now or datetime.now(UTC)
        return context(
            now=now,
            cameras=setup["cameras"],
            last_grid_detection=setup["last_grid_detection"],
            on_screen=frozenset(),
            lingering=await pursuit._released(focus.client(), now),
            hold=await pursuit._hold(focus.client()),
        )

    async def fake_anchor(_s: Any, _plate: str, cameras: Any, now: datetime) -> Anchor | None:
        code = setup["anchor"]
        if code is None:
            return None
        found = next(c for c in cameras if c.code == code)
        return Anchor(
            camera_id=found.camera_id,
            camera_code=found.code,
            camera_name=found.name,
            lat=found.lat,
            lon=found.lon,
            town_level=found.town_level,
            recorded=setup["recorded"],
            seen_at=now - timedelta(minutes=12),
            detection_id="synthetic",
        )

    monkeypatch.setattr(pursuit, "context", fake_context)
    monkeypatch.setattr(pursuit, "anchor_for", fake_anchor)
    yield setup
    client = focus.client()
    async for key in client.scan_iter(match=f"nagarnetra:test:{tag}:*"):
        await client.delete(key)


async def focused() -> set[str]:
    return set(await focus.watched(time.time()))


async def audit_count(action: str, resource_id: str = PLATE, **where: Any) -> int:
    query = (
        select(func.count())
        .select_from(AuditLog)
        .where(AuditLog.action == action, AuditLog.resource_id == resource_id)
    )
    for column, value in where.items():
        query = query.where(getattr(AuditLog, column) == value)
    async with SessionLocal() as session:
        return (await session.execute(query)).scalar_one()


StartFn = Callable[..., Any]


@pytest.fixture
def start(client: AsyncClient, auth_headers) -> StartFn:
    async def _start(role: str = "operator", **body: Any) -> Any:
        return await client.post(
            "/api/v1/pursuits", json={"plate": PLATE, **body}, headers=await auth_headers(role)
        )

    return _start


@pytest.mark.integration
class TestStartingAndStopping:
    async def test_pins_the_cameras_it_can_reach_next_and_says_so_in_the_trail(
        self, client: AsyncClient, auth_headers, isolated, start: StartFn
    ) -> None:
        before = await audit_count("pursuit.start")
        generic = await audit_count("pursuits.create", resource_id=PLATE)
        response = await start()
        assert response.status_code == 201, response.text
        body = response.json()
        pinned = [p["camera_code"] for p in body["pins"]]
        # Adalaj to Ahmedabad's centre is ~16 km: at 10-60 km/h the window is
        # open twelve minutes after the sighting; Dehgam (~25 km) opens soon.
        assert pinned == ["ZZT-AHMEDABAD", "ZZT-GRID"]
        assert await focused() == set(pinned)
        assert body["remaining_s"] > 14 * 60
        assert await audit_count("pursuit.start") == before + 1
        assert await audit_count("pursuits.create", resource_id=PLATE) == generic
        states = {p["camera_code"]: p["pin_state"] for p in body["predictions"]}
        assert states["ZZT-ALWAYS"] == "always_on"

    async def test_needs_the_right_to_watch(self, isolated, start: StartFn) -> None:
        """Analysts work over recorded detections and may not open cameras."""
        response = await start(role="analyst")
        assert response.status_code == 403
        assert await focused() == set()

    async def test_never_more_pins_than_the_workers_take(self, isolated, start: StartFn) -> None:
        body = (await start(pins=10)).json()
        assert body["pins_wanted"] == pursuit.settings.focus_max_streams

    async def test_starting_it_again_renews_it(self, isolated, start: StartFn) -> None:
        await start()
        renewals = await audit_count("pursuit.renew")
        response = await start()
        assert response.status_code == 200
        assert await audit_count("pursuit.renew") == renewals + 1

    async def test_stopping_releases_its_streams_and_is_audited(
        self, client: AsyncClient, auth_headers, isolated, start: StartFn
    ) -> None:
        pinned = [p["camera_code"] for p in (await start()).json()["pins"]]
        stops = await audit_count("pursuit.stop")
        response = await client.delete(
            f"/api/v1/pursuits/{PLATE}", headers=await auth_headers("operator")
        )
        assert response.status_code == 200, response.text
        assert response.json()["released"] == pinned
        assert await pursuit.load(PLATE) is None
        lingering = await pursuit._released(focus.client(), datetime.now(UTC))
        assert set(lingering) == set(pinned), "their streams count until the workers close them"
        assert await audit_count("pursuit.stop") == stops + 1

    async def test_stopping_what_is_not_running_is_not_found(
        self, client: AsyncClient, auth_headers, isolated
    ) -> None:
        response = await client.delete(
            f"/api/v1/pursuits/{PLATE}", headers=await auth_headers("operator")
        )
        assert response.status_code == 404


@pytest.mark.integration
class TestWatchingAPursuit:
    async def test_the_top_bar_lists_it_without_its_sightings(
        self, client: AsyncClient, auth_headers, isolated, start: StartFn
    ) -> None:
        await start()
        body = (await client.get("/api/v1/pursuits", headers=await auth_headers("analyst"))).json()
        listed = [p for p in body["pursuits"] if p["plate"] == PLATE]
        assert listed and "sightings" not in listed[0]
        assert listed[0]["remaining_s"] > 0

    async def test_opening_the_detail_is_audited_once_per_person(
        self, client: AsyncClient, auth_headers, isolated, start: StartFn
    ) -> None:
        await start()
        headers = await auth_headers("supervisor")
        views = await audit_count("search.plate", username="supervisor")
        for _ in range(3):
            response = await client.get(f"/api/v1/pursuits/{PLATE}", headers=headers)
            assert response.status_code == 200
        assert await audit_count("search.plate", username="supervisor") == views + 1

    async def test_an_auditor_sees_no_pursuit(self, client: AsyncClient, auth_headers) -> None:
        response = await client.get("/api/v1/pursuits", headers=await auth_headers("auditor"))
        assert response.status_code == 403

    async def test_a_prediction_pins_nothing_and_saves_nothing(
        self, client: AsyncClient, auth_headers, isolated
    ) -> None:
        predictions = await audit_count("search.plate", username="operator")
        response = await client.get(
            f"/api/v1/pursuits/{PLATE}/prediction", headers=await auth_headers("operator")
        )
        assert response.status_code == 200, response.text
        body = response.json()
        assert body["status"] == "preview"
        assert body["would_pin"] == ["ZZT-AHMEDABAD", "ZZT-GRID"]
        assert await pursuit.load(PLATE) is None
        assert await focused() == set()
        assert await audit_count("search.plate", username="operator") == predictions + 1


@pytest.mark.integration
class TestTheGrid:
    async def test_a_quiet_grid_gets_no_pin(self, isolated, start: StartFn) -> None:
        isolated["last_grid_detection"] = datetime.now(UTC) - timedelta(minutes=30)
        body = (await start()).json()
        pinned = [p["camera_code"] for p in body["pins"]]
        assert "ZZT-GRID" not in pinned
        assert pinned == ["ZZT-AHMEDABAD", "ZZT-DEHGAM"]
        assert body["grid"]["held"] is True
        states = {p["camera_code"]: p for p in body["predictions"]}
        assert states["ZZT-GRID"]["pin_state"] == "held"
        assert "refused login" in states["ZZT-GRID"]["pin_note"]

    async def test_a_recorded_clip_pins_nothing(self, isolated, start: StartFn) -> None:
        isolated["recorded"] = True
        body = (await start()).json()
        assert body["pins"] == []
        assert await focused() == set()


@pytest.mark.integration
class TestTheKeeper:
    async def test_keeps_the_pins_alive(self, isolated, start: StartFn) -> None:
        await start()
        await focus.client().delete(focus.FOCUS_KEY)
        assert await focused() == set()
        assert await pursuit.keeper.tick() == 1
        assert await focused() == {"ZZT-AHMEDABAD", "ZZT-GRID"}

    async def test_ends_a_pursuit_nobody_renewed(self, isolated, start: StartFn) -> None:
        await start()
        state = await pursuit.load(PLATE)
        assert state is not None
        state.expires_at = datetime.now(UTC) - timedelta(seconds=1)
        await pursuit.save(state)
        expiries = await audit_count("pursuit.expire", username="system")
        assert await pursuit.keeper.tick() == 0
        assert await pursuit.load(PLATE) is None
        assert await audit_count("pursuit.expire", username="system") == expiries + 1

    async def test_advances_on_a_read_and_shows_a_near_read_without_advancing(
        self, isolated, start: StartFn
    ) -> None:
        """A read of the plate re-ranks from where it was read; a read one
        misreading away is listed as possible and moves nothing."""
        async with SessionLocal() as session:
            real = await session.scalar(select(Camera).where(Camera.camera_code == "CAM-DEMO-01"))
        if real is None:
            pytest.skip("CAM-DEMO-01 is not in the registry")
        # A synthetic camera carrying a real id, so a detection can name it.
        cameras = synthetic_fleet()
        cameras[2] = dataclasses.replace(cameras[2], camera_id=str(real.id))
        isolated["cameras"] = cameras
        await start()

        now = datetime.now(UTC)
        ids = [uuid.uuid4(), uuid.uuid4()]
        async with SessionLocal() as session:
            for detection_id, plate, at in (
                (ids[0], NEAR_PLATE, now - timedelta(seconds=20)),
                (ids[1], PLATE, now - timedelta(seconds=10)),
            ):
                session.add(
                    Detection(
                        id=detection_id,
                        ts=at,
                        camera_id=real.id,
                        track_id=f"pursuit-test-{detection_id.hex[:8]}",
                        plate_normalised=plate,
                        plate_confidence=0.9,
                    )
                )
            await session.commit()
        try:
            await pursuit.keeper.tick()
        finally:
            async with SessionLocal() as session:
                await session.execute(delete(Detection).where(Detection.id.in_(ids)))
                await session.commit()

        state = await pursuit.load(PLATE)
        assert state is not None and state.anchor is not None
        assert state.anchor.camera_code == "ZZT-DEHGAM"
        kinds = {s["plate"]: s for s in state.sightings}
        assert kinds[PLATE]["kind"] == "confirmed" and kinds[PLATE]["advanced"] is True
        assert kinds[NEAR_PLATE]["kind"] == "possible"
        assert kinds[NEAR_PLATE]["advanced"] is False
        assert "a common misreading" in kinds[NEAR_PLATE]["difference"]
        assert "advanced" in state.events[0]["text"] or any(
            "advanced" in e["text"] for e in state.events
        )
        assert json.loads(state.to_json())["anchor"]["camera_code"] == "ZZT-DEHGAM"
