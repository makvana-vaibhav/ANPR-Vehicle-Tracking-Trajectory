"""External-registry lookups — the response contract.

Every response says where its answer came from, at the top, in two fields an
interface cannot miss: ``source`` ("reference" today, for every registry) and
``provenance``, a sentence to show beside the answer. ``sources`` breaks that
down per registry consulted, because one vehicle lookup reads two (VAHAN for
the registration, eGujCop/CCTNS for the FIRs).
"""

from __future__ import annotations

import uuid
from datetime import date, datetime
from typing import Literal

from pydantic import BaseModel, Field

SourceLabel = Literal["reference", "live", "mixed"]


class RegistrySource(BaseModel):
    registry: str = Field(description="The system, as an officer knows it: VAHAN, SARTHI, ...")
    answers: str
    source: Literal["reference", "live"]
    provenance: str


class DocumentOut(BaseModel):
    document: str
    label: str
    valid_until: date | None
    state: Literal["valid", "expiring", "expired", "not_on_record", "not_applicable"]
    days_remaining: int | None = Field(
        description="Days from today (IST) to the end of validity; negative once expired."
    )


class FlagOut(BaseModel):
    severity: Literal["critical", "high", "medium", "low"]
    code: str
    label: str
    detail: str = Field(description="Why, in words. A flag without its reason is a bug.")


class RegistrationOut(BaseModel):
    plate: str
    owner_name: str
    owner_district: str
    owner_state: str
    registering_authority: str
    registration_status: str
    vehicle_class: str
    vehicle_category: str
    maker: str
    model: str
    colour: str
    fuel: str
    manufacture_year: int | None
    registered_on: date
    documents: list[DocumentOut]
    hypothecated: bool
    financier: str | None
    blacklisted: bool
    blacklist_reason: str | None


class FirOut(BaseModel):
    fir_number: str
    police_station: str
    district: str
    state: str
    registered_on: date
    sections: list[str]
    status: str
    status_label: str
    open: bool
    vehicle_role: str
    vehicle_role_label: str
    summary: str


class SightingOut(BaseModel):
    """The sighting the registration was compared against."""

    detection_id: uuid.UUID
    seen_at: datetime
    camera_code: str | None
    camera_name: str | None
    vehicle_type: str | None
    vehicle_colour: str | None
    plate_confidence: float | None


class CheckOut(BaseModel):
    field: str
    label: str
    registered: str
    observed: str | None
    observed_source: str | None = Field(
        description="'sighting' when a camera's detection supplied it, 'officer' when typed."
    )
    outcome: Literal["match", "mismatch", "not_compared"]
    reason: str


class VehicleLookupOut(BaseModel):
    source: SourceLabel
    provenance: str
    sources: list[RegistrySource]
    query: str
    plate: str
    as_of: date = Field(description="The date (IST) validity was judged against.")
    queried_at: datetime
    found: bool = Field(description="Whether VAHAN holds a registration for the plate.")
    registration: RegistrationOut | None
    firs: list[FirOut]
    sighting: SightingOut | None
    checks: list[CheckOut]
    mismatch: bool = Field(description="Whether any check disagreed with what was seen.")
    flags: list[FlagOut]


class LicenceClassOut(BaseModel):
    code: str
    label: str


class LicenceOut(BaseModel):
    licence_number: str
    holder_name: str
    holder_district: str
    holder_state: str
    issuing_authority: str
    issued_on: date
    classes: list[LicenceClassOut]
    status: str
    status_reason: str | None
    documents: list[DocumentOut]


class LicenceLookupOut(BaseModel):
    source: SourceLabel
    provenance: str
    sources: list[RegistrySource]
    query: str
    as_of: date
    queried_at: datetime
    found: bool
    licence: LicenceOut | None
    flags: list[FlagOut]


class AfisRecordOut(BaseModel):
    """Existence and reference only. There is no field for biometric data."""

    reference: str
    afis_reference: str
    nafis_reference: str | None
    linked_fir_number: str | None
    district: str
    recorded_on: date


class AfisLookupOut(BaseModel):
    source: SourceLabel
    provenance: str
    sources: list[RegistrySource]
    query: str
    queried_at: datetime
    record_exists: bool
    records: list[AfisRecordOut]
