"""Shared pytest fixtures for the NagarNetra API test suite.

Tests run inside the api container (``make test``), so the live infrastructure
from docker-compose is reachable. Tests that require it are marked
``@pytest.mark.integration``; the rest exercise the application in-process
through an ASGI transport with no network involved.
"""

from __future__ import annotations

import ipaddress
import os
from collections.abc import AsyncGenerator, Callable, Iterator

import pytest
from httpx import ASGITransport, AsyncClient

# Imported under an alias: this module also defines a `settings` *fixture*,
# and the fixture function would otherwise shadow the object.
from app.core.config import Settings, get_settings
from app.core.config import settings as app_settings
from app.db.session import engine
from app.main import app
from app.services import focus, grid_session, token_store


@pytest.fixture(autouse=True)
async def _reset_pooled_clients() -> AsyncGenerator[None, None]:
    """Return pooled connections to a clean state after every test.

    Both the SQLAlchemy engine and the Redis client are module-level singletons
    created on first use, while pytest-asyncio runs each test in its own event
    loop. Without this, connections outlive the loop that created them and the
    next test fails with "attached to a different loop" / "Event loop is closed".

    This is a test-harness concern only: in production both run inside a single
    long-lived loop, which is exactly what connection pools are designed for.
    """
    yield
    await engine.dispose()
    await token_store.close()
    await focus.close()
    await grid_session.session.close()


@pytest.fixture(autouse=True)
def _relax_rate_limits() -> Iterator[None]:
    """Raise the rate-limit budget for the duration of a test.

    The suite fires several hundred requests in a few seconds from one client,
    which is nothing like a human operator and would exhaust any honest
    production budget. Rather than weaken the real defaults, the ceiling is
    lifted here and the limiter's actual behaviour is asserted directly in
    `test_retention.py::TestRateLimiting` — including that a 429 fires once the
    budget is spent.

    The middleware is left *enabled*, so every test still exercises the code
    path and the rate-limit headers are still produced.
    """
    original = (app_settings.rate_limit_requests, app_settings.rate_limit_auth_requests)
    app_settings.rate_limit_requests = 1_000_000
    app_settings.rate_limit_auth_requests = 1_000_000
    try:
        yield
    finally:
        (
            app_settings.rate_limit_requests,
            app_settings.rate_limit_auth_requests,
        ) = original


@pytest.fixture(autouse=True)
def _no_simulator_control() -> Iterator[None]:
    """Keep the suite from starting replays on the live simulator.

    Creating a camera with a recorded clip makes the API ask the simulator to
    publish it (app/services/simulator_control.py). Against the live stack
    that would put test cameras' footage into the real gateway, so the calls
    are off unless a test turns them on — and the tests that do point them at
    a mock transport, never at the simulator.
    """
    original = (app_settings.simulator_control_url, app_settings.probe_on_onboard)
    app_settings.simulator_control_url = ""
    # Likewise the probe straight after onboarding: test cameras point at
    # addresses that do not answer, and each would wait out the probe timeout.
    app_settings.probe_on_onboard = False
    try:
        yield
    finally:
        app_settings.simulator_control_url, app_settings.probe_on_onboard = original


@pytest.fixture
async def client() -> AsyncGenerator[AsyncClient, None]:
    """An HTTP client bound directly to the ASGI app.

    Uses ASGITransport rather than a live server: the tests exercise real
    routing, dependencies and middleware, but do not need a port to be open.
    """
    transport = ASGITransport(app=app)
    async with AsyncClient(
        transport=transport,
        base_url="http://nagarnetra.test",
    ) as async_client:
        yield async_client


def trusted_proxy() -> str:
    """An address the API believes X-Forwarded-For from (FORWARDED_ALLOW_IPS).

    In compose that is the web tier's nginx, pinned in docker-compose.yml.
    """
    first = app_settings.forwarded_allow_ips.split(",")[0].strip()
    if first == "*":
        raise RuntimeError("FORWARDED_ALLOW_IPS=* trusts every caller; set the proxy's address")
    network = ipaddress.ip_network(first, strict=False)
    return str(network.network_address if network.num_addresses == 1 else next(network.hosts()))


@pytest.fixture
def client_from() -> Callable[[str], AsyncClient]:
    """A client whose connection arrives from a given address.

    What the trusted-proxy middleware decides depends on the socket peer, which
    the default client fixes at 127.0.0.1.
    """

    def _make(peer: str) -> AsyncClient:
        return AsyncClient(
            transport=ASGITransport(app=app, client=(peer, 40000)),
            base_url="http://nagarnetra.test",
        )

    return _make


@pytest.fixture
def settings() -> Settings:
    """The process-wide settings object."""
    return get_settings()


# ── Authentication helpers ────────────────────────────────────────────
# The seeded demo accounts (scripts/seed.py) give one user per role, which is
# exactly what the RBAC matrix tests need. Each has its own password, generated
# into .env by `make env` (scripts/gen_secrets.py) and reaching this container
# through env_file: BOOTSTRAP_ADMIN_PASSWORD for the admin, and
# DEMO_PASSWORD_<USERNAME> (upper-cased, `-` as `_`) for the rest. They used to
# share one password committed in the seed script.


def demo_password(username: str) -> str:
    """The password a seeded demo account was given."""
    if username == app_settings.bootstrap_admin_username:
        return app_settings.bootstrap_admin_password
    key = "DEMO_PASSWORD_" + username.upper().replace("-", "_")
    value = os.environ.get(key, "")
    if not value:
        raise RuntimeError(
            f"{key} is not set. Run `make env` and recreate the api container, "
            "then `make seed` (or `python -m scripts.seed --reset-demo-passwords`)."
        )
    return value


DEMO_ACCOUNTS = {
    "admin": "admin",
    "supervisor": "supervisor",
    "operator": "operator",
    "analyst": "analyst",
    "auditor": "auditor",
    "api_client": "gsrtc-integration",
}


@pytest.fixture
async def login(client: AsyncClient):
    """Return a callable that logs in as a role and yields its token pair."""

    async def _login(role: str = "admin") -> dict[str, str]:
        username = DEMO_ACCOUNTS[role]
        response = await client.post(
            "/api/v1/auth/login",
            json={"username": username, "password": demo_password(username)},
        )
        assert response.status_code == 200, (
            f"login as {username} failed: {response.status_code} {response.text}. "
            "Has `make seed` been run?"
        )
        return response.json()

    return _login


@pytest.fixture
async def auth_headers(login):
    """Return a callable producing Authorization headers for a role."""

    async def _headers(role: str = "admin") -> dict[str, str]:
        tokens = await login(role)
        return {"Authorization": f"Bearer {tokens['access_token']}"}

    return _headers
