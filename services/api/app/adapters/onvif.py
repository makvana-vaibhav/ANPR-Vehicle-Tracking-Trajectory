"""ONVIF integration.

ONVIF is the interoperability standard most professional IP cameras implement,
and it is what makes vendor-neutral onboarding possible: a device tells you its
own capabilities, profiles and stream URIs instead of you knowing them in
advance.

Implemented directly over SOAP with httpx rather than pulling in a heavyweight
ONVIF client. We use four operations — GetDeviceInformation, GetProfiles,
GetStreamUri and (unauthenticated) GetSystemDateAndTime — and hand-rolling them
keeps the runtime image small and avoids a dependency that would need auditing
for a government deployment.

## Logging in

Almost every ONVIF device refuses GetDeviceInformation, GetProfiles and
GetStreamUri to an anonymous caller. The ONVIF Core Specification (§5.12)
requires devices to accept a **WS-Security UsernameToken with a password
digest**, so every call carries one when a login is known:

    PasswordDigest = Base64( SHA-1( nonce + created + password ) )

with a fresh 16-byte nonce and the creation time in UTC, so a captured request
cannot be replayed once its timestamp ages out on the device, and the password
itself never crosses the wire. The login is the camera's own (sealed in
`cameras.credentials_ref`) or, for a VMS-level ONVIF instance, the VMS row's.

Two real-world wrinkles are handled rather than left to fail:

* **Clock skew.** Devices reject a digest whose `Created` is far from their own
  clock, and NVRs that have never seen NTP are common. When a signed call is
  refused, the adapter asks the device its time (GetSystemDateAndTime, which
  ONVIF lets anyone call), corrects `Created` by the difference, and retries
  once.
* **HTTP Digest instead of WS-Security.** Some firmware authenticates at the
  HTTP layer. httpx's `DigestAuth` answers such a challenge with the same
  login; on a device that does not challenge it sends nothing extra.
"""

from __future__ import annotations

import base64
import hashlib
import os
import time
from datetime import UTC, datetime, timedelta
from typing import Any
from urllib.parse import urlparse
from xml.etree.ElementTree import Element, ParseError
from xml.sax.saxutils import escape

import httpx

# ONVIF responses come from devices on the camera VLAN, which is untrusted
# input: a compromised or spoofed camera could answer with an entity-expansion
# bomb. defusedxml refuses those; the stdlib parser does not.
from defusedxml.ElementTree import fromstring as safe_fromstring

from app.adapters.base import (
    AdapterError,
    CameraAdapter,
    DiscoveredCamera,
    HealthProbe,
    StreamEndpoints,
)
from app.adapters.rtsp import RtspAdapter
from app.core.config import settings
from app.services.camera_credentials import camera_login
from app.services.secrets import Credentials, resolve_credentials

_NS = {
    "s": "http://www.w3.org/2003/05/soap-envelope",
    "tds": "http://www.onvif.org/ver10/device/wsdl",
    "trt": "http://www.onvif.org/ver10/media/wsdl",
    "tt": "http://www.onvif.org/ver10/schema",
}

_SOAP_HEADERS = {"Content-Type": "application/soap+xml; charset=utf-8"}

WSSE_NS = "http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-secext-1.0.xsd"
WSU_NS = "http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-utility-1.0.xsd"
#: The WS-Security type URI naming a digest password (not a credential).
DIGEST_TYPE_URI = (
    "http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-username-token-profile-1.0"
    "#PasswordDigest"
)
NONCE_ENCODING = (
    "http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-soap-message-security-1.0"
    "#Base64Binary"
)

#: Words a device uses when it refuses a login: the ONVIF `ter:NotAuthorized`
#: subcode, and the WS-Security fault codes some firmware returns instead.
_AUTH_FAULT_MARKERS = (
    "notauthorized",
    "not authorized",
    "failedauthentication",
    "invalidsecurity",
    "sender not authorized",
)


def password_digest(nonce: bytes, created: str, password: str) -> str:
    """WS-Security UsernameToken digest: Base64(SHA-1(nonce + created + password))."""
    # SHA-1 is what the UsernameToken profile, and so every ONVIF device,
    # specifies; the choice is the standard's, not ours.
    digest = hashlib.sha1(  # noqa: S324 - mandated by the WS-Security UsernameToken profile
        nonce + created.encode("utf-8") + password.encode("utf-8")
    ).digest()
    return base64.b64encode(digest).decode("ascii")


def created_timestamp(moment: datetime) -> str:
    """`wsu:Created` in the form devices parse: UTC, second precision, `Z`."""
    return moment.astimezone(UTC).strftime("%Y-%m-%dT%H:%M:%SZ")


def security_header(
    username: str,
    password: str,
    *,
    nonce: bytes | None = None,
    created: str | None = None,
) -> str:
    """A `wsse:Security` SOAP header carrying a digest UsernameToken.

    `nonce` and `created` are parameters only so a test can pin them; in use
    both are fresh on every call.
    """
    nonce = nonce if nonce is not None else os.urandom(16)
    created = created or created_timestamp(datetime.now(UTC))
    return (
        f'<wsse:Security s:mustUnderstand="1" xmlns:wsse="{WSSE_NS}" xmlns:wsu="{WSU_NS}">'
        "<wsse:UsernameToken>"
        f"<wsse:Username>{escape(username)}</wsse:Username>"
        f'<wsse:Password Type="{DIGEST_TYPE_URI}">'
        f"{password_digest(nonce, created, password)}</wsse:Password>"
        f'<wsse:Nonce EncodingType="{NONCE_ENCODING}">'
        f"{base64.b64encode(nonce).decode('ascii')}</wsse:Nonce>"
        f"<wsu:Created>{created}</wsu:Created>"
        "</wsse:UsernameToken>"
        "</wsse:Security>"
    )


def _envelope(body: str, header: str = "") -> str:
    return (
        '<?xml version="1.0" encoding="UTF-8"?>'
        '<s:Envelope xmlns:s="http://www.w3.org/2003/05/soap-envelope">'
        + (f"<s:Header>{header}</s:Header>" if header else "")
        + f"<s:Body>{body}</s:Body></s:Envelope>"
    )


def _is_auth_refusal(response: httpx.Response) -> bool:
    """Whether a device turned the request away for its login."""
    if response.status_code == 401:
        return True
    if response.status_code < 400:
        return False
    text = response.text.lower()
    return any(marker in text for marker in _AUTH_FAULT_MARKERS)


def parse_device_time(root: Element) -> datetime | None:
    """The device's UTC clock from a GetSystemDateAndTime response."""
    utc = root.find(".//tt:UTCDateTime", _NS)
    if utc is None:
        return None
    try:
        return datetime(
            int(utc.findtext("tt:Date/tt:Year", "", _NS)),
            int(utc.findtext("tt:Date/tt:Month", "", _NS)),
            int(utc.findtext("tt:Date/tt:Day", "", _NS)),
            int(utc.findtext("tt:Time/tt:Hour", "", _NS)),
            int(utc.findtext("tt:Time/tt:Minute", "", _NS)),
            int(utc.findtext("tt:Time/tt:Second", "", _NS)),
            tzinfo=UTC,
        )
    except ValueError:
        return None


class OnvifAdapter(CameraAdapter):
    """Speaks ONVIF Device and Media services over SOAP."""

    adapter_type = "onvif"

    def __init__(self, **kwargs: Any) -> None:
        super().__init__(**kwargs)
        #: Device clock minus ours, learnt when a signed call is refused.
        self._clock_offset = timedelta(0)
        #: Injected by tests to replay recorded SOAP exchanges; None in use.
        self.transport: httpx.AsyncBaseTransport | None = None

    # ── Login ──────────────────────────────────────────────────────────

    def _login(self, camera: Any = None) -> Credentials | None:
        """The camera's own login, else the VMS instance's, else None."""
        if camera is not None:
            login = camera_login(camera)
            if login is not None:
                return login
        return resolve_credentials(self.credentials_ref)

    def _header(self, login: Credentials | None) -> str:
        if login is None:
            return ""
        created = created_timestamp(datetime.now(UTC) + self._clock_offset)
        return security_header(login.username, login.password, created=created)

    async def _post(
        self, client: httpx.AsyncClient, url: str, body: str, login: Credentials | None
    ) -> httpx.Response:
        content = _envelope(body, self._header(login))
        if login is None:
            return await client.post(url, content=content, headers=_SOAP_HEADERS)
        return await client.post(
            url,
            content=content,
            headers=_SOAP_HEADERS,
            auth=httpx.DigestAuth(login.username, login.password),
        )

    async def _sync_clock(self, client: httpx.AsyncClient, device_url: str) -> bool:
        """Learn the device's clock offset. True when it was learnt."""
        try:
            response = await client.post(
                device_url,
                content=_envelope(
                    '<tds:GetSystemDateAndTime xmlns:tds="http://www.onvif.org/ver10/device/wsdl"/>'
                ),
                headers=_SOAP_HEADERS,
            )
            response.raise_for_status()
            device_now = parse_device_time(safe_fromstring(response.text))
        except (httpx.HTTPError, ParseError):
            return False
        if device_now is None:
            return False
        self._clock_offset = device_now - datetime.now(UTC)
        self.log.info("onvif.clock_offset", seconds=round(self._clock_offset.total_seconds(), 1))
        return True

    async def _call(self, service_url: str, body: str, camera: Any = None) -> Element:
        """Issue a SOAP request, signed when a login is known, and parse it."""
        login = self._login(camera)
        try:
            async with httpx.AsyncClient(
                timeout=self.timeout_seconds, transport=self.transport
            ) as client:
                response = await self._post(client, service_url, body, login)
                if login is not None and _is_auth_refusal(response):
                    # Most often the device's clock, not the password: retry
                    # once with `Created` on the device's time.
                    device_url = self._device_url_for(service_url)
                    if await self._sync_clock(client, device_url):
                        response = await self._post(client, service_url, body, login)
                if _is_auth_refusal(response):
                    raise AdapterError(
                        "ONVIF device refused the login"
                        if login is not None
                        else "ONVIF device requires a login and none is stored"
                    )
                response.raise_for_status()
                # defusedxml ships no type information; it hands back the
                # stdlib's Element.
                root: Element = safe_fromstring(response.text)
                return root
        except httpx.HTTPError as exc:
            raise AdapterError(f"ONVIF call failed: {exc}") from exc
        except ParseError as exc:
            raise AdapterError(f"ONVIF returned malformed XML: {exc}") from exc

    @staticmethod
    def _device_url_for(service_url: str) -> str:
        parsed = urlparse(service_url)
        return parsed._replace(path="/onvif/device_service", query="").geturl()

    # ── Endpoints ──────────────────────────────────────────────────────

    def _device_service(self, camera: Any = None) -> str:
        """The device service endpoint for a camera or the VMS itself."""
        host = getattr(camera, "stream_url", None) or self.base_url
        if host.startswith("rtsp://"):
            # Derive the HTTP device service from an RTSP URL's host.
            host = "http://" + host.split("://", 1)[1].split("/", 1)[0].split("@")[-1]
            host = host.rsplit(":", 1)[0] if host.count(":") > 1 else host
        return f"{host.rstrip('/')}/onvif/device_service"

    def _media_service(self, camera: Any = None) -> str:
        return (
            f"{self.base_url}/onvif/media_service"
            if self.base_url
            else self._device_service(camera)
        )

    async def get_device_information(self, camera: Any = None) -> dict[str, str]:
        """Manufacturer, model, firmware and serial for the device.

        Worth recording on onboarding: a firmware version is often the first
        thing asked about when a batch of cameras starts misbehaving.
        """
        root = await self._call(
            self._device_service(camera),
            '<tds:GetDeviceInformation xmlns:tds="http://www.onvif.org/ver10/device/wsdl"/>',
            camera,
        )
        response = root.find(".//tds:GetDeviceInformationResponse", _NS)
        if response is None:
            raise AdapterError("ONVIF device returned no device information")

        return {
            tag: (response.findtext(f"tds:{tag}", default="", namespaces=_NS) or "")
            for tag in ("Manufacturer", "Model", "FirmwareVersion", "SerialNumber")
        }

    async def get_profiles(self, camera: Any = None) -> list[dict[str, Any]]:
        """Enumerate media profiles.

        A camera typically publishes a high-resolution main profile and a
        low-resolution sub profile. We prefer the sub profile for AI analysis:
        at 80,000 cameras, analysing sub-streams instead of main streams is a
        very large bandwidth and GPU saving for a small accuracy cost.
        """
        root = await self._call(
            self._media_service(camera),
            '<trt:GetProfiles xmlns:trt="http://www.onvif.org/ver10/media/wsdl"/>',
            camera,
        )

        profiles: list[dict[str, Any]] = []
        for node in root.findall(".//trt:Profiles", _NS):
            resolution = node.find(".//tt:Resolution", _NS)
            profiles.append(
                {
                    "token": node.get("token", ""),
                    "name": node.findtext("tt:Name", default="", namespaces=_NS),
                    "width": int(resolution.findtext("tt:Width", "0", _NS))
                    if resolution is not None
                    else None,
                    "height": int(resolution.findtext("tt:Height", "0", _NS))
                    if resolution is not None
                    else None,
                    "fps": _int_or_none(
                        node.findtext(".//tt:FrameRateLimit", default=None, namespaces=_NS)
                    ),
                    "encoding": node.findtext(".//tt:Encoding", default="", namespaces=_NS),
                }
            )
        return profiles

    async def get_stream_uri(self, profile_token: str, camera: Any = None) -> str | None:
        """Ask the device for the RTSP URI of a given profile.

        The URI comes back without the login; the gateway adds the camera's
        stored one when it pulls (app/services/gateway.py).
        """
        body = (
            '<trt:GetStreamUri xmlns:trt="http://www.onvif.org/ver10/media/wsdl">'
            "<trt:StreamSetup>"
            '<tt:Stream xmlns:tt="http://www.onvif.org/ver10/schema">RTP-Unicast</tt:Stream>'
            '<tt:Transport xmlns:tt="http://www.onvif.org/ver10/schema"><tt:Protocol>RTSP</tt:Protocol></tt:Transport>'
            "</trt:StreamSetup>"
            f"<trt:ProfileToken>{escape(profile_token)}</trt:ProfileToken>"
            "</trt:GetStreamUri>"
        )
        root = await self._call(self._media_service(camera), body, camera)
        return root.findtext(".//tt:Uri", default=None, namespaces=_NS)

    async def list_cameras(self) -> list[DiscoveredCamera]:
        """Enumerate this device's profiles as discoverable streams."""
        try:
            info = await self.get_device_information()
            profiles = await self.get_profiles()
        except AdapterError as exc:
            self.log.warning("onvif.discovery_failed", error=str(exc))
            return []

        label = f"{info.get('Manufacturer', '')} {info.get('Model', '')}".strip() or self.name

        discovered: list[DiscoveredCamera] = []
        for profile in profiles:
            uri = await self.get_stream_uri(profile["token"])
            width, height = profile.get("width"), profile.get("height")
            discovered.append(
                DiscoveredCamera(
                    external_id=f"{info.get('SerialNumber', self.name)}:{profile['token']}",
                    name=f"{label} — {profile['name'] or profile['token']}",
                    stream_url=uri,
                    resolution=f"{width}x{height}" if width and height else None,
                    fps=profile.get("fps"),
                    codec=profile.get("encoding") or None,
                    raw={"device": info, "profile": profile},
                )
            )
        return discovered

    async def probe_health(self, camera: Any) -> HealthProbe:
        """Probe via ONVIF, falling back to RTSP.

        A device that answers GetDeviceInformation is management-plane alive,
        which is not the same as delivering video. So a successful ONVIF
        response is followed by an actual RTSP probe — otherwise a camera with
        a dead sensor reports perfectly healthy.
        """
        started = time.perf_counter()
        try:
            await self.get_device_information(camera)
        except AdapterError as exc:
            refused = "login" in str(exc)
            return HealthProbe(
                reachable=False,
                latency_ms=int((time.perf_counter() - started) * 1000),
                error_code="unauthorized" if refused else "onvif_unreachable",
                detail=str(exc),
            )

        rtsp = RtspAdapter(
            vms_id=self.vms_id,
            name=self.name,
            base_url=self.base_url,
            timeout_seconds=self.timeout_seconds,
        )
        probe = await rtsp.probe_health(camera)
        if probe.error_code == "no_stream_url":
            # Management plane responded but no stream is registered: the
            # device is up, the configuration is incomplete.
            return HealthProbe(
                reachable=True,
                latency_ms=int((time.perf_counter() - started) * 1000),
                frame_drop_pct=None,
                error_code="no_stream_configured",
                detail="ONVIF device reachable but no stream URL registered",
            )
        return probe

    async def get_stream_url(self, camera: Any) -> StreamEndpoints:
        """Republish through our gateway, as with plain RTSP."""
        code = getattr(camera, "camera_code", "unknown").lower()
        return StreamEndpoints(
            rtsp=f"rtsp://{settings.mediamtx_host}:{settings.mediamtx_rtsp_port}/{code}",
            whep=f"{settings.mediamtx_public_webrtc_url}/{code}/whep",
            hls=f"{settings.mediamtx_public_hls_url}/{code}/index.m3u8",
        )


def _int_or_none(value: str | None) -> int | None:
    try:
        return int(value) if value else None
    except ValueError:
        return None
