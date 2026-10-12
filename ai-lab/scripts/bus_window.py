#!/usr/bin/env python3
"""What the workers published over a time window, per camera — from the bus only.

Reads the event stream the AI workers write to (Redis Streams) and nothing
else: it opens no camera, so it costs the organisers' grid no watch. Use it
for live before/after comparisons (same length of window, same time of day),
and say what it is: traffic confounds it, so it is an observation, never an
accuracy figure.

Per camera, over `vehicle.completed` events:
    vehicles          completed vehicles
    with_plate        ... that carried any reading
    valid             ... a grammar-valid one (what a watchlist acts on)
    single_read       valid plates that rested on exactly one OCR read
    reads_median      OCR reads behind a valid plate (multi-frame evidence)
    correct / wrong   valid plates in / not in --ground-truth (a plate column)
and capture-to-event latency (`latency_ms`) over the events that carry it.

Usage:
    python3 scripts/bus_window.py --minutes 10 --camera CAM-DEMO-01
    python3 scripts/bus_window.py --stream nagarnetra:events:native-trial --minutes 10
"""

from __future__ import annotations

import argparse
import csv
import json
import statistics
import sys
import time
from datetime import datetime
from pathlib import Path
from typing import Any

import redis


def _ms(text: str) -> int:
    return int(datetime.fromisoformat(text.replace("Z", "+00:00")).timestamp() * 1000)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--redis", default="redis://localhost:6379/0")
    parser.add_argument("--stream", default="nagarnetra:events:detections")
    parser.add_argument("--since", help="UTC ISO-8601")
    parser.add_argument("--until", help="UTC ISO-8601")
    parser.add_argument("--minutes", type=float, help="the last N minutes (instead of --since)")
    parser.add_argument("--camera", action="append", default=[], help="only these camera ids")
    parser.add_argument("--ground-truth", type=Path)
    parser.add_argument("--disputed", default="")
    parser.add_argument("--json", action="store_true")
    args = parser.parse_args()

    now_ms = int(time.time() * 1000)
    until = _ms(args.until) if args.until else now_ms
    since = _ms(args.since) if args.since else until - int((args.minutes or 10) * 60_000)
    truth: set[str] = set()
    if args.ground_truth:
        with args.ground_truth.open(encoding="utf-8") as handle:
            truth = {row["plate"].strip().upper() for row in csv.DictReader(handle)}
    disputed = {p.strip().upper() for p in args.disputed.split(",") if p.strip()}

    client = redis.Redis.from_url(args.redis, decode_responses=True)
    cameras: dict[str, dict[str, Any]] = {}
    cursor = f"{since}-0"
    while True:
        batch = client.xrange(args.stream, min=cursor, max=f"{until}-999999", count=2000)
        if not batch:
            break
        for _entry_id, fields in batch:
            try:
                event = json.loads(fields.get("payload", "{}"))
            except ValueError:
                continue
            camera = (event.get("source") or {}).get("camera_id", "")
            if args.camera and camera not in args.camera:
                continue
            stats = cameras.setdefault(camera, {
                "vehicles": 0, "with_plate": 0, "valid": [], "reads": [], "latency": [],
                "observed": 0,
            })
            if event.get("latency_ms") is not None and event.get("event") != "camera.tracks":
                stats["latency"].append(float(event["latency_ms"]))
            if event.get("event") == "vehicle.observed":
                stats["observed"] += 1
            if event.get("event") != "vehicle.completed":
                continue
            stats["vehicles"] += 1
            plate = event.get("plate") or {}
            if plate.get("text"):
                stats["with_plate"] += 1
                if plate.get("grammar_valid"):
                    stats["valid"].append(plate["text"])
                    stats["reads"].append(int((plate.get("evidence") or {}).get("reads_total", 0)))
        last = batch[-1][0]
        ms, seq = last.split("-")
        cursor = f"{ms}-{int(seq) + 1}"

    report = {}
    for camera, s in sorted(cameras.items()):
        valid, reads, latency = s["valid"], s["reads"], sorted(s["latency"])
        scored = [p for p in valid if p not in disputed]
        report[camera] = {
            "vehicles": s["vehicles"],
            "with_plate": s["with_plate"],
            "valid": len(valid),
            "distinct_valid": len(set(valid)),
            "single_read": sum(1 for r in reads if r == 1),
            "reads_median": statistics.median(reads) if reads else 0,
            "observed_events": s["observed"],
            "latency_ms_p50": round(latency[len(latency) // 2], 1) if latency else None,
            "latency_ms_p90": round(latency[int(0.9 * (len(latency) - 1))], 1) if latency else None,
            **({"correct": sum(1 for p in scored if p in truth),
                "wrong_reads": sum(1 for p in scored if p not in truth),
                "disputed_reads": len(valid) - len(scored),
                "wrong": sorted({p for p in scored if p not in truth})} if truth else {}),
        }
    window = {"stream": args.stream, "since_ms": since, "until_ms": until,
              "minutes": round((until - since) / 60_000, 2)}
    if args.json:
        print(json.dumps({"window": window, "cameras": report}, indent=2))
    else:
        print(f"{args.stream}  {window['minutes']} min")
        for camera, r in report.items():
            print(f"  {camera:<14} {json.dumps(r)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
