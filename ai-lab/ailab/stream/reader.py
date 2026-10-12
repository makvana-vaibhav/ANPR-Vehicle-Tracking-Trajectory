"""Threaded frame reader with drop-to-latest semantics.

A file and a live camera differ in one way that changes the whole design: a file
waits for you, a camera does not. If inference takes 300 ms and the camera
produces a frame every 33 ms, something has to give. There are only three
options and only one of them is right for CCTV:

  block the reader     the decoder's buffer fills, then the RTSP connection
                       stalls or the server drops us. Recovery is a reconnect,
                       and we lose everything in between.
  queue everything     memory grows without bound and latency grows with it.
                       After a minute we are confidently reporting where a car
                       was a minute ago, which is worse than useless for alerts.
  drop to latest       decode continuously, keep only the newest frame, let the
                       consumer take whatever is current.

The third is correct here because for ANPR the *current* frame is worth more
than a backlog of old ones. A vehicle is in view for dozens of frames; missing
some of them costs a little consensus evidence, while falling behind costs
alert latency, which is the thing the platform actually sells.

Dropped frames are counted, not hidden. A worker silently discarding 90% of its
input while reporting healthy throughput is a lie the operator cannot see.
"""

from __future__ import annotations

import os

# Set before OpenCV opens any FFmpeg capture. The NagarNetra integration guide is
# explicit that UDP "fails across NAT and most corporate firewalls" and that
# partial UDP delivery "produces corrupt frames that look like model bugs" —
# which is the worst failure mode available, because it sends you debugging the
# detector instead of the transport.
os.environ.setdefault("OPENCV_FFMPEG_CAPTURE_OPTIONS", "rtsp_transport;tcp")

import base64
import hashlib
import re
import secrets
import socket
import threading
import time
import urllib.error
import urllib.request
from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import Any
from urllib.parse import unquote, urlparse, urlunparse

import cv2
import numpy as np

from ailab import runtime
from ailab.logging import get_logger

log = get_logger(__name__)


class StreamUnavailable(RuntimeError):
    """The source could not be opened at all.

    Distinct from a stream that opens and then fails, because for a federated
    camera it is the *expected* state whenever the far end is down. A caller
    supervising many cameras wants to log this as a fact about one camera, not
    as an exception with a traceback — thirty unreachable cameras would
    otherwise bury every real fault in the log.

    Carries `reason`, because "unreachable" and "the far end rejected our
    credentials" call for completely different responses and OpenCV reports
    both as a bare False. Telling an operator to check the network when the
    real answer is a missing password costs hours.
    """

    def __init__(self, message: str, reason: str = "unknown") -> None:
        super().__init__(message)
        self.reason = reason


def redact(url: str) -> str:
    """A stream URL safe to log.

    RTSP credentials travel in the URL (`rtsp://user:pass@host/path`), so any
    code path that logs a source — and there are several: connection, retry,
    failure, the run report — would otherwise write the password to disk and
    to whatever ships those logs onward.
    """
    parsed = urlparse(url)
    if not parsed.password:
        return url
    safe = parsed._replace(
        netloc=f"{parsed.username or ''}:***@{parsed.hostname}"
        + (f":{parsed.port}" if parsed.port else "")
    )
    return urlunparse(safe)


def diagnose(url: str, timeout: float = 6.0) -> str:
    """Ask the far end why it would not open.

    `cv2.VideoCapture.isOpened()` returns False for a refused connection, a
    DNS failure, an authentication rejection and a missing path alike. This
    reproduces the first exchange by hand to recover the distinction:

        no route / refused   the host or port is wrong, or a firewall
        unauthorized         credentials are needed or were rejected
        not found            the host is right and the camera id is not
        timeout              the far end accepted and then went quiet
    """
    parsed = urlparse(url)
    host, port = parsed.hostname, parsed.port

    if parsed.scheme in ("http", "https"):
        try:
            request = urllib.request.Request(url, method="GET")
            with urllib.request.urlopen(request, timeout=timeout) as response:
                return "ok" if response.status == 200 else f"http {response.status}"
        except urllib.error.HTTPError as exc:
            if exc.code in (401, 403):
                return "unauthorized"
            if exc.code == 404:
                return "not found"
            return f"http {exc.code}"
        except (urllib.error.URLError, TimeoutError, OSError) as exc:
            return f"no route ({exc})"

    if parsed.scheme != "rtsp" or not host:
        return "unknown"

    port = port or 554
    target = _without_credentials(url)
    user = unquote(parsed.username) if parsed.username is not None else None
    secret = unquote(parsed.password or "")
    try:
        with socket.create_connection((host, port), timeout=timeout) as sock:
            sock.settimeout(timeout)
            # A DESCRIBE is the first request any RTSP client makes, and it is
            # what returns 401 when the server wants credentials.
            status, challenges = _describe(sock, target, 1)
            # Then answer the challenge with the credentials we hold, exactly
            # as FFmpeg does. This used to stop at the challenge, so a server
            # that requires a login answered 401 to every diagnosis whatever
            # had really gone wrong — and "unauthorized" pauses every camera
            # on the host (see ai_worker.backoff), so a wrong verdict here
            # would take the whole grid off the air for a timeout on one feed.
            if " 401" in status and user is not None:
                header = _authorization(user, secret, target, challenges)
                if header is not None:
                    status, _ = _describe(sock, target, 2, header)
    except TimeoutError:
        return "timeout"
    except OSError as exc:
        return f"no route ({exc})"

    if " 401" in status or " 403" in status:
        return "unauthorized"
    if " 404" in status:
        return "not found"
    if " 200" in status:
        # It answers a DESCRIBE but the decoder still could not start: usually
        # a codec the build cannot handle, or a path publishing nothing.
        return "opened but no media"
    return status.strip() or "unknown"


def _without_credentials(url: str) -> str:
    """The URL a request line may carry. Credentials go in a header or nowhere."""
    parsed = urlparse(url)
    if parsed.username is None and parsed.password is None:
        return url
    host = parsed.hostname or ""
    netloc = f"[{host}]" if ":" in host else host
    if parsed.port:
        netloc += f":{parsed.port}"
    return urlunparse(parsed._replace(netloc=netloc))


def _describe(
    sock: socket.socket, target: str, cseq: int, authorization: str | None = None
) -> tuple[str, list[str]]:
    """One DESCRIBE on an open connection: its status line and any challenges."""
    request = (
        f"DESCRIBE {target} RTSP/1.0\r\n"
        f"CSeq: {cseq}\r\n"
        "User-Agent: nagarnetra/diagnose\r\n"
        "Accept: application/sdp\r\n"
        + (f"Authorization: {authorization}\r\n" if authorization else "")
        + "\r\n"
    )
    sock.sendall(request.encode("latin-1"))

    data = b""
    while b"\r\n\r\n" not in data and len(data) < 16_384:
        chunk = sock.recv(4096)
        if not chunk:
            break
        data += chunk
    head, _, body = data.partition(b"\r\n\r\n")
    lines = head.decode("latin-1", "replace").split("\r\n")

    challenges: list[str] = []
    length = 0
    for line in lines[1:]:
        name, _, value = line.partition(":")
        if name.strip().lower() == "www-authenticate":
            challenges.append(value.strip())
        elif name.strip().lower() == "content-length" and value.strip().isdigit():
            length = int(value.strip())
    # Drain the body, so a second request on this connection reads its own
    # response rather than the tail of this one.
    while len(body) < min(length, 65_536):
        chunk = sock.recv(4096)
        if not chunk:
            break
        body += chunk
    return lines[0], challenges


def _authorization(
    user: str, secret: str, target: str, challenges: list[str]
) -> str | None:
    """Answer a challenge the way an RTSP client would. Digest when offered.

    Digest is preferred because it never puts the password on the wire, and
    this is plain RTSP over the internet; Basic only when it is all the server
    accepts, which is also when FFmpeg itself would send it.
    """
    for challenge in challenges:
        scheme, _, params = challenge.partition(" ")
        if scheme.lower() == "digest":
            return _digest(user, secret, target, _challenge_params(params))
    if any(c.partition(" ")[0].lower() == "basic" for c in challenges):
        token = base64.b64encode(f"{user}:{secret}".encode()).decode("ascii")
        return f"Basic {token}"
    return None


def _challenge_params(text: str) -> dict[str, str]:
    return {
        key.lower(): quoted if quoted else bare
        for key, quoted, bare in re.findall(r'(\w+)=(?:"([^"]*)"|([^,\s]+))', text)
    }


def _digest(user: str, secret: str, target: str, params: dict[str, str]) -> str:
    """RFC 2617 Digest, MD5, with `qop=auth` when the server asks for it."""

    def md5(text: str) -> str:
        # MD5 because the protocol says so, not as a choice of hash.
        return hashlib.md5(text.encode()).hexdigest()

    realm, nonce = params.get("realm", ""), params.get("nonce", "")
    ha1 = md5(f"{user}:{realm}:{secret}")
    ha2 = md5(f"DESCRIBE:{target}")
    fields = [
        f'username="{user}"', f'realm="{realm}"', f'nonce="{nonce}"', f'uri="{target}"'
    ]
    if "auth" in [q.strip() for q in params.get("qop", "").split(",")]:
        cnonce, nc = secrets.token_hex(8), "00000001"
        response = md5(f"{ha1}:{nonce}:{nc}:{cnonce}:auth:{ha2}")
        fields += ["qop=auth", f"nc={nc}", f'cnonce="{cnonce}"']
    else:
        response = md5(f"{ha1}:{nonce}:{ha2}")
    fields.append(f'response="{response}"')
    if "opaque" in params:
        fields.append(f'opaque="{params["opaque"]}"')
    return "Digest " + ", ".join(fields)


@dataclass(slots=True)
class CapturedFrame:
    """A frame plus when it was actually captured, for latency accounting."""

    index: int
    image: np.ndarray
    captured_at: float          # perf_counter, for measuring latency only
    wall_time: datetime         # tz-aware UTC, for the event payload
    # Presentation timestamp, in seconds, taken from the stream itself. Every
    # motion calculation must use this and never arrival time — see the note on
    # `_read_pts`.
    source_t_s: float
    # True when the stream jumped backwards, i.e. the recording looped or the
    # camera restarted. Long-lived state must be rebuilt rather than carried
    # across the cut.
    discontinuity: bool = False

    @property
    def age_ms(self) -> float:
        return (time.perf_counter() - self.captured_at) * 1000.0


@dataclass
class ReaderStats:
    frames_decoded: int = 0
    frames_delivered: int = 0
    frames_dropped: int = 0
    reconnects: int = 0
    decode_failures: int = 0
    discontinuities: int = 0
    #: Frames decoded but never converted to an image, because nobody was going
    #: to look at them (`StreamReader._run`). Part of `frames_dropped`.
    frames_skipped_unconverted: int = 0
    #: Frames stamped off the stream's timeline and withheld (see `_read_pts`).
    #: Part of `frames_dropped`.
    frames_off_timeline: int = 0
    #: Backward PTS steps that came back to the timeline: jitter, not a cut.
    pts_excursions: int = 0
    pts_unavailable: bool = False
    started_at: float = field(default_factory=time.perf_counter)

    @property
    def elapsed_s(self) -> float:
        return max(1e-6, time.perf_counter() - self.started_at)

    def to_dict(self) -> dict[str, Any]:
        return {
            "frames_decoded": self.frames_decoded,
            "frames_delivered": self.frames_delivered,
            "frames_dropped": self.frames_dropped,
            "drop_rate": round(self.frames_dropped / max(1, self.frames_decoded), 4),
            "decode_fps": round(self.frames_decoded / self.elapsed_s, 2),
            "delivered_fps": round(self.frames_delivered / self.elapsed_s, 2),
            "reconnects": self.reconnects,
            "decode_failures": self.decode_failures,
            "discontinuities": self.discontinuities,
            "frames_skipped_unconverted": self.frames_skipped_unconverted,
            "frames_off_timeline": self.frames_off_timeline,
            "pts_excursions": self.pts_excursions,
            "pts_unavailable": self.pts_unavailable,
            "elapsed_s": round(self.elapsed_s, 2),
        }


#: A backward PTS step up to this size is taken as ordinary timestamp noise and
#: the frame is used as it is — the behaviour this reader always had.
PTS_JITTER_S = 1.0

#: A larger backward step is a loop or a restart only once the stream has
#: *stayed* on the earlier timeline for this much of its own time. Measured on
#: the organisers' grid, 11-12 Oct: cam21 and cam10 interleave frames stamped
#: 1-4 s (at times up to 53 s) behind the live timeline, then return to it at
#: once — `PTS 35.64 -> 34.36`, `35.72 -> 34.44`, `35.80 -> 34.56` in three
#: consecutive steps. Taken as cuts, those rebuilt the tracker 1,453 times in a
#: day and left two in three grid plates with a single read. A real loop does
#: not come back; one second is ample to tell the two apart and short enough
#: that a cut is still caught within a second of happening.
PTS_CONFIRM_S = 1.0

#: ...or for this many seconds' worth of frames, so a source whose clock stalls
#: on the earlier timeline cannot have its frames withheld indefinitely.
PTS_CONFIRM_MAX_S = 2.0

#: A consumer that has not taken a frame for this long (or four of its own read
#: intervals, if longer) has paused, and nothing is converted for it until it
#: asks again.
_CONSUMER_IDLE_S = 2.0


class StreamReader:
    """Continuously decodes a source, holding only the most recent frame.

    Works for an RTSP URL or a file. A file is read at its natural pace rather
    than as fast as possible, so that a recorded clip exercises the same
    drop-and-catch-up behaviour a live camera would produce — otherwise the
    streaming path would only ever be tested in a regime it will never meet.
    """

    def __init__(
        self,
        source: str,
        realtime: bool = True,
        reconnect: bool = True,
        reconnect_delay_s: float = 2.0,
        max_reconnect_delay_s: float = 30.0,
        max_reconnects: int = 0,
    ) -> None:
        self.source = source
        self.realtime = realtime
        self.reconnect = reconnect
        self.reconnect_delay_s = reconnect_delay_s
        self.max_reconnect_delay_s = max_reconnect_delay_s
        self.max_reconnects = max_reconnects

        self.stats = ReaderStats()
        self._pts_s = 0.0
        #: The furthest point the stream's own timeline has reached (raw PTS,
        #: seconds), or None at the start of a connection.
        self._last_pts_s: float | None = None
        self._pts_offset_s = 0.0
        self._pts_available = True
        #: Where a suspected backward step landed (raw PTS), and how many frames
        #: have stayed on that earlier timeline since. None when not suspecting.
        self._suspect_from_s: float | None = None
        self._suspect_frames = 0
        #: Set by a reconnect: the next frame starts a new clock.
        self._reconnected = False
        #: A cut detected on a frame that was not handed over; it travels with
        #: the next frame that is, so the consumer always hears of it.
        self._pending_cut = False
        # Consumer pacing, for converting only the frames that will be taken.
        self._waiting = 0
        self._last_read_at: float | None = None
        self._read_period_s = 0.0
        self._grabbed = 0
        self._backoff_s = reconnect_delay_s
        self._latest: CapturedFrame | None = None
        self._lock = threading.Lock()
        self._new_frame = threading.Condition(self._lock)
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None
        self._capture: cv2.VideoCapture | None = None
        self._fps = 25.0
        self._finished = False

    # ── lifecycle ──
    def _open(self) -> bool:
        # FFmpeg only. Left to choose, OpenCV tries its other backends after
        # FFmpeg refuses, and the image-sequence one rejects the URL with an
        # error that quotes it whole — credentials included — on stderr, which
        # is the container log. It was doing that on every failed grid open.
        capture = cv2.VideoCapture(
            self.source,
            cv2.CAP_FFMPEG,
            [cv2.CAP_PROP_N_THREADS, runtime.decode_threads()],
        )
        if not capture.isOpened():
            capture.release()
            return False
        # A small decoder buffer keeps the driver from handing us stale frames;
        # we do our own dropping and want the freshest one available.
        capture.set(cv2.CAP_PROP_BUFFERSIZE, 1)
        fps = float(capture.get(cv2.CAP_PROP_FPS) or 0.0)
        self._fps = fps if 0.0 < fps <= 240.0 else 25.0
        self._capture = capture
        return True

    def _read_pts(self, capture: cv2.VideoCapture) -> tuple[float, bool, bool]:
        """Presentation timestamp for the frame just read, whether the stream
        was cut there, and whether the frame must be withheld.

        The NagarNetra integration guide is emphatic about this and it is not a
        style preference: when a client connects the gateway "replays its
        buffered group-of-pictures so the decoder can start at a keyframe", so
        the first second or two arrives *faster than real time*. A tracker that
        timestamps by arrival computes impossible velocities immediately after
        every connection, and a Kalman filter fed those deltas diverges.

        So timing comes from the stream. Two cases still need handling:

        * **Not every source reports PTS.** Some return 0 forever. That is
          detected once and recorded, after which a nominal cadence is used and
          the run says so rather than silently inventing timestamps.
        * **The recording loops.** PTS jumps backwards at the loop point. The
          offset is carried forward so `source_t_s` stays monotonic for event
          ordering, and the jump is flagged so tracker state can be rebuilt.
        * **The timestamps jitter.** Some grid streams interleave frames stamped
          seconds behind the live timeline and then carry straight on (see
          `PTS_CONFIRM_S`). Treating every such step as a loop rebuilt the
          tracker every minute and threw away each vehicle's multi-frame
          evidence. So a step back further than `PTS_JITTER_S` is *suspected*,
          and its frame withheld — whether its pixels are stale or only its
          stamp, it is not evidence about where a vehicle is now, and a
          drop-to-latest reader loses nothing by skipping one frame. If the
          stream returns to its timeline the step was jitter and nothing is
          rebuilt. If it stays on the earlier timeline for `PTS_CONFIRM_S` of
          its own time, it was a loop: the cut is reported then, and because
          the frames in between were withheld, no frame from after the cut ever
          reaches a tracker that still holds the scene from before it.
        * **The connection was re-established.** A reconnect replays a buffered
          GOP on a fresh clock, so its first frame is a cut too, and the clock
          is re-based to keep rising.

        Returns `(source_t_s, cut, withhold)`.
        """
        raw_ms = capture.get(cv2.CAP_PROP_POS_MSEC)
        if raw_ms is None or raw_ms != raw_ms or raw_ms <= 0.0:  # NaN-safe
            if self._pts_available:
                # Record it immediately; a stream that dies after three frames
                # still needs its timestamps marked as approximate. Only the
                # warning waits, so a normal startup does not log noise.
                self._pts_available = False
                self.stats.pts_unavailable = True
                if self.stats.frames_decoded > 5:
                    log.warning(
                        "%s reports no usable PTS; falling back to nominal cadence. "
                        "Motion-derived values from this source are approximate.",
                        redact(self.source),
                    )
            self._pts_s += 1.0 / self._fps
            return self._pts_s, False, False

        raw_s = raw_ms / 1000.0
        high = self._last_pts_s

        if high is None:
            # The first frame of a connection.
            cut = self._reconnected
            if cut:
                self._pts_offset_s = self._pts_s + 1.0 / self._fps - raw_s
                self._report_cut("reconnected; the stream restarts on a new clock")
            self._reconnected = False
            self._last_pts_s = raw_s
            self._pts_s = raw_s + self._pts_offset_s
            return self._pts_s, cut, False

        if raw_s >= high - PTS_JITTER_S:
            # On the timeline, or within ordinary noise of it.
            if self._suspect_from_s is not None:
                # It came back: the step was jitter, not a loop.
                self.stats.pts_excursions += 1
                log.debug(
                    "%s: PTS stepped back to %.2fs and returned to %.2fs; not a cut",
                    redact(self.source), self._suspect_from_s, raw_s,
                )
                self._suspect_from_s, self._suspect_frames = None, 0
            self._last_pts_s = max(high, raw_s)
            self._pts_s = raw_s + self._pts_offset_s
            return self._pts_s, False, False

        # Off the timeline, backwards. Start (or continue) suspecting a cut.
        if self._suspect_from_s is None or raw_s < self._suspect_from_s - PTS_JITTER_S:
            self._suspect_from_s, self._suspect_frames = raw_s, 0
        self._suspect_frames += 1
        stayed_s = raw_s - self._suspect_from_s
        if stayed_s < PTS_CONFIRM_S and self._suspect_frames < PTS_CONFIRM_MAX_S * self._fps:
            return self._pts_s, False, True

        # It stayed: a loop or a restart. Re-base so the emitted clock carries
        # on rising from where it was, across the frames that were withheld.
        landed = self._suspect_from_s
        self._pts_offset_s += high - landed + 1.0 / self._fps
        self._suspect_from_s, self._suspect_frames = None, 0
        self._report_cut(f"PTS {high:.2f}s -> {landed:.2f}s and stayed")
        self._last_pts_s = raw_s
        self._pts_s = raw_s + self._pts_offset_s
        return self._pts_s, True, False

    def _report_cut(self, why: str) -> None:
        self.stats.discontinuities += 1
        log.info(
            "scene discontinuity on %s (%s); tracker state will be rebuilt",
            redact(self.source), why,
        )

    def start(self) -> StreamReader:
        if not self._open():
            reason = diagnose(self.source)
            raise StreamUnavailable(
                f"{redact(self.source)} — {reason}", reason=reason
            )
        self._thread = threading.Thread(target=self._run, name="stream-reader", daemon=True)
        self._thread.start()
        return self

    def _run(self) -> None:
        frame_interval = 1.0 / self._fps
        next_due = time.perf_counter()

        while not self._stop.is_set():
            capture = self._capture
            if capture is None:
                break

            # Decode every frame — a decoder cannot skip one without breaking
            # the frames that reference it — but convert to BGR only the ones
            # that will be looked at. Conversion and the copy out of FFmpeg are
            # a quarter of the per-frame cost, and a camera thread analysing a
            # few frames a second takes one in five to one in ten of what a
            # 15-25 fps camera sends. Measured in the worker image at one
            # thread: H.264 1080p25, 11.45 ms a frame with read() against
            # 8.80 ms with grab(); H.265, 22.1 against 15.4 ms
            # (docs/research/ANPR_ACCURACY_LATENCY.md §2.2).
            grabbed_at = time.perf_counter()
            if not capture.grab():
                if not self._handle_read_failure():
                    break
                continue

            self.stats.frames_decoded += 1
            index = self._grabbed
            self._grabbed += 1
            pts_s, cut, withhold = self._read_pts(capture)
            # A frame arrived, so the connection is healthy: reset the backoff
            # so a later drop starts from a short delay rather than inheriting
            # the previous outage's.
            self._backoff_s = self.reconnect_delay_s

            with self._new_frame:
                if cut:
                    self._pending_cut = True
                    if self._latest is not None:
                        # From before the cut. Handing it over after the cut
                        # was reported would seed the rebuilt tracker with the
                        # old scene.
                        self._latest = None
                        self.stats.frames_dropped += 1
                wanted = not withhold and self._wants_frame(grabbed_at, frame_interval)
                if withhold:
                    self.stats.frames_off_timeline += 1
                    self.stats.frames_dropped += 1
                elif not wanted:
                    self.stats.frames_skipped_unconverted += 1
                    self.stats.frames_dropped += 1

            if wanted:
                ok, image = capture.retrieve()
                if ok and image is not None:
                    self._publish(
                        CapturedFrame(
                            index=index,
                            image=image,
                            captured_at=grabbed_at,
                            wall_time=datetime.now(UTC),
                            source_t_s=pts_s,
                        )
                    )
                else:
                    with self._new_frame:
                        self.stats.frames_dropped += 1

            if self.realtime:
                # Pace a file at its natural rate so it exercises the same
                # drop-and-catch-up path a camera would.
                next_due += frame_interval
                sleep_for = next_due - time.perf_counter()
                if sleep_for > 0:
                    self._stop.wait(sleep_for)
                else:
                    # We are behind; do not try to catch up by racing ahead.
                    next_due = time.perf_counter()

        with self._new_frame:
            self._finished = True
            self._new_frame.notify_all()

    def _wants_frame(self, now: float, frame_interval: float) -> bool:
        """Will anyone take the frame just grabbed? Called with the lock held.

        Yes when a consumer is waiting for one. Otherwise only when the
        consumer is due back within about a frame: its pace is learned from
        its own reads, so the frame it takes is as fresh as it always was —
        the newest one decoded — while the frames it would never have seen are
        not converted at all. A consumer that has stopped reading (a camera
        whose analysis slot has rotated away) gets nothing converted until it
        asks again.
        """
        if self._waiting:
            return True
        last = self._last_read_at
        if last is None:
            return False
        if now - last > max(_CONSUMER_IDLE_S, 4.0 * self._read_period_s):
            return False
        return now + frame_interval >= last + self._read_period_s

    def _publish(self, captured: CapturedFrame) -> None:
        with self._new_frame:
            previous = self._latest
            # Replacing an unconsumed frame IS the drop. Counting it here is
            # the only place the number is knowable. A cut it carried is not
            # dropped with it: the consumer must still hear of it.
            if previous is not None:
                self.stats.frames_dropped += 1
            captured.discontinuity = self._pending_cut or bool(
                previous is not None and previous.discontinuity
            )
            self._pending_cut = False
            self._latest = captured
            self._new_frame.notify()

    def _handle_read_failure(self) -> bool:
        """A read failure is end-of-file, or a camera that dropped out."""
        if self._capture is not None:
            self._capture.release()
            self._capture = None

        if not self.reconnect:
            return False
        if self.max_reconnects and self.stats.reconnects >= self.max_reconnects:
            log.warning(
                "giving up on %s after %d reconnects",
                redact(self.source), self.stats.reconnects,
            )
            return False

        self.stats.decode_failures += 1
        # A file simply ends; only a live source is worth reconnecting to.
        if not self.source.startswith(("rtsp://", "rtsps://", "http://", "https://")):
            return False

        self.stats.reconnects += 1
        delay = self._backoff_s
        log.warning(
            "stream %s dropped; reconnecting in %.1fs (attempt %d)",
            redact(self.source), delay, self.stats.reconnects,
        )
        # Exponential backoff, capped. Feeds are supervised and restart; a tight
        # reconnect loop against a recovering gateway is useless and rude, and
        # the guide asks for ~2s rising to ~30s.
        self._backoff_s = min(self.max_reconnect_delay_s, self._backoff_s * 2.0)

        if self._stop.wait(delay):
            return False
        if not self._open():
            return True   # stay in the loop and back off again

        # A reconnect replays a buffered GOP, so the frames that follow are not
        # continuous with the ones before it: the first of them is reported as
        # a cut (`_read_pts`), with the clock re-based to keep rising. It used
        # to be neither, so the tracker carried vehicles across the outage and
        # the clock restarted near zero — and a vehicle last seen at t=600 s
        # is not "stale" at t=3 s, so nothing in view was ever retired.
        self._last_pts_s = None
        self._reconnected = self.stats.frames_decoded > 0
        self._suspect_from_s, self._suspect_frames = None, 0
        return True

    # ── consumption ──
    def read(self, timeout: float = 1.0) -> CapturedFrame | None:
        """Take the most recent frame, or None when the stream has ended."""
        with self._new_frame:
            held = self._latest
            if (
                held is not None
                and self._grabbed > held.index + 1
                and time.perf_counter() - held.captured_at > 2.0 / self._fps
            ):
                # Converted before the consumer paused, and frames have been
                # decoded since: it is not the latest any more. Drop it and take
                # the next, which arrives within a frame.
                self._latest = None
                self.stats.frames_dropped += 1
                self._pending_cut = self._pending_cut or held.discontinuity
            if self._latest is None and not self._finished:
                self._waiting += 1
                try:
                    self._new_frame.wait(timeout)
                finally:
                    self._waiting -= 1
            frame = self._latest
            self._latest = None
            if frame is not None:
                self.stats.frames_delivered += 1
                now = time.perf_counter()
                if self._last_read_at is not None:
                    gap = now - self._last_read_at
                    if gap < _CONSUMER_IDLE_S:
                        self._read_period_s = (
                            gap if self._read_period_s == 0.0
                            else 0.7 * self._read_period_s + 0.3 * gap
                        )
                self._last_read_at = now
        return frame

    @property
    def finished(self) -> bool:
        with self._lock:
            return self._finished and self._latest is None

    @property
    def fps(self) -> float:
        return self._fps

    def stop(self) -> None:
        self._stop.set()
        if self._thread is not None:
            self._thread.join(timeout=5.0)
        if self._capture is not None:
            self._capture.release()
            self._capture = None

    def __enter__(self) -> StreamReader:
        return self.start()

    def __exit__(self, *exc: object) -> None:
        self.stop()
