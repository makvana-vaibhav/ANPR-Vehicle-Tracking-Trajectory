"""Seed the platform with a working demo dataset.

Run with ``make seed``. Idempotent: safe to run repeatedly, it upserts rather
than duplicating, so a judge can re-run it without wiping the database first.

Phase 1 seeds departments and one user per role.
Phase 2 extends this with the camera fleet and the watchlist.

The camera fleet is whatever `data/seed/cameras.csv` holds. It ships as the
three-camera demonstration corridor; `scripts/generate_ahmedabad_cameras.py`
regenerates it at any size.
"""

from __future__ import annotations

import argparse
import asyncio
import csv
import os
import sys
from datetime import datetime
from pathlib import Path

# The script runs from /app inside the container; make the API package importable.
sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "services" / "api"))

from sqlalchemy import delete, func, select, text  # noqa: E402

from app.core.config import settings  # noqa: E402
from app.core.security import hash_password  # noqa: E402
from app.db.session import SessionLocal, dispose_engine  # noqa: E402
from app.models.enums import AdapterType, CameraStatus, Role, VmsVendor  # noqa: E402
from app.models.intelligence import Alert, Detection, Watchlist  # noqa: E402
from app.models.registry import (  # noqa: E402
    Camera,
    CameraHealth,
    Department,
    VmsInstance,
)
from app.models.security import User  # noqa: E402
from app.schemas.intelligence import normalise_plate  # noqa: E402

SEED_DIR = Path("/data/seed")
if not SEED_DIR.exists():  # running outside the container
    SEED_DIR = Path(__file__).resolve().parent.parent / "data" / "seed"

# ── Departments ───────────────────────────────────────────────────────
# The five departments whose live feeds the challenge sandbox exposes, plus
# SCRB which operates the state aggregation tier.
DEPARTMENTS: list[dict[str, str]] = [
    {
        "code": "POLICE",
        "name": "Gujarat Police",
        "contact_email": "control@police.gujarat.gov.in",
    },
    {
        "code": "HEALTH",
        "name": "Department of Health & Family Welfare",
        "contact_email": "cctv@health.gujarat.gov.in",
    },
    {
        "code": "GSRTC",
        "name": "Gujarat State Road Transport Corporation",
        "contact_email": "security@gsrtc.gujarat.gov.in",
    },
    {
        "code": "PANCHAYAT",
        "name": "Panchayat, Rural Housing & Rural Development",
        "contact_email": "cctv@panchayat.gujarat.gov.in",
    },
    {
        "code": "MUNICIPAL",
        "name": "Urban Development & Urban Housing (Municipal)",
        "contact_email": "citysurveillance@udd.gujarat.gov.in",
    },
    {
        "code": "SCRB",
        "name": "State Crime Records Bureau",
        "contact_email": "scrb@gujarat.gov.in",
    },
]

# ── Federated VMS instances ───────────────────────────────────────────
# The federated systems. Each stays authoritative for its own recordings; this
# platform holds their metadata and pulls streams on demand — the essence of
# Model 5.
#
# credentials_ref is a POINTER into a secret store, never a credential. That is
# enforced by convention here and documented in docs/SECURITY.md.
#
# The registry lists only systems we genuinely federate.
#
# It used to seed four more — a Milestone deployment in Rajkot, a Genetec one
# in Ahmedabad, a CP Plus depot system and a Hikvision highway grid — all with
# `adapter_type: simulated`, none with a single camera behind them. On screen
# they read as four integrations the platform maintains. It maintains none of
# them, and no server of any of those vendors has ever been on the other end.
#
# The multi-vendor claim belongs where it is true: `/integration/adapters`
# reports the adapter interface's real implementations — RTSP, ONVIF, vendor
# REST, sandbox — which are code, and unit-tested. What a *connected system*
# list should show is what is connected.

#: The city fleet's recorder and the CSV that populates it. Defined before
#: VMS_INSTANCES because that list references FLEET_VMS at module level.
FLEET_VMS = "Ahmedabad City ANPR Grid (simulated)"
FLEET_CSV = SEED_DIR / "cameras.csv"

VMS_INSTANCES: list[dict[str, str]] = [
    {
        # The city fleet's recorder. `adapter_type: simulated` is the honest
        # label: footage is replayed into MediaMTX by services/simulator and
        # read back over RTSP, so every camera filed here has a stream that
        # genuinely resolves, can be opened, and can produce a detection.
        "name": FLEET_VMS,
        "vendor": VmsVendor.SIMULATED.value,
        "adapter_type": AdapterType.SIMULATED.value,
        "base_url": "",
        "credentials_ref": "vault://nagarnetra/vms/ahmedabad-city-grid",
        "department": "POLICE",
    },
    {
        # The challenge sandbox (sentinel.gujarat.gov.in) publishes a camera
        # catalogue at /api/ingest and serves RTSP/WHEP/HLS. Phase 3's
        # HostedGridAdapter federates it through this record.
        "name": "Hosted Camera Grid",
        "vendor": VmsVendor.HOSTED_GRID.value,
        "adapter_type": AdapterType.HOSTED_GRID.value,
        "base_url": "https://sentinel.gujarat.gov.in",
        "credentials_ref": "vault://nagarnetra/vms/sandbox-grid",
        "department": "SCRB",
    },
]

# ── Demo users ────────────────────────────────────────────────────────
# One per role, so a judge can sign in as any role and see the RBAC matrix
# take effect. The admin password comes from the environment; the rest share
# a documented demo password. In production these accounts would not exist —
# see docs/SECURITY.md on account provisioning.
DEMO_PASSWORD = "NagarNetra@2026"  # noqa: S105 - documented demo credential

DEMO_USERS: list[dict[str, str | None]] = [
    {
        "username": "admin",
        "full_name": "System Administrator",
        "role": Role.ADMIN.value,
        "department": "SCRB",
    },
    {
        "username": "supervisor",
        "full_name": "Control Room Supervisor",
        "role": Role.SUPERVISOR.value,
        "department": "POLICE",
    },
    {
        "username": "operator",
        "full_name": "Control Room Operator",
        "role": Role.OPERATOR.value,
        "department": "POLICE",
    },
    {
        "username": "analyst",
        "full_name": "Crime Analyst",
        "role": Role.ANALYST.value,
        "department": "SCRB",
    },
    {
        "username": "auditor",
        "full_name": "Compliance Auditor",
        "role": Role.AUDITOR.value,
        "department": "SCRB",
    },
    {
        "username": "gsrtc-integration",
        "full_name": "GSRTC Camera Onboarding Client",
        "role": Role.API_CLIENT.value,
        "department": "GSRTC",
    },
]


async def seed_departments() -> dict[str, object]:
    """Insert departments, returning ``{code: id}``."""
    created = 0
    ids: dict[str, object] = {}

    async with SessionLocal() as session:
        for spec in DEPARTMENTS:
            existing = await session.scalar(
                select(Department).where(Department.code == spec["code"])
            )
            if existing is None:
                dept = Department(
                    code=spec["code"],
                    name=spec["name"],
                    contact_email=spec["contact_email"],
                )
                session.add(dept)
                await session.flush()
                ids[spec["code"]] = dept.id
                created += 1
            else:
                ids[spec["code"]] = existing.id
        await session.commit()

    print(
        f"  departments: {created} created, {len(DEPARTMENTS) - created} already present"
    )
    return ids


async def seed_users(department_ids: dict[str, object]) -> None:
    """Insert one user per role."""
    created = 0

    async with SessionLocal() as session:
        for spec in DEMO_USERS:
            username = str(spec["username"])
            existing = await session.scalar(
                select(User).where(User.username == username)
            )
            if existing is not None:
                continue

            # The admin password is configurable so a deployment can set a real
            # one; demo accounts use the documented shared password.
            password = (
                settings.bootstrap_admin_password
                if username == settings.bootstrap_admin_username
                else DEMO_PASSWORD
            )

            session.add(
                User(
                    username=username,
                    password_hash=hash_password(password),
                    full_name=spec["full_name"],
                    role=str(spec["role"]),
                    department_id=department_ids.get(str(spec["department"])),
                    is_active=True,
                )
            )
            created += 1
        await session.commit()

    print(f"  users: {created} created, {len(DEMO_USERS) - created} already present")


async def seed_vms(department_ids: dict[str, object]) -> None:
    """Register the federated VMS instances."""
    created = 0
    async with SessionLocal() as session:
        for spec in VMS_INSTANCES:
            existing = await session.scalar(
                select(VmsInstance).where(VmsInstance.name == spec["name"])
            )
            if existing is not None:
                # Reconcile: a changed adapter_type or base_url must reach an
                # already-seeded database, or re-running the seed silently
                # leaves stale integration settings in place.
                existing.vendor = spec["vendor"]
                existing.adapter_type = spec["adapter_type"]
                existing.base_url = spec["base_url"]
                existing.credentials_ref = spec["credentials_ref"]
                existing.department_id = department_ids.get(spec["department"])
                continue
            session.add(
                VmsInstance(
                    name=spec["name"],
                    vendor=spec["vendor"],
                    adapter_type=spec["adapter_type"],
                    base_url=spec["base_url"],
                    credentials_ref=spec["credentials_ref"],
                    department_id=department_ids.get(spec["department"]),
                    status=CameraStatus.UNKNOWN.value,
                )
            )
            created += 1
        await session.commit()
    print(
        f"  vms instances: {created} created, {len(VMS_INSTANCES) - created} already present"
    )


#: Cameras this registry no longer carries, removed from databases seeded
#: before they were dropped.
#:
#: `CAM-DEMO` is the original single demonstration camera. The rest are the
#: simulated Ahmedabad fleet built for SIH26127. The platform now competes in
#: the Gujarat Police CCTV hackathon, whose live test runs on the organisers'
#: own camera grid (onboarded by scripts/sync_sandbox.py), so the simulated
#: fleet shrinks to one recorded camera, CAM-DEMO-01, kept as the fallback
#: that still plays when the grid cannot be reached.
#:
#: `CAM-DEMO-02` is no longer retired: the code was reused for the persons
#: watchlist's recorded demonstration camera (see data/seed/cameras.csv).
#: Retiring it here would delete it — with its person-match alarms — on every
#: re-seed, only for `seed_fleet` to recreate it empty a moment later.
RETIRED_CAMERA_CODES = (
    "CAM-DEMO",
    "CAM-DEMO-03",
    "CAM-NRD-01",
    "CAM-NRD-02",
    "CAM-NRD-03",
    "CAM-SGH-01",
    "CAM-SGH-02",
    "CAM-SGH-03",
    "CAM-SPR-01",
    "CAM-SPR-02",
    "CAM-SPR-03",
)
LEGACY_DEMO_VMS = "NagarNetra ANPR Demonstration"


async def retire_cameras() -> None:
    """Remove every camera in `RETIRED_CAMERA_CODES` this database still has.

    A retired camera sits at a position no simulator publishes, which is the
    kind of unwatchable registry entry commit 4d0346f deleted 251 of.

    Children go first and explicitly. `detections.camera_id` and
    `alerts.camera_id` are ON DELETE SET NULL, so deleting the camera alone
    would orphan its sightings rather than remove them, and they would then
    appear in search attached to no camera at all — worse than either keeping
    or deleting them. Route history has no foreign key at all: a journey is
    stored as JSON naming its cameras, so journeys through a retired camera
    are matched by code. They are what anomaly baselines are learned from, and
    a baseline over cameras that no longer exist describes nothing.
    """
    retired = 0
    async with SessionLocal() as session:
        cameras = (
            await session.scalars(
                select(Camera).where(Camera.camera_code.in_(RETIRED_CAMERA_CODES))
            )
        ).all()

        for camera in cameras:
            # Alerts reference detections *and* cameras, so they go before both.
            await session.execute(delete(Alert).where(Alert.camera_id == camera.id))
            await session.execute(
                delete(Detection).where(Detection.camera_id == camera.id)
            )
            await session.execute(
                delete(CameraHealth).where(CameraHealth.camera_id == camera.id)
            )
            await session.execute(
                text(
                    "DELETE FROM vehicle_tracks WHERE EXISTS ("
                    " SELECT 1 FROM jsonb_array_elements(hops->'hops') AS hop"
                    " WHERE hop->>'camera_code' = :code)"
                ),
                {"code": camera.camera_code},
            )
            await session.execute(delete(Camera).where(Camera.id == camera.id))
            retired += 1

        # The original demo camera had a private VMS whose only purpose was to
        # keep recorded footage from looking like a department's live feed.
        # With its camera gone it describes nothing, and an empty integration
        # on the fleet screen is its own small piece of fiction.
        vms = (
            await session.execute(
                select(VmsInstance).where(VmsInstance.name == LEGACY_DEMO_VMS)
            )
        ).scalar_one_or_none()
        if vms is not None:
            orphaned = (
                await session.execute(
                    select(func.count())
                    .select_from(Camera)
                    .where(Camera.vms_id == vms.id)
                )
            ).scalar_one()
            if orphaned == 0:
                await session.execute(
                    delete(VmsInstance).where(VmsInstance.id == vms.id)
                )

        await session.commit()

    if retired:
        print(f"  retired cameras: removed {retired}")
    else:
        print("  retired cameras: none left to remove")


async def seed_fleet() -> None:
    """Load the ANPR fleet from data/seed/cameras.csv.

    The committed CSV is one **recorded camera**, CAM-DEMO-01, replaying a
    clip on a real OpenStreetMap road vertex. The live test runs on the
    organisers' grid, which scripts/sync_sandbox.py onboards; this camera is
    the fallback that still plays when the grid cannot be reached, and it is
    tagged as recorded footage so nobody mistakes it for a live feed.

    It was three cameras on the Ashram Road corridor, and before that a
    simulated city fleet; `RETIRED_CAMERA_CODES` removes those from databases
    seeded before the change. A larger simulated fleet is a
    `generate_ahmedabad_cameras.py` run away, and the worker divides one CPU
    budget across every camera it watches, so it costs latency in proportion.

    Whatever its size, the CSV is generated by
    `scripts/generate_ahmedabad_cameras.py`, which thins the committed
    OpenStreetMap arterial network so that **every camera sits on a real road
    vertex** of a real named corridor, in a real taluka, at least 250 m from any
    other camera. So each row is a position a camera could actually occupy.

    ## Why `stream_url` stays NULL

    This is the part that is easy to get wrong, and getting it wrong breaks the
    whole fleet rather than one camera.

    `gateway.reconcile()` runs at API startup and, for every camera that has a
    `stream_url` and whose adapter is not federated, tells MediaMTX to open a
    **pull** path from that URL. `simulated` is not in `FEDERATED_ADAPTERS`. So
    setting `stream_url` to the gateway's own address — the obvious thing to
    write, since that is where the stream really is — makes MediaMTX pull each
    path *from itself*: an infinite loop that silently blocks the simulator from
    publishing, on every camera, on every restart.

    These cameras are *published into* MediaMTX, not pulled from anywhere, so
    they have no upstream URL and the column stays NULL. `SimulatedVmsAdapter`
    derives the RTSP, WHEP and HLS URLs from `camera_code`, and probes health by
    asking MediaMTX which paths are actually live — which is a better health
    check than a stored string could ever be.

    This is not the fiction commit `4d0346f` deleted. Those 251 cameras had no
    source *at all*: nothing published them, they could never be watched and
    never produced a detection. Every camera here is published by the simulator
    and is genuinely watchable.
    """
    if not FLEET_CSV.exists():
        print(
            f"  fleet: SKIPPED — {FLEET_CSV.name} not found "
            f"(run scripts/generate_ahmedabad_cameras.py)"
        )
        return

    created = refreshed = 0
    async with SessionLocal() as session:
        vms = (
            await session.execute(
                select(VmsInstance).where(VmsInstance.name == FLEET_VMS)
            )
        ).scalar_one_or_none()
        if vms is None:
            print(f"  fleet: SKIPPED — VMS {FLEET_VMS!r} missing; seed vms first")
            return

        departments = {
            code: ident
            for code, ident in (
                await session.execute(select(Department.code, Department.id))
            ).all()
        }

        with FLEET_CSV.open(newline="") as handle:
            for row in csv.DictReader(handle):
                code = row["camera_code"].strip().upper()
                if not code:
                    continue
                lon, lat = float(row["lon"]), float(row["lat"])

                camera = (
                    await session.execute(
                        select(Camera).where(Camera.camera_code == code)
                    )
                ).scalar_one_or_none()
                if camera is None:
                    camera = Camera(camera_code=code)
                    session.add(camera)
                    created += 1
                else:
                    refreshed += 1

                camera.name = row["name"].strip()
                camera.department_id = departments.get(
                    row["department_code"].strip().upper()
                )
                camera.vms_id = vms.id
                camera.location = func.ST_SetSRID(func.ST_MakePoint(lon, lat), 4326)
                camera.district = row["district"].strip()
                camera.city = row["city"].strip()
                camera.junction = row["junction"].strip()
                # `.get`, not `[...]`: a cameras.csv written before the corridor
                # column existed must still seed. Such a camera is left
                # uncorridored, which analytics reports as its own bucket rather
                # than guessing a road from the camera code.
                camera.corridor = (row.get("corridor") or "").strip() or None
                camera.heading_deg = int(row["heading_deg"])
                camera.camera_type = row["camera_type"].strip()
                camera.protocol = row["protocol"].strip()
                # Deliberately NULL — see the docstring. Do not "fix" this.
                camera.stream_url = None
                camera.resolution = row["resolution"].strip()
                camera.fps = int(row["fps"])
                camera.anpr_enabled = row["anpr_enabled"].strip().lower() == "true"
                # UNKNOWN, not ONLINE: the health monitor decides what is up.
                # Seeding a camera as online would be its own small lie.
                camera.status = CameraStatus.UNKNOWN.value
                camera.tags = [tag for tag in row["tags"].split("|") if tag]

        await session.commit()

    print(f"  fleet: {created} created, {refreshed} refreshed")


async def seed_watchlist() -> None:
    """Load the demo watchlist from data/seed/watchlist.csv.

    This file has existed since Phase 2 and **nothing read it**. The watchlist
    was populated by hand during development, so it survived on this machine
    and nowhere else: a fresh clone reached `make demo` with an empty watchlist
    and judge moments 3 and 4 — the automatic alert and the tracked vehicle —
    had nothing to fire on.

    Existing entries are **reactivated**, not skipped. Deleting a watchlist
    entry through the API deactivates it rather than removing it, which is
    right for an audit trail and means a demo plate retired during testing
    stays retired through every future re-seed unless seeding says otherwise.
    That is exactly how this database ended up with all eight of its entries
    inactive.

    ## Labelled, and on by default

    The rows in `watchlist.csv` are invented — plates nobody reported, against
    case numbers that do not exist. This was opt-in while they read like real
    cases: an invented "stolen, occupants may be armed" flag against a real
    plate photographed on a real road is not a thing to put on a screen. With
    seeding off, though, a fresh `make demo` failed its own check that the
    watchlist is not empty, and the brief asks for representative data —
    stolen, wanted, blacklisted and suspect vehicles.

    So every row now says what it is, where an operator looks: the case
    reference starts `DEMO/` and the remark `DEMO (fictional)`. Every plate
    was checked against all 1,516 plates read on the live feeds by 12 Oct
    2026 and is at least three characters from each, so neither an exact nor
    a one-character near match can fire on a vehicle the cameras have seen.
    Re-check before adding a row (CLAUDE.md: guess toward demonstrable, never
    toward accusing a real vehicle). `SEED_WATCHLIST=false` leaves the
    watchlist empty for a deployment that should start with none.
    """
    csv_path = SEED_DIR / "watchlist.csv"
    if not csv_path.exists():
        print(f"  watchlist: SKIPPED — {csv_path} not found")
        return

    created = reactivated = updated = 0
    with csv_path.open(newline="", encoding="utf-8") as handle:
        rows = list(csv.DictReader(handle))

    async with SessionLocal() as session:
        for row in rows:
            plate = normalise_plate(row["plate"])
            # The entry being watched now, if there is one. A plate can also
            # have retired entries under other cases; refreshing one of those
            # instead would leave the plate watched twice.
            existing = (
                (
                    await session.execute(
                        select(Watchlist)
                        .where(Watchlist.plate_normalised == plate)
                        .order_by(Watchlist.active.desc(), Watchlist.created_at.desc())
                    )
                )
                .scalars()
                .first()
            )

            valid_from = _timestamp(row.get("valid_from"))
            valid_to = _timestamp(row.get("valid_to"))

            if existing is None:
                session.add(
                    Watchlist(
                        plate_normalised=plate,
                        category=row["category"],
                        priority=row["priority"],
                        case_ref=row.get("case_ref") or None,
                        remarks=row.get("remarks") or None,
                        valid_from=valid_from,
                        valid_to=valid_to,
                        active=True,
                    )
                )
                created += 1
                continue

            if not existing.active:
                reactivated += 1
            else:
                updated += 1
            existing.category = row["category"]
            existing.priority = row["priority"]
            existing.case_ref = row.get("case_ref") or None
            existing.remarks = row.get("remarks") or None
            existing.valid_from = valid_from
            existing.valid_to = valid_to
            existing.active = True

        await session.commit()

    print(
        f"  watchlist: {created} created, {reactivated} reactivated, {updated} refreshed"
    )


def _timestamp(value: str | None) -> datetime | None:
    """Parse an ISO timestamp from the CSV, tolerating the Z suffix."""
    if not value or not value.strip():
        return None
    return datetime.fromisoformat(value.strip().replace("Z", "+00:00"))


async def main() -> int:
    parser = argparse.ArgumentParser(description="Seed NagarNetra demo data")
    parser.add_argument(
        "--only",
        choices=[
            "departments",
            "users",
            "vms",
            "demo-camera",
            "fleet",
            "watchlist",
            "all",
        ],
        default="all",
        help="Seed a single dataset instead of everything",
    )
    args = parser.parse_args()

    print("Seeding NagarNetra")
    try:
        department_ids = await seed_departments()
        if args.only in ("users", "all"):
            await seed_users(department_ids)
        if args.only in ("vms", "all"):
            await seed_vms(department_ids)
        if args.only in ("demo-camera", "all"):
            await retire_cameras()
        if args.only in ("fleet", "all"):
            await seed_fleet()
        # On unless switched off; `--only watchlist` is someone asking for it
        # by name either way. See `seed_watchlist`'s docstring for the history.
        if args.only == "watchlist" or (
            args.only == "all"
            and os.environ.get("SEED_WATCHLIST", "true").lower()
            not in ("0", "false", "no")
        ):
            await seed_watchlist()
        elif args.only == "all":
            print("  watchlist: skipped — SEED_WATCHLIST is off")
    finally:
        await dispose_engine()

    print("\nDemo credentials:")
    print(f"  admin / {settings.bootstrap_admin_password}")
    print(f"  supervisor · operator · analyst · auditor / {DEMO_PASSWORD}")
    print("\nSeed complete.")
    return 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
