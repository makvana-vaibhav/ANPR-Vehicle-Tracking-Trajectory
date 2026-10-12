"""Prometheus exposition for the platform: `GET /metrics/prometheus`.

`GET /metrics` stays as it was — JSON, read by the load test and by people —
and this is the same picture in the format a scraper reads, plus what only a
scraper wants: request rate and latency per route, the bus's consumer lag,
alerts by type and priority, how long since each camera last read a plate, and
the edge workers' own counters.

## Where each number comes from

* **Requests** — counted in this process by `MetricsMiddleware`, labelled by the
  route *template* (`/api/v1/cameras/{camera_id}`), never the raw path, so a
  camera id or a plate never becomes a label and cardinality stays fixed.
* **Ingest** — every consumer process publishes its counters to the Redis hash
  `nagarnetra:ingest:workers` (`event_consumer.WORKER_STATS_KEY`). Read from
  there rather than from this process, so a deployment whose ingest runs in
  dedicated consumers still reports it, one `worker` label per consumer.
* **Edge AI workers** — likewise, from `nagarnetra:ai:workers`, which each worker
  rewrites every few seconds (`ai_worker/worker.py`). Workers started before
  that code existed publish nothing, and their series are simply absent.
* **Bus** — `XLEN` and `XINFO GROUPS` on the detection stream, at scrape time.
* **Alerts and cameras** — two small aggregate queries at scrape time. Alerts
  are never purged, so the all-time count per type and priority is a true
  counter and `increase()` over it is the rate they were raised at.

Everything read from Redis or Postgres is refreshed at most every
`MIN_REFRESH_S`, however often the endpoint is hit, so a misconfigured scraper
cannot turn into database load. A source that fails is left out of that scrape
and counted in `contrail_metrics_scrape_errors_total{source}` — a stale number
presented as current is worse than a gap.

No plate, no person and no user ever appears in a label: camera codes and
worker ids are the only identifiers, as in `/metrics`.
"""

from __future__ import annotations

import asyncio
import json
import time
from collections.abc import Iterable, Iterator
from dataclasses import dataclass, field
from typing import Any, cast

import redis.asyncio as aioredis
from prometheus_client import (
    CollectorRegistry,
    Counter,
    GCCollector,
    Histogram,
    PlatformCollector,
    ProcessCollector,
    generate_latest,
)
from prometheus_client.core import CounterMetricFamily, GaugeMetricFamily, Metric
from prometheus_client.registry import Collector
from redis.exceptions import RedisError, ResponseError
from sqlalchemy import text
from sqlalchemy.exc import SQLAlchemyError

from app.core.config import settings
from app.core.logging import get_logger
from app.db.session import SessionLocal
from app.services.event_bus import broadcaster
from app.services.event_consumer import WORKER_STATS_TTL_S

log = get_logger("api.metrics")

#: Where the AI workers report (`ai_worker.config.ai_worker_stats_key`).
AI_WORKER_STATS_KEY = "nagarnetra:ai:workers"
#: Where ingest consumers report (`event_consumer.WORKER_STATS_KEY`).
INGEST_WORKER_STATS_KEY = "nagarnetra:ingest:workers"
#: An edge worker's report older than this is a worker that has gone; its series
#: are dropped. Long enough for the "stats are stale" alert (60 s) to fire first.
STALE_AFTER_S = 300.0
#: Shortest interval between two reads of Redis and Postgres.
MIN_REFRESH_S = 5.0
#: Plate reads are looked for this far back. A camera with none in the window
#: reports exactly this age: "at least a day", not a measurement.
LAST_READ_HORIZON_S = 86_400
#: At most this many per-camera series, so a registry of thousands of cameras
#: cannot explode the scrape. The stalest are kept, since they are the ones an
#: alert is about.
MAX_CAMERA_SERIES = 500

OPEN_STATUSES = ("new", "acknowledged", "dispatched")

REGISTRY = CollectorRegistry(auto_describe=False)
ProcessCollector(registry=REGISTRY)
PlatformCollector(registry=REGISTRY)
GCCollector(registry=REGISTRY)

HTTP_REQUESTS = Counter(
    "contrail_http_requests",
    "HTTP requests served, by method, route template and status code.",
    ["method", "route", "status"],
    registry=REGISTRY,
)
HTTP_LATENCY = Histogram(
    "contrail_http_request_duration_seconds",
    "Time to serve an HTTP request, by method and route template.",
    ["method", "route"],
    buckets=(0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1.0, 2.5, 5.0, 10.0),
    registry=REGISTRY,
)
SCRAPE_ERRORS = Counter(
    "contrail_metrics_scrape_errors",
    "Sources the exporter could not read, by source; their series are absent "
    "from that scrape rather than stale.",
    ["source"],
    registry=REGISTRY,
)


def observe_request(method: str, route: str, status: int, seconds: float) -> None:
    HTTP_REQUESTS.labels(method, route, str(status)).inc()
    HTTP_LATENCY.labels(method, route).observe(seconds)


def _always_on() -> frozenset[str]:
    """Cameras the workers keep analysing whatever is on screen."""
    codes = f"{settings.ai_worker_always_on},{settings.ai_worker_pinned}"
    return frozenset(code.strip().upper() for code in codes.split(",") if code.strip())


def _fresh(raw: dict[str, str], now: float, max_age_s: float) -> list[dict[str, Any]]:
    entries = []
    for value in raw.values():
        try:
            entry = json.loads(value)
        except ValueError:
            continue
        if isinstance(entry, dict) and now - float(entry.get("reported_at", 0)) <= max_age_s:
            entries.append(entry)
    return entries


def _counter(name: str, doc: str, labels: list[str]) -> CounterMetricFamily:
    return CounterMetricFamily(name, doc, labels=labels)


def _gauge(name: str, doc: str, labels: list[str] | None = None) -> GaugeMetricFamily:
    return GaugeMetricFamily(name, doc, labels=labels or [])


def ingest_families(entries: list[dict[str, Any]]) -> list[Metric]:
    """Ingest consumers' counters, one `worker` label each."""
    counters = {
        "consumed": "Events read off the bus, including overlay batches.",
        "persisted": "Settled sightings written to the detections table.",
        "failed": "Events that could not be persisted.",
        "boxes": "Live-overlay batches (camera.tracks) consumed; never persisted.",
        "alerts_raised": "Alerts this consumer raised.",
        "batches": "Read batches handled.",
    }
    families: list[Metric] = []
    for key, doc in counters.items():
        family = _counter(f"contrail_ingest_{key}", doc, ["worker"])
        for entry in entries:
            family.add_metric([str(entry.get("worker", "?"))], float(entry.get(key, 0) or 0))
        families.append(family)

    latency = _gauge(
        "contrail_ingest_latency_ms",
        "Capture-to-persisted latency over the consumer's rolling window, in ms.",
        ["worker", "quantile"],
    )
    for entry in entries:
        lat = entry.get("latency") or {}
        for quantile, key in (("0.5", "p50_ms"), ("0.95", "p95_ms"), ("0.99", "p99_ms")):
            if lat.get(key) is not None:
                latency.add_metric([str(entry.get("worker", "?")), quantile], float(lat[key]))
    families.append(latency)
    workers = _gauge("contrail_ingest_workers", "Ingest consumers reporting.")
    workers.add_metric([], len(entries))
    families.append(workers)
    return families


def ai_worker_families(entries: list[dict[str, Any]], now: float) -> list[Metric]:
    """Edge workers' counters, from the hash they each rewrite every few seconds."""
    spool_counters = {
        "events_published": ("published", "Events that reached the central bus."),
        "publish_failures": ("publish_failures", "Bus round trips that failed."),
        "spooled": ("spooled", "Sightings held locally because the bus could not take them."),
        "replayed": ("replayed", "Held sightings later delivered, in order."),
        "spool_dropped": ("dropped", "Held sightings discarded because the spool was full."),
        "ephemeral_dropped": (
            "ephemeral_dropped",
            "Live-only events (boxes, provisional reads) discarded during an outage.",
        ),
    }
    families: list[Metric] = []
    age = _gauge(
        "contrail_ai_worker_stats_age_seconds",
        "Seconds since the worker last reported.",
        ["worker"],
    )
    for entry in entries:
        age.add_metric([str(entry["worker"])], max(0.0, now - float(entry["reported_at"])))
    families.append(age)

    for name, (key, doc) in spool_counters.items():
        family = _counter(f"contrail_ai_worker_{name}", doc, ["worker"])
        for entry in entries:
            spool = entry.get("spool") or {}
            family.add_metric([str(entry["worker"])], float(spool.get(key, 0) or 0))
        families.append(family)

    by_kind = _counter(
        "contrail_ai_worker_events_by_kind",
        "Events emitted by the pipeline, by kind.",
        ["worker", "kind"],
    )
    cpu = _counter(
        "contrail_ai_worker_cpu_seconds",
        "CPU time of the worker process, all threads.",
        ["worker"],
    )
    held = _gauge(
        "contrail_ai_worker_spool_events",
        "Sightings held in the spool now, waiting for the bus.",
        ["worker"],
    )
    held_bytes = _gauge("contrail_ai_worker_spool_bytes", "Spool size by tier.", ["worker", "tier"])
    gauges = {
        "threads": _gauge("contrail_ai_worker_threads", "OS threads in the worker.", ["worker"]),
        "rss_bytes": _gauge(
            "contrail_ai_worker_rss_bytes", "Resident memory of the worker.", ["worker"]
        ),
        "slots": _gauge(
            "contrail_ai_worker_slots", "Cameras the worker analyses at once.", ["worker"]
        ),
        "inference_budget_threads": _gauge(
            "contrail_ai_worker_inference_budget_threads",
            "ONNX intra-op threads the worker may use across all cameras.",
            ["worker"],
        ),
    }
    cameras = _gauge(
        "contrail_ai_worker_cameras",
        "Cameras the worker owns (assigned), has a stream open for (open), and is "
        "analysing now (analysing).",
        ["worker", "state"],
    )
    for entry in entries:
        worker = str(entry["worker"])
        for kind, count in (entry.get("by_kind") or {}).items():
            by_kind.add_metric([worker, str(kind)], float(count))
        cpu.add_metric([worker], float(entry.get("cpu_seconds", 0) or 0))
        spool = entry.get("spool") or {}
        held.add_metric([worker], float(spool.get("held", 0) or 0))
        held_bytes.add_metric([worker, "memory"], float(spool.get("memory_bytes", 0) or 0))
        held_bytes.add_metric([worker, "disk"], float(spool.get("disk_bytes", 0) or 0))
        for key, gauge in gauges.items():
            if entry.get(key) is not None:
                gauge.add_metric([worker], float(entry[key]))
        for state in ("assigned", "open", "analysing"):
            cameras.add_metric([worker, state], float(entry.get(state, 0) or 0))
    families.extend([by_kind, cpu, held, held_bytes, *gauges.values(), cameras])
    return families


@dataclass(slots=True)
class _Snapshot:
    families: list[Metric] = field(default_factory=list)
    taken_at: float = 0.0


class SnapshotCollector(Collector):
    """Yields the families read by the last `refresh()`. Registered once."""

    def __init__(
        self,
        *,
        ai_stats_key: str = AI_WORKER_STATS_KEY,
        ingest_stats_key: str = INGEST_WORKER_STATS_KEY,
        min_refresh_s: float = MIN_REFRESH_S,
    ) -> None:
        self.ai_stats_key = ai_stats_key
        self.ingest_stats_key = ingest_stats_key
        self.min_refresh_s = min_refresh_s
        self._snapshot = _Snapshot()
        self._lock = asyncio.Lock()

    def collect(self) -> Iterator[Metric]:
        yield from self._snapshot.families
        sockets = _gauge("contrail_websocket_clients", "Browsers on the live feed of this API.")
        sockets.add_metric([], broadcaster.subscriber_count)
        yield sockets

    def describe(self) -> Iterable[Metric]:
        # Families vary with what each refresh found; describing them would
        # mean collecting at registration.
        return []

    async def refresh(self) -> None:
        async with self._lock:
            if time.monotonic() - self._snapshot.taken_at < self.min_refresh_s:
                return
            parts = await asyncio.gather(
                self._from_redis(), self._from_database(), return_exceptions=True
            )
            families: list[Metric] = []
            for source, part in zip(("redis", "database"), parts, strict=True):
                if isinstance(part, BaseException):
                    # Supervisor boundary: a scrape must answer whatever broke,
                    # or the platform looks down when one source is.
                    log.error("metrics.refresh_failed", source=source, exc_info=part)
                    SCRAPE_ERRORS.labels(source).inc()
                else:
                    families += part
            self._snapshot = _Snapshot(families=families, taken_at=time.monotonic())

    async def _from_redis(self) -> list[Metric]:
        client = cast(
            aioredis.Redis,
            aioredis.from_url(
                settings.redis_url,
                decode_responses=True,
                socket_connect_timeout=2.0,
                socket_timeout=2.0,
            ),
        )
        families: list[Metric] = []
        now = time.time()
        try:
            try:
                ingest = await cast(Any, client.hgetall(self.ingest_stats_key))
                # The same cut-off `/metrics` uses: a consumer that stopped
                # reporting half a minute ago is a previous process.
                families += ingest_families(_fresh(ingest, now, WORKER_STATS_TTL_S))
            except (RedisError, OSError) as exc:
                self._failed("ingest_workers", exc)
            try:
                workers = await cast(Any, client.hgetall(self.ai_stats_key))
                families += ai_worker_families(_fresh(workers, now, STALE_AFTER_S), now)
            except (RedisError, OSError, KeyError, ValueError, TypeError) as exc:
                self._failed("ai_workers", exc)
            try:
                families += await self._bus(client)
            except (RedisError, OSError) as exc:
                self._failed("bus", exc)
        finally:
            await client.aclose()
        return families

    async def _bus(self, client: aioredis.Redis) -> list[Metric]:
        length = _gauge("contrail_event_stream_length", "Entries in the detection stream.")
        length.add_metric([], float(await client.xlen(settings.event_stream_key)))
        lag = _gauge(
            "contrail_ingest_consumer_lag",
            "Stream entries not yet delivered to the consumer group.",
            ["group"],
        )
        pending = _gauge(
            "contrail_ingest_consumer_pending",
            "Entries delivered to the group and not yet acknowledged.",
            ["group"],
        )
        try:
            groups = await client.xinfo_groups(settings.event_stream_key)
        except ResponseError:
            groups = []  # no stream yet
        for group in groups:
            name = str(group.get("name"))
            pending.add_metric([name], float(group.get("pending", 0) or 0))
            # Redis reports lag as nil when it cannot compute it cheaply (after
            # a trim past the group's position); absent rather than invented.
            if group.get("lag") is not None:
                lag.add_metric([name], float(group["lag"]))
        return [length, lag, pending]

    async def _from_database(self) -> list[Metric]:
        families: list[Metric] = []
        try:
            async with SessionLocal() as session:
                alert_rows = (
                    await session.execute(
                        text(
                            "SELECT alert_type, priority, status, count(*) FROM alerts "
                            "GROUP BY alert_type, priority, status"
                        )
                    )
                ).all()
                camera_rows = (
                    await session.execute(
                        text(
                            "SELECT c.camera_code, last.ts FROM cameras c "
                            "LEFT JOIN LATERAL ("
                            "  SELECT max(d.ts) AS ts FROM detections d"
                            "  WHERE d.camera_id = c.id AND d.plate_normalised IS NOT NULL"
                            "  AND d.ts > now() - make_interval(secs => :horizon)"
                            ") last ON true "
                            "WHERE c.anpr_enabled"
                        ),
                        {"horizon": LAST_READ_HORIZON_S},
                    )
                ).all()
                now = (await session.execute(text("SELECT now()"))).scalar_one()
        except (SQLAlchemyError, OSError) as exc:
            self._failed("database", exc)
            return families

        raised = _counter(
            "contrail_alerts_raised",
            "Alerts ever raised, by type and priority. Alerts are never purged.",
            ["type", "priority"],
        )
        open_ = _gauge(
            "contrail_alerts_open",
            "Alerts not yet closed or marked false positive.",
            ["type", "priority"],
        )
        totals: dict[tuple[str, str], int] = {}
        opened: dict[tuple[str, str], int] = {}
        for alert_type, priority, status, count in alert_rows:
            key = (str(alert_type), str(priority))
            totals[key] = totals.get(key, 0) + int(count)
            if status in OPEN_STATUSES:
                opened[key] = opened.get(key, 0) + int(count)
        for key, count in sorted(totals.items()):
            raised.add_metric(list(key), float(count))
            open_.add_metric(list(key), float(opened.get(key, 0)))
        families += [raised, open_]

        always_on = _always_on()
        ages = sorted(
            (
                (
                    min(float(LAST_READ_HORIZON_S), (now - ts).total_seconds())
                    if ts is not None
                    else float(LAST_READ_HORIZON_S),
                    str(code),
                )
                for code, ts in camera_rows
            ),
            reverse=True,
        )[:MAX_CAMERA_SERIES]
        freshness = _gauge(
            "contrail_camera_last_plate_read_age_seconds",
            "Seconds since an ANPR camera last produced a plate read; "
            f"{LAST_READ_HORIZON_S} means none in that many seconds.",
            ["camera", "always_on"],
        )
        for age_s, code in ages:
            freshness.add_metric(
                [code, "true" if code.upper() in always_on else "false"], max(0.0, age_s)
            )
        families.append(freshness)
        return families

    def _failed(self, source: str, exc: BaseException) -> None:
        SCRAPE_ERRORS.labels(source).inc()
        log.warning("metrics.source_failed", source=source, error=str(exc))


collector = SnapshotCollector()
REGISTRY.register(collector)


async def exposition() -> bytes:
    """The Prometheus text format, after a (rate-limited) refresh."""
    await collector.refresh()
    return generate_latest(REGISTRY)
