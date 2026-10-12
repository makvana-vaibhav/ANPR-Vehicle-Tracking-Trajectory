"""A camera's own login: accepted at onboarding, never stored or shown in clear.

The jury's likeliest test of "integrate a new camera" is an NVR URL with a
password in it. These tests hold the line on every place that password could
escape — the response, the registry row, the audit trail, the logs, a 422 echo,
a health probe's error text — and check it still reaches the one place that
needs it: the gateway's pull from the camera.
"""

from __future__ import annotations

import base64
import io
import json
import uuid
from types import SimpleNamespace
from typing import Any

import httpx
import pytest
from httpx import AsyncClient
from sqlalchemy import select, text

from app.adapters.rtsp import RtspAdapter
from app.core import crypto
from app.core.urls import redact_text, split_credentials, with_credentials
from app.db.session import SessionLocal
from app.models.registry import Camera
from app.models.security import AuditLog
from app.schemas.camera import CameraCreate, CameraUpdate
from app.services import camera_credentials, gateway
from app.services.secrets import resolve_credentials

USER = "jury-admin"
PASSWORD = "Pa:ss@w0rd/#?"  # every character that breaks a naive URL split
URL = "rtsp://10.99.0.7:554/Streaming/Channels/101"
QUOTED = "rtsp://jury-admin:Pa%3Ass%40w0rd%2F%23%3F@10.99.0.7:554/Streaming/Channels/101"


@pytest.fixture
def ring(monkeypatch: pytest.MonkeyPatch):
    key = base64.b64encode(b"\x11" * 32).decode()
    monkeypatch.setattr(crypto.settings, "encryption_keys", f"t1:{key}")
    monkeypatch.setattr(crypto.settings, "encryption_active_key_id", "t1")
    crypto.reset_cache()
    yield
    crypto.reset_cache()


@pytest.fixture
def no_ring(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setattr(crypto.settings, "encryption_keys", "")
    monkeypatch.setattr(crypto.settings, "encryption_active_key_id", "")
    crypto.reset_cache()
    yield
    crypto.reset_cache()


def code() -> str:
    return f"CAM-LOGIN-{uuid.uuid4().hex[:6].upper()}"


def body(camera_code: str, **extra: Any) -> dict[str, Any]:
    return {
        "camera_code": camera_code,
        "name": "Login test camera",
        "lat": 23.03,
        "lon": 72.58,
        "anpr_enabled": False,
        **extra,
    }


async def row(camera_code: str) -> Camera:
    async with SessionLocal() as session:
        found = await session.scalar(select(Camera).where(Camera.camera_code == camera_code))
    assert found is not None
    return found


async def raw_row_text(camera_code: str) -> str:
    """The whole row as Postgres renders it — what a database dump would hold."""
    async with SessionLocal() as session:
        value = await session.scalar(
            text("SELECT row_to_json(c)::text FROM cameras c WHERE camera_code = :code"),
            {"code": camera_code},
        )
    return str(value)


# ── URL helpers ────────────────────────────────────────────────────────


class TestUrlHelpers:
    def test_split_decodes_and_keeps_the_rest_verbatim(self) -> None:
        clean, user, password = split_credentials(QUOTED)
        assert (clean, user, password) == (URL, USER, PASSWORD)

    def test_split_handles_an_unencoded_at_in_the_password(self) -> None:
        clean, user, password = split_credentials("rtsp://admin:p@ss@10.0.0.5/live")
        assert (clean, user, password) == ("rtsp://10.0.0.5/live", "admin", "p@ss")

    def test_split_leaves_a_clean_url_alone(self) -> None:
        assert split_credentials(URL) == (URL, None, None)

    def test_with_credentials_round_trips(self) -> None:
        assert with_credentials(URL, USER, PASSWORD) == QUOTED
        assert split_credentials(with_credentials(URL, USER, PASSWORD))[1:] == (USER, PASSWORD)

    def test_with_credentials_never_doubles_a_login(self) -> None:
        assert with_credentials(QUOTED, "other", "x") == QUOTED

    def test_redact_text_masks_a_url_inside_an_error_line(self) -> None:
        line = f"{with_credentials(URL, 'admin', 'hunter2')}: Server returned 401 Unauthorized"
        masked = redact_text(line)
        assert "hunter2" not in masked
        assert "10.99.0.7:554/Streaming/Channels/101" in masked


# ── Schema ─────────────────────────────────────────────────────────────


class TestSchema:
    def test_a_pasted_url_is_split_into_url_and_login(self) -> None:
        payload = CameraCreate(**body("CAM-SCHEMA-01", stream_url=QUOTED))
        assert payload.stream_url == URL
        assert payload.stream_username == USER
        assert payload.stream_password is not None
        assert payload.stream_password.get_secret_value() == PASSWORD
        # And never shown by the model itself.
        assert PASSWORD not in repr(payload)

    def test_the_same_login_twice_is_accepted(self) -> None:
        payload = CameraCreate(
            **body(
                "CAM-SCHEMA-02",
                stream_url=QUOTED,
                stream_username=USER,
                stream_password=PASSWORD,
            )
        )
        assert payload.stream_url == URL

    def test_two_different_logins_are_refused(self) -> None:
        with pytest.raises(ValueError, match="different login"):
            CameraCreate(**body("CAM-SCHEMA-03", stream_url=QUOTED, stream_username="other"))

    def test_a_password_without_a_username_is_refused(self) -> None:
        with pytest.raises(ValueError, match="needs a stream_username"):
            CameraCreate(**body("CAM-SCHEMA-04", stream_url=URL, stream_password="x"))

    def test_a_username_with_a_colon_is_refused(self) -> None:
        with pytest.raises(ValueError, match="may not contain ':'"):
            CameraCreate(**body("CAM-SCHEMA-05", stream_username="a:b", stream_password="x"))

    def test_an_edit_splits_a_pasted_url_too(self) -> None:
        # The update path used to store `rtsp://user:pass@…` as typed.
        update = CameraUpdate(stream_url=QUOTED)
        assert update.stream_url == URL
        assert update.stream_username == USER
        assert update.login_changed


# ── API ────────────────────────────────────────────────────────────────


@pytest.mark.usefixtures("ring")
class TestOnboardingWithALogin:
    async def test_the_password_never_appears_in_responses_or_the_row(
        self, client: AsyncClient, auth_headers, capfd
    ) -> None:
        admin = await auth_headers("admin")
        camera_code = code()
        created = await client.post(
            "/api/v1/cameras",
            json=body(camera_code, stream_url=URL, stream_username=USER, stream_password=PASSWORD),
            headers=admin,
        )
        try:
            assert created.status_code == 201, created.text
            out = created.json()
            assert out["has_credentials"] is True
            assert out["has_stream"] is True

            listed = await client.get(f"/api/v1/cameras?search={camera_code}", headers=admin)
            one = await client.get(f"/api/v1/cameras/{out['id']}", headers=admin)
            for response in (created, listed, one):
                assert PASSWORD not in response.text
                assert "Pa%3Ass" not in response.text
                assert USER not in response.text
                assert "credentials_ref" not in response.text
                assert "enc://" not in response.text

            stored = await row(camera_code)
            assert stored.stream_url == URL
            assert stored.credentials_ref is not None
            assert stored.credentials_ref.startswith("enc://")
            dump = await raw_row_text(camera_code)
            assert PASSWORD not in dump
            assert USER not in dump
            # It opens again, with the camera context and only that context.
            login = camera_credentials.resolve(stored.credentials_ref)
            assert login is not None
            assert (login.username, login.password) == (USER, PASSWORD)
            assert resolve_credentials(stored.credentials_ref) is None

            captured = capfd.readouterr()
            assert PASSWORD not in captured.out + captured.err
        finally:
            await client.delete(f"/api/v1/cameras/{created.json()['id']}", headers=admin)

    async def test_a_pasted_credentialed_url_is_split_and_sealed(
        self, client: AsyncClient, auth_headers
    ) -> None:
        admin = await auth_headers("admin")
        camera_code = code()
        created = await client.post(
            "/api/v1/cameras", json=body(camera_code, stream_url=QUOTED), headers=admin
        )
        try:
            assert created.status_code == 201, created.text
            assert created.json()["has_credentials"] is True
            assert "Pa%3Ass" not in created.text
            stored = await row(camera_code)
            assert stored.stream_url == URL
            assert "@" not in (stored.stream_url or "")
            assert "Pa%3Ass" not in await raw_row_text(camera_code)
        finally:
            await client.delete(f"/api/v1/cameras/{created.json()['id']}", headers=admin)

    async def test_the_audit_row_says_a_login_was_set_and_nothing_more(
        self, client: AsyncClient, auth_headers
    ) -> None:
        admin = await auth_headers("admin")
        camera_code = code()
        created = await client.post(
            "/api/v1/cameras", json=body(camera_code, stream_url=QUOTED), headers=admin
        )
        camera_id = created.json()["id"]
        try:
            changed = await client.patch(
                f"/api/v1/cameras/{camera_id}",
                json={"stream_password": "N3w-Secret"},
                headers=admin,
            )
            # A password alone has no username to go with; refused.
            assert changed.status_code == 422
            assert "N3w-Secret" not in changed.text
            changed = await client.patch(
                f"/api/v1/cameras/{camera_id}",
                json={"stream_username": USER, "stream_password": "N3w-Secret"},
                headers=admin,
            )
            assert changed.status_code == 200, changed.text
            async with SessionLocal() as session:
                rows = (
                    await session.scalars(select(AuditLog).where(AuditLog.resource_id == camera_id))
                ).all()
            # The handler's rows, not the middleware's generic request rows.
            explicit = [r for r in rows if r.params and "camera_code" in r.params]
            create = next(r for r in explicit if r.action == "camera.create")
            update = next(r for r in explicit if r.action == "camera.update")
            assert create.params["login_stored"] is True
            assert "login" in update.params["fields"]
            everything = json.dumps([r.params for r in rows], default=str)
            for secret in (PASSWORD, "Pa%3Ass", "N3w-Secret"):
                assert secret not in everything
        finally:
            await client.delete(f"/api/v1/cameras/{camera_id}", headers=admin)

    async def test_editing_the_login(self, client: AsyncClient, auth_headers) -> None:
        admin = await auth_headers("admin")
        camera_code = code()
        created = await client.post(
            "/api/v1/cameras", json=body(camera_code, stream_url=QUOTED), headers=admin
        )
        camera_id = created.json()["id"]
        try:
            # A new username alone keeps the stored password.
            await client.patch(
                f"/api/v1/cameras/{camera_id}", json={"stream_username": "ops"}, headers=admin
            )
            login = camera_credentials.resolve((await row(camera_code)).credentials_ref)
            assert login is not None and (login.username, login.password) == ("ops", PASSWORD)

            # Editing something else leaves the login alone.
            await client.patch(
                f"/api/v1/cameras/{camera_id}", json={"name": "Renamed"}, headers=admin
            )
            assert (await row(camera_code)).credentials_ref is not None

            cleared = await client.patch(
                f"/api/v1/cameras/{camera_id}", json={"clear_credentials": True}, headers=admin
            )
            assert cleared.json()["has_credentials"] is False
            assert (await row(camera_code)).credentials_ref is None
        finally:
            await client.delete(f"/api/v1/cameras/{camera_id}", headers=admin)

    async def test_a_422_never_echoes_the_password(self, client: AsyncClient, auth_headers) -> None:
        # Outside Gujarat: refused by a model-level validator, whose default
        # 422 would carry the whole body — password included — as `input`.
        admin = await auth_headers("admin")
        outside = {"lat": 51.5, "lon": -0.12}
        for extra in (
            {"stream_url": QUOTED},
            {"stream_url": URL, "stream_username": USER, "stream_password": PASSWORD},
        ):
            response = await client.post(
                "/api/v1/cameras", json={**body(code(), **extra), **outside}, headers=admin
            )
            assert response.status_code == 422
            assert "outside Gujarat" in response.text
            assert PASSWORD not in response.text
            assert "Pa%3Ass" not in response.text

    async def test_bulk_csv_columns_seal_the_login(self, client: AsyncClient, auth_headers) -> None:
        admin = await auth_headers("admin")
        camera_code = code()
        csv = (
            "camera_code,name,lat,lon,stream_url,stream_username,stream_password\n"
            f"{camera_code},Bulk login,23.04,72.57,{URL},{USER},csvSecret!\n"
        ).encode()
        response = await client.post(
            "/api/v1/cameras/bulk",
            files={"file": ("estate.csv", io.BytesIO(csv), "text/csv")},
            headers=admin,
        )
        try:
            assert response.status_code == 200, response.text
            assert response.json()["created"] == 1
            assert "csvSecret" not in response.text
            login = camera_credentials.resolve((await row(camera_code)).credentials_ref)
            assert login is not None and login.password == "csvSecret!"
        finally:
            stored = await row(camera_code)
            await client.delete(f"/api/v1/cameras/{stored.id}", headers=admin)


@pytest.mark.usefixtures("no_ring")
class TestWithoutAKeyRing:
    async def test_a_login_is_refused_rather_than_stored_in_clear(
        self, client: AsyncClient, auth_headers
    ) -> None:
        camera_code = code()
        response = await client.post(
            "/api/v1/cameras",
            json=body(camera_code, stream_url=URL, stream_username=USER, stream_password=PASSWORD),
            headers=await auth_headers("admin"),
        )
        assert response.status_code == 422
        assert "ENCRYPTION_KEYS" in response.text
        assert PASSWORD not in response.text
        async with SessionLocal() as session:
            assert (
                await session.scalar(select(Camera).where(Camera.camera_code == camera_code))
            ) is None

    async def test_a_dry_run_says_so_too(self, client: AsyncClient, auth_headers) -> None:
        csv = (
            "camera_code,name,lat,lon,stream_url\n" f"{code()},Dry run,23.04,72.57,{QUOTED}\n"
        ).encode()
        response = await client.post(
            "/api/v1/cameras/bulk?dry_run=true",
            files={"file": ("estate.csv", io.BytesIO(csv), "text/csv")},
            headers=await auth_headers("admin"),
        )
        assert response.json()["failed"] == 1
        assert "cannot be stored" in response.text
        assert "Pa%3Ass" not in response.text


# ── Where it is opened ─────────────────────────────────────────────────


@pytest.mark.usefixtures("ring")
class TestWhereTheLoginIsUsed:
    async def test_the_gateway_pull_carries_it_and_the_log_does_not(
        self, monkeypatch, capfd
    ) -> None:
        sent: list[dict[str, Any]] = []

        def handler(request: httpx.Request) -> httpx.Response:
            sent.append(json.loads(request.content))
            return httpx.Response(200)

        real = httpx.AsyncClient

        def client_factory(*args: Any, **kwargs: Any) -> httpx.AsyncClient:
            return real(*args, transport=httpx.MockTransport(handler), **kwargs)

        monkeypatch.setattr(gateway.httpx, "AsyncClient", client_factory)
        cam = SimpleNamespace(
            camera_code="CAM-GW-01",
            stream_url=URL,
            credentials_ref=camera_credentials.seal(USER, PASSWORD),
        )
        assert await gateway.register(cam)
        assert sent[0]["source"] == QUOTED
        captured = capfd.readouterr()
        assert PASSWORD not in captured.out + captured.err
        assert "Pa%3Ass" not in captured.out + captured.err

    async def test_the_health_probe_uses_it_and_redacts_ffprobes_echo(self, monkeypatch) -> None:
        seen: list[str] = []

        class FakeProcess:
            returncode = 1

            async def communicate(self) -> tuple[bytes, bytes]:
                return b"", f"{seen[-1]}: Server returned 401 Unauthorized\n".encode()

        async def fake_exec(*command: str, **_kwargs: Any) -> FakeProcess:
            seen.append(command[-1])
            return FakeProcess()

        monkeypatch.setattr(RtspAdapter, "ffprobe_available", staticmethod(lambda: True))
        monkeypatch.setattr("app.adapters.rtsp.asyncio.create_subprocess_exec", fake_exec)
        cam = SimpleNamespace(
            camera_code="CAM-PROBE-01",
            stream_url=URL,
            sub_stream_url=None,
            credentials_ref=camera_credentials.seal(USER, PASSWORD),
        )
        probe = await RtspAdapter().probe_health(cam)
        assert seen == [QUOTED]
        assert probe.error_code == "unauthorized"
        assert probe.detail is not None
        assert "Pa%3Ass" not in probe.detail and PASSWORD not in probe.detail
        assert "10.99.0.7:554" in probe.detail

    async def test_a_camera_token_cannot_be_opened_as_a_vms_credential(self) -> None:
        sealed = camera_credentials.seal(USER, PASSWORD)
        assert resolve_credentials(sealed) is None
        vms_sealed = "enc://" + crypto.encrypt(f"{USER}:{PASSWORD}", context="vms-credentials")
        assert camera_credentials.resolve(vms_sealed) is None

    async def test_the_roster_never_carries_the_login(self, client, auth_headers) -> None:
        from app.services.fleet_roster import build_roster

        admin = await auth_headers("admin")
        camera_code = code()
        created = await client.post(
            "/api/v1/cameras",
            json={**body(camera_code, stream_url=QUOTED), "anpr_enabled": True},
            headers=admin,
        )
        try:
            entry = next(e for e in await build_roster() if e["camera_code"] == camera_code)
            serialised = json.dumps(entry)
            assert "Pa%3Ass" not in serialised and USER not in serialised
            # The worker reads the camera from our gateway, never from the camera.
            assert entry["rtsp_url"].endswith(f"/{camera_code.lower()}")
        finally:
            await client.delete(f"/api/v1/cameras/{created.json()['id']}", headers=admin)


@pytest.mark.usefixtures("ring")
class TestFirstProbe:
    async def test_a_new_camera_is_probed_with_its_login_straight_away(
        self, client: AsyncClient, auth_headers, monkeypatch
    ) -> None:
        """Its status is known in seconds, not at the monitor's next sweep."""
        from app.adapters.base import HealthProbe
        from app.core.config import settings
        from app.services import health_monitor

        seen: list[str | None] = []

        async def fake_probe(session: Any, camera: Any, *, record: bool = True) -> HealthProbe:
            seen.append(camera_credentials.camera_source_url(camera))
            return HealthProbe(reachable=True, latency_ms=40, fps_actual=25.0)

        monkeypatch.setattr(settings, "probe_on_onboard", True)
        monkeypatch.setattr(health_monitor, "probe_camera", fake_probe)
        admin = await auth_headers("admin")
        created = await client.post(
            "/api/v1/cameras", json=body(code(), stream_url=QUOTED), headers=admin
        )
        try:
            assert created.status_code == 201
            assert created.json()["status"] == "unknown"
            # The probe ran after the response, with the login put back.
            assert seen == [QUOTED]
            after = await client.get(f"/api/v1/cameras/{created.json()['id']}", headers=admin)
            assert after.json()["status"] == "online"
        finally:
            await client.delete(f"/api/v1/cameras/{created.json()['id']}", headers=admin)


class TestRecordedClipHealth:
    async def test_a_recorded_clip_is_probed_on_our_gateway(self, monkeypatch) -> None:
        """No URL of its own: its gateway path is what plays, so that is probed."""
        from app.core.config import settings

        seen: list[str] = []

        class FakeProcess:
            returncode = 0

            async def communicate(self) -> tuple[bytes, bytes]:
                return (
                    b'{"streams":[{"codec_name":"h264","width":1280,"height":720,'
                    b'"avg_frame_rate":"15/1"}]}',
                    b"",
                )

        async def fake_exec(*command: str, **_kwargs: Any) -> FakeProcess:
            seen.append(command[-1])
            return FakeProcess()

        monkeypatch.setattr(RtspAdapter, "ffprobe_available", staticmethod(lambda: True))
        monkeypatch.setattr("app.adapters.rtsp.asyncio.create_subprocess_exec", fake_exec)
        monkeypatch.setattr(settings, "mediamtx_read_user", "contrail-reader")
        monkeypatch.setattr(settings, "mediamtx_read_password", "r3ader/pw")
        cam = SimpleNamespace(
            camera_code="JURY-02",
            stream_url=None,
            sub_stream_url=None,
            source_file="clip.mp4",
            credentials_ref=None,
        )
        probe = await RtspAdapter().probe_health(cam)
        assert probe.reachable and probe.status.value == "online"
        assert seen == [
            f"rtsp://contrail-reader:r3ader%2Fpw@{settings.mediamtx_host}:"
            f"{settings.mediamtx_rtsp_port}/jury-02"
        ]

    async def test_no_url_and_no_clip_is_still_reported_as_such(self) -> None:
        cam = SimpleNamespace(camera_code="X", stream_url=None, sub_stream_url=None)
        assert (await RtspAdapter().probe_health(cam)).error_code == "no_stream_url"
