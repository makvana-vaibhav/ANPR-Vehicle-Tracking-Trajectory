"""When a camera that would not open may be asked again.

## What this replaced

A camera that failed to open went straight back to the rotation, and the next
reconcile pass — every twenty seconds — opened it again. Each attempt was an
FFmpeg login plus a second connection to diagnose the failure. With the whole
organisers' grid refusing at once, that was every camera, every pass, for as
long as the refusal lasted: well over a hundred rejected logins a minute from
one address, which is indistinguishable from someone guessing the password.
It is also the surest way to turn a short lockout into a long one.

## Two kinds of failure, two policies

**One camera is down** — no such path, no media, a timeout. That is a fact
about the camera, and it backs off on its own: 2 s doubling to 30 s, the
cadence the grid's integration guide asks for.

**The far end rejected our credentials.** That is a fact about the account,
not the camera: every camera on that host will get the same answer. So the
host is paused as a whole. When the pause ends, exactly one camera asks; if it
opens, every camera on the host resumes, and if it is refused again the pause
doubles. Thirty cameras become one question every few minutes.

Pure, like `Rotation`: no threads, no I/O, no clock of its own. The worker
calls it from its event loop, so it needs no lock.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass, field
from urllib.parse import urlparse

log = logging.getLogger(__name__)

#: Diagnoses that are about the account rather than the camera.
ACCOUNT_REASONS = frozenset({"unauthorized"})


def host_of(url: str) -> str:
    """The far end a stream lives on, which is what checks the credentials."""
    parsed = urlparse(url)
    return f"{parsed.hostname or ''}:{parsed.port or ''}"


@dataclass
class Backoff:
    #: One camera's retry delay: doubles from `base_s` up to `cap_s`.
    base_s: float = 2.0
    cap_s: float = 30.0
    #: A rejected login's pause, for the whole host: doubles up to the cap.
    account_base_s: float = 120.0
    account_cap_s: float = 900.0

    #: Consecutive failed opens, per camera.
    streak: dict[str, int] = field(default_factory=dict)
    #: A camera is not opened again before this (monotonic seconds).
    not_before: dict[str, float] = field(default_factory=dict)
    #: Consecutive credential rejections, per host.
    host_streak: dict[str, int] = field(default_factory=dict)
    #: Hosts paused after a rejection, and until when. Past that time a host
    #: stays listed — half-open — until one of its cameras gets through.
    host_paused_until: dict[str, float] = field(default_factory=dict)
    #: The one camera currently allowed to ask a half-open host.
    probe: dict[str, str] = field(default_factory=dict)

    def admit(self, code: str, host: str, now: float) -> bool:
        """Whether `code` may be opened now.

        On a half-open host this also makes `code` the probe, so call it only
        for a camera that will be started if it is admitted.
        """
        if now < self.not_before.get(code, 0.0):
            return False
        paused_until = self.host_paused_until.get(host)
        if paused_until is None:
            return True
        if now < paused_until:
            return False
        holder = self.probe.get(host)
        if holder is not None and holder != code:
            return False
        self.probe[host] = code
        return True

    def opened(self, code: str, host: str) -> None:
        """The stream opened: the camera is healthy, and so is the account."""
        self.streak.pop(code, None)
        self.not_before.pop(code, None)
        if self.host_paused_until.pop(host, None) is not None:
            log.info("%s accepted us again; resuming its cameras", host)
        self.host_streak.pop(host, None)
        self.probe.pop(host, None)

    def failed(self, code: str, host: str, reason: str, now: float) -> float:
        """Record a failed open. Returns how long before it is tried again."""
        was_probe = self.probe.get(host) == code
        if was_probe:
            del self.probe[host]

        if reason in ACCOUNT_REASONS:
            if host in self.host_paused_until and not was_probe:
                # A camera started before the pause began, answering late.
                # Same incident: escalating on it would double the pause for
                # one refusal.
                return max(0.0, self.host_paused_until[host] - now)
            n = self.host_streak.get(host, 0) + 1
            self.host_streak[host] = n
            delay = min(self.account_cap_s, self.account_base_s * 2 ** (n - 1))
            self.host_paused_until[host] = now + delay
            return delay

        # About this camera only. A probe that fails this way has not cleared
        # the host — a camera that is down says nothing about the login — so
        # the host stays half-open and the next camera may ask.
        n = self.streak.get(code, 0) + 1
        self.streak[code] = n
        delay = min(self.cap_s, self.base_s * 2 ** (n - 1))
        self.not_before[code] = now + delay
        return delay

    def stopped(self, code: str, host: str) -> None:
        """The camera was stopped before it answered: no verdict either way."""
        if self.probe.get(host) == code:
            del self.probe[host]

    def retain(self, codes: set[str] | frozenset[str]) -> None:
        """Forget cameras this worker no longer owns."""
        for table in (self.streak, self.not_before):
            for code in [c for c in table if c not in codes]:
                del table[code]
        for host in [h for h, c in self.probe.items() if c not in codes]:
            del self.probe[host]

    def paused_hosts(self, now: float) -> dict[str, float]:
        """Hosts refusing us, and seconds left (0 = waiting on a probe)."""
        return {
            host: max(0.0, until - now) for host, until in self.host_paused_until.items()
        }

    def waiting(self, now: float) -> int:
        """Cameras backing off on their own account."""
        return sum(1 for until in self.not_before.values() if until > now)
