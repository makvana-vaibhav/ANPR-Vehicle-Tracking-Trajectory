"""The worker: one inference loop per camera, supervised.

Each camera gets its own thread running the lab's StreamRunner, which reads
RTSP, tracks vehicles, reads plates and emits events. The supervisor's job is
narrow and unglamorous: keep a stream open for every camera it owns, give the
inference slots to them in turn, restart the ones that die, and stop cleanly.

Restarting matters more than it sounds. A CCTV stream drops — the encoder
reboots, the network blips, a technician unplugs something — and a worker that
treats that as fatal takes a camera offline until someone notices. The reader
already reconnects within a session; this handles the case where the session
itself ends.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import resource
import sys
import threading
import time
from collections.abc import Awaitable
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, cast

import redis.asyncio as aioredis
from ailab import runtime
from ailab.config import RunConfig
from redis.exceptions import RedisError
from ailab.stream import SourceIdentity, StreamRunner, StreamUnavailable
from ailab.stream.reader import redact
from ailab.face.stage import FaceStage

from ai_worker.backoff import ACCOUNT_REASONS, Backoff, host_of
from ai_worker.config import WorkerSettings
from ai_worker.crops import MinioCropStore
from ai_worker.face_pool import FaceModelsPool
from ai_worker.gallery import GalleryCache
from ai_worker.roster_watch import RosterWatch
from ai_worker.discovery import (
    CameraStream,
    discover,
    discover_registry,
    discover_sandbox,
    with_gateway_credentials,
)
from ai_worker.pipeline_pool import PipelinePool
from ai_worker.rotation import Rotation
from ai_worker.publisher import RedisEventSink

log = logging.getLogger(__name__)

#: What each diagnosis means for whoever is reading the log. The point of the
#: table is that these have different owners: a network team, an integration
#: contact, and us.
REASON_ADVICE = {
    "unauthorized": "the far end rejected our credentials",
    "not found": "the far end has no such camera id",
    "timeout": "the far end accepted the connection then went quiet",
    "opened but no media": "answers, but sends no decodable video",
}

#: How long shutdown waits for every camera thread together. Each one checks
#: its stop flag at least every two seconds, then closes its capture.
STOP_WAIT_S = 8.0

#: The stats hash expires this long after the last report from any worker, so
#: a fleet shut down overnight does not come back reporting yesterday. Longer
#: than the exporter's own 300 s cut-off, so that when every worker dies at
#: once the "worker stale" alert still sees their ages climb, and fires.
STATS_TTL_S = 600


def process_usage() -> dict[str, int | float]:
    """CPU time, OS threads and resident memory of this process.

    OS threads rather than Python's: ONNX Runtime's intra-op pools and the
    decoders are native threads, and they are what the thread budget governs.
    Linux figures come from /proc; elsewhere (a native macOS worker) the thread
    count falls back to Python's and memory to the peak.
    """
    usage = resource.getrusage(resource.RUSAGE_SELF)
    threads = threading.active_count()
    rss = usage.ru_maxrss * (1 if sys.platform == "darwin" else 1024)
    try:
        for line in Path("/proc/self/status").read_text().splitlines():
            if line.startswith("Threads:"):
                threads = int(line.split()[1])
        pages = int(Path("/proc/self/statm").read_text().split()[1])
        rss = pages * os.sysconf("SC_PAGE_SIZE")
    except (OSError, ValueError, IndexError):
        pass
    return {
        "cpu_seconds": round(usage.ru_utime + usage.ru_stime, 2),
        "threads": threads,
        "rss_bytes": rss,
    }


def _spool_dir(settings: WorkerSettings) -> Path | None:
    """This worker's own disk spool, or None to hold events in memory only.

    A subdirectory per worker index, so the three workers of `make ai-multi`
    can share one volume without replaying each other's events. A directory
    that cannot be created costs the disk tier, not the worker.
    """
    if not settings.ai_worker_spool_dir:
        return None
    path = Path(settings.ai_worker_spool_dir) / f"worker-{settings.ai_worker_index}"
    try:
        path.mkdir(parents=True, exist_ok=True)
    except OSError as exc:
        log.error(
            "disk spool %s unusable (%s); holding events in memory only", path, exc
        )
        return None
    return path


@dataclass
class CameraTask:
    """One camera being processed."""

    stream: CameraStream
    thread: threading.Thread
    stop: threading.Event
    started_at: float = field(default_factory=time.perf_counter)
    restarts: int = 0
    last_report: dict[str, Any] = field(default_factory=dict)
    #: Set while this camera holds an inference slot. Clear, its stream stays
    #: open and decoding but nothing is analysed. See `Rotation`.
    analyse: threading.Event = field(default_factory=threading.Event)
    #: True when the stream could not be opened at all. Distinguishes "the far
    #: end is down" from "our inference loop broke", which are different
    #: problems with different owners.
    unreachable: bool = False
    #: Why, from `ailab.stream.reader.diagnose`.
    reason: str = ""
    #: Set by the camera thread once its stream opens; `open_seen` once the
    #: supervisor has told the backoff. Seen once, not on every pass: a
    #: session opened an hour ago says nothing about whether the far end
    #: would accept our login now.
    opened: bool = False
    open_seen: bool = False

    @property
    def alive(self) -> bool:
        return self.thread.is_alive()


class AiWorker:
    """Supervises per-camera inference loops."""

    def __init__(self, settings: WorkerSettings, config: RunConfig) -> None:
        self.settings = settings
        self.config = config
        # Declare the thread budget BEFORE anything builds an inference
        # session, because a session's thread pool is fixed at construction and
        # cannot be resized afterwards.
        #
        # Each camera runs a whole pipeline on its own thread, and every one of
        # its five ONNX sessions used to size its pool as though it were alone
        # on the machine. Left undeclared that is ~124 threads on 10 cores at
        # three cameras, which measured 866% CPU and a host load average of
        # 18.8 — the AI worker starving the media gateway and the browser it
        # exists to serve. See `ailab.runtime`.
        runtime.set_concurrency(settings.ai_worker_max_cameras)
        opencv_threads = runtime.apply_opencv_threads()
        log.info(
            "inference threading: %s (opencv=%d)", runtime.describe(), opencv_threads
        )
        # Every event goes through a bounded local spool, so a bus outage holds
        # sightings for replay instead of losing them. See ai_worker.publisher.
        self.sink = RedisEventSink(
            settings.redis_url,
            settings.event_stream_key,
            settings.event_stream_maxlen,
            spool_max_events=settings.ai_worker_spool_max_events,
            spool_max_bytes=settings.ai_worker_spool_max_bytes,
            spool_dir=_spool_dir(settings),
            spool_disk_max_bytes=settings.ai_worker_spool_disk_max_bytes,
        )
        self._stats_due = 0.0
        #: Every camera this worker owns, whether or not its stream is open.
        self._assigned: dict[str, CameraStream] = {}
        #: Opened and analysed whenever owned; empty means every owned camera.
        self._always_on = frozenset(
            c.strip() for c in settings.ai_worker_always_on.split(",") if c.strip()
        )
        #: Cameras on someone's screen now, as the API last recorded them.
        self._focus: frozenset[str] = frozenset()
        #: The roster version this worker last acted on; a change means a
        #: camera was onboarded, edited or deleted. See ai_worker.roster_watch.
        self._roster_watch = RosterWatch()
        #: When each owned camera was last on someone's screen (monotonic).
        self._last_watched: dict[str, float] = {}
        self._focus_redis: aioredis.Redis | None = None
        #: Open (or opening) streams, by camera.
        self.tasks: dict[str, CameraTask] = {}
        #: Which open streams are analysed now. Inference slots are what the
        #: rotation shares out; the streams themselves are never cycled.
        self.rotation = Rotation(
            slots=settings.ai_worker_max_cameras,
            slice_seconds=settings.ai_worker_slice_seconds,
            pinned=frozenset(
                c.strip() for c in settings.ai_worker_pinned.split(",") if c.strip()
            ),
        )
        # When a camera that would not open is asked again — and, after a
        # rejected login, when its whole host is. See ai_worker.backoff.
        self._backoff = Backoff(
            base_s=settings.restart_delay_s,
            cap_s=settings.restart_delay_max_s,
            account_base_s=settings.auth_pause_s,
            account_cap_s=settings.auth_pause_max_s,
        )
        # Evidence crops go straight from here to object storage; only the
        # object key rides the event bus. Created once and shared by every
        # camera thread, because it owns a bounded upload queue and its whole
        # purpose is to keep that bounded.
        self._crops = MinioCropStore()
        # Models outlive the cameras that borrow them; see PipelinePool.
        self._pipelines = PipelinePool()
        # The persons watchlist. Face models are loaded only if a camera this
        # worker owns is tagged `analytics:faces`, and lent one camera at a
        # time; the gallery they match against is read from the platform.
        self._faces = FaceModelsPool(factory=self._load_face_models)
        self._gallery = GalleryCache(
            settings.persons_gallery_key, settings.persons_gallery_refresh_s
        )
        self._transport: str | None = None
        # Whether RTSP works to a given host, probed once. Which transport a
        # federated grid accepts is a property of this worker's network.
        self._rtsp_probe: dict[str, bool] = {}
        self._shutdown = asyncio.Event()

    # ─────────────────────────────────────────────────────────────────
    async def run(self) -> None:
        log.info(
            "ai-worker %d/%d starting (config=%s, max %d cameras)",
            self.settings.ai_worker_index,
            self.settings.ai_worker_count,
            self.config.name,
            self.settings.ai_worker_max_cameras,
        )
        try:
            next_pass = 0.0
            while not self._shutdown.is_set():
                # Focus is read every couple of seconds and a change acts at
                # once, so a camera someone opens is analysed in seconds rather
                # than at the next full pass.
                focus = await self._read_focus()
                # And so is the fleet: a camera onboarded a moment ago is
                # rediscovered now rather than at the next full pass.
                if await self._roster_changed():
                    self._focus = focus
                    await self._reconcile()
                    next_pass = time.monotonic() + self.settings.discovery_interval_s
                    # Read again now that the new camera is owned: if it is
                    # already on someone's screen, it opens in this same pass.
                    focus = await self._read_focus()
                await self._refresh_gallery()
                await self._publish_stats()
                # So is a stream that has just opened: a camera opened because
                # someone is watching it should start analysing now, not at
                # the next full pass twenty seconds away.
                newly_open = any(
                    t.opened and not t.open_seen for t in self.tasks.values()
                )
                if time.monotonic() >= next_pass or focus != self._focus or newly_open:
                    self._focus = focus
                    await self._reconcile()
                    next_pass = time.monotonic() + self.settings.discovery_interval_s
                try:
                    await asyncio.wait_for(
                        self._shutdown.wait(), timeout=self.settings.focus_poll_s
                    )
                except TimeoutError:
                    continue
        finally:
            await self._stop_all()
            if self._focus_redis is not None:
                await self._focus_redis.aclose()
            # Drain queued crops before the sink closes, so a clean shutdown
            # does not throw away evidence that was already encoded.
            self._crops.close()
            self.sink.close()

    async def _read_focus(self) -> frozenset[str]:
        """Cameras this worker owns that are on someone's screen now.

        Only owned ones, so a camera another worker owns being opened does not
        set this one reconciling. On a Redis failure the last answer stands:
        focus is a priority, and losing it for a moment must not close streams.
        """
        if self._focus_redis is None:
            self._focus_redis = aioredis.from_url(
                self.settings.redis_url,
                decode_responses=True,
                socket_connect_timeout=3,
                socket_timeout=3,
            )
        try:
            codes = await self._focus_redis.zrangebyscore(
                self.settings.focus_key, f"({time.time()}", "+inf"
            )
        except (RedisError, OSError) as exc:
            log.debug("could not read focus: %s", exc)
            return self._focus
        return frozenset(code for code in codes if code in self._assigned)

    async def _roster_changed(self) -> bool:
        """Whether the registry roster changed since this worker last looked.

        Only the registry source has a roster. See ai_worker.roster_watch.
        """
        if self.settings.ai_worker_source != "registry" or self._focus_redis is None:
            return False
        return await self._roster_watch.poll(
            self._focus_redis, self.settings.roster_version_key
        )

    async def _publish_stats(self) -> None:
        """Report this worker's counters for the platform's exporter.

        One hash field per worker, rewritten every few seconds; the reader
        judges staleness from `reported_at`. Losing a report — the bus is
        down, which is exactly when the spool counters matter — costs nothing:
        the next one carries the totals.
        """
        now = time.monotonic()
        if now < self._stats_due or self._focus_redis is None:
            return
        self._stats_due = now + self.settings.ai_worker_stats_every_s
        report = self.stats_report()
        try:
            # redis-py types HSET for its sync and async clients at once.
            await cast(
                Awaitable[int],
                self._focus_redis.hset(
                    self.settings.ai_worker_stats_key,
                    str(report["worker"]),
                    json.dumps(report),
                ),
            )
            await self._focus_redis.expire(
                self.settings.ai_worker_stats_key, STATS_TTL_S
            )
        except (RedisError, OSError) as exc:
            log.debug("could not publish worker stats: %s", exc)

    def stats_report(self) -> dict[str, Any]:
        """Counts only — camera codes, never plates or faces."""
        open_streams = sorted(c for c, t in self.tasks.items() if t.opened and t.alive)
        return {
            "worker": f"{self.settings.ai_worker_index}/{self.settings.ai_worker_count}",
            "reported_at": time.time(),
            "assigned": len(self._assigned),
            "open": len(open_streams),
            "analysing": len(self.rotation.started_at),
            "open_cameras": open_streams,
            "analysing_cameras": sorted(self.rotation.started_at),
            "slots": self.rotation.slots,
            "sweep_seconds": round(self.rotation.sweep_seconds, 1),
            "by_kind": dict(self.sink.by_kind),
            "spool": self.sink.stats(),
            "inference_budget_threads": runtime.total_budget(),
            "threads_per_model": runtime.threads_per_model(),
            **process_usage(),
        }

    async def _refresh_gallery(self) -> None:
        """Re-read the persons gallery when it is due, if any camera this
        worker owns looks for faces. A worker with none never reads it."""
        if not any(stream.faces for stream in self._assigned.values()):
            return
        if not self._gallery.due() or self._focus_redis is None:
            return
        await self._gallery.refresh(self._focus_redis)

    def _load_face_models(self) -> Any:
        """Build one set of face models, inside the thread budget.

        Imported here so a worker that never meets a faces camera never loads
        OpenCV's DNN networks at all. `FaceModels` applies
        `ailab.runtime.apply_opencv_threads()` before creating either network.
        """
        from ailab.face.models import FaceModels

        faces = self.config.faces
        return FaceModels(
            faces.models_dir,
            score_threshold=faces.detect_score,
            detect_max_side=faces.detect_max_side,
        )

    def _wanted(self, now: float) -> tuple[set[str], set[str]]:
        """Which owned cameras should have a stream open, and which be analysed.

        Always-on cameras are both. A camera on someone's screen is both, and
        stays open — unanalysed — for `focus_linger_s` after it leaves the
        screen, so clicking back to it costs the grid no new session.
        """
        owned = set(self._assigned)
        for code in self._focus:
            self._last_watched[code] = now
        for code in [c for c in self._last_watched if c not in owned]:
            del self._last_watched[code]

        base = (
            owned
            if not self._always_on
            else {c for c in owned if c in self._always_on or c in self.rotation.pinned}
        )
        recent = sorted(
            (
                code
                for code, seen in self._last_watched.items()
                if code not in base and now - seen < self.settings.focus_linger_s
            ),
            key=lambda code: -self._last_watched[code],
        )[: self.settings.focus_max_streams]
        open_set = base | set(recent)
        return open_set, base | (set(self._focus) & open_set)

    async def _discover(self) -> list[CameraStream]:
        """Every camera this worker owns — not just the ones it can run now."""
        explicit = frozenset(
            c.strip() for c in self.settings.ai_worker_cameras.split(",") if c.strip()
        )

        if self.settings.ai_worker_source == "registry":
            # An explicit list narrows the roster rather than replacing it, so
            # the camera keeps its resolved URL and its plate regions. See
            # discover_registry for what went wrong when it replaced it.
            return await discover_registry(
                self.settings.redis_url,
                self.settings.ai_worker_index,
                self.settings.ai_worker_count,
                rtsp_probe=self._rtsp_probe,
                only=explicit,
                gateway=(
                    self.settings.roster_gateway_host,
                    self.settings.mediamtx_host,
                ),
            )

        if explicit:
            # No roster to narrow: the codes are all there is.
            return await discover(
                self.settings.mediamtx_api_url,
                self.settings.mediamtx_host,
                self.settings.mediamtx_rtsp_port,
                self.settings.ai_worker_index,
                self.settings.ai_worker_count,
                self.settings.ai_worker_cameras,
                limit=10_000,
            )

        if self.settings.ai_worker_source == "sandbox":
            wanted = await discover_sandbox(
                self.settings.sandbox_base_url,
                self.settings.ai_worker_index,
                self.settings.ai_worker_count,
                10_000,
                self.settings.sandbox_transport or self._transport,
            )
            # Probe once, then reuse: the answer is a property of the network,
            # not of the camera, and re-probing every cycle is wasted latency.
            if wanted and self._transport is None:
                self._transport = wanted[0].transport
            return wanted

        return await discover(
            self.settings.mediamtx_api_url,
            self.settings.mediamtx_host,
            self.settings.mediamtx_rtsp_port,
            self.settings.ai_worker_index,
            self.settings.ai_worker_count,
            limit=10_000,
        )

    async def _reconcile(self) -> None:
        """Open a stream for every assigned camera, then share out the analysis.

        The two are separate on purpose. Streams are opened once and kept open,
        because the organisers' grid answers a camera opened and closed every
        few minutes by refusing our login — it did, twice, for about fifteen
        minutes each time. Inference slots are what rotates: a camera's stream
        stays up while it waits, so its turn costs the far end nothing.
        """
        gateway_hosts = frozenset(
            {self.settings.mediamtx_host, self.settings.roster_gateway_host}
        )
        self._assigned = {
            s.camera_code: with_gateway_credentials(
                s,
                gateway_hosts,
                self.settings.mediamtx_read_user,
                self.settings.mediamtx_read_password,
            )
            for s in await self._discover()
        }
        self._backoff.retain(frozenset(self._assigned))
        now = time.monotonic()
        open_set, analysable = self._wanted(now)

        # Cameras that left the fleet, moved to another worker, or were only
        # open because someone was watching them, a while ago now.
        for code in list(self.tasks):
            if code not in self._assigned:
                log.info("camera %s no longer assigned; stopping", code)
                self._stop(code)
            elif self._assigned[code].rtsp_url != self.tasks[code].stream.rtsp_url:
                # The registry moved the camera's source (`make grid-replay`,
                # a new URL typed in the UI). Stopped here, reopened below on
                # the new address; left alone it would read the old one until
                # that stream happened to end.
                log.info("camera %s changed source; reopening", code)
                self._stop(code)
            elif code not in open_set:
                log.info(
                    "closing %s; it has not been on anyone's screen for %.0f min",
                    code,
                    self.settings.focus_linger_s / 60,
                )
                self._stop(code)

        # Streams that opened since the last pass. Before the deaths below, so
        # a camera that opened and then died is judged on its latest outcome.
        for code, task in self.tasks.items():
            if task.opened and not task.open_seen:
                task.open_seen = True
                self._backoff.opened(code, host_of(task.stream.rtsp_url))

        # Threads that ended: the stream would not open, or the loop died.
        for code, task in list(self.tasks.items()):
            if task.alive:
                continue
            ran_for = time.perf_counter() - task.started_at
            host = host_of(task.stream.rtsp_url)
            if task.unreachable:
                # Already logged as a warning by the loop itself; the backoff
                # decides when it costs the far end another attempt.
                paused_before = self._backoff.host_paused_until.get(host)
                delay = self._backoff.failed(code, host, task.reason, now)
                if task.reason not in ACCOUNT_REASONS:
                    log.info("%s will be asked again in %.0fs", code, delay)
                elif self._backoff.host_paused_until.get(host) != paused_before:
                    log.warning(
                        "%s refused our login; no camera on %s will be opened "
                        "for %.0fs, then one will ask again",
                        code,
                        host,
                        delay,
                    )
            else:
                delay = self._backoff.failed(code, host, "exited", now)
                log.warning(
                    "stream for %s ended after %.0fs; reopening in %.0fs",
                    code,
                    ran_for,
                    delay,
                )
            self._stop(code)

        # Open what is not open — pinned cameras first, then watched ones — one
        # at a time: a worker opening a dozen grid streams in the same instant
        # is a burst to the far end, which is what a per-account limiter is
        # there to stop.
        unopened = sorted(
            (
                s
                for code, s in self._assigned.items()
                if code in open_set and code not in self.tasks
            ),
            key=lambda s: (
                s.camera_code not in self.rotation.pinned,
                s.camera_code not in self._focus,
                s.camera_code,
            ),
        )
        opened_now = 0
        for stream in unopened:
            if not self._backoff.admit(
                stream.camera_code, host_of(stream.rtsp_url), now
            ):
                continue
            if opened_now and self.settings.start_stagger_s > 0:
                try:
                    await asyncio.wait_for(
                        self._shutdown.wait(), timeout=self.settings.start_stagger_s
                    )
                    return
                except TimeoutError:
                    pass
            self._start(stream, 0)
            opened_now += 1

        # Share the inference slots among the streams that are up and wanted
        # analysed; one kept open only because it was watched recently waits.
        self.rotation.focused = self._focus
        self.rotation.update_assignment(
            [
                t.stream
                for code, t in self.tasks.items()
                if t.opened and t.alive and code in analysable
            ]
        )
        for code in self.rotation.expired():
            self._pause(code)
        for stream in self.rotation.next_up():
            self._analyse(stream.camera_code)
        # A camera can also lose its slot without its turn ending: nobody is
        # watching it any more, or it left the rotation with its stream.
        for code, task in self.tasks.items():
            if task.analyse.is_set() and code not in self.rotation.started_at:
                task.analyse.clear()
                log.info(
                    "pausing analysis of %s; it is no longer on anyone's screen", code
                )

        self._log_coverage()

    def _analyse(self, code: str) -> None:
        task = self.tasks.get(code)
        if task is None:
            return
        self.rotation.take_slot(code)
        task.analyse.set()
        turn = self.rotation.slice_for(code)
        log.info(
            "analysing %s %s",
            code,
            "while it is on screen"
            if code in self._focus
            else f"for {turn:.0f}s"
            if turn
            else "continuously",
        )

    def _pause(self, code: str) -> None:
        self.rotation.release_slot(code)
        task = self.tasks.get(code)
        if task is not None:
            task.analyse.clear()
        log.info("pausing analysis of %s; its slot is wanted elsewhere", code)

    def _log_coverage(self) -> None:
        """Say what is running and, honestly, what is not."""
        total = len(self._assigned)
        if not total:
            log.info(
                "no cameras assigned — the roster is empty for this shard. "
                "Is the API publishing it, and are any cameras anpr_enabled?"
            )
            return

        open_streams = sum(1 for t in self.tasks.values() if t.opened and t.alive)
        # Open but not in the rotation: watched a while ago, kept open so that
        # clicking back costs the grid no new session, and not analysed.
        lingering = open_streams - len(self.rotation.assigned)
        sweep = self.rotation.sweep_seconds
        coverage = (
            f"; {open_streams} streams open, {self.rotation.slots} analysed at a time, "
            f"each for {self.rotation.slice_seconds:.0f}s every {sweep / 60:.1f} min"
            if sweep > 0
            else f"; {open_streams} streams open, "
            f"{len(self.rotation.assigned)} analysed continuously"
        )
        if lingering > 0:
            coverage += f", {lingering} kept open unanalysed since leaving the screen"
        if self._focus:
            coverage += f"; on screen: {', '.join(sorted(self._focus))}"
        now = time.monotonic()
        for host, left in self._backoff.paused_hosts(now).items():
            coverage += (
                f"; {host} refused our login — next try in {left:.0f}s"
                if left > 0
                else f"; {host} refused our login — one camera is asking again"
            )
        waiting = self._backoff.waiting(now)
        if waiting:
            coverage += f"; {waiting} camera(s) backing off"
        faces = sorted(code for code, s in self._assigned.items() if s.faces)
        if faces:
            entries = len(self._gallery.current())
            coverage += (
                f"; faces looked for on {', '.join(faces)} against {entries} "
                f"approved entr{'y' if entries == 1 else 'ies'}"
            )
        pool = self._pipelines.stats()
        log.info(
            "analysing %d of %d camera(s): %s · %d events published%s · "
            "pipelines built %d, reused %d",
            len(self.rotation.started_at),
            total,
            ", ".join(sorted(self.rotation.started_at)),
            self.sink.written,
            coverage,
            # One pipeline per open stream; `built` should settle there and
            # stop rising. If it keeps climbing, pipelines are not being
            # returned when a stream ends.
            pool["built"],
            pool["reused"],
        )

    # ─────────────────────────────────────────────────────────────────
    def _start(self, stream: CameraStream, restarts: int) -> None:
        """Open a camera's stream. It analyses nothing until given a slot."""
        stop, analyse = threading.Event(), threading.Event()
        thread = threading.Thread(
            target=self._process,
            args=(stream, stop, analyse),
            name=f"cam-{stream.camera_code}",
            daemon=True,
        )
        self.tasks[stream.camera_code] = CameraTask(
            stream=stream, thread=thread, stop=stop, analyse=analyse, restarts=restarts
        )
        thread.start()
        log.info(
            "opening %s [%s] over %s — %s",
            stream.camera_code,
            stream.label or "unnamed",
            stream.transport,
            # Redacted: RTSP credentials travel in the URL, and this line goes
            # to stdout, the container log, and wherever those are shipped.
            redact(stream.rtsp_url),
        )

    def _config_for(self, stream: CameraStream) -> RunConfig:
        """The pipeline config for one camera.

        Identical to the worker's config in every inference decision; only the
        accepted plate formats differ, and only when the camera declares them.
        A copy per camera because each runs on its own thread.
        """
        if tuple(stream.plate_regions) == tuple(self.config.consensus.plate_regions):
            return self.config
        config = self.config.model_copy(deep=True)
        config.consensus.plate_regions = tuple(stream.plate_regions)
        return config

    def _process(
        self, stream: CameraStream, stop: threading.Event, analyse: threading.Event
    ) -> None:
        """One camera's stream, analysed while `analyse` is set. Its own thread."""
        source = SourceIdentity(camera_id=stream.camera_code, name=stream.camera_code)
        config = self._config_for(stream)
        # Borrowed, not built. Constructing a Pipeline here loads five ONNX
        # models and leaks their native thread pools on every rotation — see
        # PipelinePool.
        pipeline = self._pipelines.acquire(config)
        face_models, face_stage = self._face_stage_for(stream, source)
        # Passing a run_dir is what makes crops exist at all: without one the
        # runner substitutes _NullRunDir and silently discards every crop, which
        # is why Detection.crop_key was NULL for the life of the project.
        runner = StreamRunner(
            config,
            source,
            self.sink,
            run_dir=self._crops,
            pipeline=pipeline,
            face_stage=face_stage,
            # A camera tagged for faces and not for ANPR runs the face stage
            # alone: no vehicle detection, no plates, no vehicle events.
            vehicles=stream.vehicles,
        )

        def mark_open() -> None:
            task = self._own_task(stream.camera_code, stop)
            if task is not None:
                task.opened = True

        try:
            # realtime=True: a live source sets the pace, and falling behind is
            # handled by dropping frames rather than by queueing them. `stop`
            # is what makes _stop() actually close the capture; `analyse` is
            # this camera's inference slot, given and taken by the rotation.
            report = runner.run(
                stream.rtsp_url,
                realtime=True,
                stop=stop,
                on_open=mark_open,
                analyse=analyse,
            )
            task = self._own_task(stream.camera_code, stop)
            if task is not None:
                task.last_report = report
        except StreamUnavailable as exc:
            # Expected for a federated camera whose gateway is down. It is one
            # camera's status, not a fault in this worker, so it gets a line
            # rather than a traceback — thirty unreachable cameras would
            # otherwise bury every real failure in the log.
            #
            # The *reason* is what makes the line worth reading. "unreachable"
            # sends an operator to check the network; "unauthorized" sends them
            # to find a password. Reporting the first when the truth is the
            # second is how a working grid looks broken for a day.
            log.warning(
                "%s not started — %s: %s",
                stream.camera_code,
                REASON_ADVICE.get(exc.reason, exc.reason),
                exc,
            )
            task = self._own_task(stream.camera_code, stop)
            if task is not None:
                task.unreachable = True
                task.reason = exc.reason
        except Exception:
            # A supervisor boundary: one camera's failure must not take down
            # the others, and the traceback has to survive to be diagnosed.
            log.exception("inference loop for %s failed", stream.camera_code)
        finally:
            # Returned however the run ended, including after a failure: a
            # pipeline that is not given back is one the next camera has to
            # rebuild, which is the leak this pool exists to close.
            self._pipelines.release(config, pipeline)
            if face_models is not None:
                if face_stage is not None:
                    # Releases any crop still held for a face that never got
                    # enough frames to agree. It is never uploaded.
                    face_stage.reset()
                self._faces.release(face_models)
            stop.set()

    def _face_stage_for(
        self, stream: CameraStream, source: SourceIdentity
    ) -> tuple[Any, FaceStage | None]:
        """The persons watchlist's face stage, for a camera tagged for it.

        Only a camera the registry tags `analytics:faces` gets one: faces at a
        junction are a few pixels across and its CPU is wanted for plates. If
        the face models cannot be loaded, the camera runs without the stage and
        says why, rather than failing and being retried every 30 s.
        """
        if not stream.faces:
            return None, None
        try:
            models = self._faces.acquire()
        except (FileNotFoundError, RuntimeError) as exc:
            log.warning(
                "%s is tagged analytics:faces but the face stage cannot run: %s",
                stream.camera_code,
                exc,
            )
            return None, None
        stage = FaceStage(
            models,
            self._gallery.current,
            self.sink,
            source,
            config=self.config.faces,
            crop_store=self._crops,
            run_id=f"{stream.camera_code}.faces",
        )
        log.info(
            "%s: face stage on (%s; gallery %d entr%s)",
            stream.camera_code,
            "faces only" if not stream.vehicles else "with ANPR",
            len(self._gallery.current()),
            "y" if len(self._gallery.current()) == 1 else "ies",
        )
        return models, stage

    def _own_task(self, code: str, stop: threading.Event) -> CameraTask | None:
        """The calling thread's task — never a newer one that took the camera
        over after this thread was told to stop."""
        task = self.tasks.get(code)
        return task if task is not None and task.stop is stop else None

    def _release(self, code: str) -> CameraTask | None:
        """Take a camera off its slot and tell its thread to finish."""
        task = self.tasks.pop(code, None)
        self.rotation.release_slot(code)
        if task is None:
            return None
        # A probe stopped before it answered must not hold its host half-open
        # forever; the next camera may ask instead.
        self._backoff.stopped(code, host_of(task.stream.rtsp_url))
        task.stop.set()
        return task

    def _stop(self, code: str) -> None:
        task = self._release(code)
        if task is not None and task.thread.is_alive():
            # The runner checks `stop` at least every two seconds, then closes
            # its capture. Wait a little for that, then let the daemon thread
            # finish on its own rather than block the supervisor.
            task.thread.join(timeout=3.0)

    async def _stop_all(self) -> None:
        # Tell every camera at once, then wait for them together. One at a
        # time, at three seconds each, twelve cameras outlasted the container's
        # grace period and the worker was killed with its sessions still open.
        tasks = [t for t in map(self._release, list(self.tasks)) if t is not None]
        deadline = time.monotonic() + STOP_WAIT_S
        for task in tasks:
            task.thread.join(timeout=max(0.0, deadline - time.monotonic()))

    def shutdown(self) -> None:
        self._shutdown.set()

    # ── introspection, used by the healthcheck ──
    def status(self) -> dict[str, Any]:
        return {
            "worker": f"{self.settings.ai_worker_index}/{self.settings.ai_worker_count}",
            "assigned": sorted(self._assigned),
            "streams_open": sorted(
                c for c, t in self.tasks.items() if t.opened and t.alive
            ),
            "analysing": sorted(self.rotation.started_at),
            "slots": self.rotation.slots,
            # How long before every assigned camera has had a turn. The number
            # an operator needs to answer "could we have missed a vehicle?".
            "sweep_seconds": round(self.rotation.sweep_seconds, 1),
            # Hosts that refused our login, and seconds until we ask again.
            "paused_hosts": {
                host: round(left, 1)
                for host, left in self._backoff.paused_hosts(time.monotonic()).items()
            },
            "alive": sum(1 for t in self.tasks.values() if t.alive),
            "events_published": self.sink.written,
            "publish_failures": self.sink.publish_failures,
            "by_kind": dict(self.sink.by_kind),
            # Store and forward: what is held for a bus outage, what has been
            # replayed, and what the bounds have cost. See ai_worker.publisher.
            "spool": self.sink.stats(),
            # The persons watchlist: which owned cameras look for faces, and
            # what they match against. No entry ids — counts and versions only.
            "faces": {
                "cameras": sorted(c for c, s in self._assigned.items() if s.faces),
                "gallery": self._gallery.describe(),
                "models": self._faces.stats(),
            },
        }
