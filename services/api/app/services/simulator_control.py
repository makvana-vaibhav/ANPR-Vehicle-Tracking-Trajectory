"""Starts and stops a recorded-video camera's replay from the registry.

Onboarding a camera with **Recorded video** used to store the clip's name and
stop there: the simulator chose its clips once, at start-up, so the new camera
showed nothing until someone ran `curl -X POST :9100/streams/<CODE>/start` by
hand. The jury rehearsal on 12 Oct needed exactly that curl.

Now the API makes the call itself, after the row is committed (the simulator
reads the camera from the database): on create, when the clip changes on an
edit, and — as a stop — on delete or when the camera switches to a live URL.
Each request carries a short-lived service token (`app/core/service_auth.py`);
the simulator refuses its control endpoints without one.

A camera with a `stream_url` is never started here, whatever its clip. The
gateway already pulls that URL into the camera's path, and a publisher into the
same path would fight the pull — a cousin of CLAUDE.md trap 1.

Failure is logged, never raised: an onboarding must not fail because the
simulator is restarting. Its own start-up replays every camera with a clip and
no live URL, so the camera is published then anyway.
"""

from __future__ import annotations

from typing import Any

import httpx

from app.core import service_auth
from app.core.config import settings
from app.core.logging import get_logger

log = get_logger("simulator_control")

#: Starting can include a one-off transcode of a new clip into a keyframe-dense
#: copy (simulator/publisher.py `prepare_clip`), which takes a while for a
#: long file. The call runs after the response has been sent, so waiting costs
#: the operator nothing.
START_TIMEOUT_S = 180.0
STOP_TIMEOUT_S = 10.0


def wants_replay(camera: Any) -> bool:
    """Whether this camera's pictures come from a clip the simulator plays."""
    return bool(getattr(camera, "source_file", None)) and not getattr(camera, "stream_url", None)


async def _post(code: str, action: str, wait_s: float) -> dict[str, Any] | None:
    base = settings.simulator_control_url.rstrip("/")
    if not base:
        return None
    headers = {service_auth.HEADER: service_auth.issue(service_auth.SIMULATOR_CONTROL)}
    url = f"{base}/streams/{code}/{action}"
    try:
        async with httpx.AsyncClient(timeout=wait_s) as client:
            response = await client.post(url, headers=headers)
    except httpx.HTTPError as exc:
        log.warning("simulator_control.unreachable", camera=code, action=action, error=str(exc))
        return None
    if action == "stop" and response.status_code == 404:
        # Not publishing — which is the state a stop asks for.
        return {"camera_code": code, "stopped": False}
    if response.status_code >= 400:
        log.warning(
            "simulator_control.refused",
            camera=code,
            action=action,
            status=response.status_code,
            detail=response.text[:200],
        )
        return None
    try:
        body: dict[str, Any] = response.json()
    except ValueError:
        body = {}
    log.info("simulator_control.done", camera=code, action=action, result=body)
    return body


async def start(code: str) -> bool:
    """Ask the simulator to publish this camera's clip. True when it is."""
    body = await _post(code.upper(), "start", START_TIMEOUT_S)
    if body is None:
        return False
    return bool(body.get("started")) or body.get("detail") == "Already publishing"


async def stop(code: str) -> bool:
    """Ask the simulator to stop publishing this camera. True unless unreachable."""
    return await _post(code.upper(), "stop", STOP_TIMEOUT_S) is not None


async def restart(code: str) -> bool:
    """Stop then start — a new clip on a camera already replaying one."""
    await stop(code)
    return await start(code)
