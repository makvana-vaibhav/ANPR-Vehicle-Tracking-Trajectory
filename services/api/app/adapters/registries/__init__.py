"""External registries: VAHAN, SARTHI, eGujCop/CCTNS, AFIS/NAFIS.

``registries_for`` is the one place that decides which implementation answers
for each registry — the counterpart of ``adapter_for`` for cameras. Today
every one is a reference adapter over the local dataset, and says so in every
answer. Connecting a real system is one class implementing the matching
abstract registry in ``base.py`` and one line here; the router, the checks and
the screen do not change. Tests replace the whole set through the router's
``get_registries`` dependency, which is how the swap is proven.
"""

from __future__ import annotations

from sqlalchemy.ext.asyncio import AsyncSession

from app.adapters.registries.base import (
    CaseRegistry,
    DrivingLicence,
    FingerprintRecordRef,
    FingerprintRegistry,
    FirRecord,
    LicenceRegistry,
    Registries,
    RegistryAdapter,
    RegistryError,
    SourceKind,
    VehicleRegistration,
    VehicleRegistry,
)
from app.adapters.registries.reference import (
    ReferenceAfisAdapter,
    ReferenceEGujCopAdapter,
    ReferenceSarthiAdapter,
    ReferenceVahanAdapter,
)


def registries_for(session: AsyncSession) -> Registries:
    """The registries a request consults, bound to its database session."""
    return Registries(
        vahan=ReferenceVahanAdapter(session),
        sarthi=ReferenceSarthiAdapter(session),
        cctns=ReferenceEGujCopAdapter(session),
        afis=ReferenceAfisAdapter(session),
    )


__all__ = [
    "CaseRegistry",
    "DrivingLicence",
    "FingerprintRecordRef",
    "FingerprintRegistry",
    "FirRecord",
    "LicenceRegistry",
    "ReferenceAfisAdapter",
    "ReferenceEGujCopAdapter",
    "ReferenceSarthiAdapter",
    "ReferenceVahanAdapter",
    "Registries",
    "RegistryAdapter",
    "RegistryError",
    "SourceKind",
    "VehicleRegistration",
    "VehicleRegistry",
    "registries_for",
]
