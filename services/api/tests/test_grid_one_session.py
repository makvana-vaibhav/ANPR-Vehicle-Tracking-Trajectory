"""One grid session for the whole platform.

Since 11 Oct the organisers' grid refuses a request with 403 `one session per
IP` when another session is using the same address. The API, the health
monitor and the onboarding script all leave from one address and each used to
log in for itself; the API's session lost, and every grid camera on screen
failed with "no video arrived". These pin the sharing that replaced that.

They use a throwaway Redis key: the real one is the live platform's session.
"""

from __future__ import annotations

import asyncio
import json
import uuid
from datetime import UTC, datetime, timedelta
from functools import partial

import httpx
import pytest

from app.routers import grid_media
from app.services import grid_session as grid_session_module
from app.services.grid_session import GridSession, is_one_session_refusal

pytestmark = pytest.mark.integration


@pytest.fixture
def key():
    return f"test:grid:session:{uuid.uuid4().hex}"


@pytest.fixture
def grid(monkeypatch: pytest.MonkeyPatch, key: str):
    """Two processes' sessions on one key, and a grid that counts logins."""
    from app.core.config import settings

    monkeypatch.setattr(settings, "sandbox_rtsp_username", "team@example.org")
    monkeypatch.setattr(settings, "sandbox_rtsp_password", "not-a-real-password")
    logins: list[int] = []

    def handler(request: httpx.Request) -> httpx.Response:
        assert request.url.path == "/auth/login"
        logins.append(1)
        return httpx.Response(
            302, headers={"location": "/", "set-cookie": f"sentinel=s{len(logins)}; Path=/"}
        )

    real_client = httpx.AsyncClient
    monkeypatch.setattr(
        grid_session_module.httpx,
        "AsyncClient",
        partial(real_client, transport=httpx.MockTransport(handler)),
    )
    return GridSession(key=key), GridSession(key=key), logins


@pytest.fixture(autouse=True)
async def _clean(key: str):
    yield
    session = GridSession(key=key)
    await session._client().delete(key, f"{key}:lock")
    await session.close()


async def _age(session: GridSession, key: str, by: timedelta) -> None:
    """Make the shared session look older than it is."""
    raw = json.loads(await session._client().get(key))
    raw["obtained_at"] = (datetime.now(UTC) - by).isoformat()
    await session._client().set(key, json.dumps(raw))


class TestOneSessionIsShared:
    async def test_a_second_process_uses_the_first_ones_login(self, grid) -> None:
        api, ingest, logins = grid
        assert await api.cookie() == "sentinel=s1"
        assert await ingest.cookie() == "sentinel=s1"
        assert len(logins) == 1, "two logins are two sessions, and the grid refuses one"

    async def test_two_processes_starting_together_log_in_once(self, grid) -> None:
        api, ingest, logins = grid
        cookies = await asyncio.gather(api.cookie(), ingest.cookie())
        assert cookies == ["sentinel=s1", "sentinel=s1"]
        assert len(logins) == 1

    async def test_a_restarted_process_reuses_the_session(self, grid, key: str) -> None:
        api, _ingest, logins = grid
        await api.cookie()
        await api.close()
        restarted = GridSession(key=key)
        try:
            assert await restarted.cookie() == "sentinel=s1"
        finally:
            await restarted.close()
        assert len(logins) == 1


class TestARefusedSessionIsReplacedOnce:
    async def test_it_is_replaced_once_it_is_a_minute_old(self, grid, key: str) -> None:
        api, _ingest, logins = grid
        first = await api.cookie()
        await _age(api, key, timedelta(minutes=2))
        assert await api.refused(first) == "sentinel=s2"
        assert len(logins) == 2

    async def test_not_again_within_a_minute(self, grid) -> None:
        """A second login that soon is only another session to refuse."""
        api, _ingest, logins = grid
        first = await api.cookie()
        assert await api.refused(first) is None
        assert len(logins) == 1

    async def test_another_process_s_replacement_is_adopted(self, grid, key: str) -> None:
        api, ingest, logins = grid
        first = await api.cookie()
        await _age(api, key, timedelta(minutes=2))
        replacement = await ingest.refused(first)
        assert await api.refused(first) == replacement
        assert len(logins) == 2, "both processes replaced the same refused session"


class TestTheProxyRetriesOnce:
    def test_the_grids_refusal_is_recognised(self) -> None:
        assert is_one_session_refusal(403, "one session per IP")
        assert not is_one_session_refusal(403, "browser required")
        assert not is_one_session_refusal(200, "one session per IP")

    async def test_a_refusal_is_retried_with_the_replacement(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        seen: list[str | None] = []

        def handler(request: httpx.Request) -> httpx.Response:
            seen.append(request.headers.get("cookie"))
            if request.headers.get("cookie") == "sentinel=old":
                return httpx.Response(403, text="one session per IP")
            return httpx.Response(200, text="#EXTM3U")

        async def refused(cookie: str | None) -> str | None:
            assert cookie == "sentinel=old"
            return "sentinel=new"

        monkeypatch.setattr(grid_session_module.session, "refused", refused)
        async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
            response = await grid_media._fetch(
                client, "https://grid.example/cam01/index.m3u8", {"Cookie": "sentinel=old"}
            )
        assert response.status_code == 200
        assert seen == ["sentinel=old", "sentinel=new"]

    async def test_a_refusal_with_no_replacement_reaches_the_viewer(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """Returned with its body, so the player can say what the grid said."""

        def handler(request: httpx.Request) -> httpx.Response:
            return httpx.Response(403, text="one session per IP")

        async def refused(cookie: str | None) -> str | None:
            return None

        monkeypatch.setattr(grid_session_module.session, "refused", refused)
        async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
            response = await grid_media._fetch(
                client, "https://grid.example/cam01/index.m3u8", {"Cookie": "sentinel=old"}
            )
        assert response.status_code == 403
        assert (await response.aread()).decode() == "one session per IP"


class TestARefusedCatalogueIsNotAskedAgainAtOnce:
    """While the grid refused us, the health monitor asked for the catalogue
    once per camera — thirty refused requests a sweep, from an address the
    grid had just told to wait for its cooldown."""

    async def test_a_sweep_makes_one_refused_request_not_thirty(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        from app.adapters.sandbox import HostedGridAdapter
        from app.services.grid_session import CatalogueCache

        requests: list[str] = []

        def handler(request: httpx.Request) -> httpx.Response:
            requests.append(request.url.path)
            return httpx.Response(
                403,
                text="watch time limit reached — please wait for your cooldown, then watch again",
            )

        async def headers() -> dict[str, str]:
            return {"User-Agent": "test", "Cookie": "sentinel=test"}

        real_client = httpx.AsyncClient
        monkeypatch.setattr(
            grid_session_module.httpx,
            "AsyncClient",
            partial(real_client, transport=httpx.MockTransport(handler)),
        )
        monkeypatch.setattr(grid_session_module.session, "headers", headers)
        monkeypatch.setattr(grid_session_module, "catalogue", CatalogueCache())

        adapter = HostedGridAdapter(name="grid", base_url="https://grid.example")
        results = [await adapter._fetch_catalogue(5.0) for _ in range(30)]

        assert len(requests) == 1, "every camera in the sweep asked the grid again"
        assert all(payload is None for payload, _url, _error in results)
        # Each camera is told what the grid said, not merely that it failed.
        assert all("watch time limit reached" in error for _p, _u, error in results)
