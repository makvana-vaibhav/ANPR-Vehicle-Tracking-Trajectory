#!/usr/bin/env python3
"""Record a short clip from every camera on the organisers' grid.

    python scripts/record_grid.py                 # all 30, 60 s each
    python scripts/record_grid.py --seconds 90 cam10 cam21
    python scripts/record_grid.py --skip-existing

Writes `data/videos/grid-SBX-camNN.mp4` (gitignored), which
`scripts/grid_replay.py on` then plays as each camera's source, so the demo
does not depend on the venue's network or the grid's watch-time quota.

Gentle on the grid on purpose: one session at a time by default, a pause
between clips, and on a 401 (the grid locks out an address that opens sessions
too often) it waits 2, 4, 8, then 15 min and retries rather than carrying on.

The grid credentials come from `.env` and never appear in output: ffmpeg
echoes its input URL in error messages, so every line it prints is redacted
before it reaches the terminal.
"""

from __future__ import annotations

import argparse
import re
import subprocess
import sys
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from urllib.parse import quote

REPO = Path(__file__).resolve().parent.parent
VIDEO_DIR = REPO / "data" / "videos"


def read_env() -> dict[str, str]:
    values: dict[str, str] = {}
    for line in (REPO / ".env").read_text().splitlines():
        if "=" in line and not line.lstrip().startswith("#"):
            key, _, value = line.partition("=")
            values[key.strip()] = value.strip().strip('"').strip("'")
    return values


def clip_path(grid_id: str) -> Path:
    return VIDEO_DIR / f"grid-SBX-{grid_id}.mp4"


def duration_of(path: Path) -> float:
    out = subprocess.run(
        [
            "ffprobe",
            "-v",
            "error",
            "-show_entries",
            "format=duration",
            "-of",
            "csv=p=0",
            str(path),
        ],
        capture_output=True,
        text=True,
        check=False,
    )
    try:
        return float(out.stdout.strip())
    except ValueError:
        return 0.0


def record(grid_id: str, url: str, seconds: int, secrets: list[str]) -> tuple[str, str]:
    target = clip_path(grid_id)
    partial = target.with_suffix(".part.mp4")
    partial.unlink(missing_ok=True)
    cmd = [
        "ffmpeg", "-nostdin", "-hide_banner", "-loglevel", "error",
        "-rtsp_transport", "tcp", "-timeout", "15000000",
        "-i", url,
        "-t", str(seconds), "-map", "0:v:0", "-an", "-c:v", "copy",
        "-movflags", "+faststart", "-y", str(partial),
    ]  # fmt: skip
    started = time.monotonic()
    try:
        proc = subprocess.run(
            cmd, capture_output=True, text=True, timeout=seconds + 90, check=False
        )
        err = proc.stderr
    except subprocess.TimeoutExpired as exc:
        err = f"stopped after {seconds + 90}s; " + (exc.stderr or b"").decode(
            errors="replace"
        )
    for secret in secrets:
        err = err.replace(secret, "***")
    err = re.sub(r"//[^/@\s]*@", "//***@", err)
    got = duration_of(partial) if partial.exists() else 0.0
    took = time.monotonic() - started
    if got >= 10:
        partial.replace(target)
        size = target.stat().st_size / 1e6
        return grid_id, f"ok   {got:5.1f}s video  {size:5.1f} MB  in {took:4.0f}s"
    partial.unlink(missing_ok=True)
    last = err.strip().splitlines()[-1] if err.strip() else "no video received"
    return grid_id, f"FAIL {got:5.1f}s video  in {took:4.0f}s  ({last[:160]})"


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument(
        "cameras", nargs="*", help="grid ids such as cam10 (default: cam01..cam30)"
    )
    parser.add_argument("--seconds", type=int, default=60)
    parser.add_argument("--parallel", type=int, default=1)
    parser.add_argument(
        "--pause", type=float, default=10.0, help="seconds between clips"
    )
    parser.add_argument("--skip-existing", action="store_true")
    parser.add_argument(
        "--max-wait-min",
        type=float,
        default=45.0,
        help="when the grid refuses our login, keep waiting and retrying for this long in total",
    )
    args = parser.parse_args()

    env = read_env()
    host = env.get("SANDBOX_MEDIA_HOST") or "103.250.160.189"
    user, password = (
        env.get("SANDBOX_RTSP_USERNAME", ""),
        env.get("SANDBOX_RTSP_PASSWORD", ""),
    )
    auth = f"{quote(user, safe='')}:{quote(password, safe='')}@" if user else ""
    secrets = [s for s in (password, quote(password, safe=""), user) if s]

    ids = args.cameras or [f"cam{n:02d}" for n in range(1, 31)]
    if args.skip_existing:
        ids = [i for i in ids if not clip_path(i).exists()]
    VIDEO_DIR.mkdir(parents=True, exist_ok=True)

    def job(grid_id: str) -> tuple[str, str]:
        result = record(
            grid_id, f"rtsp://{auth}{host}:8554/stream/{grid_id}", args.seconds, secrets
        )
        print(f"{time.strftime('%H:%M:%S')} {result[0]}  {result[1]}", flush=True)
        return result

    # The grid answers 401 to an address it has decided is churning sessions,
    # for every camera, for minutes. Carrying on down the list only adds
    # refused logins, so a 401 stops the run, waits (2, 4, 8, then 15 min, as
    # the workers do) and retries the same cameras.
    waits = [120, 240, 480, 900]
    lockouts = 0
    waited = 0.0
    queue = list(ids)
    done: dict[str, str] = {}
    width = max(1, args.parallel)
    print(
        f"recording {len(queue)} cameras, {args.seconds}s each, {width} at a time",
        flush=True,
    )
    while queue:
        batch, queue = queue[:width], queue[width:]
        with ThreadPoolExecutor(max_workers=len(batch)) as pool:
            results = list(pool.map(job, batch))
        refused = [g for g, line in results if "401" in line]
        done.update((g, line) for g, line in results if g not in refused)
        if refused:
            queue = refused + queue
            delay = waits[min(lockouts, len(waits) - 1)]
            lockouts += 1
            if waited + delay > args.max_wait_min * 60:
                print(
                    f"grid still refusing after {waited / 60:.0f} min; stopping. Re-run with --skip-existing later."
                )
                break
            print(
                f"grid refused our login; waiting {delay // 60} min before trying {refused[0]} again",
                flush=True,
            )
            time.sleep(delay)
            waited += delay
            continue
        lockouts = 0
        if queue:
            time.sleep(args.pause)

    failed = [g for g, line in done.items() if line.startswith("FAIL")] + queue
    print(
        f"done: {len(ids) - len(failed)} recorded, {len(failed)} not recorded {' '.join(failed)}"
    )
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
