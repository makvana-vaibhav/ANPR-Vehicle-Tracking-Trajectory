#!/usr/bin/env python3
"""CPU per firing of PP-OCR's detect-then-recognise fallback, by input sizing.

The fallback runs only on a crop squarer than `detection_fallback_max_aspect`
and at least `detection_fallback_min_height` tall (`RapidOcrEngine.
_detection_could_help`), so it is timed on exactly those: every such crop in
the given datasets, plus rendered two-row plates. Each is run `--repeat`
times per setting, after one warm-up, and the thread CPU is reported.

Usage (worker image, one thread, as the workers run):
    python scripts/bench_fallback.py datasets/grid_ocr_v1 datasets/demo_ocr_v1
"""

from __future__ import annotations

import argparse
import statistics
import sys
import time
from pathlib import Path

import cv2
import numpy as np

LAB = Path(__file__).resolve().parents[1]
if str(LAB) not in sys.path:
    sys.path.insert(0, str(LAB))

from ailab import runtime  # noqa: E402
from ailab.aggregate.grammar import normalise  # noqa: E402
from ailab.config import OcrConfig  # noqa: E402
from ailab.registry import create  # noqa: E402

SETTINGS = {
    "shipped 736/min + cls": {"detection_fallback_limit_side_len": 736,
                              "detection_fallback_limit_type": "min",
                              "detection_fallback_use_cls": True},
    "128/min, no cls": {"detection_fallback_limit_side_len": 128,
                        "detection_fallback_limit_type": "min",
                        "detection_fallback_use_cls": False},
    "192/max, no cls": {"detection_fallback_limit_side_len": 192,
                        "detection_fallback_limit_type": "max",
                        "detection_fallback_use_cls": False},
}


def two_row(top: str, bottom: str, width: int, height: int) -> np.ndarray:
    image = np.full((height, width, 3), 245, dtype=np.uint8)
    cv2.rectangle(image, (2, 2), (width - 3, height - 3), (20, 20, 20), 2)
    for text, baseline in ((top, int(height * 0.44)), (bottom, int(height * 0.88))):
        (tw, th), _ = cv2.getTextSize(text, cv2.FONT_HERSHEY_DUPLEX, 1.0, 2)
        scale = min((width * 0.8) / tw, (height * 0.34) / th)
        (tw, th), _ = cv2.getTextSize(text, cv2.FONT_HERSHEY_DUPLEX, scale, 2)
        cv2.putText(image, text, ((width - tw) // 2, baseline), cv2.FONT_HERSHEY_DUPLEX,
                    scale, (10, 10, 10), 2, cv2.LINE_AA)
    return image


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("datasets", nargs="*", type=Path)
    parser.add_argument("--repeat", type=int, default=3)
    args = parser.parse_args()
    runtime.apply_opencv_threads()

    gate = OcrConfig()
    crops: list[tuple[str, np.ndarray]] = []
    for dataset in args.datasets:
        for path in sorted((dataset / "crops").glob("*.jpg")):
            image = cv2.imread(str(path))
            if image is None:
                continue
            h, w = image.shape[:2]
            if h >= gate.detection_fallback_min_height and w >= 48 and \
                    w / h < gate.detection_fallback_max_aspect:
                crops.append((f"{dataset.name}/{path.stem[:8]}", image))
    rendered = [("GJ02", "ZZ7828", 160, 110), ("GJ18", "Z7967", 120, 80),
                ("MH12", "DE1433", 90, 60)]
    crops += [(f"rendered/{t}{b}", two_row(t, b, w, h)) for t, b, w, h in rendered]
    print(f"{len(crops)} crops that qualify for the fallback "
          f"({len(crops) - len(rendered)} real, {len(rendered)} rendered two-row)")

    for name, overrides in SETTINGS.items():
        engine = create("ocr", "rapidocr", OcrConfig(**overrides))
        engine._detect_and_recognise(crops[0][1])          # warm-up
        per_firing: list[float] = []
        rendered_right = 0
        for label, image in crops:
            samples = []
            for _ in range(args.repeat):
                started = time.thread_time()
                result = engine._detect_and_recognise(image)
                samples.append((time.thread_time() - started) * 1000.0)
            per_firing.append(statistics.median(samples))
            if label.startswith("rendered/"):
                rendered_right += normalise(result.text) == label.split("/")[1]
        per_firing.sort()
        print(f"  {name:<22} mean {statistics.fmean(per_firing):7.1f} ms  "
              f"median {statistics.median(per_firing):7.1f}  "
              f"p90 {per_firing[int(0.9 * (len(per_firing) - 1))]:7.1f}  "
              f"rendered two-row read {rendered_right}/{len(rendered)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
