"""Onboarding with "Recorded video" starts the replay; deleting stops it.

At the jury rehearsal the form stored the clip and nothing played until someone
ran `curl -X POST :9100/streams/<CODE>/start`. The API now makes that call
itself, signed with a short-lived service token the simulator checks.
"""

from __future__ import annotations

import uuid
from typing import Any

import httpx
import pytest
from httpx import AsyncClient

from app.core import service_auth
from app.core.config import settings
from app.services import simulator_control


class TestServiceToken:
    def test_a_fresh_token_verifies_for_its_purpose(self) -> None:
        token = service_auth.issue(service_auth.SIMULATOR_CONTROL)
        assert service_auth.verify(token, service_auth.SIMULATOR_CONTROL)

    def test_it_is_bound_to_its_purpose(self) -> None:
        token = service_auth.issue("something.else")
        assert not service_auth.verify(token, service_auth.SIMULATOR_CONTROL)

    def test_it_expires(self) -> None:
        token = service_auth.issue(service_auth.SIMULATOR_CONTROL, now=1_000_000.0)
        assert service_auth.verify(token, service_auth.SIMULATOR_CONTROL, now=1_000_030.0)
        assert not service_auth.verify(token, service_auth.SIMULATOR_CONTROL, now=1_000_061.0)

    @pytest.mark.parametrize("token", [None, "", "abc", "123.", ".deadbeef", "12x.ab"])
    def test_garbage_is_refused(self, token: str | None) -> None:
        assert not service_auth.verify(token, service_auth.SIMULATOR_CONTROL)

    def test_a_tampered_timestamp_is_refused(self) -> None:
        issued, mac = service_auth.issue(service_auth.SIMULATOR_CONTROL).split(".")
        assert not service_auth.verify(f"{int(issued) + 1}.{mac}", service_auth.SIMULATOR_CONTROL)

    def test_it_is_not_a_user_jwt(self) -> None:
        from app.core.security import TokenError, decode_token

        with pytest.raises(TokenError):
            decode_token(service_auth.issue(service_auth.SIMULATOR_CONTROL), expected_type="access")


class TestCalls:
    async def test_start_is_signed_and_addressed(self, monkeypatch) -> None:
        seen: list[httpx.Request] = []

        def handler(request: httpx.Request) -> httpx.Response:
            seen.append(request)
            return httpx.Response(200, json={"camera_code": "JURY-02", "started": True})

        real = httpx.AsyncClient

        def factory(*args: Any, **kwargs: Any) -> httpx.AsyncClient:
            return real(*args, transport=httpx.MockTransport(handler), **kwargs)

        monkeypatch.setattr(simulator_control.httpx, "AsyncClient", factory)
        monkeypatch.setattr(settings, "simulator_control_url", "http://simulator.test:9100")
        assert await simulator_control.start("jury-02")
        assert str(seen[0].url) == "http://simulator.test:9100/streams/JURY-02/start"
        assert service_auth.verify(
            seen[0].headers[service_auth.HEADER], service_auth.SIMULATOR_CONTROL
        )

    async def test_an_unreachable_simulator_is_logged_not_raised(self, monkeypatch) -> None:
        def handler(request: httpx.Request) -> httpx.Response:
            raise httpx.ConnectError("refused", request=request)

        real = httpx.AsyncClient
        monkeypatch.setattr(
            simulator_control.httpx,
            "AsyncClient",
            lambda *a, **k: real(*a, transport=httpx.MockTransport(handler), **k),
        )
        monkeypatch.setattr(settings, "simulator_control_url", "http://simulator.test:9100")
        assert not await simulator_control.start("JURY-02")
        assert not await simulator_control.stop("JURY-02")

    async def test_disabled_does_nothing(self) -> None:
        # The suite's default (conftest): no URL, no call.
        assert settings.simulator_control_url == ""
        assert not await simulator_control.start("JURY-02")


class TestOnboardingDrivesTheReplay:
    @pytest.fixture
    def calls(self, monkeypatch) -> list[tuple[str, str]]:
        recorded: list[tuple[str, str]] = []

        def recorder(action: str):
            async def _call(code: str) -> bool:
                recorded.append((action, code))
                return True

            return _call

        for action in ("start", "stop", "restart"):
            monkeypatch.setattr(simulator_control, action, recorder(action))
        return recorded

    async def test_recorded_clip_lifecycle(self, client: AsyncClient, auth_headers, calls) -> None:
        admin = await auth_headers("admin")
        code = f"CAM-CLIP-{uuid.uuid4().hex[:6].upper()}"
        created = await client.post(
            "/api/v1/cameras",
            json={
                "camera_code": code,
                "name": "Recorded clip",
                "lat": 23.03,
                "lon": 72.58,
                "source_file": "jury_clip.mp4",
                "anpr_enabled": False,
            },
            headers=admin,
        )
        assert created.status_code == 201, created.text
        camera_id = created.json()["id"]
        assert calls == [("start", code)]

        await client.patch(
            f"/api/v1/cameras/{camera_id}", json={"source_file": "other_clip.mp4"}, headers=admin
        )
        assert calls[-1] == ("restart", code)

        # Switching to a live URL stops the replay before the pull is set up.
        await client.patch(
            f"/api/v1/cameras/{camera_id}",
            json={"source_file": None, "stream_url": "rtsp://10.97.0.1/live"},
            headers=admin,
        )
        assert calls[-1] == ("stop", code)

        await client.patch(
            f"/api/v1/cameras/{camera_id}",
            json={"source_file": "jury_clip.mp4", "stream_url": None},
            headers=admin,
        )
        assert calls[-1] == ("start", code)

        await client.delete(f"/api/v1/cameras/{camera_id}", headers=admin)
        assert calls[-1] == ("stop", code)

    async def test_a_live_url_camera_never_starts_a_replay(
        self, client: AsyncClient, auth_headers, calls
    ) -> None:
        admin = await auth_headers("admin")
        created = await client.post(
            "/api/v1/cameras",
            json={
                "camera_code": f"CAM-LIVE-{uuid.uuid4().hex[:6].upper()}",
                "name": "Live URL and a clip",
                "lat": 23.03,
                "lon": 72.58,
                "stream_url": "rtsp://10.97.0.2/live",
                "source_file": "jury_clip.mp4",
                "anpr_enabled": False,
            },
            headers=admin,
        )
        try:
            assert created.status_code == 201
            assert calls == []
        finally:
            await client.delete(f"/api/v1/cameras/{created.json()['id']}", headers=admin)
