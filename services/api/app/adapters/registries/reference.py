"""Reference adapters: the registry interface over the local, fictional dataset.

These are real adapters — they run real queries against real tables
(migration 0010) — over data that is labelled for what it is. The rows are
loaded from `data/seed/registries/` by `scripts/seed.py`; every owner is
"Reference Owner NNN", every address is a district, every case number starts
`DEMO/` or `REF/`. The plates were chosen at least three characters from every
plate the cameras had read when the dataset was generated, so a fictional
record never lands on a real vehicle the network has seen
(`scripts/generate_registry_reference.py`).

Each class declares ``source = "reference"`` and its own provenance sentence,
and the API copies both into every response it builds from them.
"""

from __future__ import annotations

from collections.abc import Iterator
from contextlib import contextmanager

from sqlalchemy import or_, select
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.ext.asyncio import AsyncSession

from app.adapters.registries.base import (
    CaseRegistry,
    DrivingLicence,
    FingerprintRecordRef,
    FingerprintRegistry,
    FirRecord,
    LicenceRegistry,
    RegistryError,
    VehicleRegistration,
    VehicleRegistry,
)
from app.models.external_registry import (
    ReferenceAfisRecord,
    ReferenceFir,
    ReferenceLicence,
    ReferenceVehicle,
)
from app.schemas.intelligence import normalise_plate

#: Upper bound on records returned for one key. A plate named in more FIRs
#: than this is not a case the reference dataset contains; the bound is here
#: so no lookup is ever an unbounded read.
MAX_RECORDS = 50

_DATASET = "a fictional local dataset (data/seed/registries) standing in for"


def _alnum(raw: str) -> str:
    return "".join(ch for ch in raw.upper() if ch.isalnum())


@contextmanager
def _answering(registry: str) -> Iterator[None]:
    """A database failure is "the registry could not answer", never "no record".

    The commonest cause is a database that has not had migration 0010 applied,
    and an officer told "no record" for a plate that is on file would be worse
    off than one told the lookup failed.
    """
    try:
        yield
    except SQLAlchemyError as exc:
        raise RegistryError(f"The {registry} reference dataset could not be read.") from exc


class ReferenceVahanAdapter(VehicleRegistry):
    source = "reference"
    provenance = (
        f"Reference data — not a live VAHAN query. {_DATASET.capitalize()} the "
        "national vehicle register, which this platform has no access to."
    )

    def __init__(self, session: AsyncSession) -> None:
        self.session = session

    def normalise(self, raw: str) -> str:
        return normalise_plate(raw)

    async def lookup(self, key: str) -> list[VehicleRegistration]:
        with _answering(self.registry):
            row = await self.session.scalar(
                select(ReferenceVehicle).where(ReferenceVehicle.plate_normalised == key)
            )
            if row is None:
                return []
            return [
                VehicleRegistration(
                    plate=row.plate_normalised,
                    owner_name=row.owner_name,
                    owner_district=row.owner_district,
                    owner_state=row.owner_state,
                    registering_authority=row.registering_authority,
                    registration_status=row.registration_status,
                    vehicle_class=row.vehicle_class,
                    vehicle_category=row.vehicle_category,
                    maker=row.maker,
                    model=row.model,
                    colour=row.colour,
                    fuel=row.fuel,
                    manufacture_year=row.manufacture_year,
                    registered_on=row.registered_on,
                    registration_valid_until=row.registration_valid_until,
                    fitness_valid_until=row.fitness_valid_until,
                    insurance_valid_until=row.insurance_valid_until,
                    puc_valid_until=row.puc_valid_until,
                    permit_valid_until=row.permit_valid_until,
                    hypothecated=row.hypothecated,
                    financier=row.financier,
                    blacklisted=row.blacklisted,
                    blacklist_reason=row.blacklist_reason,
                )
            ]


class ReferenceSarthiAdapter(LicenceRegistry):
    source = "reference"
    provenance = (
        f"Reference data — not a live SARTHI query. {_DATASET.capitalize()} the "
        "national driving-licence register, which this platform has no access to."
    )

    def __init__(self, session: AsyncSession) -> None:
        self.session = session

    def normalise(self, raw: str) -> str:
        return _alnum(raw)

    async def lookup(self, key: str) -> list[DrivingLicence]:
        with _answering(self.registry):
            row = await self.session.scalar(
                select(ReferenceLicence).where(ReferenceLicence.licence_number == key)
            )
            if row is None:
                return []
            return [
                DrivingLicence(
                    licence_number=row.licence_number,
                    holder_name=row.holder_name,
                    holder_district=row.holder_district,
                    holder_state=row.holder_state,
                    issuing_authority=row.issuing_authority,
                    issued_on=row.issued_on,
                    non_transport_valid_until=row.non_transport_valid_until,
                    transport_valid_until=row.transport_valid_until,
                    classes=tuple(row.classes),
                    status=row.status,
                    status_reason=row.status_reason,
                )
            ]


class ReferenceEGujCopAdapter(CaseRegistry):
    source = "reference"
    provenance = (
        f"Reference data — not a live eGujCop/CCTNS query. {_DATASET.capitalize()} "
        "police case records, which this platform has no access to."
    )

    def __init__(self, session: AsyncSession) -> None:
        self.session = session

    def normalise(self, raw: str) -> str:
        return normalise_plate(raw)

    async def lookup(self, key: str) -> list[FirRecord]:
        with _answering(self.registry):
            rows = (
                await self.session.scalars(
                    select(ReferenceFir)
                    .where(ReferenceFir.linked_plate == key)
                    .order_by(ReferenceFir.registered_on.desc(), ReferenceFir.fir_number)
                    .limit(MAX_RECORDS)
                )
            ).all()
            return [
                FirRecord(
                    fir_number=row.fir_number,
                    police_station=row.police_station,
                    district=row.district,
                    state=row.state,
                    registered_on=row.registered_on,
                    sections=tuple(row.sections),
                    status=row.status,
                    linked_plate=row.linked_plate,
                    vehicle_role=row.vehicle_role,
                    summary=row.summary,
                )
                for row in rows
            ]


class ReferenceAfisAdapter(FingerprintRegistry):
    source = "reference"
    provenance = (
        f"Reference data — not a live AFIS/NAFIS query. {_DATASET.capitalize()} "
        "fingerprint bureaux. Existence and reference only: no biometric data is "
        "held or returned."
    )

    def __init__(self, session: AsyncSession) -> None:
        self.session = session

    def normalise(self, raw: str) -> str:
        # Case and person references carry their slashes ("DEMO/FIR/2026/
        # RJT/0412"); only case and surrounding space are not significant.
        return " ".join(raw.upper().split())

    async def lookup(self, key: str) -> list[FingerprintRecordRef]:
        with _answering(self.registry):
            # A case is known by its FIR number as often as by its own reference,
            # so either finds the records filed against it.
            rows = (
                await self.session.scalars(
                    select(ReferenceAfisRecord)
                    .where(
                        or_(
                            ReferenceAfisRecord.reference == key,
                            ReferenceAfisRecord.linked_fir_number == key,
                        )
                    )
                    .order_by(ReferenceAfisRecord.recorded_on.desc())
                    .limit(MAX_RECORDS)
                )
            ).all()
            return [
                FingerprintRecordRef(
                    reference=row.reference,
                    afis_reference=row.afis_reference,
                    nafis_reference=row.nafis_reference,
                    linked_fir_number=row.linked_fir_number,
                    district=row.district,
                    recorded_on=row.recorded_on,
                )
                for row in rows
            ]
