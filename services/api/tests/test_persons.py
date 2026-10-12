"""The persons watchlist: enrolment, four-eyes approval, what is refused, what
is audited, and how a face match becomes an alarm.

These run over HTTP against the live database, object store and Redis, like
the watchlist tests, and enrol real faces with the real models: a reference cut
from the persons demonstration clip (`make videos`) by the same detector the
cameras use. Without that clip the tests that need a face are skipped and say
why; the rest still run.

Every entry a test creates carries a `TEST/PERSONS/` case reference and is
removed, with its photo and its alarms, when the test ends.
"""

from __future__ import annotations

import json
import uuid
from collections.abc import AsyncIterator
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

import numpy as np
import pytest
from httpx import AsyncClient
from sqlalchemy import delete, select, update
from sqlalchemy.exc import IntegrityError

from app.core.config import settings
from app.db.session import SessionLocal
from app.models.enums import AlertStatus, AlertType
from app.models.intelligence import Alert
from app.models.persons import PersonEntry
from app.models.registry import Camera
from app.models.security import AuditLog
from app.services import event_tailer, fleet_roster, person_media, persons
from app.services.event_consumer import EventConsumer

pytestmark = pytest.mark.integration

CLIP = Path("/data/videos/persons_demo.mp4")
CASE_PREFIX = "TEST/PERSONS/"


# ── reference photos, cut from the demo clip by the cameras' detector ─
def _frame(at_fraction: float = 1.0) -> np.ndarray:
    import cv2

    if not CLIP.is_file():
        pytest.skip("persons_demo.mp4 is not fetched (make videos); no real face to enrol")
    capture = cv2.VideoCapture(str(CLIP))
    total = int(capture.get(cv2.CAP_PROP_FRAME_COUNT)) or 1
    capture.set(cv2.CAP_PROP_POS_FRAMES, max(0, int(total * at_fraction) - 2))
    ok, image = capture.read()
    capture.release()
    assert ok, "could not read the demo clip"
    return image


def _jpeg(image: np.ndarray) -> bytes:
    import cv2

    ok, data = cv2.imencode(".jpg", image, [int(cv2.IMWRITE_JPEG_QUALITY), 92])
    assert ok
    return data.tobytes()


def _one_face_photo(index: int = 1) -> bytes:
    """Head and shoulders of one of the three people walking toward the camera
    (0 left, 1 middle, 2 right), from the clip's last frame."""
    from ailab.face.models import FaceModels

    image = _frame()
    faces = sorted(FaceModels(settings.face_models_dir).detect(image), key=lambda f: f.cx)
    assert len(faces) == 3, f"expected the clip's three faces, found {len(faces)}"
    face = faces[index]
    pad_x, pad_y = int(face.w * 1.4), int(face.h * 1.6)
    x1, y1 = max(0, int(face.x) - pad_x), max(0, int(face.y) - pad_y)
    x2 = min(image.shape[1], int(face.x + face.w) + pad_x)
    y2 = min(image.shape[0], int(face.y + face.h) + pad_y)
    return _jpeg(image[y1:y2, x1:x2])


@pytest.fixture(autouse=True)
async def _remove_test_entries() -> AsyncIterator[None]:
    """Delete every entry a test enrolled — its alarms, its photo, the row —
    however the test ended, and republish the gallery without them."""
    yield
    async with SessionLocal() as session:
        entries = (
            (
                await session.execute(
                    select(PersonEntry).where(PersonEntry.case_ref.like(f"{CASE_PREFIX}%"))
                )
            )
            .scalars()
            .all()
        )
        ids = [e.id for e in entries]
        keys = [e.photo_key for e in entries if e.photo_key]
        if ids:
            crops = (
                (
                    await session.execute(
                        select(Alert.face_crop_key).where(
                            Alert.person_id.in_(ids), Alert.face_crop_key.is_not(None)
                        )
                    )
                )
                .scalars()
                .all()
            )
            keys.extend(k for k in crops if k)
            await session.execute(delete(Alert).where(Alert.person_id.in_(ids)))
            await session.execute(delete(PersonEntry).where(PersonEntry.id.in_(ids)))
        await session.commit()
    for key in keys:
        await person_media.delete_object(key)
    await persons.publish_gallery()


def _case() -> str:
    return f"{CASE_PREFIX}{uuid.uuid4().hex[:8].upper()}"


async def _enrol(
    client: AsyncClient,
    headers: dict[str, str],
    photo: bytes,
    *,
    case_ref: str | None = None,
    **fields: Any,
) -> Any:
    data = {
        "display_name": "Test entry",
        "category": "demo",
        "case_ref": case_ref or _case(),
        "purpose": "Automated test of the persons watchlist; fictional entry.",
        "valid_days": "1",
        **fields,
    }
    return await client.post(
        "/api/v1/persons",
        headers=headers,
        data=data,
        files={"photo": ("reference.jpg", photo, "image/jpeg")},
    )


async def _audit(action: str, entry_id: str | None = None) -> list[AuditLog]:
    async with SessionLocal() as session:
        query = select(AuditLog).where(AuditLog.action == action)
        if entry_id is not None:
            query = query.where(AuditLog.resource_id == entry_id)
        return list((await session.execute(query.order_by(AuditLog.ts.desc()).limit(20))).scalars())


async def _active_entry(client: AsyncClient, auth_headers: Any, index: int = 1) -> dict[str, Any]:
    """Enrolled by the supervisor, approved by the admin: four-eyes, done right."""
    enrolled = await _enrol(client, await auth_headers("supervisor"), _one_face_photo(index))
    assert enrolled.status_code == 201, enrolled.text
    approved = await client.post(
        f"/api/v1/persons/{enrolled.json()['id']}/approve", headers=await auth_headers("admin")
    )
    assert approved.status_code == 200, approved.text
    body: dict[str, Any] = approved.json()
    return body


# ── who may do what ───────────────────────────────────────────────────
class TestPermissions:
    async def test_an_operator_may_look_but_not_enrol(
        self, client: AsyncClient, auth_headers
    ) -> None:
        headers = await auth_headers("operator")
        assert (await client.get("/api/v1/persons", headers=headers)).status_code == 200
        response = await client.post(
            "/api/v1/persons",
            headers=headers,
            data={
                "display_name": "x",
                "category": "demo",
                "case_ref": _case(),
                "purpose": "x" * 20,
            },
            files={"photo": ("r.jpg", b"\xff\xd8\xff", "image/jpeg")},
        )
        assert response.status_code == 403
        assert "person.enrol" in response.text

    @pytest.mark.parametrize("role", ["analyst", "auditor"])
    async def test_read_only_roles_can_read(
        self, client: AsyncClient, auth_headers, role: str
    ) -> None:
        assert (
            await client.get("/api/v1/persons", headers=await auth_headers(role))
        ).status_code == 200

    async def test_a_machine_identity_sees_no_face(self, client: AsyncClient, auth_headers) -> None:
        headers = await auth_headers("api_client")
        assert (await client.get("/api/v1/persons", headers=headers)).status_code == 403
        assert (
            await client.get("/api/v1/persons/gallery/status", headers=headers)
        ).status_code == 403


# ── enrolment, and what it refuses ────────────────────────────────────
class TestEnrolment:
    async def test_a_photo_of_nobody_is_refused_and_the_refusal_audited(
        self, client: AsyncClient, auth_headers
    ) -> None:
        case = _case()
        blank = _jpeg(np.full((480, 360, 3), 200, dtype=np.uint8))
        response = await _enrol(client, await auth_headers("supervisor"), blank, case_ref=case)
        assert response.status_code == 422
        assert "No face" in response.json()["detail"]
        rows = [r for r in await _audit("person.enrol") if (r.params or {}).get("case_ref") == case]
        assert rows and rows[0].result == "denied"
        assert rows[0].params["refused"] == "no_face"

    async def test_a_photo_of_several_people_is_refused(
        self, client: AsyncClient, auth_headers
    ) -> None:
        crowd = _jpeg(_frame())
        response = await _enrol(client, await auth_headers("supervisor"), crowd)
        assert response.status_code == 422
        assert "3 faces" in response.json()["detail"]
        assert "exactly one person" in response.json()["detail"]

    async def test_something_that_is_not_an_image_is_refused_by_its_bytes(
        self, client: AsyncClient, auth_headers
    ) -> None:
        response = await _enrol(client, await auth_headers("supervisor"), b"GIF89a not a photo")
        assert response.status_code == 422
        assert "JPEG or PNG" in response.json()["detail"]

    async def test_a_purpose_is_required(self, client: AsyncClient, auth_headers) -> None:
        response = await _enrol(
            client, await auth_headers("supervisor"), b"\xff\xd8\xff", purpose="   "
        )
        assert response.status_code == 422

    async def test_an_entry_cannot_be_held_longer_than_the_maximum(
        self, client: AsyncClient, auth_headers
    ) -> None:
        response = await _enrol(
            client,
            await auth_headers("supervisor"),
            b"\xff\xd8\xff",
            valid_days=str(settings.person_max_valid_days + 1),
        )
        assert response.status_code == 422
        assert "at most" in response.json()["detail"]

    async def test_a_good_photo_enrols_pending_and_shows_no_embedding(
        self, client: AsyncClient, auth_headers
    ) -> None:
        case = _case()
        response = await _enrol(
            client, await auth_headers("supervisor"), _one_face_photo(), case_ref=case
        )
        assert response.status_code == 201, response.text
        body = response.json()
        assert body["status"] == "pending_approval"
        assert body["matchable"] is False
        assert body["enrolled_by_username"] == "supervisor"
        assert body["enrol_quality"]["face_px"] >= settings.person_min_face_px
        assert "embeddings" not in body
        assert "photo_key" not in body

        # Stored privately, re-encoded, with its embedding — and audited.
        async with SessionLocal() as session:
            entry = await session.get(PersonEntry, uuid.UUID(body["id"]))
        assert entry is not None and entry.embeddings and len(entry.embeddings) == 1
        assert entry.photo_key and entry.photo_key.startswith(f"persons/{entry.id}/")
        rows = await _audit("person.enrol", body["id"])
        assert rows and rows[0].result == "success" and rows[0].params["case_ref"] == case
        # One row for the enrolment, not the middleware's generic one beside it.
        assert not [r for r in await _audit("person.create") if r.resource_id == body["id"]]


# ── four-eyes ─────────────────────────────────────────────────────────
class TestFourEyes:
    async def test_the_enroller_cannot_approve_and_is_audited_trying(
        self, client: AsyncClient, auth_headers
    ) -> None:
        headers = await auth_headers("supervisor")
        enrolled = await _enrol(client, headers, _one_face_photo())
        entry_id = enrolled.json()["id"]
        assert enrolled.json()["can_review"] is False

        refused = await client.post(f"/api/v1/persons/{entry_id}/approve", headers=headers)
        assert refused.status_code == 403
        assert "Four-eyes" in refused.json()["detail"]
        rows = await _audit("person.approve", entry_id)
        assert rows and rows[0].result == "denied"
        assert rows[0].params["refused"] == "four_eyes"

    async def test_a_second_account_approves_and_matching_starts(
        self, client: AsyncClient, auth_headers
    ) -> None:
        enrolled = await _enrol(client, await auth_headers("supervisor"), _one_face_photo())
        entry_id = enrolled.json()["id"]
        listed = await client.get(
            "/api/v1/persons",
            params={"status": "pending_approval"},
            headers=await auth_headers("admin"),
        )
        assert any(i["id"] == entry_id and i["can_review"] for i in listed.json()["items"])

        approved = await client.post(
            f"/api/v1/persons/{entry_id}/approve", headers=await auth_headers("admin")
        )
        assert approved.status_code == 200, approved.text
        body = approved.json()
        assert body["status"] == "active" and body["matchable"] is True
        assert body["approved_by_username"] == "admin"

        # Published to the cameras at once: ids and embeddings, no photo, no name.
        import redis.asyncio as aioredis

        client_r = aioredis.from_url(settings.redis_url, decode_responses=True)
        try:
            raw = await client_r.get(persons.GALLERY_KEY)
        finally:
            await client_r.aclose()
        payload = json.loads(raw)
        assert entry_id in {e["person_id"] for e in payload["entries"]}
        assert "Test entry" not in raw and "photo" not in raw
        assert (await _audit("person.approve", entry_id))[0].result == "success"

    async def test_the_database_refuses_self_approval_too(
        self, client: AsyncClient, auth_headers
    ) -> None:
        """A future code path that forgets the API's check still cannot do it."""
        enrolled = await _enrol(client, await auth_headers("supervisor"), _one_face_photo())
        entry_id = uuid.UUID(enrolled.json()["id"])
        async with SessionLocal() as session:
            with pytest.raises(IntegrityError):
                await session.execute(
                    update(PersonEntry)
                    .where(PersonEntry.id == entry_id)
                    .values(approved_by=PersonEntry.enrolled_by, status="active")
                )
                await session.commit()

    async def test_a_rejection_needs_a_reason_and_destroys_the_embedding(
        self, client: AsyncClient, auth_headers
    ) -> None:
        enrolled = await _enrol(client, await auth_headers("supervisor"), _one_face_photo())
        entry_id = enrolled.json()["id"]
        admin = await auth_headers("admin")
        without = await client.post(f"/api/v1/persons/{entry_id}/reject", headers=admin, json={})
        assert without.status_code == 422

        rejected = await client.post(
            f"/api/v1/persons/{entry_id}/reject",
            headers=admin,
            json={"reason": "Reference photo is not the person named in the case file"},
        )
        assert rejected.status_code == 200, rejected.text
        assert rejected.json()["status"] == "rejected"
        async with SessionLocal() as session:
            entry = await session.get(PersonEntry, uuid.UUID(entry_id))
        assert entry is not None and entry.embeddings is None
        assert (await _audit("person.reject", entry_id))[0].params["reason"].startswith("Reference")


# ── retiring and reading ──────────────────────────────────────────────
class TestRetireAndRead:
    async def test_retiring_stops_matching_at_once(self, client: AsyncClient, auth_headers) -> None:
        entry = await _active_entry(client, auth_headers)
        retired = await client.post(
            f"/api/v1/persons/{entry['id']}/retire",
            headers=await auth_headers("supervisor"),
            json={"reason": "Found safe; case closed"},
        )
        assert retired.status_code == 200, retired.text
        assert retired.json()["status"] == "retired" and retired.json()["matchable"] is False
        async with SessionLocal() as session:
            gallery = await persons.build_gallery(session)
            stored = await session.get(PersonEntry, uuid.UUID(entry["id"]))
        assert entry["id"] not in {e["person_id"] for e in gallery["entries"]}
        assert stored is not None and stored.embeddings is None
        assert (await _audit("person.retire", entry["id"]))[0].params["was"] == "active"

    async def test_every_photo_a_list_shows_is_named_in_its_audit_row(
        self, client: AsyncClient, auth_headers
    ) -> None:
        entry = await _active_entry(client, auth_headers)
        listed = await client.get("/api/v1/persons", headers=await auth_headers("analyst"))
        assert listed.status_code == 200
        item = next(i for i in listed.json()["items"] if i["id"] == entry["id"])
        assert item["photo_url"] and settings.minio_persons_bucket in item["photo_url"]
        assert "X-Amz-Signature" in item["photo_url"]
        row = (await _audit("person.list"))[0]
        assert row.username == "analyst"
        assert entry["id"] in row.params["photos_issued"]

        viewed = await client.get(
            f"/api/v1/persons/{entry['id']}", headers=await auth_headers("auditor")
        )
        assert viewed.status_code == 200 and viewed.json()["photo_url"]
        view_row = (await _audit("person.view", entry["id"]))[0]
        assert view_row.username == "auditor" and view_row.params["photo_issued"] is True


# ── a match, from the edge, to an alarm ───────────────────────────────
def _match_event(person_id: str, camera_code: str, **match: Any) -> dict[str, Any]:
    return {
        "schema": "ailab.person.match.v1",
        "event": "person.match",
        "event_id": uuid.uuid4().hex,
        "event_time": datetime.now(UTC).isoformat(),
        "captured_at": datetime.now(UTC).isoformat(),
        "source": {"camera_id": camera_code},
        "person": {"id": person_id, "category": "demo", "case_ref": "edge copy"},
        "match": {
            "similarity": 0.71,
            "similarity_mean": 0.68,
            "threshold": 0.45,
            "model_threshold": 0.363,
            "frames_agreed": 3,
            "frames_required": 2,
            "frames_seen": 4,
            "margin": 0.52,
            "window_s": 1.0,
            "model": "sface_2021dec",
            "gallery_version": "test",
            **match,
        },
        "face": {"bbox": [1, 2, 3, 4], "detector_score": 0.93, "size_px": 96},
        "evidence": {"face_crop": f"faces/2026/10/12/{camera_code}/{uuid.uuid4().hex}.jpg"},
    }


@pytest.fixture
async def faces_camera() -> AsyncIterator[tuple[uuid.UUID, str]]:
    code = f"CAM-TEST-FACE-{uuid.uuid4().hex[:6].upper()}"
    async with SessionLocal() as session:
        camera = Camera(
            camera_code=code,
            name=f"Test {code}",
            district="TEST",
            location="SRID=4326;POINT(72.5 23.0)",
            status="unknown",
            anpr_enabled=False,
            tags=["analytics:faces"],
        )
        session.add(camera)
        await session.commit()
        camera_id = camera.id
    yield camera_id, code
    async with SessionLocal() as session:
        await session.execute(delete(Alert).where(Alert.camera_id == camera_id))
        await session.execute(delete(Camera).where(Camera.id == camera_id))
        await session.commit()


@pytest.fixture
def published(monkeypatch: pytest.MonkeyPatch) -> list[dict[str, Any]]:
    """Capture what would go out on the live alert channel, so a test alarm
    never reaches an operator's screen."""
    sent: list[dict[str, Any]] = []

    async def capture(payload: dict[str, Any]) -> None:
        sent.append(payload)

    monkeypatch.setattr("app.services.event_consumer.alert_fanout.publish", capture)
    return sent


class TestMatchToAlarm:
    async def test_a_match_becomes_a_high_possible_match_alarm_with_its_reasons(
        self, client: AsyncClient, auth_headers, faces_camera, published
    ) -> None:
        camera_id, code = faces_camera
        entry = await _active_entry(client, auth_headers)
        consumer = EventConsumer()
        await consumer._raise_person_matches([_match_event(entry["id"], code)])

        async with SessionLocal() as session:
            alerts = list(
                (await session.execute(select(Alert).where(Alert.camera_id == camera_id))).scalars()
            )
        assert len(alerts) == 1
        alert = alerts[0]
        assert alert.alert_type == AlertType.PERSON_MATCH.value
        assert alert.priority == "high"
        assert alert.status == AlertStatus.NEW.value
        assert str(alert.person_id) == entry["id"]
        assert alert.similarity == pytest.approx(0.71)
        assert alert.face_crop_key and alert.face_crop_key.startswith("faces/")
        factors = [r["factor"] for r in alert.reasons or []]
        assert factors == [
            "face_similarity",
            "frames_agreed",
            "next_closest_entry",
            "watchlist_entry",
        ]
        assert "0.71" in (alert.reasons or [])[0]["detail"]
        assert "0.45" in (alert.reasons or [])[0]["detail"]
        assert "3 analysed frames" in (alert.reasons or [])[1]["detail"]

        # Announced live — without the entry's name or any photograph.
        assert len(published) == 1
        payload = published[0]
        assert payload["alert_type"] == "person_match" and payload["person"]["id"] == entry["id"]
        text = json.dumps(payload)
        assert "Test entry" not in text
        assert "X-Amz" not in text and "faces/" not in text and "persons/" not in text

    async def test_a_repeat_at_the_same_camera_folds_into_the_first(
        self, client: AsyncClient, auth_headers, faces_camera, published
    ) -> None:
        camera_id, code = faces_camera
        entry = await _active_entry(client, auth_headers)
        consumer = EventConsumer()
        await consumer._raise_person_matches([_match_event(entry["id"], code)])
        await consumer._raise_person_matches(
            [_match_event(entry["id"], code), _match_event(entry["id"], code)]
        )
        async with SessionLocal() as session:
            count = len(
                list(
                    (
                        await session.execute(select(Alert.id).where(Alert.camera_id == camera_id))
                    ).scalars()
                )
            )
        assert count == 1
        assert consumer.person_matches == 3 and consumer.person_alerts == 1

    @pytest.mark.parametrize(
        ("override", "why"),
        [
            ({"similarity": 0.40}, "below the platform threshold"),
            ({"frames_agreed": 1}, "one frame is not agreement"),
            ({"margin": 0.01}, "too close to another entry"),
            ({"model": "another_model"}, "a different embedding space"),
        ],
    )
    async def test_the_platform_applies_its_own_policy_to_what_the_edge_claims(
        self, client: AsyncClient, auth_headers, faces_camera, published, override, why
    ) -> None:
        camera_id, code = faces_camera
        entry = await _active_entry(client, auth_headers)
        await EventConsumer()._raise_person_matches([_match_event(entry["id"], code, **override)])
        async with SessionLocal() as session:
            raised = (
                await session.execute(select(Alert.id).where(Alert.camera_id == camera_id))
            ).first()
        assert raised is None, why
        assert published == []

    async def test_a_match_on_a_retired_entry_raises_nothing(
        self, client: AsyncClient, auth_headers, faces_camera, published
    ) -> None:
        camera_id, code = faces_camera
        entry = await _active_entry(client, auth_headers)
        await client.post(
            f"/api/v1/persons/{entry['id']}/retire",
            headers=await auth_headers("supervisor"),
            json={"reason": "case closed"},
        )
        await EventConsumer()._raise_person_matches([_match_event(entry["id"], code)])
        async with SessionLocal() as session:
            assert (
                await session.execute(select(Alert.id).where(Alert.camera_id == camera_id))
            ).first() is None

    async def test_the_alarm_list_shows_no_face_and_the_evidence_view_is_audited(
        self, client: AsyncClient, auth_headers, faces_camera, published
    ) -> None:
        camera_id, code = faces_camera
        entry = await _active_entry(client, auth_headers)
        await EventConsumer()._raise_person_matches([_match_event(entry["id"], code)])

        listed = await client.get(
            "/api/v1/alerts",
            params={"camera_id": str(camera_id)},
            headers=await auth_headers("operator"),
        )
        assert listed.status_code == 200
        [item] = listed.json()["items"]
        assert item["alert_type"] == "person_match"
        text = json.dumps(item)
        assert "faces/" not in text and "Test entry" not in text and "X-Amz" not in text

        evidence = await client.get(
            f"/api/v1/persons/matches/{item['id']}", headers=await auth_headers("operator")
        )
        assert evidence.status_code == 200, evidence.text
        body = evidence.json()
        assert body["person"]["id"] == entry["id"] and body["person"]["photo_url"]
        assert body["face_url"] and settings.minio_persons_bucket in body["face_url"]
        assert body["similarity"] == pytest.approx(0.71)
        assert body["frames_agreed"] == 3 and body["frames_required"] == 2
        assert "must compare the two faces" in body["notice"]
        row = (await _audit("person.match_view", entry["id"]))[0]
        assert row.username == "operator"
        assert row.params["alert_id"] == item["id"]
        assert set(row.params["photos_issued"]) == {"reference", "captured"}

        refused = await client.get(
            f"/api/v1/persons/matches/{item['id']}", headers=await auth_headers("api_client")
        )
        assert refused.status_code == 403

    async def test_a_person_match_ranks_with_watchlist_hits_in_triage(
        self, client: AsyncClient, auth_headers, faces_camera
    ) -> None:
        """Same severity: a face matched to an approved entry, like a known
        plate read now, before a camera that has gone dark."""
        camera_id, _code = faces_camera
        now = datetime.now(UTC)
        async with SessionLocal() as session:
            for kind, minutes in (
                (AlertType.CAMERA_DOWN.value, 1),
                (AlertType.PERSON_MATCH.value, 30),
                (AlertType.WATCHLIST_HIT.value, 20),
            ):
                session.add(
                    Alert(
                        alert_type=kind,
                        priority="high",
                        status=AlertStatus.NEW.value,
                        camera_id=camera_id,
                        created_at=now - timedelta(minutes=minutes),
                    )
                )
            await session.commit()
        response = await client.get(
            "/api/v1/alerts",
            params={"camera_id": str(camera_id), "sort": "priority"},
            headers=await auth_headers("operator"),
        )
        kinds = [i["alert_type"] for i in response.json()["items"]]
        assert kinds == ["watchlist_hit", "person_match", "camera_down"]


# ── the plumbing around it ────────────────────────────────────────────
class TestPlumbing:
    async def test_an_expired_entry_is_retired_by_the_platform(
        self, client: AsyncClient, auth_headers
    ) -> None:
        entry = await _active_entry(client, auth_headers)
        async with SessionLocal() as session:
            await session.execute(
                update(PersonEntry)
                .where(PersonEntry.id == uuid.UUID(entry["id"]))
                .values(valid_until=datetime.now(UTC) - timedelta(minutes=1))
            )
            await session.commit()
            expired = await persons.expire_due(session)
            await session.commit()
        assert entry["id"] in {str(e.id) for e in expired}
        async with SessionLocal() as session:
            stored = await session.get(PersonEntry, uuid.UUID(entry["id"]))
        assert stored is not None
        assert stored.status == "retired" and stored.retired_by is None
        assert stored.embeddings is None
        assert "expired" in (stored.retired_reason or "")

    def test_a_raw_match_event_never_reaches_the_live_feed(self) -> None:
        """Every signed-in role hears the live feed; a face is for
        `person.read` alone. Operators learn of a match from its alarm."""
        assert "person.match" in event_tailer.PRIVATE_EVENTS

    def test_only_a_camera_tagged_for_faces_is_given_the_face_stage(self) -> None:
        tagged = Camera(camera_code="X", anpr_enabled=False, tags=["analytics:faces"])
        junction = Camera(camera_code="Y", anpr_enabled=True, tags=["arterial"])
        assert fleet_roster.analytics(tagged) == ["faces"]
        assert fleet_roster.analytics(junction) == ["anpr"]

    async def test_the_persons_bucket_is_private(self) -> None:
        """No anonymous policy on the bucket that holds faces."""
        await person_media.ensure_bucket()
        import httpx

        async with httpx.AsyncClient(timeout=5.0) as http:
            response = await http.get(f"{settings.minio_url}/{settings.minio_persons_bucket}/")
        assert response.status_code == 403
