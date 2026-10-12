"""The live feed gives each role what the RBAC matrix gives it, and no more.

`/ws/events` used to fan every event out whole to every signed-in role, so an
auditor (no plate search) received every plate as it was read, and an analyst
(no live video) received stills cut from the video. Operators, supervisors and
admins must see no difference at all.
"""

from __future__ import annotations

import asyncio
import copy
import json
import uuid
from typing import Any

import pytest
from fastapi import WebSocketDisconnect

from app.core.security import create_access_token
from app.routers import events as events_router
from app.services.event_bus import broadcaster
from app.services.feed_policy import FeedPolicy

PLATE = "GJ01AB1234"

COMPLETED: dict[str, Any] = {
    "schema": "vehicle.v3",
    "event": "vehicle.completed",
    "event_time": "2026-10-12T06:00:00+00:00",
    "captured_at": "2026-10-12T05:59:59+00:00",
    "source": {"camera_id": "CAM-DEMO-01"},
    "frame": {"width": 1280, "height": 720},
    "vehicle": {"vehicle_id": 7, "type": "car", "bbox": {"x1": 1, "y1": 2, "x2": 3, "y2": 4}},
    "plate": {
        "text": PLATE,
        "confidence": 0.97,
        "readable": True,
        "corrected_from": "GJ01A81234",
        "candidates": [{"text": PLATE}, {"text": "GJ01AB1284"}],
        "evidence": {"reads_total": 9, "agreement": 0.89},
    },
    "evidence": {
        "plate_crop": "crops/2026/10/12/abc_plate.jpg",
        "vehicle_crop": "crops/2026/10/12/abc_vehicle.jpg",
        "reads": [{"text": PLATE, "crop": "crops/2026/10/12/abc_1.jpg"}],
    },
    "run_id": "r1",
    "latency_ms": 180.0,
    # A field added later, unknown to the policy: must not leak by default.
    "future_identifying_field": PLATE,
}

TRACKS: dict[str, Any] = {
    "event": "camera.tracks",
    "source": {"camera_id": "CAM-DEMO-01"},
    "tracks": [
        {"track_id": 1, "type": "car", "bbox": [1, 2, 3, 4], "plate": PLATE, "confidence": 0.9},
        {"track_id": 2, "type": "bus", "bbox": [5, 6, 7, 8]},
    ],
}

WATCHLIST_ALERT: dict[str, Any] = {
    "event": "alert.raised",
    "alert_id": str(uuid.uuid4()),
    "alert_type": "watchlist_hit",
    "priority": "high",
    "plate": PLATE,
    "confidence": 0.97,
    "status": "new",
    "camera_id": str(uuid.uuid4()),
    "detection_id": str(uuid.uuid4()),
    "created_at": "2026-10-12T06:00:00+00:00",
    "notes": f"Near match to {PLATE}",
    "reasons": [{"code": "watchlist", "text": f"{PLATE} is listed"}],
    "watchlist": {"id": "w1", "plate": PLATE, "category": "stolen", "case_ref": "FIR-12"},
}

CAMERA_DOWN: dict[str, Any] = {
    "event": "alert.raised",
    "alert_id": str(uuid.uuid4()),
    "alert_type": "camera_down",
    "priority": "medium",
    "plate": None,
    "notes": "JURY-01 unreachable: probe_failed",
}


def everything(event: dict[str, Any] | None) -> str:
    return json.dumps(event)


class TestPolicyByRole:
    @pytest.mark.parametrize("role", ["admin", "supervisor", "operator"])
    @pytest.mark.parametrize("event", [COMPLETED, TRACKS, WATCHLIST_ALERT, CAMERA_DOWN])
    def test_full_roles_get_every_event_untouched(self, role: str, event: dict) -> None:
        before = copy.deepcopy(event)
        assert FeedPolicy.for_role(role).apply(event) is event
        assert event == before

    def test_full_roles_get_unknown_events_too(self) -> None:
        odd = {"event": "pursuit.advanced", "plate": PLATE}
        assert FeedPolicy.for_role("operator").apply(odd) is odd

    def test_auditor_sees_that_a_vehicle_passed_not_which(self) -> None:
        out = FeedPolicy.for_role("auditor").apply(COMPLETED)
        assert out is not None
        assert PLATE not in everything(out)
        assert "GJ01A81234" not in everything(out)
        assert "crops/" not in everything(out)
        assert out["plate"] == {"readable": True, "text": "", "withheld": True}
        assert out["vehicle"]["type"] == "car"
        assert out["source"]["camera_id"] == "CAM-DEMO-01"

    def test_analyst_reads_plates_but_gets_no_stills(self) -> None:
        out = FeedPolicy.for_role("analyst").apply(COMPLETED)
        assert out is not None
        assert out["plate"]["text"] == PLATE
        assert "evidence" not in out
        assert "crops/" not in everything(out)

    @pytest.mark.parametrize("role", ["analyst", "auditor"])
    def test_overlay_boxes_need_live_video(self, role: str) -> None:
        assert FeedPolicy.for_role(role).apply(TRACKS) is None

    def test_auditor_alarm_without_the_plate(self) -> None:
        out = FeedPolicy.for_role("auditor").apply(WATCHLIST_ALERT)
        assert out is not None
        assert PLATE not in everything(out)
        assert "FIR-12" not in everything(out)
        assert out["alert_type"] == "watchlist_hit"
        assert out["priority"] == "high"
        assert out["withheld"] is True

    def test_analyst_alarm_keeps_the_plate(self) -> None:
        assert FeedPolicy.for_role("analyst").apply(WATCHLIST_ALERT) is WATCHLIST_ALERT

    def test_a_camera_alarm_is_not_about_a_plate(self) -> None:
        assert FeedPolicy.for_role("auditor").apply(CAMERA_DOWN) is CAMERA_DOWN

    def test_unknown_events_are_not_guessed_at(self) -> None:
        odd = {"event": "pursuit.advanced", "plate": PLATE}
        assert FeedPolicy.for_role("auditor").apply(odd) is None

    def test_api_client_gets_nothing(self) -> None:
        policy = FeedPolicy.for_role("api_client")
        assert not policy.receives_anything
        assert policy.apply(COMPLETED) is None

    def test_an_unknown_role_gets_nothing(self) -> None:
        assert not FeedPolicy.for_role("intruder").receives_anything


class FakeSocket:
    """Just enough of a WebSocket to run the real handler."""

    def __init__(self, stop_after: int) -> None:
        self.sent: list[dict[str, Any]] = []
        self.accepted = False
        self.closed: tuple[int, str] | None = None
        self.stop_after = stop_after
        self.url = type("U", (), {"scheme": "http"})()
        self.headers: dict[str, str] = {"host": "contrail.test"}

    async def accept(self) -> None:
        self.accepted = True

    async def close(self, code: int = 1000, reason: str = "") -> None:
        self.closed = (code, reason)

    async def send_json(self, data: dict[str, Any]) -> None:
        self.sent.append(data)
        if len(self.sent) >= self.stop_after:
            raise WebSocketDisconnect()


def token_for(role: str) -> str:
    return create_access_token(user_id=uuid.uuid4(), username=f"test-{role}", role=role)


async def run_feed(role: str, events: list[dict[str, Any]], expect: int) -> FakeSocket:
    socket = FakeSocket(stop_after=1 + expect)  # "connected" comes first
    before = broadcaster.subscriber_count
    task = asyncio.create_task(events_router.event_feed(socket, token_for(role)))  # type: ignore[arg-type]
    for _ in range(100):
        if broadcaster.subscriber_count > before or socket.closed:
            break
        await asyncio.sleep(0.01)
    for event in events:
        await broadcaster.publish(event)
    await asyncio.wait_for(task, timeout=5)
    return socket


class TestTheSocket:
    async def test_operator_feed_is_unchanged(self) -> None:
        socket = await run_feed("operator", [WATCHLIST_ALERT, TRACKS], expect=2)
        assert socket.sent[1:] == [WATCHLIST_ALERT, TRACKS]

    async def test_auditor_feed_carries_no_plate(self) -> None:
        socket = await run_feed("auditor", [TRACKS, COMPLETED, WATCHLIST_ALERT], expect=2)
        delivered = socket.sent[1:]
        assert [e["event"] for e in delivered] == ["vehicle.completed", "alert.raised"]
        assert PLATE not in json.dumps(delivered)
        assert "plate_crop_url" not in json.dumps(delivered)

    async def test_api_client_is_refused_the_socket(self) -> None:
        socket = FakeSocket(stop_after=1)
        await events_router.event_feed(socket, token_for("api_client"))  # type: ignore[arg-type]
        assert not socket.accepted
        assert socket.closed is not None and socket.closed[0] == 1008
