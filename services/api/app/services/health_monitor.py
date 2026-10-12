"""Fleet health monitoring.

Required by the challenge: Model 1 must provide "camera health monitoring". It
is also the difference between a registry and an operational system — knowing
a camera *exists* is useless if nobody notices it stopped working three weeks
ago.

Design notes that matter at 80,000 cameras:

* **Probes are staggered**, not synchronised. Probing the whole estate at once
  would produce a thundering herd against every departmental VMS on a fixed
  cycle. Cameras are spread across the interval by a stable hash of their id,
  so the load is smooth and each camera keeps its own slot between restarts.
* **Concurrency is bounded** by a semaphore. Unbounded ``gather`` over 80,000
  cameras would exhaust file descriptors long before it exhausted the network.
* **Every status change is debounced**, in both directions: N consecutive
  probes must agree on the new state (``HEALTH_OFFLINE_AFTER_FAILURES`` to go
  down, ``HEALTH_STATUS_CHANGE_AFTER_PROBES`` for anything else). A single
  dropped packet must not page a control room, and a single good probe must
  not close an alarm the next sweep opens again.
* **A probe that could not ask is not an answer.** When an integration refuses
  our session or does not answer (``STATUS_HOLD_ERRORS``), its cameras keep
  their last known status, shown as stale, and the integration gets **one**
  alarm — raised after ``HEALTH_INTEGRATION_DOWN_AFTER_SWEEPS`` and closed
  after ``HEALTH_INTEGRATION_RECOVER_AFTER_SWEEPS``. On 12 Oct the organisers'
  grid swung between accepting and refusing us every few minutes; thirty
  cameras flipped to "unknown" and back with every swing, and the integration
  alarm opened and closed eleven times in one hour.
* **The AI workers are witnesses.** A camera whose video a worker is decoding,
  or at which it read a vehicle moments ago, is answering — whatever a
  catalogue says. That is the most direct evidence the platform has.
* Every probe is written to the ``camera_health`` hypertable, which is what
  makes uptime sparklines and gap analysis possible.
"""

from __future__ import annotations

import asyncio
import json
import uuid
from dataclasses import dataclass, replace
from datetime import UTC, datetime, timedelta
from zoneinfo import ZoneInfo

import redis.asyncio as aioredis
from redis.exceptions import RedisError
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.adapters import adapter_for
from app.adapters.base import NOT_INTEGRATED_ERRORS, STATUS_HOLD_ERRORS, HealthProbe
from app.core.config import settings
from app.core.logging import get_logger
from app.models.enums import AlertType, CameraStatus, Priority
from app.models.intelligence import Alert, Detection
from app.models.registry import Camera, CameraHealth

#: Notes on alerts are read by operators, in IST.
IST = ZoneInfo("Asia/Kolkata")

log = get_logger("api.health_monitor")

#: Cap on simultaneous probes. Tuned for a laptop; the scale profile raises it.
MAX_CONCURRENT_PROBES = 32

#: Where each AI worker reports its counters and the cameras whose streams it
#: has open (`ai_worker.config.ai_worker_stats_key`), every few seconds.
AI_WORKER_STATS_KEY = "nagarnetra:ai:workers"

#: A worker report older than this is a worker that may have gone; its open
#: streams are not evidence of anything now.
WORKER_REPORT_FRESH_S = 60.0

#: Alert states that count as "still open".
OPEN_STATUSES = ("new", "acknowledged", "dispatched")

#: Statuses that mean the camera is delivering video, for closing its alarm.
ANSWERING = (CameraStatus.ONLINE.value, CameraStatus.DEGRADED.value)


# ── Debounce state ────────────────────────────────────────────────────
#
# In memory by design: this is debounce state, not a fact worth persisting,
# and it should reset when the monitor restarts. A restart costs at most one
# debounce window of delay, never a duplicate alarm — alarms are deduplicated
# against the open ones in the database.


@dataclass
class _Streak:
    """Consecutive probes of one camera agreeing on a status it does not have."""

    status: str
    count: int = 0


@dataclass
class _IntegrationState:
    """Consecutive sweeps an integration did, or did not, answer."""

    failing: int = 0
    answering: int = 0
    error_code: str | None = None
    detail: str | None = None
    since: datetime | None = None


_streaks: dict[uuid.UUID, _Streak] = {}
_integrations: dict[uuid.UUID, _IntegrationState] = {}


def reset_state() -> None:
    """Forget every streak. For tests, and nothing else."""
    _streaks.clear()
    _integrations.clear()


@dataclass
class SweepProbe:
    """What one sweep learned about one camera.

    `adapter` is what its integration said; `effective` is what the monitor
    acts on — the same, unless a worker's evidence overrode a failure.
    """

    camera: Camera
    adapter: HealthProbe
    effective: HealthProbe
    evidence: str | None = None


# ── Probing ───────────────────────────────────────────────────────────


async def _ask_adapter(camera: Camera) -> HealthProbe:
    """Probe one camera through its VMS adapter."""
    adapter = adapter_for(camera.vms, timeout_seconds=settings.health_probe_timeout_seconds)
    try:
        return await adapter.probe_health(camera)
    except Exception as exc:
        # Supervisor boundary: one misbehaving adapter must not stop the sweep.
        log.error(
            "health.probe_raised",
            camera_code=camera.camera_code,
            adapter=adapter.adapter_type,
            error=str(exc),
            exc_info=True,
        )
        return HealthProbe(reachable=False, error_code="adapter_exception", detail=str(exc))
    finally:
        await adapter.close()


def _record(session: AsyncSession, camera: Camera, probe: HealthProbe) -> None:
    session.add(
        CameraHealth(
            camera_id=camera.id,
            ts=probe.probed_at,
            reachable=probe.reachable,
            fps_actual=probe.fps_actual,
            latency_ms=probe.latency_ms,
            bitrate_kbps=probe.bitrate_kbps,
            frame_drop_pct=probe.frame_drop_pct,
            error_code=probe.error_code,
        )
    )


async def probe_camera(
    session: AsyncSession, camera: Camera, *, record: bool = True
) -> HealthProbe:
    """Probe one camera through its VMS adapter and record the result."""
    probe = await _ask_adapter(camera)
    if record:
        _record(session, camera, probe)
    return probe


async def worker_evidence(
    session: AsyncSession, cameras: list[Camera], *, now: datetime | None = None
) -> dict[uuid.UUID, str]:
    """Cameras the AI workers show to be answering, and the words for how.

    Two witnesses, both the platform's own: a fresh worker report listing the
    camera's stream as open (video is being decoded now), and a vehicle read
    at the camera within ``HEALTH_WORKER_EVIDENCE_SECONDS``. Either is more
    direct than any catalogue: it is the picture itself arriving.
    """
    if not cameras:
        return {}
    now = now or datetime.now(UTC)
    by_code = {camera.camera_code.upper(): camera.id for camera in cameras}
    found: dict[uuid.UUID, str] = {}

    client = aioredis.from_url(
        settings.redis_url, decode_responses=True, socket_connect_timeout=2, socket_timeout=2
    )
    try:
        reports = await client.hgetall(AI_WORKER_STATS_KEY)
    except (RedisError, OSError) as exc:
        # No witness is not a failure: the integration's own answer stands.
        log.warning("health.worker_evidence_unavailable", error=str(exc))
        reports = {}
    finally:
        await client.aclose()

    for raw in reports.values():
        try:
            report = json.loads(raw)
        except ValueError:
            continue
        if not isinstance(report, dict):
            continue
        if now.timestamp() - float(report.get("reported_at") or 0) > WORKER_REPORT_FRESH_S:
            continue
        for code in report.get("open_cameras") or ():
            camera_id = by_code.get(str(code).upper())
            if camera_id is not None:
                found[camera_id] = "an AI worker is receiving its video"

    since = now - timedelta(seconds=settings.health_worker_evidence_seconds)
    rows = (
        await session.execute(
            select(Detection.camera_id, func.max(Detection.ts))
            .where(
                Detection.ts >= since,
                Detection.camera_id.in_([camera.id for camera in cameras]),
            )
            .group_by(Detection.camera_id)
        )
    ).all()
    for camera_id, last in rows:
        if camera_id is not None and camera_id not in found:
            stamp = last.astimezone(IST).strftime("%H:%M:%S")
            found[camera_id] = f"an AI worker read a vehicle here at {stamp} IST"
    return found


def _with_evidence(probe: HealthProbe, evidence: str) -> HealthProbe:
    """A failed probe overruled by a worker that is seeing the camera's video."""
    said = probe.error_code or "no answer"
    return replace(
        probe,
        reachable=True,
        error_code=None,
        latency_ms=None,
        detail=f"answering: {evidence} (its integration said: {said})",
    )


# ── Status decisions ──────────────────────────────────────────────────


def _verdict(probe: HealthProbe, current: str) -> str | None:
    """The status a probe argues for, or None when it says nothing about the camera."""
    if not probe.reachable and probe.error_code in STATUS_HOLD_ERRORS:
        return None
    verdict = probe.status.value
    # A camera that was delivering video and has stopped is a genuine outage,
    # even though the raw error ("not publishing") is the same one a
    # never-integrated camera reports. The difference is where it came FROM:
    # losing a working feed needs an operator; a camera that never had one does
    # not. Only the transition can tell them apart, which is why this lives
    # here and not in HealthProbe.status.
    if (
        not probe.reachable
        and probe.error_code in NOT_INTEGRATED_ERRORS
        and current in (CameraStatus.ONLINE.value, CameraStatus.DEGRADED.value)
    ):
        verdict = CameraStatus.OFFLINE.value
    return verdict


def _threshold(status: str) -> int:
    if status in (CameraStatus.OFFLINE.value, CameraStatus.UNKNOWN.value):
        return max(1, settings.health_offline_after_failures)
    return max(1, settings.health_status_change_after_probes)


def _should_flip(camera_id: uuid.UUID, probe: HealthProbe, current: str) -> str | None:
    """Decide whether a camera's status should change.

    Debounced in both directions: the status moves only once N consecutive
    answered probes agree on the same new state. A probe that could not ask
    (the integration refused or did not answer) neither counts nor breaks a
    streak — it is not evidence about the camera either way.
    """
    verdict = _verdict(probe, current)
    if verdict is None:
        return None
    if verdict == current:
        _streaks.pop(camera_id, None)
        return None
    streak = _streaks.get(camera_id)
    if streak is None or streak.status != verdict:
        streak = _streaks[camera_id] = _Streak(verdict)
    streak.count += 1
    if streak.count < _threshold(verdict):
        return None
    _streaks.pop(camera_id, None)
    return verdict


def status_after_manual_probe(current: str, probe: HealthProbe) -> str:
    """The status an operator's "probe now" sets.

    Applied at once — the operator asked — except when the probe could not ask
    at all, which says nothing about the camera.
    """
    if not probe.reachable and probe.error_code in STATUS_HOLD_ERRORS:
        return current
    return probe.status.value


# ── Alarms ────────────────────────────────────────────────────────────


async def _raise_camera_down_alert(
    session: AsyncSession, camera: Camera, probe: HealthProbe
) -> bool:
    """Raise a camera_down alert, unless one is already open.

    Deduplicated on open alerts so a camera that has been down for a week does
    not accumulate 20,000 identical alerts.
    """
    existing = await session.scalar(
        select(Alert).where(
            Alert.camera_id == camera.id,
            Alert.alert_type == AlertType.CAMERA_DOWN.value,
            Alert.status.in_(OPEN_STATUSES),
        )
    )
    if existing is not None:
        return False

    # An ANPR camera going dark is an intelligence gap, not just a maintenance
    # ticket — it is a hole in the route history the correlator can build.
    priority = Priority.HIGH if camera.anpr_enabled else Priority.MEDIUM
    probes = max(1, settings.health_offline_after_failures)

    session.add(
        Alert(
            camera_id=camera.id,
            alert_type=AlertType.CAMERA_DOWN.value,
            priority=priority.value,
            status="new",
            notes=(
                f"{camera.camera_code} ({camera.name}) not delivering video after "
                f"{probes} consecutive probes: {probe.error_code or 'unknown error'}"
                f"{f' — {probe.detail}' if probe.detail else ''}"
            ),
        )
    )
    log.warning(
        "health.camera_down",
        camera_code=camera.camera_code,
        error_code=probe.error_code,
        anpr=camera.anpr_enabled,
    )
    return True


async def _resolve_recovered(
    session: AsyncSession, online: list[uuid.UUID], vms_reachable: set[uuid.UUID]
) -> int:
    """Close the camera-down alerts of cameras that are reachable again.

    Nothing used to: an alert raised when a camera went dark stayed open after
    it came back, so the alert queue went on saying a camera was unreachable
    beside a fleet screen showing it online — the kind of contradiction that
    teaches an operator to stop believing either. The callers pass only
    cameras and integrations whose recovery has been debounced.

    Closed through the same transition an operator uses, with a note saying
    the system did it and when, so the record shows why it is no longer open.
    """
    from app.services import alerts as alerts_service

    stamp = datetime.now(UTC).astimezone(IST).strftime("%d %b %H:%M")
    found: list[tuple[Alert, str]] = []
    if online:
        for alert in (
            await session.scalars(
                select(Alert).where(
                    Alert.alert_type == AlertType.CAMERA_DOWN.value,
                    Alert.status.in_(OPEN_STATUSES),
                    Alert.camera_id.in_(online),
                )
            )
        ).all():
            found.append(
                (alert, f"Closed automatically: the camera was reachable again at {stamp} IST.")
            )
    for vms_id in vms_reachable:
        for alert in (
            await session.scalars(
                select(Alert).where(
                    Alert.alert_type == AlertType.CAMERA_DOWN.value,
                    Alert.status.in_(OPEN_STATUSES),
                    Alert.camera_id.is_(None),
                    Alert.notes.like(f"%vms:{vms_id}%"),
                )
            )
        ).all():
            found.append(
                (
                    alert,
                    "Closed automatically: the integration has answered steadily again "
                    f"since before {stamp} IST.",
                )
            )

    for alert, note in found:
        try:
            await alerts_service.transition(session, alert, to="closed", user_id=None, notes=note)
        except alerts_service.InvalidTransition:
            continue
        log.info("health.alert_resolved", alert_id=str(alert.id), camera_id=str(alert.camera_id))
    return len(found)


def integration_words(error_code: str | None, name: str, affected: int) -> str:
    """The integration alarm's note, in an operator's words."""
    if error_code == "grid_refused":
        return (
            f"{name} is refusing our session (its watch-time cooldown, or another "
            f"session on this address). {affected} cameras keep their last known "
            "state, shown as stale, until it accepts us again; the AI workers' own "
            "video still counts where they have it."
        )
    return (
        f"Integration unreachable: {name} did not answer for {affected} cameras. "
        "Their last known state is shown as stale until it answers again."
    )


async def _raise_integration_alert(
    session: AsyncSession, vms_id: uuid.UUID, state: _IntegrationState, affected: int
) -> bool:
    """One alarm per integration, however many cameras it holds.

    A dead Milestone server means 4,000 cameras are unreadable, but it is ONE
    incident with one fix. Alerting per camera would make the alert feed
    useless at exactly the moment an operator needs it.
    """
    from app.models.registry import VmsInstance

    existing = await session.scalar(
        select(Alert).where(
            Alert.alert_type == AlertType.CAMERA_DOWN.value,
            Alert.status.in_(OPEN_STATUSES),
            Alert.camera_id.is_(None),
            Alert.notes.like(f"%vms:{vms_id}%"),
        )
    )
    if existing is not None:
        return False

    vms = await session.scalar(select(VmsInstance).where(VmsInstance.id == vms_id))
    name = vms.name if vms else str(vms_id)
    since = (state.since or datetime.now(UTC)).astimezone(IST).strftime("%H:%M")
    refused = state.error_code == "grid_refused"
    session.add(
        Alert(
            alert_type=AlertType.CAMERA_DOWN.value,
            # The grid asking us to wait is expected and self-resolving; an
            # integration that has gone silent across many cameras is not.
            priority=(Priority.MEDIUM.value if refused or affected <= 25 else Priority.HIGH.value),
            status="new",
            notes=(
                f"{integration_words(state.error_code, name, affected)} "
                f"Since {since} IST. [vms:{vms_id}]"
            ),
        )
    )
    log.warning(
        "health.integration_down",
        vms=name,
        affected_cameras=affected,
        error_code=state.error_code,
    )
    return True


# ── The sweep ─────────────────────────────────────────────────────────


def _integration_verdicts(
    probes: list[SweepProbe],
) -> tuple[dict[uuid.UUID, list[SweepProbe]], dict[uuid.UUID, list[SweepProbe]]]:
    """Per integration: did it answer this sweep, or could it not be asked at all?

    Judged on the adapter's own answers, before any worker evidence: a worker
    seeing video does not make a refusing catalogue answer.
    """
    by_vms: dict[uuid.UUID, list[SweepProbe]] = {}
    for item in probes:
        if item.camera.vms_id is not None:
            by_vms.setdefault(item.camera.vms_id, []).append(item)
    failing: dict[uuid.UUID, list[SweepProbe]] = {}
    answering: dict[uuid.UUID, list[SweepProbe]] = {}
    for vms_id, items in by_vms.items():
        if all(
            not i.adapter.reachable and i.adapter.error_code in STATUS_HOLD_ERRORS for i in items
        ):
            failing[vms_id] = items
        else:
            answering[vms_id] = items
    return failing, answering


async def sweep(
    session: AsyncSession, *, camera_ids: list[uuid.UUID] | None = None
) -> dict[str, int]:
    """Probe the fleet once and apply status transitions.

    Returns a summary of what changed, which the monitor logs and the tests
    assert against.
    """
    stmt = select(Camera).options(selectinload(Camera.vms))
    if camera_ids:
        stmt = stmt.where(Camera.id.in_(camera_ids))

    cameras = list((await session.scalars(stmt)).all())
    if not cameras:
        return {"probed": 0, "online": 0, "offline": 0, "changed": 0, "alerts": 0}

    semaphore = asyncio.Semaphore(MAX_CONCURRENT_PROBES)

    async def guarded(camera: Camera) -> tuple[Camera, HealthProbe]:
        async with semaphore:
            return camera, await _ask_adapter(camera)

    asked = await asyncio.gather(*(guarded(c) for c in cameras))
    return await apply_probes(session, asked)


async def apply_probes(
    session: AsyncSession,
    asked: list[tuple[Camera, HealthProbe]],
    *,
    evidence: dict[uuid.UUID, str] | None = None,
) -> dict[str, int]:
    """Record one sweep's probes and act on them.

    Separate from `sweep` so that a recorded sequence of probe results can be
    replayed through exactly the logic the monitor runs. `evidence` is the
    workers' testimony; when None it is gathered live.
    """
    if evidence is None:
        failed = [camera for camera, probe in asked if not probe.reachable]
        evidence = await worker_evidence(session, failed)

    probes: list[SweepProbe] = []
    for camera, probe in asked:
        witness = evidence.get(camera.id) if not probe.reachable else None
        effective = _with_evidence(probe, witness) if witness else probe
        probes.append(SweepProbe(camera, probe, effective, witness))
        _record(session, camera, effective)

    online = offline = changed = alerts = held = witnessed = 0
    recovered: list[uuid.UUID] = []

    for item in probes:
        camera, probe = item.camera, item.effective
        if probe.reachable:
            online += 1
        else:
            offline += 1
        if item.evidence:
            witnessed += 1
        if not probe.reachable and probe.error_code in STATUS_HOLD_ERRORS:
            held += 1

        new_status = _should_flip(camera.id, probe, camera.status)
        if new_status is not None:
            previous = camera.status
            camera.status = new_status
            camera.updated_at = datetime.now(UTC)
            changed += 1
            log.info(
                "health.status_changed",
                camera_code=camera.camera_code,
                previous=previous,
                current=new_status,
                error_code=probe.error_code,
                evidence=item.evidence,
            )
            if new_status == CameraStatus.OFFLINE.value and await _raise_camera_down_alert(
                session, camera, probe
            ):
                alerts += 1
        if camera.status in ANSWERING:
            recovered.append(camera.id)

    # ── One state per integration, debounced ─────────────────────────
    failing, answering = _integration_verdicts(probes)
    now = datetime.now(UTC)
    integrations_recovered: set[uuid.UUID] = set()
    for vms_id, items in failing.items():
        state = _integrations.setdefault(vms_id, _IntegrationState())
        if state.failing == 0:
            state.since = now
        state.failing += 1
        state.answering = 0
        # A refusal anywhere in the sweep names the cause: the grid asking us
        # to wait reads differently from a recorder that has gone silent.
        codes = {i.adapter.error_code for i in items}
        state.error_code = (
            "grid_refused" if "grid_refused" in codes else items[0].adapter.error_code
        )
        state.detail = items[0].adapter.detail
        due = state.failing >= max(1, settings.health_integration_down_after_sweeps)
        if due and await _raise_integration_alert(session, vms_id, state, len(items)):
            alerts += 1
    for vms_id in answering:
        state = _integrations.setdefault(vms_id, _IntegrationState())
        state.failing = 0
        state.answering += 1
        if state.answering >= max(1, settings.health_integration_recover_after_sweeps):
            integrations_recovered.add(vms_id)

    resolved = await _resolve_recovered(session, recovered, integrations_recovered)

    await session.commit()

    summary = {
        "probed": len(probes),
        "online": online,
        "offline": offline,
        "held": held,
        "witnessed": witnessed,
        "changed": changed,
        "alerts": alerts,
        "resolved": resolved,
    }
    log.info("health.sweep_complete", **summary)
    return summary


def integration_state() -> dict[uuid.UUID, dict[str, object]]:
    """This process's view of each integration's streak (for logs and tests)."""
    return {
        vms_id: {
            "failing_sweeps": state.failing,
            "answering_sweeps": state.answering,
            "error_code": state.error_code,
            "since": state.since.isoformat() if state.since else None,
        }
        for vms_id, state in _integrations.items()
    }


def stagger_offset(camera_id: uuid.UUID, interval_seconds: int) -> float:
    """Stable position for a camera within the probe interval.

    Derived from the camera's own id, so a camera keeps the same slot across
    restarts and the load stays evenly spread rather than re-clumping.
    """
    return (camera_id.int % (interval_seconds * 1000)) / 1000.0
