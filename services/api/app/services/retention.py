"""Enforcing the retention policy.

## Why this exists

`Settings` has carried `retention_detections_days`, `retention_media_days` and
`retention_audit_days` since Phase 0, and until now **nothing deleted
anything**. A surveillance platform that states a retention period and then
keeps everything forever is not merely untidy: under the DPDP Act the stated
period is the lawful basis for holding the data at all, and exceeding it is the
violation. A policy nobody enforces is worse than no policy, because it is
documented as a control that does not exist.

## How it deletes

Detections and camera health are TimescaleDB hypertables, so expiry is
`drop_chunks` — it unlinks whole time partitions rather than scanning and
deleting rows. On a table holding hundreds of millions of detections a
row-by-row `DELETE` would run for hours, hold locks, and bloat the table it was
trying to shrink.

The audit log is an ordinary table and is deleted by predicate. It is also the
smallest and the longest-lived, so that is affordable.

## What deliberately survives

**Alerts outlive the detections that raised them.** An alert is a police record
with a lifecycle, an operator's name against each transition, and possibly a
case reference; the raw sighting behind it is evidence with a shorter lawful
life. `Alert.detection_id` therefore has no foreign key and dangles by design
once the detection expires. `evidence_expired()` exists so a screen can say
"the evidence for this alert is past its retention date" rather than showing an
operator a lookup failure that looks like a bug.

**Crops behind an open alert survive their retention date.** Plate and vehicle
crops are deleted after `retention_media_days` by `expire_crops`, a day at a
time, because the worker writes them under `crops/<kind>/YYYY/MM/DD/`. A crop
that an alert still being handled points at — its detection's `crop_key`, or
any per-frame read crop recorded beside it — is kept until the alert is closed
or marked a false positive: deleting the photograph an officer is about to act
on would be the retention policy destroying evidence mid-case.

**The audit log outlives everything else** — five years by default. It is the
record of who looked at whom, which is exactly what an inquiry into misuse
would need, and it must not be purgeable on the same schedule as the data it
describes.
"""

from __future__ import annotations

import asyncio
import contextlib
from collections.abc import Collection
from dataclasses import dataclass, field
from datetime import UTC, date, datetime, timedelta
from typing import Any

import aioboto3
from botocore.config import Config
from sqlalchemy import and_, delete, func, select, text
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings
from app.core.logging import get_logger
from app.db.session import SessionLocal
from app.models.enums import AlertStatus
from app.models.intelligence import Alert, Detection
from app.models.security import AuditLog

log = get_logger(__name__)

#: How often the sweep runs. Daily: retention is measured in months, so a
#: shorter interval buys nothing and a longer one lets an expiry sit for weeks.
SWEEP_INTERVAL_S = 24 * 3600.0

#: Where the worker writes plate and vehicle crops: `crops/<kind>/YYYY/MM/DD/`
#: (`ai_worker/crops.py`). Face crops live in the persons bucket and are purged
#: by the persons sweeper, not here.
CROPS_PREFIX = "crops/"

#: An alert in one of these states is still being handled, and the crops
#: behind it are kept past their retention date.
OPEN_ALERT_STATUSES = (
    AlertStatus.NEW.value,
    AlertStatus.ACKNOWLEDGED.value,
    AlertStatus.DISPATCHED.value,
)

#: S3 DeleteObjects takes at most this many keys per call.
DELETE_BATCH = 1000

#: Hypertables, and which setting governs each.
HYPERTABLES = {
    "detections": "retention_detections_days",
    "camera_health": "retention_camera_health_days",
}


@dataclass(slots=True)
class SweepResult:
    """What one pass removed. Reported whether or not anything was deleted."""

    ran_at: datetime
    dry_run: bool
    chunks_dropped: dict[str, int] = field(default_factory=dict)
    audit_rows_deleted: int = 0
    #: Expired plate/vehicle crops removed (or, on a dry run, that would be).
    crops_deleted: int = 0
    #: Expired crops kept because an open alert still points at them.
    crops_kept_for_open_alerts: int = 0
    errors: list[str] = field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        return {
            "ran_at": self.ran_at.isoformat(),
            "dry_run": self.dry_run,
            "chunks_dropped": dict(self.chunks_dropped),
            "audit_rows_deleted": self.audit_rows_deleted,
            "crops_deleted": self.crops_deleted,
            "crops_kept_for_open_alerts": self.crops_kept_for_open_alerts,
            "errors": list(self.errors),
        }


@dataclass(slots=True)
class CropSweep:
    """What one pass over the crop store found."""

    deleted: int = 0
    kept_for_open_alerts: int = 0
    days_expired: list[str] = field(default_factory=list)


def cutoff_for(days: int) -> datetime:
    return datetime.now(UTC) - timedelta(days=days)


async def _expire_hypertable(session: AsyncSession, table: str, days: int, dry_run: bool) -> int:
    """Drop whole time partitions older than the cutoff.

    `show_chunks` is asked first so the count is known and reportable even on a
    dry run — "retention ran and removed nothing" and "retention did not run"
    must not look the same in a log.
    """
    cutoff = cutoff_for(days)
    # Both parameters are cast explicitly. asyncpg infers parameter types from
    # the function signature, and `show_chunks` is polymorphic in `older_than`
    # (it accepts an interval, a timestamp, or an integer), so an uncast
    # parameter is genuinely ambiguous and the driver refuses it.
    chunks = (
        (
            await session.execute(
                text(
                    "SELECT show_chunks(CAST(:table AS regclass), "
                    "older_than => CAST(:cutoff AS timestamptz))"
                ),
                {"table": table, "cutoff": cutoff},
            )
        )
        .scalars()
        .all()
    )

    if not dry_run and chunks:
        await session.execute(
            text(
                "SELECT drop_chunks(CAST(:table AS regclass), "
                "older_than => CAST(:cutoff AS timestamptz))"
            ),
            {"table": table, "cutoff": cutoff},
        )
    return len(chunks)


async def _expire_audit(session: AsyncSession, days: int, dry_run: bool) -> int:
    cutoff = cutoff_for(days)
    doomed = (
        await session.execute(
            select(func.count()).select_from(AuditLog).where(AuditLog.ts < cutoff)
        )
    ).scalar_one()
    if not dry_run and doomed:
        await session.execute(delete(AuditLog).where(AuditLog.ts < cutoff))
    return doomed


async def protected_crop_keys(session: AsyncSession) -> set[str]:
    """Every crop an open alert still points at.

    The detection's own `crop_key`, plus the per-frame read crops recorded in
    `ocr_raw.reads` — an operator verifying a plate looks at those too. Alerts
    are few and the join is on the detections primary key, so this is cheap.
    """
    rows = await session.execute(
        select(Detection.crop_key, Detection.ocr_raw)
        .join(
            Alert,
            and_(Alert.detection_id == Detection.id, Alert.detection_ts == Detection.ts),
        )
        .where(Alert.status.in_(OPEN_ALERT_STATUSES))
    )
    keys: set[str] = set()
    for crop_key, ocr_raw in rows.all():
        if crop_key:
            keys.add(crop_key)
        reads = ocr_raw.get("reads") if isinstance(ocr_raw, dict) else None
        for read in reads or []:
            if isinstance(read, dict) and isinstance(read.get("crop"), str) and read["crop"]:
                keys.add(read["crop"])
    return keys


def _s3_kwargs() -> dict[str, Any]:
    return {
        "endpoint_url": settings.minio_url,
        "aws_access_key_id": settings.minio_root_user,
        "aws_secret_access_key": settings.minio_root_password,
        "config": Config(signature_version="s3v4", retries={"max_attempts": 2}),
    }


async def _subprefixes(s3: Any, bucket: str, prefix: str) -> list[str]:
    """The next level of `prefix/` — what a directory listing would show."""
    found: list[str] = []
    paginator = s3.get_paginator("list_objects_v2")
    async for page in paginator.paginate(Bucket=bucket, Prefix=prefix, Delimiter="/"):
        found.extend(entry["Prefix"] for entry in page.get("CommonPrefixes", []))
    return found


def _segment(prefix: str) -> str:
    return prefix.rstrip("/").rsplit("/", 1)[-1]


async def _expired_days(s3: Any, bucket: str, kind_prefix: str, cutoff: date) -> list[str]:
    """Day prefixes under `crops/<kind>/` strictly older than `cutoff`.

    Years and months entirely after the cutoff are not descended into, so the
    listing costs a handful of calls however much recent evidence there is.
    A segment that is not a number is not ours to judge, and is left alone.
    """
    days: list[str] = []
    for year_prefix in await _subprefixes(s3, bucket, kind_prefix):
        year = _segment(year_prefix)
        if not year.isdigit() or int(year) > cutoff.year:
            continue
        for month_prefix in await _subprefixes(s3, bucket, year_prefix):
            month = _segment(month_prefix)
            if not month.isdigit() or (int(year), int(month)) > (cutoff.year, cutoff.month):
                continue
            for day_prefix in await _subprefixes(s3, bucket, month_prefix):
                day = _segment(day_prefix)
                try:
                    when = date(int(year), int(month), int(day))
                except ValueError:
                    continue
                if when < cutoff:
                    days.append(day_prefix)
    return days


async def expire_crops(
    cutoff: datetime,
    *,
    dry_run: bool,
    kinds: Collection[str] | None = None,
    bucket: str | None = None,
) -> CropSweep:
    """Delete plate and vehicle crops from days before `cutoff`.

    Whole days, because the worker partitions crops by the day it wrote them:
    a crop goes within a day of its retention date, never before it. Crops an
    open alert points at are kept (`protected_crop_keys`). `kinds` narrows the
    sweep to some `crops/<kind>/` trees — for tests; the scheduled sweep takes
    every kind it finds.
    """
    result = CropSweep()
    bucket = bucket or settings.minio_bucket
    async with SessionLocal() as session:
        protected = await protected_crop_keys(session)

    async with aioboto3.Session().client("s3", **_s3_kwargs()) as s3:
        for kind_prefix in await _subprefixes(s3, bucket, CROPS_PREFIX):
            if kinds is not None and _segment(kind_prefix) not in kinds:
                continue
            for day_prefix in await _expired_days(s3, bucket, kind_prefix, cutoff.date()):
                result.days_expired.append(day_prefix)
                doomed: list[str] = []
                paginator = s3.get_paginator("list_objects_v2")
                async for page in paginator.paginate(Bucket=bucket, Prefix=day_prefix):
                    for obj in page.get("Contents", []):
                        if obj["Key"] in protected:
                            result.kept_for_open_alerts += 1
                        else:
                            doomed.append(obj["Key"])
                for start in range(0, len(doomed), DELETE_BATCH):
                    batch = doomed[start : start + DELETE_BATCH]
                    if not dry_run:
                        response = await s3.delete_objects(
                            Bucket=bucket,
                            Delete={"Objects": [{"Key": key} for key in batch], "Quiet": True},
                        )
                        failed = response.get("Errors", [])
                        if failed:
                            raise RuntimeError(
                                f"{len(failed)} crop deletions refused under {day_prefix}: "
                                f"{failed[0].get('Code')}"
                            )
                    result.deleted += len(batch)
    return result


async def sweep(dry_run: bool = False) -> SweepResult:
    """Delete everything past its retention date."""
    result = SweepResult(ran_at=datetime.now(UTC), dry_run=dry_run)

    # A session per target. Postgres aborts the whole transaction on a failed
    # statement, so sharing one would mean the first failure silently took the
    # rest of the sweep with it — a policy that reports success while enforcing
    # nothing is the worst of the available outcomes.
    for table, setting in HYPERTABLES.items():
        days = getattr(settings, setting, None)
        if not days:
            continue
        try:
            async with SessionLocal() as session:
                result.chunks_dropped[table] = await _expire_hypertable(
                    session, table, days, dry_run
                )
                if not dry_run:
                    await session.commit()
        except Exception as exc:
            log.warning("retention.table_failed", table=table, error=str(exc))
            result.errors.append(f"{table}: {exc}")

    try:
        async with SessionLocal() as session:
            result.audit_rows_deleted = await _expire_audit(
                session, settings.retention_audit_days, dry_run
            )
            if not dry_run:
                await session.commit()
    except Exception as exc:
        log.warning("retention.audit_failed", error=str(exc))
        result.errors.append(f"audit_log: {exc}")

    # Plate and vehicle crops. Object storage being down must not cost the
    # database its sweep, so this is last and on its own.
    try:
        crops = await expire_crops(cutoff_for(settings.retention_media_days), dry_run=dry_run)
        result.crops_deleted = crops.deleted
        result.crops_kept_for_open_alerts = crops.kept_for_open_alerts
    except Exception as exc:
        log.warning("retention.crops_failed", error=str(exc), exc_info=True)
        result.errors.append(f"crops: {exc}")

    log.info(
        "retention.swept",
        dry_run=dry_run,
        chunks=result.chunks_dropped,
        audit_rows=result.audit_rows_deleted,
        crops_deleted=result.crops_deleted,
        crops_kept_for_open_alerts=result.crops_kept_for_open_alerts,
        errors=len(result.errors),
        detections_days=settings.retention_detections_days,
        media_days=settings.retention_media_days,
        audit_days=settings.retention_audit_days,
    )
    return result


async def evidence_expired(session: AsyncSession, alert: Alert) -> bool:
    """True when the detection behind an alert is past its retention date.

    Lets a screen say "the evidence has passed its retention date" instead of
    showing a lookup failure. The two look identical to a caller that only
    checks for a missing row, and they mean very different things: one is
    policy working, the other is a bug.
    """
    if alert.detection_id is None:
        return False
    if alert.created_at is None:
        return False
    if alert.created_at >= cutoff_for(settings.retention_detections_days):
        return False

    found = (
        await session.execute(
            select(func.count()).select_from(Detection).where(Detection.id == alert.detection_id)
        )
    ).scalar_one()
    return found == 0


class RetentionEnforcer:
    """Runs the sweep on a schedule."""

    def __init__(self) -> None:
        self._task: asyncio.Task[None] | None = None
        self._stop = asyncio.Event()
        self.last: SweepResult | None = None

    async def _loop(self) -> None:
        while not self._stop.is_set():
            try:
                self.last = await sweep(dry_run=not settings.retention_enforce)
            except Exception:
                log.warning("retention.sweep_failed", exc_info=True)
            with contextlib.suppress(TimeoutError):
                await asyncio.wait_for(self._stop.wait(), timeout=SWEEP_INTERVAL_S)

    def start(self) -> None:
        if self._task is not None:
            return
        if not settings.retention_enforce:
            # Reported rather than silent. An operator reading the log must be
            # able to tell that retention is off, because the alternative is
            # believing a control is running when it is not.
            log.warning(
                "retention.disabled",
                detail=(
                    "RETENTION_ENFORCE is false; the sweep will report what it "
                    "would delete but delete nothing."
                ),
            )
        self._stop.clear()
        self._task = asyncio.create_task(self._loop(), name="retention")

    async def stop(self) -> None:
        self._stop.set()
        if self._task is not None:
            self._task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await self._task
            self._task = None


enforcer = RetentionEnforcer()
