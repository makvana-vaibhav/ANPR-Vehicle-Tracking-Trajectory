"""Switch the organisers' grid cameras between the live grid and local recordings.

    make grid-replay          # every SBX-* camera with a recording plays it
    make grid-live            # back to the live grid
    docker compose exec -T api python -m scripts.grid_replay status

The recordings come from `scripts/record_grid.py` (`data/videos/grid-SBX-camNN.mp4`).
A camera switched to replay keeps its code, name, position and history; it
becomes a "Recorded video" camera exactly like one onboarded that way in the UI
(`source_file` set, no VMS, no stream URL), so the simulator publishes the clip
into the camera's own gateway path and the AI workers, the health monitor and
the browser all read it from there. The UI labels it "Recorded clip", and the
`recorded-footage` tag keeps it out of Insights and the anomaly baseline, so a
loop never passes for live traffic.

Why: the venue network (~1 Mbps) and the grid's watch-time quota made the live
feeds come and go. `off` restores the grid binding from the grid id the camera
already carries (`grid-id:camNN`), so nothing is lost by switching.
"""

from __future__ import annotations

import argparse
import asyncio
import sys
from pathlib import Path

# The script runs from /app inside the container; make the API package importable.
sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "services" / "api"))

from sqlalchemy import select  # noqa: E402
from sqlalchemy.orm import selectinload  # noqa: E402

from app.adapters import adapter_for  # noqa: E402
from app.db.session import SessionLocal, dispose_engine  # noqa: E402
from app.models.enums import AdapterType  # noqa: E402
from app.models.registry import Camera, VmsInstance  # noqa: E402
from app.services import audit, fleet_roster, gateway, simulator_control  # noqa: E402

VIDEO_DIR = Path("/data/videos")
REPLAY_TAGS = ("recorded-footage", "grid-replay")


def clip_name(camera_code: str) -> str:
    return f"grid-{camera_code}.mp4"


def grid_id_of(camera: Camera) -> str | None:
    for tag in camera.tags or []:
        if tag.startswith("grid-id:"):
            return tag.split(":", 1)[1]
    return None


async def grid_cameras() -> list[Camera]:
    async with SessionLocal() as session:
        return list(
            (
                await session.scalars(
                    select(Camera)
                    .options(selectinload(Camera.vms))
                    .where(Camera.camera_code.like("SBX-%"))
                    .order_by(Camera.camera_code)
                )
            ).all()
        )


async def to_replay(only: set[str]) -> None:
    switched: list[str] = []
    missing: list[str] = []
    async with SessionLocal() as session:
        cameras = (
            await session.scalars(
                select(Camera)
                .where(Camera.camera_code.like("SBX-%"))
                .order_by(Camera.camera_code)
            )
        ).all()
        for camera in cameras:
            if only and camera.camera_code not in only:
                continue
            clip = clip_name(camera.camera_code)
            if not (VIDEO_DIR / clip).is_file():
                missing.append(camera.camera_code)
                continue
            if (
                camera.source_file == clip
                and not camera.stream_url
                and camera.vms_id is None
            ):
                continue
            camera.source_file = clip
            camera.stream_url = None
            camera.sub_stream_url = None
            camera.vms_id = None
            camera.tags = [
                *(camera.tags or []),
                *(t for t in REPLAY_TAGS if t not in (camera.tags or [])),
            ]
            switched.append(camera.camera_code)
        await session.commit()

    for code in switched:
        # The gateway's pull of the grid URL goes first, so the simulator's
        # publish into the same path never contends with it.
        await gateway.unregister(code)
        await simulator_control.start(code)
    if switched:
        await fleet_roster.notify_changed("grid.replay", None)
        await audit.record(
            action="camera.update",
            username="system:grid_replay",
            role="system",
            resource_type="camera",
            params={"fields": ["source"], "source": "recorded", "cameras": switched},
        )
    print(f"replaying {len(switched)} cameras: {' '.join(switched) or '-'}")
    if missing:
        print(f"no recording yet (left on the grid): {' '.join(missing)}")


async def to_live(only: set[str]) -> None:
    switched: list[str] = []
    async with SessionLocal() as session:
        grid = await session.scalar(
            select(VmsInstance).where(
                VmsInstance.adapter_type == AdapterType.HOSTED_GRID.value
            )
        )
        if grid is None:
            print("no hosted-grid VMS registered; nothing to restore")
            return
        adapter = adapter_for(grid)
        cameras = (
            await session.scalars(
                select(Camera)
                .where(Camera.camera_code.like("SBX-%"))
                .order_by(Camera.camera_code)
            )
        ).all()
        for camera in cameras:
            if only and camera.camera_code not in only:
                continue
            grid_id = grid_id_of(camera)
            if grid_id is None or "grid-replay" not in (camera.tags or []):
                continue
            camera.vms_id = grid.id
            camera.stream_url = adapter._endpoints_for(grid_id).rtsp  # type: ignore[attr-defined]
            camera.source_file = None
            camera.tags = [t for t in (camera.tags or []) if t not in REPLAY_TAGS]
            switched.append(camera.camera_code)
        await session.commit()
        await adapter.close()

    refreshed = {c.camera_code: c for c in await grid_cameras()}
    for code in switched:
        await simulator_control.stop(code)
        await gateway.register(refreshed[code])
    if switched:
        await fleet_roster.notify_changed("grid.live", None)
        await audit.record(
            action="camera.update",
            username="system:grid_replay",
            role="system",
            resource_type="camera",
            params={"fields": ["source"], "source": "stream", "cameras": switched},
        )
    print(
        f"back on the live grid: {len(switched)} cameras: {' '.join(switched) or '-'}"
    )


async def status() -> None:
    cameras = await grid_cameras()
    replay = [c.camera_code for c in cameras if c.source_file]
    live = [c.camera_code for c in cameras if not c.source_file]
    recorded = sorted(
        p.name for p in VIDEO_DIR.glob("grid-SBX-*.mp4") if ".part" not in p.name
    )
    print(f"replaying ({len(replay)}): {' '.join(replay) or '-'}")
    print(f"live grid ({len(live)}): {' '.join(live) or '-'}")
    print(f"recordings on disk: {len(recorded)}")


async def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("mode", choices=["on", "off", "status"])
    parser.add_argument(
        "cameras", nargs="*", help="camera codes, e.g. SBX-cam10 (default: all)"
    )
    args = parser.parse_args()
    only = {c.upper().replace("SBX-CAM", "SBX-cam") for c in args.cameras}
    try:
        if args.mode == "on":
            await to_replay(only)
        elif args.mode == "off":
            await to_live(only)
        else:
            await status()
    finally:
        await dispose_engine()


if __name__ == "__main__":
    asyncio.run(main())
