"""NagarNetra API — application entrypoint.

City-wide vehicle intelligence platform (SIH26127). This tier owns the camera
registry, GIS queries, auth and audit, the event and alert engines, search,
and cross-camera trajectory correlation.

Phases are built in order (see docs/BUILD_STATE.md); routers are mounted here as
each phase lands.
"""

from __future__ import annotations

import uuid
from collections.abc import AsyncIterator, Awaitable, Callable
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request, Response
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from uvicorn.middleware.proxy_headers import ProxyHeadersMiddleware

from app.core import public_origin
from app.core.config import settings
from app.core.logging import configure_logging, get_logger, request_id_var
from app.core.ratelimit import RateLimitMiddleware
from app.core.validation_errors import validation_exception_handler
from app.db.session import dispose_engine
from app.middleware.audit import AuditMiddleware
from app.middleware.metrics import MetricsMiddleware
from app.routers import (
    alerts,
    analytics,
    audit,
    auth,
    cameras,
    detections,
    events,
    fleet,
    gap_report,
    gateway_auth,
    grid_media,
    health,
    persons,
    predictions,
    pursuits,
    registries,
    reid,
    reports,
    streams,
    users,
    vehicles,
    watchlist,
)
from app.services import (
    alert_fanout,
    event_consumer,
    event_tailer,
    fleet_roster,
    focus,
    gateway,
    grid_session,
    pursuit,
    retention,
    token_store,
)
from app.services import persons as persons_service

configure_logging(service="api")
log = get_logger("api")

DESCRIPTION = """
**Contrail** — statewide federated CCTV and vehicle-intelligence platform, built for
the Gujarat Police CCTV Hackathon *Sentinel*.

Federates existing multi-vendor, multi-department CCTV rather than replacing it
(Model 5 — Hybrid: Model 1 registry + GIS, Model 3 federation middleware, selective
Model 2 viewing). Departmental VMS remain authoritative for their own
video; this platform ingests metadata centrally, pulls streams on demand, and runs
AI at the edge so that **the central tier carries events, not video**.

* **Registry + GIS** — camera estate, PostGIS queries, bulk onboarding
* **Integration** — RTSP / ONVIF / vendor-VMS adapters, health monitoring
* **Intelligence** — ANPR events, watchlist matching, cross-camera route reconstruction
* **Audit** — every plate search, stream open, and watchlist change is recorded
"""


@asynccontextmanager
async def lifespan(_app: FastAPI) -> AsyncIterator[None]:
    """Start-up and shut-down.

    Configuration is logged (redacted) at boot so a failing deployment can be
    diagnosed from logs alone, without shell access to the container.
    """
    log.info(
        "api.starting",
        environment=settings.environment,
        event_bus=settings.event_bus_backend,
        search_fallback=settings.search_fallback_enabled,
    )
    if settings.environment == "development":
        log.debug("api.configuration", **settings.sanitised())

    # The live operations picture: every replica tails the stream and fans
    # every event out to its own sockets. Always on — an API process that
    # cannot show operators what is happening has no reason to be running.
    await event_tailer.tailer.start()
    # And alerts raised by any ingest worker, wherever it runs.
    await alert_fanout.subscriber.start()

    # Durable ingest. Started here rather than lazily on the first WebSocket
    # connection, so detections are persisted whether or not an operator
    # happens to be watching. Disabled on replicas of a deployment with
    # dedicated ingest workers; see Settings.ingest_enabled.
    if settings.ingest_enabled:
        await event_consumer.consumer.start()
    else:
        log.info("api.ingest_delegated", reason="dedicated ingest workers")
    fleet_roster.publisher.start()
    # Make the media gateway's paths match the registry. A camera onboarded
    # while MediaMTX was restarting would otherwise stay unwatchable until
    # somebody happened to edit it, with nothing reporting a fault.
    await gateway.reconcile()
    retention.enforcer.start()
    # Persons watchlist: expiry each minute, the active gallery republished
    # for the cameras, and media retention for faces. See services/persons.py.
    persons_service.sweeper.start()
    # Pursuit: keeps the cameras a pursued vehicle can reach next pinned for
    # the workers, and advances when the plate is read. See services/pursuit.py.
    pursuit.keeper.start()

    yield

    log.info("api.stopping")
    await pursuit.keeper.stop()
    await persons_service.sweeper.stop()
    await retention.enforcer.stop()
    await fleet_roster.publisher.stop()
    await event_consumer.consumer.stop()
    await alert_fanout.subscriber.stop()
    await event_tailer.tailer.stop()
    await token_store.close()
    await focus.close()
    await grid_session.session.close()
    await dispose_engine()
    log.info("api.stopped")


app = FastAPI(
    title=settings.app_name,
    description=DESCRIPTION,
    version="0.1.0",
    lifespan=lifespan,
    docs_url="/docs",
    redoc_url="/redoc",
    openapi_url="/openapi.json",
    contact={
        "name": "Contrail",
        "url": "https://github.com/makvana-vaibhav/SIH-ANPR-Vehicle-Tracking",
    },
    license_info={"name": "Apache-2.0"},
)

# A 422 never echoes a password or a credentialed URL back in its `input`
# (FastAPI's default puts the whole body there for a model-level error).
app.add_exception_handler(RequestValidationError, validation_exception_handler)

# Starlette runs middleware in reverse registration order, so what is added
# last is outermost. The intended order, outermost first, is:
#
#   CORS  →  rate limit  →  audit  →  the route
#
# CORS outermost so a 429 still carries the headers a browser needs to read it.
# The rate limiter *outside* the audit middleware so a flood is rejected before
# it can write a row per request — an attacker who can make the platform fill
# its own audit table has found a way to destroy the record of what they did.
app.add_middleware(AuditMiddleware)

app.add_middleware(RateLimitMiddleware)

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origin_list,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
    # Content-Disposition, or every CSV export saves as "export.csv": the web
    # app calls the API cross-origin, and a header not exposed is invisible.
    expose_headers=[
        "X-Request-ID",
        "X-RateLimit-Limit",
        "X-RateLimit-Remaining",
        "Content-Disposition",
    ],
)

# Request count and latency per route template, for Prometheus. Outside CORS,
# rate limiting and audit, so it times what the client experienced — a 429
# included. See app/middleware/metrics.py.
app.add_middleware(MetricsMiddleware)


@app.middleware("http")
async def request_context(
    request: Request, call_next: Callable[[Request], Awaitable[Response]]
) -> Response:
    """Assign a correlation id to every request and log its outcome.

    The id is bound into the logging context so every line emitted while
    handling the request carries it, and returned as ``X-Request-ID`` so an
    operator reporting a problem can quote a value we can grep for.

    This is *not* the audit trail — audit logging is a durable database record
    added in Phase 1. This is operational telemetry.
    """
    request_id = request.headers.get("X-Request-ID") or str(uuid.uuid4())
    token = request_id_var.set(request_id)
    # Media URLs answer to the scheme the browser used: over HTTPS they point
    # at the web tier's own proxies, over HTTP at the services directly.
    origin_token = public_origin.bind(request.url.scheme, request.headers.get("host"))

    try:
        response = await call_next(request)
    except Exception as exc:
        # Supervisor boundary: log with a stack trace, return a clean error.
        # An unhandled exception must never leak internals to a client of a
        # surveillance system.
        log.error(
            "request.unhandled_exception",
            method=request.method,
            path=request.url.path,
            error=str(exc),
            exc_info=True,
        )
        request_id_var.reset(token)
        public_origin.reset(origin_token)
        return JSONResponse(
            status_code=500,
            content={
                "detail": "Internal server error",
                "request_id": request_id,
            },
            headers={"X-Request-ID": request_id},
        )

    response.headers["X-Request-ID"] = request_id

    # Health probes fire every few seconds; logging them buries real traffic.
    if request.url.path not in ("/health", "/ready", "/metrics", "/metrics/prometheus"):
        log.info(
            "request.completed",
            method=request.method,
            path=request.url.path,
            status_code=response.status_code,
            client=request.client.host if request.client else None,
        )

    request_id_var.reset(token)
    public_origin.reset(origin_token)
    return response


# Outermost of all, so every layer inside — the request log, metrics, the rate
# limiter, the audit trail, the HTTPS media URLs — sees one answer to "who is
# the client". X-Forwarded-For and X-Forwarded-Proto are believed only from
# FORWARDED_ALLOW_IPS (the web tier's nginx); from anyone else they are ignored
# and the socket peer is the client. Through the proxy the client is the
# right-most address the proxy did not vouch for, so a value a caller writes
# into the header themselves cannot be chosen either. uvicorn is started with
# --no-proxy-headers so this is the only place the decision is made.
app.add_middleware(ProxyHeadersMiddleware, trusted_hosts=settings.forwarded_allow_ips)


# ── Routers ───────────────────────────────────────────────────────────
# Later phases mount cameras, events, watchlist, alerts, search, vehicles, admin.
app.include_router(health.router)
app.include_router(auth.router)
app.include_router(cameras.router)
app.include_router(fleet.router)
app.include_router(streams.router)
app.include_router(gateway_auth.router)
app.include_router(grid_media.router)
app.include_router(events.router)
app.include_router(detections.router)
app.include_router(users.router)
app.include_router(audit.router)
app.include_router(vehicles.router)
app.include_router(reports.router)
app.include_router(gap_report.router)
app.include_router(registries.router)
app.include_router(watchlist.router)
app.include_router(persons.router)
app.include_router(alerts.router)
app.include_router(analytics.router)
app.include_router(predictions.router)
app.include_router(reid.router)
app.include_router(pursuits.router)


@app.get("/", tags=["meta"], summary="Service banner")
async def root() -> dict[str, object]:
    """Human-readable entrypoint pointing at the interactive docs."""
    return {
        "service": settings.app_name,
        "description": (
            "Statewide federated CCTV and vehicle-intelligence platform"
            " — Gujarat Police CCTV Hackathon (Sentinel)"
        ),
        "version": app.version,
        "model": (
            "Hybrid (Model 5): Model 1 registry + GIS, Model 3 federation"
            " middleware, selective Model 2 viewing"
        ),
        "docs": "/docs",
        "health": "/health",
        "ready": "/ready",
        "api_prefix": settings.api_v1_prefix,
    }
