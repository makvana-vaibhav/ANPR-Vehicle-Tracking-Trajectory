"""Does one leg of a journey look normal, given what the fleet has already seen?

## What this is, and what it replaces

`correlator.score_legs` already flags six things — `revisit`, `co_located`,
`impossible_simultaneous`, `implausible_speed`, `unobserved_gap`,
`heading_conflict` — but every one of them is a **physics check** run on a
single leg in isolation: could a vehicle have covered this distance in this
time. None of them compares a journey to anything the fleet has actually
observed. `AlertType.ANOMALY` has had zero producers because there was
nothing here to produce one.

This module is the data-driven half: for each newly-observed leg of a
journey, has *any* vehicle made this exact camera-to-camera transition
before, and if so, does this one's timing look like the others'. Two
factors, learned from `vehicle_tracks` — the journey history `route_history`
already persists (P2) — plus the physics filter's own `implausible_speed`
flag promoted to a named factor when it is the newest leg, per
ROADMAP.md's P5 definition ("unexpected camera sequence, travel time vs
baseline, unusual speed, impossible hop").

## Language discipline (CLAUDE.md §1)

Call it a **trajectory anomaly**. Nothing here decides that a vehicle,
plate or driver is suspicious — a rare transition is a fact about the
*route*, not an accusation about who drove it. `Reason.detail` is written to
be read by an operator who will decide what it means; it never says
"suspect", "criminal" or "wanted".

## The same trap as analytics.py, for the same reason

`vehicle_tracks` holds one row per journey *advance*, not per journey. Every
query here starts from `DISTINCT ON (plate_normalised) ... ORDER BY
created_at DESC` for the identical reason `app/routers/analytics.py`
documents: without it, a plate re-persisted 200 times would look like 200
vehicles having made the same trip, and "this transition is rare" would be
false for exactly the transitions where it matters most.

## Why only the newest hops are scored

Re-scoring a whole route on every snapshot would raise the same finding
again each time a journey is re-persisted — one journey producing an alert
storm instead of one alert. `route_history.snapshot` already knows exactly
which hops are new since the last snapshot; this module scores only those.

## Recorded footage, and how a loop is recognised

A camera replaying a clip on a loop shows the same vehicles again every
loop: on CAM-DEMO-01 the same plate is read every 15 s, at multiples of the
clip's length. Scored as journeys, those reappearances raised 760 alerts in
one evening. The loop has to be recognised before anything is scored, and
only one signal does it reliably: the camera's `recorded-footage` tag.

The stream reader's discontinuity detector is *not* that signal, though it
looks like one. It fires when PTS jumps backwards, and ffmpeg's
`-stream_loop` keeps PTS rising across the loop point, so it never fires on
the demo clip at all. On the grid it fires mostly on ~1.2 s PTS jitter rather
than on loops (11 Oct: 1,453 of 1,486 events), and nothing it detects reaches
this side of the bus anyway.

So a recording's sightings are taken out of a journey before any leg is
scored, and out of the history legs are measured against. The journey that
remains is the one the live cameras saw, scored as usual. Skipping only the
legs that touch a recording — the first version of this — also lost the leg
*between* two live cameras whenever a replayed sighting of the same plate
fell between them: a real finding, hidden by an artefact.
"""

from __future__ import annotations

import uuid
from dataclasses import dataclass, replace
from datetime import UTC, datetime, timedelta

from sqlalchemy import select, text
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.logging import get_logger
from app.models.registry import Camera
from app.services.correlator import DWELL_WINDOW, Hop, Route, score_legs

# Re-exported: `route_history` calls `anomaly.recorded_cameras`. The test now
# lives in `recorded_footage` so traffic analytics applies exactly the same one.
from app.services.recorded_footage import RECORDED_TAG as RECORDED_TAG
from app.services.recorded_footage import recorded_cameras as recorded_cameras

log = get_logger("api.anomaly")

#: How far back a transition's frequency and typical duration are learned
#: from. Matches the demo's practical history depth; long enough that a
#: transition made once a week still counts as "seen", short enough that a
#: road that changed character six months ago is not still setting the norm.
BASELINE_LOOKBACK = timedelta(days=30)

#: A transition made by fewer distinct vehicles than this, in the lookback,
#: is rare. Three, not one or two: a single prior vehicle could itself have
#: been the anomaly, and two is not enough to call anything a pattern.
RARE_TRANSITION_SAMPLES = 3

#: "Rare" only means something once the fleet has routes to compare against.
#: Until this many distinct vehicles have journeys on file, every transition
#: is unseen by construction, and calling each one rare raised an alert for
#: almost every cross-camera link: the 2,000-alert flood on the SIH demo, and
#: the same again on a grid with one day of history. Below it the honest
#: answer is "not enough history", which raises nothing.
MIN_FLEET_HISTORY_PLATES = 30

#: Cameras tagged `RECORDED_TAG` (see `app.services.recorded_footage`) replay a
#: recording on a loop, so their sightings are not part of any journey this
#: module scores, nor of the history it scores against. See "Recorded footage"
#: above.

#: A transition needs at least this many prior *timed* samples before "how
#: long does this normally take" is a distribution rather than a guess.
#: Matches MIN_BASELINE_SAMPLES in analytics.py, deliberately — the same
#: honesty threshold applies to both.
MIN_DURATION_SAMPLES = 5

#: Current duration at or above this multiple of the historical median is
#: flagged as unusually slow; at or below its reciprocal, unusually fast.
DURATION_RATIO_HIGH = 2.0
DURATION_RATIO_LOW = 0.5


@dataclass(slots=True)
class Reason:
    """One factor behind a trajectory-anomaly alert."""

    factor: str
    detail: str

    def to_dict(self) -> dict[str, str]:
        return {"factor": self.factor, "detail": self.detail}


@dataclass(slots=True)
class TransitionBaseline:
    """What the fleet has observed for one camera-to-camera transition."""

    #: Distinct vehicles seen making this transition in the lookback —
    #: "how many times" would double-count a vehicle re-persisted mid-journey.
    plates: int
    #: Sorted elapsed-seconds of the *timed, plausible* legs behind it.
    durations: list[float]

    @property
    def median_seconds(self) -> float | None:
        if not self.durations:
            return None
        mid = len(self.durations) // 2
        if len(self.durations) % 2:
            return self.durations[mid]
        return (self.durations[mid - 1] + self.durations[mid]) / 2.0


# Same shape as `_LEGS_SQL` in app/routers/analytics.py, and the same reason:
# `lag()` over each journey's ordered hops supplies the *from* camera, which
# a hop only carries relative to the one before it.
_TRANSITION_SQL = """
WITH latest AS (
    SELECT DISTINCT ON (plate_normalised) plate_normalised, hops
    FROM vehicle_tracks
    WHERE created_at >= :since
    ORDER BY plate_normalised, created_at DESC
),
legs AS (
    SELECT
        l.plate_normalised,
        lag(e.h ->> 'camera_code') OVER (
            PARTITION BY l.plate_normalised ORDER BY e.ord
        ) AS from_camera,
        e.h ->> 'camera_code'            AS to_camera,
        (e.h ->> 'elapsed_s')::float     AS elapsed_s,
        (e.h ->> 'plausible')::bool      AS plausible
    FROM latest l,
         jsonb_array_elements(l.hops -> 'hops') WITH ORDINALITY AS e(h, ord)
)
SELECT from_camera, to_camera, plate_normalised, elapsed_s, plausible
FROM legs
WHERE from_camera IS NOT NULL
"""


@dataclass(slots=True)
class FleetHistory:
    """What every leg is measured against, learned from `vehicle_tracks`."""

    #: Every transition the fleet has made, plausibly, between live cameras.
    baselines: dict[tuple[str, str], TransitionBaseline]
    #: Distinct vehicles with at least one leg between live cameras on file.
    #: A journey made only of a recording's replays is not history: counted,
    #: the demo clip alone would make a day-old fleet look established.
    depth: int


async def _load_history(
    session: AsyncSession, since: datetime, recorded: frozenset[str] = frozenset()
) -> FleetHistory:
    """Every plate's latest snapshot, less any leg that touches a recording."""
    rows = (await session.execute(text(_TRANSITION_SQL), {"since": since})).all()

    plates: dict[tuple[str, str], set[str]] = {}
    durations: dict[tuple[str, str], list[float]] = {}
    vehicles: set[str] = set()
    for from_camera, to_camera, plate, elapsed_s, plausible in rows:
        if from_camera in recorded or to_camera in recorded:
            continue
        vehicles.add(plate)
        if not plausible:
            continue
        key = (from_camera, to_camera)
        plates.setdefault(key, set()).add(plate)
        if elapsed_s is not None:
            durations.setdefault(key, []).append(float(elapsed_s))

    return FleetHistory(
        baselines={
            key: TransitionBaseline(
                plates=len(plates[key]), durations=sorted(durations.get(key, []))
            )
            for key in plates
        },
        depth=len(vehicles),
    )


async def _without_recordings(
    session: AsyncSession, hops: list[Hop], first_new: int, recorded: frozenset[str]
) -> tuple[list[Hop], int]:
    """The journey as the live cameras saw it, with its legs measured afresh.

    Returns copies — the route itself is persisted as it was seen, replays
    included — and the index of the first copy that is new since the last
    snapshot. A recording's sighting can be all that split one visit to a
    live camera into two, so the visits it separated are joined again, the
    way `cluster_into_hops` would have joined them.
    """
    kept: list[Hop] = []
    first_kept_new: int | None = None
    for index, hop in enumerate(hops):
        if hop.camera_code in recorded:
            continue
        previous = kept[-1] if kept else None
        if (
            previous is not None
            and previous.camera_id == hop.camera_id
            and hop.arrived_at - previous.departed_at <= DWELL_WINDOW
        ):
            previous.departed_at = hop.departed_at
            previous.sightings += hop.sightings
            if hop.best_confidence > previous.best_confidence:
                previous.best_confidence = hop.best_confidence
                previous.best_detection_id = hop.best_detection_id
            continue
        if first_kept_new is None and index >= first_new:
            first_kept_new = len(kept)
        kept.append(
            replace(hop, distance_m=None, elapsed_s=None, implied_kmph=None, bearing=None, flags=[])
        )

    headings: dict[uuid.UUID, float | None] = {}
    if len(kept) > 1:
        rows = await session.execute(
            select(Camera.id, Camera.heading_deg).where(
                Camera.id.in_({hop.camera_id for hop in kept})
            )
        )
        headings = dict(rows.tuples().all())
    score_legs(kept, headings)
    return kept, len(kept) if first_kept_new is None else first_kept_new


def _score_leg(
    from_camera: str,
    to_camera: str,
    hop: Hop,
    baseline: TransitionBaseline | None,
    *,
    established: bool = True,
) -> list[Reason]:
    label = f"{from_camera} → {to_camera}"

    if not hop.plausible:
        # The physics filter already found this leg impossible — the strongest
        # signal this module has, promoted to a named factor rather than left
        # as a flag only the route view shows.
        return [
            Reason(
                "impossible_hop",
                f"{label}: this leg is not physically plausible "
                f"({', '.join(hop.flags)}) — a cloned plate looks exactly like this",
            )
        ]

    reasons: list[Reason] = []
    seen = baseline.plates if baseline else 0
    if established and seen < RARE_TRANSITION_SAMPLES:
        reasons.append(
            Reason(
                "rare_transition",
                f"{label} has been made by {seen} vehicle(s) in the last "
                f"{BASELINE_LOOKBACK.days} days — fewer than the "
                f"{RARE_TRANSITION_SAMPLES} needed to call it an established route",
            )
        )

    median = baseline.median_seconds if baseline else None
    if (
        baseline is not None
        and len(baseline.durations) >= MIN_DURATION_SAMPLES
        and median
        and hop.elapsed_s is not None
    ):
        ratio = hop.elapsed_s / median
        if ratio >= DURATION_RATIO_HIGH:
            reasons.append(
                Reason(
                    "slow_transition",
                    f"{label} took {hop.elapsed_s:.0f}s, {ratio:.1f}× the "
                    f"{median:.0f}s median over {len(baseline.durations)} prior journeys",
                )
            )
        elif ratio <= DURATION_RATIO_LOW:
            reasons.append(
                Reason(
                    "fast_transition",
                    f"{label} took {hop.elapsed_s:.0f}s, {ratio:.1f}× the "
                    f"{median:.0f}s median over {len(baseline.durations)} prior journeys",
                )
            )

    return reasons


async def evaluate_new_hops(
    session: AsyncSession,
    route: Route,
    new_hops: list[Hop],
    *,
    now: datetime | None = None,
    recorded: frozenset[str] = frozenset(),
) -> list[Reason]:
    """Score only the hops added since the journey's last snapshot.

    Must be called *before* the current advance is persisted — the baseline
    query has no way to exclude "this exact advance" from "history", so
    calling it after `persist_route` would let a journey's own newest leg
    inflate the sample count it is being measured against.

    `now` anchors the lookback window and defaults to the real clock;
    injectable so a test can score against a fixed historical baseline
    without racing whatever the live simulator is doing at the actual
    current time — the same reason `correlator.build_route` takes an
    explicit `since`/`until` rather than always meaning "now".

    `recorded` names the cameras replaying a recording (`recorded_cameras`).
    Their sightings are set aside first and the legs between the live
    cameras that remain are measured afresh — see "Recorded footage" above.
    """
    if not new_hops:
        return []

    hops = route.hops
    first_new = len(hops) - len(new_hops)
    if recorded and any(hop.camera_code in recorded for hop in hops):
        hops, first_new = await _without_recordings(session, hops, first_new, recorded)
    # The first hop in a route has no leg into it — nothing to score.
    first_new = max(first_new, 1)
    if first_new >= len(hops):
        return []

    since = (now or datetime.now(UTC)) - BASELINE_LOOKBACK
    history = await _load_history(session, since, recorded)
    established = history.depth >= MIN_FLEET_HISTORY_PLATES

    reasons: list[Reason] = []
    for index in range(first_new, len(hops)):
        previous_hop, hop = hops[index - 1], hops[index]
        baseline = history.baselines.get((previous_hop.camera_code, hop.camera_code))
        reasons.extend(
            _score_leg(
                previous_hop.camera_code,
                hop.camera_code,
                hop,
                baseline,
                established=established,
            )
        )

    if reasons:
        log.info(
            "anomaly.scored",
            plate=route.plate,
            factors=[r.factor for r in reasons],
        )
    return reasons
