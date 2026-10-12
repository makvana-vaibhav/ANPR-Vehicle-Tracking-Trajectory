"""The stream gateway's authorisation callback.

MediaMTX runs with `authMethod: http` (infra/mediamtx/mediamtx.yml): before it
lets anything publish into a path or read one out — RTSP, WebRTC or HLS — it
POSTs the request here and obeys the status code. That makes the API the single
place that decides who may watch a camera, which the camera-scoped stream token
always claimed and, for our own cameras, did not deliver: MediaMTX granted
`read` to any address, so CAM-DEMO-01 played for anyone who could reach :8888
whether or not they had a token.

Three kinds of caller, each allowed exactly one thing:

* **the simulator** publishes, with `MEDIAMTX_PUBLISH_USER/_PASSWORD`;
* **the ANPR workers** read, with `MEDIAMTX_READ_USER/_PASSWORD`;
* **a browser** reads over WebRTC or HLS, presenting the stream token the API
  issued (and audited, as `camera.view`) in `?token=`. The token must be valid,
  of type `stream`, and scoped to the very path being read.

Nothing else is allowed: no anonymous read, no publish with a token, no
playback (we record nothing). The control API and metrics are excluded from
this callback in the MediaMTX config and are reachable only on the internal
network, because their ports are not published beyond the host's loopback.

The address MediaMTX reports is deliberately not used. Connections from the
host and from the web tier's proxy arrive from inside the bridge network, so
"internal address" proves nothing about who is asking.

Not under `/api/`, so the web tier's proxy never forwards it; the API port is
published on the host's loopback only (docker-compose.yml).
"""

from __future__ import annotations

import hmac
from urllib.parse import parse_qs

from fastapi import APIRouter, Response, status
from pydantic import BaseModel

from app.core.config import settings
from app.core.logging import get_logger
from app.core.security import TokenError, decode_token

log = get_logger("api.gateway_auth")

router = APIRouter(tags=["streams"])

#: Where MediaMTX sends its questions. Also excluded from the audit middleware
#: (the viewing is audited when the token is issued) and from rate limiting
#: (every caller arrives through one MediaMTX address, so a limit here would
#: let one noisy client lock every operator out of video).
AUTH_PATH = "/internal/mediamtx/auth"

#: Protocols a browser can play. A stream token is never accepted over RTSP:
#: no browser speaks it, and the workers have their own identity.
BROWSER_PROTOCOLS = frozenset({"webrtc", "hls"})


class GatewayAuthRequest(BaseModel):
    """What MediaMTX sends (its `authHTTPAddress` contract)."""

    user: str = ""
    password: str = ""
    token: str = ""
    ip: str = ""
    action: str = ""
    path: str = ""
    protocol: str = ""
    id: str | None = None
    query: str = ""


def _same(given: str, expected: str) -> bool:
    """Constant-time comparison; an empty expected value matches nothing."""
    if not expected:
        return False
    return hmac.compare_digest(given.encode(), expected.encode())


def _is_identity(req: GatewayAuthRequest, user: str, password: str) -> bool:
    return _same(req.user, user) and _same(req.password, password)


def _stream_token(req: GatewayAuthRequest) -> str:
    """The token a browser presented: `?token=` on the WHEP or HLS URL.

    MediaMTX also fills `token` from an `Authorization: Bearer` header — and,
    with Basic credentials, from the password — so that field is read only
    when no username was given.
    """
    values = parse_qs(req.query).get("token")
    if values:
        return values[0]
    return req.token if not req.user else ""


def authorise(req: GatewayAuthRequest) -> tuple[bool, str]:
    """Whether to let the request through, and why (for the log)."""
    if req.action == "publish":
        if _is_identity(req, settings.mediamtx_publish_user, settings.mediamtx_publish_password):
            return True, "publisher"
        return False, "publish needs the publisher identity"

    if req.action != "read":
        return False, f"action {req.action!r} is not granted to anyone"

    if _is_identity(req, settings.mediamtx_read_user, settings.mediamtx_read_password):
        return True, "reader"

    token = _stream_token(req)
    if not token:
        return False, "no credentials and no stream token"
    if req.protocol not in BROWSER_PROTOCOLS:
        return False, f"stream tokens are not accepted over {req.protocol or 'unknown'}"
    try:
        payload = decode_token(token, expected_type="stream")
    except TokenError as exc:
        return False, f"stream token rejected: {exc}"
    if not payload.gateway_path or payload.gateway_path != req.path:
        return False, "stream token is scoped to a different camera"
    return True, f"stream token of {payload.username}"


@router.post(AUTH_PATH, include_in_schema=False)
async def mediamtx_auth(req: GatewayAuthRequest) -> Response:
    """2xx lets MediaMTX proceed; anything else refuses the client."""
    allowed, reason = authorise(req)
    fields = {
        "action": req.action,
        "path": req.path,
        "protocol": req.protocol,
        "client_ip": req.ip,
        "reason": reason,
    }
    if allowed:
        # Internal identities connect constantly (worker rotation, publisher
        # restarts); only browser reads are worth an info line.
        if reason.startswith("stream token"):
            log.info("gateway.read_authorised", **fields)
        return Response(status_code=status.HTTP_204_NO_CONTENT)
    log.warning("gateway.refused", **fields)
    return Response(status_code=status.HTTP_401_UNAUTHORIZED)
