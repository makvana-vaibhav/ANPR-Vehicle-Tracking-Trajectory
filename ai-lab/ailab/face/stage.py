"""The face stage: one camera's frames in, possible matches out.

`StreamRunner` hands every analysed frame to `process`; this decides whether
it is time to look (at most `max_fps` a second, by the stream's own clock),
finds faces, compares the ones big enough to compare with the active gallery,
and lets `FaceWatch` decide whether several frames of one face agree. When they
do, the face crop goes to object storage from here and a `person.match` event
goes onto the bus.

Two things are skipped before any work is done, and both are deliberate:

* **No gallery, no looking.** With nothing approved to match against there is
  no purpose for detecting a face at all, so the stage does not.
* **Too small to compare, not compared.** A face below `min_face_px` gets no
  embedding — it could only produce a score nobody should trust.

## What is never kept (privacy by design)

The embedding of a face exists for the length of one comparison, inside
`_compare`, and is then out of scope: it is never stored, logged, emitted or
returned. A crop is cut only for a frame that passed the threshold (see
`ailab.face.matching`), and only the crop of a face that several frames agreed
on is ever uploaded. Faces that matched nothing leave no trace here beyond a
count.
"""

from __future__ import annotations

import dataclasses
import logging
import math
import time
import uuid
from collections.abc import Callable
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any, Protocol

import numpy as np

from ailab.config import FaceConfig
from ailab.face.events import person_match_event
from ailab.face.gallery import Gallery, MatchPolicy
from ailab.face.matching import FaceObservation, FaceWatch, PossibleMatch
from ailab.face.models import FaceBox

log = logging.getLogger(__name__)


class FaceModelsLike(Protocol):
    """What the stage needs of the models — `FaceModels`, or a test double."""

    def detect(self, image: np.ndarray) -> list[FaceBox]: ...

    def embed(self, image: np.ndarray, face: FaceBox) -> np.ndarray: ...


class FaceCropStore(Protocol):
    """Where a matched face's crop goes. Returns the object key, or None when
    the crop could not be queued (the event then says so with a null key)."""

    def save_face_crop(self, image: np.ndarray, name: str) -> str | None: ...


class EventSinkLike(Protocol):
    def emit(self, event: dict[str, Any]) -> None: ...


class SourceLike(Protocol):
    camera_id: str

    def to_dict(self) -> dict[str, Any]: ...


@dataclass(slots=True)
class FaceStageStats:
    frames_offered: int = 0
    frames_analysed: int = 0
    skipped_rate: int = 0
    skipped_no_gallery: int = 0
    faces_detected: int = 0
    faces_too_small: int = 0
    faces_compared: int = 0
    matches_announced: int = 0
    crops_uploaded: int = 0
    crops_missing: int = 0
    analyse_ms: float = 0.0

    def to_dict(self) -> dict[str, Any]:
        data = dataclasses.asdict(self)
        data["analyse_ms"] = round(self.analyse_ms, 1)
        data["ms_per_analysed_frame"] = (
            round(self.analyse_ms / self.frames_analysed, 1) if self.frames_analysed else 0.0
        )
        return data


def face_crop(
    image: np.ndarray, box: FaceBox, margin: float = 0.25, max_side: int = 256
) -> np.ndarray:
    """The face with a little context around it, as its own small image.

    A copy, never a view: a view would keep the whole frame alive in memory for
    as long as the crop is held — the opposite of keeping only what matched.
    """
    height, width = image.shape[:2]
    dx, dy = box.w * margin, box.h * margin
    x1 = max(0, int(math.floor(box.x - dx)))
    y1 = max(0, int(math.floor(box.y - dy)))
    x2 = min(width, int(math.ceil(box.x + box.w + dx)))
    y2 = min(height, int(math.ceil(box.y + box.h + dy)))
    crop = np.ascontiguousarray(image[y1:y2, x1:x2]).copy()
    longest = max(crop.shape[:2]) if crop.size else 0
    if longest > max_side:
        import cv2

        scale = max_side / float(longest)
        crop = cv2.resize(
            crop,
            (max(1, round(crop.shape[1] * scale)), max(1, round(crop.shape[0] * scale))),
            interpolation=cv2.INTER_AREA,
        )
    return crop


class FaceStage:
    """Faces on one camera. One per camera run; not thread-safe."""

    def __init__(
        self,
        models: FaceModelsLike,
        gallery: Callable[[], Gallery],
        sink: EventSinkLike,
        source: SourceLike,
        *,
        config: FaceConfig | None = None,
        crop_store: FaceCropStore | None = None,
        run_id: str = "",
    ) -> None:
        self.config = config or FaceConfig()
        self._models = models
        self._gallery = gallery
        self._sink = sink
        self._source = source
        self._crop_store = crop_store
        self.run_id = run_id
        self._floor = MatchPolicy(
            threshold=self.config.threshold,
            min_frames=self.config.min_frames,
            min_margin=self.config.min_margin,
        )
        self._watch = FaceWatch(
            self._floor,
            max_gap_s=self.config.max_gap_s,
            cooldown_s=self.config.cooldown_s,
        )
        self._interval_s = 1.0 / self.config.max_fps
        self._last_t_s: float | None = None
        self._gallery_version: str | None = None
        self.stats = FaceStageStats()

    @property
    def watch(self) -> FaceWatch:
        return self._watch

    def reset(self) -> None:
        """A scene cut or a pause: forget every face in view, and its evidence."""
        self._watch.reset()
        self._last_t_s = None

    def process(
        self,
        image: np.ndarray,
        *,
        t_s: float,
        captured_at: datetime | None = None,
        latency_ms: float | None = None,
    ) -> list[PossibleMatch]:
        """Look at one frame if it is time to. Returns what was announced."""
        self.stats.frames_offered += 1
        if self._last_t_s is not None and 0.0 <= t_s - self._last_t_s < self._interval_s:
            self.stats.skipped_rate += 1
            return []

        now = captured_at or datetime.now(UTC)
        gallery = self._gallery()
        if gallery.is_empty or gallery.is_expired(now):
            self.stats.skipped_no_gallery += 1
            return []
        self._last_t_s = t_s
        self._follow(gallery)

        started = time.perf_counter()
        observations = self._compare(image, gallery, now)
        announced = self._watch.observe(
            t_s,
            observations,
            evidence=lambda o: face_crop(
                image, o.box, self.config.crop_margin, self.config.crop_max_side
            ),
        )
        self.stats.frames_analysed += 1
        self.stats.analyse_ms += (time.perf_counter() - started) * 1000.0

        for match in announced:
            self._announce(match, image, captured_at, latency_ms, gallery.version)
        return announced

    # ── internals ──────────────────────────────────────────────────────
    def _follow(self, gallery: Gallery) -> None:
        """Adopt a newly published gallery's policy, and drop agreement held
        for any entry it no longer contains — a retired entry must not be
        announced on the strength of frames compared before it was retired."""
        if gallery.version == self._gallery_version:
            return
        self._gallery_version = gallery.version
        self._watch.policy = gallery.policy.stricter(self._floor)
        self._watch.retain({entry.person_id for entry in gallery.entries})

    def _compare(
        self, image: np.ndarray, gallery: Gallery, now: datetime
    ) -> list[FaceObservation]:
        observations: list[FaceObservation] = []
        for face in self._models.detect(image):
            self.stats.faces_detected += 1
            if face.size_px < self.config.min_face_px:
                self.stats.faces_too_small += 1
                continue
            # The embedding lives for exactly this statement and the next: it
            # is compared and goes out of scope. Nothing below receives it.
            embedding = self._models.embed(image, face)
            match = gallery.best(embedding, now)
            del embedding
            self.stats.faces_compared += 1
            observations.append(FaceObservation(box=face, match=match))
        return observations

    def _announce(
        self,
        match: PossibleMatch,
        image: np.ndarray,
        captured_at: datetime | None,
        latency_ms: float | None,
        gallery_version: str,
    ) -> None:
        key: str | None = None
        if self._crop_store is not None and match.evidence is not None:
            # A random name: the object key says nothing about who matched.
            key = self._crop_store.save_face_crop(
                match.evidence, f"{self._source.camera_id}/{uuid.uuid4().hex}"
            )
        if key:
            self.stats.crops_uploaded += 1
        else:
            self.stats.crops_missing += 1
        self.stats.matches_announced += 1

        height, width = image.shape[:2]
        self._sink.emit(
            person_match_event(
                match,
                self._source.to_dict(),
                captured_at=captured_at,
                frame_size=(int(width), int(height)),
                face_crop_key=key,
                gallery_version=gallery_version,
                latency_ms=latency_ms,
                run_id=self.run_id,
            )
        )
        # Which entry matched is not logged: the alert is the record, and it
        # is behind RBAC. The log says only that a match was announced.
        log.info(
            "possible person match announced on %s (%d frames agreed, similarity %.3f)",
            self._source.camera_id,
            match.frames_agreed,
            match.similarity,
        )

    def describe(self) -> dict[str, Any]:
        return {
            "max_fps": self.config.max_fps,
            "min_face_px": self.config.min_face_px,
            "policy": self._watch.policy.to_dict(),
            "gallery_version": self._gallery_version,
            "held_evidence": self._watch.held_evidence,
            "stats": self.stats.to_dict(),
            "watch": self._watch.stats.to_dict(),
        }
