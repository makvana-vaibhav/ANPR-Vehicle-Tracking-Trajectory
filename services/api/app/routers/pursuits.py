"""Pursuit: keep the cameras a vehicle can reach next under analysis.

The mechanics — ranking, pins, the grid's limits — are in
`app.services.pursuit`. This router is the operator's handle on them, and the
audit trail of who did what with it:

* `pursuit.start`, `pursuit.renew`, `pursuit.stop` — the person, explicitly;
* `pursuit.expire` — the system, when nobody renewed it (the keeper);
* `search.plate` (`pursuit.predict`, `pursuit.view`) — a prediction asked
  for, and the first time each person opens a pursuit's detail, since both
  name where a vehicle was seen.

Starting, renewing and stopping need `stream.view` as well as
`search.execute`: a pursuit opens cameras for analysis, which is what
watching one does, and a role that may not watch may not steer what the
workers watch either.
"""

from __future__ import annotations

from datetime import UTC, datetime
from typing import Annotated, Any

from fastapi import APIRouter, Depends, HTTPException, Query, Request, Response, status
from pydantic import BaseModel, Field

from app.api.deps import CurrentUser, CurrentUserDep, DbSession
from app.core.logging import get_logger
from app.core.rbac import Permission, require_permission
from app.middleware.audit import RECORDED_EXPLICITLY
from app.schemas.intelligence import normalise_plate
from app.services import audit, pursuit

router = APIRouter(prefix="/api/v1/pursuits", tags=["pursuit"])
log = get_logger("api.pursuits")

_STEER = require_permission(Permission.STREAM_VIEW, Permission.SEARCH_EXECUTE)


class PursuitStart(BaseModel):
    plate: str = Field(min_length=4, max_length=24)
    pins: int | None = Field(
        default=None,
        ge=1,
        le=10,
        description="Cameras to keep pinned; capped at the workers' focus capacity",
    )


def _plate(value: str) -> str:
    normalised = normalise_plate(value)
    if len(normalised) < 4:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="A plate needs at least four alphanumeric characters to search on.",
        )
    return normalised


async def _active() -> list[pursuit.PursuitState]:
    states = [await pursuit.load(plate) for plate in await pursuit.active_plates()]
    return [state for state in states if state is not None]


def _not_pursued(plate: str) -> HTTPException:
    return HTTPException(
        status_code=status.HTTP_404_NOT_FOUND, detail=f"{plate} is not being pursued."
    )


@router.get(
    "",
    dependencies=[Depends(require_permission(Permission.SEARCH_EXECUTE))],
    summary="Pursuits active now",
)
async def list_pursuits() -> dict[str, Any]:
    """What the top bar shows: plate, who started it, time left, pins. No
    sightings, so it is not a plate search."""
    now = datetime.now(UTC)
    states = await _active()
    return {
        "pursuits": [
            pursuit.summary(state, now)
            for state in sorted(states, key=lambda s: s.started_at)
            if state.expires_at > now
        ]
    }


@router.get(
    "/{plate}/prediction",
    dependencies=[Depends(require_permission(Permission.SEARCH_EXECUTE))],
    summary="The cameras a vehicle can reach next, without pinning any",
)
async def predict(
    plate: str,
    session: DbSession,
    user: CurrentUserDep,
    request: Request,
    pins: Annotated[int | None, Query(ge=1, le=10)] = None,
) -> dict[str, Any]:
    """Exactly what starting a pursuit would rank and pin, and nothing done.

    The panel shows this before an operator commits: the grid's watch time is
    spent only by a deliberate start.
    """
    normalised = _plate(plate)
    now = datetime.now(UTC)
    ctx = await pursuit.context(session, now)
    state = pursuit.new_state(
        normalised, user.username, str(user.id), pursuit.clamp_pins(pins), now
    )
    state.anchor = await pursuit.anchor_for(session, normalised, ctx.cameras, now)
    active = await _active()
    await pursuit.step(
        session,
        state,
        ctx,
        others_open=pursuit.others_open([*active, state], normalised, ctx.on_screen),
        dry_run=True,
    )
    await audit.record_plate_search(
        request=request,
        user=user,
        query=normalised,
        filters={"action": "pursuit.predict"},
        result_count=len(state.predictions),
    )
    body = pursuit.describe(state, now)
    body["status"] = "preview"
    body["would_pin"] = [
        p["camera_code"] for p in state.predictions if p["pin_state"] == "would_pin"
    ]
    return body


@router.post(
    "",
    status_code=status.HTTP_201_CREATED,
    summary="Pursue a plate: pin the cameras it can reach next",
)
async def start(
    body: PursuitStart,
    session: DbSession,
    user: Annotated[CurrentUser, Depends(_STEER)],
    request: Request,
    response: Response,
) -> dict[str, Any]:
    """Start a pursuit — or, if the plate is already pursued, renew it.

    The first ranking and pinning happen in this request, so the workers are
    told before the operator has looked away; the keeper takes over from the
    next tick.
    """
    normalised = _plate(body.plate)
    now = datetime.now(UTC)
    async with pursuit.lock(normalised):
        existing = await pursuit.load(normalised)
        if existing is not None and existing.expires_at > now:
            existing.expires_at = now + pursuit.DURATION
            existing.renewed_at = now
            existing.note(now, f"Renewed by {user.username}.")
            await pursuit.save(existing)
            await audit.record(
                action="pursuit.renew",
                user=user,
                request=request,
                resource_type="vehicle",
                resource_id=normalised,
                params={"plate": normalised, "joined": True},
            )
            setattr(request.state, RECORDED_EXPLICITLY, True)
            response.status_code = status.HTTP_200_OK
            return pursuit.describe(existing, now)

        ctx = await pursuit.context(session, now)
        state = pursuit.new_state(
            normalised, user.username, str(user.id), pursuit.clamp_pins(body.pins), now
        )
        state.anchor = await pursuit.anchor_for(session, normalised, ctx.cameras, now)
        state.note(
            now,
            f"Started by {user.username}, "
            + (
                f"from {state.anchor.camera_code}."
                if state.anchor
                else "with no sighting to predict from yet."
            ),
        )
        active = [s for s in await _active() if s.plate != normalised]
        await pursuit.step(
            session,
            state,
            ctx,
            others_open=pursuit.others_open([*active, state], normalised, ctx.on_screen),
        )
        await pursuit.save(state)
        await pursuit.save_hold(ctx.hold)
    await pursuit.heartbeat([state])

    await audit.record(
        action="pursuit.start",
        user=user,
        request=request,
        resource_type="vehicle",
        resource_id=normalised,
        params={
            "plate": normalised,
            "pins_wanted": state.pins_wanted,
            "from_camera": state.anchor.camera_code if state.anchor else None,
            "pinned": [pin.camera_code for pin in state.pins],
            "predicted": [p["camera_code"] for p in state.predictions[:5]],
            "grid_held": bool(state.grid.get("held")),
        },
    )
    setattr(request.state, RECORDED_EXPLICITLY, True)
    log.info(
        "pursuit.started",
        plate=normalised,
        by=user.username,
        pinned=[pin.camera_code for pin in state.pins],
    )
    return pursuit.describe(state, now)


@router.get(
    "/{plate}",
    summary="One pursuit: predictions, pins, live sightings",
)
async def detail(
    plate: str,
    user: Annotated[CurrentUser, Depends(require_permission(Permission.SEARCH_EXECUTE))],
    request: Request,
) -> dict[str, Any]:
    """The pursuit panel's state, polled every few seconds.

    Read from Redis alone. The first time each person opens it, it is audited
    as a plate search: the detail lists where the plate was seen.
    """
    normalised = _plate(plate)
    state = await pursuit.load(normalised)
    now = datetime.now(UTC)
    if state is None or state.expires_at <= now:
        raise _not_pursued(normalised)
    viewer = str(user.id)
    if viewer not in state.viewers:
        async with pursuit.lock(normalised):
            fresh = await pursuit.load(normalised)
            if fresh is not None and viewer not in fresh.viewers:
                fresh.viewers.append(viewer)
                await pursuit.save(fresh)
                state = fresh
        await audit.record_plate_search(
            request=request,
            user=user,
            query=normalised,
            filters={"action": "pursuit.view"},
            result_count=len(state.sightings),
        )
    return pursuit.describe(state, now)


@router.post(
    "/{plate}/renew",
    summary="Keep a pursuit going for another 15 minutes",
)
async def renew(
    plate: str,
    user: Annotated[CurrentUser, Depends(_STEER)],
    request: Request,
) -> dict[str, Any]:
    normalised = _plate(plate)
    now = datetime.now(UTC)
    async with pursuit.lock(normalised):
        state = await pursuit.load(normalised)
        if state is None or state.expires_at <= now:
            raise _not_pursued(normalised)
        state.expires_at = now + pursuit.DURATION
        state.renewed_at = now
        state.note(now, f"Renewed by {user.username}.")
        await pursuit.save(state)
    await audit.record(
        action="pursuit.renew",
        user=user,
        request=request,
        resource_type="vehicle",
        resource_id=normalised,
        params={"plate": normalised, "expires_at": state.expires_at.isoformat()},
    )
    setattr(request.state, RECORDED_EXPLICITLY, True)
    return pursuit.describe(state, now)


@router.delete(
    "/{plate}",
    summary="Stop a pursuit; its pins lapse within the focus TTL",
)
async def stop(
    plate: str,
    user: Annotated[CurrentUser, Depends(_STEER)],
    request: Request,
) -> dict[str, Any]:
    normalised = _plate(plate)
    now = datetime.now(UTC)
    async with pursuit.lock(normalised):
        state = await pursuit.load(normalised)
        if state is None:
            raise _not_pursued(normalised)
        await pursuit.end(state, now)
    await audit.record(
        action="pursuit.stop",
        user=user,
        request=request,
        resource_type="vehicle",
        resource_id=normalised,
        params={
            "plate": normalised,
            "started_by": state.started_by,
            "ran_s": round((now - state.started_at).total_seconds()),
            "released": [pin.camera_code for pin in state.pins],
            "sightings": len(state.sightings),
        },
    )
    setattr(request.state, RECORDED_EXPLICITLY, True)
    log.info("pursuit.stopped", plate=normalised, by=user.username)
    return {
        "plate": normalised,
        "status": "stopped",
        "released": [pin.camera_code for pin in state.pins],
        "note": (
            "Pins lapse within 45 s; the workers keep each released stream open, unanalysed, "
            f"for {pursuit.FOCUS_LINGER_S / 60:.0f} min before closing it."
        ),
    }
