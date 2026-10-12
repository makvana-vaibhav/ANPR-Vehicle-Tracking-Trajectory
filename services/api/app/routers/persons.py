"""The persons watchlist: enrol, approve, reject, retire, read.

Every endpoint here writes an explicit audit row, reads included — and every
signed photo URL an endpoint hands out is named in its row. A reference photo
or a captured face is the most sensitive thing this platform can show, so "who
looked at whose face, when" must be answerable from `audit_log` alone.

The controls, endpoint by endpoint:

* **Enrol** (`person.enrol`) checks the photo holds exactly one face big enough
  to be a reference, embeds it with the cameras' own models, stores a
  re-encoded copy in the private bucket, and creates the entry
  `pending_approval`. Nothing is matched yet.
* **Approve / reject** (`person.approve`) is four-eyes: refused, and audited as
  denied, for the account that enrolled the entry. The database refuses it
  again (migration 0009). Approving publishes the gallery to the cameras.
* **Retire** (`person.retire`) stops matching at once — the gallery is
  republished in the same request — and destroys the embedding. A reason is
  required. There is no "reinstate": a retired entry is re-enrolled and
  re-approved, so it gets a second pair of eyes again.
* **Read** (`person.read`) returns two-minute signed URLs, never image bytes
  and never embeddings.
"""

from __future__ import annotations

import asyncio
import hashlib
import uuid
from datetime import UTC, datetime, timedelta
from typing import Annotated, Any

from fastapi import (
    APIRouter,
    Depends,
    File,
    Form,
    HTTPException,
    Query,
    Request,
    UploadFile,
    status,
)
from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError

from app.api.deps import CurrentUser, CurrentUserDep, DbSession
from app.core.config import settings
from app.core.logging import get_logger
from app.core.rbac import Permission, permissions_for, require_permission
from app.middleware.audit import RECORDED_EXPLICITLY
from app.models.enums import AlertType, AuditResult, PersonCategory, PersonStatus
from app.models.intelligence import Alert
from app.models.persons import PersonEntry
from app.models.registry import Camera
from app.schemas.persons import (
    GalleryStatus,
    PersonDecision,
    PersonMatchEvidence,
    PersonOut,
    PersonPage,
)
from app.services import audit, face_enrol, person_media, persons

router = APIRouter(prefix="/api/v1/persons", tags=["persons"])
log = get_logger(__name__)

#: One page. Small on purpose: each row issues a signed photo URL, and every
#: one of those is named in the audit row for the request.
MAX_PAGE = 50

FACES_TAG = "analytics:faces"


# ── shaping ────────────────────────────────────────────────────────────
def _out(entry: PersonEntry, user: CurrentUser, *, with_photo: bool = True) -> PersonOut:
    item = PersonOut.model_validate(entry)
    item.matchable = persons.is_matchable(entry)
    item.photo_url = person_media.signed_url(entry.photo_key) if with_photo else None
    item.photo_purged = entry.photo_key is None
    item.can_review = (
        Permission.PERSON_APPROVE in permissions_for(user.role)
        and entry.status == PersonStatus.PENDING_APPROVAL.value
        and entry.enrolled_by != user.id
    )
    return item


async def _entry_or_404(session: DbSession, entry_id: uuid.UUID) -> PersonEntry:
    entry = await session.get(PersonEntry, entry_id)
    if entry is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="No such entry")
    return entry


async def _record(
    request: Request,
    user: CurrentUser,
    action: str,
    entry_id: uuid.UUID | str | None,
    params: dict[str, Any],
    result: AuditResult = AuditResult.SUCCESS,
) -> None:
    await audit.record(
        request=request,
        user=user,
        action=f"person.{action}",
        resource_type="person",
        resource_id=entry_id,
        params=params,
        result=result,
    )
    # This row replaces the middleware's generic one for the request: two rows
    # for one enrolment would make "how many faces did this account enrol"
    # wrong by a factor of two. A request that fails before reaching here
    # keeps the middleware's row, with its error result.
    setattr(request.state, RECORDED_EXPLICITLY, True)


# ── reads ──────────────────────────────────────────────────────────────
@router.get(
    "",
    response_model=PersonPage,
    dependencies=[Depends(require_permission(Permission.PERSON_READ))],
    summary="List persons-watchlist entries",
)
async def list_entries(
    session: DbSession,
    user: CurrentUserDep,
    request: Request,
    entry_status: Annotated[PersonStatus | None, Query(alias="status")] = None,
    category: Annotated[PersonCategory | None, Query()] = None,
    limit: Annotated[int, Query(ge=1, le=MAX_PAGE)] = MAX_PAGE,
    offset: Annotated[int, Query(ge=0)] = 0,
) -> PersonPage:
    query = select(PersonEntry)
    count = select(func.count()).select_from(PersonEntry)
    if entry_status is not None:
        query = query.where(PersonEntry.status == entry_status.value)
        count = count.where(PersonEntry.status == entry_status.value)
    if category is not None:
        query = query.where(PersonEntry.category == category.value)
        count = count.where(PersonEntry.category == category.value)

    total = (await session.execute(count)).scalar_one()
    pending = (
        await session.execute(
            select(func.count())
            .select_from(PersonEntry)
            .where(PersonEntry.status == PersonStatus.PENDING_APPROVAL.value)
        )
    ).scalar_one()
    rows = (
        (
            await session.execute(
                query.order_by(PersonEntry.created_at.desc()).limit(limit).offset(offset)
            )
        )
        .scalars()
        .all()
    )
    items = [_out(row, user) for row in rows]
    await _record(
        request,
        user,
        "list",
        None,
        {
            "status": entry_status.value if entry_status else None,
            "category": category.value if category else None,
            "results": len(items),
            # Every photo this response made viewable, by entry.
            "photos_issued": [str(i.id) for i in items if i.photo_url],
        },
    )
    return PersonPage(items=items, total=total, limit=limit, offset=offset, pending=pending)


@router.get(
    "/gallery/status",
    response_model=GalleryStatus,
    dependencies=[Depends(require_permission(Permission.PERSON_READ))],
    summary="What the cameras are matching against right now",
)
async def gallery_status(
    session: DbSession, user: CurrentUserDep, request: Request
) -> GalleryStatus:
    payload = await persons.build_gallery(session)
    pending = (
        await session.execute(
            select(func.count())
            .select_from(PersonEntry)
            .where(PersonEntry.status == PersonStatus.PENDING_APPROVAL.value)
        )
    ).scalar_one()
    cameras = (
        (
            await session.execute(
                select(Camera.camera_code)
                .where(Camera.tags.contains([FACES_TAG]))
                .order_by(Camera.camera_code)
                .limit(200)
            )
        )
        .scalars()
        .all()
    )
    await _record(request, user, "gallery_status", None, {"active": len(payload["entries"])})
    state = persons.gallery_state
    return GalleryStatus(
        active_entries=len(payload["entries"]),
        pending_entries=pending,
        version=state.version or payload["version"],
        published_at=state.published_at,
        publish_error=state.error,
        threshold=settings.person_match_threshold,
        min_frames=settings.person_match_min_frames,
        min_margin=settings.person_match_min_margin,
        model=persons.SFACE_MODEL_ID,
        model_threshold=persons.SFACE_PUBLISHED_COSINE_THRESHOLD,
        cameras=list(cameras),
        default_valid_days=settings.person_default_valid_days,
        max_valid_days=settings.person_max_valid_days,
        min_face_px=settings.person_min_face_px,
    )


@router.get(
    "/matches/{alert_id}",
    response_model=PersonMatchEvidence,
    dependencies=[Depends(require_permission(Permission.PERSON_READ, Permission.ALERT_READ))],
    summary="The two faces behind a person-match alarm, side by side",
)
async def match_evidence(
    alert_id: uuid.UUID,
    session: DbSession,
    user: CurrentUserDep,
    request: Request,
) -> PersonMatchEvidence:
    alert = await session.get(Alert, alert_id)
    if alert is None or alert.alert_type != AlertType.PERSON_MATCH.value:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="No such person-match alarm"
        )
    entry = await session.get(PersonEntry, alert.person_id) if alert.person_id else None

    person = _out(entry, user) if entry is not None else None
    face_url = person_media.signed_url(alert.face_crop_key)
    # The reasons carry their numbers beside the sentence an operator reads
    # (see persons.build_reasons); the screen wants them as numbers.
    frames = next((r for r in alert.reasons or [] if r.get("factor") == "frames_agreed"), {})
    agreed = frames.get("agreed")
    required = frames.get("required")
    await _record(
        request,
        user,
        "match_view",
        entry.id if entry else None,
        {
            "alert_id": str(alert.id),
            "photos_issued": [
                name
                for name, url in (
                    ("reference", person.photo_url if person else None),
                    ("captured", face_url),
                )
                if url
            ],
        },
    )
    return PersonMatchEvidence(
        alert_id=alert.id,
        person=person,
        face_url=face_url,
        face_purged=alert.face_crop_key is None,
        similarity=alert.similarity,
        threshold=settings.person_match_threshold,
        model_threshold=persons.SFACE_PUBLISHED_COSINE_THRESHOLD,
        frames_agreed=agreed if isinstance(agreed, int) else None,
        frames_required=required if isinstance(required, int) else None,
        captured_at=alert.detection_ts,
        camera_id=alert.camera_id,
    )


@router.get(
    "/{entry_id}",
    response_model=PersonOut,
    dependencies=[Depends(require_permission(Permission.PERSON_READ))],
    summary="One entry, with a two-minute link to its photo",
)
async def get_entry(
    entry_id: uuid.UUID,
    session: DbSession,
    user: CurrentUserDep,
    request: Request,
) -> PersonOut:
    entry = await _entry_or_404(session, entry_id)
    item = _out(entry, user)
    await _record(request, user, "view", entry.id, {"photo_issued": bool(item.photo_url)})
    return item


# ── enrol ──────────────────────────────────────────────────────────────
def _clean(value: str | None, field: str, *, minimum: int = 1, maximum: int) -> str:
    cleaned = " ".join((value or "").split())
    if len(cleaned) < minimum:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=f"{field} is required"
            + (f" — at least {minimum} characters" if minimum > 1 else ""),
        )
    if len(cleaned) > maximum:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=f"{field} is longer than {maximum} characters",
        )
    return cleaned


@router.post(
    "",
    response_model=PersonOut,
    status_code=status.HTTP_201_CREATED,
    dependencies=[Depends(require_permission(Permission.PERSON_ENROL))],
    summary="Enrol a person from one reference photo (pending a second approver)",
)
async def enrol(
    session: DbSession,
    user: CurrentUserDep,
    request: Request,
    photo: Annotated[UploadFile, File(description="JPEG or PNG showing exactly one face")],
    display_name: Annotated[str, Form(max_length=120)],
    category: Annotated[PersonCategory, Form()],
    case_ref: Annotated[str, Form(max_length=64)],
    purpose: Annotated[str, Form(max_length=2000)],
    notes: Annotated[str | None, Form(max_length=2000)] = None,
    valid_days: Annotated[int | None, Form(ge=1)] = None,
) -> PersonOut:
    name = _clean(display_name, "A display name", maximum=120)
    case = _clean(case_ref, "A case reference", maximum=64)
    reason = _clean(purpose, "The purpose and legal basis", minimum=10, maximum=2000)
    remark = " ".join((notes or "").split()) or None
    days = valid_days or settings.person_default_valid_days
    if days > settings.person_max_valid_days:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=f"An entry can be valid for at most {settings.person_max_valid_days} days; "
            "renewing it is a new enrolment with a new approval.",
        )

    data = await photo.read(settings.person_photo_max_bytes + 1)
    await photo.close()
    base = {"category": category.value, "case_ref": case, "valid_days": days}

    try:
        reference = await asyncio.to_thread(face_enrol.enrol, data)
    except face_enrol.PhotoRefused as refused:
        await _record(
            request, user, "enrol", None, {**base, "refused": refused.code}, AuditResult.DENIED
        )
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail=refused.message
        ) from refused
    except face_enrol.FaceEngineUnavailable as exc:
        await _record(request, user, "enrol", None, {**base, "error": "engine"}, AuditResult.ERROR)
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail=str(exc)
        ) from exc

    entry_id = uuid.uuid4()
    try:
        photo_key = await person_media.put_reference_photo(entry_id, reference.photo_jpeg)
    except person_media.PersonMediaError as exc:
        await _record(request, user, "enrol", None, {**base, "error": "storage"}, AuditResult.ERROR)
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail=str(exc)
        ) from exc

    entry = PersonEntry(
        id=entry_id,
        display_name=name,
        category=category.value,
        case_ref=case,
        purpose=reason,
        notes=remark,
        photo_key=photo_key,
        photo_sha256=hashlib.sha256(reference.photo_jpeg).hexdigest(),
        embeddings=[reference.embedding_b64],
        embedding_model=persons.SFACE_MODEL_ID,
        enrol_quality=reference.quality,
        status=PersonStatus.PENDING_APPROVAL.value,
        valid_until=datetime.now(UTC) + timedelta(days=days),
        enrolled_by=user.id,
        enrolled_by_username=user.username,
    )
    session.add(entry)
    try:
        await session.commit()
    except IntegrityError as exc:
        await session.rollback()
        # Nothing references the photo now; do not leave a face behind.
        await person_media.delete_object(photo_key)
        await _record(
            request, user, "enrol", None, {**base, "error": "integrity"}, AuditResult.ERROR
        )
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT, detail="The entry could not be stored"
        ) from exc
    await session.refresh(entry)

    await _record(
        request,
        user,
        "enrol",
        entry.id,
        {**base, "quality": reference.quality, "photo_sha256": entry.photo_sha256},
    )
    return _out(entry, user, with_photo=False)


# ── decisions ──────────────────────────────────────────────────────────
async def _four_eyes(request: Request, user: CurrentUser, entry: PersonEntry, action: str) -> None:
    """The account that enrolled an entry may not decide on it."""
    if entry.enrolled_by == user.id:
        await _record(request, user, action, entry.id, {"refused": "four_eyes"}, AuditResult.DENIED)
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Four-eyes rule: you enrolled this entry, so a different account must "
            f"{'approve' if action == 'approve' else 'reject'} it.",
        )


def _require_pending(entry: PersonEntry, verb: str) -> None:
    if entry.status != PersonStatus.PENDING_APPROVAL.value:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=f"Only an entry awaiting approval can be {verb}; this one is {entry.status}.",
        )


@router.post(
    "/{entry_id}/approve",
    response_model=PersonOut,
    dependencies=[Depends(require_permission(Permission.PERSON_APPROVE))],
    summary="Approve an entry enrolled by someone else; matching starts",
)
async def approve(
    entry_id: uuid.UUID,
    session: DbSession,
    user: CurrentUserDep,
    request: Request,
) -> PersonOut:
    entry = await _entry_or_404(session, entry_id)
    await _four_eyes(request, user, entry, "approve")
    _require_pending(entry, "approved")
    now = datetime.now(UTC)
    if entry.valid_until <= now:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="This entry expired before it was approved. Enrol it again.",
        )
    if not entry.embeddings:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="This entry holds no reference embedding to match against. Enrol it again.",
        )

    entry.status = PersonStatus.ACTIVE.value
    entry.approved_by = user.id
    entry.approved_by_username = user.username
    entry.approved_at = now
    await session.commit()
    await session.refresh(entry)

    size = await persons.publish_gallery()
    await _record(
        request,
        user,
        "approve",
        entry.id,
        {
            "case_ref": entry.case_ref,
            "enrolled_by": entry.enrolled_by_username,
            "gallery_size": size,
        },
    )
    return _out(entry, user, with_photo=False)


@router.post(
    "/{entry_id}/reject",
    response_model=PersonOut,
    dependencies=[Depends(require_permission(Permission.PERSON_APPROVE))],
    summary="Reject an entry enrolled by someone else, with a reason",
)
async def reject(
    entry_id: uuid.UUID,
    payload: PersonDecision,
    session: DbSession,
    user: CurrentUserDep,
    request: Request,
) -> PersonOut:
    entry = await _entry_or_404(session, entry_id)
    await _four_eyes(request, user, entry, "reject")
    _require_pending(entry, "rejected")
    if not payload.reason:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="A rejection must say why — it is the decision most worth reviewing later.",
        )

    entry.status = PersonStatus.REJECTED.value
    entry.rejected_by = user.id
    entry.rejected_by_username = user.username
    entry.rejected_at = datetime.now(UTC)
    entry.rejection_reason = payload.reason
    persons.destroy_biometrics(entry)
    await session.commit()
    await session.refresh(entry)

    await _record(
        request, user, "reject", entry.id, {"case_ref": entry.case_ref, "reason": payload.reason}
    )
    return _out(entry, user, with_photo=False)


@router.post(
    "/{entry_id}/retire",
    response_model=PersonOut,
    dependencies=[Depends(require_permission(Permission.PERSON_RETIRE))],
    summary="Stop matching an entry now, with a reason",
)
async def retire(
    entry_id: uuid.UUID,
    payload: PersonDecision,
    session: DbSession,
    user: CurrentUserDep,
    request: Request,
) -> PersonOut:
    entry = await _entry_or_404(session, entry_id)
    if entry.status not in (PersonStatus.PENDING_APPROVAL.value, PersonStatus.ACTIVE.value):
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=f"This entry is already {entry.status}.",
        )
    if not payload.reason:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="Retiring an entry must say why — found, case closed, enrolled in error.",
        )

    was = entry.status
    entry.status = PersonStatus.RETIRED.value
    entry.retired_by = user.id
    entry.retired_by_username = user.username
    entry.retired_at = datetime.now(UTC)
    entry.retired_reason = payload.reason
    persons.destroy_biometrics(entry)
    await session.commit()
    await session.refresh(entry)

    # In the same request: stopping a match must not wait for the next sweep.
    size = await persons.publish_gallery()
    await _record(
        request,
        user,
        "retire",
        entry.id,
        {"case_ref": entry.case_ref, "was": was, "reason": payload.reason, "gallery_size": size},
    )
    return _out(entry, user, with_photo=False)
