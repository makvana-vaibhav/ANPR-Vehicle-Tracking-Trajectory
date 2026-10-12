"""Face models, lent to cameras one at a time.

The same shape as `PipelinePool`, for the same two reasons:

* **Loaded once, not once per rotation.** SFace is a 37 MB network; a camera
  tagged for faces that rotates through an inference slot every 45 s would
  otherwise reload it — and re-allocate OpenCV's buffers — 80 times an hour.
* **One user at a time.** OpenCV DNN networks keep per-inference state, and
  `cv2.FaceDetectorYN` keeps its input size between calls, so two cameras
  must never share one instance concurrently. A pool checks one out.

Only cameras tagged `analytics:faces` ever borrow from it, so on a worker
with none the factory never runs and the models are never loaded.

Import-light on purpose, like `pipeline_pool`: the factory is injected, so
this module needs neither OpenCV nor the models to be tested.
"""

from __future__ import annotations

import logging
import threading
from collections.abc import Callable
from typing import Any

log = logging.getLogger(__name__)


class FaceModelsPool:
    """`FaceModels` instances, built on demand and reused."""

    def __init__(self, factory: Callable[[], Any]) -> None:
        self._factory = factory
        self._idle: list[Any] = []
        self._lock = threading.Lock()
        self.built = 0
        self.reused = 0

    def acquire(self) -> Any:
        """Borrow a set of face models. Built on first use per concurrent
        camera; raises whatever the factory raises when the weights are
        missing, which the caller reports and runs without faces."""
        with self._lock:
            if self._idle:
                self.reused += 1
                return self._idle.pop()
            self.built += 1
        log.info("loading face models for a camera tagged analytics:faces")
        return self._factory()

    def release(self, models: Any) -> None:
        with self._lock:
            self._idle.append(models)

    def stats(self) -> dict[str, int]:
        with self._lock:
            return {"built": self.built, "reused": self.reused, "idle": len(self._idle)}
