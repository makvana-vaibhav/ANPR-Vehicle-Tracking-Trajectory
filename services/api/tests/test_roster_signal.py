"""A camera change reaches the AI workers in seconds, not at the next pass.

The jury rehearsal measured +18 s from onboarding to the camera appearing in
the roster and +32 s to a worker opening it. The roster is now republished the
moment a camera is created, edited or deleted, with a content digest beside it
that the workers poll every two seconds (ai_worker/roster_watch.py).

The publish is guarded so an older read of the database can never overwrite a
newer one — the periodic loop may begin reading just before an onboarding
commits and finish after the onboarding's own publish.
"""

from __future__ import annotations

import json
import uuid
from typing import Any

import pytest
import redis.asyncio as aioredis
from httpx import AsyncClient

from app.core.config import settings
from app.services import fleet_roster


@pytest.fixture
async def scratch_keys(monkeypatch: pytest.MonkeyPatch):
    """Point the publisher at throwaway keys, never the live roster."""
    suffix = uuid.uuid4().hex[:8]
    keys = {
        "ROSTER_KEY": f"test:roster:{suffix}",
        "ROSTER_VERSION_KEY": f"test:roster:{suffix}:version",
        "ROSTER_BUILT_AT_KEY": f"test:roster:{suffix}:built_at",
    }
    for name, value in keys.items():
        monkeypatch.setattr(fleet_roster, name, value)
    yield keys
    client = aioredis.from_url(settings.redis_url, decode_responses=True)
    try:
        await client.delete(*keys.values())
    finally:
        await client.aclose()


async def read(key: str) -> str | None:
    client = aioredis.from_url(settings.redis_url, decode_responses=True)
    try:
        value: str | None = await client.get(key)
        return value
    finally:
        await client.aclose()


def fake_roster(monkeypatch: pytest.MonkeyPatch, cameras: list[dict[str, Any]]) -> None:
    async def _build() -> list[dict[str, Any]]:
        return cameras

    monkeypatch.setattr(fleet_roster, "build_roster", _build)


class TestVersionedPublish:
    async def test_the_version_follows_the_content(self, scratch_keys, monkeypatch) -> None:
        fake_roster(monkeypatch, [{"camera_code": "A"}])
        await fleet_roster.publisher.publish_once()
        first = await read(scratch_keys["ROSTER_VERSION_KEY"])
        await fleet_roster.publisher.publish_once()
        assert await read(scratch_keys["ROSTER_VERSION_KEY"]) == first

        fake_roster(monkeypatch, [{"camera_code": "A"}, {"camera_code": "B"}])
        await fleet_roster.publisher.publish_once()
        second = await read(scratch_keys["ROSTER_VERSION_KEY"])
        assert second and second != first
        payload = json.loads(await read(scratch_keys["ROSTER_KEY"]) or "{}")
        assert [c["camera_code"] for c in payload["cameras"]] == ["A", "B"]
        assert second == fleet_roster.roster_version(json.dumps(payload))

    async def test_an_older_read_never_overwrites_a_newer_one(
        self, scratch_keys, monkeypatch
    ) -> None:
        fake_roster(monkeypatch, [{"camera_code": "NEW"}])
        await fleet_roster.publisher.publish_once()

        # A slow periodic publish whose database read predates that one.
        real_time = fleet_roster.time.time
        started = real_time() - 60

        class _Clock:
            @staticmethod
            def time() -> float:
                return started

        monkeypatch.setattr(fleet_roster, "time", _Clock)
        fake_roster(monkeypatch, [])
        await fleet_roster.publisher.publish_once()

        payload = json.loads(await read(scratch_keys["ROSTER_KEY"]) or "{}")
        assert [c["camera_code"] for c in payload["cameras"]] == ["NEW"]

    async def test_notify_never_raises(self, monkeypatch) -> None:
        async def _broken() -> int:
            raise ConnectionError("redis is down")

        monkeypatch.setattr(fleet_roster.publisher, "publish_once", _broken)
        assert await fleet_roster.notify_changed("test") is False


class TestCameraEndpointsNotify:
    async def test_create_edit_delete_each_republish_after_commit(
        self, client: AsyncClient, auth_headers, monkeypatch
    ) -> None:
        """The roster is read in a fresh session, so it must see the commit."""
        seen: list[tuple[str, bool]] = []
        code = f"CAM-ROSTER-{uuid.uuid4().hex[:6].upper()}"

        async def _notify(reason: str, camera_code: str | None = None) -> bool:
            roster = await fleet_roster.build_roster()
            seen.append((reason, any(e["camera_code"] == code for e in roster)))
            return True

        monkeypatch.setattr(fleet_roster, "notify_changed", _notify)
        admin = await auth_headers("admin")
        created = await client.post(
            "/api/v1/cameras",
            json={
                "camera_code": code,
                "name": "Roster signal",
                "lat": 23.03,
                "lon": 72.58,
                "stream_url": "rtsp://10.98.0.1:554/live",
                "anpr_enabled": True,
            },
            headers=admin,
        )
        assert created.status_code == 201, created.text
        camera_id = created.json()["id"]
        await client.patch(
            f"/api/v1/cameras/{camera_id}", json={"anpr_enabled": False}, headers=admin
        )
        await client.delete(f"/api/v1/cameras/{camera_id}", headers=admin)

        assert seen == [
            ("camera.create", True),
            ("camera.update", False),
            ("camera.delete", False),
        ]
