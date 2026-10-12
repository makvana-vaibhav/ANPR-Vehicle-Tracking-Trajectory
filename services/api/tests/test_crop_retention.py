"""Plate-crop retention: expired crops go, crops behind an open alert stay.

Runs against the live object store and database, in a `crops/<kind>/` tree of
its own so the sweep under test never sees a real crop.
"""

from __future__ import annotations

import uuid
from datetime import UTC, datetime, timedelta

import aioboto3
import pytest
from sqlalchemy import delete

from app.core.config import settings
from app.db.session import SessionLocal
from app.models.enums import AlertStatus, AlertType, Priority
from app.models.intelligence import Alert, Detection
from app.services import retention

pytestmark = pytest.mark.asyncio


@pytest.fixture
async def crop_tree():
    """An old day and today, under a test kind, with alerts pointing into it."""
    kind = f"__retention_test_{uuid.uuid4().hex[:8]}__"
    old_day = f"{retention.CROPS_PREFIX}{kind}/2020/01/01/"
    today = f"{retention.CROPS_PREFIX}{kind}/{datetime.now(UTC):%Y/%m/%d}/"
    keys = {
        "expired": f"{old_day}expired.jpg",
        "open_alert": f"{old_day}open_alert.jpg",
        "open_alert_read": f"{old_day}open_alert_read.jpg",
        "closed_alert": f"{old_day}closed_alert.jpg",
        "recent": f"{today}recent.jpg",
    }
    async with aioboto3.Session().client("s3", **retention._s3_kwargs()) as s3:
        for key in keys.values():
            await s3.put_object(Bucket=settings.minio_bucket, Key=key, Body=b"\xff\xd8test")

    now = datetime.now(UTC)
    ids = {name: uuid.uuid4() for name in ("open", "closed")}
    async with SessionLocal() as session:
        session.add(
            Detection(
                id=ids["open"],
                ts=now,
                track_id=f"retention-test:{kind}:1",
                plate_normalised="ZZ99RT0001",
                crop_key=keys["open_alert"],
                ocr_raw={"reads": [{"crop": keys["open_alert_read"]}, {"crop": None}]},
            )
        )
        session.add(
            Detection(
                id=ids["closed"],
                ts=now,
                track_id=f"retention-test:{kind}:2",
                plate_normalised="ZZ99RT0002",
                crop_key=keys["closed_alert"],
            )
        )
        for name, status in (
            ("open", AlertStatus.ACKNOWLEDGED.value),
            ("closed", AlertStatus.CLOSED.value),
        ):
            session.add(
                Alert(
                    detection_id=ids[name],
                    detection_ts=now,
                    alert_type=AlertType.WATCHLIST_HIT.value,
                    priority=Priority.HIGH.value,
                    status=status,
                    plate_normalised=f"ZZ99RT000{1 if name == 'open' else 2}",
                )
            )
        await session.commit()

    yield kind, keys

    async with SessionLocal() as session:
        await session.execute(delete(Alert).where(Alert.detection_id.in_(ids.values())))
        await session.execute(delete(Detection).where(Detection.id.in_(ids.values())))
        await session.commit()
    async with aioboto3.Session().client("s3", **retention._s3_kwargs()) as s3:
        await s3.delete_objects(
            Bucket=settings.minio_bucket,
            Delete={"Objects": [{"Key": key} for key in keys.values()], "Quiet": True},
        )


async def _present(keys: dict[str, str]) -> set[str]:
    found = set()
    async with aioboto3.Session().client("s3", **retention._s3_kwargs()) as s3:
        for name, key in keys.items():
            listing = await s3.list_objects_v2(Bucket=settings.minio_bucket, Prefix=key)
            if listing.get("KeyCount", 0):
                found.add(name)
    return found


def _cutoff() -> datetime:
    return datetime.now(UTC) - timedelta(days=settings.retention_media_days)


class TestCropExpiry:
    async def test_expired_crops_go_and_open_alert_evidence_stays(self, crop_tree) -> None:
        kind, keys = crop_tree
        result = await retention.expire_crops(_cutoff(), dry_run=False, kinds={kind})

        assert await _present(keys) == {"open_alert", "open_alert_read", "recent"}
        assert result.deleted == 2  # the unreferenced one and the closed alert's
        assert result.kept_for_open_alerts == 2
        assert result.days_expired == [f"{retention.CROPS_PREFIX}{kind}/2020/01/01/"]

    async def test_a_dry_run_deletes_nothing_and_says_what_it_would(self, crop_tree) -> None:
        kind, keys = crop_tree
        result = await retention.expire_crops(_cutoff(), dry_run=True, kinds={kind})
        assert await _present(keys) == set(keys)
        assert result.deleted == 2

    async def test_open_alert_crops_are_found_from_both_places(self, crop_tree) -> None:
        _, keys = crop_tree
        async with SessionLocal() as session:
            protected = await retention.protected_crop_keys(session)
        assert {keys["open_alert"], keys["open_alert_read"]} <= protected
        assert keys["closed_alert"] not in protected

    async def test_the_scheduled_sweep_reports_crops(self) -> None:
        result = await retention.sweep(dry_run=True)
        assert "crops_deleted" in result.to_dict()
        assert not [e for e in result.errors if e.startswith("crops")], result.errors
