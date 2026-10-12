"""The web tier's HTTPS server, and what it must and must not proxy.

The same application is served over plain HTTP (the demo's :8080) and HTTPS
(:8443). These assert the differences that are deliberate — TLS, and HSTS only
for real hostnames, never for `localhost`, where it would upgrade the demo's own
HTTP address and break it — and that the same-origin proxies the HTTPS page
needs for crops and video stay read-only.

The certificate is self-signed unless one was mounted, so it is not verified
here; what is under test is the server, not the trust store.

Run against a live stack:  pytest tests/e2e/test_web_tls.py
"""

from __future__ import annotations

import os
from urllib.parse import urlsplit

import httpx
import pytest

WEB_URL = os.environ.get("WEB_URL", "http://localhost:8080")
WEB_TLS_URL = os.environ.get(
    "WEB_TLS_URL",
    "https://web:8443"
    if WEB_URL.rstrip("/") == "http://web"
    else "https://localhost:8443",
)

SECURITY_HEADERS = (
    "content-security-policy",
    "x-frame-options",
    "x-content-type-options",
    "referrer-policy",
)


def tls_get(
    path: str,
    host: str | None = None,
    method: str = "GET",
    headers: dict[str, str] | None = None,
    **kw,
) -> httpx.Response:
    headers = {**(headers or {}), **({"Host": host} if host else {})}
    try:
        return httpx.request(
            method,
            f"{WEB_TLS_URL}{path}",
            headers=headers,
            verify=False,
            timeout=10,
            **kw,
        )
    except httpx.HTTPError as exc:
        pytest.skip(f"HTTPS web tier not reachable at {WEB_TLS_URL}: {exc}")


class TestHttpsServer:
    def test_serves_the_same_application(self) -> None:
        response = tls_get("/")
        assert response.status_code == 200
        assert "Contrail" in response.text

    @pytest.mark.parametrize("header", SECURITY_HEADERS)
    def test_security_headers_present(self, header: str) -> None:
        assert header in {k.lower() for k in tls_get("/").headers}

    def test_hsts_for_a_real_hostname(self) -> None:
        response = tls_get("/", host="contrail.example")
        assert response.headers.get("strict-transport-security", "").startswith(
            "max-age="
        )

    @pytest.mark.parametrize("host", ["localhost", "localhost:8443", "127.0.0.1:8443"])
    def test_no_hsts_for_localhost_or_an_address(self, host: str) -> None:
        """HSTS is per host, not per port: it would upgrade http://localhost:8080."""
        assert "strict-transport-security" not in tls_get("/", host=host).headers

    def test_the_api_is_proxied(self) -> None:
        assert tls_get("/api/v1/auth/me").status_code == 401


class TestHttpServerUnchanged:
    def test_no_hsts_over_plain_http(self) -> None:
        try:
            response = httpx.get(
                WEB_URL, timeout=10, headers={"Host": "contrail.example"}
            )
        except httpx.HTTPError as exc:
            pytest.skip(f"web tier not reachable at {WEB_URL}: {exc}")
        assert response.status_code == 200
        assert "strict-transport-security" not in response.headers


class TestProxiesAreReadOnly:
    def test_the_object_store_cannot_be_written(self) -> None:
        response = tls_get(
            "/media/nagarnetra-media/crops/plates/e2e.jpg", method="PUT", content=b"x"
        )
        assert response.status_code == 403

    def test_a_bucket_cannot_be_listed(self) -> None:
        """Anonymous download is GetObject only; a listing must be refused."""
        assert tls_get("/media/nagarnetra-media/").status_code in (403, 404)

    def test_publishing_to_the_gateway_is_impossible(self) -> None:
        """MediaMTX lets the internal network publish, and nginx is on it."""
        response = tls_get(
            "/gateway/webrtc/cam-demo-01/whip",
            method="POST",
            content=b"v=0",
            headers={"content-type": "application/sdp"},
        )
        assert response.status_code in (404, 405)
        assert tls_get("/gateway/webrtc/cam-demo-01/whep").status_code in (403, 405)

    def test_hls_redirects_stay_under_the_prefix(self) -> None:
        response = tls_get("/gateway/hls/cam-demo-01/index.m3u8")
        if response.status_code in (301, 302):
            # MediaMTX's cookie check redirects to an absolute path; unrewritten
            # it would leave the prefix and land on the SPA.
            assert urlsplit(response.headers["location"]).path.startswith(
                "/gateway/hls/"
            )
