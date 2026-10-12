"""Media URLs over HTTPS: on the browser's own origin, and still valid.

A page served over HTTPS cannot load `http://localhost:9000/...` crops or
`http://localhost:8889/...` video — mixed content. The web tier proxies both
under its own origin, and the API points a TLS request's URLs there. The test
that matters most is the last one: a crop URL signed for the proxied path must
pass MinIO's signature check when forwarded the way nginx forwards it.
"""

from __future__ import annotations

import uuid

import aioboto3
import httpx
import pytest

from app.core import public_origin
from app.core.config import settings
from app.services import evidence, person_media
from app.services.retention import _s3_kwargs

pytestmark = pytest.mark.asyncio


@pytest.fixture
def over_tls():
    token = public_origin.bind("https", "localhost:8443")
    yield "https://localhost:8443"
    public_origin.reset(token)


class TestOrigin:
    @pytest.mark.parametrize(
        ("scheme", "host", "expected"),
        [
            ("https", "localhost:8443", "https://localhost:8443"),
            ("wss", "contrail.example:443", "https://contrail.example:443"),
            ("https", "[::1]:8443", "https://[::1]:8443"),
            ("http", "localhost:8080", None),
            ("ws", "localhost:8000", None),
            ("https", None, None),
            ("https", "evil.example/path", None),
            ("https", "a b", None),
        ],
    )
    async def test_only_tls_requests_with_a_sane_host_bind(self, scheme, host, expected) -> None:
        assert public_origin.origin_from(scheme, host) == expected

    async def test_plain_http_keeps_the_urls_it_always_had(self) -> None:
        url = evidence.crop_url("crops/plates/x.jpg")
        assert url is not None and url.startswith(settings.minio_public_endpoint)
        whep = f"{settings.mediamtx_public_webrtc_url}/cam-demo-01/whep"
        assert public_origin.gateway_url(whep) == whep


class TestRewrites:
    async def test_crops_move_onto_the_page_origin(self, over_tls) -> None:
        url = evidence.crop_url("crops/plates/2026/10/12/x.jpg")
        assert url is not None
        assert url.startswith(f"{over_tls}/media/{settings.minio_bucket}/crops/plates/")
        assert "X-Amz-Signature=" in url

    async def test_face_media_moves_too(self, over_tls) -> None:
        url = person_media.signed_url("faces/2026/10/12/cam/x.jpg")
        assert url is not None
        assert url.startswith(f"{over_tls}/media/{settings.minio_persons_bucket}/faces/")

    async def test_our_gateway_moves_and_a_federated_one_does_not(self, over_tls) -> None:
        whep = f"{settings.mediamtx_public_webrtc_url}/cam-demo-01/whep"
        hls = f"{settings.mediamtx_public_hls_url}/cam-demo-01/index.m3u8"
        assert public_origin.gateway_url(whep) == f"{over_tls}/gateway/webrtc/cam-demo-01/whep"
        assert public_origin.gateway_url(hls) == f"{over_tls}/gateway/hls/cam-demo-01/index.m3u8"
        grid = "http://103.250.160.189:8889/stream/7/whep"
        assert public_origin.gateway_url(grid) == grid
        relative = "/api/v1/grid/abc/token/index.m3u8"
        assert public_origin.gateway_url(relative) == relative


class TestSignatureSurvivesTheProxy:
    async def test_a_proxied_crop_url_is_accepted_by_object_storage(self, over_tls) -> None:
        """Forwarded exactly as web/nginx.conf forwards it: path after /media,
        query untouched, Host the internal endpoint."""
        key = f"crops/__origin_test__/{uuid.uuid4().hex}.jpg"
        async with aioboto3.Session().client("s3", **_s3_kwargs()) as s3:
            await s3.put_object(Bucket=settings.minio_bucket, Key=key, Body=b"\xff\xd8ok")
        try:
            url = evidence.crop_url(key)
            assert url is not None
            forwarded = url.replace(f"{over_tls}/media", settings.minio_url, 1)
            async with httpx.AsyncClient(timeout=5) as client:
                response = await client.get(forwarded)
            assert response.status_code == 200, response.text[:300]
            assert response.content == b"\xff\xd8ok"
        finally:
            async with aioboto3.Session().client("s3", **_s3_kwargs()) as s3:
                await s3.delete_object(Bucket=settings.minio_bucket, Key=key)
