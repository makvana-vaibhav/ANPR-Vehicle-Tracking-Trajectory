#!/usr/bin/env python3
"""Onboard the organisers' camera grid into the registry.

Reads the organisers' catalogue (``/cameras.json``, formerly ``/api/ingest``)
and creates or updates one camera row per entry. That is the answer to "how do
I know where a camera is": we do not guess it, and we do not invent it. The
catalogue is the source of truth; where it names a town we place the camera at
that town and say so, and cameras we cannot place are recorded as such rather
than dropped onto the map somewhere plausible.

The integration guide is explicit that "camera ids and the set of available
cameras can change", so this is a re-sync rather than a one-off import: run it
again and it reconciles.

    python scripts/sync_sandbox.py              # host from SANDBOX_BASE_URL
    python scripts/sync_sandbox.py --dry-run    # read and report, write nothing
    python scripts/sync_sandbox.py --positions-only   # geocoded positions only;
                                                      # the grid is not contacted

Positions: the catalogue gives a name, never coordinates. Where
``data/seed/camera_positions.csv`` holds a confident OpenStreetMap match for
that name, the camera is placed there and tagged ``placement:geocoded`` —
approximate, from the name, never surveyed; otherwise at its town's centre
(``placement:city``) or nowhere (``placement:unknown``).
"""

from __future__ import annotations

import argparse
import asyncio
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "services" / "api"))

from sqlalchemy import select  # noqa: E402

from app.adapters.base import AdapterError  # noqa: E402
from app.adapters.sandbox import (  # noqa: E402
    DEFAULT_MEDIA_HOST,
    RTSP_PORT,
    HostedGridAdapter,
)
from app.core.config import settings  # noqa: E402
from app.db.session import SessionLocal  # noqa: E402
from app.models.enums import CameraStatus, CameraType, Protocol, VmsVendor  # noqa: E402
from app.models.registry import Camera, Department, VmsInstance  # noqa: E402
from app.services import audit, camera_positions, grid_session  # noqa: E402
from app.services.fleet import district_at  # noqa: E402

VMS_NAME = "Hosted Camera Grid"
CODE_PREFIX = "SBX"
# The seed data is mounted at /data/seed in the containers, not beside the
# script. Resolving only beside the script found nothing in the API container,
# so every camera synced from there was left unplaced. Same rule as seed.py.
SEED_DIR = Path("/data/seed")
if not SEED_DIR.exists():  # running outside the container
    SEED_DIR = Path(__file__).resolve().parent.parent / "data" / "seed"
GAZETTEER = SEED_DIR / "gujarat_places.csv"

#: `cameras.location` is NOT NULL, so a camera we cannot place still needs a
#: point. It gets the state centroid and the tag `placement:unknown` — the tag
#: is what matters: it is the difference between "we do not know where this is"
#: and a coordinate that looks surveyed. Any map must filter on it.
GUJARAT_CENTROID = (22.2587, 71.1924)


def load_gazetteer() -> list[dict[str, str]]:
    """Keyword -> settlement, for placing cameras the catalogue does not locate."""
    import csv

    if not GAZETTEER.exists():
        return []
    with GAZETTEER.open(encoding="utf-8") as handle:
        rows = [line for line in handle if not line.startswith("#")]
    return list(csv.DictReader(rows))


#: Department codes for words that name the owner outright. A camera called
#: "Rajkot Bus Port" belongs to GSRTC and one at a gram panchayat to the
#: Panchayat department; a bare junction name says nothing about who runs it,
#: so it matches nothing here and stays unattributed rather than guessed.
OWNER_WORDS: tuple[tuple[str, str], ...] = (
    ("bus port", "GSRTC"),
    ("bus stand", "GSRTC"),
    ("bus station", "GSRTC"),
    ("depot", "GSRTC"),
    ("gsrtc", "GSRTC"),
    ("panchayat", "PANCHAYAT"),
    ("hospital", "HEALTH"),
    ("phc", "HEALTH"),
    ("chc", "HEALTH"),
    ("rlvd", "POLICE"),
    ("police", "POLICE"),
    ("municipal", "MUNICIPAL"),
    ("corporation", "MUNICIPAL"),
)


def owner_of(item, departments: dict[str, object]) -> tuple[object | None, str]:
    """The department a grid camera belongs to, and where that answer came from.

    The catalogue wins when it says. Otherwise only a word that names the owner
    outright counts; anything else is left unattributed and tagged as such.
    """
    published = next(
        (
            str(item.raw.get(key)).strip()
            for key in ("department", "dept", "owner", "agency")
            if item.raw.get(key)
        ),
        "",
    )
    if published:
        wanted = published.upper()
        for code, department_id in departments.items():
            if code == wanted or wanted.startswith(code):
                return department_id, "catalogue"
        return None, "catalogue-unmatched"

    text = f"{item.raw.get('location') or ''} {item.name}".lower()
    for word, code in OWNER_WORDS:
        if word in text and code in departments:
            return departments[code], "name"
    return None, "none"


def location_text(item) -> str:
    """The grid's own words for where a camera is.

    Its ``location`` field when it publishes one. Since October the catalogue
    carries only ``id`` and ``name``, and the name holds the same text
    ("06 Timbavadi gate-Junagadh"), so it is the fallback. Reading ``location``
    alone placed every camera at the state centroid, off the map.
    """
    return str(
        item.raw.get("location") or item.raw.get("name") or item.name or ""
    ).strip()


def without_index(text: str) -> str:
    """Drop the grid's own running number ("06 Timbavadi gate" -> "Timbavadi gate")."""
    cleaned = text.lstrip("0123456789 -_.").strip()
    return cleaned or text


def place(location: str, gazetteer: list[dict[str, str]]) -> dict[str, str] | None:
    """Match a location name to a settlement.

    Returns None rather than a guess when nothing matches. A camera with no
    coordinates is registered and watchable but stays off the map — putting it
    somewhere plausible would be worse than admitting we do not know.
    """
    text = (location or "").lower()
    for row in gazetteer:
        if row["keyword"] and row["keyword"].lower() in text:
            return row
    return None


async def reachable_transport(base_url: str, cameras: list) -> str:
    """Which transport this network can use: rtsp, hls, or neither.

    The integration guide anticipates this exactly — "If port 8554 is blocked on
    your network, use the HLS endpoint instead" — so probe once rather than
    registering RTSP URLs that will time out on every camera.
    """
    import asyncio

    import httpx

    # RTSP is served from the media host, never the CDN: probing 8554 on the
    # catalogue's host reports a working grid as unreachable.
    host = settings.sandbox_media_host or DEFAULT_MEDIA_HOST
    try:
        _r, w = await asyncio.wait_for(
            asyncio.open_connection(host, RTSP_PORT), timeout=8
        )
        w.close()
        await w.wait_closed()
        return "rtsp"
    except (OSError, asyncio.TimeoutError):
        pass

    sample = next((c for c in cameras if c.raw.get("_hls")), None)
    if sample is not None:
        url = sample.raw["_hls"]
        url = url if url.startswith("http") else f"{base_url.rstrip('/')}{url}"
        try:
            # HLS sits behind the same login as the catalogue.
            headers = await grid_session.session.headers()
            async with httpx.AsyncClient(timeout=10, follow_redirects=True) as client:
                response = await client.get(url, headers=headers)
            if response.status_code == 200 and "#EXTM3U" in response.text:
                return "hls"
        except httpx.HTTPError:
            pass
    return "none"


async def sync(base_url: str, dry_run: bool = False) -> int:
    adapter = HostedGridAdapter(name=VMS_NAME, base_url=base_url)

    print(f"reading catalogue from {base_url.rstrip('/')} ...")
    try:
        discovered = await adapter.list_cameras()
    except AdapterError as exc:
        # An unreachable catalogue is the normal first failure, and a traceback
        # tells the operator nothing they can act on.
        print(f"\ncould not read the catalogue: {exc}\n")
        print("Check that:")
        print("  * the host is the sandbox host from the organisers, not the")
        print("    public site (sentinel.gujarat.gov.in/api/ingest returns 404)")
        print("  * you are on a network permitted to reach it")
        print("  * the catalogue does not require an auth header — if it does,")
        print("    the adapter needs the credential wired through")
        return 1
    if not discovered:
        print(
            "catalogue returned no cameras — check the host and that you are authorised"
        )
        return 1

    gazetteer = load_gazetteer()
    transport = await reachable_transport(base_url, discovered)
    print(f"  usable transport from this network: {transport}")
    if transport == "none":
        print(
            "  neither RTSP (8554) nor HLS is reachable — cameras will register "
            "but cannot be watched from here"
        )

    with_location = [c for c in discovered if c.lat is not None and c.lon is not None]
    live = [c for c in discovered if c.is_live]
    print(
        f"  {len(discovered)} cameras, {len(with_location)} with coordinates, "
        f"{len(live)} reporting live"
    )
    codecs = sorted({c.codec for c in discovered if c.codec})
    resolutions = sorted({c.resolution for c in discovered if c.resolution})
    print(f"  codecs: {codecs or 'not reported'}")
    print(f"  resolutions: {resolutions or 'not reported'}")

    # Approximate positions geocoded from the cameras' names, applied on every
    # sync so that a re-sync never puts a camera back at its town centre.
    positions = camera_positions.load_positions()

    if dry_run:
        print("\n(dry run — nothing written)")
        for camera in discovered:
            code = f"{CODE_PREFIX}-{camera.external_id.zfill(5)}"
            hit = place(location_text(camera), gazetteer)
            where = f"{hit['place']} ({hit['precision']})" if hit else "UNPLACED"
            precision = hit["precision"] if hit else "unknown"
            if camera_positions.override_for(
                code, camera.name, f"placement:{precision}", positions
            ):
                where = "geocoded from the name (approximate)"
            print(f"  {camera.external_id:>5}  {camera.name[:38]:38}  {where:26}")
        return 0

    created = updated = skipped = from_gazetteer = geocoded = 0
    async with SessionLocal() as session:
        vms = (
            await session.execute(
                select(VmsInstance).where(VmsInstance.name == VMS_NAME)
            )
        ).scalar_one_or_none()
        if vms is None:
            vms = VmsInstance(
                name=VMS_NAME,
                vendor=VmsVendor.HOSTED_GRID.value,
                adapter_type="hosted_grid",
                base_url=base_url,
                # A pointer, never a secret: see CLAUDE.md on credentials_ref.
                credentials_ref="env:SANDBOX_CREDENTIALS",
                status=CameraStatus.ONLINE.value,
            )
            session.add(vms)
            await session.flush()
            print(f"  created VMS instance {vms.id}")
        else:
            vms.base_url = base_url

        departments = {
            department.code: department.id
            for department in (await session.scalars(select(Department))).all()
        }

        for item in discovered:
            code = f"{CODE_PREFIX}-{item.external_id.zfill(5)}"
            camera = (
                await session.execute(select(Camera).where(Camera.camera_code == code))
            ).scalar_one_or_none()

            # The catalogue publishes a location *name*, not coordinates. Where
            # the name identifies a settlement we place the camera at that
            # settlement's centre and record precision='city' — it is the town,
            # not the junction. Published coordinates, if they ever appear,
            # always win.
            lat, lon = item.lat, item.lon
            precision = "exact" if lat is not None else None
            hit_place = None
            if lat is None:
                hit_place = place(location_text(item), gazetteer)
                if hit_place:
                    lat, lon = float(hit_place["lat"]), float(hit_place["lon"])
                    precision = hit_place["precision"]
                    from_gazetteer += 1
                else:
                    lat, lon = GUJARAT_CENTROID
                    precision = "unknown"
                    skipped += 1

            # Closer than a town centre, though still approximate: what
            # OpenStreetMap matched the camera's name to. Never over the
            # grid's own coordinates (see app/services/camera_positions.py).
            match = camera_positions.override_for(
                code, item.name, f"placement:{precision}", positions
            )
            if match is not None:
                if precision == "unknown":
                    skipped -= 1
                elif hit_place is not None:
                    from_gazetteer -= 1
                lat, lon = match.lat, match.lon
                precision = "geocoded"
                geocoded += 1

            # Register the URL this network can actually open, not the one the
            # catalogue lists first.
            hls = item.raw.get("_hls") or ""
            if hls and not hls.startswith("http"):
                hls = f"{base_url.rstrip('/')}{hls}"
            stream_url = (
                item.stream_url if transport != "hls" else (hls or item.stream_url)
            )

            raw_location = without_index(location_text(item))
            department_id, department_source = owner_of(item, departments)
            if department_id is None and camera is not None and camera.department_id:
                # Set by an operator after an earlier sync; a catalogue that
                # says nothing is no reason to undo it.
                department_id, department_source = camera.department_id, "operator"
            fields = {
                "camera_code": code,
                "name": item.name,
                # Without this the camera has no VMS, so adapter_for falls back
                # to the generic RTSP adapter and hands the player our own
                # gateway's URLs for a camera our gateway has never seen.
                "vms_id": vms.id,
                "stream_url": stream_url,
                "sub_stream_url": hls or None,
                "protocol": Protocol.RTSP.value,
                "camera_type": CameraType.FIXED.value,
                "resolution": item.resolution,
                "fps": item.fps,
                "status": (
                    CameraStatus.ONLINE.value
                    if item.is_live
                    else CameraStatus.UNKNOWN.value
                ),
                # The grid's location string is the junction the camera watches;
                # the gazetteer supplies the settlement it sits in. Keeping both
                # means the map can show a city while the operator still sees
                # the junction name the organisers use.
                "junction": raw_location[:200] or None,
                "address": raw_location[:400] or None,
                "department_id": department_id,
                "anpr_enabled": True,
            }
            if hit_place is not None:
                fields["city"] = hit_place["place"]
                fields["district"] = hit_place["district"]
            if precision != "unknown":
                # One spelling for every district: the boundary file's, by the
                # point itself. The gazetteer says "Ahmadabad", the boundaries
                # "Ahmedabad", and the gap report counts by boundary.
                fields["district"] = district_at(lat, lon) or fields.get("district")

            # How the coordinate was arrived at travels with the camera, so a
            # city-level placement can never be mistaken for a surveyed one.
            fields["tags"] = [
                "sandbox",
                # The grid's own id, stored rather than derived from our code.
                # Their id format has already changed once (7 → cam07) and the
                # guide says the catalogue is the source of truth, so deriving
                # it would break silently the next time they renumber.
                f"grid-id:{item.external_id}",
                f"transport:{transport}",
                f"placement:{precision or 'none'}",
                # Who says this camera is that department's: the grid, a word
                # in its name, an operator, or nobody.
                f"department-source:{department_source}",
            ]

            if camera is None:
                camera = Camera(**fields)
                if lat is not None and lon is not None:
                    camera.location = f"SRID=4326;POINT({lon} {lat})"
                session.add(camera)
                created += 1
            else:
                for key, value in fields.items():
                    setattr(camera, key, value)
                if lat is not None and lon is not None:
                    camera.location = f"SRID=4326;POINT({lon} {lat})"
                updated += 1

        await session.commit()

    print(f"\n  created {created}, updated {updated}")
    print(f"  placed from the gazetteer (city precision): {from_gazetteer}")
    print(f"  geocoded from the name (approximate, OpenStreetMap): {geocoded}")
    print(f"  location not identifiable, tagged placement:unknown: {skipped}")
    if skipped:
        print("    (these sit at the state centroid so they can be watched; the tag")
        print("     is what stops the map treating that as a real position)")
    print("\nNext: point the AI worker at these cameras and open the map.")
    return 0


def _placement_note(item, precision: str | None, transport: str) -> str:
    """Say plainly where the coordinate came from and how the feed is reached."""
    source = item.raw.get("location", "")
    if precision == "exact":
        where = "coordinates published by the grid"
    elif precision:
        where = f"placed at settlement centre from '{source}' — town, not junction"
    else:
        where = f"no coordinates; '{source}' did not identify a settlement"
    return f"hosted grid. {where}. Watched over {transport.upper()}."


async def apply_positions(dry_run: bool = False) -> int:
    """Apply data/seed/camera_positions.csv to the registered grid cameras.

    Reads and writes the registry only — the grid is not contacted, so this
    is safe while it is refusing our session or rationing watch time.
    """
    async with SessionLocal() as session:
        changes = await camera_positions.apply_to_registry(session, dry_run=dry_run)
        if not dry_run:
            await session.commit()
    if changes and not dry_run:
        # Registry changes leave a trace, whoever makes them.
        await audit.record(
            action="camera.positions_applied",
            username="system:sync_sandbox",
            role="system",
            resource_type="camera",
            params={
                "source": "data/seed/camera_positions.csv (OpenStreetMap Nominatim)",
                "moved": [c["camera_code"] for c in changes if c.get("moved")],
                "districts_normalised": len(changes),
            },
        )
    for change in changes:
        where = (
            f"{change['lat']:.5f}, {change['lon']:.5f} ({change['confidence']}, "
            f"OSM {change['osm']} '{change['osm_name']}')"
            if change.get("moved")
            else "position unchanged"
        )
        print(
            f"  {change['camera_code']:<10} {where}; district "
            f"{change['previous_district']!r} -> {change['district']!r}"
        )
    verb = "would change" if dry_run else "changed"
    print(
        f"\n  {len(changes)} grid cameras {verb}. Positions are approximate, geocoded"
    )
    print("  from the camera's name: © OpenStreetMap contributors (ODbL 1.0).")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    parser.add_argument(
        "--base-url",
        # The value already lives in settings (SANDBOX_BASE_URL). Requiring it
        # again on the command line is why `make demo`, which passed nothing,
        # never onboarded the grid at all.
        default=settings.sandbox_base_url,
        help="sandbox host, e.g. https://<host>; defaults to SANDBOX_BASE_URL",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="show what the catalogue returns without writing",
    )
    parser.add_argument(
        "--positions-only",
        action="store_true",
        help=(
            "apply data/seed/camera_positions.csv to the registered grid cameras "
            "without reading the catalogue (no contact with the grid)"
        ),
    )
    args = parser.parse_args()
    if args.positions_only:
        return asyncio.run(apply_positions(args.dry_run))
    return asyncio.run(sync(args.base_url, args.dry_run))


if __name__ == "__main__":
    raise SystemExit(main())
