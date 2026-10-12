"""Who the client is, and that a caller cannot choose it (review item S11).

The login limiter counts failures per client address, and the audit trail
records it. Both used to take the first `X-Forwarded-For` entry as sent, and
uvicorn ran with `--forwarded-allow-ips "*"`, so anyone calling the API port
directly could put a new address in that header on every attempt: each guess
was a "new client", and the "10 failures per 5 minutes" limit never fired.

Now the trusted-proxy middleware (app/main.py) believes forwarded headers only
from FORWARDED_ALLOW_IPS — the web tier's nginx — and everyone else is their
socket peer. These tests go through the whole application, middleware and all,
with the connection arriving from a chosen address.
"""

from __future__ import annotations

import asyncio
import time
import uuid
from collections.abc import Callable

import pytest
from httpx import AsyncClient

from app.core import ratelimit
from app.core.config import settings
from tests.conftest import trusted_proxy

pytestmark = pytest.mark.integration

#: Small, so the limit bites within a handful of requests.
BUDGET = 3


async def _fresh_window() -> None:
    """Start clear of a fixed-window boundary, so the count cannot reset mid-test."""
    window = settings.rate_limit_auth_window_seconds
    if window - (time.time() % window) < 5:
        await asyncio.sleep(window - (time.time() % window) + 0.1)


async def _clear(peer_ip: str) -> None:
    client = await ratelimit.RateLimitMiddleware(None)._redis()
    keys = await client.keys(f"nagarnetra:ratelimit:auth:ip:{peer_ip}:*")
    if keys:
        await client.delete(*keys)


async def _failed_logins(client: AsyncClient, forwarded: Callable[[int], str]) -> list[int]:
    """BUDGET + 2 wrong-password attempts, each claiming a different address."""
    codes = []
    for attempt in range(BUDGET + 2):
        response = await client.post(
            "/api/v1/auth/login",
            json={"username": f"nobody-{uuid.uuid4().hex[:8]}", "password": "wrong-password"},
            headers={"X-Forwarded-For": forwarded(attempt)},
        )
        codes.append(response.status_code)
    return codes


@pytest.fixture
def small_auth_budget():
    original = settings.rate_limit_auth_requests
    settings.rate_limit_auth_requests = BUDGET
    try:
        yield
    finally:
        settings.rate_limit_auth_requests = original


class TestSpoofedForwardedFor:
    async def test_a_direct_caller_cannot_reset_the_login_limit(
        self, client_from, small_auth_budget
    ) -> None:
        """The attack itself: rotate X-Forwarded-For on every guess."""
        peer = "198.51.100.77"
        await _fresh_window()
        await _clear(peer)
        try:
            async with client_from(peer) as attacker:
                codes = await _failed_logins(attacker, lambda n: f"203.0.113.{n + 1}")
        finally:
            await _clear(peer)

        assert codes[:BUDGET] == [401] * BUDGET, codes
        assert codes[-1] == 429, f"a rotated X-Forwarded-For bypassed the limit: {codes}"

    async def test_through_the_proxy_the_address_nginx_saw_is_counted(
        self, client_from, small_auth_budget
    ) -> None:
        """nginx appends the address it accepted the connection from. Whatever
        the browser wrote in front of that is the caller's own claim, so
        rotating it changes nothing."""
        real = "198.51.100.78"
        await _fresh_window()
        await _clear(real)
        try:
            async with client_from(trusted_proxy()) as via_nginx:
                codes = await _failed_logins(via_nginx, lambda n: f"203.0.113.{n + 1}, {real}")
        finally:
            await _clear(real)

        assert codes[-1] == 429, f"spoofing in front of the proxy bypassed the limit: {codes}"

    async def test_no_remote_peer_is_trusted_by_default(self) -> None:
        """Out of the box only loopback may vouch for a client, and the running
        configuration never trusts everyone — which is what `*` did."""
        from app.core.config import Settings

        assert Settings.model_fields["forwarded_allow_ips"].default == "127.0.0.1"
        assert "*" not in settings.forwarded_allow_ips
