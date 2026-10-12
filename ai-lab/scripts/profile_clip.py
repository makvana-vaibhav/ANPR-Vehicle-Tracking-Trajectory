#!/usr/bin/env python3
"""Whole-pipeline CPU per analysed frame, and the plates it resolves, on a clip.

Runs the real `Pipeline.run` with the given config, analysing one source frame
in `--stride` (to imitate the share of a camera's frames a live worker keeps up
with) and decoding the way the live reader does: one FFmpeg thread, every
frame decoded, only the analysed ones converted to BGR.

CPU is process CPU (`getrusage`), so it is what the worker would be charged
whatever runs on which thread; per-stage figures are the calling thread's CPU
around each model call, which is all of it at one ONNX Runtime thread.

Plates are scored against `--ground-truth`, a CSV with a `plate` column listing
the plates that appear in the clip (from blind labels; see ocr_bench.py):
`correct` is a resolved vehicle whose plate is in that set, `wrong` one whose
plate is not, and `--disputed` names plates the labellers could not agree on,
which are counted on their own rather than as either.

Usage:
    python scripts/profile_clip.py /data/videos/anpr_demo.mp4 --config stream_demo \\
        --stride 6 --ground-truth gt.csv --set preprocess.variants=[raw]
"""

from __future__ import annotations

import argparse
import csv
import json
import resource
import sys
import time
from collections.abc import Callable, Iterator
from pathlib import Path
from typing import Any

import cv2

LAB = Path(__file__).resolve().parents[1]
if str(LAB) not in sys.path:
    sys.path.insert(0, str(LAB))

import ailab.pipeline as pipeline_module  # noqa: E402
from ailab import runtime  # noqa: E402
from ailab.config import RunConfig, parse_override  # noqa: E402
from ailab.pipeline import Pipeline  # noqa: E402
from ailab.sources.base import SourceInfo  # noqa: E402
from ailab.types import Frame  # noqa: E402

CPU: dict[str, float] = {}
CALLS: dict[str, int] = {}


def _cpu_s() -> float:
    usage = resource.getrusage(resource.RUSAGE_SELF)
    return usage.ru_utime + usage.ru_stime


def _timed(name: str, fn: Callable[..., Any]) -> Callable[..., Any]:
    def wrapper(*args: Any, **kwargs: Any) -> Any:
        started = time.thread_time()
        try:
            return fn(*args, **kwargs)
        finally:
            CPU[name] = CPU.get(name, 0.0) + time.thread_time() - started
            CALLS[name] = CALLS.get(name, 0) + 1
    return wrapper


class LiveLikeSource:
    """Decodes like `StreamReader`: one thread, grab() all, retrieve() the analysed."""

    def __init__(self, path: str, stride: int, limit: int | None) -> None:
        self._capture = cv2.VideoCapture(path, cv2.CAP_FFMPEG, [cv2.CAP_PROP_N_THREADS, 1])
        if not self._capture.isOpened():
            raise RuntimeError(f"could not open {path}")
        fps = float(self._capture.get(cv2.CAP_PROP_FPS) or 25.0)
        self._stride, self._limit = stride, limit
        self.decoded = 0
        self._info = SourceInfo(
            name=Path(path).stem, path=path, kind="video",
            width=int(self._capture.get(cv2.CAP_PROP_FRAME_WIDTH)),
            height=int(self._capture.get(cv2.CAP_PROP_FRAME_HEIGHT)),
            fps=fps, total_frames=int(self._capture.get(cv2.CAP_PROP_FRAME_COUNT) or 0),
            duration_s=0.0, codec="",
        )

    @property
    def info(self) -> SourceInfo:
        return self._info

    def __iter__(self) -> Iterator[Frame]:
        index, emitted = -1, 0
        while self._limit is None or emitted < self._limit:
            started = time.thread_time()
            ok = self._capture.grab()
            image = None
            if ok:
                index += 1
                self.decoded += 1
                if index % self._stride == 0:
                    ok, image = self._capture.retrieve()
            CPU["decode"] = CPU.get("decode", 0.0) + time.thread_time() - started
            if not ok:
                return
            if image is None:
                continue
            emitted += 1
            yield Frame(index=index, t_s=index / self._info.fps, image=image,
                        source_name=self._info.name)

    def close(self) -> None:
        self._capture.release()


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("clip")
    parser.add_argument("--config", default="stream")
    parser.add_argument("--set", action="append", default=[], metavar="KEY=VALUE")
    parser.add_argument("--stride", type=int, default=6)
    parser.add_argument("--limit", type=int, default=None, help="analysed frames")
    parser.add_argument("--ground-truth", type=Path)
    parser.add_argument("--disputed", default="", help="comma-separated plates to count apart")
    parser.add_argument("--label", default="")
    parser.add_argument("--out", type=Path, default=LAB / "runs" / "_profile")
    args = parser.parse_args()

    runtime.apply_opencv_threads()
    config = RunConfig.load(args.config)
    if args.set:
        config = config.with_overrides(dict(parse_override(item) for item in args.set))
    config.output.save_plate_crops = False
    config.output.save_vehicle_crops = False
    config.output.annotated_video = False
    config.output.html_report = False

    pipeline = Pipeline(config)
    pipeline.detector.detect = _timed("detect", pipeline.detector.detect)
    pipeline.plate_detector.detect = _timed("plate_detect", pipeline.plate_detector.detect)
    pipeline.ocr.read = _timed("ocr", pipeline.ocr.read)

    holder: dict[str, LiveLikeSource] = {}

    def open_source(path: str, _cfg: Any) -> LiveLikeSource:
        holder["source"] = LiveLikeSource(path, args.stride, args.limit)
        return holder["source"]

    pipeline_module.open_source = open_source  # the live-like decoder, for this run only
    args.out.mkdir(parents=True, exist_ok=True)
    cpu_before, wall_before = _cpu_s(), time.perf_counter()
    result = pipeline.run(args.clip, run_root=args.out)
    cpu_total = _cpu_s() - cpu_before
    wall_total = time.perf_counter() - wall_before

    frames = result.frames_processed or 1
    truth = set()
    if args.ground_truth:
        with args.ground_truth.open(encoding="utf-8") as handle:
            truth = {row["plate"].strip().upper() for row in csv.DictReader(handle)}
    disputed = {p.strip().upper() for p in args.disputed.split(",") if p.strip()}
    resolved = [v.result.text for v in result.vehicles if v.result and v.result.text]
    valid = [v.result.text for v in result.vehicles
             if v.result and v.result.text and v.result.grammar_valid]
    scored = [p for p in valid if p not in disputed]
    report = {
        "label": args.label,
        "clip": args.clip,
        "config": config.name,
        "overrides": args.set,
        "stride": args.stride,
        "runtime": runtime.describe(),
        "frames_decoded": holder["source"].decoded,
        "frames_analysed": result.frames_processed,
        "cpu_s_per_analysed_frame": round(cpu_total / frames, 4),
        "wall_s_per_analysed_frame": round(wall_total / frames, 4),
        "stage_cpu_ms_per_frame": {k: round(1000 * v / frames, 1) for k, v in sorted(CPU.items())},
        "stage_calls_per_frame": {k: round(v / frames, 2) for k, v in sorted(CALLS.items())},
        "vehicles": len(result.vehicles),
        "plates_resolved": len(resolved),
        "plates_grammar_valid": len(valid),
        "distinct_valid_plates": sorted(set(valid)),
        "correct": sum(1 for p in scored if p in truth),
        "wrong": sorted(p for p in scored if p not in truth),
        "disputed_reads": sorted(p for p in valid if p in disputed),
        "ground_truth_plates_found": sorted(truth & set(valid)),
    }
    report_path = args.out / f"{result.run_dir.path.name}.profile.json"
    report_path.write_text(json.dumps(report, indent=2))
    print(json.dumps({k: report[k] for k in (
        "label", "cpu_s_per_analysed_frame", "stage_cpu_ms_per_frame", "stage_calls_per_frame",
        "frames_analysed", "plates_grammar_valid", "correct", "wrong", "disputed_reads",
    )}))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
