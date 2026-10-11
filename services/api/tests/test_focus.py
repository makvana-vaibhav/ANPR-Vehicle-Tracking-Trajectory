"""Focus: the camera on someone's screen is analysed first.

These run against the stack's real Redis, which the AI workers also read, so
they use the recorded demonstration camera only. Focusing a grid camera from a
test would make a worker open a session on the organisers' grid for it.
"""

from __future__ import annotations

import time
import uuid

import pytest
from httpx import AsyncClient
from sqlalchemy import func, select

from app.db.session import SessionLocal
from app.models.registry import Camera
from app.models.security import AuditLog
from app.services import focus

pytestmark = pytest.mark.integration

DEMO = "CAM-DEMO-01"


@pytest.fixture
async def demo_camera() -> Camera:
    async with SessionLocal() as session:
        camera = await session.scalar(select(Camera).where(Camera.camera_code == DEMO))
    if camera is None:
        pytest.skip(f"{DEMO} is not seeded")
    return camera


@pytest.fixture(autouse=True)
async def _forget_the_demo_focus():
    yield
    await focus._redis().zrem(focus.FOCUS_KEY, DEMO)


async def _audit_rows() -> int:
    async with SessionLocal() as session:
        return await session.scalar(select(func.count()).select_from(AuditLog)) or 0


class TestTheHeartbeat:
    async def test_puts_the_camera_on_the_watched_list(
        self, client: AsyncClient, auth_headers, demo_camera: Camera
    ) -> None:
        response = await client.post(
            f"/api/v1/cameras/{demo_camera.id}/focus", headers=await auth_headers("operator")
        )
        assert response.status_code == 204
        assert DEMO in await focus.watched()

    async def test_lapses_on_its_own(self) -> None:
        """A closed tab sends nothing more; the entry must stop counting."""
        await focus.watch(DEMO, now=time.time() - focus.FOCUS_TTL_S - 1)
        assert DEMO not in await focus.watched()

    async def test_each_write_drops_what_has_lapsed(self) -> None:
        await focus.watch(DEMO, now=time.time() - focus.FOCUS_TTL_S - 1)
        await focus.watch("CAM-DEMO-FOCUS-TEST")
        try:
            score = await focus._redis().zscore(focus.FOCUS_KEY, DEMO)
            assert score is None, "a lapsed entry outlived the next write"
        finally:
            await focus._redis().zrem(focus.FOCUS_KEY, "CAM-DEMO-FOCUS-TEST")

    async def test_is_not_audited(
        self, client: AsyncClient, auth_headers, demo_camera: Camera
    ) -> None:
        """Opening the stream is the audited act; a row per heartbeat would
        add four a minute per viewer and say nothing new."""
        headers = await auth_headers("operator")
        before = await _audit_rows()
        await client.post(f"/api/v1/cameras/{demo_camera.id}/focus", headers=headers)
        assert await _audit_rows() == before

    async def test_needs_the_right_to_watch(
        self, client: AsyncClient, auth_headers, demo_camera: Camera
    ) -> None:
        """Analysts work over recorded detections and cannot open live
        video, so they cannot steer the live analysis either."""
        response = await client.post(
            f"/api/v1/cameras/{demo_camera.id}/focus", headers=await auth_headers("analyst")
        )
        assert response.status_code == 403
        assert DEMO not in await focus.watched()

    async def test_an_unknown_camera_is_not_found(
        self, client: AsyncClient, auth_headers
    ) -> None:
        response = await client.post(
            f"/api/v1/cameras/{uuid.uuid4()}/focus", headers=await auth_headers("operator")
        )
        assert response.status_code == 404
