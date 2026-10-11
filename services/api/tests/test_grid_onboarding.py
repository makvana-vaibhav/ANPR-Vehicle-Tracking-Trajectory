"""Onboarding the organisers' camera grid.

Each test here pins a failure that kept the grid's 30 cameras out of the
platform: a session cookie renamed along with this product, a catalogue whose
names now carry what its location field used to, a gazetteer the API
container could not see, and departments either guessed or never recorded.
"""

from __future__ import annotations

import importlib.util
from functools import partial
from pathlib import Path

import httpx
import pytest

from app.adapters.base import DiscoveredCamera
from app.adapters.sandbox import _camera_name
from app.services import grid_session as grid_session_module
from app.services.grid_session import SESSION_COOKIE, GridSession, rejection_reason

_SYNC_PATH = Path(__file__).resolve().parents[3] / "scripts" / "sync_sandbox.py"


def _load_sync():
    spec = importlib.util.spec_from_file_location("sync_sandbox_under_test", _SYNC_PATH)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


sync = _load_sync()


def _camera(external_id: str, name: str, **raw: object) -> DiscoveredCamera:
    return DiscoveredCamera(
        external_id=external_id, name=name, raw={"id": external_id, "name": name, **raw}
    )


class TestSessionCookie:
    def test_the_cookie_name_is_the_grids_not_ours(self) -> None:
        """The organisers' system is Sentinel; renaming this product renamed it
        too once, and every successful login was then logged as rejected."""
        assert SESSION_COOKIE == "sentinel"

    @pytest.fixture
    def grid(self, monkeypatch: pytest.MonkeyPatch):
        """A GridSession whose HTTP calls go to a handler instead of the grid."""
        from app.core.config import settings

        monkeypatch.setattr(settings, "sandbox_rtsp_username", "team@example.org")
        monkeypatch.setattr(settings, "sandbox_rtsp_password", "not-a-real-password")
        responses: list[httpx.Response] = []

        def handler(request: httpx.Request) -> httpx.Response:
            assert request.url.path == "/auth/login"
            return responses.pop(0)

        real_client = httpx.AsyncClient
        monkeypatch.setattr(
            grid_session_module.httpx,
            "AsyncClient",
            partial(real_client, transport=httpx.MockTransport(handler)),
        )
        return GridSession(), responses

    async def test_a_redirect_with_the_grids_cookie_is_a_session(self, grid) -> None:
        session, responses = grid
        responses.append(
            httpx.Response(302, headers={"location": "/", "set-cookie": "sentinel=abc123; Path=/"})
        )
        assert await session.cookie() == "sentinel=abc123"

    async def test_a_re_rendered_form_is_a_refusal(self, grid) -> None:
        session, responses = grid
        responses.append(
            httpx.Response(200, text="<form><p class=error>Invalid email or password</p></form>")
        )
        assert await session.cookie() is None


class TestRejectionReason:
    def test_the_grids_own_words_are_kept(self) -> None:
        page = """
            <html><head><title>Sign in · Sentinel</title></head>
            <body><div class="alert">The system is in restricted mode right now —
            only priority operators can sign in.</div><form>…</form></body></html>
        """
        assert rejection_reason(page) == (
            "The system is in restricted mode right now — only priority operators can sign in."
        )

    def test_script_text_is_not_mistaken_for_a_reason(self) -> None:
        page = "<script>if (invalid) { show() }</script><p>Welcome back</p>"
        assert rejection_reason(page) is None

    def test_a_page_with_no_reason_says_so(self) -> None:
        assert rejection_reason("<html><body><form></form></body></html>") is None


class TestCatalogueNames:
    """Since October the catalogue carries only `id` and `name`."""

    def test_the_grids_running_number_is_dropped(self) -> None:
        item = {"id": "cam06", "name": "06 Timbavadi gate-Junagadh"}
        assert _camera_name(item, "cam06") == "Timbavadi gate-Junagadh"

    def test_a_name_without_a_number_is_left_alone(self) -> None:
        item = {"id": "cam30", "name": "Gandhidham Rambaugh p2"}
        assert _camera_name(item, "cam30") == "Gandhidham Rambaugh p2"

    def test_location_still_wins_when_the_grid_publishes_it(self) -> None:
        item = {"id": "cam02", "name": "Camera 2", "location": "02 Janpath"}
        assert _camera_name(item, "cam02") == "Janpath"


class TestPlacement:
    def test_the_gazetteer_is_found_where_the_seed_data_is(self) -> None:
        """It lives at /data/seed in the containers, not beside the script."""
        assert sync.GAZETTEER.exists(), sync.GAZETTEER
        assert sync.load_gazetteer()

    def test_a_name_only_camera_is_placed_from_its_name(self) -> None:
        camera = _camera("cam06", "Timbavadi gate-Junagadh")
        camera.raw["name"] = "06 Timbavadi gate-Junagadh"
        hit = sync.place(sync.location_text(camera), sync.load_gazetteer())
        assert hit is not None and hit["place"] == "Junagadh"

    def test_an_unknown_place_is_left_unplaced(self) -> None:
        camera = _camera("cam23", "kheram")
        assert sync.place(sync.location_text(camera), sync.load_gazetteer()) is None

    def test_the_junction_label_drops_the_running_number(self) -> None:
        assert sync.without_index("12 Tri Mandir Adalaj Tollnaka") == "Tri Mandir Adalaj Tollnaka"
        assert sync.without_index("Gandhidham Rambaugh p2") == "Gandhidham Rambaugh p2"


class TestDepartments:
    DEPARTMENTS = {"POLICE": "p", "GSRTC": "g", "PANCHAYAT": "k", "HEALTH": "h", "MUNICIPAL": "m"}

    def test_a_published_department_wins(self) -> None:
        camera = _camera("cam04", "Paldi Circle", department="Police")
        assert sync.owner_of(camera, self.DEPARTMENTS) == ("p", "catalogue")

    @pytest.mark.parametrize(
        ("name", "expected"),
        [
            ("Rajkot Bus Port CCTV", "g"),
            ("KHAPARIA GRAM PANCHAYAT , TALUKA GANDEVI, DISTRICT NAVSARI", "k"),
            ("Delight RLVD", "p"),
        ],
    )
    def test_a_name_that_names_the_owner_is_attributed(self, name: str, expected: str) -> None:
        assert sync.owner_of(_camera("x", name), self.DEPARTMENTS) == (expected, "name")

    def test_a_bare_junction_is_left_unattributed_rather_than_guessed(self) -> None:
        assert sync.owner_of(_camera("cam04", "Paldi Circle"), self.DEPARTMENTS) == (None, "none")
