"""Alert deduplication and lifecycle.

Both exist to make alerts trustworthy rather than merely present: forty alerts
for one stationary car is worse than none, and a status that can move backwards
makes the record meaningless.
"""

from __future__ import annotations

import uuid
from datetime import UTC, datetime, timedelta

import pytest

from app.models.enums import AlertStatus, AlertType, Priority
from app.models.intelligence import Alert
from app.services.alerts import (
    ALLOWED_TRANSITIONS,
    AlertDeduper,
    InvalidTransition,
    deduper,
    raise_for_anomaly,
    raise_for_match,
    transition,
)
from app.services.anomaly import Reason
from app.services.watchlist import Match, WatchlistEntry


class TestDeduplication:
    def test_first_hit_is_not_a_repeat(self) -> None:
        d = AlertDeduper()
        assert d.seen("GJ03AB1234", "CAM-1") is None

    def test_second_hit_within_the_window_is_suppressed(self) -> None:
        """A car stopped at a junction must not raise an alert per detection."""
        d = AlertDeduper()
        alert_id = uuid.uuid4()
        assert d.seen("GJ03AB1234", "CAM-1") is None
        d.remember("GJ03AB1234", "CAM-1", alert_id)

        repeat = d.seen("GJ03AB1234", "CAM-1")
        assert repeat is not None
        assert repeat.alert_id == alert_id

    def test_repeats_are_counted_on_the_original(self) -> None:
        """'Seen 12 times' is useful; twelve rows are not."""
        d = AlertDeduper()
        d.remember("GJ03AB1234", "CAM-1", uuid.uuid4())
        for _ in range(3):
            d.seen("GJ03AB1234", "CAM-1")
        assert d.seen("GJ03AB1234", "CAM-1").repeats == 4

    def test_the_same_plate_at_another_camera_is_a_new_alert(self) -> None:
        """That is the vehicle moving — the thing the system exists to notice."""
        d = AlertDeduper()
        d.remember("GJ03AB1234", "CAM-1", uuid.uuid4())
        assert d.seen("GJ03AB1234", "CAM-2") is None

    def test_a_hit_after_the_window_alerts_again(self) -> None:
        d = AlertDeduper(window=timedelta(seconds=30))
        now = datetime.now(UTC)
        d.remember("GJ03AB1234", "CAM-1", uuid.uuid4(), now=now - timedelta(seconds=60))
        assert d.seen("GJ03AB1234", "CAM-1", now=now) is None

    def test_expired_entries_are_pruned(self) -> None:
        """The window is short; the map must not grow for the process lifetime."""
        d = AlertDeduper(window=timedelta(seconds=10))
        now = datetime.now(UTC)
        for i in range(50):
            d.remember(f"GJ03AB{i:04d}", "CAM-1", uuid.uuid4(), now=now - timedelta(seconds=60))
        d.seen("TRIGGER", "CAM-1", now=now)
        assert len(d._recent) <= 1

    def test_an_anomaly_and_a_watchlist_hit_never_fold_into_each_other(self) -> None:
        """Same plate, same camera, same minute: still two different facts."""
        d = AlertDeduper()
        d.remember("GJ03AB1234", "CAM-1", uuid.uuid4(), kind="anomaly")
        assert d.seen("GJ03AB1234", "CAM-1") is None
        assert d.seen("GJ03AB1234", "CAM-1", kind="anomaly") is not None


class _Session:
    """Just enough of a session for the raise functions, which add and flush."""

    def __init__(self) -> None:
        self.added: list[Alert] = []

    def add(self, alert: Alert) -> None:
        self.added.append(alert)

    async def flush(self) -> None:
        return None


def _critical_entry(plate: str = "GJ03AB1234") -> WatchlistEntry:
    return WatchlistEntry(
        id=uuid.uuid4(),
        plate=plate,
        category="stolen",
        priority=Priority.CRITICAL.value,
        case_ref="FIR/TEST/0001",
        valid_from=None,
        valid_to=None,
    )


@pytest.fixture
def fresh_deduper():
    deduper.clear()
    yield
    deduper.clear()


class TestRealPriorityOnTheDay:
    """B7 (readiness plan): a critical entry was seen to raise a medium alert.

    The medium alert is the near match, capped by design — a one-character
    misread is a lead, not a stolen car. What must hold is the other half: the
    exact read of the same car raises its own alert at the entry's priority,
    whatever was raised for that plate and camera just before it.
    """

    @pytest.mark.asyncio
    async def test_the_exact_read_after_a_near_miss_is_raised_at_its_real_priority(
        self, fresh_deduper
    ) -> None:
        entry = _critical_entry()
        session = _Session()

        near = await raise_for_match(
            session,
            match=Match(entry=entry, exact=False, distance=1),
            plate="GJ03AB1284",
            camera_id=None,
            camera_code="CAM-1",
            detection_id=None,
            detection_ts=None,
            confidence=0.8,
        )
        exact = await raise_for_match(
            session,
            match=Match(entry=entry, exact=True, distance=0),
            plate="GJ03AB1234",
            camera_id=None,
            camera_code="CAM-1",
            detection_id=None,
            detection_ts=None,
            confidence=0.93,
        )

        assert near is not None and exact is not None
        assert (near.alert_type, near.priority) == (
            AlertType.POSSIBLE_MATCH.value,
            Priority.MEDIUM.value,
        )
        assert (exact.alert_type, exact.priority) == (
            AlertType.WATCHLIST_HIT.value,
            Priority.CRITICAL.value,
        )

    @pytest.mark.asyncio
    async def test_a_trajectory_anomaly_cannot_swallow_a_watchlist_hit(self, fresh_deduper) -> None:
        session = _Session()
        anomaly_alert = await raise_for_anomaly(
            session,
            plate="GJ03AB1234",
            camera_id=None,
            camera_code="CAM-1",
            arrived_at=datetime.now(UTC),
            reasons=[Reason("impossible_hop", "CAM-0 → CAM-1: not physically plausible")],
        )
        hit = await raise_for_match(
            session,
            match=Match(entry=_critical_entry(), exact=True, distance=0),
            plate="GJ03AB1234",
            camera_id=None,
            camera_code="CAM-1",
            detection_id=None,
            detection_ts=None,
            confidence=0.93,
        )

        assert anomaly_alert is not None
        assert hit is not None, "the watchlist hit was folded into the anomaly"
        assert hit.priority == Priority.CRITICAL.value


class TestLifecycle:
    @pytest.mark.asyncio
    async def test_acknowledge_records_who_and_when(self) -> None:
        alert = Alert(status=AlertStatus.NEW.value, alert_type="watchlist_hit", priority="high")
        user = uuid.uuid4()

        class FakeSession:
            async def flush(self) -> None:
                return None

        await transition(FakeSession(), alert, to=AlertStatus.ACKNOWLEDGED.value, user_id=user)
        assert alert.status == AlertStatus.ACKNOWLEDGED.value
        assert alert.acknowledged_by == user
        assert alert.acknowledged_at is not None

    @pytest.mark.asyncio
    async def test_a_closed_alert_cannot_be_reopened(self) -> None:
        """A record that can move backwards is not a record."""
        alert = Alert(status=AlertStatus.CLOSED.value, alert_type="watchlist_hit", priority="high")

        class FakeSession:
            async def flush(self) -> None:
                return None

        with pytest.raises(InvalidTransition):
            await transition(FakeSession(), alert, to=AlertStatus.NEW.value, user_id=uuid.uuid4())

    @pytest.mark.asyncio
    async def test_cannot_dispatch_before_acknowledging(self) -> None:
        alert = Alert(status=AlertStatus.NEW.value, alert_type="watchlist_hit", priority="high")

        class FakeSession:
            async def flush(self) -> None:
                return None

        with pytest.raises(InvalidTransition):
            await transition(
                FakeSession(), alert, to=AlertStatus.DISPATCHED.value, user_id=uuid.uuid4()
            )

    @pytest.mark.asyncio
    async def test_notes_accumulate_rather_than_overwrite(self) -> None:
        """The handling history is the point; each step must survive."""
        alert = Alert(
            status=AlertStatus.NEW.value,
            alert_type="watchlist_hit",
            priority="high",
            notes="raised automatically",
        )

        class FakeSession:
            async def flush(self) -> None:
                return None

        await transition(
            FakeSession(),
            alert,
            to=AlertStatus.ACKNOWLEDGED.value,
            user_id=uuid.uuid4(),
            notes="operator confirmed plate",
        )
        assert "raised automatically" in alert.notes
        assert "operator confirmed plate" in alert.notes

    def test_terminal_states_allow_nothing(self) -> None:
        assert ALLOWED_TRANSITIONS[AlertStatus.CLOSED.value] == set()
        assert ALLOWED_TRANSITIONS[AlertStatus.FALSE_POSITIVE.value] == set()

    def test_false_positive_is_reachable_from_every_open_state(self) -> None:
        """Operators must always be able to say 'this was wrong'.

        Those corrections are the data that improves the models.
        """
        for state in (AlertStatus.NEW, AlertStatus.ACKNOWLEDGED, AlertStatus.DISPATCHED):
            assert AlertStatus.FALSE_POSITIVE.value in ALLOWED_TRANSITIONS[state.value]
