"""The persons watchlist's face stage: when a face becomes a possible match, and
what is never kept when it does not.

Most of this runs on fakes — a detector that returns boxes it was told to, an
embedder that returns vectors it was told to — because the properties that
matter are about the *rules*: the threshold, agreement across frames, the
margin over the next-closest entry, the cooldown, and that a face matching
nothing never has its crop taken. The last group loads the real YuNet and
SFace models when they have been fetched, to pin that they are built inside the
CPU thread budget.
"""

from __future__ import annotations

import json
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

import numpy as np
import pytest

from ailab import runtime
from ailab.config import FaceConfig
from ailab.face.enrol import EnrolmentRefused, enrol_image, image_dimensions
from ailab.face.events import SCHEMA_PERSON_MATCH, person_match_event
from ailab.face.gallery import (
    EMPTY_GALLERY,
    Gallery,
    GalleryEntry,
    GalleryMatch,
    MatchPolicy,
    build_payload,
    decode_embedding,
    encode_embedding,
)
from ailab.face.matching import FaceObservation, FaceWatch
from ailab.face.models import EMBEDDING_DIM, SFACE_MODEL_ID, FaceBox
from ailab.face.stage import FaceStage, face_crop

MODELS_DIR = Path(__file__).resolve().parent.parent / "models"
HAVE_MODELS = (MODELS_DIR / "face_detection_yunet_2023mar.onnx").is_file() and (
    MODELS_DIR / "face_recognition_sface_2021dec.onnx"
).is_file()


# ── helpers ───────────────────────────────────────────────────────────
def unit(seed: int) -> np.ndarray:
    """A deterministic unit vector."""
    vector = np.random.default_rng(seed).normal(size=EMBEDDING_DIM).astype(np.float32)
    return vector / np.linalg.norm(vector)


def towards(target: np.ndarray, similarity: float, seed: int = 99) -> np.ndarray:
    """A unit vector whose cosine similarity to `target` is exactly `similarity`."""
    noise = unit(seed)
    noise = noise - float(noise @ target) * target
    noise /= np.linalg.norm(noise)
    vector = similarity * target + np.sqrt(max(0.0, 1.0 - similarity**2)) * noise
    return (vector / np.linalg.norm(vector)).astype(np.float32)


def entry(person: str, vector: np.ndarray, valid_until: datetime | None = None) -> GalleryEntry:
    return GalleryEntry(
        person_id=person,
        category="demo",
        case_ref=f"DEMO/{person}",
        valid_until=valid_until,
        embeddings=vector.reshape(1, -1),
    )


def box(x: float, y: float = 100.0, size: float = 80.0) -> FaceBox:
    return FaceBox(x=x, y=y, w=size, h=size, landmarks=(0.0,) * 10, score=0.95)


def observation(face: FaceBox, person: GalleryEntry | None, similarity: float,
                runner_up: float | None = None) -> FaceObservation:
    match = (
        None
        if person is None
        else GalleryMatch(entry=person, similarity=similarity, runner_up=runner_up)
    )
    return FaceObservation(box=face, match=match)


ALICE = entry("alice", unit(1))
BOB = entry("bob", unit(2))


# ── the gallery ───────────────────────────────────────────────────────
class TestGallery:
    def test_an_embedding_survives_the_wire_exactly(self) -> None:
        vector = unit(7)
        assert np.array_equal(decode_embedding(encode_embedding(vector)), vector)

    @pytest.mark.parametrize(
        "text",
        [
            encode_embedding(unit(1))[:-8],  # truncated
            "not base64!",
        ],
    )
    def test_a_damaged_embedding_is_refused(self, text: str) -> None:
        with pytest.raises(ValueError):
            decode_embedding(text)

    def test_a_vector_of_zeros_is_refused_rather_than_matching_nothing_quietly(self) -> None:
        zeros = np.zeros(EMBEDDING_DIM, dtype=np.float32)
        with pytest.raises(ValueError):
            decode_embedding(encode_embedding(zeros))

    def test_the_nearest_entry_and_its_lead_over_the_next(self) -> None:
        gallery = Gallery([ALICE, BOB])
        face = towards(ALICE.embeddings[0], 0.8)
        match = gallery.best(face)
        assert match is not None
        assert match.entry.person_id == "alice"
        assert match.similarity == pytest.approx(0.8, abs=1e-5)
        assert match.runner_up == pytest.approx(float(face @ BOB.embeddings[0]), abs=1e-5)
        assert match.margin == pytest.approx(match.similarity - match.runner_up, abs=1e-6)

    def test_an_expired_entry_is_not_matched_even_before_the_next_publish(self) -> None:
        lapsed = entry("carol", unit(3), valid_until=datetime.now(UTC) - timedelta(minutes=1))
        gallery = Gallery([lapsed])
        assert gallery.best(lapsed.embeddings[0]) is None

    def test_payload_round_trip_carries_ids_policy_and_no_photo(self) -> None:
        now = datetime.now(UTC)
        payload = build_payload(
            [
                {
                    "person_id": "alice",
                    "category": "missing",
                    "case_ref": "MP/1",
                    "valid_until": now + timedelta(days=30),
                    "embeddings": [encode_embedding(ALICE.embeddings[0])],
                }
            ],
            version="v1",
            policy=MatchPolicy(threshold=0.5, min_frames=3, min_margin=0.1),
            published_at=now,
            expires_at=now + timedelta(minutes=15),
        )
        text = json.dumps(payload)
        assert "photo" not in text and "display_name" not in text
        gallery = Gallery.from_payload(json.loads(text))
        assert len(gallery) == 1
        assert gallery.policy == MatchPolicy(threshold=0.5, min_frames=3, min_margin=0.1)
        assert gallery.entries[0].case_ref == "MP/1"
        assert not gallery.is_expired(now)
        assert gallery.is_expired(now + timedelta(minutes=16))

    def test_an_unreadable_entry_is_skipped_not_guessed(self) -> None:
        now = datetime.now(UTC)
        payload = build_payload(
            [
                {"person_id": "good", "embeddings": [encode_embedding(unit(1))]},
                {"person_id": "bad", "embeddings": ["AAAA"]},
                {"person_id": "empty", "embeddings": []},
            ],
            version="v2",
            policy=MatchPolicy(),
            published_at=now,
            expires_at=now + timedelta(minutes=5),
        )
        assert [e.person_id for e in Gallery.from_payload(payload).entries] == ["good"]

    def test_a_gallery_from_another_model_matches_nothing(self) -> None:
        payload = {
            "schema": "contrail.persons.gallery.v1",
            "model": "some_other_model",
            "entries": [{"person_id": "x", "embeddings": [encode_embedding(unit(1))]}],
        }
        assert Gallery.from_payload(payload, model=SFACE_MODEL_ID).is_empty

    def test_the_stricter_policy_wins_setting_by_setting(self) -> None:
        a = MatchPolicy(threshold=0.5, min_frames=2, min_margin=0.02)
        b = MatchPolicy(threshold=0.4, min_frames=3, min_margin=0.08)
        assert a.stricter(b) == MatchPolicy(threshold=0.5, min_frames=3, min_margin=0.08)


# ── agreement across frames ───────────────────────────────────────────
class TestFaceWatch:
    def policy(self, **overrides: Any) -> MatchPolicy:
        return MatchPolicy(**{"threshold": 0.45, "min_frames": 2, "min_margin": 0.05, **overrides})

    def test_one_frame_over_the_threshold_is_not_a_match(self) -> None:
        watch = FaceWatch(self.policy())
        assert watch.observe(0.0, [observation(box(100), ALICE, 0.9)]) == []

    def test_two_frames_of_the_same_face_agreeing_are_announced_once(self) -> None:
        watch = FaceWatch(self.policy())
        crops: list[str] = []
        evidence = lambda o: crops.append("crop") or f"crop-{len(crops)}"  # noqa: E731

        assert watch.observe(0.0, [observation(box(100), ALICE, 0.6)], evidence) == []
        announced = watch.observe(0.5, [observation(box(104), ALICE, 0.7)], evidence)
        assert len(announced) == 1
        match = announced[0]
        assert match.person_id == "alice"
        assert match.frames_agreed == 2
        assert match.similarity == pytest.approx(0.7)
        assert match.similarities == (0.6, 0.7)
        # The best frame's crop travels with the announcement.
        assert match.evidence == "crop-2"

        # Still in view, still matching: said once, not every frame.
        assert watch.observe(1.0, [observation(box(108), ALICE, 0.75)], evidence) == []

    def test_once_announced_no_further_crop_of_that_face_is_taken(self) -> None:
        watch = FaceWatch(self.policy())
        taken: list[FaceObservation] = []
        for step in range(6):
            watch.observe(
                step * 0.5,
                [observation(box(100), ALICE, 0.6 + step * 0.05)],
                evidence=lambda o: taken.append(o) or "crop",
            )
        # Two candidate frames before the announcement, none after it.
        assert len(taken) == 2
        assert watch.held_evidence == 0

    def test_frames_under_the_threshold_never_have_a_crop_taken(self) -> None:
        """Privacy by design: a face that matches nothing is never cropped."""
        watch = FaceWatch(self.policy())
        taken: list[FaceObservation] = []
        for step in range(10):
            watch.observe(
                step * 0.5,
                [observation(box(100 + step), ALICE, 0.30), observation(box(600), None, 0.0)],
                evidence=lambda o: taken.append(o),
            )
        assert taken == []
        assert watch.held_evidence == 0
        assert watch.stats.candidate_frames == 0

    def test_a_candidate_that_never_agrees_again_is_dropped_with_its_crop(self) -> None:
        watch = FaceWatch(self.policy(), max_gap_s=2.0)
        watch.observe(0.0, [observation(box(100), ALICE, 0.9)], evidence=lambda o: "crop")
        assert watch.held_evidence == 1
        # The face leaves; time passes beyond the gap.
        assert watch.observe(5.0, [], evidence=lambda o: "crop") == []
        assert watch.held_evidence == 0
        assert watch.stats.evidence_released == 1
        assert watch.stats.announced == 0

    def test_only_one_crop_is_held_per_face_however_long_it_stays(self) -> None:
        watch = FaceWatch(self.policy(min_frames=50))
        for step in range(20):
            watch.observe(step * 0.5, [observation(box(100), ALICE, 0.5 + step * 0.01)],
                          evidence=lambda o: object())
        assert watch.held_evidence == 1

    def test_a_best_match_too_close_to_the_runner_up_is_not_a_candidate(self) -> None:
        watch = FaceWatch(self.policy(min_margin=0.10))
        for step in range(4):
            assert watch.observe(
                step * 0.5, [observation(box(100), ALICE, 0.70, runner_up=0.65)]
            ) == []
        assert watch.stats.candidate_frames == 0

    def test_one_face_agreeing_with_two_entries_is_ambiguous_and_silent(self) -> None:
        watch = FaceWatch(self.policy())
        watch.observe(0.0, [observation(box(100), ALICE, 0.6)])
        watch.observe(0.5, [observation(box(102), BOB, 0.6)])
        assert watch.observe(1.0, [observation(box(104), ALICE, 0.7)]) == []
        assert watch.stats.conflicts >= 1

    def test_two_people_side_by_side_are_two_tracks(self) -> None:
        watch = FaceWatch(self.policy())
        watch.observe(0.0, [observation(box(100), ALICE, 0.6), observation(box(900), None, 0.0)])
        announced = watch.observe(
            0.5, [observation(box(104), ALICE, 0.62), observation(box(905), None, 0.0)]
        )
        assert [m.person_id for m in announced] == ["alice"]
        assert watch.live_tracks == 2

    def test_the_same_person_is_not_announced_again_within_the_cooldown(self) -> None:
        watch = FaceWatch(self.policy(), cooldown_s=60.0, max_gap_s=1.0)
        watch.observe(0.0, [observation(box(100), ALICE, 0.6)])
        assert len(watch.observe(0.5, [observation(box(100), ALICE, 0.6)])) == 1
        # They leave, and come back 20 s later: a new track, inside the cooldown.
        watch.observe(20.0, [observation(box(100), ALICE, 0.6)])
        assert watch.observe(20.5, [observation(box(100), ALICE, 0.6)]) == []
        assert watch.stats.suppressed_cooldown == 1
        # And after it: announced again.
        watch.observe(90.0, [observation(box(100), ALICE, 0.6)])
        assert len(watch.observe(90.5, [observation(box(100), ALICE, 0.6)])) == 1

    def test_an_entry_retired_mid_track_cannot_be_announced(self) -> None:
        watch = FaceWatch(self.policy())
        watch.observe(0.0, [observation(box(100), ALICE, 0.9)], evidence=lambda o: "crop")
        watch.retain({"bob"})
        assert watch.held_evidence == 0
        # The retired entry's earlier frame no longer counts toward agreement.
        assert watch.observe(0.5, [observation(box(100), ALICE, 0.9)]) == []

    def test_a_reset_releases_every_crop(self) -> None:
        watch = FaceWatch(self.policy())
        watch.observe(0.0, [observation(box(100), ALICE, 0.9)], evidence=lambda o: "crop")
        watch.reset()
        assert watch.held_evidence == 0
        assert watch.live_tracks == 0


# ── the stage, end to end, on fakes ───────────────────────────────────
class FakeModels:
    """Returns the faces and vectors a test scripts, and counts the calls."""

    def __init__(self, faces: list[FaceBox], vectors: list[np.ndarray]) -> None:
        self.faces = faces
        self.vectors = vectors
        self.detect_calls = 0
        self.embed_calls = 0

    def detect(self, image: np.ndarray) -> list[FaceBox]:
        self.detect_calls += 1
        return list(self.faces)

    def embed(self, image: np.ndarray, face: FaceBox) -> np.ndarray:
        self.embed_calls += 1
        return self.vectors[self.faces.index(face)]


class ListSink:
    def __init__(self) -> None:
        self.events: list[dict[str, Any]] = []

    def emit(self, event: dict[str, Any]) -> None:
        self.events.append(event)


class RecordingStore:
    def __init__(self) -> None:
        self.saved: list[tuple[np.ndarray, str]] = []

    def save_face_crop(self, image: np.ndarray, name: str) -> str | None:
        self.saved.append((image, name))
        return f"faces/2026/10/12/{name}.jpg"


class Source:
    camera_id = "CAM-DEMO-02"

    def to_dict(self) -> dict[str, Any]:
        return {"camera_id": self.camera_id}


def a_gallery(*entries: GalleryEntry) -> Gallery:
    return Gallery(list(entries), version="v1", policy=MatchPolicy())


def frame() -> np.ndarray:
    return np.full((480, 640, 3), 90, dtype=np.uint8)


class TestFaceStage:
    def stage(self, models: FakeModels, gallery: Gallery, **config: Any) -> tuple[FaceStage, ListSink, RecordingStore]:
        sink, store = ListSink(), RecordingStore()
        stage = FaceStage(
            models,
            lambda: gallery,
            sink,
            Source(),
            config=FaceConfig(**config),
            crop_store=store,
            run_id="CAM-DEMO-02.abc",
        )
        return stage, sink, store

    def test_with_no_approved_entry_it_does_not_even_look(self) -> None:
        models = FakeModels([box(100)], [unit(1)])
        stage, sink, _ = self.stage(models, EMPTY_GALLERY)
        for step in range(10):
            stage.process(frame(), t_s=step * 1.0)
        assert models.detect_calls == 0
        assert sink.events == []

    def test_it_looks_at_most_max_fps_times_a_second(self) -> None:
        models = FakeModels([], [])
        stage, _, _ = self.stage(models, a_gallery(ALICE), max_fps=2.0)
        for step in range(30):  # 3 s of 10 fps
            stage.process(frame(), t_s=step * 0.1)
        assert models.detect_calls == 6
        assert stage.stats.skipped_rate == 24

    def test_a_face_too_small_to_compare_is_never_embedded(self) -> None:
        small = box(100, size=30)
        models = FakeModels([small], [towards(ALICE.embeddings[0], 0.9)])
        stage, sink, _ = self.stage(models, a_gallery(ALICE), min_face_px=56)
        for step in range(6):
            stage.process(frame(), t_s=step * 0.5)
        assert models.embed_calls == 0
        assert stage.stats.faces_too_small == 6
        assert sink.events == []

    def test_a_match_over_two_frames_emits_one_event_and_uploads_one_crop(self) -> None:
        face = box(200, size=80)
        stranger = box(450, size=80)
        models = FakeModels(
            [face, stranger], [towards(ALICE.embeddings[0], 0.7), towards(ALICE.embeddings[0], 0.1)]
        )
        stage, sink, store = self.stage(models, a_gallery(ALICE, BOB))
        image = frame()
        captured = datetime(2026, 10, 12, 10, 31, 4, tzinfo=UTC)
        stage.process(image, t_s=0.0, captured_at=captured)
        stage.process(image, t_s=0.5, captured_at=captured, latency_ms=120.0)
        stage.process(image, t_s=1.0, captured_at=captured)

        assert len(sink.events) == 1
        event = sink.events[0]
        assert event["schema"] == SCHEMA_PERSON_MATCH
        assert event["event"] == "person.match"
        assert event["source"] == {"camera_id": "CAM-DEMO-02"}
        assert event["person"] == {"id": "alice", "category": "demo", "case_ref": "DEMO/alice"}
        assert event["match"]["frames_agreed"] == 2
        assert event["match"]["frames_required"] == 2
        assert event["match"]["threshold"] == pytest.approx(0.45)
        assert event["match"]["model_threshold"] == pytest.approx(0.363)
        assert event["match"]["similarity"] == pytest.approx(0.7, abs=1e-3)
        assert event["evidence"]["face_crop"].startswith("faces/")
        assert event["latency_ms"] == pytest.approx(120.0)

        # Exactly one crop left the edge, and it is the matched face's.
        assert len(store.saved) == 1
        crop, name = store.saved[0]
        assert name.startswith("CAM-DEMO-02/")
        assert "alice" not in name
        assert crop.shape[0] < image.shape[0]
        # A copy, never a view that would keep the whole frame alive.
        assert not np.shares_memory(crop, image)

    def test_nothing_about_a_face_reaches_the_event_but_the_claim(self) -> None:
        face = box(200, size=80)
        vector = towards(ALICE.embeddings[0], 0.8)
        models = FakeModels([face], [vector])
        stage, sink, _ = self.stage(models, a_gallery(ALICE))
        stage.process(frame(), t_s=0.0)
        stage.process(frame(), t_s=0.5)
        text = json.dumps(sink.events)
        assert "embedding" not in text
        # No 128-long list of floats anywhere in the payload.
        def lists(node: Any) -> list[list[Any]]:
            if isinstance(node, dict):
                return [x for v in node.values() for x in lists(v)]
            if isinstance(node, list):
                return [node, *[x for v in node for x in lists(v)]]
            return []
        assert all(len(found) < EMBEDDING_DIM for found in lists(sink.events))

    def test_a_stranger_in_view_leaves_no_crop_and_no_event(self) -> None:
        stranger = box(300, size=90)
        models = FakeModels([stranger], [towards(ALICE.embeddings[0], 0.2)])
        stage, sink, store = self.stage(models, a_gallery(ALICE))
        for step in range(20):
            stage.process(frame(), t_s=step * 0.5)
        assert sink.events == []
        assert store.saved == []
        assert stage.watch.held_evidence == 0
        assert stage.stats.faces_compared == 20

    def test_the_platform_policy_can_tighten_the_camera_but_not_loosen_it(self) -> None:
        face = box(200, size=80)
        models = FakeModels([face], [towards(ALICE.embeddings[0], 0.5)])
        strict = Gallery([ALICE], version="v9", policy=MatchPolicy(threshold=0.6))
        stage, sink, _ = self.stage(models, strict, threshold=0.45)
        for step in range(6):
            stage.process(frame(), t_s=step * 0.5)
        assert sink.events == []
        assert stage.watch.policy.threshold == pytest.approx(0.6)

        loose = Gallery([ALICE], version="v10", policy=MatchPolicy(threshold=0.2))
        stage2, _, _ = self.stage(models, loose, threshold=0.45)
        stage2.process(frame(), t_s=0.0)
        assert stage2.watch.policy.threshold == pytest.approx(0.45)


class TestFaceCrop:
    def test_the_crop_is_bounded_and_padded(self) -> None:
        image = np.zeros((1080, 1920, 3), dtype=np.uint8)
        crop = face_crop(image, box(900, 400, size=100), margin=0.25, max_side=4000)
        assert crop.shape[:2] == (150, 150)

    def test_the_crop_stops_at_the_frame_edge(self) -> None:
        image = np.zeros((200, 200, 3), dtype=np.uint8)
        crop = face_crop(image, box(-20, -20, size=60), margin=0.25, max_side=4000)
        assert crop.shape[0] > 0 and crop.shape[1] > 0
        assert crop.shape[0] <= 55 and crop.shape[1] <= 55


class TestEvent:
    def test_the_event_names_the_claim_and_its_working(self) -> None:
        watch = FaceWatch(MatchPolicy())
        watch.observe(0.0, [observation(box(100), ALICE, 0.6, runner_up=0.1)], lambda o: "c")
        [match] = watch.observe(0.5, [observation(box(101), ALICE, 0.7, runner_up=0.2)], lambda o: "c")
        event = person_match_event(
            match,
            {"camera_id": "CAM-DEMO-02"},
            captured_at=None,
            frame_size=(1920, 1080),
            face_crop_key="faces/x.jpg",
            gallery_version="v1",
        )
        assert event["match"]["margin"] == pytest.approx(0.5)
        assert event["match"]["frames_seen"] == 2
        assert event["frame"] == {"width": 1920, "height": 1080}
        assert event["face"]["size_px"] == 80.0


# ── enrolment input handling (no models needed) ───────────────────────
class TestImageHeaders:
    def test_png_dimensions_come_from_the_header(self) -> None:
        import cv2

        ok, data = cv2.imencode(".png", np.zeros((48, 64, 3), dtype=np.uint8))
        assert ok
        assert image_dimensions(data.tobytes()) == ("png", 64, 48)

    def test_jpeg_dimensions_come_from_the_header(self) -> None:
        import cv2

        ok, data = cv2.imencode(".jpg", np.zeros((120, 90, 3), dtype=np.uint8))
        assert ok
        assert image_dimensions(data.tobytes()) == ("jpeg", 90, 120)

    def test_anything_else_is_refused_by_its_bytes_not_its_name(self) -> None:
        with pytest.raises(EnrolmentRefused) as refused:
            image_dimensions(b"GIF89a....")
        assert refused.value.code == "unsupported_format"

    def test_a_pixel_bomb_is_refused_before_it_is_decoded(self) -> None:
        # A PNG header claiming 20000 x 20000 and nothing behind it: decoding
        # it is never attempted, so its missing body never matters.
        header = b"\x89PNG\r\n\x1a\n" + b"\x00\x00\x00\x0dIHDR" + (20000).to_bytes(4, "big") * 2
        with pytest.raises(EnrolmentRefused) as refused:
            enrol_image(object(), header + b"\x08\x02\x00\x00\x00")  # type: ignore[arg-type]
        assert refused.value.code == "too_many_pixels"


# ── the real models, when they have been fetched ──────────────────────
@pytest.mark.skipif(not HAVE_MODELS, reason="face models not fetched (scripts/fetch_models.sh)")
class TestRealModels:
    def test_they_are_built_inside_the_thread_budget(self, monkeypatch: pytest.MonkeyPatch) -> None:
        """CLAUDE.md trap 4: no inference engine sizes its own thread pool.

        OpenCV DNN runs on OpenCV's process-wide pool, so the budget for these
        models is whatever `ailab.runtime` says OpenCV may use — one thread
        when several cameras share the process.
        """
        import cv2

        from ailab.face.models import FaceModels

        monkeypatch.setattr(runtime, "_concurrency", 4)
        models = FaceModels(MODELS_DIR)
        assert models.threads == runtime.opencv_threads() == 1
        assert cv2.getNumThreads() == 1

    def test_a_frame_with_no_one_in_it_has_no_faces(self) -> None:
        from ailab.face.models import FaceModels

        models = FaceModels(MODELS_DIR, detect_max_side=640)
        assert models.detect(np.full((720, 1280, 3), 128, dtype=np.uint8)) == []

    def test_enrolling_a_photo_of_nobody_is_refused_with_a_reason(self) -> None:
        import cv2

        from ailab.face.models import FaceModels

        models = FaceModels(MODELS_DIR)
        ok, data = cv2.imencode(".jpg", np.full((400, 300, 3), 200, dtype=np.uint8))
        assert ok
        with pytest.raises(EnrolmentRefused) as refused:
            enrol_image(models, data.tobytes())
        assert refused.value.code == "no_face"
        assert "No face" in refused.value.message


# ── the stream runner hands frames to the face stage ──────────────────
class _RecordingFaceStage:
    def __init__(self) -> None:
        self.calls: list[tuple[float, datetime | None]] = []
        self.resets = 0

    def process(
        self,
        image: Any,
        *,
        t_s: float,
        captured_at: datetime | None = None,
        latency_ms: float | None = None,
    ) -> list[Any]:
        self.calls.append((t_s, captured_at))
        return []

    def reset(self) -> None:
        self.resets += 1

    def describe(self) -> dict[str, Any]:
        return {"calls": len(self.calls)}


class _NoVehiclePipeline:
    """A pipeline with no detector at all: a faces-only camera must never
    reach for one."""

    def __init__(self) -> None:
        from ailab.types import StageTimer

        self.timer = StageTimer()
        self._tracker = None

    def reset_run_state(self) -> None:
        return None


class _Captured:
    def __init__(self, t_s: float, discontinuity: bool = False) -> None:
        self.image = np.zeros((72, 128, 3), dtype=np.uint8)
        self.source_t_s = t_s
        self.wall_time = datetime(2026, 10, 12, 10, 31, 4, tzinfo=UTC)
        self.discontinuity = discontinuity
        self.age_ms = 40.0


class TestTheRunnerAndTheFaceStage:
    def runner(self, stage: _RecordingFaceStage) -> Any:
        from ailab.config import RunConfig
        from ailab.stream.events import EventSink, SourceIdentity
        from ailab.stream.runner import StreamRunner

        return StreamRunner(
            RunConfig(),
            SourceIdentity(camera_id="CAM-DEMO-02"),
            EventSink(),
            pipeline=_NoVehiclePipeline(),  # type: ignore[arg-type]
            face_stage=stage,
            vehicles=False,
        )

    def test_a_faces_only_camera_runs_no_vehicle_pipeline(self) -> None:
        stage = _RecordingFaceStage()
        runner = self.runner(stage)
        for index in range(3):
            # Would raise AttributeError on the missing detector if the
            # vehicle path ran at all.
            runner._process(_Captured(index * 0.1), index)
        assert [t for t, _ in stage.calls] == [0.0, 0.1, 0.2]
        assert stage.calls[0][1] == datetime(2026, 10, 12, 10, 31, 4, tzinfo=UTC)
        assert runner.sink.written == 0

    def test_a_scene_cut_forgets_the_faces_in_view(self) -> None:
        stage = _RecordingFaceStage()
        runner = self.runner(stage)
        runner._process(_Captured(0.0), 0)
        runner._process(_Captured(5.0, discontinuity=True), 1)
        assert stage.resets == 1
