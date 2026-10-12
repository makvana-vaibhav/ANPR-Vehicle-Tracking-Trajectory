"""Candidate sightings: reads that may be the searched vehicle, misread.

The vehicle a judge names will often be in the database one or two characters
off. These pin down what makes a read a candidate, the reasons each carries,
that the route never takes one in unless an analyst includes it (and then
marks it everywhere), and that every decision lands in the audit trail.

The integration tests build their own reads in a fixed window in 2024, at the
registry's real cameras, so the distances and speeds are the ones the live
fleet would produce, and the live demo cannot interfere.
"""

from __future__ import annotations

import csv
import io
import uuid
from collections import Counter
from collections.abc import AsyncGenerator
from datetime import UTC, datetime, timedelta

import pytest
from httpx import AsyncClient, Response
from sqlalchemy import delete, func, select

from app.db.session import SessionLocal
from app.models.intelligence import Detection
from app.models.registry import Camera
from app.models.security import AuditLog
from app.services import candidates, correlator
from app.services.candidates import CandidateVisit, compare, confusable, near
from app.services.correlator import Hop

# ─────────────────────────────────────────────────────────────────────
# The matcher — pure
# ─────────────────────────────────────────────────────────────────────


class TestConfusions:
    @pytest.mark.parametrize(
        "pair",
        ["0O", "0D", "0Q", "OD", "DQ", "1I", "1L", "IL", "2Z", "5S", "6G", "8B", "4A"],
    )
    def test_the_common_misreadings_are_confusions(self, pair: str) -> None:
        a, b = pair
        assert confusable(a, b) and confusable(b, a)

    @pytest.mark.parametrize("pair", ["7T", "HN", "MN", "38", "0A", "AA"])
    def test_other_pairs_are_not(self, pair: str) -> None:
        a, b = pair
        assert not confusable(a, b)


class TestCompare:
    def test_names_a_misreading_and_charges_half(self) -> None:
        match = compare("GJ01AB1234", "GJ01A81234")
        assert match.cost == 0.5
        assert match.count == 1 and match.only_confusions
        assert match.describe() == (
            "1 character differs: B read as 8 at position 6 (a common misreading)"
        )

    def test_an_unrelated_substitution_costs_one(self) -> None:
        match = compare("GJ01AB1234", "GJ01AB1734")
        assert match.cost == 1.0 and match.confusions == 0
        assert match.edits[0].describe() == "2 read as 7 at position 8"

    def test_a_character_not_read(self) -> None:
        match = compare("GJ01AB1234", "GJ01AB123")
        assert match.cost == 1.0
        assert match.edits[0].kind == "missing"
        assert match.edits[0].describe() == "4 at position 10 not read"

    def test_an_extra_character(self) -> None:
        match = compare("GJ01AB1234", "GJ01AB12345")
        assert match.edits[0].kind == "extra"
        assert match.edits[0].describe() == "an extra 5 read after position 10"

    def test_prefers_one_substitution_to_a_missing_and_an_extra(self) -> None:
        match = compare("GJ01AB1234", "GJ01AB1Z34")
        assert [e.kind for e in match.edits] == ["substitution"]


class TestNear:
    def test_one_or_two_differences_on_a_full_plate(self) -> None:
        assert near("GJ01AB1234", "GJ01AB1734") is not None
        assert near("GJ01AB1234", "GJ01XB1734") is not None

    def test_three_unrelated_differences_are_another_plate(self) -> None:
        assert near("GJ01AB1234", "GJ01XY1734") is None

    def test_three_misreadings_still_count(self) -> None:
        match = near("GJ01AB1234", "GJ0IA81Z34")
        assert match is not None and match.cost == 1.5 and match.count == 3

    def test_but_never_four(self) -> None:
        assert near("GJ01AB1234", "GJ0IA8IZ34") is None

    def test_a_short_plate_allows_one(self) -> None:
        assert near("AB123", "AB173") is not None
        assert near("AB123", "XB173") is None

    def test_the_plate_itself_is_not_a_candidate(self) -> None:
        assert near("GJ01AB1234", "GJ01AB1234") is None


# ─────────────────────────────────────────────────────────────────────
# Assessment — pure, at the registry's real positions
# ─────────────────────────────────────────────────────────────────────
PALDI = (23.00937, 72.56212)  # CAM-DEMO-01
AHMEDABAD_CENTRE = (23.0225, 72.5714)  # SBX-cam01..05, 13..16 (town-level)
ADALAJ = (23.1645, 72.581)  # SBX-cam12
JUNAGADH = (21.5222, 70.4579)  # SBX-cam06, 08..11

T0 = datetime(2024, 5, 6, 8, 0, tzinfo=UTC)
TARGET = "ZZCAND1234"


def _hop(code: str, at: tuple[float, float], when: datetime) -> Hop:
    return Hop(
        camera_id=uuid.uuid5(uuid.NAMESPACE_DNS, code),
        camera_code=code,
        camera_name=code,
        city=None,
        district=None,
        lat=at[0],
        lon=at[1],
        arrived_at=when,
        departed_at=when,
        sightings=1,
        best_confidence=0.95,
    )


def _visit(
    read: str,
    code: str,
    at: tuple[float, float] | None,
    when: datetime,
    *,
    confidence: float = 0.9,
    vehicle: str = "car",
    town_level: bool = False,
) -> CandidateVisit:
    match = near(TARGET, read)
    assert match is not None
    return CandidateVisit(
        read_as=read,
        match=match,
        camera_id=uuid.uuid5(uuid.NAMESPACE_DNS, code),
        camera_code=code,
        camera_name=code,
        city=None,
        district=None,
        lat=at[0] if at else None,
        lon=at[1] if at else None,
        town_level=town_level,
        heading_deg=None,
        arrived_at=when,
        departed_at=when,
        best_confidence=confidence,
        best_detection_id=uuid.uuid4(),
        best_detection_ts=when,
        crop_key=None,
        member_ids=[uuid.uuid4()],
        vehicle_types=Counter([vehicle]),
    )


ROUTE = [
    _hop("CAM-DEMO-01", PALDI, T0),
    _hop("SBX-cam12", ADALAJ, T0 + timedelta(minutes=60)),
]


def _assess(visit: CandidateVisit, confirmed: list[Hop] = ROUTE) -> CandidateVisit:
    candidates._assess(visit, TARGET, confirmed, {}, set(), "car")
    return visit


class TestAssessment:
    def test_a_misreading_where_the_route_allows_is_strong(self) -> None:
        visit = _assess(
            _visit(
                "ZZCAND1Z34",
                "SBX-cam13",
                AHMEDABAD_CENTRE,
                T0 + timedelta(minutes=10),
                town_level=True,
            )
        )
        assert visit.fit == "fits"
        assert visit.strength == "strong"
        assert "reachable" in visit.fit_detail
        assert "from CAM-DEMO-01" in visit.fit_detail and "to SBX-cam12" in visit.fit_detail
        assert "approximate" in visit.fit_detail
        tones = {reason.factor: reason.tone for reason in visit.reasons}
        assert tones["route"] == "for" and tones["vehicle"] == "for"

    def test_a_read_the_route_makes_impossible_is_weak_and_says_why(self) -> None:
        visit = _assess(_visit("ZZCANO1234", "SBX-cam06", JUNAGADH, T0 + timedelta(minutes=20)))
        assert visit.fit == "conflicts"
        assert visit.strength == "weak"
        assert "faster than any vehicle" in visit.fit_detail

    def test_a_read_in_the_same_pass_is_named_as_one(self) -> None:
        visit = _assess(_visit("ZZCAMD1234", "CAM-DEMO-01", PALDI, T0 + timedelta(seconds=30)))
        assert visit.fit == "same_visit"
        assert visit.strength == "strong"
        assert "the same pass" in visit.fit_detail

    def test_an_unplaced_camera_cannot_be_checked(self) -> None:
        visit = _assess(_visit("ZZCAMB1234", "SBX-cam20", None, T0 + timedelta(minutes=5)))
        assert visit.fit == "unknown"
        assert "position unknown" in visit.fit_detail
        # Two unrelated differences and nothing to check them against.
        assert visit.strength == "weak"

    def test_with_no_confirmed_route_nothing_is_contradicted(self) -> None:
        visit = _assess(_visit("ZZCAND1Z34", "SBX-cam12", ADALAJ, T0), confirmed=[])
        assert visit.fit == "unknown"
        assert "no route to check it against" in visit.fit_detail

    def test_a_different_kind_of_vehicle_counts_against(self) -> None:
        visit = _assess(
            _visit(
                "ZZCAND1Z34",
                "SBX-cam13",
                AHMEDABAD_CENTRE,
                T0 + timedelta(minutes=10),
                vehicle="motorcycle",
                town_level=True,
            )
        )
        assert visit.strength == "weak"
        vehicle = next(r for r in visit.reasons if r.factor == "vehicle")
        assert vehicle.tone == "against" and "motorcycle" in vehicle.detail

    def test_a_weak_read_says_check_the_crop(self) -> None:
        visit = _assess(
            _visit("ZZCAND1Z34", "SBX-cam12", ADALAJ, T0 + timedelta(minutes=61), confidence=0.3)
        )
        confidence = next(r for r in visit.reasons if r.factor == "confidence")
        assert confidence.tone == "against" and "check the crop" in confidence.detail


class TestAssembledRoute:
    def test_an_included_candidate_stays_a_separate_marked_visit(self) -> None:
        sightings = [
            correlator.Sighting(
                detection_id=uuid.uuid4(),
                ts=T0,
                camera_id=ROUTE[0].camera_id,
                camera_code="CAM-DEMO-01",
                camera_name="CAM-DEMO-01",
                city=None,
                district=None,
                lat=PALDI[0],
                lon=PALDI[1],
                heading_deg=None,
                plate_confidence=0.95,
            )
        ]
        same_pass = _visit("ZZCAMD1234", "CAM-DEMO-01", PALDI, T0 + timedelta(seconds=30))
        route = correlator.assemble_route(
            TARGET, sightings, [], T0, None, extra_hops=[same_pass.as_hop()]
        )
        assert len(route.hops) == 2, "a candidate must never be merged into a confirmed visit"
        candidate = route.hops[1]
        assert candidate.candidate and candidate.read_as == "ZZCAMD1234"
        # Not "revisit": the vehicle did not come back, it was read two ways.
        assert candidate.flags == ["same_visit"]
        body = route.to_dict()
        assert body["candidate_hop_count"] == 1
        assert body["hops"][1]["candidate"] is True
        assert "not confirmed sightings" in body["candidate_note"]

    def test_a_route_without_candidates_says_nothing_about_them(self) -> None:
        body = correlator.assemble_route(TARGET, [], [], T0, None).to_dict()
        assert body["candidate_hop_count"] == 0 and body["candidate_note"] is None


# ─────────────────────────────────────────────────────────────────────
# Over HTTP, against the database
# ─────────────────────────────────────────────────────────────────────
WINDOW = {"since": "2024-05-06T07:00:00Z", "until": "2024-05-06T10:00:00Z"}

FITS = "ZZCAND1Z34"  # 2 read as Z: a misreading, somewhere the route allows
CONFLICTS = "ZZCANO1234"  # D read as O, but 280 km away 20 minutes later
SAME_PASS = "ZZCAMD1234"  # N read as M, at the same camera in the same pass
UNPLACED = "ZZCAMB1234"  # two unrelated differences, at an unplaced camera
FAR = "ZZCAXY9934"  # too many differences: another vehicle
PLATES = [TARGET, FITS, CONFLICTS, SAME_PASS, UNPLACED, FAR]


async def _camera(code: str) -> uuid.UUID:
    async with SessionLocal() as session:
        camera_id = await session.scalar(select(Camera.id).where(Camera.camera_code == code))
    if camera_id is None:
        pytest.skip(f"{code} is not in the registry")
    return camera_id


async def _read(plate: str, code: str, when: datetime, vehicle: str = "car") -> uuid.UUID:
    detection_id = uuid.uuid4()
    async with SessionLocal() as session:
        session.add(
            Detection(
                id=detection_id,
                ts=when,
                camera_id=await _camera(code),
                track_id=f"candidates-test-{detection_id.hex[:8]}",
                plate_normalised=plate,
                plate_text=plate,
                plate_confidence=0.9,
                vehicle_type=vehicle,
            )
        )
        await session.commit()
    return detection_id


async def _cleanup() -> None:
    async with SessionLocal() as session:
        await session.execute(
            delete(Detection).where(
                Detection.plate_normalised.in_(PLATES),
                Detection.ts >= datetime(2024, 5, 6, tzinfo=UTC),
                Detection.ts < datetime(2024, 5, 7, tzinfo=UTC),
            )
        )
        await session.commit()


@pytest.fixture
async def scenario() -> AsyncGenerator[dict[str, uuid.UUID], None]:
    await _cleanup()
    ids = {
        "target_paldi": await _read(TARGET, "CAM-DEMO-01", T0),
        "target_adalaj": await _read(TARGET, "SBX-cam12", T0 + timedelta(minutes=60)),
        "fits": await _read(FITS, "SBX-cam13", T0 + timedelta(minutes=10)),
        "conflicts": await _read(
            CONFLICTS, "SBX-cam06", T0 + timedelta(minutes=20), vehicle="motorcycle"
        ),
        "same_pass": await _read(SAME_PASS, "CAM-DEMO-01", T0 + timedelta(seconds=30)),
        "unplaced": await _read(UNPLACED, "SBX-cam20", T0 + timedelta(minutes=5)),
        "far": await _read(FAR, "SBX-cam12", T0 + timedelta(minutes=30)),
    }
    yield ids
    await _cleanup()


async def _rows(action: str, resource_id: str) -> int:
    async with SessionLocal() as session:
        return (
            await session.execute(
                select(func.count())
                .select_from(AuditLog)
                .where(AuditLog.action == action, AuditLog.resource_id == resource_id)
            )
        ).scalar_one()


@pytest.mark.integration
class TestCandidatesEndpoint:
    async def test_lists_the_near_reads_with_their_reasons(
        self, client: AsyncClient, auth_headers, scenario
    ) -> None:
        response = await client.get(
            f"/api/v1/vehicles/{TARGET}/candidates",
            params=WINDOW,
            headers=await auth_headers("analyst"),
        )
        assert response.status_code == 200, response.text
        body = response.json()
        found = {c["read_as"]: c for c in body["candidates"]}
        assert set(found) == {
            FITS,
            CONFLICTS,
            SAME_PASS,
            UNPLACED,
        }, "the plate itself and a read with too many differences are not candidates"
        # What would add to the journey first; the same pass read two ways last.
        assert [c["read_as"] for c in body["candidates"]] == [
            FITS,
            UNPLACED,
            CONFLICTS,
            SAME_PASS,
        ]
        assert found[FITS]["strength"] == "strong"
        assert found[FITS]["fit"]["status"] == "fits"
        assert "2 read as Z at position 8 (a common misreading)" in found[FITS]["difference"]
        assert found[CONFLICTS]["fit"]["status"] == "conflicts"
        assert found[UNPLACED]["placed"] is False and found[UNPLACED]["lat"] is None
        assert found[SAME_PASS]["fit"]["status"] == "same_visit"
        assert {"factor", "detail", "tone"} <= set(found[FITS]["reasons"][0])
        assert body["counts"] == {"fits": 1, "unknown": 1, "conflicts": 1, "same_visit": 1}
        assert body["target_vehicle_type"] == "car"

    async def test_writes_one_audit_row_naming_the_plate(
        self, client: AsyncClient, auth_headers, scenario
    ) -> None:
        searches = await _rows("search.plate", TARGET)
        generic = await _rows("vehicle.read", TARGET)
        await client.get(
            f"/api/v1/vehicles/{TARGET}/candidates",
            params=WINDOW,
            headers=await auth_headers("analyst"),
        )
        assert await _rows("search.plate", TARGET) == searches + 1
        assert await _rows("vehicle.read", TARGET) == generic, "one row per request, not two"

    async def test_an_auditor_may_not_look(self, client: AsyncClient, auth_headers) -> None:
        response = await client.get(
            f"/api/v1/vehicles/{TARGET}/candidates", headers=await auth_headers("auditor")
        )
        assert response.status_code == 403


@pytest.mark.integration
class TestIncludingCandidates:
    async def test_the_route_takes_only_what_was_included_and_marks_it(
        self, client: AsyncClient, auth_headers, scenario
    ) -> None:
        headers = await auth_headers("analyst")
        plain = (
            await client.get(f"/api/v1/vehicles/{TARGET}/route", params=WINDOW, headers=headers)
        ).json()
        assert [h["camera_code"] for h in plain["hops"]] == ["CAM-DEMO-01", "SBX-cam12"]
        assert plain["candidate_hop_count"] == 0

        response = await client.get(
            f"/api/v1/vehicles/{TARGET}/route",
            params={
                **WINDOW,
                "include": [str(scenario["fits"]), str(scenario["unplaced"])],
            },
            headers=headers,
        )
        assert response.status_code == 200, response.text
        body = response.json()
        assert [h["camera_code"] for h in body["hops"]] == ["CAM-DEMO-01", "SBX-cam13", "SBX-cam12"]
        middle = body["hops"][1]
        assert middle["candidate"] is True and middle["read_as"] == FITS
        assert body["hops"][0]["candidate"] is False
        assert [s["read_as"] for s in body["unplaced_sightings"]] == [UNPLACED]
        assert body["candidate_hop_count"] == 2
        assert body["candidates_missing"] == []

    async def test_an_inclusion_outside_the_window_is_reported_not_dropped(
        self, client: AsyncClient, auth_headers, scenario
    ) -> None:
        stray = str(uuid.uuid4())
        body = (
            await client.get(
                f"/api/v1/vehicles/{TARGET}/route",
                params={**WINDOW, "include": [stray]},
                headers=await auth_headers("analyst"),
            )
        ).json()
        assert body["candidates_missing"] == [stray]
        assert body["candidate_hop_count"] == 0

    async def test_the_csv_flags_the_candidate_three_ways(
        self, client: AsyncClient, auth_headers, scenario
    ) -> None:
        response = await client.get(
            f"/api/v1/reports/vehicle/{TARGET}.csv",
            params={**WINDOW, "include": [str(scenario["fits"])]},
            headers=await auth_headers("analyst"),
        )
        assert response.status_code == 200, response.text
        rows = list(csv.DictReader(io.StringIO(response.text.lstrip("﻿"))))
        assert [row["sighting"] for row in rows] == ["confirmed", "candidate", "confirmed"]
        assert rows[1]["read_as"] == FITS
        assert rows[1]["notes"].startswith(f"CANDIDATE: read as {FITS}")


@pytest.mark.integration
class TestDecisions:
    async def _decide(
        self,
        client: AsyncClient,
        headers: dict[str, str],
        detection_id: uuid.UUID,
        when: datetime,
        decision: str,
    ) -> Response:
        return await client.post(
            f"/api/v1/vehicles/{TARGET}/candidates/decisions",
            json={
                "detection_id": str(detection_id),
                "detection_ts": when.isoformat(),
                "decision": decision,
            },
            headers=headers,
        )

    async def test_each_decision_is_its_own_audit_row(
        self, client: AsyncClient, auth_headers, scenario
    ) -> None:
        headers = await auth_headers("analyst")
        target = str(scenario["fits"])
        before = {a: await _rows(f"candidate.{a}", target) for a in ("include", "dismiss", "undo")}
        generic = await _rows("vehicle.create", TARGET)
        when = T0 + timedelta(minutes=10)
        for decision in ("include", "undo", "dismiss"):
            response = await self._decide(client, headers, scenario["fits"], when, decision)
            assert response.status_code == 201, response.text
            body = response.json()
            assert body["decision"] == decision and body["read_as"] == FITS
            assert body["decided_by"] == "analyst"
        for action in ("include", "dismiss", "undo"):
            assert await _rows(f"candidate.{action}", target) == before[action] + 1
        async with SessionLocal() as session:
            row = await session.scalar(
                select(AuditLog)
                .where(AuditLog.action == "candidate.include", AuditLog.resource_id == target)
                .order_by(AuditLog.ts.desc())
                .limit(1)
            )
        assert row is not None and row.params is not None
        assert row.params["plate"] == TARGET and row.params["read_as"] == FITS
        assert "a common misreading" in row.params["difference"]
        # The middleware's generic row is not written beside the explicit one.
        assert await _rows("vehicle.create", TARGET) == generic

    async def test_refuses_a_read_of_the_plate_itself(
        self, client: AsyncClient, auth_headers, scenario
    ) -> None:
        response = await client.post(
            f"/api/v1/vehicles/{TARGET}/candidates/decisions",
            json={
                "detection_id": str(scenario["target_paldi"]),
                "detection_ts": T0.isoformat(),
                "decision": "include",
            },
            headers=await auth_headers("analyst"),
        )
        assert response.status_code == 422
        assert "not a candidate" in response.json()["detail"]

    async def test_refuses_a_read_too_far_from_the_plate(
        self, client: AsyncClient, auth_headers, scenario
    ) -> None:
        response = await client.post(
            f"/api/v1/vehicles/{TARGET}/candidates/decisions",
            json={
                "detection_id": str(scenario["far"]),
                "detection_ts": (T0 + timedelta(minutes=30)).isoformat(),
                "decision": "include",
            },
            headers=await auth_headers("analyst"),
        )
        assert response.status_code == 422

    async def test_an_unknown_sighting_is_not_found(
        self, client: AsyncClient, auth_headers
    ) -> None:
        response = await client.post(
            f"/api/v1/vehicles/{TARGET}/candidates/decisions",
            json={
                "detection_id": str(uuid.uuid4()),
                "detection_ts": T0.isoformat(),
                "decision": "dismiss",
            },
            headers=await auth_headers("analyst"),
        )
        assert response.status_code == 404

    async def test_an_auditor_may_not_decide(self, client: AsyncClient, auth_headers) -> None:
        response = await client.post(
            f"/api/v1/vehicles/{TARGET}/candidates/decisions",
            json={
                "detection_id": str(uuid.uuid4()),
                "detection_ts": T0.isoformat(),
                "decision": "include",
            },
            headers=await auth_headers("auditor"),
        )
        assert response.status_code == 403
