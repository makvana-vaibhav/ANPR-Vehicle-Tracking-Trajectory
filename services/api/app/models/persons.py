"""The persons watchlist.

A face is the most sensitive identifier this platform handles, so this table
carries its controls in its own shape rather than relying on whoever writes the
next endpoint to remember them:

* **Four-eyes.** An entry is enrolled by one account and made active by a
  *different* one. The API refuses self-approval, and a CHECK constraint
  refuses it again at the database, so a future code path cannot quietly skip
  it (migration 0009).
* **Purpose and expiry.** Every entry states its purpose (the legal basis it is
  held under) and a case reference, and lapses at `valid_until` — 30 days by
  default. An entry nobody renews stops being matched on its own.
* **Only what is needed, only while it is needed.** The reference photo is
  stored in a private bucket as a key here, never inline; the embedding is
  destroyed the moment an entry stops being matchable (rejected, retired,
  expired), because nothing but matching needs it.
* **Who did what is on the row,** denormalised by username as the audit log
  is, so the record reads the same after an account is renamed or removed.
"""

from __future__ import annotations

import uuid
from datetime import datetime
from typing import Any

from sqlalchemy import CheckConstraint, DateTime, Index, String, Text, func, text
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.db.session import Base
from app.models.enums import PersonStatus


class PersonEntry(Base):
    """One person the platform has been authorised to look for."""

    __tablename__ = "person_watchlist"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)

    #: How the entry is referred to on screen — an alias or a case name is
    #: enough, and often better than a legal name.
    display_name: Mapped[str] = mapped_column(String(120), nullable=False)
    category: Mapped[str] = mapped_column(String(16), nullable=False)
    case_ref: Mapped[str] = mapped_column(String(64), nullable=False)
    #: The purpose and legal basis the entry is held under, in the enroller's
    #: words. Required: an entry nobody can justify should not exist.
    purpose: Mapped[str] = mapped_column(Text, nullable=False)
    notes: Mapped[str | None] = mapped_column(Text)

    #: Object key of the reference photo in the private persons bucket
    #: (`MINIO_PERSONS_BUCKET`). Re-encoded from pixels at enrolment, so it
    #: carries no EXIF. NULL once retention has removed it.
    photo_key: Mapped[str | None] = mapped_column(Text)
    #: SHA-256 of the stored photo, so the evidence an alert was judged against
    #: can be shown to be the one that was enrolled.
    photo_sha256: Mapped[str | None] = mapped_column(String(64))
    #: SFace embeddings of the reference photo, as base64 float32 strings
    #: (`ailab.face.gallery.encode_embedding`). NULL once the entry can no
    #: longer match — see the module docstring.
    embeddings: Mapped[list[str] | None] = mapped_column(JSONB)
    #: The embedding space (`sface_2021dec`). A different model is a different
    #: space; vectors from two must never be compared.
    embedding_model: Mapped[str] = mapped_column(String(48), nullable=False)
    #: Where the face was found and how good the reference is: detector score,
    #: face size in pixels, sharpness. Shown to the approver.
    enrol_quality: Mapped[dict[str, Any] | None] = mapped_column(JSONB)

    status: Mapped[str] = mapped_column(
        String(20), nullable=False, default=PersonStatus.PENDING_APPROVAL.value
    )
    valid_until: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)

    enrolled_by: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False)
    enrolled_by_username: Mapped[str] = mapped_column(String(64), nullable=False)
    enrolled_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )

    approved_by: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))
    approved_by_username: Mapped[str | None] = mapped_column(String(64))
    approved_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))

    rejected_by: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))
    rejected_by_username: Mapped[str | None] = mapped_column(String(64))
    rejected_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    rejection_reason: Mapped[str | None] = mapped_column(Text)

    #: NULL with a `retired` status means the platform retired it on expiry.
    retired_by: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))
    retired_by_username: Mapped[str | None] = mapped_column(String(64))
    retired_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    retired_reason: Mapped[str | None] = mapped_column(Text)

    #: When retention removed the photo (and with it the last of the entry's
    #: biometric data). The row itself stays: it is the record that the entry
    #: existed, who authorised it, and why.
    media_purged_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))

    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
        server_default=func.now(),
        onupdate=func.now(),
    )

    __table_args__ = (
        CheckConstraint(
            "status IN ('pending_approval', 'active', 'rejected', 'retired')",
            name="ck_person_watchlist_status",
        ),
        # Four-eyes, at the database: the account that enrolled an entry can
        # neither approve it nor reject it.
        CheckConstraint(
            "approved_by IS NULL OR approved_by <> enrolled_by",
            name="ck_person_watchlist_four_eyes_approve",
        ),
        CheckConstraint(
            "rejected_by IS NULL OR rejected_by <> enrolled_by",
            name="ck_person_watchlist_four_eyes_reject",
        ),
        # An active entry has an approver, always.
        CheckConstraint(
            "status <> 'active' OR approved_by IS NOT NULL",
            name="ck_person_watchlist_active_is_approved",
        ),
        Index("ix_person_watchlist_status_created", "status", created_at.desc()),
        # The gallery publisher reads exactly this set, every minute.
        Index(
            "ix_person_watchlist_active_valid",
            "valid_until",
            postgresql_where=text("status = 'active'"),
        ),
    )

    def __repr__(self) -> str:
        return f"<PersonEntry {self.id} {self.category}/{self.status}>"
