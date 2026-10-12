"""The alert queue an operator triages.

Two failures this pins. Newest-first put a critical watchlist hit below every
camera that had gone dark since. And nothing closed a camera-down alert when
the camera came back, so the queue went on saying a camera was unreachable
beside a fleet screen showing it online.
"""

from __future__ import annotations

import uuid
from datetime import UTC, datetime, timedelta

import pytest
from httpx import AsyncClient
from sqlalchemy import delete, select

from app.db.session import SessionLocal
from app.models.enums import AlertStatus, AlertType
from app.models.intelligence import Alert
from app.models.registry import Camera
from app.services import health_monitor

pytestmark = pytest.mark.integration


@pytest.fixture
async def queue():
    """Four alerts on one throwaway plate, newest last in severity order."""
    plate = f"ZZTRIAGE{uuid.uuid4().hex[:4].upper()}"
    now = datetime.now(UTC)
    specs = [
        ("critical-hit", AlertType.WATCHLIST_HIT.value, "critical", now - timedelta(minutes=40)),
        ("high-hit", AlertType.WATCHLIST_HIT.value, "high", now - timedelta(minutes=30)),
        ("high-anomaly", AlertType.ANOMALY.value, "high", now - timedelta(minutes=20)),
        ("medium-anomaly", AlertType.ANOMALY.value, "medium", now - timedelta(minutes=10)),
    ]
    ids: dict[str, uuid.UUID] = {}
    async with SessionLocal() as session:
        for name, kind, priority, created in specs:
            alert = Alert(
                id=uuid.uuid4(),
                alert_type=kind,
                priority=priority,
                status=AlertStatus.NEW.value,
                plate_normalised=plate,
                created_at=created,
            )
            session.add(alert)
            ids[name] = alert.id
        await session.commit()
    yield plate, ids
    async with SessionLocal() as session:
        await session.execute(delete(Alert).where(Alert.plate_normalised == plate))
        await session.commit()


class TestTriageOrder:
    async def test_most_severe_first_and_a_watchlist_hit_before_an_inference(
        self, client: AsyncClient, auth_headers, queue
    ) -> None:
        plate, ids = queue
        response = await client.get(
            "/api/v1/alerts",
            params={"plate": plate, "sort": "priority"},
            headers=await auth_headers("operator"),
        )
        assert response.status_code == 200, response.text
        order = [item["id"] for item in response.json()["items"]]
        assert order == [
            str(ids["critical-hit"]),
            str(ids["high-hit"]),
            str(ids["high-anomaly"]),
            str(ids["medium-anomaly"]),
        ]

    async def test_a_watchlist_hit_outranks_an_anomaly_at_any_severity(
        self, client: AsyncClient, auth_headers
    ) -> None:
        """A trajectory anomaly is a journey to explain; a watchlist hit is a
        known vehicle read now. Even a high anomaly waits behind a low hit —
        and behind a near match, which is still a lead on a listed vehicle."""
        plate = f"ZZTRIAGE{uuid.uuid4().hex[:4].upper()}"
        now = datetime.now(UTC)
        specs = [
            ("critical-anomaly", AlertType.ANOMALY.value, "critical", now),
            ("high-anomaly", AlertType.ANOMALY.value, "high", now - timedelta(minutes=1)),
            ("low-hit", AlertType.WATCHLIST_HIT.value, "low", now - timedelta(minutes=50)),
            ("medium-near", AlertType.POSSIBLE_MATCH.value, "medium", now - timedelta(minutes=40)),
            ("medium-hit", AlertType.WATCHLIST_HIT.value, "medium", now - timedelta(minutes=60)),
        ]
        ids: dict[str, uuid.UUID] = {}
        async with SessionLocal() as session:
            for name, kind, priority, created in specs:
                alert = Alert(
                    id=uuid.uuid4(),
                    alert_type=kind,
                    priority=priority,
                    status=AlertStatus.NEW.value,
                    plate_normalised=plate,
                    created_at=created,
                )
                session.add(alert)
                ids[name] = alert.id
            await session.commit()
        try:
            response = await client.get(
                "/api/v1/alerts",
                params={"plate": plate, "sort": "priority"},
                headers=await auth_headers("operator"),
            )
            assert response.status_code == 200, response.text
            order = [item["id"] for item in response.json()["items"]]
            assert order == [
                str(ids["medium-hit"]),
                str(ids["medium-near"]),
                str(ids["low-hit"]),
                str(ids["critical-anomaly"]),
                str(ids["high-anomaly"]),
            ]
        finally:
            async with SessionLocal() as session:
                await session.execute(delete(Alert).where(Alert.plate_normalised == plate))
                await session.commit()

    async def test_newest_first_is_still_there_when_asked_for(
        self, client: AsyncClient, auth_headers, queue
    ) -> None:
        plate, ids = queue
        response = await client.get(
            "/api/v1/alerts", params={"plate": plate}, headers=await auth_headers("operator")
        )
        order = [item["id"] for item in response.json()["items"]]
        assert order[0] == str(ids["medium-anomaly"])

    async def test_an_unknown_order_is_refused(self, client: AsyncClient, auth_headers) -> None:
        response = await client.get(
            "/api/v1/alerts", params={"sort": "loudest"}, headers=await auth_headers("operator")
        )
        assert response.status_code == 422


class TestRecoveryClosesTheAlert:
    async def test_a_camera_reachable_again_has_its_alert_closed_with_a_note(self) -> None:
        async with SessionLocal() as session:
            camera = await session.scalar(select(Camera).order_by(Camera.camera_code).limit(1))
            if camera is None:
                pytest.skip("no cameras seeded")
            alert = Alert(
                id=uuid.uuid4(),
                camera_id=camera.id,
                alert_type=AlertType.CAMERA_DOWN.value,
                priority="high",
                status=AlertStatus.NEW.value,
                notes=f"{camera.camera_code} unreachable: test",
            )
            session.add(alert)
            await session.commit()
            alert_id = alert.id

        try:
            async with SessionLocal() as session:
                await health_monitor._resolve_recovered(session, [camera.id], set())
                await session.commit()
            async with SessionLocal() as session:
                stored = await session.get(Alert, alert_id)
            assert stored is not None
            assert stored.status == AlertStatus.CLOSED.value
            assert "Closed automatically" in (stored.notes or "")
            assert "unreachable: test" in (stored.notes or ""), "the original note was lost"
        finally:
            async with SessionLocal() as session:
                await session.execute(delete(Alert).where(Alert.id == alert_id))
                await session.commit()

    async def test_an_integration_answering_again_closes_its_alert(self) -> None:
        vms_id = uuid.uuid4()
        async with SessionLocal() as session:
            alert = Alert(
                id=uuid.uuid4(),
                alert_type=AlertType.CAMERA_DOWN.value,
                priority="high",
                status=AlertStatus.NEW.value,
                notes=f"Integration unreachable: test grid [vms:{vms_id}]",
            )
            session.add(alert)
            await session.commit()
            alert_id = alert.id

        try:
            async with SessionLocal() as session:
                await health_monitor._resolve_recovered(session, [], {vms_id})
                await session.commit()
            async with SessionLocal() as session:
                stored = await session.get(Alert, alert_id)
            assert stored is not None and stored.status == AlertStatus.CLOSED.value
        finally:
            async with SessionLocal() as session:
                await session.execute(delete(Alert).where(Alert.id == alert_id))
                await session.commit()

    async def test_an_integration_still_down_keeps_its_alert(self) -> None:
        vms_id = uuid.uuid4()
        async with SessionLocal() as session:
            alert = Alert(
                id=uuid.uuid4(),
                alert_type=AlertType.CAMERA_DOWN.value,
                priority="high",
                status=AlertStatus.NEW.value,
                notes=f"Integration unreachable: test grid [vms:{vms_id}]",
            )
            session.add(alert)
            await session.commit()
            alert_id = alert.id

        try:
            async with SessionLocal() as session:
                await health_monitor._resolve_recovered(session, [], {uuid.uuid4()})
                await session.commit()
            async with SessionLocal() as session:
                stored = await session.get(Alert, alert_id)
            assert stored is not None and stored.status == AlertStatus.NEW.value
        finally:
            async with SessionLocal() as session:
                await session.execute(delete(Alert).where(Alert.id == alert_id))
                await session.commit()
