"""Publishes vehicle events to the platform's Redis Stream — and holds them when
it cannot.

The AI tier's responsibility ends here. It does not write to Postgres, does not
consult the watchlist, and does not raise alerts — those belong to the platform,
and keeping the line sharp is what lets the worker be scaled and restarted
without coordinating with anything.

A Redis Stream rather than pub/sub, because a stream is durable: if the API
restarts, it resumes from its consumer-group offset instead of losing whatever
was in flight. The stream is capped so that a stopped consumer degrades into
losing the oldest events rather than exhausting Redis.

## Store and forward

The worker runs beside the cameras; the bus runs at the centre. Between them is
a WAN link, and a WAN link goes down. This used to cost every sighting made
while it was down: the XADD failed, the failure was counted, the event was
gone. A stolen car that crossed a junction during a ten-minute outage was never
in the platform's history at all.

So every event now goes through a bounded local **spool**:

* ``emit`` never touches the network. It serialises the event and appends it
  to the spool under a lock — microseconds — and returns. The camera thread
  that called it cannot be stalled by a slow, hung or unreachable Redis; before
  this, an unreachable host could hold an inference loop in ``connect()`` for
  as long as the OS cared to wait.
* One publisher thread drains the spool **oldest first**, in batches, through a
  pipeline. While Redis answers, the spool is a few events deep and an event
  leaves within a millisecond of being emitted.
* When Redis stops answering, the batch in hand goes back to the *front* of the
  spool and the thread retries with backoff. Events keep accumulating behind
  it, in order. When Redis answers again they are replayed in the order they
  were seen, before anything newer.
* The spool is bounded by **count and bytes** in memory, and optionally
  overflows to segment files on disk (``AI_WORKER_SPOOL_DIR``, a mounted
  volume). When every bound is exhausted the **oldest** events are dropped —
  the same choice the capped stream makes — and every drop is counted.
* **Ephemeral events are not spooled.** ``camera.tracks`` (the live boxes) and
  ``vehicle.observed`` (a vehicle still in view) exist to draw on a screen now.
  Replayed an hour later they would put rectangles on video they no longer
  describe, and they would crowd the sightings out of the spool. During an
  outage they are discarded and counted as ``ephemeral_dropped``. The settled
  ``vehicle.completed`` and ``person.match`` events are what is held.

Delivery is at least once. A pipeline that fails part-way may have landed some
of its entries, and the retry sends them again. The consumer's own rule
applies: a duplicate sighting is recoverable, a lost one is not.

On a clean shutdown (SIGTERM) the spool is drained for a few seconds; anything
still held is written to the disk spool when one is configured, and replayed by
the next process. Without a disk spool it is counted as dropped and logged.
A worker killed outright loses what was only in memory.
"""

from __future__ import annotations

import json
import logging
import os
import threading
import time
from collections import deque
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import redis

log = logging.getLogger(__name__)

#: Events that describe the screen now, not history. Never spooled — see the
#: module docstring.
EPHEMERAL_KINDS = frozenset({"camera.tracks", "vehicle.observed"})

#: Entries sent per pipeline round trip. The API consumes in batches of 200, so
#: a replayed backlog arrives at the rate the consumer reads it.
BATCH_SIZE = 200

#: Socket timeouts. Bounded so the publisher thread notices an outage within a
#: couple of seconds rather than after the operating system's TCP timeout —
#: which on a link that silently drops packets is minutes.
SOCKET_TIMEOUT_S = 2.0

#: Retry backoff while the bus is unreachable.
RETRY_INITIAL_S = 0.5
RETRY_MAX_S = 5.0

#: How long `close()` keeps trying to drain before giving up on the network.
CLOSE_DRAIN_S = 5.0

#: How often a continuing outage is logged.
OUTAGE_LOG_EVERY_S = 30.0

SEGMENT_PREFIX = "seg-"
SEGMENT_SUFFIX = ".jsonl"
#: Segment sequence numbers start high so `prepend` (used on shutdown to keep
#: older in-memory events ahead of newer on-disk ones) can always go lower.
FIRST_SEGMENT = 1_000_000_000


@dataclass(slots=True)
class _Item:
    payload: str
    size: int
    durable: bool
    #: Set once the event has been held back by an outage. Counted once in
    #: `spooled`, and in `replayed` when it finally leaves.
    spooled: bool = False


@dataclass(slots=True)
class _Segment:
    seq: int
    path: Path
    events: int = 0
    bytes: int = 0


def _item(payload: str, *, durable: bool = True, spooled: bool = False) -> _Item:
    # `json.dumps` escapes everything outside ASCII by default, so the string's
    # length is its size in bytes.
    return _Item(payload, len(payload), durable, spooled)


class DiskSpool:
    """Overflow on disk: append-only JSON-lines segments, oldest first.

    Not thread-safe; `RedisEventSink` holds its lock around every call.

    Each line is one event's JSON payload. ``json.dumps`` escapes newlines, so a
    line is always one whole event — except a line torn by a crash mid-write,
    which is skipped on reading and counted as dropped.
    """

    def __init__(
        self,
        directory: Path,
        *,
        max_bytes: int,
        segment_events: int = 2_000,
        segment_bytes: int = 8 * 1024 * 1024,
    ) -> None:
        self.directory = directory
        self.max_bytes = max_bytes
        self.segment_events = segment_events
        self.segment_bytes = segment_bytes
        self.directory.mkdir(parents=True, exist_ok=True)
        #: Oldest first. The last one is the segment being written, when
        #: `_writer` is open.
        self._segments: deque[_Segment] = deque()
        self._writer: Any = None
        self.events = 0
        self.bytes = 0
        for path in sorted(self.directory.glob(f"{SEGMENT_PREFIX}*{SEGMENT_SUFFIX}")):
            seq = self._seq_of(path)
            if seq is None:
                continue
            data = path.read_bytes()
            count = sum(1 for line in data.splitlines() if line.strip())
            if count == 0:
                path.unlink(missing_ok=True)
                continue
            self._segments.append(_Segment(seq, path, count, len(data)))
            self.events += count
            self.bytes += len(data)
        #: Events found on disk when the spool opened: what a previous process
        #: held and could not deliver.
        self.recovered = self.events

    # ── paths ──
    def _path(self, seq: int) -> Path:
        return self.directory / f"{SEGMENT_PREFIX}{seq:015d}{SEGMENT_SUFFIX}"

    @staticmethod
    def _seq_of(path: Path) -> int | None:
        stem = path.name[len(SEGMENT_PREFIX) : -len(SEGMENT_SUFFIX)]
        return int(stem) if stem.isdigit() else None

    # ── writing ──
    def _close_writer(self) -> None:
        if self._writer is not None:
            self._writer.flush()
            os.fsync(self._writer.fileno())
            self._writer.close()
            self._writer = None

    def _open_writer(self) -> None:
        seq = self._segments[-1].seq + 1 if self._segments else FIRST_SEGMENT
        segment = _Segment(seq, self._path(seq))
        self._segments.append(segment)
        self._writer = segment.path.open("a", encoding="utf-8")

    def append(self, payload: str) -> int:
        """Append one event. Returns how many of the oldest were evicted."""
        line = payload + "\n"
        size = len(line.encode("utf-8"))
        if self._writer is None:
            self._open_writer()
        else:
            current = self._segments[-1]
            if (
                current.events >= self.segment_events
                or current.bytes + size > self.segment_bytes
            ):
                self._close_writer()
                self._open_writer()
        self._writer.write(line)
        # Flushed to the OS on every event, fsynced on rotation and close: a
        # worker that crashes keeps what it wrote; a host that loses power may
        # lose the last few seconds, which is the trade for not paying an fsync
        # per sighting.
        self._writer.flush()
        current = self._segments[-1]
        current.events += 1
        current.bytes += size
        self.events += 1
        self.bytes += size
        return self._evict()

    def _evict(self) -> int:
        """Drop whole oldest segments until within the byte budget."""
        evicted = 0
        while self.bytes > self.max_bytes and self._segments:
            if len(self._segments) == 1:
                # Only the segment being written is left; close it so it can go.
                self._close_writer()
            oldest = self._segments.popleft()
            oldest.path.unlink(missing_ok=True)
            self.events -= oldest.events
            self.bytes -= oldest.bytes
            evicted += oldest.events
        return evicted

    def prepend(self, payloads: list[str]) -> None:
        """Write events that are older than everything on disk, ahead of it."""
        if not payloads:
            return
        seq = self._segments[0].seq - 1 if self._segments else FIRST_SEGMENT
        data = "".join(p + "\n" for p in payloads)
        path = self._path(seq)
        with path.open("w", encoding="utf-8") as handle:
            handle.write(data)
            handle.flush()
            os.fsync(handle.fileno())
        size = len(data.encode("utf-8"))
        self._segments.appendleft(_Segment(seq, path, len(payloads), size))
        self.events += len(payloads)
        self.bytes += size

    # ── reading ──
    def pop_oldest(self) -> tuple[list[str], int]:
        """Remove the oldest segment and return its events, and how many lines
        were unreadable (torn by a crash)."""
        if not self._segments:
            return [], 0
        if len(self._segments) == 1 and self._writer is not None:
            self._close_writer()
        oldest = self._segments.popleft()
        try:
            text = oldest.path.read_text(encoding="utf-8", errors="replace")
        except FileNotFoundError:
            text = ""
        oldest.path.unlink(missing_ok=True)
        self.events -= oldest.events
        self.bytes -= oldest.bytes
        payloads: list[str] = []
        torn = 0
        for line in text.splitlines():
            if not line.strip():
                continue
            try:
                json.loads(line)
            except ValueError:
                torn += 1
                continue
            payloads.append(line)
        return payloads, torn

    def close(self) -> None:
        self._close_writer()


class Spool:
    """The queue between the camera threads and the bus: memory first, then disk.

    Order is preserved across the two tiers. Memory holds the oldest events;
    once it is full, or while anything is on disk, new events go to disk.
    Reading takes memory first and refills it from the oldest disk segment, so
    events always leave in the order they arrived.

    Not thread-safe; `RedisEventSink` holds its lock around every call.
    """

    def __init__(
        self, *, max_events: int, max_bytes: int, disk: DiskSpool | None
    ) -> None:
        self.max_events = max_events
        self.max_bytes = max_bytes
        self.disk = disk
        self._mem: deque[_Item] = deque()
        self.memory_bytes = 0
        #: Durable events discarded because every bound was exhausted.
        self.dropped = 0
        #: Ephemeral events discarded because they cannot go to disk.
        self.ephemeral_dropped = 0

    def __len__(self) -> int:
        return len(self._mem) + (self.disk.events if self.disk is not None else 0)

    @property
    def memory_events(self) -> int:
        return len(self._mem)

    def _memory_full(self, size: int) -> bool:
        return (
            len(self._mem) >= self.max_events
            or self.memory_bytes + size > self.max_bytes
        )

    def push(self, item: _Item) -> None:
        if self.disk is not None and (self.disk.events or self._memory_full(item.size)):
            if not item.durable:
                self.ephemeral_dropped += 1
                return
            item.spooled = True
            self.dropped += self.disk.append(item.payload)
            return
        while self._mem and self._memory_full(item.size):
            oldest = self._mem.popleft()
            self.memory_bytes -= oldest.size
            if oldest.durable:
                self.dropped += 1
            else:
                self.ephemeral_dropped += 1
        self._mem.append(item)
        self.memory_bytes += item.size

    def push_front(self, items: list[_Item]) -> None:
        """Put a batch that failed to send back at the head, in order.

        It may take memory over its bound by up to one batch; the next `push`
        then overflows to disk or trims, as for any full spool.
        """
        for item in reversed(items):
            self._mem.appendleft(item)
            self.memory_bytes += item.size

    def take(self, limit: int) -> list[_Item]:
        if not self._mem and self.disk is not None and self.disk.events:
            payloads, torn = self.disk.pop_oldest()
            self.dropped += torn
            for payload in payloads:
                item = _item(payload, spooled=True)
                self._mem.append(item)
                self.memory_bytes += item.size
        batch: list[_Item] = []
        while self._mem and len(batch) < limit:
            item = self._mem.popleft()
            self.memory_bytes -= item.size
            batch.append(item)
        return batch

    def drain_memory(self) -> list[_Item]:
        items = list(self._mem)
        self._mem.clear()
        self.memory_bytes = 0
        return items


class RedisEventSink:
    """Duck-types the lab's EventSink so StreamRunner can write to the bus.

    Called from every per-camera inference thread. `emit` only enqueues; one
    background thread owns the Redis connection. See the module docstring.
    """

    def __init__(
        self,
        url: str,
        stream_key: str,
        maxlen: int = 100_000,
        *,
        spool_max_events: int = 20_000,
        spool_max_bytes: int = 48 * 1024 * 1024,
        spool_dir: str | Path | None = None,
        spool_disk_max_bytes: int = 1024 * 1024 * 1024,
        batch_size: int = BATCH_SIZE,
        retry_initial_s: float = RETRY_INITIAL_S,
        retry_max_s: float = RETRY_MAX_S,
        client: Any = None,
    ) -> None:
        self._client = client or redis.Redis.from_url(
            url,
            decode_responses=True,
            socket_connect_timeout=SOCKET_TIMEOUT_S,
            socket_timeout=SOCKET_TIMEOUT_S,
        )
        self._stream_key = stream_key
        self._maxlen = maxlen
        self._batch_size = batch_size
        self._retry_initial_s = retry_initial_s
        self._retry_max_s = retry_max_s

        disk = (
            DiskSpool(Path(spool_dir), max_bytes=spool_disk_max_bytes)
            if spool_dir
            else None
        )
        self._spool = Spool(
            max_events=spool_max_events, max_bytes=spool_max_bytes, disk=disk
        )
        self._cond = threading.Condition()
        #: Set only by `close()`. The retry backoff waits on this rather than on
        #: the condition, which every `emit` notifies: during an outage a
        #: steady stream of sightings would otherwise wake the retry at once,
        #: every time, and hammer an unreachable host at the emit rate.
        self._stopping = threading.Event()
        #: Taken from the spool and not yet confirmed or put back.
        self._in_flight = 0
        self._closing = False
        self._close_deadline = 0.0
        #: Set while the bus is unreachable; new durable events are counted as
        #: spooled and ephemeral ones are discarded.
        self._outage_since: float | None = None
        self._outage_logged_at = 0.0

        # ── counters (read by the worker's status and stats) ──
        #: Events handed to `emit`, whatever became of them.
        self.written = 0
        self.by_kind: dict[str, int] = {}
        #: Events that reached Redis.
        self.published = 0
        #: Pipeline round trips that failed.
        self.publish_failures = 0
        #: Durable events held back because the bus could not take them.
        self.spooled = 0
        #: Of those, how many were later delivered.
        self.replayed = 0
        #: Events found in the disk spool at start-up, left by a previous run.
        self.recovered = disk.recovered if disk is not None else 0
        if self.recovered:
            log.warning(
                "%d event(s) left in the disk spool by a previous run will be "
                "replayed when the bus answers",
                self.recovered,
            )

        self._thread = threading.Thread(
            target=self._run, name="bus-publisher", daemon=True
        )
        self._thread.start()

    # ── the inference threads' side ──
    def emit(self, event: dict[str, Any]) -> None:
        kind = str(event.get("event", "unknown"))
        payload = json.dumps(event, default=str)
        durable = kind not in EPHEMERAL_KINDS
        with self._cond:
            self.by_kind[kind] = self.by_kind.get(kind, 0) + 1
            self.written += 1
            if self._outage_since is not None and not durable:
                self._spool.ephemeral_dropped += 1
                return
            item = _item(
                payload, durable=durable, spooled=self._outage_since is not None
            )
            self._spool.push(item)
            # Held during an outage, or overflowed to disk behind a backlog.
            if item.spooled:
                self.spooled += 1
            self._cond.notify()

    # ── the publisher thread ──
    def _send(self, batch: list[_Item]) -> list[_Item]:
        """XADD a batch in one round trip. Returns the items Redis refused."""
        pipe = self._client.pipeline(transaction=False)
        for item in batch:
            pipe.xadd(
                self._stream_key,
                {"payload": item.payload},
                # approximate trimming: Redis trims on segment boundaries,
                # which is far cheaper than exact and just as safe here.
                maxlen=self._maxlen,
                approximate=True,
            )
        results = pipe.execute(raise_on_error=False)
        return [
            item
            for item, result in zip(batch, results, strict=True)
            if isinstance(result, Exception)
        ]

    def _wait(self, seconds: float) -> None:
        self._stopping.wait(timeout=seconds)

    def _run(self) -> None:
        delay = self._retry_initial_s
        while True:
            with self._cond:
                while not len(self._spool) and not self._closing:
                    self._cond.wait(timeout=1.0)
                if self._closing and (
                    not len(self._spool) or time.monotonic() >= self._close_deadline
                ):
                    return
                batch = self._spool.take(self._batch_size)
                self._in_flight = len(batch)
            if not batch:
                continue

            try:
                refused = self._send(batch)
                error: BaseException | None = (
                    redis.ResponseError(
                        f"{len(refused)} of {len(batch)} entries refused"
                    )
                    if refused
                    else None
                )
            except (redis.RedisError, OSError) as exc:
                refused, error = batch, exc

            delivered = len(batch) - len(refused)
            with self._cond:
                if delivered:
                    held_back = {id(item) for item in refused}
                    self.published += delivered
                    self.replayed += sum(
                        1
                        for item in batch
                        if item.spooled and id(item) not in held_back
                    )
                if error is not None:
                    self._on_failure(refused, error)
                elif self._outage_since is not None and not len(self._spool):
                    self._on_recovered()
                self._in_flight = 0
            if error is not None:
                if self._closing:
                    # Shutting down: keep trying until the deadline, briefly
                    # apart. What is left then goes to disk in close().
                    with self._cond:
                        if time.monotonic() >= self._close_deadline:
                            return
                    time.sleep(0.1)
                    continue
                self._wait(delay)
                delay = min(delay * 2, self._retry_max_s)
            else:
                delay = self._retry_initial_s

    def _on_failure(self, refused: list[_Item], error: BaseException) -> None:
        """Hold a batch that did not land. Caller holds the lock."""
        self.publish_failures += 1
        durable = [item for item in refused if item.durable]
        self._spool.ephemeral_dropped += len(refused) - len(durable)
        for item in durable:
            if not item.spooled:
                item.spooled = True
                self.spooled += 1
        self._spool.push_front(durable)

        now = time.monotonic()
        if self._outage_since is None:
            self._outage_since = now
            self._outage_logged_at = now
            log.warning(
                "event bus %s unreachable (%s); holding sightings locally "
                "(%d held, memory cap %d events / %d MB%s)",
                self._stream_key,
                error,
                len(self._spool),
                self._spool.max_events,
                self._spool.max_bytes // (1024 * 1024),
                f", disk overflow at {self._spool.disk.directory}"
                if self._spool.disk is not None
                else ", no disk overflow",
            )
        elif now - self._outage_logged_at >= OUTAGE_LOG_EVERY_S:
            self._outage_logged_at = now
            log.warning(
                "event bus still unreachable after %.0fs: %d held, %d dropped (%s)",
                now - self._outage_since,
                len(self._spool),
                self._spool.dropped,
                error,
            )

    def _on_recovered(self) -> None:
        """Caller holds the lock."""
        since = self._outage_since or time.monotonic()
        self._outage_since = None
        log.info(
            "event bus reachable again after %.0fs; %d held event(s) replayed in "
            "order so far, %d dropped",
            time.monotonic() - since,
            self.replayed,
            self._spool.dropped,
        )

    # ── lifecycle ──
    def flush(self, timeout: float = 5.0) -> bool:
        """Wait until everything emitted so far has left. True if it did."""
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            with self._cond:
                if not len(self._spool) and not self._in_flight:
                    return True
            time.sleep(0.01)
        return False

    def close(self, timeout: float = CLOSE_DRAIN_S) -> None:
        with self._cond:
            self._closing = True
            self._close_deadline = time.monotonic() + timeout
            self._cond.notify_all()
        self._stopping.set()
        self._thread.join(timeout=timeout + SOCKET_TIMEOUT_S * 2)

        with self._cond:
            left = [item for item in self._spool.drain_memory() if item.durable]
            disk = self._spool.disk
            if left and disk is not None:
                disk.prepend([item.payload for item in left])
                log.warning(
                    "shutting down with the bus unreachable: %d event(s) written "
                    "to the disk spool (%d there in all) for the next run to replay",
                    len(left),
                    disk.events,
                )
            elif left:
                self._spool.dropped += len(left)
                log.warning(
                    "shutting down with the bus unreachable and no disk spool: "
                    "%d held event(s) lost",
                    len(left),
                )
            if disk is not None:
                disk.close()
        try:
            self._client.close()
        except redis.RedisError:
            pass

    def __enter__(self) -> RedisEventSink:
        return self

    def __exit__(self, *exc: object) -> None:
        self.close()

    # ── introspection ──
    @property
    def dropped(self) -> int:
        return self._spool.dropped

    @property
    def ephemeral_dropped(self) -> int:
        return self._spool.ephemeral_dropped

    def stats(self) -> dict[str, Any]:
        with self._cond:
            disk = self._spool.disk
            return {
                "written": self.written,
                "published": self.published,
                "publish_failures": self.publish_failures,
                "spooled": self.spooled,
                "replayed": self.replayed,
                "dropped": self._spool.dropped,
                "ephemeral_dropped": self._spool.ephemeral_dropped,
                "recovered": self.recovered,
                "outage_seconds": (
                    round(time.monotonic() - self._outage_since, 1)
                    if self._outage_since is not None
                    else 0.0
                ),
                "held": len(self._spool) + self._in_flight,
                "memory_events": self._spool.memory_events,
                "memory_bytes": self._spool.memory_bytes,
                "disk_events": disk.events if disk is not None else 0,
                "disk_bytes": disk.bytes if disk is not None else 0,
                "disk_enabled": disk is not None,
            }
