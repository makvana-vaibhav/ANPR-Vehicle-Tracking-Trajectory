"""Request and response shapes for the persons watchlist.

No response here ever carries an embedding. Photographs travel only as
two-minute signed URLs, and only from endpoints that check `person.read` and
write an audit row for every URL they issue.
"""

from __future__ import annotations

import uuid
from datetime import datetime
from typing import Any

from pydantic import BaseModel, ConfigDict, Field, field_validator


class PersonOut(BaseModel):
    """One entry as an operator with `person.read` sees it."""

    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    display_name: str
    category: str
    case_ref: str
    purpose: str
    notes: str | None
    status: str
    valid_until: datetime
    #: True when the entry would be matched right now: active, approved,
    #: unexpired, with its embedding still held.
    matchable: bool = False
    #: Signed for two minutes; None when retention has removed the photo.
    photo_url: str | None = None
    photo_purged: bool = False
    enrol_quality: dict[str, Any] | None
    embedding_model: str

    enrolled_by: uuid.UUID
    enrolled_by_username: str
    enrolled_at: datetime
    approved_by_username: str | None
    approved_at: datetime | None
    rejected_by_username: str | None
    rejected_at: datetime | None
    rejection_reason: str | None
    retired_by_username: str | None
    retired_at: datetime | None
    retired_reason: str | None
    #: Whether the caller may approve or reject this entry: holds
    #: `person.approve`, the entry is pending, and the caller did not enrol it.
    #: The API enforces all three regardless; this is so the screen can say why.
    can_review: bool = False


class PersonPage(BaseModel):
    items: list[PersonOut]
    total: int
    limit: int
    offset: int
    #: How many entries are waiting for a second pair of eyes.
    pending: int


class PersonDecision(BaseModel):
    """Approve needs no reason; reject and retire do, because they are the
    decisions most worth being able to review later."""

    reason: str | None = Field(default=None, max_length=1000)

    @field_validator("reason")
    @classmethod
    def strip(cls, value: str | None) -> str | None:
        cleaned = (value or "").strip()
        return cleaned or None


class PersonMatchEvidence(BaseModel):
    """Everything a person needs to confirm or dismiss a `person_match` alarm:
    the enrolled reference and the captured face side by side, and the
    numbers behind the claim."""

    alert_id: uuid.UUID
    person: PersonOut | None
    #: The captured face, signed for two minutes. None when retention removed
    #: it or the upload never landed.
    face_url: str | None
    face_purged: bool
    similarity: float | None
    threshold: float
    model_threshold: float
    frames_agreed: int | None
    frames_required: int | None
    captured_at: datetime | None
    camera_id: uuid.UUID | None
    #: The rule this screen exists to state.
    notice: str = (
        "A possible match, not an identification. A person must compare the two faces "
        "before anyone acts."
    )


class GalleryStatus(BaseModel):
    """What the cameras are matching against right now."""

    active_entries: int
    pending_entries: int
    version: str
    published_at: datetime | None
    publish_error: str | None
    threshold: float
    min_frames: int
    min_margin: float
    model: str
    model_threshold: float
    #: Cameras the registry tags `analytics:faces` — the only ones that look.
    cameras: list[str]
    default_valid_days: int
    max_valid_days: int
    min_face_px: int
