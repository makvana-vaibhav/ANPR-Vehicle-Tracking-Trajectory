"""Approximate camera positions, geocoded from the grid's camera names.

`data/seed/camera_positions.csv` is the committed record of what OpenStreetMap
Nominatim matched each grid camera's name to. What is pinned here is that only
confident matches move a camera, never onto a renamed or renumbered one, never
over a person's or the grid's own position, and that a re-sync keeps them.
"""

from __future__ import annotations

from dataclasses import replace

import pytest

from app.db.session import SessionLocal
from app.services import camera_positions as cp


@pytest.fixture(scope="module")
def positions() -> dict[str, cp.GeocodedPosition]:
    loaded = cp.load_positions()
    if not loaded:
        pytest.skip("data/seed/camera_positions.csv is not mounted")
    return loaded


class TestTheFile:
    def test_only_confident_geocodes_are_applied(self, positions) -> None:
        assert all(p.confidence in ("high", "medium") for p in positions.values())
        # A junction match; a town-only row; a camera nothing matched.
        assert "SBX-cam15" in positions  # Suvidha Crossroads
        assert "SBX-cam18" not in positions  # "Rajkot CCTV": the town only
        assert "SBX-cam22" not in positions  # "BK Mervada": not in OSM

    def test_every_position_is_in_gujarat_and_carries_its_source(self, positions) -> None:
        for p in positions.values():
            assert 20.0 <= p.lat <= 24.8 and 68.1 <= p.lon <= 74.5, p
            assert p.osm_type in ("node", "way", "relation") and p.osm_id.isdigit(), p
            assert p.query and p.note, p

    def test_the_file_credits_openstreetmap(self) -> None:
        path = cp.positions_file()
        assert path is not None
        text = path.read_text(encoding="utf-8")
        assert "© OpenStreetMap contributors" in text and "ODbL" in text
        assert "APPROXIMATE" in text


class TestWhenItApplies:
    def test_names_match_without_the_grids_index(self) -> None:
        assert cp.normalise_name("06 Timbavadi gate-Junagadh") == cp.normalise_name(
            "Timbavadi gate-Junagadh"
        )
        assert cp.normalise_name("Visat P2") != cp.normalise_name("Visat teen Rasta")

    def test_a_town_centre_or_unknown_placement_is_replaced(self, positions) -> None:
        name = positions["SBX-cam04"].grid_name
        for placement in ("placement:city", "placement:unknown", "placement:geocoded"):
            assert cp.override_for("SBX-cam04", name, placement, positions) is not None

    def test_a_renamed_or_renumbered_camera_keeps_its_position(self, positions) -> None:
        assert cp.override_for("SBX-cam04", "Somewhere new", "placement:city", positions) is None

    def test_a_person_or_the_grid_placed_it_and_that_wins(self, positions) -> None:
        name = positions["SBX-cam04"].grid_name
        # No placement tag: an operator typed coordinates in the registry form.
        assert cp.override_for("SBX-cam04", name, None, positions) is None
        # The grid published coordinates.
        assert cp.override_for("SBX-cam04", name, "placement:exact", positions) is None

    def test_the_placement_tag_is_replaced_not_added(self) -> None:
        tags = ["sandbox", "grid-id:cam04", "placement:city", "department-source:none"]
        assert cp.with_placement(tags, cp.GEOCODED_TAG) == [
            "sandbox",
            "grid-id:cam04",
            "department-source:none",
            "placement:geocoded",
        ]


@pytest.mark.integration
async def test_applying_moves_registered_grid_cameras(positions) -> None:
    """A dry run against the live registry, with a position nudged so there is
    always something to move — nothing is written."""
    nudged = {code: replace(p, lat=p.lat + 0.0001) for code, p in positions.items()}
    async with SessionLocal() as session:
        changes = await cp.apply_to_registry(session, nudged, dry_run=True)
        dirty = session.dirty
    if not changes:
        pytest.skip("no grid cameras registered — run scripts/sync_sandbox.py")
    moved = {c["camera_code"] for c in changes if c["moved"]}
    assert moved <= set(positions)
    assert "SBX-cam22" not in moved
    assert all(c["district"] for c in changes if c["moved"])
    assert not dirty, "a dry run changed the registry"
