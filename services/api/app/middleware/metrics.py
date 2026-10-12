"""Counts and times every HTTP request for Prometheus.

A plain ASGI middleware rather than `BaseHTTPMiddleware`: it sits outermost, so
it times what the client experienced — rate limiting and audit included — and
it adds no task hop per request.

The route label is the matched route's *template*, read from the scope after
the router has run, so `/api/v1/vehicles/GJ03AB1234/route` is counted as
`/api/v1/vehicles/{plate}/route`. A plate in a label would be both a privacy
leak into the monitoring system and a new time series per vehicle. Anything
that matched no route — a 404, or a request refused before routing — is
`<unmatched>`.
"""

from __future__ import annotations

import time

from starlette.types import ASGIApp, Message, Receive, Scope, Send

from app.services import metrics

UNMATCHED = "<unmatched>"


class MetricsMiddleware:
    def __init__(self, app: ASGIApp) -> None:
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return

        started = time.perf_counter()
        status = 500

        async def send_and_record(message: Message) -> None:
            nonlocal status
            if message["type"] == "http.response.start":
                status = int(message["status"])
            await send(message)

        try:
            await self.app(scope, receive, send_and_record)
        finally:
            route = scope.get("route")
            template = getattr(route, "path", None) or UNMATCHED
            metrics.observe_request(
                str(scope.get("method", "?")),
                str(template),
                status,
                time.perf_counter() - started,
            )
