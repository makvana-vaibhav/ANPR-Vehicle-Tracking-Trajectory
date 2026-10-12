"""Reference copies of the external registries a plate or a case leads to.

The brief names four government systems an investigator cross-references:
**VAHAN** (vehicle registration), **SARTHI** (driving licences),
**eGujCop/CCTNS** (police case records) and **AFIS/NAFIS** (fingerprints). This
platform has no access to any of them, and must never appear to.

So these tables hold a **local reference dataset**: fictional owners
("Reference Owner 017"), district-level addresses only, case numbers marked
`DEMO/` or `REF/`. They are loaded from `data/seed/registries/` and queried by
the reference adapters in `app/adapters/registries/`, behind the same
interface a live connector would implement. Every response built from them is
labelled `source: "reference"` — see `app/routers/registries.py`.

Not to be confused with `app/models/registry.py`, which is the *camera*
registry this platform owns.

**No biometric data, by construction.** `ref_afis_records` has no column that
could hold a fingerprint, a template or an image: it records only that a
record exists and the reference it exists under, which is all a platform like
this should ever learn from AFIS.
"""

from __future__ import annotations

import uuid
from datetime import date, datetime

from sqlalchemy import Boolean, Date, DateTime, Index, SmallInteger, String, Text, false, func
from sqlalchemy.dialects.postgresql import ARRAY, UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.db.session import Base


class ReferenceVehicle(Base):
    """One registration, shaped like a VAHAN RC record."""

    __tablename__ = "ref_vahan_vehicles"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    #: Normalised the way detections are (`normalise_plate`), so a lookup from
    #: a camera read and one typed by an officer meet on the same key.
    plate_normalised: Mapped[str] = mapped_column(String(24), unique=True, nullable=False)

    owner_name: Mapped[str] = mapped_column(String(120), nullable=False)
    #: District only. A reference dataset has no reason to hold a street.
    owner_district: Mapped[str] = mapped_column(String(64), nullable=False)
    owner_state: Mapped[str] = mapped_column(String(64), nullable=False)
    #: The registering RTO, e.g. "RTO Ahmedabad (GJ01)".
    registering_authority: Mapped[str] = mapped_column(String(120), nullable=False)
    registration_status: Mapped[str] = mapped_column(String(16), nullable=False)

    #: As VAHAN words it ("Motor Car (LMV)", "M-Cycle/Scooter (2WN)").
    vehicle_class: Mapped[str] = mapped_column(String(64), nullable=False)
    #: The class reduced to what a camera can tell apart: car, motorcycle,
    #: truck, bus, three_wheeler. The comparison with a sighting uses this.
    vehicle_category: Mapped[str] = mapped_column(String(16), nullable=False)
    maker: Mapped[str] = mapped_column(String(64), nullable=False)
    model: Mapped[str] = mapped_column(String(64), nullable=False)
    colour: Mapped[str] = mapped_column(String(32), nullable=False)
    fuel: Mapped[str] = mapped_column(String(24), nullable=False)
    manufacture_year: Mapped[int | None] = mapped_column(SmallInteger)

    registered_on: Mapped[date] = mapped_column(Date, nullable=False)
    registration_valid_until: Mapped[date] = mapped_column(Date, nullable=False)
    #: Transport vehicles only; NULL means not applicable, not unknown.
    fitness_valid_until: Mapped[date | None] = mapped_column(Date)
    #: NULL means no policy on record — which, for a vehicle on the road, is
    #: itself the finding.
    insurance_valid_until: Mapped[date | None] = mapped_column(Date)
    #: NULL for electric vehicles, which need no PUC certificate.
    puc_valid_until: Mapped[date | None] = mapped_column(Date)
    #: Transport vehicles only.
    permit_valid_until: Mapped[date | None] = mapped_column(Date)

    hypothecated: Mapped[bool] = mapped_column(
        Boolean, nullable=False, default=False, server_default=false()
    )
    financier: Mapped[str | None] = mapped_column(String(120))
    blacklisted: Mapped[bool] = mapped_column(
        Boolean, nullable=False, default=False, server_default=false()
    )
    blacklist_reason: Mapped[str | None] = mapped_column(Text)

    loaded_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )

    def __repr__(self) -> str:
        return f"<ReferenceVehicle {self.plate_normalised}>"


class ReferenceLicence(Base):
    """One driving licence, shaped like a SARTHI record."""

    __tablename__ = "ref_sarthi_licences"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    #: Separators stripped and uppercased: "GJ01 20150012345" and
    #: "GJ01-2015-0012345" are the same licence.
    licence_number: Mapped[str] = mapped_column(String(24), unique=True, nullable=False)
    holder_name: Mapped[str] = mapped_column(String(120), nullable=False)
    holder_district: Mapped[str] = mapped_column(String(64), nullable=False)
    holder_state: Mapped[str] = mapped_column(String(64), nullable=False)
    issuing_authority: Mapped[str] = mapped_column(String(120), nullable=False)
    issued_on: Mapped[date] = mapped_column(Date, nullable=False)
    non_transport_valid_until: Mapped[date | None] = mapped_column(Date)
    transport_valid_until: Mapped[date | None] = mapped_column(Date)
    #: Class-of-vehicle codes as printed on a licence: MCWG, LMV, TRANS, ...
    classes: Mapped[list[str]] = mapped_column(ARRAY(Text), nullable=False)
    status: Mapped[str] = mapped_column(String(16), nullable=False)
    status_reason: Mapped[str | None] = mapped_column(Text)

    loaded_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )

    def __repr__(self) -> str:
        return f"<ReferenceLicence {self.licence_number} {self.status}>"


class ReferenceFir(Base):
    """One FIR that names a vehicle, shaped like an eGujCop/CCTNS record."""

    __tablename__ = "ref_cctns_firs"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    fir_number: Mapped[str] = mapped_column(String(48), unique=True, nullable=False)
    police_station: Mapped[str] = mapped_column(String(120), nullable=False)
    district: Mapped[str] = mapped_column(String(64), nullable=False)
    state: Mapped[str] = mapped_column(String(64), nullable=False)
    registered_on: Mapped[date] = mapped_column(Date, nullable=False)
    #: Statute and section, e.g. "BNS 303(2)".
    sections: Mapped[list[str]] = mapped_column(ARRAY(Text), nullable=False)
    #: under_investigation · chargesheeted · closed · vehicle_recovered.
    status: Mapped[str] = mapped_column(String(24), nullable=False)
    linked_plate: Mapped[str] = mapped_column(String(24), nullable=False)
    #: What the vehicle is to the case: stolen, used_in_offence, accident.
    vehicle_role: Mapped[str] = mapped_column(String(24), nullable=False)
    summary: Mapped[str] = mapped_column(Text, nullable=False)

    loaded_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )

    __table_args__ = (Index("ix_ref_cctns_firs_linked_plate", "linked_plate"),)

    def __repr__(self) -> str:
        return f"<ReferenceFir {self.fir_number} {self.linked_plate}>"


class ReferenceAfisRecord(Base):
    """That a fingerprint record exists, and under which reference. Nothing more."""

    __tablename__ = "ref_afis_records"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    #: The case or person reference an investigator holds, uppercased.
    reference: Mapped[str] = mapped_column(String(64), nullable=False)
    afis_reference: Mapped[str] = mapped_column(String(48), unique=True, nullable=False)
    #: Set when the state record has been matched into the national system.
    nafis_reference: Mapped[str | None] = mapped_column(String(48))
    linked_fir_number: Mapped[str | None] = mapped_column(String(48))
    district: Mapped[str] = mapped_column(String(64), nullable=False)
    recorded_on: Mapped[date] = mapped_column(Date, nullable=False)

    loaded_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )

    __table_args__ = (
        Index("ix_ref_afis_records_reference", "reference"),
        Index("ix_ref_afis_records_linked_fir", "linked_fir_number"),
    )

    def __repr__(self) -> str:
        return f"<ReferenceAfisRecord {self.afis_reference}>"
