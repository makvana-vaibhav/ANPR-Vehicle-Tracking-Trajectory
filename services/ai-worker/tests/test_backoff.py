"""Backoff: a refused camera is asked again politely, a refused login rarely.

The failure this guards against is the worker looking like an attack. When the
organisers' grid started refusing our login, every camera was re-opened on
every reconcile pass with a diagnosis connection on top — over a hundred
rejected logins a minute from one address, for as long as the refusal lasted.
"""

from __future__ import annotations

from ai_worker.backoff import Backoff, host_of
from ai_worker.discovery import CameraStream
from ai_worker.rotation import Rotation

GRID = host_of("rtsp://user:pw@103.250.160.189:8554/stream/cam01")
OURS = host_of("rtsp://mediamtx:8554/cam-demo-01")


def backoff() -> Backoff:
    return Backoff(base_s=2.0, cap_s=30.0, account_base_s=120.0, account_cap_s=900.0)


class TestOneCameraDown:
    def test_retries_double_from_two_seconds_and_cap_at_thirty(self) -> None:
        """The integration guide's own numbers: ~2s rising to ~30s."""
        b = backoff()
        delays = [b.failed("SBX-cam04", GRID, "not found", 0.0) for _ in range(7)]
        assert delays == [2.0, 4.0, 8.0, 16.0, 30.0, 30.0, 30.0]

    def test_a_camera_is_not_asked_again_before_its_delay(self) -> None:
        b = backoff()
        b.failed("SBX-cam04", GRID, "timeout", 100.0)
        assert not b.admit("SBX-cam04", GRID, 101.0)
        assert b.admit("SBX-cam04", GRID, 102.0)

    def test_one_camera_down_holds_back_no_other(self) -> None:
        b = backoff()
        b.failed("SBX-cam04", GRID, "opened but no media", 100.0)
        assert b.admit("SBX-cam05", GRID, 100.0)

    def test_opening_resets_the_delay(self) -> None:
        b = backoff()
        for _ in range(4):
            b.failed("SBX-cam04", GRID, "timeout", 0.0)
        b.opened("SBX-cam04", GRID)
        assert b.failed("SBX-cam04", GRID, "timeout", 0.0) == 2.0

    def test_a_loop_that_exited_backs_off_too(self) -> None:
        """Not only failed opens: a loop that keeps dying is not restarted in
        a tight loop either."""
        b = backoff()
        assert b.failed("SBX-cam04", GRID, "exited", 0.0) == 2.0
        assert not b.admit("SBX-cam04", GRID, 1.0)


class TestRefusedLogin:
    def test_pauses_every_camera_on_that_host(self) -> None:
        """A rejected login is about the account: asking from every camera
        only multiplies the refusals."""
        b = backoff()
        delay = b.failed("SBX-cam01", GRID, "unauthorized", 0.0)
        assert delay == 120.0
        assert not any(b.admit(f"SBX-cam{i:02d}", GRID, 60.0) for i in range(1, 31))

    def test_leaves_cameras_on_other_hosts_alone(self) -> None:
        """The recorded fallback camera must keep playing while the grid is
        refusing us — that is what it is for."""
        b = backoff()
        b.failed("SBX-cam01", GRID, "unauthorized", 0.0)
        assert b.admit("CAM-DEMO-01", OURS, 1.0)

    def test_after_the_pause_exactly_one_camera_asks(self) -> None:
        b = backoff()
        b.failed("SBX-cam01", GRID, "unauthorized", 0.0)
        admitted = [
            code
            for code in ("SBX-cam02", "SBX-cam03", "SBX-cam04")
            if b.admit(code, GRID, 121.0)
        ]
        assert admitted == ["SBX-cam02"]

    def test_the_probe_may_be_asked_about_twice(self) -> None:
        """Admitting is idempotent for the camera that holds the probe."""
        b = backoff()
        b.failed("SBX-cam01", GRID, "unauthorized", 0.0)
        assert b.admit("SBX-cam02", GRID, 121.0)
        assert b.admit("SBX-cam02", GRID, 122.0)

    def test_a_refused_probe_doubles_the_pause_up_to_the_cap(self) -> None:
        b = backoff()
        now, delays = 0.0, []
        delays.append(b.failed("SBX-cam01", GRID, "unauthorized", now))
        for _ in range(5):
            now += delays[-1]
            assert b.admit("SBX-cam02", GRID, now)
            delays.append(b.failed("SBX-cam02", GRID, "unauthorized", now))
        assert delays == [120.0, 240.0, 480.0, 900.0, 900.0, 900.0]

    def test_a_probe_that_opens_resumes_the_whole_host(self) -> None:
        b = backoff()
        b.failed("SBX-cam01", GRID, "unauthorized", 0.0)
        assert b.admit("SBX-cam02", GRID, 121.0)
        b.opened("SBX-cam02", GRID)
        assert all(b.admit(f"SBX-cam{i:02d}", GRID, 121.0) for i in range(1, 31))
        assert b.paused_hosts(121.0) == {}

    def test_after_recovering_a_new_refusal_starts_from_the_base_pause(self) -> None:
        b = backoff()
        b.failed("SBX-cam01", GRID, "unauthorized", 0.0)
        b.admit("SBX-cam02", GRID, 121.0)
        b.failed("SBX-cam02", GRID, "unauthorized", 121.0)
        b.admit("SBX-cam03", GRID, 400.0)
        b.opened("SBX-cam03", GRID)
        assert b.failed("SBX-cam04", GRID, "unauthorized", 500.0) == 120.0

    def test_late_refusals_from_the_same_burst_do_not_escalate(self) -> None:
        """Twelve cameras opened together are refused together. That is one
        incident, not twelve doublings of the pause."""
        b = backoff()
        first = b.failed("SBX-cam01", GRID, "unauthorized", 0.0)
        later = [
            b.failed(f"SBX-cam{i:02d}", GRID, "unauthorized", 3.0) for i in (2, 3, 4)
        ]
        assert first == 120.0
        assert later == [117.0, 117.0, 117.0]
        assert b.paused_hosts(3.0) == {GRID: 117.0}

    def test_a_probe_failing_for_its_own_reasons_lets_the_next_camera_ask(self) -> None:
        """A camera that is down says nothing about the login; the host stays
        half-open, and another camera may try."""
        b = backoff()
        b.failed("SBX-cam01", GRID, "unauthorized", 0.0)
        assert b.admit("SBX-cam02", GRID, 121.0)
        b.failed("SBX-cam02", GRID, "not found", 121.0)
        assert b.admit("SBX-cam03", GRID, 121.0)
        assert b.paused_hosts(121.0) == {GRID: 0.0}

    def test_a_probe_stopped_before_it_answers_frees_the_question(self) -> None:
        b = backoff()
        b.failed("SBX-cam01", GRID, "unauthorized", 0.0)
        assert b.admit("SBX-cam02", GRID, 121.0)
        b.stopped("SBX-cam02", GRID)
        assert b.admit("SBX-cam03", GRID, 121.0)

    def test_a_departed_probe_frees_the_question(self) -> None:
        b = backoff()
        b.failed("SBX-cam01", GRID, "unauthorized", 0.0)
        b.admit("SBX-cam02", GRID, 121.0)
        b.retain({"SBX-cam01", "SBX-cam03"})
        assert b.admit("SBX-cam03", GRID, 121.0)

    def test_departed_cameras_leave_no_state(self) -> None:
        b = backoff()
        b.failed("SBX-cam04", GRID, "timeout", 0.0)
        b.retain({"SBX-cam05"})
        assert b.streak == {} and b.not_before == {}


class TestAnUnprovenHost:
    def test_is_asked_by_one_camera_before_the_rest(self) -> None:
        """A worker starting against a grid that is refusing it spends one
        login finding out, not one per camera."""
        b = backoff()
        assert b.admit("SBX-cam01", GRID, 0.0)
        assert not b.admit("SBX-cam02", GRID, 0.0)
        b.opened("SBX-cam01", GRID)
        assert b.admit("SBX-cam02", GRID, 1.0)
        assert b.admit("SBX-cam03", GRID, 1.0)

    def test_a_refusal_unproves_it(self) -> None:
        b = backoff()
        b.admit("SBX-cam01", GRID, 0.0)
        b.opened("SBX-cam01", GRID)
        b.failed("SBX-cam02", GRID, "unauthorized", 10.0)
        assert b.admit("SBX-cam03", GRID, 131.0)
        assert not b.admit("SBX-cam04", GRID, 131.0)

    def test_a_camera_down_does_not_unprove_it(self) -> None:
        b = backoff()
        b.admit("SBX-cam01", GRID, 0.0)
        b.opened("SBX-cam01", GRID)
        b.failed("SBX-cam02", GRID, "not found", 10.0)
        assert b.admit("SBX-cam03", GRID, 10.0)
        assert b.admit("SBX-cam04", GRID, 10.0)


class TestRotationAsksTheBackoff:
    @staticmethod
    def _streams(*codes: str) -> list[CameraStream]:
        return [
            CameraStream(camera_code=c, rtsp_url=f"rtsp://grid:8554/{c}") for c in codes
        ]

    def test_a_camera_backing_off_does_not_cost_a_slot(self) -> None:
        r = Rotation(slots=2, slice_seconds=30.0)
        r.update_assignment(self._streams("A", "B", "C"))
        chosen = r.next_up(admit=lambda s: s.camera_code != "A")
        assert [s.camera_code for s in chosen] == ["B", "C"]

    def test_admission_is_asked_only_until_the_slots_are_full(self) -> None:
        """Admitting reserves a probe, so it must not be asked of a camera
        that will not be started anyway."""
        r = Rotation(slots=1, slice_seconds=30.0)
        r.update_assignment(self._streams("A", "B", "C"))
        asked: list[str] = []

        def admit(stream: CameraStream) -> bool:
            asked.append(stream.camera_code)
            return True

        r.next_up(admit=admit)
        assert asked == ["A"]
