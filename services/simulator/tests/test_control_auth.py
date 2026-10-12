"""The simulator's start/stop endpoints answer only the API.

They put footage behind a camera code, or take a camera's picture away, so an
unsigned call from anywhere on the network is refused. The API signs its calls
with a short-lived service token (app/core/service_auth.py).
"""

from __future__ import annotations

import time

import pytest
import pytest_asyncio
from httpx import ASGITransport, AsyncClient

from app.core import service_auth
from simulator import main

pytestmark = pytest.mark.asyncio


@pytest_asyncio.fixture
async def client():
    # No lifespan: these tests must not start the fleet's ffmpeg processes.
    transport = ASGITransport(app=main.app)
    async with AsyncClient(transport=transport, base_url="http://simulator.test") as c:
        yield c


def signed() -> dict[str, str]:
    return {service_auth.HEADER: service_auth.issue(service_auth.SIMULATOR_CONTROL)}


@pytest.mark.parametrize("action", ["start", "stop"])
async def test_an_unsigned_call_is_refused(client: AsyncClient, action: str) -> None:
    response = await client.post(f"/streams/NOT-A-CAMERA/{action}")
    assert response.status_code == 401


@pytest.mark.parametrize("action", ["start", "stop"])
async def test_a_stale_token_is_refused(client: AsyncClient, action: str) -> None:
    stale = service_auth.issue(service_auth.SIMULATOR_CONTROL, now=time.time() - 3600)
    response = await client.post(
        f"/streams/NOT-A-CAMERA/{action}", headers={service_auth.HEADER: stale}
    )
    assert response.status_code == 401


async def test_a_token_for_another_purpose_is_refused(client: AsyncClient) -> None:
    other = service_auth.issue("something.else")
    response = await client.post(
        "/streams/NOT-A-CAMERA/start", headers={service_auth.HEADER: other}
    )
    assert response.status_code == 401


async def test_a_signed_call_gets_through(client: AsyncClient) -> None:
    # Past the token check, to the registry lookup: an unknown camera is a 404,
    # not a 401.
    code = "NO-SUCH-CAMERA-0"
    started = await client.post(f"/streams/{code}/start", headers=signed())
    assert started.status_code == 404
    stopped = await client.post(f"/streams/{code}/stop", headers=signed())
    assert stopped.status_code == 404


async def test_reading_needs_no_token(client: AsyncClient) -> None:
    assert (await client.get("/streams")).status_code == 200
