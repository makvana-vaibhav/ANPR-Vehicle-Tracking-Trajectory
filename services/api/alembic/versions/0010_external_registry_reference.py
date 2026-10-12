"""Reference copies of VAHAN, SARTHI, eGujCop/CCTNS and AFIS/NAFIS.

The brief asks the platform to cross-reference a plate against vehicle
registration (VAHAN), a driver against licensing (SARTHI), a vehicle against
police case records (eGujCop/CCTNS) and a case against fingerprints
(AFIS/NAFIS). None of those systems is reachable from here, and the platform
must never appear to hold live access to them.

These four tables are the **local reference dataset** the registry adapters
query instead (`app/adapters/registries/`). They are loaded from
`data/seed/registries/` by `scripts/seed.py`, every row in them is fictional
("Reference Owner 017", district-level addresses, `DEMO/` or `REF/` case
numbers), and every API response built from them says `source: "reference"`.
A live connector would implement the same adapter interface and never touch
these tables.

`ref_afis_records` deliberately has no column that could hold biometric data:
it records that a record exists and its reference, and nothing else.

Revision ID: 0010
Revises: 0009
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0010"
down_revision: str | None = "0009"
branch_labels: str | None = None
depends_on: str | None = None


def _loaded_at() -> sa.Column:
    return sa.Column(
        "loaded_at",
        sa.DateTime(timezone=True),
        nullable=False,
        server_default=sa.func.now(),
    )


def upgrade() -> None:
    op.create_table(
        "ref_vahan_vehicles",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column("plate_normalised", sa.String(24), nullable=False, unique=True),
        sa.Column("owner_name", sa.String(120), nullable=False),
        sa.Column("owner_district", sa.String(64), nullable=False),
        sa.Column("owner_state", sa.String(64), nullable=False),
        sa.Column("registering_authority", sa.String(120), nullable=False),
        sa.Column("registration_status", sa.String(16), nullable=False),
        sa.Column("vehicle_class", sa.String(64), nullable=False),
        sa.Column("vehicle_category", sa.String(16), nullable=False),
        sa.Column("maker", sa.String(64), nullable=False),
        sa.Column("model", sa.String(64), nullable=False),
        sa.Column("colour", sa.String(32), nullable=False),
        sa.Column("fuel", sa.String(24), nullable=False),
        sa.Column("manufacture_year", sa.SmallInteger(), nullable=True),
        sa.Column("registered_on", sa.Date(), nullable=False),
        sa.Column("registration_valid_until", sa.Date(), nullable=False),
        sa.Column("fitness_valid_until", sa.Date(), nullable=True),
        sa.Column("insurance_valid_until", sa.Date(), nullable=True),
        sa.Column("puc_valid_until", sa.Date(), nullable=True),
        sa.Column("permit_valid_until", sa.Date(), nullable=True),
        sa.Column("hypothecated", sa.Boolean(), nullable=False, server_default=sa.false()),
        sa.Column("financier", sa.String(120), nullable=True),
        sa.Column("blacklisted", sa.Boolean(), nullable=False, server_default=sa.false()),
        sa.Column("blacklist_reason", sa.Text(), nullable=True),
        _loaded_at(),
    )

    op.create_table(
        "ref_sarthi_licences",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column("licence_number", sa.String(24), nullable=False, unique=True),
        sa.Column("holder_name", sa.String(120), nullable=False),
        sa.Column("holder_district", sa.String(64), nullable=False),
        sa.Column("holder_state", sa.String(64), nullable=False),
        sa.Column("issuing_authority", sa.String(120), nullable=False),
        sa.Column("issued_on", sa.Date(), nullable=False),
        sa.Column("non_transport_valid_until", sa.Date(), nullable=True),
        sa.Column("transport_valid_until", sa.Date(), nullable=True),
        sa.Column("classes", postgresql.ARRAY(sa.Text()), nullable=False),
        sa.Column("status", sa.String(16), nullable=False),
        sa.Column("status_reason", sa.Text(), nullable=True),
        _loaded_at(),
    )

    op.create_table(
        "ref_cctns_firs",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column("fir_number", sa.String(48), nullable=False, unique=True),
        sa.Column("police_station", sa.String(120), nullable=False),
        sa.Column("district", sa.String(64), nullable=False),
        sa.Column("state", sa.String(64), nullable=False),
        sa.Column("registered_on", sa.Date(), nullable=False),
        sa.Column("sections", postgresql.ARRAY(sa.Text()), nullable=False),
        sa.Column("status", sa.String(24), nullable=False),
        sa.Column("linked_plate", sa.String(24), nullable=False),
        sa.Column("vehicle_role", sa.String(24), nullable=False),
        sa.Column("summary", sa.Text(), nullable=False),
        _loaded_at(),
    )
    op.create_index("ix_ref_cctns_firs_linked_plate", "ref_cctns_firs", ["linked_plate"])

    op.create_table(
        "ref_afis_records",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column("reference", sa.String(64), nullable=False),
        sa.Column("afis_reference", sa.String(48), nullable=False, unique=True),
        sa.Column("nafis_reference", sa.String(48), nullable=True),
        sa.Column("linked_fir_number", sa.String(48), nullable=True),
        sa.Column("district", sa.String(64), nullable=False),
        sa.Column("recorded_on", sa.Date(), nullable=False),
        _loaded_at(),
    )
    op.create_index("ix_ref_afis_records_reference", "ref_afis_records", ["reference"])
    op.create_index("ix_ref_afis_records_linked_fir", "ref_afis_records", ["linked_fir_number"])


def downgrade() -> None:
    op.drop_index("ix_ref_afis_records_linked_fir", table_name="ref_afis_records")
    op.drop_index("ix_ref_afis_records_reference", table_name="ref_afis_records")
    op.drop_table("ref_afis_records")
    op.drop_index("ix_ref_cctns_firs_linked_plate", table_name="ref_cctns_firs")
    op.drop_table("ref_cctns_firs")
    op.drop_table("ref_sarthi_licences")
    op.drop_table("ref_vahan_vehicles")
