"""Face detection and face embedding, through OpenCV and inside the CPU budget.

Two models from the OpenCV Zoo, both run by OpenCV's own DNN module through the
API OpenCV ships for them:

* **YuNet** (`face_detection_yunet_2023mar.onnx`, MIT) via `cv2.FaceDetectorYN`
  — a 0.23 MB detector that returns a box, five landmarks and a score per face.
* **SFace** (`face_recognition_sface_2021dec.onnx`, Apache-2.0) via
  `cv2.FaceRecognizerSF` — aligns a face on those five landmarks to 112x112 and
  returns a 128-d embedding. Two embeddings of the same person point the same
  way; cosine similarity is the comparison.

Licences were checked at the source (`opencv_zoo/models/*/LICENSE`) and the
weights are fetched, pinned by commit and checksum, by
`ai-lab/scripts/fetch_models.sh`. Nothing here is AGPL and nothing here needs
PyTorch, so the models ship in the same torch-free images as everything else.

## The thread budget

OpenCV DNN does not take a thread count per network. It runs on OpenCV's
process-wide `parallel_for` pool, which `ailab.runtime` already sizes:
`apply_opencv_threads()` sets it to one thread whenever more than one camera
pipeline shares the process (the worker already has one thread per camera) and
to a small pool otherwise. These models are built only through `FaceModels`,
which applies that budget before creating either network — CLAUDE.md trap 4 is
about exactly the sessions that skipped this step.

## Not thread-safe

A `cv::dnn::Net` keeps per-inference state, and `FaceDetectorYN` keeps its
input size between calls, so one `FaceModels` must have one user at a time.
The worker lends them out from a pool, one per camera run; the API serialises
enrolment behind a lock.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import numpy as np

from ailab import runtime

# Stdlib logging, like `ailab.runtime`: this module is imported by the API for
# enrolment, whose image carries neither `rich` nor the rest of the lab.
log = logging.getLogger(__name__)

#: Identifies the embedding space. Stored beside every enrolled embedding and
#: carried in every match, so a model swap can never compare vectors from two
#: different spaces — they would produce plausible-looking, meaningless scores.
SFACE_MODEL_ID = "sface_2021dec"
YUNET_MODEL_ID = "yunet_2023mar"

SFACE_FILE = "face_recognition_sface_2021dec.onnx"
YUNET_FILE = "face_detection_yunet_2023mar.onnx"

#: SFace's published operating point for cosine similarity (opencv_zoo
#: `models/face_recognition_sface/sface.py`: `_threshold_cosine = 0.363`),
#: chosen on LFW-style verification pairs. It is reported beside every match as
#: the model's own threshold; the platform applies a stricter one, because a
#: watchlist compares one face against every passer-by rather than a curated
#: pair, and false matches multiply with the number of faces compared.
SFACE_PUBLISHED_COSINE_THRESHOLD = 0.363

EMBEDDING_DIM = 128

#: The 2023mar YuNet has a different output layout from the 2022 release and
#: is only decoded correctly by OpenCV 4.8 onwards.
MIN_OPENCV = (4, 8)


@dataclass(frozen=True, slots=True)
class FaceBox:
    """One detected face, in the pixel space of the image it was found in.

    `landmarks` are YuNet's five points as ten numbers: right eye, left eye,
    nose tip, right mouth corner, left mouth corner (x, y each). SFace aligns on
    them, which is why they are kept rather than just the box.
    """

    x: float
    y: float
    w: float
    h: float
    landmarks: tuple[float, ...]
    score: float

    @property
    def size_px(self) -> float:
        """The face's smaller side — what decides whether it can be matched."""
        return min(self.w, self.h)

    @property
    def cx(self) -> float:
        return self.x + self.w / 2.0

    @property
    def cy(self) -> float:
        return self.y + self.h / 2.0

    def xyxy(self) -> tuple[float, float, float, float]:
        return (self.x, self.y, self.x + self.w, self.y + self.h)

    def as_row(self) -> np.ndarray:
        """The 15-value row `FaceRecognizerSF.alignCrop` expects."""
        return np.array(
            [self.x, self.y, self.w, self.h, *self.landmarks, self.score], dtype=np.float32
        )

    def scaled(self, factor: float) -> FaceBox:
        """The same face in an image `factor` times larger (or smaller)."""
        return FaceBox(
            x=self.x * factor,
            y=self.y * factor,
            w=self.w * factor,
            h=self.h * factor,
            landmarks=tuple(v * factor for v in self.landmarks),
            score=self.score,
        )

    def to_dict(self) -> dict[str, Any]:
        return {
            "bbox": [round(v, 1) for v in self.xyxy()],
            "detector_score": round(self.score, 4),
            "size_px": round(self.size_px, 1),
        }

    @classmethod
    def from_row(cls, row: np.ndarray) -> FaceBox:
        values = [float(v) for v in row[:15]]
        return cls(
            x=values[0],
            y=values[1],
            w=values[2],
            h=values[3],
            landmarks=tuple(values[4:14]),
            score=values[14],
        )


def opencv_supports_faces() -> tuple[bool, str]:
    """Whether this OpenCV can run YuNet 2023mar and SFace, and if not, why."""
    import cv2

    version = tuple(int(part) for part in cv2.__version__.split(".")[:2])
    if not hasattr(cv2, "FaceDetectorYN") or not hasattr(cv2, "FaceRecognizerSF"):
        return False, f"OpenCV {cv2.__version__} has no FaceDetectorYN/FaceRecognizerSF"
    if version < MIN_OPENCV:
        return False, (
            f"OpenCV {cv2.__version__} cannot decode YuNet 2023mar; "
            f"{MIN_OPENCV[0]}.{MIN_OPENCV[1]} or later is needed"
        )
    return True, cv2.__version__


class FaceModels:
    """A YuNet detector and an SFace recogniser, sized by the thread budget."""

    def __init__(
        self,
        models_dir: str | Path,
        *,
        score_threshold: float = 0.8,
        nms_threshold: float = 0.3,
        top_k: int = 50,
        detect_max_side: int = 1280,
    ) -> None:
        """Load both networks from `models_dir`.

        `detect_max_side` bounds the detector's input: a frame larger than this
        is shrunk for detection and the boxes scaled back, so a 4K source costs
        the same as a 720p one. Alignment and embedding then run on the full
        frame, where the face has the most pixels.
        """
        import cv2

        supported, detail = opencv_supports_faces()
        if not supported:
            raise RuntimeError(detail)

        directory = Path(models_dir)
        detector_path = directory / YUNET_FILE
        recognizer_path = directory / SFACE_FILE
        missing = [p.name for p in (detector_path, recognizer_path) if not p.is_file()]
        if missing:
            raise FileNotFoundError(
                f"face model(s) not found in {directory}: {', '.join(missing)}. "
                "Fetch them with ai-lab/scripts/fetch_models.sh."
            )

        # The budget first: OpenCV DNN runs on OpenCV's process-wide pool, so
        # this is the only place its thread count can be decided. See the
        # module docstring and `ailab.runtime.opencv_threads`.
        self.threads = runtime.apply_opencv_threads()
        self.detect_max_side = max(160, int(detect_max_side))
        self.score_threshold = score_threshold

        self._detector = cv2.FaceDetectorYN.create(
            str(detector_path), "", (320, 320), score_threshold, nms_threshold, top_k
        )
        self._recognizer = cv2.FaceRecognizerSF.create(str(recognizer_path), "")
        self._input_size: tuple[int, int] = (320, 320)
        log.info(
            "face models loaded (%s + %s, OpenCV %s, %d thread(s))",
            YUNET_MODEL_ID,
            SFACE_MODEL_ID,
            detail,
            self.threads,
        )

    def detect(self, image: np.ndarray) -> list[FaceBox]:
        """Every face YuNet finds above its score threshold, in `image` pixels."""
        import cv2

        if image is None or image.size == 0:
            return []
        height, width = image.shape[:2]
        scale = min(1.0, self.detect_max_side / float(max(height, width)))
        if scale < 1.0:
            small = cv2.resize(
                image,
                (max(1, round(width * scale)), max(1, round(height * scale))),
                interpolation=cv2.INTER_AREA,
            )
        else:
            small = image

        size = (int(small.shape[1]), int(small.shape[0]))
        if size != self._input_size:
            self._detector.setInputSize(size)
            self._input_size = size
        _, faces = self._detector.detect(small)
        if faces is None:
            return []

        found = [FaceBox.from_row(row) for row in faces]
        if scale < 1.0:
            found = [face.scaled(1.0 / scale) for face in found]
        return found

    def embed(self, image: np.ndarray, face: FaceBox) -> np.ndarray:
        """The face's unit-length 128-d SFace embedding.

        Normalised here so that every comparison downstream is a plain dot
        product equal to the cosine similarity `FaceRecognizerSF.match` would
        report with `FR_COSINE`.
        """
        aligned = self._recognizer.alignCrop(image, face.as_row())
        feature = np.asarray(self._recognizer.feature(aligned), dtype=np.float32).reshape(-1)
        norm = float(np.linalg.norm(feature))
        return feature / norm if norm > 0.0 else feature

    def describe(self) -> dict[str, Any]:
        return {
            "detector": YUNET_MODEL_ID,
            "recognizer": SFACE_MODEL_ID,
            "threads": self.threads,
            "detect_max_side": self.detect_max_side,
            "score_threshold": self.score_threshold,
        }
