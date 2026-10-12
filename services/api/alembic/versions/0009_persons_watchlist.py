"""The persons watchlist, and what an alert needs to report a face match.

The brief asks for watchlists of wanted or missing persons beside vehicles.
A face is the most sensitive identifier this platform will hold, so the table
is built to carry its own controls (see `app/models/persons.py` and
docs/SECURITY.md § Persons watchlist):

* **Four-eyes at the database.** CHECK constraints refuse an approval or a
  rejection by the account that enrolled the entry, and an `active` row with no
  approver. The API refuses both first; these make sure no future code path
  can skip them.
* **Purpose limitation.** `purpose` and `case_ref` are NOT NULL, and every row
  has a `valid_until` — the API defaults it to 30 days and caps it.
* **Data minimisation.** The reference photo lives in a private bucket and is
  referenced by key; the embedding column is nulled when the entry stops being
  matchable; `media_purged_at` records when retention removed the photo.

`alerts` gains three nullable columns for `person_match`: the entry matched,
the similarity (not a probability, so not `confidence`), and the object key of
the captured face. Existing alert types leave them NULL and change in no way.

Revision ID: 0009
Revises: 0008
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0009"
down_revision: str | None = "0008"
branch_labels: str | None = None
depends_on: str | None = None


def upgrade() -> None:
    op.create_table(
        "person_watchlist",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column("display_name", sa.String(120), nullable=False),
        sa.Column("category", sa.String(16), nullable=False),
        sa.Column("case_ref", sa.String(64), nullable=False),
        sa.Column("purpose", sa.Text(), nullable=False),
        sa.Column("notes", sa.Text(), nullable=True),
        sa.Column("photo_key", sa.Text(), nullable=True),
        sa.Column("photo_sha256", sa.String(64), nullable=True),
        sa.Column("embeddings", postgresql.JSONB(astext_type=sa.Text()), nullable=True),
        sa.Column("embedding_model", sa.String(48), nullable=False),
        sa.Column("enrol_quality", postgresql.JSONB(astext_type=sa.Text()), nullable=True),
        sa.Column(
            "status", sa.String(20), nullable=False, server_default="pending_approval"
        ),
        sa.Column("valid_until", sa.DateTime(timezone=True), nullable=False),
        sa.Column("enrolled_by", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("enrolled_by_username", sa.String(64), nullable=False),
        sa.Column(
            "enrolled_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.func.now(),
        ),
        sa.Column("approved_by", postgresql.UUID(as_uuid=True), nullable=True),
        sa.Column("approved_by_username", sa.String(64), nullable=True),
        sa.Column("approved_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("rejected_by", postgresql.UUID(as_uuid=True), nullable=True),
        sa.Column("rejected_by_username", sa.String(64), nullable=True),
        sa.Column("rejected_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("rejection_reason", sa.Text(), nullable=True),
        sa.Column("retired_by", postgresql.UUID(as_uuid=True), nullable=True),
        sa.Column("retired_by_username", sa.String(64), nullable=True),
        sa.Column("retired_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("retired_reason", sa.Text(), nullable=True),
        sa.Column("media_purged_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.func.now(),
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.func.now(),
        ),
        sa.CheckConstraint(
            "status IN ('pending_approval', 'active', 'rejected', 'retired')",
            name="ck_person_watchlist_status",
        ),
        sa.CheckConstraint(
            "approved_by IS NULL OR approved_by <> enrolled_by",
            name="ck_person_watchlist_four_eyes_approve",
        ),
        sa.CheckConstraint(
            "rejected_by IS NULL OR rejected_by <> enrolled_by",
            name="ck_person_watchlist_four_eyes_reject",
        ),
        sa.CheckConstraint(
            "status <> 'active' OR approved_by IS NOT NULL",
            name="ck_person_watchlist_active_is_approved",
        ),
    )
    op.create_index(
        "ix_person_watchlist_status_created",
        "person_watchlist",
        ["status", sa.text("created_at DESC")],
    )
    op.create_index(
        "ix_person_watchlist_active_valid",
        "person_watchlist",
        ["valid_until"],
        postgresql_where=sa.text("status = 'active'"),
    )

    op.add_column(
        "alerts",
        sa.Column(
            "person_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("person_watchlist.id", ondelete="SET NULL"),
            nullable=True,
        ),
    )
    op.add_column("alerts", sa.Column("similarity", sa.Float(), nullable=True))
    op.add_column("alerts", sa.Column("face_crop_key", sa.Text(), nullable=True))
    op.create_index(
        "ix_alerts_person_camera_created",
        "alerts",
        ["person_id", "camera_id", sa.text("created_at DESC")],
        postgresql_where=sa.text("person_id IS NOT NULL"),
    )


def downgrade() -> None:
    op.drop_index("ix_alerts_person_camera_created", table_name="alerts")
    op.drop_column("alerts", "face_crop_key")
    op.drop_column("alerts", "similarity")
    op.drop_column("alerts", "person_id")
    op.drop_index("ix_person_watchlist_active_valid", table_name="person_watchlist")
    op.drop_index("ix_person_watchlist_status_created", table_name="person_watchlist")
    op.drop_table("person_watchlist")
