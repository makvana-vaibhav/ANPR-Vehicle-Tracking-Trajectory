"""Vehicle intelligence: where a plate has been, and who it travelled with.

This is the endpoint behind the organisers' scored live test case (FAQ Q26–28):
a designated vehicle tracked across cameras with a complete timestamped route.

Every response here says what it does not know. A route carries its flagged
legs, its confidence, and an explicit note that distances are straight lines
between cameras rather than roads driven — because the difference decides
whether an implied speed can be used as evidence.
"""

from __future__ import annotations

import uuid
from datetime import UTC, datetime, timedelta
from typing import Annotated, Any, Literal

from fastapi import APIRouter, Depends, HTTPException, Query, Request, status
from pydantic import BaseModel, Field
from sqlalchemy import select, text

from app.api.deps import CurrentUserDep, DbSession
from app.core.logging import get_logger
from app.core.rbac import Permission, require_permission
from app.middleware.audit import RECORDED_EXPLICITLY
from app.models.intelligence import Detection, Watchlist
from app.models.registry import Camera
from app.schemas.intelligence import (
    PlateSearchResponse,
    PlateSearchResult,
    WatchlistHit,
    normalise_plate,
)
from app.services import audit, candidates, correlator

router = APIRouter(prefix="/api/v1/vehicles", tags=["vehicles"])
log = get_logger(__name__)

#: How far back a route looks when no window is given. A day covers the
#: question an operator usually has ("where has it been today?") without
#: scanning a hypertable that grows forever.
DEFAULT_WINDOW = timedelta(days=1)

#: Candidate sightings one route may include. An analyst weighing more than
#: this is no longer adding misreads to a journey but building a different one.
MAX_INCLUDED = 20


def _window(since: datetime | None, until: datetime | None) -> tuple[datetime, datetime | None]:
    return since or (datetime.now(UTC) - DEFAULT_WINDOW), until


@router.get(
    "/{plate}/route",
    dependencies=[Depends(require_permission(Permission.SEARCH_EXECUTE))],
    summary="Reconstruct a vehicle's route across cameras",
)
async def vehicle_route(
    plate: str,
    session: DbSession,
    user: CurrentUserDep,
    request: Request,
    since: Annotated[datetime | None, Query(description="UTC lower bound")] = None,
    until: Annotated[datetime | None, Query(description="UTC upper bound")] = None,
    fmt: Annotated[
        str, Query(alias="format", pattern="^(json|geojson)$", description="json | geojson")
    ] = "json",
    include: Annotated[
        list[uuid.UUID] | None,
        Query(
            max_length=MAX_INCLUDED,
            description=(
                "Candidate sightings an analyst included (detection ids). Each joins the "
                "route as a separate visit marked `candidate`, never as a confirmed read."
            ),
        ),
    ] = None,
) -> dict[str, Any]:
    normalised = normalise_plate(plate)
    if len(normalised) < 4:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="A plate needs at least four alphanumeric characters to search on.",
        )

    window_from, window_to = _window(since, until)
    route = await candidates.route_with_candidates(
        session, normalised, window_from, window_to, include or ()
    )

    # Reconstructing a vehicle's movements is the most privacy-sensitive read
    # this system offers, so it is audited explicitly rather than left to the
    # middleware — CLAUDE.md §5.
    await audit.record_plate_search(
        request=request,
        user=user,
        query=normalised,
        filters={
            "action": "route",
            "from": window_from.isoformat(),
            "to": window_to.isoformat() if window_to else None,
            **({"include": [str(i) for i in include]} if include else {}),
        },
        result_count=len(route.hops),
    )

    if fmt == "geojson":
        return route.to_geojson()
    return route.to_dict()


@router.get(
    "/{plate}/candidates",
    dependencies=[Depends(require_permission(Permission.SEARCH_EXECUTE))],
    summary="Sightings that may be this vehicle, read as a slightly different plate",
)
async def vehicle_candidates(
    plate: str,
    session: DbSession,
    user: CurrentUserDep,
    request: Request,
    since: Annotated[datetime | None, Query(description="UTC lower bound")] = None,
    until: Annotated[datetime | None, Query(description="UTC upper bound")] = None,
    limit: Annotated[int, Query(ge=1, le=100)] = candidates.DEFAULT_LIMIT,
) -> dict[str, Any]:
    """Reads one or two characters away from the plate — or a few common
    misreadings away — each with plain reasons: which characters differ, how
    confidently it was read, whether it fits the confirmed route in time and
    space by the correlator's own rules, and what kind of vehicle it was.

    Nothing here changes the route. An analyst includes or dismisses each
    candidate (`POST …/candidates/decisions`), and the route takes the
    included ones as `include` — always marked as candidates.
    """
    normalised = normalise_plate(plate)
    if len(normalised) < 4:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="A plate needs at least four alphanumeric characters to search on.",
        )
    window_from, window_to = _window(since, until)
    report = await candidates.find_candidates(
        session, normalised, window_from, window_to, limit=limit
    )

    # One row for this request, naming what was asked: a search for reads
    # *near* a plate is still a search for that vehicle.
    await audit.record_plate_search(
        request=request,
        user=user,
        query=normalised,
        filters={
            "action": "candidates",
            "from": window_from.isoformat(),
            "to": window_to.isoformat() if window_to else None,
        },
        result_count=len(report.visits),
    )
    setattr(request.state, RECORDED_EXPLICITLY, True)
    return report.to_dict()


class CandidateDecision(BaseModel):
    """An analyst's call on one candidate sighting."""

    detection_id: uuid.UUID
    detection_ts: datetime = Field(description="The sighting's ts: detections are keyed by both")
    decision: Literal["include", "dismiss", "undo"]
    note: str | None = Field(default=None, max_length=500)


@router.post(
    "/{plate}/candidates/decisions",
    status_code=status.HTTP_201_CREATED,
    dependencies=[Depends(require_permission(Permission.SEARCH_EXECUTE))],
    summary="Include a candidate sighting in a journey, dismiss it, or undo either",
)
async def decide_candidate(
    plate: str,
    body: CandidateDecision,
    session: DbSession,
    user: CurrentUserDep,
    request: Request,
) -> dict[str, Any]:
    """Record a deliberate decision about a candidate, in the audit trail.

    The decision itself travels with the investigation — in the screen's
    address, so a link carries it — and this row is the record of who made
    it, when, and on what: the plate asked about, the plate actually read,
    and how they differ. Refused for a read that is not a candidate for this
    plate, so the trail never records a decision about something else.
    """
    normalised = normalise_plate(plate)
    if len(normalised) < 4:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="A plate needs at least four alphanumeric characters to search on.",
        )
    row = (
        await session.execute(
            select(Detection.plate_normalised, Detection.plate_confidence, Camera.camera_code)
            .join(Camera, Camera.id == Detection.camera_id, isouter=True)
            .where(Detection.id == body.detection_id, Detection.ts == body.detection_ts)
        )
    ).first()
    if row is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="No such sighting")
    read_as = row[0] or ""
    if read_as == normalised:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=f"That sighting is a read of {normalised} itself, not a candidate.",
        )
    match = candidates.near(normalised, read_as)
    if match is None:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=f"{read_as or 'An unread plate'} is not close enough to {normalised} "
            "to be a candidate for it.",
        )

    decided_at = datetime.now(UTC)
    await audit.record(
        action=f"candidate.{body.decision}",
        user=user,
        request=request,
        resource_type="detection",
        resource_id=body.detection_id,
        params={
            "plate": normalised,
            "read_as": read_as,
            "difference": match.describe(),
            "camera_code": row[2],
            "seen_at": body.detection_ts.isoformat(),
            "read_confidence": round(float(row[1] or 0.0), 4),
            "note": body.note,
        },
    )
    setattr(request.state, RECORDED_EXPLICITLY, True)
    log.info(
        "vehicles.candidate_decision",
        plate=normalised,
        read_as=read_as,
        decision=body.decision,
        detection_id=str(body.detection_id),
        by=user.username,
    )
    return {
        "plate": normalised,
        "detection_id": str(body.detection_id),
        "detection_ts": body.detection_ts.isoformat(),
        "decision": body.decision,
        "read_as": read_as,
        "camera_code": row[2],
        "difference": match.describe(),
        "decided_by": user.username,
        "decided_at": decided_at.isoformat(),
    }


@router.get(
    "/{plate}/convoy",
    dependencies=[Depends(require_permission(Permission.SEARCH_EXECUTE))],
    summary="Vehicles seen travelling with this one",
)
async def vehicle_convoy(
    plate: str,
    session: DbSession,
    user: CurrentUserDep,
    request: Request,
    since: Annotated[datetime | None, Query()] = None,
    until: Annotated[datetime | None, Query()] = None,
    window_s: Annotated[
        float, Query(ge=5.0, le=900.0, description="Seconds apart still counted as together")
    ] = 120.0,
    min_shared_cameras: Annotated[int, Query(ge=2, le=20)] = 3,
) -> dict[str, Any]:
    normalised = normalise_plate(plate)
    if len(normalised) < 4:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="A plate needs at least four alphanumeric characters to search on.",
        )

    window_from, window_to = _window(since, until)
    convoys = await correlator.find_convoys(
        session,
        normalised,
        window_from,
        window_to,
        window_s=window_s,
        min_shared_cameras=min_shared_cameras,
    )

    await audit.record_plate_search(
        request=request,
        user=user,
        query=normalised,
        filters={"action": "convoy", "window_s": window_s},
        result_count=len(convoys),
    )

    return {
        "plate": normalised,
        "window": {
            "from": window_from.isoformat(),
            "to": window_to.isoformat() if window_to else None,
        },
        "criteria": {
            "seconds_apart": window_s,
            "min_shared_cameras": min_shared_cameras,
        },
        "convoys": [convoy.to_dict() for convoy in convoys],
        "note": (
            "Co-occurrence is evidence of association, not proof of it. Two vehicles "
            "on the same road at the same time will co-occur without being related."
        ),
    }


@router.get(
    "/routable",
    dependencies=[Depends(require_permission(Permission.SEARCH_EXECUTE))],
    summary="Plates seen on enough cameras to have a route",
)
async def routable_plates(
    session: DbSession,
    since: Annotated[datetime | None, Query()] = None,
    min_cameras: Annotated[int, Query(ge=2, le=50)] = 2,
    limit: Annotated[int, Query(ge=1, le=200)] = 50,
) -> dict[str, Any]:
    """What the operator can usefully ask for a route on.

    Offering a route search with no way to discover which plates have one leads
    an operator to conclude the feature is broken when the real answer is that
    the vehicle was only ever seen once.
    """
    window = since or (datetime.now(UTC) - DEFAULT_WINDOW)
    plates = await correlator.recent_plates(session, window, min_cameras, limit)
    return {
        "since": window.isoformat(),
        "min_cameras": min_cameras,
        "plates": [{"plate": plate, "cameras": cameras} for plate, cameras in plates],
    }


#: pg_trgm's own documented default similarity threshold. Kept as the floor
#: for the `threshold` query param rather than letting a caller ask for
#: something looser: the `%` operator below already excludes anything under
#: 0.3 via the GIN index (`pg_trgm.similarity_threshold`, session-default
#: 0.3), so a caller-supplied floor under that would filter nothing the
#: index scan had not already dropped — a parameter that looks tunable but
#: is not.
DEFAULT_SIMILARITY_THRESHOLD = 0.3

#: `%` is what makes Postgres use `ix_detections_plate_trgm` (a GIN index on
#: `gin_trgm_ops`) instead of a sequential scan — `similarity() >= threshold`
#: alone is not index-aware. The explicit `similarity() >= :threshold` clause
#: alongside it is not redundant: `%` uses the *session's* GUC default (0.3)
#: to decide what the index scan returns, and re-checking with a bind
#: parameter is what lets a caller ask for a stricter match than 0.3 without
#: touching session state that would outlive this request.
#:
#: `:camera_id` and `:vehicle_type` use `CAST(:x AS type)` rather than
#: `:x::type` for the reason `analytics.py` documents at length: SQLAlchemy's
#: `text()` scans the string for `:word` parameters itself, and a `::cast`
#: immediately after one is misread as the start of another.
_FUZZY_SEARCH_SQL = """
    SELECT
        d.plate_normalised,
        similarity(d.plate_normalised, :query) AS score,
        count(*)                               AS sightings,
        count(DISTINCT d.camera_id)            AS cameras,
        min(d.ts)                              AS first_seen,
        max(d.ts)                              AS last_seen
    FROM detections d
    WHERE d.plate_normalised % :query
      AND similarity(d.plate_normalised, :query) >= :threshold
      AND (CAST(:since AS timestamptz) IS NULL OR d.ts >= :since)
      AND (CAST(:until AS timestamptz) IS NULL OR d.ts <= :until)
      AND (CAST(:camera_id AS uuid) IS NULL OR d.camera_id = :camera_id)
      AND (CAST(:vehicle_type AS text) IS NULL OR d.vehicle_type = :vehicle_type)
    GROUP BY d.plate_normalised
    ORDER BY score DESC, sightings DESC
    LIMIT :limit
"""


@router.get(
    "/search",
    response_model=PlateSearchResponse,
    dependencies=[Depends(require_permission(Permission.SEARCH_EXECUTE))],
    summary="Fuzzy and partial plate search",
)
async def search_plates(
    session: DbSession,
    user: CurrentUserDep,
    request: Request,
    q: Annotated[str, Query(min_length=3, max_length=24, description="A plate, or a guess at one")],
    since: Annotated[datetime | None, Query(description="UTC lower bound")] = None,
    until: Annotated[datetime | None, Query(description="UTC upper bound")] = None,
    camera_id: Annotated[uuid.UUID | None, Query()] = None,
    vehicle_type: Annotated[str | None, Query()] = None,
    threshold: Annotated[
        float,
        Query(
            ge=DEFAULT_SIMILARITY_THRESHOLD,
            le=1.0,
            description="Minimum trigram similarity, 0.3-1.0",
        ),
    ] = DEFAULT_SIMILARITY_THRESHOLD,
    limit: Annotated[int, Query(ge=1, le=50)] = 10,
) -> PlateSearchResponse:
    """Trigram-similarity search over every plate ever read.

    For the case an exact search returns nothing: a misread character
    (`GJ03A81234` for `GJ03AB1234`), a partial plate off a blurred crop, a
    plate typed from memory. Queries the GIN trigram index directly rather
    than through the ORM, for the same reason `analytics.py` does — the
    result is a per-plate aggregate over however many detections that plate
    has, which the ORM has no concise way to express.

    Each result carries a faceted summary (sightings, distinct cameras, first
    and last seen) and whether the plate is on an active watchlist entry —
    an operator triaging a misread plate needs to see it is a blacklist match
    without opening the full route first.
    """
    normalised = normalise_plate(q)
    if len(normalised) < 3:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="A search needs at least three alphanumeric characters.",
        )

    rows = (
        (
            await session.execute(
                text(_FUZZY_SEARCH_SQL),
                {
                    "query": normalised,
                    "threshold": threshold,
                    "since": since,
                    "until": until,
                    "camera_id": camera_id,
                    "vehicle_type": vehicle_type,
                    "limit": limit,
                },
            )
        )
        .mappings()
        .all()
    )

    plates = [row["plate_normalised"] for row in rows]
    watchlist_hits: dict[str, WatchlistHit] = {}
    if plates:
        entries = (
            (
                await session.execute(
                    select(Watchlist).where(
                        Watchlist.active.is_(True), Watchlist.plate_normalised.in_(plates)
                    )
                )
            )
            .scalars()
            .all()
        )
        for entry in entries:
            # A plate can legitimately carry more than one active entry
            # (several open cases); the first one found is shown rather than
            # inventing a ranking between cases here.
            watchlist_hits.setdefault(
                entry.plate_normalised,
                WatchlistHit(
                    category=entry.category, priority=entry.priority, case_ref=entry.case_ref
                ),
            )

    results = [
        PlateSearchResult(
            plate_normalised=row["plate_normalised"],
            similarity=round(float(row["score"]), 3),
            sightings=row["sightings"],
            cameras=row["cameras"],
            first_seen=row["first_seen"],
            last_seen=row["last_seen"],
            watchlist=watchlist_hits.get(row["plate_normalised"]),
        )
        for row in rows
    ]

    # A fuzzy search is still a plate search — CLAUDE.md's audit rule does
    # not carve out an exception for "the query might not have matched".
    await audit.record_plate_search(
        request=request,
        user=user,
        query=normalised,
        filters={
            "action": "search",
            "threshold": threshold,
            "camera_id": str(camera_id) if camera_id else None,
            "vehicle_type": vehicle_type,
        },
        result_count=len(results),
    )

    return PlateSearchResponse(
        query=normalised,
        threshold=threshold,
        exact_match=any(r.plate_normalised == normalised for r in results),
        results=results,
    )
