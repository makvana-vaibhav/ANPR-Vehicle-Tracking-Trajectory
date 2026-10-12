#!/usr/bin/env python3
"""Pull plate crops the live workers already saved, for an offline OCR benchmark.

Why this exists
---------------
The OCR benchmark (`scripts/ocr_bench.py`) needs real plate crops with human
labels. The workers already upload every crop they read to object storage, so
the benchmark set is built from those rather than by opening a camera: **this
script never opens a stream**, which matters on the organisers' grid, where
every watch counts against a quota.

It goes through the platform API, not straight to MinIO, so the read is
authenticated and recorded like any operator's: log in, list detections, follow
each detection's short-lived signed `crop_url`.

What it writes (into a directory that must be gitignored; plate crops are
photographs of real vehicles and never enter git)
---------------------------------------------------------------------------
    crops/<id>.jpg      the crop exactly as the worker stored it
    manifest.csv        id, camera, time, vehicle type, size, sha256 — no reading
    pipeline_reads.csv  what the platform stored for each crop, kept apart so a
                        labeller can work blind and look only afterwards

Bias, stated plainly: a crop reaches object storage only when the pipeline of
the day produced *some* reading from it. A set sampled here is "plates the
pipeline could partly read", not "plates that passed the camera". Say so
wherever a number from it is quoted.

Credentials come from the repository's `.env` (BOOTSTRAP_ADMIN_USERNAME /
BOOTSTRAP_ADMIN_PASSWORD) or the environment, and are never printed.

Usage
-----
    python3 scripts/fetch_eval_crops.py --out datasets/grid_ocr_v1 \
        --since 2026-10-11T06:30:00Z --until 2026-10-12T01:30:00Z \
        --camera-prefix SBX- --sample 160 --per-track 1 --seed 7
"""

from __future__ import annotations

import argparse
import csv
import hashlib
import json
import os
import random
import sys
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any

REPO_ROOT = Path(__file__).resolve().parents[2]


def _env_file_value(key: str) -> str:
    """A value from the environment, else from the repo's .env. Never logged."""
    if os.environ.get(key):
        return os.environ[key]
    env_path = REPO_ROOT / ".env"
    if env_path.exists():
        for line in env_path.read_text().splitlines():
            name, sep, value = line.partition("=")
            if sep and name.strip() == key:
                # Inline comments are allowed in .env.example ("... # CHANGE-IN-PROD").
                return value.split(" #", 1)[0].strip().strip('"').strip("'")
    return ""


def _request(url: str, *, token: str = "", body: dict[str, Any] | None = None) -> Any:
    data = json.dumps(body).encode() if body is not None else None
    request = urllib.request.Request(url, data=data, method="POST" if body else "GET")
    request.add_header("Accept", "application/json")
    if body is not None:
        request.add_header("Content-Type", "application/json")
    if token:
        request.add_header("Authorization", f"Bearer {token}")
    with urllib.request.urlopen(request, timeout=30) as response:
        return json.loads(response.read())


def login(api: str) -> str:
    username = _env_file_value("BOOTSTRAP_ADMIN_USERNAME")
    password = _env_file_value("BOOTSTRAP_ADMIN_PASSWORD")
    if not username or not password:
        sys.exit("BOOTSTRAP_ADMIN_USERNAME / BOOTSTRAP_ADMIN_PASSWORD are not set")
    pair = _request(f"{api}/api/v1/auth/login", body={"username": username, "password": password})
    return str(pair["access_token"])


def list_detections(api: str, token: str, since: str, until: str) -> list[dict[str, Any]]:
    """Every readable detection in the window, newest first, paginated."""
    rows: list[dict[str, Any]] = []
    offset = 0
    while True:
        query = urllib.parse.urlencode(
            {"since": since, "until": until, "readable_only": "true",
             "limit": 200, "offset": offset}
        )
        page = _request(f"{api}/api/v1/detections?{query}", token=token)
        items = page.get("items", [])
        rows.extend(items)
        if len(items) < 200:
            return rows
        offset += 200


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--api", default="http://localhost:8000")
    parser.add_argument("--out", required=True, type=Path)
    parser.add_argument("--since", required=True, help="UTC ISO-8601 lower bound")
    parser.add_argument("--until", required=True, help="UTC ISO-8601 upper bound")
    parser.add_argument("--camera-prefix", default="SBX-",
                        help="keep cameras whose code starts with this ('' = all)")
    parser.add_argument("--sample", type=int, default=0,
                        help="random sample size after the per-track cap (0 = all)")
    parser.add_argument("--per-track", type=int, default=1,
                        help="at most this many crops of one vehicle (one track)")
    parser.add_argument("--seed", type=int, default=7)
    args = parser.parse_args()

    token = login(args.api)
    rows = [
        r for r in list_detections(args.api, token, args.since, args.until)
        if r.get("crop_key") and r.get("crop_url")
        and str(r.get("camera_code", "")).startswith(args.camera_prefix)
    ]
    print(f"{len(rows)} detections with a crop in the window")

    # Several crops of one car are not independent samples: cap them per track
    # before sampling, so one parked car cannot dominate the set.
    by_track: dict[tuple[str, str], list[dict[str, Any]]] = {}
    for row in sorted(rows, key=lambda r: str(r["id"])):
        by_track.setdefault((row["camera_code"], row["track_id"]), []).append(row)
    rng = random.Random(args.seed)
    capped = [r for group in by_track.values() for r in group[: args.per_track]]
    rng.shuffle(capped)
    chosen = capped[: args.sample] if args.sample else capped

    crops_dir = args.out / "crops"
    crops_dir.mkdir(parents=True, exist_ok=True)
    manifest, reads = [], []
    for row in chosen:
        target = crops_dir / f"{row['id']}.jpg"
        if not target.exists():
            try:
                with urllib.request.urlopen(row["crop_url"], timeout=30) as response:
                    target.write_bytes(response.read())
            except urllib.error.HTTPError as exc:
                # The upload can fail at the edge; a missing object is a 404.
                print(f"  skip {row['id']}: {exc.code}")
                continue
        payload = target.read_bytes()
        manifest.append({
            "id": row["id"],
            "camera_code": row["camera_code"],
            "ts": row["ts"],
            "track_id": row["track_id"],
            "vehicle_type": row.get("vehicle_type") or "",
            "crop_key": row["crop_key"],
            "bytes": len(payload),
            "sha256": hashlib.sha256(payload).hexdigest(),
        })
        reads.append({
            "id": row["id"],
            "plate": row.get("plate") or "",
            "plate_confidence": row.get("plate_confidence"),
            "grammar_valid": row.get("grammar_valid"),
            "reads_total": row.get("reads_total"),
        })

    for name, records in (("manifest.csv", manifest), ("pipeline_reads.csv", reads)):
        if not records:
            continue
        with (args.out / name).open("w", newline="", encoding="utf-8") as handle:
            writer = csv.DictWriter(handle, fieldnames=list(records[0]))
            writer.writeheader()
            writer.writerows(records)
    cameras: dict[str, int] = {}
    for record in manifest:
        cameras[record["camera_code"]] = cameras.get(record["camera_code"], 0) + 1
    print(f"wrote {len(manifest)} crops to {crops_dir}; by camera: {cameras}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
