"""The persons watchlist, from the platform's side: the gallery the cameras
match against, the alerts their matches raise, and the expiry and retention
that keep the list from outliving its purpose.

## What leaves this module for the cameras

`publish_gallery` writes the *active, approved, unexpired* entries to Redis —
ids, categories, case references, expiries and SFace embeddings. **No photos
and no names**: a camera needs to know whether a face matches an approved entry
and how closely, and nothing about who the entry is. The payload carries the
platform's match policy and expires on its own (`PERSON_GALLERY_TTL_SECONDS`),
so a worker cut off from the platform stops matching instead of matching an
outdated list. It is republished on every change and once a minute besides.

## What a match becomes

`raise_for_match` turns a `person.match` event into a `person_match` alert —
after checking, on the platform's side, everything the edge claims: that the
entry exists and is active and unexpired *now*, that the similarity and the
frames that agreed meet the platform's policy, and that both sides computed
embeddings in the same space. An edge configured looser than the platform, or
holding a gallery from before an entry was retired, cannot raise an alert.

The alert is always `high`, never `critical`, and always a *possible* match:
it carries its reasons (similarity against threshold, frames agreed, margin
over the next-closest entry, what the entry is held for) and a person must
compare the two faces before anyone acts. Repeats on the same entry at the same
camera within `PERSON_MATCH_DEDUP_SECONDS`, or while the alert already raised
there is still open, fold into that alert.

## Expiry and retention

`PersonSweeper` runs every minute: entries past `valid_until` are retired by
the platform (audited as `person.expire`) and their embeddings destroyed; the
gallery is republished. Once an hour it applies media retention: photos of
entries retired or rejected more than `RETENTION_PERSON_MEDIA_DAYS` ago, and
face crops on alerts older than that, are deleted from object storage
(`person.media_purge`). The rows stay — they are the record of who authorised
what and why.
"""

from __future__ import annotations

import asyncio
import contextlib
import hashlib
import json
import uuid
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import Any, Literal

import redis.asyncio as aioredis
from pydantic import BaseModel, ConfigDict, Field, ValidationError
from redis.exceptions import RedisError
from sqlalchemy import or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings
from app.core.logging import get_logger
from app.db.session import SessionLocal
from app.models.enums import AlertStatus, AlertType, PersonCategory, PersonStatus, Priority
from app.models.intelligence import Alert
from app.models.persons import PersonEntry
from app.services import alerts as alert_service
from app.services import audit, person_media

log = get_logger("api.persons")

#: Where the active gallery is published. Read by `ai_worker.gallery`.
GALLERY_KEY = "nagarnetra:persons:gallery"
GALLERY_SCHEMA = "contrail.persons.gallery.v1"

#: The embedding space every entry is enrolled in, and every match must be
#: computed in. Mirrors `ailab.face.models.SFACE_MODEL_ID`, which the API
#: imports only lazily (OpenCV is needed to *compute* one, not to compare ids).
SFACE_MODEL_ID = "sface_2021dec"
#: SFace's published cosine threshold, reported beside the platform's own.
SFACE_PUBLISHED_COSINE_THRESHOLD = 0.363

SWEEP_INTERVAL_S = 60.0
MEDIA_SWEEP_EVERY_S = 3600.0
#: Objects deleted per media sweep, so one pass over a large backlog cannot
#: hold a transaction for minutes.
MEDIA_SWEEP_BATCH = 200

#: An alert still needing a person — the same set the alarm list calls open.
OPEN_ALERT_STATUSES = (
    AlertStatus.NEW.value,
    AlertStatus.ACKNOWLEDGED.value,
    AlertStatus.DISPATCHED.value,
)

CATEGORY_WORDS = {
    PersonCategory.MISSING.value: "reported missing",
    PersonCategory.WANTED.value: "sought under a warrant",
    PersonCategory.DEMO.value: "a demonstration entry with a fictional case",
}


def _now() -> datetime:
    return datetime.now(UTC)


def is_matchable(entry: PersonEntry, at: datetime | None = None) -> bool:
    """Active, approved, unexpired, and holding an embedding."""
    moment = at or _now()
    return (
        entry.status == PersonStatus.ACTIVE.value
        and entry.approved_by is not None
        and bool(entry.embeddings)
        and entry.valid_until >= moment
    )


# ─────────────────────────────────────────────────────────────────────
# The gallery
# ─────────────────────────────────────────────────────────────────────
def _policy() -> dict[str, Any]:
    return {
        "threshold": settings.person_match_threshold,
        "min_frames": settings.person_match_min_frames,
        "min_margin": settings.person_match_min_margin,
    }


async def build_gallery(session: AsyncSession) -> dict[str, Any]:
    """The payload the workers read. Entries that cannot match are absent."""
    now = _now()
    rows = (
        (
            await session.execute(
                select(PersonEntry)
                .where(
                    PersonEntry.status == PersonStatus.ACTIVE.value,
                    PersonEntry.valid_until >= now,
                    PersonEntry.approved_by.is_not(None),
                    PersonEntry.embeddings.is_not(None),
                    PersonEntry.embedding_model == SFACE_MODEL_ID,
                )
                .order_by(PersonEntry.id)
            )
        )
        .scalars()
        .all()
    )
    entries = [
        {
            "person_id": str(row.id),
            "category": row.category,
            "case_ref": row.case_ref,
            "valid_until": row.valid_until.isoformat(),
            "embeddings": list(row.embeddings or []),
        }
        for row in rows
    ]
    # The version is the content: a worker compares it to decide whether its
    # copy is current, and two publishes of the same list must agree.
    digest = hashlib.sha256(
        json.dumps({"entries": entries, "policy": _policy()}, sort_keys=True).encode()
    ).hexdigest()[:16]
    return {
        "schema": GALLERY_SCHEMA,
        "version": digest,
        "model": SFACE_MODEL_ID,
        "published_at": now.isoformat(),
        "expires_at": (now + timedelta(seconds=settings.person_gallery_ttl_seconds)).isoformat(),
        "policy": _policy(),
        "entries": entries,
    }


@dataclass(slots=True)
class GalleryState:
    """What was last published, for the status endpoint and the screen."""

    version: str = ""
    size: int = 0
    published_at: datetime | None = None
    error: str | None = None


gallery_state = GalleryState()


async def publish_gallery() -> int:
    """Publish the active gallery now. Returns how many entries it holds.

    Never raises for a Redis failure: the database change that prompted the
    publish has already committed, and the sweeper republishes within a
    minute. The server-side checks in `raise_for_match` mean a stale gallery
    can produce at worst a dropped event, never an alert for a retired entry.
    """
    async with SessionLocal() as session:
        payload = await build_gallery(session)
    client = aioredis.from_url(settings.redis_url, decode_responses=True)
    try:
        await client.set(GALLERY_KEY, json.dumps(payload), ex=settings.person_gallery_ttl_seconds)
    except RedisError as exc:
        gallery_state.error = str(exc)
        log.warning("persons.gallery_publish_failed", error=str(exc))
        return len(payload["entries"])
    finally:
        await client.aclose()

    if payload["version"] != gallery_state.version:
        log.info(
            "persons.gallery_published", entries=len(payload["entries"]), version=payload["version"]
        )
    gallery_state.version = payload["version"]
    gallery_state.size = len(payload["entries"])
    gallery_state.published_at = datetime.fromisoformat(payload["published_at"])
    gallery_state.error = None
    return gallery_state.size


# ─────────────────────────────────────────────────────────────────────
# A match, from the edge
# ─────────────────────────────────────────────────────────────────────
class _EventPerson(BaseModel):
    model_config = ConfigDict(extra="ignore")
    id: uuid.UUID
    category: str | None = None
    case_ref: str | None = None


class _EventMatch(BaseModel):
    model_config = ConfigDict(extra="ignore")
    similarity: float = Field(ge=-1.0, le=1.0)
    similarity_mean: float | None = Field(default=None, ge=-1.0, le=1.0)
    threshold: float = Field(ge=0.0, le=1.0)
    model_threshold: float | None = None
    frames_agreed: int = Field(ge=1)
    frames_required: int = Field(ge=1)
    frames_seen: int | None = Field(default=None, ge=0)
    margin: float | None = None
    window_s: float | None = Field(default=None, ge=0.0)
    model: str
    gallery_version: str | None = None


class PersonMatchEvent(BaseModel):
    """`ailab.person.match.v1`, as `ailab/face/events.py` builds it."""

    model_config = ConfigDict(extra="ignore")
    event: Literal["person.match"]
    event_id: str | None = None
    captured_at: datetime | None = None
    event_time: datetime | None = None
    source: dict[str, Any]
    person: _EventPerson
    match: _EventMatch
    face: dict[str, Any] | None = None
    evidence: dict[str, Any] | None = None

    @property
    def camera_code(self) -> str:
        return str(self.source.get("camera_id") or "")

    @property
    def face_crop_key(self) -> str | None:
        key = (self.evidence or {}).get("face_crop")
        # Only keys in the persons bucket's face area are accepted; anything
        # else is not something this platform wrote.
        return key if isinstance(key, str) and key.startswith("faces/") else None

    @property
    def when(self) -> datetime:
        moment = self.captured_at or self.event_time or _now()
        return moment if moment.tzinfo else moment.replace(tzinfo=UTC)


def parse_event(raw: dict[str, Any]) -> PersonMatchEvent | None:
    try:
        return PersonMatchEvent.model_validate(raw)
    except ValidationError as exc:
        log.warning("person_match.malformed", errors=exc.error_count())
        return None


def _policy_refusal(event: PersonMatchEvent, entry: PersonEntry | None) -> str | None:
    """Why the platform will not raise an alert for this, or None."""
    match = event.match
    if entry is None:
        return "no such entry"
    if not is_matchable(entry, min(event.when, _now())):
        return f"entry is {entry.status} or expired"
    if match.model != entry.embedding_model:
        return f"computed in {match.model}, enrolled in {entry.embedding_model}"
    if match.similarity < settings.person_match_threshold:
        return "similarity below the platform threshold"
    if match.frames_agreed < settings.person_match_min_frames:
        return "too few frames agreed"
    if match.margin is not None and match.margin < settings.person_match_min_margin:
        return "too close to another entry"
    return None


def build_reasons(event: PersonMatchEvent, entry: PersonEntry) -> list[dict[str, Any]]:
    """Why the alarm fired, in the words an operator reads (CLAUDE.md §5).

    Each reason is `{factor, detail}` like every other alert's, plus the
    numbers behind the sentence under their own keys — the alert list shows
    the sentence (`AlertReason` ignores the rest), and the evidence screen
    reads the numbers without parsing English.
    """
    match = event.match
    model_threshold = match.model_threshold or SFACE_PUBLISHED_COSINE_THRESHOLD
    required = max(match.frames_required, settings.person_match_min_frames)
    window = f" over {match.window_s:.1f} s" if match.window_s else ""
    seen = (
        f"; {match.frames_seen} frames of that face were analysed in all"
        if match.frames_seen and match.frames_seen > match.frames_agreed
        else ""
    )
    reasons: list[dict[str, Any]] = [
        {
            "factor": "face_similarity",
            "detail": (
                f"The captured face scored {match.similarity:.2f} against the enrolled reference "
                f"photo (cosine similarity). This deployment requires "
                f"{settings.person_match_threshold:.2f}; the model's published threshold is "
                f"{model_threshold:.3f}."
            ),
            "similarity": round(match.similarity, 4),
            "threshold": settings.person_match_threshold,
            "model_threshold": model_threshold,
        },
        {
            "factor": "frames_agreed",
            "detail": (
                f"{match.frames_agreed} analysed frames of the same face agreed on this entry"
                f"{window} ({required} required){seen}."
            ),
            "agreed": match.frames_agreed,
            "required": required,
            "seen": match.frames_seen,
        },
    ]
    if match.margin is not None:
        reasons.append(
            {
                "factor": "next_closest_entry",
                "detail": (
                    f"The next-closest enrolled entry scored {match.similarity - match.margin:.2f}"
                    f" — {match.margin:.2f} lower."
                ),
                "margin": round(match.margin, 4),
            }
        )
    reasons.append(
        {
            "factor": "watchlist_entry",
            "detail": (
                f"The entry is {CATEGORY_WORDS.get(entry.category, entry.category)}, under case "
                f"{entry.case_ref}, approved by {entry.approved_by_username or 'an approver'}."
            ),
            "category": entry.category,
        }
    )
    return reasons


async def raise_for_match(
    session: AsyncSession,
    event: PersonMatchEvent,
    camera_id: uuid.UUID | None,
    dedup: alert_service.SharedAlertDeduper | None = None,
) -> tuple[Alert, PersonEntry] | None:
    """Create a `person_match` alert, or None when policy or dedupe says not.

    The caller commits, inside `dedup.unit()`. Checked against the entry as it
    is *now* — a match computed against a gallery published before the entry
    was retired raises nothing.

    Deduplicated twice over: against alerts already committed (which survives a
    Redis restart), and by a claim in Redis (which closes the race the first
    check leaves open — two consumer replicas, each in its own transaction,
    would both find nothing committed and both raise).

    The committed check folds a repeat into any alert raised inside the window
    **or still open** for the same entry at the same camera. The window alone
    let a person who stays in view — or a looping demonstration clip — raise a
    fresh alarm every few minutes, which buried the one an operator had yet to
    look at under copies of itself. A new alarm is raised once the open one has
    been closed or dismissed.
    """
    entry = await session.get(PersonEntry, event.person.id)
    refusal = _policy_refusal(event, entry)
    if refusal is not None or entry is None:
        log.info(
            "person_match.not_raised",
            reason=refusal,
            camera_code=event.camera_code,
            similarity=event.match.similarity,
        )
        return None

    window_start = _now() - timedelta(seconds=settings.person_match_dedup_seconds)
    # A window of 0 turns deduplication off — the open-alert fold with it.
    recent_or_open = (
        or_(Alert.created_at >= window_start, Alert.status.in_(OPEN_ALERT_STATUSES))
        if settings.person_match_dedup_seconds > 0
        else Alert.created_at >= window_start
    )
    repeat = await session.scalar(
        select(Alert.id)
        .where(
            Alert.alert_type == AlertType.PERSON_MATCH.value,
            Alert.person_id == entry.id,
            Alert.camera_id == camera_id if camera_id is not None else Alert.camera_id.is_(None),
            recent_or_open,
        )
        .order_by(Alert.created_at.desc())
        .limit(1)
    )
    if repeat is not None:
        log.info(
            "alert.deduplicated",
            alert_id=str(repeat),
            alert_type=AlertType.PERSON_MATCH.value,
            camera_code=event.camera_code,
        )
        return None

    alert_id = uuid.uuid4()
    # A window of 0 turns deduplication off, here as in the query above.
    claimed_by = (
        await (dedup or alert_service.deduper).claim(
            str(entry.id),
            str(camera_id) if camera_id is not None else "unknown-camera",
            alert_id,
            kind=AlertType.PERSON_MATCH.value,
            window=timedelta(seconds=settings.person_match_dedup_seconds),
        )
        if settings.person_match_dedup_seconds > 0
        else None
    )
    if claimed_by is not None:
        log.info(
            "alert.deduplicated",
            alert_id=str(claimed_by.alert_id),
            alert_type=AlertType.PERSON_MATCH.value,
            camera_code=event.camera_code,
            repeats=claimed_by.repeats,
        )
        return None

    reasons = build_reasons(event, entry)
    alert = Alert(
        # The id the dedup claim names, so a repeat on any replica points here.
        id=alert_id,
        detection_id=None,
        # The frame the face was matched on, for the same chronological
        # sorting a detection-backed alert gets.
        detection_ts=event.when,
        watchlist_id=None,
        camera_id=camera_id,
        alert_type=AlertType.PERSON_MATCH.value,
        # Never critical: a face match is a lead for a person to check, and an
        # operator taught that critical can mean "a model thought so" stops
        # trusting critical.
        priority=Priority.HIGH.value,
        plate_normalised=None,
        confidence=None,
        status=AlertStatus.NEW.value,
        notes="; ".join(r["detail"] for r in reasons),
        reasons=reasons,
        person_id=entry.id,
        similarity=event.match.similarity,
        face_crop_key=event.face_crop_key,
    )
    session.add(alert)
    await session.flush()
    log.info(
        "alert.raised",
        alert_id=str(alert.id),
        alert_type=alert.alert_type,
        priority=alert.priority,
        camera_code=event.camera_code,
        frames_agreed=event.match.frames_agreed,
    )
    return alert, entry


def alert_payload(alert: Alert, entry: PersonEntry) -> dict[str, Any]:
    """The live-feed shape: the generic alert, plus what the entry is held for.

    No name and no photograph — this goes to every connected operator, and a
    face is shown only through the audited `person.read` evidence endpoint.
    """
    payload = alert_service.alert_payload(alert)
    payload["similarity"] = alert.similarity
    payload["person"] = {
        "id": str(entry.id),
        "category": entry.category,
        "case_ref": entry.case_ref,
    }
    return payload


# ─────────────────────────────────────────────────────────────────────
# Lifecycle helpers shared by the router and the sweeper
# ─────────────────────────────────────────────────────────────────────
def destroy_biometrics(entry: PersonEntry) -> None:
    """The embedding exists only to be matched; an entry that cannot match
    does not keep it. The photo stays until media retention, so the decision
    to enrol, approve or reject can still be reviewed."""
    entry.embeddings = None


async def expire_due(session: AsyncSession) -> list[PersonEntry]:
    """Retire every entry past its `valid_until`. The caller commits."""
    now = _now()
    due = (
        (
            await session.execute(
                select(PersonEntry)
                .where(
                    PersonEntry.status.in_(
                        [PersonStatus.ACTIVE.value, PersonStatus.PENDING_APPROVAL.value]
                    ),
                    PersonEntry.valid_until < now,
                )
                .limit(500)
            )
        )
        .scalars()
        .all()
    )
    for entry in due:
        entry.status = PersonStatus.RETIRED.value
        entry.retired_at = now
        entry.retired_by = None
        entry.retired_by_username = None
        entry.retired_reason = "expired — valid_until passed with no renewal"
        destroy_biometrics(entry)
    return list(due)


async def purge_media(session: AsyncSession) -> dict[str, int]:
    """Delete photos and face crops past retention. The caller commits."""
    cutoff = _now() - timedelta(days=settings.retention_person_media_days)
    purged = {"photos": 0, "face_crops": 0, "failed": 0}

    entries = (
        (
            await session.execute(
                select(PersonEntry)
                .where(
                    PersonEntry.status.in_(
                        [PersonStatus.RETIRED.value, PersonStatus.REJECTED.value]
                    ),
                    PersonEntry.photo_key.is_not(None),
                    or_(PersonEntry.retired_at < cutoff, PersonEntry.rejected_at < cutoff),
                )
                .limit(MEDIA_SWEEP_BATCH)
            )
        )
        .scalars()
        .all()
    )
    for entry in entries:
        if entry.photo_key and await person_media.delete_object(entry.photo_key):
            entry.photo_key = None
            entry.media_purged_at = _now()
            destroy_biometrics(entry)
            purged["photos"] += 1
        else:
            purged["failed"] += 1

    crops = (
        (
            await session.execute(
                select(Alert)
                .where(
                    Alert.alert_type == AlertType.PERSON_MATCH.value,
                    Alert.face_crop_key.is_not(None),
                    Alert.created_at < cutoff,
                )
                .limit(MEDIA_SWEEP_BATCH)
            )
        )
        .scalars()
        .all()
    )
    for alert in crops:
        if alert.face_crop_key and await person_media.delete_object(alert.face_crop_key):
            alert.face_crop_key = None
            purged["face_crops"] += 1
        else:
            purged["failed"] += 1
    return purged


class PersonSweeper:
    """Expiry every minute, the gallery republished, media retention hourly."""

    def __init__(self) -> None:
        self._task: asyncio.Task[None] | None = None
        self._stop = asyncio.Event()
        self._last_media_sweep = 0.0
        self.runs = 0
        self.expired = 0

    def start(self) -> None:
        if self._task is None:
            self._stop.clear()
            self._task = asyncio.create_task(self._loop(), name="persons-sweeper")

    async def stop(self) -> None:
        self._stop.set()
        if self._task is not None:
            self._task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await self._task
            self._task = None

    async def run_once(self) -> dict[str, Any]:
        async with SessionLocal() as session:
            expired = await expire_due(session)
            await session.commit()
        for entry in expired:
            self.expired += 1
            await audit.record(
                action="person.expire",
                username="platform",
                role="system",
                resource_type="person",
                resource_id=entry.id,
                params={"case_ref": entry.case_ref, "valid_until": entry.valid_until.isoformat()},
            )

        size = await publish_gallery()

        media: dict[str, int] | None = None
        loop_time = asyncio.get_running_loop().time()
        if loop_time - self._last_media_sweep >= MEDIA_SWEEP_EVERY_S:
            self._last_media_sweep = loop_time
            async with SessionLocal() as session:
                media = await purge_media(session)
                await session.commit()
            if media["photos"] or media["face_crops"]:
                await audit.record(
                    action="person.media_purge",
                    username="platform",
                    role="system",
                    resource_type="person",
                    params={**media, "retention_days": settings.retention_person_media_days},
                )
        self.runs += 1
        return {"expired": len(expired), "gallery_size": size, "media": media}

    async def _loop(self) -> None:
        while not self._stop.is_set():
            try:
                await self.run_once()
            except Exception:
                # Supervisor boundary: expiry must keep running after a
                # transient database or storage failure, and say so when not.
                log.warning("persons.sweep_failed", exc_info=True)
            with contextlib.suppress(TimeoutError):
                await asyncio.wait_for(self._stop.wait(), timeout=SWEEP_INTERVAL_S)


sweeper = PersonSweeper()
