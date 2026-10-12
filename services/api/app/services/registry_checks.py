"""What a registry answer means for the officer reading it.

Three judgements are made here, all from the record itself and the date — no
score, no model:

* **Validity.** Each dated document (registration, fitness, insurance, PUC,
  permit; a licence's two validities) is valid, expiring within
  ``EXPIRING_WITHIN_DAYS``, expired, not on record, or not applicable to this
  kind of vehicle. Computed against today's date in IST on every request, so
  a document that lapses overnight reads as lapsed in the morning.
* **Agreement with the camera.** The registered vehicle is compared with what
  a camera saw carrying the plate — the sighting's vehicle class, and the
  colour and maker when they are known (from the pipeline, or typed by an
  officer looking at the evidence crop). A number plate on the wrong kind of
  vehicle is the classic sign of a cloned or swapped plate. The comparison is
  deliberately coarse: the detector's classes are COCO's, which call many SUVs
  a "truck", so only differences the detector can actually make — two wheels
  against four, a bus against a car — count as a mismatch.
* **Flags.** Everything above that needs a person, with a severity in the
  platform's language: a blacklist or an open FIR is critical, an expired
  document or a disagreement with the camera is high, a document expiring soon
  is low. Every flag carries its reason in words (CLAUDE.md §5).

A mismatch is reported as a disagreement between two records, never as a
verdict on the vehicle. The officer checks the crop.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import date, datetime
from typing import Literal
from zoneinfo import ZoneInfo

from app.adapters.registries.base import DrivingLicence, FirRecord, VehicleRegistration

IST = ZoneInfo("Asia/Kolkata")

#: A document this close to lapsing is called out before it does.
EXPIRING_WITHIN_DAYS = 30

DocumentState = Literal["valid", "expiring", "expired", "not_on_record", "not_applicable"]
Severity = Literal["critical", "high", "medium", "low"]
Outcome = Literal["match", "mismatch", "not_compared"]

_SEVERITY_ORDER: dict[str, int] = {"critical": 0, "high": 1, "medium": 2, "low": 3}

#: FIR statuses under which the case is still live.
OPEN_FIR_STATUSES = frozenset({"under_investigation", "chargesheeted"})

FIR_STATUS_WORDS = {
    "under_investigation": "under investigation",
    "chargesheeted": "chargesheet filed",
    "closed": "closed",
    "vehicle_recovered": "vehicle recovered",
}

VEHICLE_ROLE_WORDS = {
    "stolen": "reported stolen",
    "used_in_offence": "used in an offence",
    "accident": "involved in an accident",
}

#: Licence class codes as printed, and what they permit.
LICENCE_CLASS_WORDS = {
    "MCWOG": "Motorcycle without gear",
    "MCWG": "Motorcycle with gear",
    "LMV": "Light motor vehicle",
    "LMV-NT": "Light motor vehicle (non-transport)",
    "LMV-TR": "Light motor vehicle (transport)",
    "3W-TR": "Three-wheeler (transport)",
    "TRANS": "Transport vehicle (HGMV/HPMV)",
    "HGMV": "Heavy goods motor vehicle",
    "HPMV": "Heavy passenger motor vehicle",
}


def today_ist() -> date:
    return datetime.now(IST).date()


# ── Validity ──────────────────────────────────────────────────────────


@dataclass(frozen=True, slots=True)
class Document:
    document: str
    label: str
    valid_until: date | None
    state: DocumentState
    #: Negative once expired. None when there is no date to count to.
    days_remaining: int | None


def document_state(
    valid_until: date | None, today: date, *, applicable: bool = True
) -> tuple[DocumentState, int | None]:
    if not applicable:
        return "not_applicable", None
    if valid_until is None:
        return "not_on_record", None
    days = (valid_until - today).days
    if days < 0:
        return "expired", days
    if days < EXPIRING_WITHIN_DAYS:
        return "expiring", days
    return "valid", days


def _document(
    key: str, label: str, valid_until: date | None, today: date, *, applicable: bool = True
) -> Document:
    state, days = document_state(valid_until, today, applicable=applicable)
    return Document(key, label, valid_until, state, days)


#: Vehicle categories that carry goods or passengers for hire, and so need a
#: fitness certificate and a permit of their own.
TRANSPORT_CATEGORIES = frozenset({"truck", "bus", "three_wheeler"})


def vehicle_documents(reg: VehicleRegistration, today: date) -> list[Document]:
    transport = reg.vehicle_category in TRANSPORT_CATEGORIES or "cab" in reg.vehicle_class.lower()
    electric = "electric" in reg.fuel.lower()
    return [
        _document("registration", "Registration", reg.registration_valid_until, today),
        # A private vehicle's fitness is its registration; only a transport
        # vehicle carries a separate certificate. Absent where it applies, it
        # is "not on record", which is the finding.
        _document(
            "fitness",
            "Fitness certificate",
            reg.fitness_valid_until,
            today,
            applicable=transport or reg.fitness_valid_until is not None,
        ),
        _document("insurance", "Insurance", reg.insurance_valid_until, today),
        # Battery vehicles need no pollution certificate.
        _document("puc", "PUC certificate", reg.puc_valid_until, today, applicable=not electric),
        _document(
            "permit",
            "Permit",
            reg.permit_valid_until,
            today,
            applicable=transport or reg.permit_valid_until is not None,
        ),
    ]


def licence_documents(lic: DrivingLicence, today: date) -> list[Document]:
    transport_classes = {"LMV-TR", "3W-TR", "TRANS", "HGMV", "HPMV"}
    holds_transport = any(code in transport_classes for code in lic.classes)
    return [
        _document(
            "non_transport",
            "Non-transport validity",
            lic.non_transport_valid_until,
            today,
            applicable=lic.non_transport_valid_until is not None or not holds_transport,
        ),
        _document(
            "transport",
            "Transport validity",
            lic.transport_valid_until,
            today,
            applicable=holds_transport,
        ),
    ]


# ── Agreement with the camera ─────────────────────────────────────────


@dataclass(frozen=True, slots=True)
class Observation:
    """What was seen carrying the plate, field by field, with where each came from."""

    vehicle_type: str | None = None
    vehicle_type_source: str | None = None
    colour: str | None = None
    colour_source: str | None = None
    make: str | None = None
    make_source: str | None = None


@dataclass(frozen=True, slots=True)
class Check:
    field: str
    label: str
    registered: str
    observed: str | None
    observed_source: str | None
    outcome: Outcome
    reason: str


#: Which detector classes are consistent with each registered category. Broad
#: on purpose: COCO calls many SUVs and pickups "truck" and has no class for an
#: auto-rickshaw at all, so only a difference the detector can really make is
#: allowed to become a mismatch.
COMPATIBLE_CLASSES: dict[str, frozenset[str]] = {
    "car": frozenset({"car", "truck"}),
    "motorcycle": frozenset({"motorcycle", "bicycle"}),
    "truck": frozenset({"truck", "car", "bus"}),
    "bus": frozenset({"bus", "truck"}),
    "three_wheeler": frozenset({"car", "motorcycle", "truck"}),
}

CATEGORY_WORDS = {
    "car": "a car",
    "motorcycle": "a two-wheeler",
    "truck": "a goods vehicle",
    "bus": "a bus",
    "three_wheeler": "a three-wheeler",
}

DETECTED_WORDS = {
    "car": "a car",
    "motorcycle": "a two-wheeler",
    "bicycle": "a bicycle",
    "truck": "a truck or large SUV",
    "bus": "a bus",
}

#: Colour words reduced to families a camera can tell apart. Silver and grey
#: are one family: under daylight and compression they are not separable.
_COLOUR_FAMILIES: tuple[tuple[str, tuple[str, ...]], ...] = (
    ("white", ("white", "ivory", "pearl")),
    ("silver/grey", ("silver", "grey", "gray", "graphite", "steel")),
    ("black", ("black", "ebony")),
    ("red", ("red", "maroon", "wine", "burgundy", "cherry")),
    ("blue", ("blue", "navy", "aqua")),
    ("green", ("green", "olive")),
    ("yellow", ("yellow", "gold", "mustard")),
    ("orange", ("orange", "copper")),
    ("brown/beige", ("brown", "beige", "bronze", "champagne")),
)


def colour_family(colour: str) -> str | None:
    """The family a colour name belongs to.

    Manufacturers' names put the finish first and the hue last — "Pearl Siren
    Blue", "Golden Brown", "Solid Fire Red" — so the hue is the *last* word
    that names a colour. Reading left to right called a blue scooter white
    (for "Pearl") and a brown car yellow (for "Golden").
    """
    for word in reversed(_tokens(colour)):
        for family, terms in _COLOUR_FAMILIES:
            if any(term in word for term in terms):
                return family
    return None


#: Makers known by more than one name ("Maruti" for "Maruti Suzuki").
_MAKER_ALIASES: dict[str, tuple[str, ...]] = {
    "maruti suzuki": ("maruti", "suzuki"),
    "tata motors": ("tata",),
    "hero motocorp": ("hero",),
    "ashok leyland": ("leyland", "ashok"),
    "royal enfield": ("enfield", "royal enfield"),
    "mahindra": ("mahindra", "m&m"),
}


def _tokens(text: str) -> list[str]:
    """Lower-cased alphanumeric words, in order."""
    return "".join(c if c.isalnum() else " " for c in text.lower()).split()


def _words(text: str) -> set[str]:
    return set(_tokens(text))


def make_agrees(observed: str, maker: str, model: str) -> bool:
    """Whether a free-text make/model ("Swift", "Maruti", "Hyundai i20")
    names the registered vehicle. Any shared significant word counts."""
    registered = _words(f"{maker} {model}")
    for alias in _MAKER_ALIASES.get(maker.lower(), ()):
        registered |= _words(alias)
    seen = {w for w in _words(observed) if len(w) >= 3 or any(ch.isdigit() for ch in w)}
    return bool(seen & registered)


def compare(reg: VehicleRegistration, seen: Observation) -> list[Check]:
    checks: list[Check] = []

    # Vehicle class — the one attribute every sighting carries.
    registered_class = f"{reg.vehicle_class}"
    if seen.vehicle_type is None:
        checks.append(
            Check(
                "vehicle_class",
                "Vehicle class",
                registered_class,
                None,
                None,
                "not_compared",
                "No sighting of this plate to compare against.",
            )
        )
    else:
        allowed = COMPATIBLE_CLASSES.get(reg.vehicle_category)
        if allowed is None or seen.vehicle_type not in DETECTED_WORDS:
            checks.append(
                Check(
                    "vehicle_class",
                    "Vehicle class",
                    registered_class,
                    seen.vehicle_type,
                    seen.vehicle_type_source,
                    "not_compared",
                    "The detector's class cannot be compared with this registration.",
                )
            )
        elif seen.vehicle_type in allowed:
            checks.append(
                Check(
                    "vehicle_class",
                    "Vehicle class",
                    registered_class,
                    seen.vehicle_type,
                    seen.vehicle_type_source,
                    "match",
                    f"Registered as {CATEGORY_WORDS[reg.vehicle_category]}; "
                    f"seen as {DETECTED_WORDS[seen.vehicle_type]}.",
                )
            )
        else:
            checks.append(
                Check(
                    "vehicle_class",
                    "Vehicle class",
                    registered_class,
                    seen.vehicle_type,
                    seen.vehicle_type_source,
                    "mismatch",
                    # Source-neutral: the class may be the sighting's or an
                    # officer's reading of the crop, and `observed_source` says which.
                    f"Registered as {CATEGORY_WORDS[reg.vehicle_category]}, but "
                    f"{DETECTED_WORDS[seen.vehicle_type]} was seen carrying this plate. A "
                    "plate on the wrong kind of vehicle is how a cloned or swapped plate "
                    "shows itself — check the evidence crop.",
                )
            )

    # Colour — only when someone or something actually saw one.
    if seen.colour is None:
        checks.append(
            Check(
                "colour",
                "Colour",
                reg.colour,
                None,
                None,
                "not_compared",
                "No colour observed: the pipeline does not yet measure one, "
                "and none was entered.",
            )
        )
    else:
        registered_family = colour_family(reg.colour)
        seen_family = colour_family(seen.colour)
        if registered_family is None or seen_family is None:
            checks.append(
                Check(
                    "colour",
                    "Colour",
                    reg.colour,
                    seen.colour,
                    seen.colour_source,
                    "not_compared",
                    f"'{seen.colour if seen_family is None else reg.colour}' is not a "
                    "colour this check recognises.",
                )
            )
        elif registered_family == seen_family:
            checks.append(
                Check(
                    "colour",
                    "Colour",
                    reg.colour,
                    seen.colour,
                    seen.colour_source,
                    "match",
                    f"Both {registered_family}.",
                )
            )
        else:
            checks.append(
                Check(
                    "colour",
                    "Colour",
                    reg.colour,
                    seen.colour,
                    seen.colour_source,
                    "mismatch",
                    f"Registered {registered_family}, seen {seen_family}. A repaint must "
                    "be endorsed on the registration; an unendorsed one, or a plate moved "
                    "to another vehicle, reads exactly like this.",
                )
            )

    # Maker — no model on the platform recognises makes, so only an officer's
    # reading of the crop can supply one.
    registered_make = f"{reg.maker} {reg.model}"
    if seen.make is None:
        checks.append(
            Check(
                "maker",
                "Maker and model",
                registered_make,
                None,
                None,
                "not_compared",
                "No make observed: nothing on the platform recognises makes, "
                "and none was entered.",
            )
        )
    elif make_agrees(seen.make, reg.maker, reg.model):
        checks.append(
            Check(
                "maker",
                "Maker and model",
                registered_make,
                seen.make,
                seen.make_source,
                "match",
                f"'{seen.make}' names the registered {reg.maker}.",
            )
        )
    else:
        checks.append(
            Check(
                "maker",
                "Maker and model",
                registered_make,
                seen.make,
                seen.make_source,
                "mismatch",
                f"Registered as a {registered_make}; seen as '{seen.make}'. A plate on "
                "a different make of vehicle is the commonest sign of a cloned plate.",
            )
        )
    return checks


# ── Flags ─────────────────────────────────────────────────────────────


@dataclass(frozen=True, slots=True)
class Flag:
    severity: Severity
    code: str
    label: str
    detail: str


def _when(day: date) -> str:
    return f"{day.day} {day:%b %Y}"


def _document_flags(documents: list[Document], subject: str) -> list[Flag]:
    flags: list[Flag] = []
    for doc in documents:
        if doc.state == "expired" and doc.valid_until is not None:
            ago = -(doc.days_remaining or 0)
            flags.append(
                Flag(
                    "high",
                    f"{doc.document}_expired",
                    f"{doc.label} expired",
                    f"Lapsed {_when(doc.valid_until)}, {ago} day{'s' if ago != 1 else ''} ago.",
                )
            )
        elif doc.state == "not_on_record":
            flags.append(
                Flag(
                    "high",
                    f"{doc.document}_missing",
                    f"No {doc.label.lower()} on record",
                    f"The {subject} holds no {doc.label.lower()} for this record.",
                )
            )
        elif doc.state == "expiring" and doc.valid_until is not None:
            left = doc.days_remaining or 0
            flags.append(
                Flag(
                    "low",
                    f"{doc.document}_expiring",
                    f"{doc.label} expiring",
                    f"Valid until {_when(doc.valid_until)} — "
                    f"{left} day{'s' if left != 1 else ''} left.",
                )
            )
    return flags


def fir_is_open(fir: FirRecord) -> bool:
    return fir.status in OPEN_FIR_STATUSES


def vehicle_flags(
    reg: VehicleRegistration | None,
    documents: list[Document],
    firs: list[FirRecord],
    checks: list[Check],
) -> list[Flag]:
    flags: list[Flag] = []
    for fir in firs:
        role = VEHICLE_ROLE_WORDS.get(fir.vehicle_role, fir.vehicle_role)
        status = FIR_STATUS_WORDS.get(fir.status, fir.status)
        if fir_is_open(fir):
            flags.append(
                Flag(
                    "critical",
                    "fir_linked",
                    "FIR-linked",
                    f"FIR {fir.fir_number}, {fir.police_station}: vehicle {role}; {status}.",
                )
            )
        else:
            flags.append(
                Flag(
                    "low",
                    "fir_closed",
                    "Past FIR",
                    f"FIR {fir.fir_number}, {fir.police_station}: vehicle {role}; {status}.",
                )
            )
    if reg is not None:
        if reg.blacklisted:
            flags.append(
                Flag(
                    "critical",
                    "blacklisted",
                    "Blacklisted",
                    reg.blacklist_reason or "Blacklisted by the registering authority.",
                )
            )
        if reg.registration_status.lower() != "active":
            flags.append(
                Flag(
                    "high",
                    "registration_status",
                    f"Registration {reg.registration_status.lower()}",
                    f"The registering authority records this registration as "
                    f"{reg.registration_status.lower()}.",
                )
            )
        flags.extend(_document_flags(documents, "VAHAN record"))
        for check in checks:
            if check.outcome == "mismatch":
                flags.append(
                    Flag(
                        "high",
                        f"mismatch_{check.field}",
                        f"{check.label} does not match what was seen",
                        check.reason,
                    )
                )
    return sorted(flags, key=lambda f: _SEVERITY_ORDER[f.severity])


def licence_flags(lic: DrivingLicence, documents: list[Document]) -> list[Flag]:
    flags: list[Flag] = []
    status = lic.status.lower()
    if status != "active":
        flags.append(
            Flag(
                "critical",
                f"licence_{status}",
                f"Licence {status}",
                lic.status_reason or f"SARTHI records this licence as {status}.",
            )
        )
    flags.extend(_document_flags(documents, "SARTHI record"))
    return sorted(flags, key=lambda f: _SEVERITY_ORDER[f.severity])
