"""The external-registry contract.

The camera adapters (`app/adapters/base.py`) reduce every vendor's recorder to
one interface so the platform never knows which vendor it is talking to. This
does the same for the government registries an investigator cross-references
a sighting against:

| Registry        | Answers                        | Looked up by          |
|-----------------|--------------------------------|-----------------------|
| VAHAN           | vehicle registration           | plate                 |
| SARTHI          | driving licence                | licence number        |
| eGujCop/CCTNS   | FIRs that name a vehicle       | plate                 |
| AFIS/NAFIS      | whether a fingerprint record exists, and its reference | case or person reference |

Each answer is a list of plain records defined here, independent of where they
came from. A live connector to the real system would subclass the same
abstract class, return the same records, and declare ``source = "live"``; the
router, the checks and the screen would not change. Today every
implementation is a **reference** adapter over a local, fictional dataset
(`app/adapters/registries/reference.py`), and says so.

**Provenance travels with the adapter, not the caller.** ``source`` and
``provenance`` are class attributes of the implementation, and the API copies
them into every response. Nothing downstream can label a reference answer as
live, because nothing downstream chooses the label.

**AFIS returns existence and a reference, never biometric data.** The record
type below has no field that could carry a print, a template or an image, so
no adapter — reference or live — can hand one to this platform.
"""

from __future__ import annotations

import abc
from dataclasses import dataclass
from datetime import date
from typing import ClassVar, Generic, Literal, TypeVar

#: Where an answer came from. "reference" is the local stand-in dataset;
#: "live" would be a connection to the real system, of which there are none.
SourceKind = Literal["reference", "live"]

RecordT = TypeVar("RecordT")


# ── Records ───────────────────────────────────────────────────────────


@dataclass(frozen=True, slots=True)
class VehicleRegistration:
    """A registration certificate's worth of facts about one plate."""

    plate: str
    owner_name: str
    owner_district: str
    owner_state: str
    registering_authority: str
    registration_status: str
    vehicle_class: str
    #: car · motorcycle · truck · bus · three_wheeler — what a camera can
    #: tell apart, which is what a sighting is compared against.
    vehicle_category: str
    maker: str
    model: str
    colour: str
    fuel: str
    manufacture_year: int | None
    registered_on: date
    registration_valid_until: date
    fitness_valid_until: date | None
    insurance_valid_until: date | None
    puc_valid_until: date | None
    permit_valid_until: date | None
    hypothecated: bool
    financier: str | None
    blacklisted: bool
    blacklist_reason: str | None


@dataclass(frozen=True, slots=True)
class DrivingLicence:
    licence_number: str
    holder_name: str
    holder_district: str
    holder_state: str
    issuing_authority: str
    issued_on: date
    non_transport_valid_until: date | None
    transport_valid_until: date | None
    classes: tuple[str, ...]
    status: str
    status_reason: str | None


@dataclass(frozen=True, slots=True)
class FirRecord:
    fir_number: str
    police_station: str
    district: str
    state: str
    registered_on: date
    sections: tuple[str, ...]
    status: str
    linked_plate: str
    vehicle_role: str
    summary: str


@dataclass(frozen=True, slots=True)
class FingerprintRecordRef:
    """That a record exists, under which reference — and nothing else."""

    reference: str
    afis_reference: str
    nafis_reference: str | None
    linked_fir_number: str | None
    district: str
    recorded_on: date


# ── The interface ─────────────────────────────────────────────────────


class RegistryError(Exception):
    """The registry could not answer — as distinct from answering "no record"."""


class RegistryAdapter(abc.ABC, Generic[RecordT]):
    """One external registry, reduced to a keyed lookup.

    ``lookup`` returns every record the registry holds for the key, which is
    an empty list when it holds none. "No record" is an answer, and the API
    reports it as one; a registry that cannot be reached raises
    ``RegistryError`` instead, so the two can never be confused.
    """

    #: Short, stable identifier for URLs and audit rows: "vahan".
    key: ClassVar[str]
    #: The system's own name, as an officer knows it: "VAHAN".
    registry: ClassVar[str]
    #: What it answers, in a few words: "Vehicle registration".
    answers: ClassVar[str]
    #: Set by the implementation, never by a caller.
    source: ClassVar[SourceKind]
    #: One sentence shown beside every answer: where it came from.
    provenance: ClassVar[str]

    @abc.abstractmethod
    def normalise(self, raw: str) -> str:
        """The key as this registry stores it."""

    @abc.abstractmethod
    async def lookup(self, key: str) -> list[RecordT]:
        """Every record for an already-normalised key."""

    def __repr__(self) -> str:
        return f"<{type(self).__name__} {self.registry} source={self.source}>"


class VehicleRegistry(RegistryAdapter[VehicleRegistration]):
    """VAHAN: registration by plate. At most one record per plate."""

    key = "vahan"
    registry = "VAHAN"
    answers = "Vehicle registration"


class LicenceRegistry(RegistryAdapter[DrivingLicence]):
    """SARTHI: a driving licence by its number."""

    key = "sarthi"
    registry = "SARTHI"
    answers = "Driving licence"


class CaseRegistry(RegistryAdapter[FirRecord]):
    """eGujCop/CCTNS: FIRs that name a plate."""

    key = "egujcop"
    registry = "eGujCop/CCTNS"
    answers = "FIRs naming the vehicle"


class FingerprintRegistry(RegistryAdapter[FingerprintRecordRef]):
    """AFIS/NAFIS: whether a record exists under a case or person reference."""

    key = "afis"
    registry = "AFIS/NAFIS"
    answers = "Fingerprint record existence"


@dataclass(frozen=True, slots=True)
class Registries:
    """The four registries one request can consult."""

    vahan: VehicleRegistry
    sarthi: LicenceRegistry
    cctns: CaseRegistry
    afis: FingerprintRegistry
