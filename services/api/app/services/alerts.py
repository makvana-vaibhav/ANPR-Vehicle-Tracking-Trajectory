"""Raising alerts, and moving them through their lifecycle.

Two things here are load-bearing for whether a control room trusts this system.

**Deduplication.** A vehicle stopped at a junction is detected repeatedly, and a
watchlisted one would otherwise raise an alert every time. Forty alerts for one
car is worse than none: operators stop reading them. So a hit on the same plate
at the same camera is suppressed for a window, and the suppression is counted on
the original alert rather than discarded — "seen 12 times" is useful, twelve
rows are not.

The window is per (plate, camera). The same plate at a *different* camera is a
new alert on purpose: that is the vehicle moving, which is exactly what a
cross-camera system exists to notice.

The window is kept in **Redis**, not in the process (`SharedAlertDeduper`).
Ingest scales by adding consumer replicas to one consumer group, and with the
window in each process's memory two replicas that each received one sighting of
the same stolen car raised two alarms for it. A key per (kind, plate, camera)
claimed with `SET NX` and an expiry makes the first replica's claim the one
every replica sees. If Redis cannot be reached the process falls back to its own
memory: duplicates across replicas become possible again for that moment, but
no alert is ever suppressed for want of a cache.

**Lifecycle.** new -> acknowledged -> dispatched -> closed / false_positive,
and every transition records who and when. `false_positive` is a first-class
outcome, not a deletion: a system that lets operators quietly erase its mistakes
cannot be audited, and the false positives are the data that improves it.
"""

from __future__ import annotations

import json
import time
import uuid
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from contextvars import ContextVar
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from typing import Any, cast

import redis.asyncio as aioredis
from redis.exceptions import RedisError
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings
from app.core.logging import get_logger
from app.models.enums import AlertStatus, AlertType, Priority
from app.models.intelligence import Alert
from app.services.anomaly import Reason
from app.services.watchlist import Match

log = get_logger(__name__)

#: How long a repeat hit on the same plate at the same camera is folded into
#: the existing alert instead of raising a new one.
DEDUP_WINDOW = timedelta(seconds=90)

#: Every dedup key lives under this prefix: `<prefix>:<kind>:<plate>:<camera>`.
DEDUP_KEY_PREFIX = "nagarnetra:dedup"

#: Deletes a claim only if it is still ours. A claim released after its window
#: expired and another replica re-claimed it must not take that one with it.
_RELEASE_IF_OURS = """
if redis.call('get', KEYS[1]) == ARGV[1] then
  redis.call('del', KEYS[1], KEYS[2])
  return 1
end
return 0
"""

#: Which transitions are legal. An alert cannot go from closed back to new, and
#: attempting it is an error rather than something that silently succeeds.
ALLOWED_TRANSITIONS: dict[str, set[str]] = {
    AlertStatus.NEW.value: {
        AlertStatus.ACKNOWLEDGED.value,
        AlertStatus.FALSE_POSITIVE.value,
        AlertStatus.CLOSED.value,
    },
    AlertStatus.ACKNOWLEDGED.value: {
        AlertStatus.DISPATCHED.value,
        AlertStatus.CLOSED.value,
        AlertStatus.FALSE_POSITIVE.value,
    },
    AlertStatus.DISPATCHED.value: {
        AlertStatus.CLOSED.value,
        AlertStatus.FALSE_POSITIVE.value,
    },
    AlertStatus.CLOSED.value: set(),
    AlertStatus.FALSE_POSITIVE.value: set(),
}


class InvalidTransition(ValueError):
    """Raised when a lifecycle move is not permitted from the current status."""


@dataclass
class _RecentHit:
    alert_id: uuid.UUID
    raised_at: datetime
    repeats: int = 0


@dataclass
class AlertDeduper:
    """Remembers recent alerts so repeats fold into them — in this process.

    The fallback behind `SharedAlertDeduper`, used when Redis cannot be
    reached, and the rules both follow. On its own it is correct only while
    exactly one process raises alerts: each replica would hold its own window.

    Remembered per `kind` as well as per plate and camera. A repeat folds into
    an alert *of its own kind* only: a watchlist hit arriving within the window
    of a trajectory anomaly on the same plate and camera is a known vehicle
    read now, and folding it into a journey to explain would leave the stolen
    car with no alarm of its own at all.
    """

    window: timedelta = DEDUP_WINDOW
    _recent: dict[tuple[str, str, str], _RecentHit] = field(default_factory=dict)

    def _prune(self, now: datetime) -> None:
        cutoff = now - self.window
        stale = [key for key, hit in self._recent.items() if hit.raised_at < cutoff]
        for key in stale:
            del self._recent[key]

    def seen(
        self, plate: str, camera: str, now: datetime | None = None, *, kind: str = "watchlist"
    ) -> _RecentHit | None:
        moment = now or datetime.now(UTC)
        self._prune(moment)
        hit = self._recent.get((kind, plate, camera))
        if hit is None:
            return None
        hit.repeats += 1
        return hit

    def remember(
        self,
        plate: str,
        camera: str,
        alert_id: uuid.UUID,
        now: datetime | None = None,
        *,
        kind: str = "watchlist",
    ) -> None:
        self._recent[(kind, plate, camera)] = _RecentHit(
            alert_id=alert_id, raised_at=now or datetime.now(UTC)
        )

    def forget(self, plate: str, camera: str, alert_id: uuid.UUID, *, kind: str) -> None:
        hit = self._recent.get((kind, plate, camera))
        if hit is not None and hit.alert_id == alert_id:
            del self._recent[(kind, plate, camera)]

    def clear(self) -> None:
        self._recent.clear()


@dataclass(frozen=True, slots=True)
class _Claim:
    key: str
    value: str
    plate: str
    camera: str
    kind: str
    alert_id: uuid.UUID


#: Claims made inside the current `SharedAlertDeduper.unit()`, so they can be
#: released if the transaction that would have stored their alerts fails.
_unit_claims: ContextVar[list[_Claim] | None] = ContextVar("dedup_unit_claims", default=None)


class SharedAlertDeduper:
    """The dedup window, shared by every replica through Redis.

    `claim()` is the whole protocol: `SET <key> <alert> NX PX <window>`. The
    replica whose SET lands raises the alert, under the id it claimed with;
    every other replica, and this one on a repeat, finds the key and folds the
    hit into that alert, counting the repeat beside it.

    **Claims are released if the alert is not stored.** A claim is made before
    the transaction commits. Should that transaction roll back, the key would
    otherwise suppress the plate for the rest of the window and the alert would
    never exist anywhere — the consumer retries a failed batch one event at a
    time, and every retry would find the dead claim. Callers wrap their
    transaction in `unit()`, which releases the claims it made if the block
    raises. (The in-memory deduper this replaced had the same hole.)

    A short-lived connection per call rather than a pooled client: alerts are
    rare — a few an hour — and a client bound to one event loop breaks the
    moment a test, or a restarted task, runs on another.
    """

    def __init__(
        self,
        window: timedelta = DEDUP_WINDOW,
        *,
        prefix: str = DEDUP_KEY_PREFIX,
        redis_url: str | None = None,
    ) -> None:
        self.window = window
        self.prefix = prefix
        self._redis_url = redis_url
        #: Used only when Redis cannot be reached, so dedup still holds within
        #: this process.
        self._local = AlertDeduper(window=window)
        #: Keys this instance claimed, with when they expire — for `clear()`,
        #: which must not touch keys another replica claimed.
        self._claimed: dict[str, float] = {}

    def key(self, kind: str, plate: str, camera: str) -> str:
        return f"{self.prefix}:{kind}:{plate}:{camera}"

    def _client(self) -> aioredis.Redis:
        # redis-py leaves `from_url` unannotated, so its result is Any.
        return cast(
            aioredis.Redis,
            aioredis.from_url(
                self._redis_url or settings.redis_url,
                decode_responses=True,
                socket_connect_timeout=2.0,
                socket_timeout=2.0,
            ),
        )

    async def claim(
        self,
        plate: str,
        camera: str,
        alert_id: uuid.UUID,
        now: datetime | None = None,
        *,
        kind: str = "watchlist",
        window: timedelta | None = None,
    ) -> _RecentHit | None:
        """None when this caller should raise the alert, under `alert_id`;
        otherwise the earlier alert this hit repeats."""
        moment = now or datetime.now(UTC)
        span = window or self.window
        ttl_ms = max(1, int(span.total_seconds() * 1000))
        key = self.key(kind, plate, camera)
        value = json.dumps({"alert_id": str(alert_id), "raised_at": moment.isoformat()})
        client = self._client()
        try:
            # Twice at most: the key can expire between a refused SET and the
            # GET that would read it, and the hit is then a new alert.
            for _ in range(2):
                if await client.set(key, value, nx=True, px=ttl_ms):
                    await client.delete(f"{key}:repeats")
                    self._remember(_Claim(key, value, plate, camera, kind, alert_id), ttl_ms)
                    return None
                pipe = client.pipeline(transaction=False)
                pipe.get(key)
                pipe.incr(f"{key}:repeats")
                pipe.pexpire(f"{key}:repeats", ttl_ms)
                held, repeats, _ = await pipe.execute()
                if held is not None:
                    earlier = json.loads(held)
                    return _RecentHit(
                        alert_id=uuid.UUID(earlier["alert_id"]),
                        raised_at=datetime.fromisoformat(earlier["raised_at"]),
                        repeats=int(repeats),
                    )
        except (RedisError, OSError, ValueError, KeyError) as exc:
            log.warning(
                "alert.dedup_shared_unavailable",
                detail="deduplicating within this process only",
                error=str(exc),
            )
        finally:
            await client.aclose()

        hit = self._local.seen(plate, camera, moment, kind=kind)
        if hit is not None:
            return hit
        self._local.remember(plate, camera, alert_id, moment, kind=kind)
        return None

    def _remember(self, claim: _Claim, ttl_ms: int) -> None:
        now = time.monotonic()
        for stale in [k for k, expires in self._claimed.items() if expires < now]:
            del self._claimed[stale]
        self._claimed[claim.key] = now + ttl_ms / 1000
        # Mirrored locally, so a Redis outage straight after a claim still
        # folds this process's own repeats.
        self._local.remember(claim.plate, claim.camera, claim.alert_id, kind=claim.kind)
        claims = _unit_claims.get()
        if claims is not None:
            claims.append(claim)

    async def release(self, claims: list[_Claim]) -> None:
        """Give claims back, so the alerts they stood for can be raised."""
        if not claims:
            return
        for claim in claims:
            self._local.forget(claim.plate, claim.camera, claim.alert_id, kind=claim.kind)
            self._claimed.pop(claim.key, None)
        client = self._client()
        try:
            for claim in claims:
                await cast(
                    Any,
                    client.eval(
                        _RELEASE_IF_OURS, 2, claim.key, f"{claim.key}:repeats", claim.value
                    ),
                )
        except (RedisError, OSError) as exc:
            # The claim expires with its window; until then the plate stays
            # suppressed at that camera. Logged, because that is a missed alert.
            log.error("alert.dedup_release_failed", claims=len(claims), error=str(exc))
        finally:
            await client.aclose()
        log.info("alert.dedup_released", claims=len(claims))

    @asynccontextmanager
    async def unit(self) -> AsyncIterator[None]:
        """Release the claims made inside this block if it raises.

        Wrap the transaction that stores the alerts. Nested units hand their
        claims to the enclosing one on success, so an outer rollback still
        releases them.
        """
        claims: list[_Claim] = []
        token = _unit_claims.set(claims)
        try:
            yield
        except BaseException:
            _unit_claims.reset(token)
            await self.release(claims)
            raise
        _unit_claims.reset(token)
        outer = _unit_claims.get()
        if outer is not None:
            outer.extend(claims)

    async def clear(self) -> None:
        """Forget every claim this instance made. For tests."""
        self._local.clear()
        keys = list(self._claimed)
        self._claimed.clear()
        if not keys:
            return
        client = self._client()
        try:
            await client.delete(*keys, *(f"{key}:repeats" for key in keys))
        except (RedisError, OSError) as exc:
            log.warning("alert.dedup_clear_failed", error=str(exc))
        finally:
            await client.aclose()


deduper = SharedAlertDeduper()


async def raise_for_match(
    session: AsyncSession,
    *,
    match: Match,
    plate: str,
    camera_id: uuid.UUID | None,
    camera_code: str,
    detection_id: uuid.UUID | None,
    detection_ts: datetime | None,
    confidence: float | None,
    dedup: SharedAlertDeduper | None = None,
) -> Alert | None:
    """Create an alert for a watchlist match, unless it is a recent repeat.

    Returns the new alert, or None when it was folded into a recent one —
    by this replica or any other. The caller commits, inside `dedup.unit()`.
    """
    now = datetime.now(UTC)
    alert_id = uuid.uuid4()
    repeat = await (dedup or deduper).claim(plate, camera_code, alert_id, now)
    if repeat is not None:
        log.info(
            "alert.deduplicated",
            plate=plate,
            camera=camera_code,
            alert_id=str(repeat.alert_id),
            repeats=repeat.repeats,
        )
        return None

    alert = Alert(
        # The id the dedup key was claimed under, so a repeat on any replica
        # names this alert.
        id=alert_id,
        detection_id=detection_id,
        detection_ts=detection_ts,
        watchlist_id=match.entry.id,
        camera_id=camera_id,
        alert_type=match.alert_type,
        priority=match.priority,
        plate_normalised=plate,
        confidence=confidence,
        status=AlertStatus.NEW.value,
        notes=(
            None
            if match.exact
            else f"Near match to watchlist plate {match.entry.plate} "
            f"({match.distance} character different) — verify before acting"
        ),
    )
    session.add(alert)
    await session.flush()

    log.info(
        "alert.raised",
        alert_id=str(alert.id),
        plate=plate,
        camera=camera_code,
        alert_type=alert.alert_type,
        priority=alert.priority,
        exact=match.exact,
    )
    return alert


async def raise_for_anomaly(
    session: AsyncSession,
    *,
    plate: str,
    camera_id: uuid.UUID | None,
    camera_code: str,
    arrived_at: datetime,
    reasons: list[Reason],
) -> Alert | None:
    """Create a trajectory-anomaly alert, unless it is a recent repeat.

    Shares the watchlist deduper rather than a second one: the failure mode
    is identical (the same fact re-raised on every cycle a slow-moving
    journey happens to get re-scored) and a second structure would only be a
    second thing that can drift from the first. Under its own
    `kind`, so the two never fold into each other.

    Priority follows the strongest factor found, not a raw count — a single
    `impossible_hop` (the physics filter's own strongest signal, promoted
    here) matters more than three merely-rare transitions.
    """
    now = datetime.now(UTC)
    alert_id = uuid.uuid4()
    repeat = await deduper.claim(plate, camera_code, alert_id, now, kind=AlertType.ANOMALY.value)
    if repeat is not None:
        log.info(
            "alert.deduplicated",
            plate=plate,
            camera=camera_code,
            alert_id=str(repeat.alert_id),
            repeats=repeat.repeats,
            alert_type=AlertType.ANOMALY.value,
        )
        return None

    priority = (
        Priority.HIGH.value
        if any(r.factor == "impossible_hop" for r in reasons)
        else Priority.MEDIUM.value
    )

    alert = Alert(
        id=alert_id,
        detection_id=None,
        # There is no single detection behind a journey-level finding — a hop
        # aggregates every sighting in its dwell window — so `detection_ts` is
        # set to when the anomalous leg arrived, for the same chronological
        # sorting a detection-backed alert gets, without claiming a detection
        # identity that does not exist.
        detection_ts=arrived_at,
        watchlist_id=None,
        camera_id=camera_id,
        alert_type=AlertType.ANOMALY.value,
        priority=priority,
        plate_normalised=plate,
        confidence=None,
        status=AlertStatus.NEW.value,
        notes="; ".join(r.detail for r in reasons),
        reasons=[r.to_dict() for r in reasons],
    )
    session.add(alert)
    await session.flush()

    log.info(
        "alert.raised",
        alert_id=str(alert.id),
        plate=plate,
        camera=camera_code,
        alert_type=alert.alert_type,
        priority=alert.priority,
        factors=[r.factor for r in reasons],
    )
    return alert


async def transition(
    session: AsyncSession,
    alert: Alert,
    *,
    to: str,
    user_id: uuid.UUID | None,
    notes: str | None = None,
) -> Alert:
    """Move an alert to a new status, recording who and when."""
    allowed = ALLOWED_TRANSITIONS.get(alert.status, set())
    if to not in allowed:
        raise InvalidTransition(
            f"cannot move an alert from '{alert.status}' to '{to}'; "
            f"allowed: {sorted(allowed) or 'none — this alert is final'}"
        )

    alert.status = to
    alert.acknowledged_by = user_id
    alert.acknowledged_at = datetime.now(UTC)
    if notes:
        alert.notes = f"{alert.notes}\n{notes}".strip() if alert.notes else notes

    await session.flush()
    log.info(
        "alert.transitioned",
        alert_id=str(alert.id),
        to=to,
        user=str(user_id) if user_id else None,
    )
    return alert


async def get_alert(session: AsyncSession, alert_id: uuid.UUID) -> Alert | None:
    return (await session.execute(select(Alert).where(Alert.id == alert_id))).scalar_one_or_none()


def alert_payload(alert: Alert, match: Match | None = None) -> dict[str, Any]:
    """Shape for the live feed. Carries enough to act on without a round trip."""
    payload: dict[str, Any] = {
        "event": "alert.raised",
        "alert_id": str(alert.id),
        "alert_type": alert.alert_type,
        "priority": alert.priority,
        "plate": alert.plate_normalised,
        "confidence": alert.confidence,
        "status": alert.status,
        "camera_id": str(alert.camera_id) if alert.camera_id else None,
        "detection_id": str(alert.detection_id) if alert.detection_id else None,
        "created_at": (alert.created_at or datetime.now(UTC)).isoformat(),
        "notes": alert.notes,
        "reasons": alert.reasons,
    }
    if match is not None:
        payload["watchlist"] = {
            "id": str(match.entry.id),
            "plate": match.entry.plate,
            "category": match.entry.category,
            "case_ref": match.entry.case_ref,
            "exact": match.exact,
        }
    return payload
