"""Publishes the ANPR fleet to Redis, for the AI workers to read.

## Why this exists

The workers need to know which cameras to analyse and where to pull each one
from. Three ways to tell them were possible, and two are worse:

* **Read the database directly.** The worker image is deliberately minimal —
  ONNX Runtime and OpenCV, no ORM, no Postgres driver (see CLAUDE.md §9 note 3).
  Adding SQLAlchemy to it to answer one question would undo that.
* **Call the API.** That means a service credential, a new authentication path,
  and a worker that cannot start until the API is up.

So the API — which already owns the registry — writes the roster to Redis,
which both sides already depend on. No new dependency, no new auth surface, and
a worker that keeps running off the last roster if the API restarts.

## Why not discover from MediaMTX alone

The original design discovered cameras from MediaMTX, on the reasoning that it
knows which paths are *actually publishing*. That is true and useful for
cameras we host. It cannot see a federated camera at all: the organisers' grid
publishes to their gateway, not ours. A worker discovering only from MediaMTX
is therefore structurally blind to exactly the cameras this platform exists to
federate.

The registry knows about both, and — importantly — keeps knowing about a
federated camera while its grid is returning 502. A camera that is unreachable
is a camera with a problem, not a camera that stopped existing, and the
difference belongs in health monitoring rather than in whether we try at all.
"""

from __future__ import annotations

import asyncio
import contextlib
import hashlib
import json
import time
from collections.abc import Awaitable
from typing import Any, cast

import redis.asyncio as aioredis
from sqlalchemy import or_, select
from sqlalchemy.orm import selectinload

from app.adapters import adapter_for
from app.core.config import settings
from app.core.logging import get_logger
from app.db.session import SessionLocal
from app.models.registry import Camera

log = get_logger(__name__)

#: Where the roster lives. A plain key, not a stream: this is current state,
#: not a history, and a worker joining late wants the roster as it is now.
ROSTER_KEY = "nagarnetra:fleet:anpr"

#: Republish this often. Fast enough that a newly onboarded camera is picked up
#: within a discovery cycle or two, slow enough to be irrelevant to load.
PUBLISH_INTERVAL_S = 30.0

#: The roster outlives a few missed publishes, so a brief API outage does not
#: idle every worker, but not so long that a dead API leaves workers chasing a
#: fleet that has since changed.
ROSTER_TTL_S = 300

#: A digest of the roster's content, rewritten with it. A worker reads this one
#: short key every couple of seconds (ai_worker/worker.py) and re-reads the
#: roster the moment it changes, so a camera onboarded, edited or deleted
#: reaches the workers in about two seconds instead of at the next 30-second
#: publish plus a 20-second rediscovery. Content-addressed rather than a
#: counter, so the periodic republish of an unchanged fleet wakes nobody.
ROSTER_VERSION_KEY = "nagarnetra:fleet:anpr:version"

#: When the database was read for the roster now in Redis (unix seconds). A
#: publish whose read is older than that is discarded rather than written: the
#: periodic loop can start reading just before an onboarding commits and
#: finish just after the onboarding's own publish, and writing last would
#: quietly take the new camera back out of the fleet.
ROSTER_BUILT_AT_KEY = "nagarnetra:fleet:anpr:built_at"

#: Writes roster, version and read time together, unless a newer read is
#: already published. Atomic in Redis, so it holds across API replicas too.
_PUBLISH_IF_NEWER = """
local current = tonumber(redis.call('GET', KEYS[3]) or '0')
if tonumber(ARGV[1]) < current then
  return 0
end
redis.call('SET', KEYS[1], ARGV[2], 'EX', ARGV[4])
redis.call('SET', KEYS[2], ARGV[3], 'EX', ARGV[4])
redis.call('SET', KEYS[3], ARGV[1], 'EX', ARGV[4])
return 1
"""


def roster_version(payload: str) -> str:
    """The content digest a worker compares to know the fleet changed."""
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()[:16]


def plate_regions(camera: Camera) -> list[str]:
    """Which national plate formats this camera is expected to see.

    Indian always, plus anything the camera declares with a `plate-region:XX`
    tag. Accepting a format the camera will never see is not free: the repair
    step will bend a genuine misread into a plausible plate of that format, so
    the default stays narrow and widening it is a deliberate, per-camera act.
    """
    extra = [
        tag.split(":", 1)[1].upper()
        for tag in (camera.tags or [])
        if tag.lower().startswith("plate-region:") and ":" in tag
    ]
    return ["IN", *[r for r in extra if r != "IN"]]


#: The registry tag that turns on the persons watchlist's face stage for a
#: camera. Opt-in per camera, never fleet-wide: a junction camera's faces are a
#: few pixels across, and its CPU is wanted for plates.
FACES_TAG = "analytics:faces"


def analytics(camera: Camera) -> list[str]:
    """What the worker should run on this camera: `anpr`, `faces`, or both."""
    wanted = ["anpr"] if camera.anpr_enabled else []
    if FACES_TAG in (camera.tags or []):
        wanted.append("faces")
    return wanted


async def _entry_for(camera: Camera) -> dict[str, Any] | None:
    """One camera as the worker needs it: where to pull, and how."""
    adapter = adapter_for(camera.vms)
    try:
        endpoints = await adapter.get_stream_url(camera)
    except Exception as exc:
        # A camera whose URL cannot be resolved right now is still a camera.
        # It is published without a URL so the worker can report it as
        # unreachable rather than silently omitting it from the fleet.
        log.warning(
            "roster.resolve_failed",
            camera_code=camera.camera_code,
            error=str(exc),
        )
        return {
            "camera_code": camera.camera_code,
            "label": camera.name,
            "rtsp_url": "",
            "hls_url": "",
            "plate_regions": plate_regions(camera),
            "analytics": analytics(camera),
            "federated": True,
            "detail": str(exc),
        }
    finally:
        await adapter.close()

    # Both URLs travel, and the worker chooses. Which transport works is a
    # property of the *worker's* network, not of the registry: the organisers'
    # guide says as much ("if port 8554 is blocked, use the HLS endpoint"), and
    # picking here would bake one worker's firewall into every worker's roster.
    return {
        "camera_code": camera.camera_code,
        "label": camera.name,
        "rtsp_url": endpoints.rtsp or "",
        "hls_url": endpoints.hls or "",
        "plate_regions": plate_regions(camera),
        # Which stages to run. A worker that predates this field reads every
        # entry as ANPR, which is what every entry was until faces existed.
        "analytics": analytics(camera),
        # Whether the video comes from somebody else's gateway. The worker uses
        # this only for logging; it matters to an operator reading the logs.
        "federated": (camera.vms.adapter_type != "simulated") if camera.vms else False,
    }


async def build_roster() -> list[dict[str, Any]]:
    """Every camera a worker analyses — ANPR-enabled, or tagged for faces —
    with a resolved stream URL where possible."""
    async with SessionLocal() as session:
        cameras = (
            (
                await session.execute(
                    select(Camera)
                    .options(selectinload(Camera.vms))
                    .where(or_(Camera.anpr_enabled.is_(True), Camera.tags.contains([FACES_TAG])))
                    .order_by(Camera.camera_code)
                )
            )
            .scalars()
            .all()
        )

    # Resolving is I/O per camera; doing it serially across a large fleet would
    # take longer than the publish interval.
    entries = await asyncio.gather(*(_entry_for(camera) for camera in cameras))
    return [entry for entry in entries if entry is not None]


class RosterPublisher:
    """Keeps the Redis roster in step with the registry."""

    def __init__(self) -> None:
        self._task: asyncio.Task[None] | None = None
        self._stop = asyncio.Event()
        self.published = 0
        self.last_size = 0

    async def publish_once(self) -> int:
        # Taken before the database is read, so the guard in
        # `_PUBLISH_IF_NEWER` compares what each publish actually saw.
        read_at = time.time()
        roster = await build_roster()
        payload = json.dumps({"cameras": roster})
        client = aioredis.from_url(settings.redis_url, decode_responses=True)
        try:
            # redis-py types EVAL for its sync and async clients at once.
            written = await cast(
                Awaitable[int],
                client.eval(
                    _PUBLISH_IF_NEWER,
                    3,
                    ROSTER_KEY,
                    ROSTER_VERSION_KEY,
                    ROSTER_BUILT_AT_KEY,
                    f"{read_at:.6f}",
                    payload,
                    roster_version(payload),
                    str(ROSTER_TTL_S),
                ),
            )
        finally:
            await client.aclose()
        if not written:
            log.debug("roster.superseded", cameras=len(roster))
        self.published += 1
        self.last_size = len(roster)
        return len(roster)

    async def _loop(self) -> None:
        while not self._stop.is_set():
            try:
                count = await self.publish_once()
                log.debug("roster.published", cameras=count)
            except Exception:
                # A supervisor boundary. The roster has a TTL longer than the
                # interval, so a failed publish costs nothing until several in
                # a row fail — but it must be visible when it happens.
                log.warning("roster.publish_failed", exc_info=True)
            with contextlib.suppress(TimeoutError):
                await asyncio.wait_for(self._stop.wait(), timeout=PUBLISH_INTERVAL_S)

    def start(self) -> None:
        if self._task is None:
            self._stop.clear()
            self._task = asyncio.create_task(self._loop(), name="fleet-roster")

    async def stop(self) -> None:
        self._stop.set()
        if self._task is not None:
            self._task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await self._task
            self._task = None


publisher = RosterPublisher()

#: How long a change notification may hold up the request that caused it.
NOTIFY_TIMEOUT_S = 5.0


async def notify_changed(reason: str, camera_code: str | None = None) -> bool:
    """Republish the roster now, because the registry just changed.

    Called by the camera endpoints *after* their transaction commits (the
    roster is read in a fresh session and would not see uncommitted rows).
    The workers notice the new version within their two-second focus poll.

    Never raises: the periodic publish is still the fallback, so a Redis blip
    here costs at most the old 30-to-50-second pickup, not the onboarding.
    """
    try:
        count = await asyncio.wait_for(publisher.publish_once(), timeout=NOTIFY_TIMEOUT_S)
    except Exception:
        # A supervisor boundary for a best-effort side effect: whatever went
        # wrong, the request that triggered it has already succeeded.
        log.warning("roster.notify_failed", reason=reason, camera_code=camera_code, exc_info=True)
        return False
    log.info("roster.notified", reason=reason, camera_code=camera_code, cameras=count)
    return True
