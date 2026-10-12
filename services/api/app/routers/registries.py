"""External-registry lookups: VAHAN, eGujCop/CCTNS, SARTHI, AFIS/NAFIS.

An officer looking at a plate read wants the next question answered without
leaving the screen: *whose vehicle is this, is it what the camera saw, is
anything on file against it?* These endpoints answer it from the registry
adapters (`app/adapters/registries/`).

Three rules hold for every endpoint here:

* **Provenance is in the answer.** Every response carries ``source`` and a
  ``provenance`` sentence copied from the adapter that answered — today
  ``"reference"`` and "Reference data — not a live VAHAN query" for all four,
  because this platform has no access to the real systems and must never
  look as if it does.
* **Every lookup is audited**, found or not, failed or not, with the key
  looked up and an optional case reference. Reading a person's registration
  is the same kind of act as searching their plate (CLAUDE.md §5).
* **"No record" is an answer, "could not ask" is an error.** A lookup that
  finds nothing returns 200 with ``found: false``; a registry that cannot be
  read returns 502.

Permission is ``search.execute``: the same grant that lets a role follow a
vehicle lets it look the vehicle up.
"""

from __future__ import annotations

import uuid
from collections.abc import Sequence
from datetime import UTC, datetime
from typing import Annotated, Any

from fastapi import APIRouter, Depends, HTTPException, Query, Request, status
from sqlalchemy import select

from app.adapters.registries import (
    Registries,
    RegistryAdapter,
    RegistryError,
    VehicleRegistration,
    registries_for,
)
from app.api.deps import CurrentUser, DbSession
from app.core.logging import get_logger
from app.core.rbac import Permission, require_permission
from app.models.enums import AuditResult
from app.models.intelligence import Detection
from app.models.registry import Camera
from app.schemas.registries import (
    AfisLookupOut,
    AfisRecordOut,
    CheckOut,
    DocumentOut,
    FirOut,
    FlagOut,
    LicenceClassOut,
    LicenceLookupOut,
    LicenceOut,
    RegistrationOut,
    RegistrySource,
    SightingOut,
    SourceLabel,
    VehicleLookupOut,
)
from app.services import audit, registry_checks
from app.services.registry_checks import (
    DETECTED_WORDS,
    FIR_STATUS_WORDS,
    LICENCE_CLASS_WORDS,
    VEHICLE_ROLE_WORDS,
    Check,
    Document,
    Flag,
    Observation,
)

log = get_logger("api.registries")

router = APIRouter(prefix="/api/v1/registries", tags=["external registries"])


async def get_registries(session: DbSession) -> Registries:
    """The registry implementations for this request.

    A dependency rather than a call inside each endpoint so a deployment — or
    a test — can put a different implementation behind the same endpoints
    without touching them.
    """
    return registries_for(session)


RegistriesDep = Annotated[Registries, Depends(get_registries)]
SearchUser = Annotated[CurrentUser, Depends(require_permission(Permission.SEARCH_EXECUTE))]
CaseRef = Annotated[
    str | None,
    Query(
        max_length=64,
        description="The case this lookup is for. Recorded in the audit trail.",
    ),
]


# ── Provenance ────────────────────────────────────────────────────────


def _sources(adapters: Sequence[RegistryAdapter[Any]]) -> list[RegistrySource]:
    return [
        RegistrySource(
            registry=a.registry, answers=a.answers, source=a.source, provenance=a.provenance
        )
        for a in adapters
    ]


def _source_label(adapters: Sequence[RegistryAdapter[Any]]) -> SourceLabel:
    kinds = {a.source for a in adapters}
    if kinds == {"reference"}:
        return "reference"
    if kinds == {"live"}:
        return "live"
    return "mixed"


def _provenance(adapters: Sequence[RegistryAdapter[Any]]) -> str:
    if len(adapters) == 1:
        return adapters[0].provenance
    if all(a.source == "reference" for a in adapters):
        names = " or ".join(a.registry for a in adapters)
        return (
            f"Reference data — not a live {names} query. A fictional local dataset "
            "(data/seed/registries) standing in for systems this platform has no access to."
        )
    return " ".join(f"{a.registry}: {a.provenance}" for a in adapters)


# ── Shaping ───────────────────────────────────────────────────────────


def _documents(documents: list[Document]) -> list[DocumentOut]:
    return [
        DocumentOut(
            document=d.document,
            label=d.label,
            valid_until=d.valid_until,
            state=d.state,
            days_remaining=d.days_remaining,
        )
        for d in documents
    ]


def _flags(flags: list[Flag]) -> list[FlagOut]:
    return [
        FlagOut(severity=f.severity, code=f.code, label=f.label, detail=f.detail) for f in flags
    ]


def _checks(checks: list[Check]) -> list[CheckOut]:
    return [
        CheckOut(
            field=c.field,
            label=c.label,
            registered=c.registered,
            observed=c.observed,
            observed_source=c.observed_source,
            outcome=c.outcome,
            reason=c.reason,
        )
        for c in checks
    ]


def _registration(reg: VehicleRegistration, documents: list[Document]) -> RegistrationOut:
    return RegistrationOut(
        plate=reg.plate,
        owner_name=reg.owner_name,
        owner_district=reg.owner_district,
        owner_state=reg.owner_state,
        registering_authority=reg.registering_authority,
        registration_status=reg.registration_status,
        vehicle_class=reg.vehicle_class,
        vehicle_category=reg.vehicle_category,
        maker=reg.maker,
        model=reg.model,
        colour=reg.colour,
        fuel=reg.fuel,
        manufacture_year=reg.manufacture_year,
        registered_on=reg.registered_on,
        documents=_documents(documents),
        hypothecated=reg.hypothecated,
        financier=reg.financier,
        blacklisted=reg.blacklisted,
        blacklist_reason=reg.blacklist_reason,
    )


async def _registry_failed(
    *,
    exc: RegistryError,
    action: str,
    key: str,
    user: CurrentUser,
    request: Request,
    case_ref: str | None,
) -> HTTPException:
    log.error("registries.lookup_failed", action=action, key=key, error=str(exc), exc_info=True)
    await audit.record(
        action=action,
        user=user,
        request=request,
        resource_type="registry",
        resource_id=key,
        params={"query": key, "case_ref": case_ref, "error": str(exc)},
        result=AuditResult.ERROR,
    )
    return HTTPException(status_code=status.HTTP_502_BAD_GATEWAY, detail=str(exc))


# ── Vehicle: VAHAN + eGujCop/CCTNS ────────────────────────────────────


async def _sighting(
    session: DbSession, plate: str, detection_id: uuid.UUID | None
) -> SightingOut | None:
    """The sighting to compare against: the one named, else the latest of the plate."""
    query = (
        select(Detection, Camera.camera_code, Camera.name)
        .outerjoin(Camera, Camera.id == Detection.camera_id)
        .limit(1)
    )
    if detection_id is not None:
        row = (await session.execute(query.where(Detection.id == detection_id))).first()
        if row is None:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND, detail="No sighting with that id."
            )
        if row[0].plate_normalised != plate:
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                detail=(
                    f"That sighting read {row[0].plate_normalised or 'no plate'}, not {plate}; "
                    "a registration is only compared with a sighting of its own plate."
                ),
            )
    else:
        row = (
            await session.execute(
                query.where(
                    Detection.plate_normalised == plate,
                    Detection.vehicle_type.in_(tuple(DETECTED_WORDS)),
                ).order_by(Detection.ts.desc())
            )
        ).first()
        if row is None:
            return None
    detection, camera_code, camera_name = row
    return SightingOut(
        detection_id=detection.id,
        seen_at=detection.ts,
        camera_code=camera_code,
        camera_name=camera_name,
        vehicle_type=detection.vehicle_type,
        vehicle_colour=detection.vehicle_colour,
        plate_confidence=detection.plate_confidence,
    )


def _observation(
    sighting: SightingOut | None,
    observed_type: str | None,
    observed_colour: str | None,
    observed_make: str | None,
) -> Observation:
    """Field by field: what an officer typed wins over what the sighting says,
    and each value keeps where it came from."""
    seen_type = sighting.vehicle_type if sighting else None
    seen_colour = sighting.vehicle_colour if sighting else None
    return Observation(
        vehicle_type=observed_type or seen_type,
        vehicle_type_source="officer" if observed_type else ("sighting" if seen_type else None),
        colour=observed_colour or seen_colour,
        colour_source="officer" if observed_colour else ("sighting" if seen_colour else None),
        make=observed_make,
        make_source="officer" if observed_make else None,
    )


@router.get(
    "/vehicle/{plate}",
    response_model=VehicleLookupOut,
    summary="Registration (VAHAN) and FIRs (eGujCop/CCTNS) for a plate",
)
async def vehicle_lookup(
    plate: str,
    request: Request,
    session: DbSession,
    registries: RegistriesDep,
    user: SearchUser,
    detection_id: Annotated[
        uuid.UUID | None,
        Query(description="Compare against this sighting rather than the plate's latest."),
    ] = None,
    observed_type: Annotated[
        str | None,
        Query(description="Vehicle class an officer saw: car, motorcycle, truck, bus, bicycle."),
    ] = None,
    observed_colour: Annotated[
        str | None, Query(max_length=32, description="Colour an officer saw in the crop.")
    ] = None,
    observed_make: Annotated[
        str | None, Query(max_length=64, description="Make or model an officer saw.")
    ] = None,
    case_ref: CaseRef = None,
) -> VehicleLookupOut:
    """Who the plate is registered to, whether its documents are in force,
    whether any FIR names it — and whether the registered vehicle is the one
    a camera saw carrying it.

    The comparison uses the named sighting, else the plate's latest sighting,
    with anything an officer typed taking precedence field by field.
    """
    vahan, cctns = registries.vahan, registries.cctns
    key = vahan.normalise(plate)
    if len(key) < 4:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="A plate needs at least four alphanumeric characters to look up.",
        )
    observed_type = (observed_type or "").strip().lower() or None
    if observed_type is not None and observed_type not in DETECTED_WORDS:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=f"observed_type must be one of: {', '.join(DETECTED_WORDS)}.",
        )
    observed_colour = (observed_colour or "").strip() or None
    observed_make = (observed_make or "").strip() or None

    sighting = await _sighting(session, key, detection_id)
    try:
        registrations = await vahan.lookup(key)
        firs = await cctns.lookup(cctns.normalise(plate))
    except RegistryError as exc:
        raise await _registry_failed(
            exc=exc,
            action="registry.vehicle",
            key=key,
            user=user,
            request=request,
            case_ref=case_ref,
        ) from exc

    today = registry_checks.today_ist()
    reg = registrations[0] if registrations else None
    documents = registry_checks.vehicle_documents(reg, today) if reg else []
    checks = (
        registry_checks.compare(
            reg, _observation(sighting, observed_type, observed_colour, observed_make)
        )
        if reg
        else []
    )
    flags = registry_checks.vehicle_flags(reg, documents, firs, checks)
    adapters: list[RegistryAdapter[Any]] = [vahan, cctns]

    await audit.record(
        action="registry.vehicle",
        user=user,
        request=request,
        resource_type="registry",
        resource_id=key,
        params={
            "query": key,
            "registries": [a.registry for a in adapters],
            "source": _source_label(adapters),
            "found": reg is not None,
            "firs": len(firs),
            "case_ref": case_ref,
            "detection_id": str(sighting.detection_id) if sighting else None,
            "observed": {
                "type": observed_type,
                "colour": observed_colour,
                "make": observed_make,
            },
        },
    )

    return VehicleLookupOut(
        source=_source_label(adapters),
        provenance=_provenance(adapters),
        sources=_sources(adapters),
        query=plate,
        plate=key,
        as_of=today,
        queried_at=datetime.now(UTC),
        found=reg is not None,
        registration=_registration(reg, documents) if reg else None,
        firs=[
            FirOut(
                fir_number=f.fir_number,
                police_station=f.police_station,
                district=f.district,
                state=f.state,
                registered_on=f.registered_on,
                sections=list(f.sections),
                status=f.status,
                status_label=FIR_STATUS_WORDS.get(f.status, f.status),
                open=registry_checks.fir_is_open(f),
                vehicle_role=f.vehicle_role,
                vehicle_role_label=VEHICLE_ROLE_WORDS.get(f.vehicle_role, f.vehicle_role),
                summary=f.summary,
            )
            for f in firs
        ],
        sighting=sighting,
        checks=_checks(checks),
        mismatch=any(c.outcome == "mismatch" for c in checks),
        flags=_flags(flags),
    )


# ── Licence: SARTHI ───────────────────────────────────────────────────


@router.get(
    "/licence/{number}",
    response_model=LicenceLookupOut,
    summary="A driving licence (SARTHI) by its number",
)
async def licence_lookup(
    number: str,
    request: Request,
    registries: RegistriesDep,
    user: SearchUser,
    case_ref: CaseRef = None,
) -> LicenceLookupOut:
    """The holder, the classes the licence permits, and whether it is in force."""
    sarthi = registries.sarthi
    key = sarthi.normalise(number)
    if len(key) < 6:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="A licence number needs at least six alphanumeric characters.",
        )
    try:
        licences = await sarthi.lookup(key)
    except RegistryError as exc:
        raise await _registry_failed(
            exc=exc,
            action="registry.licence",
            key=key,
            user=user,
            request=request,
            case_ref=case_ref,
        ) from exc

    today = registry_checks.today_ist()
    lic = licences[0] if licences else None
    documents = registry_checks.licence_documents(lic, today) if lic else []
    flags = registry_checks.licence_flags(lic, documents) if lic else []

    await audit.record(
        action="registry.licence",
        user=user,
        request=request,
        resource_type="registry",
        resource_id=key,
        params={
            "query": key,
            "registries": [sarthi.registry],
            "source": sarthi.source,
            "found": lic is not None,
            "case_ref": case_ref,
        },
    )

    return LicenceLookupOut(
        source=_source_label([sarthi]),
        provenance=_provenance([sarthi]),
        sources=_sources([sarthi]),
        query=number,
        as_of=today,
        queried_at=datetime.now(UTC),
        found=lic is not None,
        licence=(
            LicenceOut(
                licence_number=lic.licence_number,
                holder_name=lic.holder_name,
                holder_district=lic.holder_district,
                holder_state=lic.holder_state,
                issuing_authority=lic.issuing_authority,
                issued_on=lic.issued_on,
                classes=[
                    LicenceClassOut(code=code, label=LICENCE_CLASS_WORDS.get(code, code))
                    for code in lic.classes
                ],
                status=lic.status,
                status_reason=lic.status_reason,
                documents=_documents(documents),
            )
            if lic
            else None
        ),
        flags=_flags(flags),
    )


# ── Fingerprints: AFIS/NAFIS ──────────────────────────────────────────


@router.get(
    "/afis/{reference:path}",
    response_model=AfisLookupOut,
    summary="Whether a fingerprint record exists for a case or person reference",
)
async def afis_lookup(
    reference: str,
    request: Request,
    registries: RegistriesDep,
    user: SearchUser,
    case_ref: CaseRef = None,
) -> AfisLookupOut:
    """Existence and reference only — never biometric data.

    The reference may contain slashes (``DEMO/FIR/2026/RJT/0412``); the path
    takes them. An FIR number finds the records filed against that case.
    """
    afis = registries.afis
    key = afis.normalise(reference)
    if len(key) < 3:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="A reference needs at least three characters.",
        )
    try:
        records = await afis.lookup(key)
    except RegistryError as exc:
        raise await _registry_failed(
            exc=exc,
            action="registry.afis",
            key=key,
            user=user,
            request=request,
            case_ref=case_ref,
        ) from exc

    await audit.record(
        action="registry.afis",
        user=user,
        request=request,
        resource_type="registry",
        resource_id=key,
        params={
            "query": key,
            "registries": [afis.registry],
            "source": afis.source,
            "found": bool(records),
            "case_ref": case_ref,
        },
    )

    return AfisLookupOut(
        source=_source_label([afis]),
        provenance=_provenance([afis]),
        sources=_sources([afis]),
        query=reference,
        queried_at=datetime.now(UTC),
        record_exists=bool(records),
        records=[
            AfisRecordOut(
                reference=r.reference,
                afis_reference=r.afis_reference,
                nafis_reference=r.nafis_reference,
                linked_fir_number=r.linked_fir_number,
                district=r.district,
                recorded_on=r.recorded_on,
            )
            for r in records
        ],
    )
