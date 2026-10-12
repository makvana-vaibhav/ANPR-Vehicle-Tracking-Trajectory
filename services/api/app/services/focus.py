"""Which cameras someone has on screen now, for the ANPR workers.

A laptop cannot analyse every camera on the organisers' grid at once, so the
workers analyse a few and rotate. Rotation alone is wrong for the one camera
that matters most at any moment — the one an operator has open — because it
can wait minutes for its turn while they watch a feed with no boxes on it.

So the live page sends a heartbeat while it shows a camera, recorded here as a
sorted set of camera codes scored by when the heartbeat lapses. Each worker
reads the live entries every few seconds and puts a watched camera it owns
first in line (`ai_worker.rotation`). Expiry is by score rather than by key, so
a closed tab or a dropped connection needs no clean-up: the entry simply stops
counting `FOCUS_TTL_S` after its last heartbeat.

Viewing itself is audited where it starts, when the stream token is issued
(`camera.view`). The heartbeat is not: four rows a minute per viewer would say
nothing that row does not.
"""

from __future__ import annotations

import time

import redis.asyncio as aioredis

from app.core.config import settings
from app.core.logging import get_logger

log = get_logger("api.focus")

#: Read by the workers too: `ai_worker.config.WorkerSettings.focus_key`.
FOCUS_KEY = "nagarnetra:focus"

#: How long one heartbeat counts. The live page sends one every 15 seconds,
#: so this survives two lost in a row.
FOCUS_TTL_S = 45.0

_client: aioredis.Redis | None = None


def _redis() -> aioredis.Redis:
    """Lazily create the shared Redis client."""
    global _client
    if _client is None:
        _client = aioredis.from_url(
            settings.redis_url,
            decode_responses=True,
            socket_connect_timeout=3,
            socket_timeout=3,
        )
    return _client


async def watch(camera_code: str, now: float | None = None) -> bool:
    """Record that `camera_code` is on someone's screen. Returns whether it was.

    A failure is logged and reported, never raised: missing one heartbeat
    costs a camera at most a few seconds of priority, and must not surface
    as an error on the screen of the person watching it.
    """
    now = time.time() if now is None else now
    try:
        async with _redis().pipeline(transaction=True) as pipe:
            pipe.zadd(FOCUS_KEY, {camera_code: now + FOCUS_TTL_S})
            # Lapsed entries go here rather than in a sweeper: every write
            # bounds the set, and nothing else ever writes to it.
            pipe.zremrangebyscore(FOCUS_KEY, "-inf", now)
            await pipe.execute()
    except aioredis.RedisError as exc:
        log.warning("focus.record_failed", camera_code=camera_code, error=str(exc))
        return False
    return True


def client() -> aioredis.Redis:
    """The shared Redis client. Pursuit (`app.services.pursuit`) keeps its
    pursuit state beside the focus set it heartbeats, on this connection."""
    return _redis()


async def watched(now: float | None = None) -> list[str]:
    """Camera codes on someone's screen now."""
    now = time.time() if now is None else now
    return sorted(await _redis().zrangebyscore(FOCUS_KEY, f"({now}", "+inf"))


async def close() -> None:
    """Release the client on application shutdown."""
    global _client
    if _client is not None:
        await _client.aclose()
        _client = None
