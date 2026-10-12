#!/usr/bin/env python3
"""CPU one open stream costs the worker, by how often its frames are taken.

Streams a recorded clip through `StreamReader` at its natural rate (as a
camera would deliver it) for `--seconds`, with a consumer that takes a frame
and then spends `1/--consume-fps` seconds "analysing" it (sleeping, so only
the reader's own CPU is counted), or that never reads (`--consume-fps 0`: a
camera whose analysis slot has rotated away, its stream kept open). Reports
process CPU in cores, which is what the open stream costs the machine.

`--reader path/to/reader.py` loads another implementation with the same
interface — e.g. the pre-change one, `git show <rev>:ai-lab/ailab/stream/
reader.py` — so before and after are measured by the same harness.

Usage (worker image, one decode thread):
    python scripts/bench_reader.py /data/videos/rajkot-bus-stand.mp4 --consume-fps 3
"""

from __future__ import annotations

import argparse
import importlib.util
import json
import resource
import sys
import time
from pathlib import Path
from typing import Any

LAB = Path(__file__).resolve().parents[1]
if str(LAB) not in sys.path:
    sys.path.insert(0, str(LAB))


def _cpu_s() -> float:
    usage = resource.getrusage(resource.RUSAGE_SELF)
    return usage.ru_utime + usage.ru_stime


def load_reader(path: str | None) -> Any:
    if path is None:
        from ailab.stream.reader import StreamReader
        return StreamReader
    spec = importlib.util.spec_from_file_location("alternative_reader", path)
    if spec is None or spec.loader is None:
        sys.exit(f"cannot load {path}")
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module    # dataclasses resolve types through it
    spec.loader.exec_module(module)
    return module.StreamReader


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("clip")
    parser.add_argument("--seconds", type=float, default=15.0)
    parser.add_argument("--consume-fps", type=float, default=3.0)
    parser.add_argument("--reader", default=None)
    parser.add_argument("--label", default="")
    args = parser.parse_args()

    from ailab import runtime
    runtime.apply_opencv_threads()
    reader = load_reader(args.reader)(args.clip, realtime=True, reconnect=False).start()
    cpu_start, wall_start = _cpu_s(), time.perf_counter()
    deadline = wall_start + args.seconds
    taken = 0
    while time.perf_counter() < deadline and not reader.finished:
        if args.consume_fps > 0:
            frame = reader.read(timeout=0.5)
            if frame is not None:
                taken += 1
                time.sleep(1.0 / args.consume_fps)
        else:
            time.sleep(0.1)
    cpu, wall = _cpu_s() - cpu_start, time.perf_counter() - wall_start
    stats = reader.stats.to_dict()
    reader.stop()
    print(json.dumps({
        "label": args.label or (args.reader or "current"),
        "clip": Path(args.clip).name,
        "consume_fps": args.consume_fps,
        "wall_s": round(wall, 2),
        "cores": round(cpu / wall, 3),
        "cpu_ms_per_decoded_frame": round(1000 * cpu / max(1, stats["frames_decoded"]), 2),
        "frames_decoded": stats["frames_decoded"],
        "frames_taken": taken,
        "converted_skipped": stats.get("frames_skipped_unconverted", 0),
    }))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
