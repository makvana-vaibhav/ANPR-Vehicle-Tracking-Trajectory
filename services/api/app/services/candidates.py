"""Sightings that may be the searched vehicle, read differently.

The vehicle an investigator asks about is often in the database under a
slightly different plate: OCR read `GJ01AB1234` as `GJ01A81234`, dropped a
character off a dirty plate, or read the `0` of a worn plate as an `O`. A route
built from exact matches alone then shows a gap exactly where the vehicle was.

This module finds those reads — **candidate sightings** — and says, for each
one, why it might be the vehicle and why it might not:

* **how the plate differs**: which characters, and whether each difference is
  one plate readers commonly make (0/O/D/Q, 1/I/L, 2/Z, 5/S, 6/G, 8/B, 4/A);
* **how well it was read**: the reader's own confidence;
* **whether it fits the confirmed route** in time and space — reachable from
  the confirmed sighting before it and to the one after it at a speed the
  correlator accepts, by the correlator's own rules (`score_legs`);
* **what kind of vehicle it was**, against the confirmed reads.

## Never merged silently

A candidate is a read of a *different plate*. It never joins the route on its
own: an analyst includes it (or dismisses it), each decision is a deliberate,
audited act, and an included candidate stays a separate visit marked
`candidate` everywhere the route is shown — map, sightings list, CSV and the
printed report. `route_with_candidates` builds that route.

## How "near" is measured

A weighted edit distance: a substitution between two characters in the same
confusion group costs `CONFUSION_COST`, any other substitution, a missing or
an extra character costs 1. A read is a candidate when the weighted distance is
at most `max_cost` (2 for a plate of six characters or more, 1 below that) and
no more than `MAX_EDITS` characters differ. Two unrelated edits on a ten
character plate are therefore a candidate — ranked below one that differs only
by confusions — and three confusions are, but a plate with four differences is
not.
"""

from __future__ import annotations

import dataclasses
import math
import uuid
from collections import Counter
from collections.abc import Sequence
from dataclasses import dataclass, field
from datetime import datetime
from typing import Any, Literal

from geoalchemy2 import Geometry
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.intelligence import Detection
from app.models.registry import Camera
from app.services import correlator, evidence
from app.services.correlator import DWELL_WINDOW, UNPLACED_TAG, Hop, Route, Sighting

#: Characters plate readers confuse with one another. One group per shape.
CONFUSION_GROUPS: tuple[str, ...] = ("0ODQ", "1IL", "2Z", "5S", "6G", "8B", "4A")

_GROUP_OF: dict[str, int] = {
    char: index for index, group in enumerate(CONFUSION_GROUPS) for char in group
}

#: What a substitution inside one confusion group costs, against 1 for any
#: other difference. Half: two confusions weigh what one unrelated error does.
CONFUSION_COST = 0.5

#: Never more characters different than this, however cheap each one is.
MAX_EDITS = 3

#: A position the grid's catalogue gave only as a town: the camera stands at
#: that town's centre on the map, so a distance to it is approximate.
TOWN_LEVEL_TAG = "placement:city"

#: Distinct plates read in a window that are compared against the target.
#: Generous — a busy week is a few thousand — and a bound all the same.
MAX_DISTINCT_PLATES = 50_000

#: Near plates whose sightings are fetched, closest first.
MAX_NEAR_PLATES = 40

#: Sightings fetched for those plates, newest first.
MAX_CANDIDATE_SIGHTINGS = 5_000

#: Candidate visits returned by default.
DEFAULT_LIMIT = 30

#: An exact reading that recurs on this many visits is worth saying so about:
#: a misread is usually a one-off, while a real plate keeps being read.
RECURRENCE_NOTE_AT = 3

#: Below this a read is weak enough to say so beside it.
WEAK_READ = 0.5

EditKind = Literal["substitution", "missing", "extra"]
Fit = Literal["same_visit", "fits", "unknown", "conflicts"]
Strength = Literal["strong", "possible", "weak"]
Tone = Literal["for", "against", "neutral"]

#: The order candidates are listed in. What would *add* to the journey comes
#: first: a read that fits the route somewhere it was not confirmed, then one
#: that cannot be checked, then one the route contradicts. A read inside a
#: confirmed visit is the strongest evidence of a misreading and adds nothing
#: to where the vehicle went, so it comes last.
_FIT_ORDER: dict[str, int] = {"fits": 0, "unknown": 1, "conflicts": 2, "same_visit": 3}
_STRENGTH_ORDER: dict[str, int] = {"strong": 0, "possible": 1, "weak": 2}


def confusable(a: str, b: str) -> bool:
    """Whether a plate reader commonly mistakes one of these for the other."""
    group = _GROUP_OF.get(a)
    return a != b and group is not None and group == _GROUP_OF.get(b)


# ─────────────────────────────────────────────────────────────────────
# Comparing two plates
# ─────────────────────────────────────────────────────────────────────
@dataclass(frozen=True, slots=True)
class Edit:
    """One difference between the plate asked about and the plate read."""

    kind: EditKind
    #: 1-based position in the plate asked about. For an extra character, the
    #: position it follows (0: before the first character).
    position: int
    expected: str | None
    read: str | None
    confusion: bool

    def describe(self) -> str:
        if self.kind == "substitution":
            text = f"{self.expected} read as {self.read} at position {self.position}"
            return f"{text} (a common misreading)" if self.confusion else text
        if self.kind == "missing":
            return f"{self.expected} at position {self.position} not read"
        if self.position == 0:
            return f"an extra {self.read} read before the first character"
        return f"an extra {self.read} read after position {self.position}"

    def to_dict(self) -> dict[str, Any]:
        return {
            "kind": self.kind,
            "position": self.position,
            "expected": self.expected,
            "read": self.read,
            "confusion": self.confusion,
            "text": self.describe(),
        }


@dataclass(frozen=True, slots=True)
class PlateMatch:
    """How a read differs from the plate asked about."""

    edits: tuple[Edit, ...]
    cost: float

    @property
    def count(self) -> int:
        return len(self.edits)

    @property
    def confusions(self) -> int:
        return sum(1 for edit in self.edits if edit.confusion)

    @property
    def only_confusions(self) -> bool:
        """Every difference is a common misreading of the right character."""
        return bool(self.edits) and all(edit.confusion for edit in self.edits)

    def describe(self) -> str:
        """`1 character differs: B read as 8 at position 6 (a common misreading)`."""
        if not self.edits:
            return "identical"
        verb = "differs" if self.count == 1 else "differ"
        noun = "character" if self.count == 1 else "characters"
        return f"{self.count} {noun} {verb}: " + "; ".join(e.describe() for e in self.edits)


def compare(target: str, read: str) -> PlateMatch:
    """Weighted edit distance from `target` to `read`, with the edits named.

    Levenshtein with a cheaper substitution inside a confusion group. The
    backtrace prefers a substitution to a missing-plus-extra pair, so "B read
    as 8" is reported as that rather than as two unrelated errors.
    """
    rows, cols = len(target), len(read)
    cost = [[0.0] * (cols + 1) for _ in range(rows + 1)]
    for i in range(1, rows + 1):
        cost[i][0] = float(i)
    for j in range(1, cols + 1):
        cost[0][j] = float(j)

    def substitution(i: int, j: int) -> float:
        a, b = target[i - 1], read[j - 1]
        if a == b:
            return 0.0
        return CONFUSION_COST if confusable(a, b) else 1.0

    for i in range(1, rows + 1):
        for j in range(1, cols + 1):
            cost[i][j] = min(
                cost[i - 1][j - 1] + substitution(i, j),
                cost[i - 1][j] + 1.0,
                cost[i][j - 1] + 1.0,
            )

    edits: list[Edit] = []
    i, j = rows, cols
    while i > 0 or j > 0:
        if i > 0 and j > 0:
            step = substitution(i, j)
            if math.isclose(cost[i][j], cost[i - 1][j - 1] + step):
                if step:
                    a, b = target[i - 1], read[j - 1]
                    edits.append(Edit("substitution", i, a, b, confusable(a, b)))
                i, j = i - 1, j - 1
                continue
        if i > 0 and math.isclose(cost[i][j], cost[i - 1][j] + 1.0):
            edits.append(Edit("missing", i, target[i - 1], None, False))
            i -= 1
            continue
        edits.append(Edit("extra", i, None, read[j - 1], False))
        j -= 1
    edits.reverse()
    return PlateMatch(edits=tuple(edits), cost=cost[rows][cols])


def max_cost(target: str) -> float:
    """How far a read may be from `target` and still be a candidate.

    One error on a short plate already makes it a different plate as often as
    not; on a full Indian plate of nine or ten characters two are still a lead.
    """
    return 2.0 if len(target) >= 6 else 1.0


def near(target: str, read: str) -> PlateMatch | None:
    """The match, when `read` is close enough to `target` to be a candidate."""
    if not read or read == target:
        return None
    if abs(len(read) - len(target)) > max_cost(target):
        return None
    match = compare(target, read)
    if match.cost <= max_cost(target) and match.count <= MAX_EDITS:
        return match
    return None


# ─────────────────────────────────────────────────────────────────────
# Candidate visits
# ─────────────────────────────────────────────────────────────────────
@dataclass(slots=True)
class Reason:
    factor: str
    detail: str
    tone: Tone

    def to_dict(self) -> dict[str, str]:
        return {"factor": self.factor, "detail": self.detail, "tone": self.tone}


@dataclass(slots=True)
class CandidateVisit:
    """Consecutive reads of one near plate at one camera: one candidate."""

    read_as: str
    match: PlateMatch
    camera_id: uuid.UUID
    camera_code: str
    camera_name: str
    city: str | None
    district: str | None
    #: None when the camera's position is unknown.
    lat: float | None
    lon: float | None
    town_level: bool
    heading_deg: float | None
    arrived_at: datetime
    departed_at: datetime
    best_confidence: float
    best_detection_id: uuid.UUID
    best_detection_ts: datetime
    crop_key: str | None
    member_ids: list[uuid.UUID] = field(default_factory=list)
    vehicle_types: Counter[str] = field(default_factory=Counter)
    #: Visits in the window carrying this exact reading.
    recurrence: int = 1
    fit: Fit = "unknown"
    fit_detail: str = ""
    strength: Strength = "possible"
    reasons: list[Reason] = field(default_factory=list)

    @property
    def placed(self) -> bool:
        return self.lat is not None and self.lon is not None

    @property
    def sightings(self) -> int:
        return len(self.member_ids)

    @property
    def vehicle_type(self) -> str | None:
        return self.vehicle_types.most_common(1)[0][0] if self.vehicle_types else None

    def sort_key(self) -> tuple[int, int, float, float, datetime]:
        return (
            _FIT_ORDER[self.fit],
            _STRENGTH_ORDER[self.strength],
            self.match.cost,
            -self.best_confidence,
            self.arrived_at,
        )

    def as_hop(self) -> Hop:
        """This visit as a candidate hop on a route. Placed visits only."""
        if self.lat is None or self.lon is None:
            raise ValueError("an unplaced candidate has no position to be a hop at")
        return Hop(
            camera_id=self.camera_id,
            camera_code=self.camera_code,
            camera_name=self.camera_name,
            city=self.city,
            district=self.district,
            lat=self.lat,
            lon=self.lon,
            arrived_at=self.arrived_at,
            departed_at=self.departed_at,
            sightings=self.sightings,
            best_confidence=self.best_confidence,
            best_detection_id=self.best_detection_id,
            candidate=True,
            read_as=self.read_as,
            candidate_note=self.match.describe(),
        )

    def as_sighting(self) -> Sighting:
        """This visit as an unplaced candidate sighting on a route."""
        return Sighting(
            detection_id=self.best_detection_id,
            ts=self.best_detection_ts,
            camera_id=self.camera_id,
            camera_code=self.camera_code,
            camera_name=self.camera_name,
            city=self.city,
            district=self.district,
            lat=self.lat if self.lat is not None else 0.0,
            lon=self.lon if self.lon is not None else 0.0,
            heading_deg=self.heading_deg,
            plate_confidence=self.best_confidence,
            read_as=self.read_as,
        )

    def to_dict(self) -> dict[str, Any]:
        return {
            "detection_id": str(self.best_detection_id),
            "detection_ts": self.best_detection_ts.isoformat(),
            # Every read in the visit, so a decision recorded against one of
            # them still finds the visit when a later read becomes its best.
            "detection_ids": [str(m) for m in self.member_ids[:50]],
            "read_as": self.read_as,
            "camera_id": str(self.camera_id),
            "camera_code": self.camera_code,
            "camera_name": self.camera_name,
            "city": self.city,
            "district": self.district,
            "placed": self.placed,
            "town_level": self.town_level,
            "lat": round(self.lat, 6) if self.lat is not None else None,
            "lon": round(self.lon, 6) if self.lon is not None else None,
            "arrived_at": self.arrived_at.isoformat(),
            "departed_at": self.departed_at.isoformat(),
            "sightings": self.sightings,
            "plate_confidence": round(self.best_confidence, 4),
            "vehicle_type": self.vehicle_type,
            "edits": [edit.to_dict() for edit in self.match.edits],
            "edit_count": self.match.count,
            "confusions": self.match.confusions,
            "distance": self.match.cost,
            "difference": self.match.describe(),
            "fit": {"status": self.fit, "detail": self.fit_detail},
            "strength": self.strength,
            "reasons": [reason.to_dict() for reason in self.reasons],
            "recurrence": self.recurrence,
            "crop_url": evidence.crop_url(self.crop_key),
        }


@dataclass(slots=True)
class CandidateReport:
    plate: str
    window_from: datetime
    window_to: datetime | None
    visits: list[CandidateVisit]
    target_vehicle_type: str | None
    confirmed_visits: int
    limit: int | None

    def to_dict(self) -> dict[str, Any]:
        shown = self.visits if self.limit is None else self.visits[: self.limit]
        return {
            "plate": self.plate,
            "window": {
                "from": self.window_from.isoformat(),
                "to": self.window_to.isoformat() if self.window_to else None,
            },
            "total": len(self.visits),
            "counts": {
                fit: sum(1 for visit in self.visits if visit.fit == fit) for fit in _FIT_ORDER
            },
            "candidates": [visit.to_dict() for visit in shown],
            "target_vehicle_type": self.target_vehicle_type,
            "confirmed_visits": self.confirmed_visits,
            "criteria": {
                "max_distance": max_cost(self.plate),
                "max_edits": MAX_EDITS,
                "confusion_cost": CONFUSION_COST,
                "confusions": ["/".join(group) for group in CONFUSION_GROUPS],
                "dwell_window_s": DWELL_WINDOW.total_seconds(),
                "max_plausible_kmph": correlator.MAX_PLAUSIBLE_KMPH,
            },
            "note": (
                "Reads of other plates that may be this vehicle misread. None of them is "
                "part of the route unless an analyst includes it, and an included one stays "
                "marked as a candidate wherever the route is shown."
            ),
        }


def _cluster(rows: Sequence[Any], matches: dict[str, PlateMatch]) -> list[CandidateVisit]:
    """Group one near plate's reads into visits, by the correlator's dwell rule."""
    by_plate: dict[str, list[Any]] = {}
    for row in rows:
        by_plate.setdefault(row.plate, []).append(row)

    visits: list[CandidateVisit] = []
    for plate, plate_rows in by_plate.items():
        current: CandidateVisit | None = None
        for row in sorted(plate_rows, key=lambda r: r.ts):
            confidence = float(row.confidence or 0.0)
            if (
                current is not None
                and current.camera_id == row.camera_id
                and row.ts - current.departed_at <= DWELL_WINDOW
            ):
                current.departed_at = row.ts
                current.member_ids.append(row.id)
                if row.vehicle_type:
                    current.vehicle_types[row.vehicle_type] += 1
                if confidence > current.best_confidence:
                    current.best_confidence = confidence
                    current.best_detection_id = row.id
                    current.best_detection_ts = row.ts
                    current.crop_key = row.crop_key
                continue
            tags = row.tags or ()
            placed = row.lat is not None and row.lon is not None and UNPLACED_TAG not in tags
            current = CandidateVisit(
                read_as=plate,
                match=matches[plate],
                camera_id=row.camera_id,
                camera_code=row.camera_code,
                camera_name=row.camera_name,
                city=row.city,
                district=row.district,
                lat=float(row.lat) if placed else None,
                lon=float(row.lon) if placed else None,
                town_level=TOWN_LEVEL_TAG in tags,
                heading_deg=row.heading_deg,
                arrived_at=row.ts,
                departed_at=row.ts,
                best_confidence=confidence,
                best_detection_id=row.id,
                best_detection_ts=row.ts,
                crop_key=row.crop_key,
                member_ids=[row.id],
                vehicle_types=Counter([row.vehicle_type] if row.vehicle_type else []),
            )
            visits.append(current)

    recurrence = Counter(visit.read_as for visit in visits)
    for visit in visits:
        visit.recurrence = recurrence[visit.read_as]
    return visits


def _bare(hop: Hop) -> Hop:
    """A copy of a confirmed hop with its leg cleared, to score a new leg on."""
    return dataclasses.replace(
        hop, flags=[], distance_m=None, elapsed_s=None, implied_kmph=None, bearing=None
    )


def _minutes(seconds: float) -> str:
    if seconds < 90:
        return f"{max(0, round(seconds))} s"
    minutes = round(seconds / 60)
    return f"{minutes} min" if minutes < 120 else f"{minutes // 60} h {minutes % 60:02d} min"


def _leg_words(leg: Hop, other: str, outbound: bool) -> str:
    """A leg between a confirmed visit and the candidate, in words."""
    direction = f"to {other}" if outbound else f"from {other}"
    if "revisit" in leg.flags:
        return f"at {other}'s camera again, {_minutes(leg.elapsed_s or 0)} apart"
    if "co_located" in leg.flags:
        return f"at the same spot as {other}"
    if "impossible_simultaneous" in leg.flags:
        return f"at {other} at the same moment, somewhere else — one vehicle cannot do this"
    km = (leg.distance_m or 0.0) / 1000.0
    text = f"≥ {km:.1f} km {direction} in {_minutes(leg.elapsed_s or 0)}"
    if leg.implied_kmph is not None:
        text += f" (≥ {leg.implied_kmph:,.0f} km/h)"
    if "implausible_speed" in leg.flags:
        text += " — faster than any vehicle"
    return text


def _assess_fit(
    visit: CandidateVisit,
    plate: str,
    confirmed: list[Hop],
    headings: dict[uuid.UUID, float | None],
    town_level: set[uuid.UUID],
) -> tuple[Fit, str]:
    """Whether a candidate fits the confirmed route, by the correlator's rules."""
    if not visit.placed:
        return "unknown", "camera position unknown, so it cannot be checked against the route"
    if not confirmed:
        return "unknown", (
            f"{plate} itself was not read at a camera with a known position in this window, "
            "so there is no route to check it against"
        )

    for hop in confirmed:
        if (
            hop.camera_id == visit.camera_id
            and visit.arrived_at <= hop.departed_at + DWELL_WINDOW
            and visit.departed_at >= hop.arrived_at - DWELL_WINDOW
        ):
            gap = max(
                0.0,
                (visit.arrived_at - hop.departed_at).total_seconds(),
                (hop.arrived_at - visit.departed_at).total_seconds(),
            )
            when = "while" if gap == 0 else f"{_minutes(gap)} from when"
            return "same_visit", (
                f"read at {visit.camera_code} {when} {plate} was read there — the same pass, "
                "read two ways, or the vehicle beside it"
            )

    before = [hop for hop in confirmed if hop.arrived_at <= visit.arrived_at]
    after = [hop for hop in confirmed if hop.arrived_at > visit.arrived_at]
    previous = _bare(before[-1]) if before else None
    following = _bare(after[0]) if after else None

    chain = [h for h in (previous, visit.as_hop(), following) if h is not None]
    correlator.score_legs(chain, headings)
    middle = chain[1] if previous is not None else chain[0]
    legs: list[tuple[Hop, str, bool]] = []
    if previous is not None:
        legs.append((middle, previous.camera_code, False))
    if following is not None:
        legs.append((following, following.camera_code, True))

    words = [_leg_words(leg, other, outbound) for leg, other, outbound in legs]
    approximate = visit.town_level or any(
        h.camera_id in town_level for h in (previous, following) if h is not None
    )
    note = " (a town-level camera position: the distance is approximate)" if approximate else ""
    if any(not leg.plausible for leg, _other, _out in legs):
        return "conflicts", "; ".join(words) + note
    return "fits", "reachable — " + "; ".join(words) + note


def _assess(
    visit: CandidateVisit,
    plate: str,
    confirmed: list[Hop],
    headings: dict[uuid.UUID, float | None],
    town_level: set[uuid.UUID],
    target_type: str | None,
) -> None:
    """Fill in the visit's fit, reasons and strength. Mutates it."""
    visit.fit, visit.fit_detail = _assess_fit(visit, plate, confirmed, headings, town_level)
    reasons = [
        Reason(
            "plate",
            visit.match.describe(),
            "for" if visit.match.only_confusions or visit.match.count == 1 else "neutral",
        ),
        Reason(
            "confidence",
            f"read with confidence {visit.best_confidence:.2f}"
            + (" — a weak read; check the crop" if visit.best_confidence < WEAK_READ else ""),
            "against" if visit.best_confidence < WEAK_READ else "neutral",
        ),
        Reason(
            "route",
            visit.fit_detail,
            "for"
            if visit.fit in ("same_visit", "fits")
            else "against"
            if visit.fit == "conflicts"
            else "neutral",
        ),
    ]
    mismatch = False
    if target_type and visit.vehicle_type:
        if visit.vehicle_type == target_type:
            reasons.append(
                Reason("vehicle", f"a {visit.vehicle_type}, like the confirmed reads", "for")
            )
        else:
            mismatch = True
            reasons.append(
                Reason(
                    "vehicle",
                    f"a {visit.vehicle_type}; the confirmed reads are a {target_type}",
                    "against",
                )
            )
    if visit.recurrence >= RECURRENCE_NOTE_AT:
        reasons.append(
            Reason(
                "recurrence",
                f"{visit.read_as} was read on {visit.recurrence} visits in this window — a "
                "reading that keeps recurring may be another vehicle's own plate",
                "against",
            )
        )
    visit.reasons = reasons

    if visit.fit == "conflicts" or mismatch:
        visit.strength = "weak"
    elif (visit.fit == "same_visit" and visit.match.count == 1) or (
        visit.fit in ("same_visit", "fits") and visit.match.only_confusions
    ):
        # One difference inside a confirmed pass, or only common misreadings
        # where the route says the vehicle could have been.
        visit.strength = "strong"
    elif visit.match.confusions == 0 and visit.match.count >= 2:
        visit.strength = "weak"
    else:
        visit.strength = "possible"


async def _target_vehicle_type(
    session: AsyncSession, plate: str, since: datetime, until: datetime | None
) -> str | None:
    query = (
        select(Detection.vehicle_type, func.count())
        .where(
            Detection.plate_normalised == plate,
            Detection.ts >= since,
            Detection.vehicle_type.isnot(None),
        )
        .group_by(Detection.vehicle_type)
        .order_by(func.count().desc())
        .limit(1)
    )
    if until is not None:
        query = query.where(Detection.ts <= until)
    row = (await session.execute(query)).first()
    return str(row[0]) if row else None


async def find_candidates(
    session: AsyncSession,
    plate: str,
    since: datetime,
    until: datetime | None,
    route: Route | None = None,
    limit: int | None = DEFAULT_LIMIT,
) -> CandidateReport:
    """Candidate sightings of `plate` in the window, assessed and ranked.

    `route` is the plate's confirmed route over the same window; it is built
    here when not given. Candidate hops already on it are ignored — a route
    is checked against what was confirmed, never against other candidates.
    """
    if route is None:
        route = await correlator.build_route(session, plate, since, until)
    confirmed = [hop for hop in route.hops if not hop.candidate]

    window = [Detection.ts >= since]
    if until is not None:
        window.append(Detection.ts <= until)

    lengths = (
        await session.execute(
            select(Detection.plate_normalised, func.count())
            .where(
                *window,
                Detection.plate_normalised.isnot(None),
                Detection.plate_normalised != "",
                Detection.plate_normalised != plate,
                func.length(Detection.plate_normalised).between(len(plate) - 2, len(plate) + 2),
            )
            .group_by(Detection.plate_normalised)
            .limit(MAX_DISTINCT_PLATES)
        )
    ).all()

    matches: dict[str, PlateMatch] = {}
    for read, _count in lengths:
        match = near(plate, read)
        if match is not None:
            matches[read] = match
    closest = sorted(matches, key=lambda read: (matches[read].cost, read))[:MAX_NEAR_PLATES]
    matches = {read: matches[read] for read in closest}

    visits: list[CandidateVisit] = []
    if matches:
        location = Camera.location.cast(Geometry)
        rows = (
            await session.execute(
                select(
                    Detection.id.label("id"),
                    Detection.ts.label("ts"),
                    Detection.plate_normalised.label("plate"),
                    Detection.plate_confidence.label("confidence"),
                    Detection.vehicle_type.label("vehicle_type"),
                    Detection.crop_key.label("crop_key"),
                    Camera.id.label("camera_id"),
                    Camera.camera_code.label("camera_code"),
                    Camera.name.label("camera_name"),
                    Camera.city.label("city"),
                    Camera.district.label("district"),
                    Camera.heading_deg.label("heading_deg"),
                    func.ST_Y(location).label("lat"),
                    func.ST_X(location).label("lon"),
                    Camera.tags.label("tags"),
                )
                .join(Camera, Camera.id == Detection.camera_id)
                .where(*window, Detection.plate_normalised.in_(list(matches)))
                .order_by(Detection.ts.desc())
                .limit(MAX_CANDIDATE_SIGHTINGS)
            )
        ).all()
        visits = _cluster(rows, matches)

    town_level: set[uuid.UUID] = set()
    camera_ids = {hop.camera_id for hop in confirmed}
    if camera_ids:
        town_level = set(
            (
                await session.execute(
                    select(Camera.id).where(
                        Camera.id.in_(camera_ids), Camera.tags.contains([TOWN_LEVEL_TAG])
                    )
                )
            )
            .scalars()
            .all()
        )
    headings = {visit.camera_id: visit.heading_deg for visit in visits}
    target_type = await _target_vehicle_type(session, plate, since, until) if visits else None
    for visit in visits:
        _assess(visit, plate, confirmed, headings, town_level, target_type)

    visits.sort(key=CandidateVisit.sort_key)
    return CandidateReport(
        plate=plate,
        window_from=since,
        window_to=until,
        visits=visits,
        target_vehicle_type=target_type,
        confirmed_visits=len(confirmed),
        limit=limit,
    )


async def route_with_candidates(
    session: AsyncSession,
    plate: str,
    since: datetime,
    until: datetime | None,
    include: Sequence[uuid.UUID] = (),
) -> Route:
    """The plate's route, with the candidate visits an analyst included.

    `include` names detections; a candidate visit is included when any of its
    reads is named. Names that match no candidate in the window are reported in
    `candidates_missing` rather than dropped without a word.
    """
    placed, unplaced = await correlator.all_sightings_for(session, plate, since, until)
    confirmed = correlator.assemble_route(plate, placed, unplaced, since, until)
    if not include:
        return confirmed

    report = await find_candidates(session, plate, since, until, route=confirmed, limit=None)
    wanted = {str(detection_id) for detection_id in include}
    chosen: list[CandidateVisit] = []
    found: set[str] = set()
    for visit in report.visits:
        named = wanted & {str(member) for member in visit.member_ids}
        if named:
            chosen.append(visit)
            found |= named

    route = correlator.assemble_route(
        plate,
        placed,
        unplaced,
        since,
        until,
        extra_hops=[visit.as_hop() for visit in chosen if visit.placed],
        extra_unplaced=[visit.as_sighting() for visit in chosen if not visit.placed],
        extra_headings={visit.camera_id: visit.heading_deg for visit in chosen},
    )
    route.candidates_missing = sorted(wanted - found)
    return route
