"""Noticing, within a poll, that the registry roster changed.

The API republishes the roster every 30 s and this worker rediscovers every
20 s, so a camera onboarded a moment ago used to wait 30–50 s before any
worker owned it — and opening it in Live did not help, because a worker honours
focus only for cameras it already owns. The jury rehearsal on 12 Oct measured
+32 s from onboarding to the stream being opened for analysis.

The API now writes a digest of the roster beside it whenever a camera is
created, edited or deleted (app/services/fleet_roster.py,
`ROSTER_VERSION_KEY`). This worker reads that one short key on every focus
poll — every two seconds — and rediscovers as soon as it moves. The periodic
pass stays as the fallback: an API that predates the key never changes it, and
a Redis failure reads as "unchanged".
"""

from __future__ import annotations

import logging
from typing import Any

from redis.exceptions import RedisError

log = logging.getLogger(__name__)


class RosterWatch:
    """Remembers the roster version this worker last acted on."""

    def __init__(self) -> None:
        self.version: str | None = None

    def observe(self, version: str | None) -> bool:
        """Record `version`; True when it differs from the last one acted on.

        The first version seen counts as a change, so a worker that starts
        after the key exists reconciles against it at once. An absent key is
        never a change: there is nothing to act on.
        """
        if version is None or version == self.version:
            return False
        first = self.version is None
        self.version = version
        if not first:
            log.info("fleet roster changed; rediscovering now")
        return True

    async def poll(self, client: Any, key: str) -> bool:
        """Read the version key with `client` and `observe` it."""
        try:
            version = await client.get(key)
        except (RedisError, OSError) as exc:
            log.debug("could not read the roster version: %s", exc)
            return False
        return self.observe(str(version) if version is not None else None)
