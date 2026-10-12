"""Media URLs for a browser that reached the platform over HTTPS.

The command centre is served on two origins by the same nginx: plain HTTP on
:8080, which the demo has always used, and HTTPS on :8443. The API hands the
browser three kinds of absolute URL that point *past* nginx, straight at a
backing service on its own port:

* plate crops and face media — presigned MinIO URLs, `http://localhost:9000/…`;
* live video — MediaMTX WHEP and HLS, `http://localhost:8889/…`, `:8888/…`.

From an `https://` page every one of those is mixed content, and a browser
blocks it (or, for `localhost` only, lets it through by special exemption —
nothing to build on, and useless the moment the page is opened by any other
name). So the HTTPS server proxies all three under its own origin
(`/media/`, `/gateway/webrtc/`, `/gateway/hls/`, in `web/nginx.conf`), and a
request that arrived through it gets URLs pointing there.

How the API knows: nginx's HTTPS server sends `X-Forwarded-Proto: https` and
the `Host` the browser used, uvicorn (`--proxy-headers`) turns those into the
request's scheme and host, and the request middleware binds the origin here for
the duration of the request. A request over plain HTTP — the :8080 demo, or the
browser calling :8000 directly — binds nothing and gets exactly the URLs it got
before. The WebSocket feed does the same from its handshake.

Object URLs need one more step. SigV4 signs the `Host` header, so a URL signed
for `localhost:9000` fails when nginx forwards it. Proxied URLs are therefore
signed for the internal endpoint (`minio:9000`) — the host nginx presents when
it forwards — and then rewritten onto the browser's origin.
"""

from __future__ import annotations

import re
from contextvars import ContextVar, Token
from urllib.parse import urlsplit

from app.core.config import settings

#: Where the HTTPS server proxies each backing service (web/nginx.conf).
MEDIA_PATH = "/media"
WEBRTC_PATH = "/gateway/webrtc"
HLS_PATH = "/gateway/hls"

#: A host header worth building a URL from: a name or IPv4 address, or a
#: bracketed IPv6 address, with an optional port. Anything else is ignored
#: rather than echoed into a URL.
_HOST = re.compile(r"^(?:[A-Za-z0-9.-]+|\[[0-9A-Fa-f:.]+\])(?::\d{1,5})?$")

_origin: ContextVar[str | None] = ContextVar("public_tls_origin", default=None)


def origin_from(scheme: str, host: str | None) -> str | None:
    """`https://<host>` for a request that came in over TLS, else None."""
    if scheme not in ("https", "wss") or not host or not _HOST.match(host):
        return None
    return f"https://{host}"


def bind(scheme: str, host: str | None) -> Token[str | None]:
    return _origin.set(origin_from(scheme, host))


def reset(token: Token[str | None]) -> None:
    _origin.reset(token)


def current() -> str | None:
    return _origin.get()


def object_url(signed_internal_url: str) -> str:
    """A URL signed for the internal object store, moved onto the browser's
    origin under `/media`. Path and signature are kept byte for byte."""
    origin = current()
    if origin is None:
        return signed_internal_url
    parts = urlsplit(signed_internal_url)
    query = f"?{parts.query}" if parts.query else ""
    return f"{origin}{MEDIA_PATH}{parts.path}{query}"


def gateway_url(url: str | None) -> str | None:
    """A MediaMTX WHEP or HLS URL, moved onto the browser's origin.

    Only URLs on our own gateway's public addresses are rewritten. A federated
    grid's direct WHEP address is left alone — it is not ours to proxy, and the
    player falls back to the grid's HLS, which the API already proxies.
    """
    origin = current()
    if origin is None or not url:
        return url
    for public, path in (
        (settings.mediamtx_public_webrtc_url, WEBRTC_PATH),
        (settings.mediamtx_public_hls_url, HLS_PATH),
    ):
        base = public.rstrip("/")
        if base and url.startswith(f"{base}/"):
            return f"{origin}{path}{url[len(base) :]}"
    return url
