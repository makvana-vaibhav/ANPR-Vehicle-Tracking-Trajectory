"""The stream gateway asks the API about every publish and read (review item S3).

MediaMTX used to grant `read` to any address, so our own cameras (CAM-DEMO-01,
CAM-DEMO-02) played for anyone who could reach :8888 — the camera-scoped,
audited stream token was simply never asked for. Now MediaMTX runs with
`authMethod: http` and obeys `/internal/mediamtx/auth`. These tests pin what
that callback allows, and that the stream grant hands the browser a URL that
carries its token.
"""

from __future__ import annotations

import uuid
from collections.abc import Iterator
from datetime import timedelta

import pytest
from httpx import AsyncClient

from app.core import security
from app.core.config import settings
from app.core.security import create_access_token, create_stream_token
from app.routers.gateway_auth import AUTH_PATH, GatewayAuthRequest, authorise

PUBLISH_PW = "test-publish-" + uuid.uuid4().hex
READ_PW = "test-read-" + uuid.uuid4().hex
PATH = "cam-demo-01"


@pytest.fixture(autouse=True)
def gateway_identities() -> Iterator[None]:
    original = (settings.mediamtx_publish_password, settings.mediamtx_read_password)
    settings.mediamtx_publish_password, settings.mediamtx_read_password = PUBLISH_PW, READ_PW
    try:
        yield
    finally:
        settings.mediamtx_publish_password, settings.mediamtx_read_password = original


def token_for(path: str | None = PATH) -> str:
    return create_stream_token(
        user_id=uuid.uuid4(), camera_id=uuid.uuid4(), username="operator", gateway_path=path
    )


def ask(**fields: str) -> bool:
    return authorise(GatewayAuthRequest(**fields))[0]


class TestPublishing:
    def test_the_simulator_may_publish(self) -> None:
        assert ask(
            action="publish",
            path=PATH,
            protocol="rtsp",
            user=settings.mediamtx_publish_user,
            password=PUBLISH_PW,
        )

    def test_nobody_else_may_replace_a_feed(self) -> None:
        assert not ask(action="publish", path=PATH, protocol="rtsp")
        assert not ask(
            action="publish",
            path=PATH,
            protocol="rtsp",
            user=settings.mediamtx_read_user,
            password=READ_PW,
        )
        assert not ask(
            action="publish",
            path=PATH,
            protocol="rtsp",
            user=settings.mediamtx_publish_user,
            password="guess",
        )
        # A viewing token is for viewing.
        assert not ask(action="publish", path=PATH, protocol="webrtc", query=f"token={token_for()}")


class TestReading:
    def test_an_anonymous_read_is_refused_on_every_protocol(self) -> None:
        for protocol in ("rtsp", "hls", "webrtc"):
            assert not ask(action="read", path=PATH, protocol=protocol)

    def test_the_workers_read_with_their_own_identity(self) -> None:
        assert ask(
            action="read",
            path=PATH,
            protocol="rtsp",
            user=settings.mediamtx_read_user,
            password=READ_PW,
        )
        assert not ask(
            action="read",
            path=PATH,
            protocol="rtsp",
            user=settings.mediamtx_publish_user,
            password=PUBLISH_PW,
        )

    def test_a_browser_reads_with_the_token_for_that_camera(self) -> None:
        for protocol in ("hls", "webrtc"):
            assert ask(action="read", path=PATH, protocol=protocol, query=f"token={token_for()}")

    def test_a_token_opens_no_other_camera(self) -> None:
        assert not ask(
            action="read", path="cam-demo-02", protocol="hls", query=f"token={token_for(PATH)}"
        )
        # A token minted without a path (a federated camera's) opens nothing here.
        assert not ask(action="read", path=PATH, protocol="hls", query=f"token={token_for(None)}")

    def test_tokens_are_for_browsers_not_rtsp(self) -> None:
        assert not ask(action="read", path=PATH, protocol="rtsp", query=f"token={token_for()}")

    def test_an_expired_or_foreign_token_is_refused(self) -> None:
        expired = security._encode(
            security._base_claims(str(uuid.uuid4()), "stream", timedelta(seconds=-5))
            | {"camera_id": str(uuid.uuid4()), "username": "operator", "path": PATH}
        )
        assert not ask(action="read", path=PATH, protocol="hls", query=f"token={expired}")

        access = create_access_token(
            user_id=uuid.uuid4(), username="operator", role="operator", department_id=None
        )
        assert not ask(action="read", path=PATH, protocol="hls", query=f"token={access}")
        assert not ask(action="read", path=PATH, protocol="hls", query="token=not-a-jwt")


class TestFailsClosed:
    def test_unset_identities_match_nothing(self) -> None:
        settings.mediamtx_publish_password = ""
        settings.mediamtx_read_password = ""
        assert not ask(
            action="publish",
            path=PATH,
            protocol="rtsp",
            user=settings.mediamtx_publish_user,
            password="",
        )
        assert not ask(
            action="read", path=PATH, protocol="rtsp", user=settings.mediamtx_read_user, password=""
        )

    def test_nothing_else_is_granted(self) -> None:
        for action in ("playback", "api", "metrics", "pprof", ""):
            assert not ask(
                action=action,
                path=PATH,
                protocol="rtsp",
                user=settings.mediamtx_read_user,
                password=READ_PW,
            )


class TestTheCallback:
    async def test_answers_mediamtx_over_http(self, client: AsyncClient) -> None:
        allowed = await client.post(
            AUTH_PATH,
            json={
                "action": "read",
                "path": PATH,
                "protocol": "webrtc",
                "query": f"token={token_for()}",
                "ip": "172.31.0.1",
            },
        )
        refused = await client.post(
            AUTH_PATH, json={"action": "read", "path": PATH, "protocol": "hls", "query": ""}
        )
        assert allowed.status_code == 204
        assert refused.status_code == 401


@pytest.mark.integration
class TestTheGrantCarriesTheToken:
    async def test_own_camera_urls_carry_a_token_scoped_to_their_path(
        self, client: AsyncClient, auth_headers
    ) -> None:
        from sqlalchemy import select

        from app.db.session import SessionLocal
        from app.models.registry import Camera

        async with SessionLocal() as session:
            camera_id = await session.scalar(
                select(Camera.id).where(Camera.camera_code == "CAM-DEMO-01")
            )
        if camera_id is None:
            pytest.skip("CAM-DEMO-01 is not seeded")

        headers = await auth_headers("operator")
        grant = (await client.get(f"/api/v1/cameras/{camera_id}/stream", headers=headers)).json()

        for key in ("whep_url", "hls_url"):
            url = grant[key]
            assert url and f"token={grant['token']}" in url, f"{key} carries no token: {url}"
        payload = security.decode_token(grant["token"], expected_type="stream")
        assert payload.gateway_path == "cam-demo-01"
        assert ask(
            action="read",
            path="cam-demo-01",
            protocol="hls",
            query=grant["hls_url"].split("?", 1)[1],
        )
