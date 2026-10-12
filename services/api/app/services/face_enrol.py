"""Reference embeddings, computed by the same code and models as the cameras.

The cameras embed faces with `ailab.face` (YuNet + SFace through OpenCV). If
enrolment used anything else — another model, another alignment, even another
resize — the reference and the camera's view would live in two slightly
different spaces, and every similarity the platform reported would quietly
mean less than it said. So the API imports the lab's own enrolment function
and loads the same weights (mounted at `FACE_MODELS_DIR`).

The models are loaded on first use and kept, one set per process, behind a
lock: OpenCV's DNN networks are not safe to call from two threads at once, and
enrolment is rare enough that serialising it costs nothing. The call itself is
CPU-bound, so the router runs it in a worker thread rather than on the event
loop. Thread count comes from `ailab.runtime`, like every other inference
session in the platform (CLAUDE.md trap 4).

Nothing outside this module imports `ailab`: the router deals in `Reference`
and `PhotoRefused`, so an image without OpenCV fails here, with a message that
says so, instead of at import time somewhere else.
"""

from __future__ import annotations

import threading
from dataclasses import dataclass
from typing import TYPE_CHECKING, Any

from app.core.config import settings
from app.core.logging import get_logger

if TYPE_CHECKING:
    from ailab.face.models import FaceModels

log = get_logger("api.face_enrol")

_lock = threading.Lock()
_models: FaceModels | None = None


class FaceEngineUnavailable(RuntimeError):
    """The face models or OpenCV are missing. Says what to do about it."""


class PhotoRefused(ValueError):
    """The photo cannot be a reference. `message` is written for the person
    enrolling and says what to do instead; `code` is for the audit row."""

    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.message = message


@dataclass(frozen=True, slots=True)
class Reference:
    """What enrolment keeps: the embedding (encoded for storage), the photo
    re-encoded from pixels, and how good a reference it is."""

    embedding_b64: str
    photo_jpeg: bytes
    quality: dict[str, Any]


def _load() -> FaceModels:
    try:
        from ailab.face.models import FaceModels
    except ImportError as exc:  # OpenCV or the lab package absent from this image
        raise FaceEngineUnavailable(
            "Face enrolment is unavailable: this API image has no OpenCV or no ailab "
            "package. Rebuild it (docker compose build api)."
        ) from exc
    try:
        return FaceModels(settings.face_models_dir)
    except (FileNotFoundError, RuntimeError) as exc:
        raise FaceEngineUnavailable(f"Face enrolment is unavailable: {exc}") from exc


def enrol(data: bytes) -> Reference:
    """Detect exactly one face in `data` and embed it. Blocking: run it in a
    thread. Raises `PhotoRefused` for a photo that cannot be a reference and
    `FaceEngineUnavailable` when the engine itself is missing."""
    global _models
    try:
        from ailab.face.enrol import EnrolmentRefused, enrol_image
        from ailab.face.gallery import encode_embedding
    except ImportError as exc:
        raise FaceEngineUnavailable(
            "Face enrolment is unavailable: the ailab package is not importable here."
        ) from exc

    with _lock:
        if _models is None:
            _models = _load()
            log.info("face_enrol.models_loaded", **_models.describe())
        try:
            enrolment = enrol_image(
                _models,
                data,
                min_face_px=settings.person_min_face_px,
                max_bytes=settings.person_photo_max_bytes,
            )
        except EnrolmentRefused as refused:
            raise PhotoRefused(refused.code, refused.message) from refused

    return Reference(
        embedding_b64=encode_embedding(enrolment.embedding),
        photo_jpeg=enrolment.photo_jpeg,
        quality=enrolment.quality(),
    )
