"""Fleet health, gap analysis, and the stream gateway.

Camera health monitoring, coverage and capability gap reporting, and the
audited stream-token flow.
"""

from __future__ import annotations

import uuid
from datetime import date

import pytest
from httpx import AsyncClient
from sqlalchemy import delete

from app.db.session import SessionLocal
from app.models.registry import Camera
from app.services import fleet

#: A floor, not a count. The Ahmedabad fleet is ~58 cameras
#: (scripts/generate_ahmedabad_cameras.py) and federated sources add to it, so
#: an exact figure would fail the moment the registry does its job.
#:
#: It is deliberately a floor rather than a large number: the registry was once
#: seeded with 250 synthetic rows, 251 of 281 of which had no stream URL at all
#: and so could never be watched, analysed, or even be unhealthy. Asserting a
#: count in the hundreds tested that a CSV had loaded, not that the platform
#: worked. What matters is that a real fleet is onboarded and every screen
#: agrees about its size.
ONBOARDED_FLEET = 10

pytestmark = pytest.mark.integration


class TestFleetHealthEndpoint:
    async def test_reports_the_whole_estate(self, client: AsyncClient, auth_headers) -> None:
        body = (
            await client.get("/api/v1/health/fleet", headers=await auth_headers("operator"))
        ).json()

        assert body["total"] >= ONBOARDED_FLEET
        assert (body["online"] + body["offline"] + body["degraded"] + body["unknown"]) == body[
            "total"
        ]

    async def test_separates_integrated_from_registered(
        self, client: AsyncClient, auth_headers
    ) -> None:
        """Availability over the whole registry would understate the health of
        the estate we actually operate, and overstate an outage."""
        body = (
            await client.get("/api/v1/health/fleet", headers=await auth_headers("operator"))
        ).json()

        assert body["integrated"] == body["online"] + body["offline"] + body["degraded"]
        assert body["awaiting_integration"] == body["unknown"]
        assert body["integrated"] + body["awaiting_integration"] == body["total"]

    async def test_breaks_down_by_department_and_vendor(
        self, client: AsyncClient, auth_headers
    ) -> None:
        """A commissioner needs to see which department is degrading, not just
        a statewide average."""
        body = (
            await client.get("/api/v1/health/fleet", headers=await auth_headers("supervisor"))
        ).json()

        assert len(body["by_department"]) >= 1
        assert sum(r["total"] for r in body["by_department"]) >= ONBOARDED_FLEET

        # What matters is that every vendor row represents real cameras — not
        # how many rows there are.
        #
        # The seed once registered four extra VMS instances — Milestone,
        # Genetec, CP Plus, Hikvision — each `adapter_type: simulated` with not
        # one camera behind it. A "at least N vendors" assertion passed happily
        # on those while the breakdown represented no integration at all, which
        # is the failure worth guarding against. Counting rows cannot catch it;
        # requiring every row to have cameras can.
        #
        # This also stopped being a count the fleet could satisfy: the hosted
        # grid federates **zero** cameras today (it is a removal candidate —
        # CLAUDE.md §10), so the honest number of vendors actually carrying
        # traffic is one. The multi-vendor claim is asserted where it is true:
        # the adapter registry below reports the interface's real
        # implementations, which are code and are unit-tested.
        vendors = body["by_vendor"]
        assert vendors, "fleet health must break the estate down by vendor"
        assert all(
            row["total"] > 0 for row in vendors
        ), f"a vendor row with no cameras represents no integration: {vendors}"
        assert sum(row["total"] for row in vendors) >= ONBOARDED_FLEET

    async def test_the_adapter_interface_covers_more_than_is_connected(
        self, client: AsyncClient, auth_headers
    ) -> None:
        """Capability and deployment are different claims and are reported apart."""
        body = (
            await client.get(
                "/api/v1/integration/adapters", headers=await auth_headers("supervisor")
            )
        ).json()
        assert set(body["adapters"]) >= {"rtsp", "onvif", "vendor_api"}

    async def test_groups_failure_causes(self, client: AsyncClient, auth_headers) -> None:
        """Grouping by error code turns many symptoms into one root cause."""
        body = (
            await client.get("/api/v1/health/fleet", headers=await auth_headers("operator"))
        ).json()

        assert isinstance(body["top_errors"], list)
        for entry in body["top_errors"]:
            assert {"error_code", "count"} <= entry.keys()

    async def test_requires_authentication(self, client: AsyncClient) -> None:
        assert (await client.get("/api/v1/health/fleet")).status_code == 401


class TestGapAnalysis:
    """ "Where are we blind?" — a different question from "what is broken?"."""

    async def test_reports_four_distinct_gap_types(self, client: AsyncClient, auth_headers) -> None:
        body = (
            await client.get("/api/v1/health/gaps", headers=await auth_headers("supervisor"))
        ).json()

        assert {
            "availability_gaps",
            "capability_gaps",
            "coverage_gaps",
            "reliability_gaps",
        } <= body.keys()

    async def test_coverage_gaps_are_gujarat_districts_with_no_camera(
        self, client: AsyncClient, auth_headers
    ) -> None:
        """A blind district is one a vehicle can cross entirely unobserved.

        Over Gujarat's 33 districts by each camera's position — it used to be
        seven hard-coded Ahmedabad talukas, so a statewide grid could never
        show a blind district. This asserts the report is *correct* rather
        than that gaps exist: a fully covered state is a passing state.
        """
        body = (
            await client.get("/api/v1/health/gaps", headers=await auth_headers("analyst"))
        ).json()
        districts = {name for name, _ in fleet.gujarat_districts()}
        assert len(districts) == 33
        assert body["geography"]["districts"] == 33

        with_cameras = {d["district"] for d in body["district_coverage"] if d["cameras"] > 0}
        uncovered = {gap["district"] for gap in body["coverage_gaps"]}
        assert not uncovered & with_cameras
        assert uncovered | with_cameras == districts
        assert uncovered <= districts, f"not a Gujarat district: {uncovered - districts}"

    async def test_recordings_and_unplaced_cameras_cover_nowhere(
        self, client: AsyncClient, auth_headers
    ) -> None:
        """A looping clip covers no road, and a camera nobody can place covers
        no district; both are named apart rather than counted."""
        body = (
            await client.get("/api/v1/health/gaps", headers=await auth_headers("analyst"))
        ).json()
        geography = body["geography"]
        counted = sum(d["cameras"] for d in body["district_coverage"])
        apart = (
            len(geography["position_unknown"])
            + len(geography["recorded_footage"])
            + len(geography["outside_gujarat"])
        )
        fleet_total = (
            await client.get("/api/v1/health/fleet", headers=await auth_headers("analyst"))
        ).json()["total"]
        assert counted + apart == fleet_total
        assert not set(geography["recorded_footage"]) & set(geography["position_unknown"])

    async def test_a_camera_counts_where_it_stands_not_where_its_text_says(
        self, ageing_camera
    ) -> None:
        """Placed in the Dang by position, whatever its `district` text says."""
        code, _ = ageing_camera
        async with SessionLocal() as session:
            gaps = await fleet.gap_analysis(session)
        dang = next(d for d in gaps["district_coverage"] if d["district"] == "Dang")
        assert dang["cameras"] >= 1
        assert "Dang" not in {g["district"] for g in gaps["coverage_gaps"]}
        assert code not in gaps["geography"]["position_unknown"]

    async def test_ageing_cameras_and_unknown_install_dates_are_reported(
        self, ageing_camera
    ) -> None:
        code, undated = ageing_camera
        async with SessionLocal() as session:
            gaps = await fleet.gap_analysis(session)
        ageing = {g["camera_code"]: g for g in gaps["ageing_gaps"]}
        assert code in ageing
        assert ageing[code]["installed_on"] == "2014-03-01"
        assert ageing[code]["age_years"] >= 12
        assert "review after" in ageing[code]["reason"]
        unknown = gaps["install_date_unknown"]
        assert undated in unknown["camera_codes"]
        assert code not in unknown["camera_codes"], "a dated camera reported as undated"
        assert unknown["cameras"] == gaps["summary"]["install_date_unknown"]
        assert "nothing is assumed" in unknown["reason"]

    def test_points_fall_in_the_right_district(self) -> None:
        assert fleet.district_at(23.0146, 72.5635) == "Ahmedabad"  # Paldi
        assert fleet.district_at(21.5033, 70.4335) == "Junagadh"  # Timbavadi
        assert fleet.district_at(23.9166, 72.3611) == "Patan"  # Dethali, Siddhpur
        assert fleet.district_at(10.0, 76.0) is None  # Kerala
        assert fleet.district_at(None, 72.0) is None

    async def test_every_gap_explains_itself(self, client: AsyncClient, auth_headers) -> None:
        """A report saying only "gap" is not actionable."""
        body = (
            await client.get("/api/v1/health/gaps", headers=await auth_headers("analyst"))
        ).json()

        for gap in body["coverage_gaps"] + body["capability_gaps"]:
            assert gap.get("reason")

    async def test_district_coverage_totals_match_the_fleet(
        self, client: AsyncClient, auth_headers
    ) -> None:
        body = (
            await client.get("/api/v1/health/gaps", headers=await auth_headers("analyst"))
        ).json()

        assert sum(d["cameras"] for d in body["district_coverage"]) >= ONBOARDED_FLEET


@pytest.fixture
async def ageing_camera():
    """One camera installed in 2014 in the Dang (text says otherwise), one undated."""
    tag = uuid.uuid4().hex[:6]
    dated, undated = f"ZZTEST-GAP-{tag}-OLD", f"ZZTEST-GAP-{tag}-NEW"
    async with SessionLocal() as session:
        session.add_all(
            [
                Camera(
                    camera_code=dated,
                    name="Test ageing camera",
                    district="Somewhere else entirely",
                    location="SRID=4326;POINT(73.70 20.80)",
                    status="unknown",
                    anpr_enabled=False,
                    installed_on=date(2014, 3, 1),
                    tags=["zztest"],
                ),
                Camera(
                    camera_code=undated,
                    name="Test undated camera",
                    location="SRID=4326;POINT(73.70 20.80)",
                    status="unknown",
                    anpr_enabled=False,
                    tags=["zztest"],
                ),
            ]
        )
        await session.commit()
    yield dated, undated
    async with SessionLocal() as session:
        await session.execute(delete(Camera).where(Camera.camera_code.in_((dated, undated))))
        await session.commit()


class TestCameraHealthHistory:
    async def test_returns_probe_history_and_uptime(
        self, client: AsyncClient, auth_headers
    ) -> None:
        headers = await auth_headers("operator")
        page = (await client.get("/api/v1/cameras?limit=1", headers=headers)).json()
        camera_id = page["items"][0]["id"]

        body = (await client.get(f"/api/v1/cameras/{camera_id}/health", headers=headers)).json()

        assert body["camera_id"] == camera_id
        assert "uptime" in body
        assert isinstance(body["history"], list)

    async def test_unknown_camera_is_404(self, client: AsyncClient, auth_headers) -> None:
        response = await client.get(
            "/api/v1/cameras/11111111-1111-1111-1111-111111111111/health",
            headers=await auth_headers("operator"),
        )
        assert response.status_code == 404


class TestIntegrationAdapters:
    async def test_lists_every_supported_protocol(self, client: AsyncClient, auth_headers) -> None:
        """The interoperability evidence: one interface, many vendors."""
        body = (
            await client.get("/api/v1/integration/adapters", headers=await auth_headers("operator"))
        ).json()

        assert {"rtsp", "onvif", "vendor_api", "hosted_grid"} <= body["adapters"].keys()


class TestStreamGateway:
    """Opening a live feed — the most privacy-sensitive routine action."""

    async def _first_camera_id(self, client: AsyncClient, headers: dict) -> str:
        page = (await client.get("/api/v1/cameras?limit=1", headers=headers)).json()
        return page["items"][0]["id"]

    async def test_issues_a_camera_scoped_token(self, client: AsyncClient, auth_headers) -> None:
        headers = await auth_headers("operator")
        camera_id = await self._first_camera_id(client, headers)

        response = await client.get(f"/api/v1/cameras/{camera_id}/stream", headers=headers)

        assert response.status_code == 200
        grant = response.json()
        assert grant["camera_id"] == camera_id
        assert grant["token"]
        # Short-lived: a URL leaked from browser history dies quickly.
        assert grant["expires_in"] <= 300
        assert grant["whep_url"]
        assert grant["hls_url"], "HLS fallback must be offered when WebRTC is blocked"

    async def test_token_is_verifiable(self, client: AsyncClient, auth_headers) -> None:
        headers = await auth_headers("operator")
        camera_id = await self._first_camera_id(client, headers)
        grant = (await client.get(f"/api/v1/cameras/{camera_id}/stream", headers=headers)).json()

        verify = await client.get(
            f"/api/v1/streams/verify?token={grant['token']}&camera_id={camera_id}"
        )

        assert verify.status_code == 200
        assert verify.json()["valid"] is True

    async def test_token_for_one_camera_cannot_open_another(
        self, client: AsyncClient, auth_headers
    ) -> None:
        """Camera scoping is the point of the token."""
        headers = await auth_headers("operator")
        page = (await client.get("/api/v1/cameras?limit=2", headers=headers)).json()
        first, second = page["items"][0]["id"], page["items"][1]["id"]

        grant = (await client.get(f"/api/v1/cameras/{first}/stream", headers=headers)).json()

        verify = await client.get(
            f"/api/v1/streams/verify?token={grant['token']}&camera_id={second}"
        )
        assert verify.status_code == 403

    async def test_unauthenticated_token_request_is_rejected(
        self, client: AsyncClient, auth_headers
    ) -> None:
        headers = await auth_headers("operator")
        camera_id = await self._first_camera_id(client, headers)

        assert (await client.get(f"/api/v1/cameras/{camera_id}/stream")).status_code == 401

    async def test_garbage_token_is_rejected(self, client: AsyncClient) -> None:
        response = await client.get("/api/v1/streams/verify?token=not-a-token")
        assert response.status_code == 401

    @pytest.mark.parametrize("role", ["analyst", "auditor"])
    async def test_roles_without_stream_view_are_denied(
        self, client: AsyncClient, auth_headers, role: str
    ) -> None:
        """Analysts and auditors work over recorded detections, not live video."""
        admin = await auth_headers("admin")
        camera_id = await self._first_camera_id(client, admin)

        response = await client.get(
            f"/api/v1/cameras/{camera_id}/stream", headers=await auth_headers(role)
        )
        assert response.status_code == 403

    async def test_opening_a_stream_writes_an_audit_row(
        self, client: AsyncClient, auth_headers
    ) -> None:
        """One of the three actions CLAUDE.md promises to record."""
        from sqlalchemy import select

        from app.db.session import SessionLocal
        from app.models.security import AuditLog

        headers = await auth_headers("operator")
        camera_id = await self._first_camera_id(client, headers)

        await client.get(f"/api/v1/cameras/{camera_id}/stream", headers=headers)

        async with SessionLocal() as session:
            row = await session.scalar(
                select(AuditLog)
                .where(AuditLog.action == "camera.view")
                .order_by(AuditLog.ts.desc())
                .limit(1)
            )

        assert row is not None
        assert row.username == "operator"
        assert row.resource_id == camera_id

    async def test_stream_urls_are_not_exposed_without_a_token_request(
        self, client: AsyncClient, auth_headers
    ) -> None:
        """Listing cameras must never hand out unaudited viewing access."""
        headers = await auth_headers("operator")
        listing = (await client.get("/api/v1/cameras?limit=50", headers=headers)).text

        assert "whep" not in listing.lower()
        assert "rtsp://" not in listing
