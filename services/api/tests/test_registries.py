"""External registries: VAHAN, SARTHI, eGujCop/CCTNS, AFIS/NAFIS.

What these pin is what makes the feature safe to show an officer:

* every answer says it is reference data, and the label comes from the
  adapter — a test double declaring itself live is reported as live, which is
  the proof the interface is swappable and that nothing downstream sets the
  label;
* every lookup is audited — found, not found, or failed;
* "no record" is a 200 and "could not ask" is a 502, never the other way;
* a registration is compared with what a camera saw, and a scooter's plate on
  a car is flagged with its reason;
* AFIS returns existence and a reference, never anything biometric;
* the dataset covers every demonstration watchlist plate.

The validity and comparison rules are unit-tested first, with no database.
"""

from __future__ import annotations

import csv
import importlib.util
import uuid
from dataclasses import replace
from datetime import UTC, date, datetime
from pathlib import Path
from typing import Any, ClassVar

import pytest
from httpx import AsyncClient
from sqlalchemy import delete, select

from app.adapters.registries import (
    CaseRegistry,
    DrivingLicence,
    FingerprintRecordRef,
    FingerprintRegistry,
    FirRecord,
    LicenceRegistry,
    ReferenceAfisAdapter,
    ReferenceEGujCopAdapter,
    ReferenceSarthiAdapter,
    ReferenceVahanAdapter,
    Registries,
    RegistryError,
    VehicleRegistration,
    VehicleRegistry,
)
from app.db.session import SessionLocal
from app.main import app
from app.models.intelligence import Detection
from app.models.security import AuditLog
from app.routers.registries import get_registries
from app.services import registry_checks
from app.services.registry_checks import Observation

TODAY = date(2026, 10, 12)
SEED_DIR = Path("/data/seed")
if not SEED_DIR.exists():
    SEED_DIR = Path(__file__).resolve().parents[3] / "data" / "seed"


#: A private car, every document in force. Tests change what they are about.
REGISTRATION = VehicleRegistration(
    plate="ZZREG0001",
    owner_name="Reference Owner 900",
    owner_district="Ahmedabad",
    owner_state="Gujarat",
    registering_authority="RTO Ahmedabad (GJ01)",
    registration_status="ACTIVE",
    vehicle_class="Motor Car (LMV)",
    vehicle_category="car",
    maker="Maruti Suzuki",
    model="Swift VXI",
    colour="Solid Fire Red",
    fuel="Petrol",
    manufacture_year=2019,
    registered_on=date(2019, 7, 2),
    registration_valid_until=date(2034, 7, 1),
    fitness_valid_until=None,
    insurance_valid_until=date(2027, 7, 1),
    puc_valid_until=date(2027, 1, 1),
    permit_valid_until=None,
    hypothecated=False,
    financier=None,
    blacklisted=False,
    blacklist_reason=None,
)

FIR = FirRecord(
    fir_number="REF/FIR/2026/TEST/0001",
    police_station="Reference Police Station 01, Ahmedabad City",
    district="Ahmedabad",
    state="Gujarat",
    registered_on=date(2026, 9, 1),
    sections=("BNS 303(2)",),
    status="under_investigation",
    linked_plate="ZZREG0001",
    vehicle_role="stolen",
    summary="Reference record — test.",
)


def registration(**changes: Any) -> VehicleRegistration:
    return replace(REGISTRATION, **changes)


def fir_record(**changes: Any) -> FirRecord:
    return replace(FIR, **changes)


# ══ The rules, with no database ═══════════════════════════════════════


class TestValidity:
    @pytest.mark.parametrize(
        ("valid_until", "state", "days"),
        [
            (date(2026, 10, 11), "expired", -1),
            (date(2026, 10, 12), "expiring", 0),
            (date(2026, 11, 10), "expiring", 29),
            (date(2026, 11, 11), "valid", 30),
            (None, "not_on_record", None),
        ],
    )
    def test_a_document_is_judged_against_the_day(self, valid_until, state, days) -> None:
        assert registry_checks.document_state(valid_until, TODAY) == (state, days)

    def test_a_private_car_has_no_fitness_or_permit_of_its_own(self) -> None:
        docs = {d.document: d for d in registry_checks.vehicle_documents(registration(), TODAY)}
        assert docs["fitness"].state == "not_applicable"
        assert docs["permit"].state == "not_applicable"
        assert docs["registration"].state == "valid"

    def test_an_electric_vehicle_needs_no_puc(self) -> None:
        docs = registry_checks.vehicle_documents(
            registration(fuel="Electric", puc_valid_until=None), TODAY
        )
        assert {d.document: d.state for d in docs}["puc"] == "not_applicable"

    def test_a_goods_vehicle_without_a_fitness_certificate_is_a_finding(self) -> None:
        reg = registration(vehicle_category="truck", vehicle_class="Goods Carrier (HGV)")
        docs = {d.document: d.state for d in registry_checks.vehicle_documents(reg, TODAY)}
        assert docs["fitness"] == "not_on_record"
        flags = registry_checks.vehicle_flags(
            reg, registry_checks.vehicle_documents(reg, TODAY), [], []
        )
        assert any(f.code == "fitness_missing" and f.severity == "high" for f in flags)

    def test_a_motor_cab_needs_its_permit(self) -> None:
        reg = registration(
            vehicle_class="Motor Cab (LMV-TR)", permit_valid_until=date(2025, 12, 31)
        )
        docs = {d.document: d for d in registry_checks.vehicle_documents(reg, TODAY)}
        assert docs["permit"].state == "expired"
        assert docs["permit"].days_remaining == -285


class TestAgreementWithTheCamera:
    def test_a_scooters_plate_on_a_car_is_flagged_with_its_reason(self) -> None:
        reg = registration(
            vehicle_category="motorcycle",
            vehicle_class="M-Cycle/Scooter (2WN)",
            maker="Honda",
            model="Activa 6G",
        )
        checks = registry_checks.compare(
            reg, Observation(vehicle_type="car", vehicle_type_source="sighting")
        )
        vehicle = next(c for c in checks if c.field == "vehicle_class")
        assert vehicle.outcome == "mismatch"
        assert "two-wheeler" in vehicle.reason and "a car" in vehicle.reason
        assert "cloned" in vehicle.reason
        assert vehicle.observed_source == "sighting"

    def test_an_suv_the_detector_calls_a_truck_is_not_a_mismatch(self) -> None:
        """COCO calls many SUVs "truck"; flagging that would teach operators
        the check cries wolf."""
        checks = registry_checks.compare(registration(), Observation(vehicle_type="truck"))
        assert next(c for c in checks if c.field == "vehicle_class").outcome == "match"

    @pytest.mark.parametrize(
        ("seen", "outcome"),
        [
            ("maroon", "match"),
            ("red", "match"),
            ("white", "mismatch"),
            ("teal-ish", "not_compared"),
        ],
    )
    def test_colour_is_compared_by_family(self, seen: str, outcome: str) -> None:
        checks = registry_checks.compare(
            registration(), Observation(colour=seen, colour_source="officer")
        )
        assert next(c for c in checks if c.field == "colour").outcome == outcome

    @pytest.mark.parametrize(
        ("name", "family"),
        [
            # The finish comes first and the hue last: reading left to right
            # once called a blue scooter white ("Pearl") and a brown car
            # yellow ("Golden").
            ("Pearl Siren Blue", "blue"),
            ("Golden Brown", "brown/beige"),
            ("Pearl Arctic White", "white"),
            ("Magma Grey", "silver/grey"),
            ("Solid Fire Red", "red"),
        ],
    )
    def test_a_colour_name_is_read_by_its_hue(self, name: str, family: str) -> None:
        assert registry_checks.colour_family(name) == family

    def test_every_colour_in_the_reference_dataset_is_recognised(self) -> None:
        with (SEED_DIR / "registries" / "vahan.csv").open(encoding="utf-8") as handle:
            colours = {row["colour"] for row in csv.DictReader(handle)}
        assert colours
        assert [c for c in colours if registry_checks.colour_family(c) is None] == []

    @pytest.mark.parametrize(
        ("seen", "outcome"),
        [
            ("Maruti", "match"),
            ("swift", "match"),
            ("Suzuki Swift", "match"),
            ("Hyundai i20", "mismatch"),
        ],
    )
    def test_the_maker_is_compared_with_its_aliases(self, seen: str, outcome: str) -> None:
        checks = registry_checks.compare(registration(), Observation(make=seen))
        assert next(c for c in checks if c.field == "maker").outcome == outcome

    def test_nothing_seen_is_nothing_compared_and_says_why(self) -> None:
        checks = registry_checks.compare(registration(), Observation())
        assert {c.outcome for c in checks} == {"not_compared"}
        assert all(c.reason for c in checks)


class TestFlags:
    def test_a_blacklist_and_an_open_fir_lead_and_every_flag_says_why(self) -> None:
        reg = registration(
            blacklisted=True,
            blacklist_reason="Road tax unpaid.",
            insurance_valid_until=date(2026, 1, 1),
        )
        flags = registry_checks.vehicle_flags(
            reg,
            registry_checks.vehicle_documents(reg, TODAY),
            [fir_record(), fir_record(fir_number="REF/FIR/2024/TEST/0002", status="closed")],
            [],
        )
        assert [f.severity for f in flags][:2] == ["critical", "critical"]
        assert {f.code for f in flags} >= {
            "fir_linked",
            "blacklisted",
            "insurance_expired",
            "fir_closed",
        }
        assert next(f for f in flags if f.code == "fir_closed").severity == "low"
        assert all(f.detail for f in flags)

    def test_a_suspended_licence_is_critical_with_its_reason(self) -> None:
        lic = DrivingLicence(
            licence_number="GJ0520120018830",
            holder_name="Reference Holder 002",
            holder_district="Surat",
            holder_state="Gujarat",
            issuing_authority="RTO Surat (GJ05)",
            issued_on=date(2012, 9, 14),
            non_transport_valid_until=date(2032, 9, 13),
            transport_valid_until=None,
            classes=("MCWG", "LMV"),
            status="suspended",
            status_reason="Suspended under MV Act 19.",
        )
        flags = registry_checks.licence_flags(lic, registry_checks.licence_documents(lic, TODAY))
        assert [(f.severity, f.detail) for f in flags] == [
            ("critical", "Suspended under MV Act 19.")
        ]


# ══ The endpoints, against the seeded reference dataset ═══════════════


async def _last_audit(action: str, resource_id: str) -> AuditLog | None:
    async with SessionLocal() as session:
        return await session.scalar(
            select(AuditLog)
            .where(AuditLog.action == action, AuditLog.resource_id == resource_id)
            .order_by(AuditLog.ts.desc())
            .limit(1)
        )


@pytest.mark.integration
class TestReferenceLookups:
    async def test_a_watchlisted_stolen_car_shows_its_registration_and_its_fir(
        self, client: AsyncClient, auth_headers
    ) -> None:
        response = await client.get(
            "/api/v1/registries/vehicle/GJ 03 AB 1234", headers=await auth_headers("operator")
        )
        assert response.status_code == 200, response.text
        body = response.json()
        assert body["source"] == "reference"
        assert "not a live VAHAN" in body["provenance"]
        assert {s["source"] for s in body["sources"]} == {"reference"}
        assert body["plate"] == "GJ03AB1234" and body["found"] is True
        assert body["registration"]["owner_name"].startswith("Reference Owner")
        # The watchlist entry's case reference resolves in eGujCop.
        assert [f["fir_number"] for f in body["firs"]] == ["DEMO/FIR/2026/RJT/0412"]
        assert body["firs"][0]["open"] is True
        assert body["flags"][0]["severity"] == "critical"
        assert body["flags"][0]["code"] == "fir_linked"

    async def test_every_demonstration_watchlist_plate_has_a_record(
        self, client: AsyncClient, auth_headers
    ) -> None:
        with (SEED_DIR / "watchlist.csv").open(encoding="utf-8") as handle:
            plates = [row["plate"] for row in csv.DictReader(handle)]
        assert len(plates) == 10
        headers = await auth_headers("analyst")
        for plate in plates:
            response = await client.get(f"/api/v1/registries/vehicle/{plate}", headers=headers)
            assert response.json()["found"] is True, plate

    async def test_the_blacklisted_truck_reads_as_blacklisted_suspended_and_lapsed(
        self, client: AsyncClient, auth_headers
    ) -> None:
        body = (
            await client.get(
                "/api/v1/registries/vehicle/GJ06KM2219", headers=await auth_headers("analyst")
            )
        ).json()
        codes = {f["code"]: f["severity"] for f in body["flags"]}
        assert codes["blacklisted"] == "critical"
        assert codes["registration_status"] == "high"
        assert codes["fitness_expired"] == "high"
        assert body["registration"]["hypothecated"] is True
        assert body["registration"]["financier"].startswith("Reference Financier")

    async def test_what_an_officer_saw_is_compared_and_kept_apart_from_a_sighting(
        self, client: AsyncClient, auth_headers
    ) -> None:
        body = (
            await client.get(
                "/api/v1/registries/vehicle/GJ05NR3318",
                params={"observed_type": "car", "observed_colour": "blue"},
                headers=await auth_headers("analyst"),
            )
        ).json()
        checks = {c["field"]: c for c in body["checks"]}
        assert checks["vehicle_class"]["outcome"] == "mismatch"
        assert checks["vehicle_class"]["observed_source"] == "officer"
        assert checks["colour"]["outcome"] == "match"
        assert body["mismatch"] is True
        assert any(f["code"] == "mismatch_vehicle_class" for f in body["flags"])

    async def test_no_record_is_an_answer_and_is_audited(
        self, client: AsyncClient, auth_headers
    ) -> None:
        plate = f"ZZNONE{uuid.uuid4().hex[:4].upper()}"
        response = await client.get(
            f"/api/v1/registries/vehicle/{plate}",
            params={"case_ref": "DEMO/TEST/0001"},
            headers=await auth_headers("analyst"),
        )
        assert response.status_code == 200
        body = response.json()
        assert body["found"] is False and body["registration"] is None and body["flags"] == []
        assert body["source"] == "reference"
        row = await _last_audit("registry.vehicle", plate)
        assert row is not None
        assert row.username == "analyst"
        assert row.params["found"] is False
        assert row.params["case_ref"] == "DEMO/TEST/0001"
        assert row.params["source"] == "reference"

    async def test_a_licence_is_found_however_it_is_typed_and_audited(
        self, client: AsyncClient, auth_headers
    ) -> None:
        response = await client.get(
            "/api/v1/registries/licence/gj05-2012-0018830", headers=await auth_headers("analyst")
        )
        body = response.json()
        assert body["source"] == "reference" and "not a live SARTHI" in body["provenance"]
        assert body["licence"]["licence_number"] == "GJ0520120018830"
        assert body["licence"]["status"] == "suspended"
        assert [c["code"] for c in body["licence"]["classes"]] == ["MCWG", "LMV"]
        assert body["flags"][0]["code"] == "licence_suspended"
        assert await _last_audit("registry.licence", "GJ0520120018830") is not None

    async def test_afis_says_whether_a_record_exists_and_nothing_biometric(
        self, client: AsyncClient, auth_headers
    ) -> None:
        headers = await auth_headers("analyst")
        # Slashes are part of a case reference; encoded or not, the path takes them.
        for path in ("DEMO%2FFIR%2F2026%2FGNR%2F1187", "demo/fir/2026/gnr/1187"):
            body = (await client.get(f"/api/v1/registries/afis/{path}", headers=headers)).json()
            assert body["record_exists"] is True
            assert body["source"] == "reference"
            assert "no biometric data" in body["provenance"]
            assert {r["afis_reference"] for r in body["records"]} == {
                "REF-AFIS-GJ-2026-011870",
                "REF-AFIS-GJ-2026-011871",
            }
            for record in body["records"]:
                assert set(record) == {
                    "reference",
                    "afis_reference",
                    "nafis_reference",
                    "linked_fir_number",
                    "district",
                    "recorded_on",
                }
        missing = (
            await client.get("/api/v1/registries/afis/DEMO/PER/2026/0001", headers=headers)
        ).json()
        assert missing["record_exists"] is False and missing["records"] == []
        assert await _last_audit("registry.afis", "DEMO/PER/2026/0001") is not None

    @pytest.mark.parametrize("role", ["auditor", "api_client"])
    async def test_a_role_without_search_is_refused(
        self, client: AsyncClient, auth_headers, role: str
    ) -> None:
        headers = await auth_headers(role)
        for path in (
            "vehicle/GJ03AB1234",
            "licence/GJ0120190004217",
            "afis/DEMO/FIR/2026/GNR/1187",
        ):
            response = await client.get(f"/api/v1/registries/{path}", headers=headers)
            assert response.status_code == 403, path

    async def test_inputs_too_short_or_unknown_are_refused(
        self, client: AsyncClient, auth_headers
    ) -> None:
        headers = await auth_headers("analyst")
        for path, params in (
            ("vehicle/GJ1", {}),
            ("vehicle/GJ03AB1234", {"observed_type": "spaceship"}),
            ("licence/GJ01", {}),
            ("afis/AB", {}),
        ):
            response = await client.get(
                f"/api/v1/registries/{path}", params=params, headers=headers
            )
            assert response.status_code == 422, path


# ══ The interface is swappable: a test double behind the same endpoints ══


class _LiveVahan(VehicleRegistry):
    source = "live"
    provenance = "Test double declaring itself live."
    records: ClassVar[dict[str, VehicleRegistration]] = {}

    def normalise(self, raw: str) -> str:
        return "".join(ch for ch in raw.upper() if ch.isalnum())

    async def lookup(self, key: str) -> list[VehicleRegistration]:
        return [self.records[key]] if key in self.records else []


class _LiveCases(CaseRegistry):
    source = "live"
    provenance = "Test double declaring itself live."

    def normalise(self, raw: str) -> str:
        return "".join(ch for ch in raw.upper() if ch.isalnum())

    async def lookup(self, key: str) -> list[FirRecord]:
        return []


class _BrokenLicences(LicenceRegistry):
    source = "live"
    provenance = "Test double that cannot be reached."

    def normalise(self, raw: str) -> str:
        return raw.upper()

    async def lookup(self, key: str) -> list[DrivingLicence]:
        raise RegistryError("SARTHI did not answer.")


class _NoPrints(FingerprintRegistry):
    source = "live"
    provenance = "Test double."

    def normalise(self, raw: str) -> str:
        return raw.upper()

    async def lookup(self, key: str) -> list[FingerprintRecordRef]:
        return []


@pytest.fixture
def swapped():
    """Every registry replaced through the router's one dependency."""
    app.dependency_overrides[get_registries] = lambda: Registries(
        vahan=_LiveVahan(), sarthi=_BrokenLicences(), cctns=_LiveCases(), afis=_NoPrints()
    )
    yield _LiveVahan.records
    app.dependency_overrides.pop(get_registries, None)
    _LiveVahan.records.clear()


@pytest.fixture
async def scooter_seen_as_a_car():
    """A plate registered (in the double) as a scooter, and a sighting of it as
    a car. Timestamped in May 2024, where no live process looks."""
    plate = f"ZZREG{uuid.uuid4().hex[:4].upper()}"
    detection_id = uuid.uuid4()
    async with SessionLocal() as session:
        session.add(
            Detection(
                id=detection_id,
                ts=datetime(2024, 5, 6, 8, 0, tzinfo=UTC),
                camera_id=None,
                track_id=f"registry-test-{detection_id.hex[:8]}",
                plate_normalised=plate,
                plate_confidence=0.93,
                vehicle_type="car",
            )
        )
        await session.commit()
    yield plate, detection_id
    async with SessionLocal() as session:
        await session.execute(delete(Detection).where(Detection.plate_normalised == plate))
        await session.commit()


@pytest.mark.integration
class TestSwappable:
    async def test_the_label_is_the_adapters_not_the_routers(
        self, client: AsyncClient, auth_headers, swapped
    ) -> None:
        swapped["ZZLIVE0001"] = registration(plate="ZZLIVE0001")
        body = (
            await client.get(
                "/api/v1/registries/vehicle/ZZLIVE0001", headers=await auth_headers("analyst")
            )
        ).json()
        assert body["source"] == "live"
        assert body["found"] is True
        assert "Test double" in body["provenance"]

    async def test_a_sighting_supplies_what_the_camera_saw(
        self, client: AsyncClient, auth_headers, swapped, scooter_seen_as_a_car
    ) -> None:
        plate, detection_id = scooter_seen_as_a_car
        swapped[plate] = registration(
            plate=plate,
            vehicle_category="motorcycle",
            vehicle_class="M-Cycle/Scooter (2WN)",
            maker="Honda",
            model="Activa 6G",
        )
        body = (
            await client.get(
                f"/api/v1/registries/vehicle/{plate}", headers=await auth_headers("analyst")
            )
        ).json()
        assert body["sighting"]["detection_id"] == str(detection_id)
        vehicle = next(c for c in body["checks"] if c["field"] == "vehicle_class")
        assert vehicle["outcome"] == "mismatch"
        assert vehicle["observed_source"] == "sighting"
        assert body["mismatch"] is True
        row = await _last_audit("registry.vehicle", plate)
        assert row is not None and row.params["detection_id"] == str(detection_id)

    async def test_a_sighting_of_another_plate_is_refused(
        self, client: AsyncClient, auth_headers, swapped, scooter_seen_as_a_car
    ) -> None:
        _, detection_id = scooter_seen_as_a_car
        response = await client.get(
            "/api/v1/registries/vehicle/ZZOTHER01",
            params={"detection_id": str(detection_id)},
            headers=await auth_headers("analyst"),
        )
        assert response.status_code == 422

    async def test_a_registry_that_cannot_answer_is_a_502_and_still_audited(
        self, client: AsyncClient, auth_headers, swapped
    ) -> None:
        number = f"ZZDL{uuid.uuid4().hex[:6].upper()}"
        response = await client.get(
            f"/api/v1/registries/licence/{number}", headers=await auth_headers("analyst")
        )
        assert response.status_code == 502
        assert "did not answer" in response.json()["detail"]
        row = await _last_audit("registry.licence", number)
        assert row is not None and row.result == "error"


def test_the_reference_adapters_say_what_they_are() -> None:
    for adapter in (
        ReferenceVahanAdapter,
        ReferenceSarthiAdapter,
        ReferenceEGujCopAdapter,
        ReferenceAfisAdapter,
    ):
        assert adapter.source == "reference"
        assert adapter.provenance.startswith("Reference data — not a live")
        assert adapter.registry in adapter.provenance


# ══ Departments ═══════════════════════════════════════════════════════

_SEED_PATH = Path(__file__).resolve().parents[3] / "scripts" / "seed.py"


def _load_seed():
    spec = importlib.util.spec_from_file_location("seed_under_test", _SEED_PATH)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_the_seed_carries_26_departments_and_keeps_the_original_six() -> None:
    departments = _load_seed().DEPARTMENTS
    codes = [d["code"] for d in departments]
    names = [d["name"] for d in departments]
    assert len(departments) == 26
    assert len(set(codes)) == 26 and len(set(names)) == 26
    assert codes[:6] == ["POLICE", "HEALTH", "GSRTC", "PANCHAYAT", "MUNICIPAL", "SCRB"]
    assert all(
        len(code) <= 32 and len(name) <= 200 for code, name in zip(codes, names, strict=True)
    )
