"""The persons watchlist at the edge: which cameras look for faces, what they
match against, and where a matched face's crop may go.

Run in the shared test image (numpy, no onnxruntime), so these exercise the
worker's own modules — discovery, the gallery cache, the face-model pool and
the crop store — and leave the models themselves to ai-lab's suite.
"""

from __future__ import annotations

import json
from datetime import UTC, datetime, timedelta
from typing import Any

import numpy as np
import pytest
from ailab.face.gallery import MatchPolicy, build_payload, encode_embedding
from redis.exceptions import ConnectionError as RedisConnectionError

from ai_worker.config import settings
from ai_worker.crops import MinioCropStore, bucket_for, face_key, object_key
from ai_worker.discovery import CameraStream, discover_registry
from ai_worker.face_pool import FaceModelsPool
from ai_worker.gallery import GalleryCache


def unit(seed: int) -> np.ndarray:
    vector = np.random.default_rng(seed).normal(size=128).astype(np.float32)
    return vector / np.linalg.norm(vector)


def published(
    entries: int = 1, *, expires_in: timedelta = timedelta(minutes=15)
) -> str:
    now = datetime.now(UTC)
    return json.dumps(
        build_payload(
            [
                {
                    "person_id": f"00000000-0000-0000-0000-00000000000{index}",
                    "category": "demo",
                    "case_ref": f"DEMO/{index}",
                    "valid_until": now + timedelta(days=30),
                    "embeddings": [encode_embedding(unit(index))],
                }
                for index in range(entries)
            ],
            version=f"v{entries}",
            policy=MatchPolicy(threshold=0.5, min_frames=2, min_margin=0.05),
            published_at=now,
            expires_at=now + expires_in,
        )
    )


class FakeRedis:
    def __init__(self, value: Any = None, error: Exception | None = None) -> None:
        self.value = value
        self.error = error
        self.keys: list[str] = []

    async def get(self, name: str, /) -> Any:
        self.keys.append(name)
        if self.error is not None:
            raise self.error
        return self.value

    async def aclose(self) -> None:
        return None


# ── which cameras look ────────────────────────────────────────────────
class TestOnlyTaggedCamerasLookForFaces:
    pytestmark = pytest.mark.asyncio

    async def _discover(
        self, monkeypatch: pytest.MonkeyPatch, cameras: list[dict]
    ) -> list[CameraStream]:
        import redis.asyncio as aioredis

        monkeypatch.setattr(
            aioredis,
            "from_url",
            lambda *a, **k: FakeRedis(json.dumps({"cameras": cameras})),
        )

        async def probe(_host: str, _port: int = 8554, _timeout: float = 4.0) -> bool:
            return True

        monkeypatch.setattr("ai_worker.discovery.rtsp_reachable", probe)
        return await discover_registry("redis://x", 0, 1)

    async def test_a_camera_tagged_for_faces_says_so(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        streams = await self._discover(
            monkeypatch,
            [
                {
                    "camera_code": "CAM-DEMO-02",
                    "rtsp_url": "rtsp://gateway:8554/cam-demo-02",
                    "analytics": ["faces"],
                },
                {
                    "camera_code": "SBX-cam10",
                    "rtsp_url": "rtsp://grid:8554/stream/cam10",
                    "analytics": ["anpr"],
                },
            ],
        )
        by_code = {s.camera_code: s for s in streams}
        assert by_code["CAM-DEMO-02"].faces and not by_code["CAM-DEMO-02"].vehicles
        assert by_code["SBX-cam10"].vehicles and not by_code["SBX-cam10"].faces

    async def test_a_roster_from_before_faces_means_anpr_alone(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """The junction cameras never look for faces unless tagged."""
        [stream] = await self._discover(
            monkeypatch,
            [{"camera_code": "SBX-cam21", "rtsp_url": "rtsp://grid:8554/stream/cam21"}],
        )
        assert stream.analytics == ("anpr",)
        assert not stream.faces


# ── what they match against ───────────────────────────────────────────
class TestTheGalleryCache:
    pytestmark = pytest.mark.asyncio

    async def test_it_reads_what_the_platform_published(self) -> None:
        cache = GalleryCache("nagarnetra:persons:gallery")
        client = FakeRedis(published(entries=2))
        gallery = await cache.refresh(client)
        assert client.keys == ["nagarnetra:persons:gallery"]
        assert len(gallery) == 2
        assert cache.current().policy.threshold == pytest.approx(0.5)

    async def test_no_key_means_nothing_to_match(self) -> None:
        cache = GalleryCache("k")
        await cache.refresh(FakeRedis(published(entries=1)))
        await cache.refresh(FakeRedis(None))
        assert cache.current().is_empty

    async def test_an_unreadable_payload_matches_nothing_rather_than_half(self) -> None:
        cache = GalleryCache("k")
        await cache.refresh(FakeRedis(published(entries=1)))
        await cache.refresh(FakeRedis("{not json"))
        assert cache.current().is_empty
        assert cache.last_error is not None

    async def test_an_outage_keeps_the_last_gallery_until_it_expires(self) -> None:
        cache = GalleryCache("k")
        await cache.refresh(FakeRedis(published(entries=1)))
        await cache.refresh(FakeRedis(error=RedisConnectionError("down")))
        assert len(cache.current()) == 1
        assert cache.failures == 1

    async def test_a_gallery_past_its_expiry_matches_nothing(self) -> None:
        """A worker cut off from the platform must not go on matching an entry
        that may have been retired while it could not hear about it."""
        cache = GalleryCache("k")
        await cache.refresh(
            FakeRedis(published(entries=1, expires_in=timedelta(seconds=-1)))
        )
        assert cache.current().is_empty

    def test_it_is_read_only_as_often_as_configured(self) -> None:
        cache = GalleryCache("k", refresh_s=10.0)
        assert cache.due(now=100.0)
        cache._read_at = 100.0
        assert not cache.due(now=105.0)
        assert cache.due(now=110.0)

    def test_what_it_reports_names_no_entry(self) -> None:
        cache = GalleryCache("k")
        text = json.dumps(cache.describe())
        assert "person_id" not in text


# ── models, lent one camera at a time ─────────────────────────────────
class TestTheFaceModelsPool:
    def test_models_are_built_once_and_reused(self) -> None:
        built: list[object] = []

        def factory() -> object:
            built.append(object())
            return built[-1]

        pool = FaceModelsPool(factory)
        first = pool.acquire()
        pool.release(first)
        again = pool.acquire()
        assert again is first
        assert pool.stats() == {"built": 1, "reused": 1, "idle": 0}

    def test_two_cameras_at_once_never_share_one(self) -> None:
        pool = FaceModelsPool(object)
        assert pool.acquire() is not pool.acquire()

    def test_missing_weights_surface_to_the_caller(self) -> None:
        def factory() -> object:
            raise FileNotFoundError("face model(s) not found")

        with pytest.raises(FileNotFoundError):
            FaceModelsPool(factory).acquire()


# ── where a matched face may go ───────────────────────────────────────
def fake_encoder(image: np.ndarray) -> bytes | None:
    return b"\xff\xd8face" if image is not None and image.size else None


class TestFaceCropsGoOnlyToThePrivateBucket:
    def test_a_face_key_is_day_partitioned_and_names_no_one(self) -> None:
        key = face_key("CAM-DEMO-02/0f3a", datetime(2026, 10, 12, tzinfo=UTC))
        assert key == "faces/2026/10/12/CAM-DEMO-02/0f3a.jpg"

    def test_the_key_decides_the_bucket(self) -> None:
        assert bucket_for(face_key("CAM-DEMO-02/x")) == settings.minio_persons_bucket
        assert bucket_for(object_key("plates", "x")) == settings.minio_bucket
        assert settings.minio_persons_bucket != settings.minio_bucket

    def test_a_face_crop_is_queued_under_its_face_key(self) -> None:
        store = MinioCropStore(encoder=fake_encoder, threads=0)
        key = store.save_face_crop(
            np.full((96, 80, 3), 120, dtype=np.uint8), "CAM-DEMO-02/abc"
        )
        assert key is not None and key.startswith("faces/")
        queued_key, payload = store._queue.get_nowait()
        assert queued_key == key
        assert payload.startswith(b"\xff\xd8")

    def test_an_empty_crop_yields_no_key(self) -> None:
        store = MinioCropStore(encoder=fake_encoder, threads=0)
        assert (
            store.save_face_crop(np.zeros((0, 0, 3), dtype=np.uint8), "CAM/x") is None
        )
