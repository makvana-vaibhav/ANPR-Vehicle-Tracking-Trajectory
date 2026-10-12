"""ONVIF calls carry the camera's login, as a WS-Security digest.

The adapter used to send every SOAP request anonymously, so any device that
requires a login — nearly all of them — refused GetDeviceInformation and
GetStreamUri, and the camera looked unreachable when it was merely asking who we
were.

These tests replay recorded SOAP responses (tests/fixtures/onvif/, in the shape
a Hikvision-firmware camera sends them) through a fake device that checks the
UsernameToken exactly as a camera does: recompute
Base64(SHA-1(nonce + created + password)) with its own copy of the password,
and refuse a `Created` too far from its own clock.
"""

from __future__ import annotations

import base64
import hashlib
from datetime import UTC, datetime, timedelta
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import httpx
import pytest
from defusedxml.ElementTree import fromstring

from app.adapters.base import AdapterError
from app.adapters.onvif import (
    DIGEST_TYPE_URI,
    OnvifAdapter,
    password_digest,
    security_header,
)
from app.core import crypto
from app.services import camera_credentials

FIXTURES = Path(__file__).parent / "fixtures" / "onvif"

WSSE = "{http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-secext-1.0.xsd}"
WSU = "{http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-utility-1.0.xsd}"

USERNAME = "onvif-admin"
PASSWORD = "Cam&Pass<9>"  # XML-special characters on purpose


@pytest.fixture
def ring(monkeypatch: pytest.MonkeyPatch):
    key = base64.b64encode(b"\x07" * 32).decode()
    monkeypatch.setattr(crypto.settings, "encryption_keys", f"t1:{key}")
    monkeypatch.setattr(crypto.settings, "encryption_active_key_id", "t1")
    crypto.reset_cache()
    yield
    crypto.reset_cache()


def fixture(name: str) -> str:
    return (FIXTURES / name).read_text(encoding="utf-8")


class FakeDevice:
    """A camera's ONVIF endpoint, judging logins the way firmware does."""

    def __init__(
        self,
        *,
        password: str = PASSWORD,
        clock_offset: timedelta = timedelta(0),
        tolerance_s: float = 5.0,
    ) -> None:
        self.password = password
        self.clock_offset = clock_offset
        self.tolerance_s = tolerance_s
        self.requests: list[str] = []
        self.accepted = 0

    def now(self) -> datetime:
        return datetime.now(UTC) + self.clock_offset

    def _authorised(self, root: Any) -> bool:
        token = root.find(f".//{WSSE}UsernameToken")
        if token is None:
            return False
        username = token.findtext(f"{WSSE}Username")
        password = token.find(f"{WSSE}Password")
        nonce = token.findtext(f"{WSSE}Nonce")
        created = token.findtext(f"{WSU}Created")
        if None in (username, password, nonce, created) or username != USERNAME:
            return False
        if password.get("Type") != DIGEST_TYPE_URI:
            return False
        stamp = datetime.strptime(created, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=UTC)
        if abs((stamp - self.now()).total_seconds()) > self.tolerance_s:
            return False
        expected = base64.b64encode(
            hashlib.sha1(  # noqa: S324 - the profile's own construction
                base64.b64decode(nonce) + created.encode() + self.password.encode()
            ).digest()
        ).decode()
        return password.text == expected

    def handler(self, request: httpx.Request) -> httpx.Response:
        body = request.content.decode()
        self.requests.append(body)
        root = fromstring(body)
        if "GetSystemDateAndTime" in body:
            # ONVIF lets anyone ask the time; it is how a client fixes skew.
            now = self.now()
            return httpx.Response(
                200,
                text=fixture("get_system_date_and_time.xml").format(
                    year=now.year,
                    month=now.month,
                    day=now.day,
                    hour=now.hour,
                    minute=now.minute,
                    second=now.second,
                ),
            )
        if not self._authorised(root):
            return httpx.Response(400, text=fixture("fault_not_authorized.xml"))
        self.accepted += 1
        if "GetDeviceInformation" in body:
            return httpx.Response(200, text=fixture("get_device_information.xml"))
        if "GetProfiles" in body:
            return httpx.Response(200, text=fixture("get_profiles.xml"))
        if "GetStreamUri" in body:
            return httpx.Response(200, text=fixture("get_stream_uri.xml"))
        return httpx.Response(500, text="unexpected")


def adapter_for(device: FakeDevice, *, vms_ref: str | None = None) -> OnvifAdapter:
    adapter = OnvifAdapter(name="onvif-test", credentials_ref=vms_ref)
    adapter.transport = httpx.MockTransport(device.handler)
    return adapter


def camera(ref: str | None) -> SimpleNamespace:
    return SimpleNamespace(
        camera_code="ONVIF-01",
        stream_url="rtsp://10.20.30.40:554/Streaming/Channels/101",
        sub_stream_url=None,
        credentials_ref=ref,
    )


class TestDigest:
    def test_digest_is_the_username_token_profile_construction(self) -> None:
        nonce = bytes(range(16))
        created = "2026-10-12T06:10:00Z"
        expected = base64.b64encode(
            hashlib.sha1(nonce + created.encode() + b"secret").digest()  # noqa: S324
        ).decode()
        assert password_digest(nonce, created, "secret") == expected

    def test_header_never_carries_the_password(self) -> None:
        header = security_header(USERNAME, PASSWORD)
        assert PASSWORD not in header
        assert "Cam&amp;Pass" not in header
        assert DIGEST_TYPE_URI in header

    def test_username_is_xml_escaped(self) -> None:
        header = security_header("a<b&c", "x")
        assert "<wsse:Username>a&lt;b&amp;c</wsse:Username>" in header

    def test_every_header_has_a_fresh_nonce(self) -> None:
        assert security_header(USERNAME, PASSWORD) != security_header(USERNAME, PASSWORD)


@pytest.mark.usefixtures("ring")
class TestAgainstARecordedDevice:
    async def test_device_information_with_the_cameras_login(self) -> None:
        device = FakeDevice()
        cam = camera(camera_credentials.seal(USERNAME, PASSWORD))
        info = await adapter_for(device).get_device_information(cam)
        assert info["Manufacturer"] == "HIKVISION"
        assert info["Model"] == "DS-2CD2043G2-I"
        assert device.accepted == 1
        assert all(PASSWORD not in body for body in device.requests)

    async def test_stream_uri_with_the_cameras_login(self) -> None:
        device = FakeDevice()
        cam = camera(camera_credentials.seal(USERNAME, PASSWORD))
        uri = await adapter_for(device).get_stream_uri("Profile_2", cam)
        assert uri == (
            "rtsp://10.20.30.40:554/Streaming/Channels/102?transportmode=unicast&profile=Profile_2"
        )

    async def test_profiles_with_the_cameras_login(self) -> None:
        device = FakeDevice()
        cam = camera(camera_credentials.seal(USERNAME, PASSWORD))
        profiles = await adapter_for(device).get_profiles(cam)
        assert [p["token"] for p in profiles] == ["Profile_1", "Profile_2"]
        assert profiles[1]["width"] == 640

    async def test_a_skewed_device_clock_is_learnt_and_the_call_retried(self) -> None:
        # An NVR that has never seen NTP, an hour and a bit ahead.
        device = FakeDevice(clock_offset=timedelta(hours=1, minutes=7))
        cam = camera(camera_credentials.seal(USERNAME, PASSWORD))
        info = await adapter_for(device).get_device_information(cam)
        assert info["SerialNumber"].startswith("DS-2CD2043G2-I")
        # Refused once, asked the time, accepted on the retry.
        kinds = ["time" if "GetSystemDateAndTime" in b else "info" for b in device.requests]
        assert kinds == ["info", "time", "info"]

    async def test_a_wrong_password_is_reported_as_a_refused_login(self) -> None:
        device = FakeDevice(password="the-real-one")
        cam = camera(camera_credentials.seal(USERNAME, PASSWORD))
        with pytest.raises(AdapterError, match="refused the login"):
            await adapter_for(device).get_device_information(cam)

    async def test_probe_reports_unauthorized_not_unreachable(self) -> None:
        device = FakeDevice(password="the-real-one")
        cam = camera(camera_credentials.seal(USERNAME, PASSWORD))
        probe = await adapter_for(device).probe_health(cam)
        assert probe.error_code == "unauthorized"
        assert PASSWORD not in (probe.detail or "")

    async def test_no_login_stored_says_so(self) -> None:
        device = FakeDevice()
        with pytest.raises(AdapterError, match="requires a login and none is stored"):
            await adapter_for(device).get_device_information(camera(None))

    async def test_the_cameras_login_wins_over_the_vms_login(self, monkeypatch) -> None:
        monkeypatch.setenv("ONVIF_T_USER", "someone-else")
        monkeypatch.setenv("ONVIF_T_PASS", "nope")
        device = FakeDevice()
        cam = camera(camera_credentials.seal(USERNAME, PASSWORD))
        adapter = adapter_for(device, vms_ref="env://ONVIF_T_USER:ONVIF_T_PASS")
        assert (await adapter.get_device_information(cam))["Manufacturer"] == "HIKVISION"

    async def test_a_vms_level_login_signs_discovery(self, monkeypatch) -> None:
        monkeypatch.setenv("ONVIF_T_USER", USERNAME)
        monkeypatch.setenv("ONVIF_T_PASS", PASSWORD)
        device = FakeDevice()
        adapter = adapter_for(device, vms_ref="env://ONVIF_T_USER:ONVIF_T_PASS")
        adapter.base_url = "http://10.20.30.40"
        found = await adapter.list_cameras()
        assert [c.stream_url for c in found][1].endswith("profile=Profile_2")

    async def test_a_profile_token_cannot_inject_xml(self) -> None:
        device = FakeDevice()
        cam = camera(camera_credentials.seal(USERNAME, PASSWORD))
        await adapter_for(device).get_stream_uri("P</trt:ProfileToken><x>", cam)
        assert "P&lt;/trt:ProfileToken&gt;&lt;x&gt;" in device.requests[-1]
