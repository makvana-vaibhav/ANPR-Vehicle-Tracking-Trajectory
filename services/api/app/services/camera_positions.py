"""Approximate camera positions, geocoded from each camera's name.

The organisers' grid publishes a camera *name* and nothing else about where it
is ("Paldi Circle", "Timbavadi gate-Junagadh"). ``data/seed/camera_positions.csv``
records, per camera, what OpenStreetMap Nominatim matched that name to, with
the query, the OSM object and a confidence — one-off and cached, inside
Nominatim's usage policy. This module reads it and applies it.

Rules that keep it honest:

* Only rows marked ``geocoded`` with ``high`` or ``medium`` confidence move a
  camera. A ``city`` row (the name gives only a town) and an ``unknown`` row
  (nothing matched, or the match was ambiguous) change nothing.
* A row applies only while the camera still carries the name it was geocoded
  from. The grid renumbers; a position must never follow a camera id onto a
  different camera.
* A camera placed by the grid's own coordinates, or by an operator, is left
  alone: only placements this platform derived (town centre, unknown, or an
  earlier geocode) are replaced.
* The camera is tagged ``placement:geocoded`` — approximate, from the name,
  never surveyed — and the screens say so.

Positions are © OpenStreetMap contributors, ODbL 1.0 (see data/seed/README.md).
"""

from __future__ import annotations

import csv
import re
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from sqlalchemy.ext.asyncio import AsyncSession

from app.core.logging import get_logger

log = get_logger("api.camera_positions")

#: The tag a geocoded camera carries.
GEOCODED_TAG = "placement:geocoded"
PLACEMENT_PREFIX = "placement:"
#: Placements this platform derived itself, which a geocode may replace.
DERIVED_PLACEMENTS = frozenset(
    {"placement:city", "placement:unknown", "placement:none", GEOCODED_TAG}
)
#: Confidence levels that are applied.
APPLIED_CONFIDENCE = frozenset({"high", "medium"})

ATTRIBUTION = "© OpenStreetMap contributors (ODbL 1.0)"

_FILES = (
    Path("/data/seed/camera_positions.csv"),
    Path(__file__).resolve().parents[4] / "data" / "seed" / "camera_positions.csv",
)


@dataclass(frozen=True, slots=True)
class GeocodedPosition:
    """One camera's approximate position and where it came from."""

    camera_code: str
    grid_name: str
    lat: float
    lon: float
    confidence: str
    district: str | None
    query: str
    osm_type: str
    osm_id: str
    osm_name: str
    note: str


def normalise_name(name: str | None) -> str:
    """A camera name reduced to its letters and digits, without the grid's index.

    "06 Timbavadi gate-Junagadh" and "Timbavadi gate-Junagadh" are the same
    camera; "Janpath" and "Visat P2" are not.
    """
    text = (name or "").strip().lstrip("0123456789 -_.").lower()
    return re.sub(r"[^a-z0-9]+", "", text)


def positions_file() -> Path | None:
    for path in _FILES:
        if path.exists():
            return path
    return None


def load_positions(path: Path | None = None) -> dict[str, GeocodedPosition]:
    """The applicable rows, keyed by camera code. Empty when there is no file."""
    path = path or positions_file()
    if path is None:
        log.info("camera_positions.no_file")
        return {}
    with path.open(encoding="utf-8") as handle:
        lines = [line for line in handle if not line.startswith("#")]
    positions: dict[str, GeocodedPosition] = {}
    for row in csv.DictReader(lines):
        if (row.get("placement") or "").strip() != "geocoded":
            continue
        if (row.get("confidence") or "").strip() not in APPLIED_CONFIDENCE:
            continue
        try:
            lat, lon = float(row["lat"]), float(row["lon"])
        except (KeyError, TypeError, ValueError):
            continue
        if not (20.0 <= lat <= 24.8 and 68.1 <= lon <= 74.5):
            # Outside Gujarat: a bad row, never a camera position.
            log.warning("camera_positions.outside_gujarat", camera_code=row.get("camera_code"))
            continue
        code = (row.get("camera_code") or "").strip()
        positions[code] = GeocodedPosition(
            camera_code=code,
            grid_name=(row.get("grid_name") or "").strip(),
            lat=lat,
            lon=lon,
            confidence=row["confidence"].strip(),
            district=(row.get("district") or "").strip() or None,
            query=(row.get("query") or "").strip(),
            osm_type=(row.get("osm_type") or "").strip(),
            osm_id=(row.get("osm_id") or "").strip(),
            osm_name=(row.get("osm_name") or "").strip(),
            note=(row.get("note") or "").strip(),
        )
    return positions


def placement_of(tags: list[str] | None) -> str | None:
    """The camera's `placement:*` tag, if it has one."""
    return next((t for t in tags or () if t.startswith(PLACEMENT_PREFIX)), None)


def override_for(
    camera_code: str,
    name: str | None,
    placement: str | None,
    positions: dict[str, GeocodedPosition],
) -> GeocodedPosition | None:
    """The geocoded position to give this camera, or None to leave it as it is.

    `placement` is how the camera is placed now (its `placement:*` tag). None
    means a person placed it — every sync writes a placement tag, and the
    registry's edit form removes it when an operator types in coordinates —
    so their position wins; so do the grid's own coordinates.
    """
    position = positions.get(camera_code)
    if position is None:
        return None
    if normalise_name(name) != normalise_name(position.grid_name):
        # Renumbered, or renamed: the geocode was of a different name.
        log.warning(
            "camera_positions.name_changed",
            camera_code=camera_code,
            geocoded_from=position.grid_name,
            now_named=name,
        )
        return None
    if placement not in DERIVED_PLACEMENTS:
        return None
    return position


def with_placement(tags: list[str] | None, placement: str) -> list[str]:
    """`tags` with its placement tag replaced by `placement`."""
    kept = [t for t in tags or () if not t.startswith(PLACEMENT_PREFIX)]
    return [*kept, placement]


def describe(position: GeocodedPosition) -> dict[str, Any]:
    """What was matched, for logs and the apply script's report."""
    return {
        "camera_code": position.camera_code,
        "lat": position.lat,
        "lon": position.lon,
        "confidence": position.confidence,
        "osm": f"{position.osm_type}/{position.osm_id}",
        "osm_name": position.osm_name,
    }


async def apply_to_registry(
    session: AsyncSession,
    positions: dict[str, GeocodedPosition] | None = None,
    *,
    dry_run: bool = False,
) -> list[dict[str, Any]]:
    """Give each registered camera its geocoded position, where one applies.

    Also writes each grid camera's district in the boundary file's spelling,
    from its point, so "Ahmadabad" and "Ahmedabad" stop being two districts.
    Returns what changed (or would, on a dry run); the caller commits. Touches
    only the registry — never the grid.
    """
    from geoalchemy2.shape import to_shape
    from sqlalchemy import func, select

    from app.models.registry import Camera
    from app.services.fleet import district_at

    positions = load_positions() if positions is None else positions
    cameras = (
        await session.scalars(
            select(Camera).where(Camera.camera_code.like("SBX-%")).order_by(Camera.camera_code)
        )
    ).all()
    changes: list[dict[str, Any]] = []
    for camera in cameras:
        point = to_shape(camera.location)
        lat, lon = float(point.y), float(point.x)
        placement = placement_of(camera.tags)
        match = override_for(camera.camera_code, camera.name, placement, positions)
        if match is not None:
            lat, lon = match.lat, match.lon
            placement = GEOCODED_TAG
        if placement is None or placement in ("placement:unknown", "placement:none"):
            continue
        district = district_at(lat, lon) or camera.district
        tags = (
            camera.tags
            if placement_of(camera.tags) == placement
            else with_placement(camera.tags, placement)
        )
        moved = match is not None and (
            abs(float(point.y) - lat) > 1e-7 or abs(float(point.x) - lon) > 1e-7
        )
        if not moved and district == camera.district and tags == camera.tags:
            continue
        changes.append(
            {
                **(describe(match) if match else {"camera_code": camera.camera_code}),
                "moved": moved,
                "district": district,
                "previous_district": camera.district,
            }
        )
        if dry_run:
            continue
        if moved:
            camera.location = func.ST_SetSRID(func.ST_MakePoint(lon, lat), 4326)
        camera.district = district
        camera.tags = tags
        camera.updated_at = datetime.now(UTC)
    return changes
