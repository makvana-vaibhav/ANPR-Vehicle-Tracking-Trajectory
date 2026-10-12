"""The persons gallery, as this worker last read it from the platform.

The API publishes the active persons watchlist to Redis whenever it changes and
once a minute besides (`app/services/persons.py`): approved, unexpired entries
as ids and SFace embeddings, with the platform's match policy — no photos and
no names. This keeps the parsed copy the face stage matches against.

Three properties, each deliberate:

* **Read on the event loop, used on camera threads.** The supervisor refreshes
  it every `persons_gallery_refresh_s`; camera threads only ever read the
  current reference, which is replaced whole, never mutated.
* **A missing key means nothing to match.** The platform publishes an empty
  gallery when nothing is active and the key expires when the platform stops
  publishing, so an absent key is not an error to work around.
* **An outage does not freeze the list.** If Redis cannot be read, the last
  gallery is kept — but only until its own `expires_at`. A worker cut off from
  the platform must not go on matching an entry that has since been retired.
"""

from __future__ import annotations

import asyncio
import json
import logging
import time
from datetime import UTC, datetime
from typing import Any, Protocol

from ailab.face.gallery import EMPTY_GALLERY, Gallery
from redis.exceptions import RedisError

log = logging.getLogger(__name__)


class _AsyncGetter(Protocol):
    """`redis.asyncio.Redis`, as far as this needs it. Typed loosely because
    redis-py types `get` for its sync and async clients at once."""

    def get(self, name: str, /) -> Any: ...


class GalleryCache:
    """The current gallery, refreshed from Redis by the supervisor."""

    def __init__(self, key: str, refresh_s: float = 10.0) -> None:
        self.key = key
        self.refresh_s = refresh_s
        self._gallery: Gallery = EMPTY_GALLERY
        self._read_at = 0.0
        self.reads = 0
        self.failures = 0
        self.last_error: str | None = None

    def current(self) -> Gallery:
        """What a camera matches against now. Safe from any thread."""
        gallery = self._gallery
        if gallery.is_expired(datetime.now(UTC)):
            return EMPTY_GALLERY
        return gallery

    def due(self, now: float | None = None) -> bool:
        return (
            now if now is not None else time.monotonic()
        ) - self._read_at >= self.refresh_s

    async def refresh(self, client: _AsyncGetter, timeout: float = 3.0) -> Gallery:
        """Read the published gallery and adopt it. Returns what is current."""
        self._read_at = time.monotonic()
        try:
            raw = await asyncio.wait_for(client.get(self.key), timeout=timeout)
        except (TimeoutError, OSError, RedisError) as exc:
            self._failed(f"could not read the persons gallery: {exc}")
            return self.current()

        self.reads += 1
        if not raw:
            self._adopt(EMPTY_GALLERY)
            return self._gallery
        try:
            payload = json.loads(raw)
            gallery = Gallery.from_payload(payload)
        except (ValueError, TypeError, AttributeError) as exc:
            # A payload this worker cannot read is treated as no gallery at
            # all: matching against half of one would be guessing. Adopted
            # first, so the error recorded below is the one that stays.
            self._adopt(EMPTY_GALLERY)
            self._failed(f"the persons gallery could not be parsed: {exc}")
            return self._gallery
        self._adopt(gallery)
        return self._gallery

    def _adopt(self, gallery: Gallery) -> None:
        if gallery.version != self._gallery.version or len(gallery) != len(
            self._gallery
        ):
            log.info(
                "persons gallery: %d active entr%s (version %s)",
                len(gallery),
                "y" if len(gallery) == 1 else "ies",
                gallery.version or "none",
            )
        self._gallery = gallery
        self.last_error = None

    def _failed(self, message: str) -> None:
        self.failures += 1
        self.last_error = message
        if self.failures in (1, 10, 100) or self.failures % 1000 == 0:
            log.warning("%s (%d failures so far)", message, self.failures)

    def describe(self) -> dict[str, Any]:
        current = self.current()
        return {
            "entries": len(current),
            "version": current.version,
            "expires_at": current.expires_at.isoformat()
            if current.expires_at
            else None,
            "policy": current.policy.to_dict(),
            "reads": self.reads,
            "failures": self.failures,
            "last_error": self.last_error,
        }
