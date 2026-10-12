#!/usr/bin/env python3
"""Start or stop a camera's recorded-clip replay on the simulator, by hand.

The API does this itself when a camera with a recorded clip is onboarded,
edited or deleted. This is the manual lever — to restart a replay, or to take a
camera down on purpose and watch the health monitor raise `camera_down` — now
that the simulator refuses unsigned control calls. Runs inside the API image,
which holds the key the token is derived from:

    docker compose exec api python /app/scripts/simulator_control.py start JURY-02
    docker compose exec api python /app/scripts/simulator_control.py stop  JURY-02
"""

from __future__ import annotations

import argparse
import asyncio
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "services" / "api"))

from app.services import simulator_control  # noqa: E402


async def _run(action: str, code: str) -> bool:
    if action == "start":
        return await simulator_control.start(code)
    return await simulator_control.stop(code)


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Start or stop a recorded-clip replay."
    )
    parser.add_argument("action", choices=("start", "stop"))
    parser.add_argument("camera_code")
    args = parser.parse_args()
    ok = asyncio.run(_run(args.action, args.camera_code.upper()))
    print(
        f"{args.action} {args.camera_code.upper()}: {'ok' if ok else 'failed (see log)'}"
    )
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
