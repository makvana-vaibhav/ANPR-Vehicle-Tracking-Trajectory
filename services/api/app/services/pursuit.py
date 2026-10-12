"""Pursuit: keep the cameras a vehicle can reach next under analysis.

A laptop cannot analyse every camera at once. The workers analyse a short
always-on list, and any camera somebody has on screen (`app.services.focus`).
A vehicle being pursued will pass cameras nobody is looking at, so a pursuit
looks at them on the operator's behalf: from the plate's last confirmed
sighting it ranks the cameras the vehicle can plausibly reach next, and keeps
the focus heartbeat of the top few alive server-side, so the workers open and
analyse exactly those. When the plate is read anywhere, the pursuit advances —
it re-ranks from the new sighting — and the panel shows the read as it lands.

## How "can reach next" is decided

Straight-line distance from the camera that last read the plate, and a speed
band: the 10th–90th percentile of the straight-line speeds of journeys the
correlator believed over the last week, where at least `MIN_BAND_SAMPLES`
exist; between a pair of cameras with `MIN_PAIR_SAMPLES` observed journeys,
those journeys' own times; otherwise the stated default band
`DEFAULT_BAND_KMPH`. A camera's *arrival window* is then the earliest and
latest the vehicle could get there. Cameras whose window is open now, or opens
within `HORIZON_S`, are the ones worth pinning; nearer first, and a camera that
has analysed plenty of vehicles without ever reading a plate is passed over —
pinning it would spend a stream on a junction overview that cannot confirm
anything. Cameras with no known position are never ranked.

## What it must not do to the grid

The organisers' grid meters watch time and refuses our login when sessions
come and go too often. So a pursuit:

* never holds more than its `pins` streams open — counting a stream it has
  let go, because the workers keep a released stream open for
  `FOCUS_LINGER_S` — and never more than the workers' focus capacity overall;
* keeps a camera pinned at least `MIN_PIN_S`, and keeps it while it stays
  within `HYSTERESIS_RANKS` of the top, so the pins do not chase every change
  in ranking;
* spends no pin on a camera the workers analyse continuously anyway;
* holds grid pins while the grid looks like it is refusing us.

That last one is an **inference**. The workers' login state (their backoff)
lives in their own memory and logs; nothing publishes it where the API can
read it. What the API can see is detections: the always-on grid cameras
produce a steady stream of them when the workers are let in, and none when
they are not. So grid pins are held while no grid camera has produced a
detection for `GRID_SILENCE_S`, and when a pinned grid camera has produced
nothing for `PIN_PROOF_S` while other grid cameras did — a login refused, or a
camera that is down — the pursuit lets it go and holds grid pins for
`HOLD_BASE_S`, doubling to `HOLD_CAP_S`, the cadence of the workers' own
backoff. The panel says all of this in words, including that it is inferred.

## Audit

Starting, renewing and stopping a pursuit are audited as the people who did
them; an expiry is audited as the system. The first time a person opens a
pursuit's detail it is audited as a plate search, because the detail lists
the plate's sightings. The heartbeats are not, for the reason focus gives.
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import secrets
import uuid
from collections.abc import Iterable, Sequence
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from typing import Any, Literal

import redis.asyncio as aioredis
from geoalchemy2 import Geometry
from redis.exceptions import RedisError
from sqlalchemy import func, select, text
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings
from app.core.logging import get_logger
from app.db.session import SessionLocal
from app.models.intelligence import Detection
from app.models.registry import Camera, VmsInstance
from app.services import candidates, correlator, focus
from app.services.correlator import MAX_PLAUSIBLE_KMPH, MIN_SEPARATION_M, UNPLACED_TAG

log = get_logger("api.pursuit")

# ─────────────────────────────────────────────────────────────────────
# Policy
# ─────────────────────────────────────────────────────────────────────
#: Where pursuits live in Redis. Read at call time, so the tests can move it
#: out of the way of the workers and the live keeper.
KEY_PREFIX = "nagarnetra:pursuit"

#: How often the keeper renews heartbeats and looks for new reads. Well inside
#: the focus TTL (45 s), so a pin never lapses between two ticks.
TICK_S = 10.0

#: A pursuit ends this long after it was started or last renewed.
DURATION = timedelta(minutes=15)

#: Cameras pinned when the operator does not say.
DEFAULT_PINS = 2

#: A pinned camera stays pinned at least this long, whatever the ranking does.
MIN_PIN_S = 180.0

#: A pinned camera is kept while it ranks within this many places of the top.
HYSTERESIS_RANKS = 2

#: How long a worker keeps a stream open after its focus lapses
#: (`ai_worker.config.WorkerSettings.focus_linger_s`). A released camera
#: counts against the pursuit's streams until then.
FOCUS_LINGER_S = 300.0

#: A camera whose window opens within this is worth pinning now.
HORIZON_S = 15 * 60.0

#: Straight-line speeds, km/h, used when too few journeys have been observed.
#: Straight-line, so lower than road speeds: the low end is congested city
#: driving on a winding route, the high end an open road.
DEFAULT_BAND_KMPH = (10.0, 60.0)

#: Observed journeys needed before their speeds replace the default band.
MIN_BAND_SAMPLES = 10

#: Observed journeys between one pair of cameras before their times are used.
MIN_PAIR_SAMPLES = 3

#: How far back observed journeys and camera activity are read.
HISTORY = timedelta(days=7)

#: A camera that analysed at least this many vehicles in `HISTORY` without
#: reading one plate is an overview camera: it cannot confirm a plate.
OVERVIEW_MIN_VEHICLES = 50

#: No grid detection for this long looks, from here, like a refused login.
GRID_SILENCE_S = 600.0

#: A pinned grid camera with no detection after this long, while other grid
#: cameras produced some, was probably not let in.
PIN_PROOF_S = 240.0

#: Grid pins are held this long after that, doubling to the cap — the
#: workers' own pause after a refused login (`auth_pause_s`, `auth_pause_max_s`).
HOLD_BASE_S = 120.0
HOLD_CAP_S = 900.0

#: Reads looked at again on each tick, because a detection is persisted when
#: the vehicle has left the frame, a little after its own timestamp.
LOOKBACK = timedelta(seconds=120)

#: The anchor is the newest confirmed read within this.
ANCHOR_LOOKBACK = timedelta(days=1)

#: Kept per pursuit for the panel.
MAX_SIGHTINGS = 30
MAX_EVENTS = 30
MAX_SEEN_IDS = 600
MAX_PREDICTIONS = 12
MAX_CAMERAS = 5_000

#: Detections a camera that replays a recorded clip produces are not vehicles
#: on the road now: such a camera is never pinned, and an anchor there says so.
RECORDED_TAG = "recorded-footage"

Window = Literal["open", "soon", "town", "passed", "later"]
Basis = Literal["observed_pair", "observed_network", "default", "town"]
PinState = Literal[
    "pinned",
    "would_pin",
    "always_on",
    "waiting",
    "held",
    "ranked_lower",
    "outside_window",
    "reads_no_plates",
    "recorded",
    "not_in_fleet",
]

_WINDOW_ORDER: dict[str, int] = {"open": 0, "soon": 1, "town": 2, "passed": 3, "later": 4}
_PINNABLE_WINDOWS = frozenset({"open", "soon", "town"})


def _key(*parts: str) -> str:
    return ":".join((KEY_PREFIX, *parts))


def _iso(value: datetime | None) -> str | None:
    return value.isoformat() if value is not None else None


def _dt(value: Any) -> datetime | None:
    return datetime.fromisoformat(value) if isinstance(value, str) and value else None


def _codes(value: str) -> frozenset[str]:
    return frozenset(code.strip() for code in value.split(",") if code.strip())


def _minutes(seconds: float) -> str:
    seconds = abs(seconds)
    if seconds < 90:
        return f"{round(seconds)} s"
    minutes = round(seconds / 60)
    return f"{minutes} min" if minutes < 120 else f"{minutes // 60} h {minutes % 60:02d} min"


# ─────────────────────────────────────────────────────────────────────
# What the platform knows about each camera
# ─────────────────────────────────────────────────────────────────────
@dataclass(frozen=True, slots=True)
class FleetCamera:
    camera_id: str
    code: str
    name: str
    city: str | None
    lat: float | None
    lon: float | None
    placed: bool
    town_level: bool
    anpr: bool
    grid: bool
    recorded: bool
    always_on: bool
    vehicles_7d: int = 0
    plates_7d: int = 0

    @property
    def reads_no_plates(self) -> bool:
        return self.vehicles_7d >= OVERVIEW_MIN_VEHICLES and self.plates_7d == 0


@dataclass(frozen=True, slots=True)
class SpeedBasis:
    kind: Literal["observed_network", "default"]
    low_kmph: float
    high_kmph: float
    samples: int

    @property
    def short(self) -> str:
        """The band in a few words, for each camera's reasons."""
        band = f"{self.low_kmph:.0f}–{self.high_kmph:.0f} km/h"
        if self.kind == "default":
            return f"{band}, the default band — too few journeys observed to measure one"
        return f"{band}, measured from {self.samples} journeys between cameras"

    @property
    def note(self) -> str:
        if self.kind == "default":
            return (
                f"the default band {self.low_kmph:.0f}–{self.high_kmph:.0f} km/h: fewer than "
                f"{MIN_BAND_SAMPLES} journeys between two cameras were observed in the last "
                f"{HISTORY.days} days ({self.samples})"
            )
        return (
            f"{self.low_kmph:.0f}–{self.high_kmph:.0f} km/h, the middle 80% of {self.samples} "
            f"journeys between cameras observed in the last {HISTORY.days} days"
        )

    def to_dict(self) -> dict[str, Any]:
        return {
            "kind": self.kind,
            "low_kmph": round(self.low_kmph, 1),
            "high_kmph": round(self.high_kmph, 1),
            "samples": self.samples,
            "note": self.note,
            "short": self.short,
        }


def _percentile(values: Sequence[float], fraction: float) -> float:
    ordered = sorted(values)
    index = min(len(ordered) - 1, max(0, round(fraction * (len(ordered) - 1))))
    return ordered[index]


def speed_basis(speeds: Sequence[float]) -> SpeedBasis:
    """The speed band to predict with, from observed straight-line speeds."""
    usable = [s for s in speeds if 0 < s <= MAX_PLAUSIBLE_KMPH]
    if len(usable) < MIN_BAND_SAMPLES:
        low, high = DEFAULT_BAND_KMPH
        return SpeedBasis("default", low, high, len(usable))
    low = max(1.0, _percentile(usable, 0.10))
    high = min(MAX_PLAUSIBLE_KMPH, max(low, _percentile(usable, 0.90)))
    return SpeedBasis("observed_network", low, high, len(usable))


@dataclass(frozen=True, slots=True)
class Anchor:
    """The confirmed sighting a pursuit predicts from."""

    camera_id: str
    camera_code: str
    camera_name: str
    lat: float
    lon: float
    town_level: bool
    recorded: bool
    seen_at: datetime
    detection_id: str

    def to_dict(self) -> dict[str, Any]:
        return {
            "camera_id": self.camera_id,
            "camera_code": self.camera_code,
            "camera_name": self.camera_name,
            "lat": round(self.lat, 6),
            "lon": round(self.lon, 6),
            "town_level": self.town_level,
            "recorded": self.recorded,
            "seen_at": self.seen_at.isoformat(),
            "detection_id": self.detection_id,
        }

    @staticmethod
    def from_dict(data: dict[str, Any]) -> Anchor:
        return Anchor(
            camera_id=str(data["camera_id"]),
            camera_code=str(data["camera_code"]),
            camera_name=str(data["camera_name"]),
            lat=float(data["lat"]),
            lon=float(data["lon"]),
            town_level=bool(data.get("town_level")),
            recorded=bool(data.get("recorded")),
            seen_at=_dt(data["seen_at"]) or datetime.now(UTC),
            detection_id=str(data.get("detection_id") or ""),
        )


# ─────────────────────────────────────────────────────────────────────
# Ranking — pure
# ─────────────────────────────────────────────────────────────────────
@dataclass(slots=True)
class Predicted:
    camera: FleetCamera
    distance_km: float | None
    approximate: bool
    eta_from: datetime | None
    eta_to: datetime | None
    window: Window
    basis: Basis
    reasons: list[str]
    rank: int = 0
    pin_state: PinState = "ranked_lower"
    pin_note: str = ""

    @property
    def pinnable(self) -> bool:
        return (
            self.camera.anpr
            and not self.camera.always_on
            and not self.camera.recorded
            and not self.camera.reads_no_plates
            and self.window in _PINNABLE_WINDOWS
        )

    def to_dict(self) -> dict[str, Any]:
        return {
            "rank": self.rank,
            "camera_id": self.camera.camera_id,
            "camera_code": self.camera.code,
            "camera_name": self.camera.name,
            "city": self.camera.city,
            "lat": self.camera.lat,
            "lon": self.camera.lon,
            "grid": self.camera.grid,
            "always_on": self.camera.always_on,
            "distance_km": round(self.distance_km, 2) if self.distance_km is not None else None,
            "approximate": self.approximate,
            "eta_from": _iso(self.eta_from),
            "eta_to": _iso(self.eta_to),
            "window": self.window,
            "basis": self.basis,
            "reasons": list(self.reasons),
            "plates_7d": self.camera.plates_7d,
            "vehicles_7d": self.camera.vehicles_7d,
            "pin_state": self.pin_state,
            "pin_note": self.pin_note,
        }


def _window_for(eta_from: datetime, eta_to: datetime, now: datetime) -> Window:
    if now < eta_from:
        return "soon" if (eta_from - now).total_seconds() <= HORIZON_S else "later"
    return "open" if now <= eta_to else "passed"


def predict(
    anchor: Anchor,
    cameras: Iterable[FleetCamera],
    now: datetime,
    basis: SpeedBasis,
    pair_seconds: dict[tuple[str, str], list[float]] | None = None,
) -> list[Predicted]:
    """Every camera the vehicle could reach next from `anchor`, ranked.

    Excludes the camera that read it and any at the same spot (it has just
    passed them), and every camera whose position is unknown — a distance to
    a placeholder position would be a guess drawn as a measurement.
    """
    pair_seconds = pair_seconds or {}
    out: list[Predicted] = []
    for camera in cameras:
        if camera.camera_id == anchor.camera_id or not camera.placed:
            continue
        if camera.lat is None or camera.lon is None:
            continue
        metres = correlator.haversine_m(anchor.lat, anchor.lon, camera.lat, camera.lon)
        approximate = camera.town_level or anchor.town_level
        reasons: list[str] = []

        if metres < MIN_SEPARATION_M and not approximate:
            # The same spot as the camera that read it: it has just passed.
            continue
        if metres < MIN_SEPARATION_M:
            reasons.append(
                f"in the same town as {anchor.camera_code}: both are placed at the town's "
                "centre, so the distance between them — and an arrival time — is not known"
            )
            predicted = Predicted(camera, None, True, None, None, "town", "town", reasons)
        else:
            km = metres / 1000.0
            where = f"{km:.1f} km from {anchor.camera_code} in a straight line"
            if camera.town_level:
                where += f" — {camera.code} is placed at its town's centre, so this is approximate"
            elif anchor.town_level:
                where += f" — {anchor.camera_code} is placed at its town's centre, so this is approximate"
            reasons.append(where)
            pair = pair_seconds.get((anchor.camera_code, camera.code), [])
            if len(pair) >= MIN_PAIR_SAMPLES:
                low_s, high_s = _percentile(pair, 0.10), _percentile(pair, 0.90)
                chosen: Basis = "observed_pair"
                how = (
                    f"{len(pair)} observed journeys from {anchor.camera_code} took "
                    f"{_minutes(low_s)}–{_minutes(high_s)}"
                )
            else:
                low_s = metres / (basis.high_kmph / 3.6)
                high_s = metres / (basis.low_kmph / 3.6)
                chosen = "observed_network" if basis.kind == "observed_network" else "default"
                how = f"at {basis.short}"
            eta_from = anchor.seen_at + timedelta(seconds=low_s)
            eta_to = anchor.seen_at + timedelta(seconds=high_s)
            window = _window_for(eta_from, eta_to, now)
            reasons.append(
                f"it would arrive {_minutes(low_s)} to {_minutes(high_s)} after it was last "
                f"seen ({how})"
            )
            reasons.append(
                {
                    "open": "its arrival window is open now",
                    "soon": f"its arrival window opens in {_minutes((eta_from - now).total_seconds())}",
                    "passed": (
                        f"its arrival window closed {_minutes((now - eta_to).total_seconds())} "
                        "ago — if it went this way it has probably passed already"
                    ),
                    "later": (
                        f"its arrival window opens in {_minutes((eta_from - now).total_seconds())}"
                        " — too far to matter in this pursuit"
                    ),
                }[window]
            )
            predicted = Predicted(
                camera, km, approximate, eta_from, eta_to, window, chosen, reasons
            )

        if camera.reads_no_plates:
            reasons.append(
                f"analysed {camera.vehicles_7d} vehicles in the last {HISTORY.days} days and read "
                "no plate — an overview camera cannot confirm the vehicle"
            )
        elif camera.plates_7d:
            reasons.append(f"read {camera.plates_7d} plates in the last {HISTORY.days} days")
        else:
            reasons.append("rarely analysed, so whether it reads plates is not yet known")
        if camera.recorded:
            reasons.append("replays a recorded clip — it cannot see a vehicle on the road now")
        elif camera.always_on:
            reasons.append("analysed continuously already, so it needs no pin")
        if not camera.anpr:
            reasons.append("not in the ANPR fleet: no worker analyses it")
        out.append(predicted)

    out.sort(
        key=lambda p: (
            _WINDOW_ORDER[p.window],
            p.camera.reads_no_plates,
            p.distance_km if p.distance_km is not None else 0.0,
            p.camera.town_level,
            p.camera.code,
        )
    )
    for index, item in enumerate(out, start=1):
        item.rank = index
    return out


# ─────────────────────────────────────────────────────────────────────
# Pins — pure
# ─────────────────────────────────────────────────────────────────────
@dataclass(slots=True)
class Pin:
    camera_code: str
    camera_id: str
    pinned_at: datetime
    grid: bool
    proven_at: datetime | None = None

    def to_dict(self) -> dict[str, Any]:
        return {
            "camera_code": self.camera_code,
            "camera_id": self.camera_id,
            "pinned_at": self.pinned_at.isoformat(),
            "grid": self.grid,
            "proven_at": _iso(self.proven_at),
        }

    @staticmethod
    def from_dict(data: dict[str, Any]) -> Pin:
        return Pin(
            camera_code=str(data["camera_code"]),
            camera_id=str(data.get("camera_id") or ""),
            pinned_at=_dt(data["pinned_at"]) or datetime.now(UTC),
            grid=bool(data.get("grid")),
            proven_at=_dt(data.get("proven_at")),
        )


@dataclass(slots=True)
class PinPlan:
    keep: list[Pin]
    add: list[Predicted]
    release: list[tuple[Pin, str]]
    #: Cameras that would be pinned but are not, and why.
    waiting: dict[str, str]


def plan_pins(
    ranked: Sequence[Predicted],
    pins: Sequence[Pin],
    *,
    wanted: int,
    capacity: int,
    now: datetime,
    own_lingering: dict[str, datetime],
    lingering: dict[str, datetime],
    others_open: frozenset[str] = frozenset(),
    grid_hold: bool = False,
    hold_note: str = "",
    unproven: dict[str, str] | None = None,
    blocked: str = "",
) -> PinPlan:
    """Which cameras to keep, release and add — and which must wait, and why.

    `own_lingering` are cameras this pursuit released less than
    `FOCUS_LINGER_S` ago: the workers still hold their streams open, so they
    count against `wanted`. `lingering` is every such camera, from any
    pursuit; with `others_open` (other pursuits' pins and cameras on someone's
    screen) it counts against `capacity`, the workers' focus capacity.
    Re-pinning a camera whose stream is still open costs nothing. `blocked`
    says why nothing may be pinned at all, and releases what is.
    """
    unproven = unproven or {}
    if blocked:
        return PinPlan(keep=[], add=[], release=[(pin, blocked) for pin in pins], waiting={})
    by_code = {item.camera.code: item for item in ranked}
    eligible = [item for item in ranked if item.pinnable and not (grid_hold and item.camera.grid)]
    band = {item.camera.code for item in eligible[: wanted + HYSTERESIS_RANKS]}

    keep: list[Pin] = []
    release: list[tuple[Pin, str]] = []
    for pin in pins:
        item = by_code.get(pin.camera_code)
        if pin.camera_code in unproven:
            release.append((pin, unproven[pin.camera_code]))
        elif grid_hold and pin.grid:
            release.append((pin, hold_note or "grid pins are held"))
        elif item is None or not item.camera.anpr:
            release.append((pin, "no longer a camera the workers analyse"))
        elif pin.camera_code in band or (now - pin.pinned_at).total_seconds() < MIN_PIN_S:
            # Still among the likeliest, or pinned too recently to let go:
            # the hysteresis that stops pins chasing every change in rank.
            keep.append(pin)
        else:
            release.append((pin, "no longer among the likeliest next cameras"))

    kept = {pin.camera_code for pin in keep}
    own_open = kept | {code for code in own_lingering if code not in kept}
    own_open |= {pin.camera_code for pin, _why in release}
    all_lingering = set(lingering) | {pin.camera_code for pin, _why in release}
    open_now = set(others_open) | kept | all_lingering

    add: list[Predicted] = []
    waiting: dict[str, str] = {}
    for item in eligible[:wanted]:
        code = item.camera.code
        if code in kept:
            continue
        already_open = code in all_lingering or code in others_open
        if code not in own_open and len(own_open) >= wanted:
            waiting[code] = (
                f"this pursuit already holds {len(own_open)} stream"
                f"{'s' if len(own_open) != 1 else ''} open, its limit — a released stream stays "
                f"open {FOCUS_LINGER_S / 60:.0f} min before it can be replaced"
            )
            continue
        if not already_open and len(open_now) >= capacity:
            waiting[code] = (
                f"the workers' {capacity} focus streams are all in use (pins, released streams "
                "still open, and cameras on someone's screen)"
            )
            continue
        add.append(item)
        own_open.add(code)
        open_now.add(code)
    return PinPlan(keep=keep, add=add, release=release, waiting=waiting)


def label_pins(
    ranked: Sequence[Predicted],
    pinned: set[str],
    waiting: dict[str, str],
    *,
    grid_hold: bool,
    hold_note: str,
    dry_run: bool = False,
    blocked: str = "",
) -> None:
    """Say, on each ranked camera, whether it is pinned and if not, why not."""
    for item in ranked:
        if blocked and item.pinnable:
            item.pin_state, item.pin_note = "held", blocked
            continue
        camera = item.camera
        if camera.code in pinned:
            item.pin_state, item.pin_note = (
                ("would_pin", "would be pinned") if dry_run else ("pinned", "pinned: analysed now")
            )
        elif not camera.anpr:
            item.pin_state, item.pin_note = "not_in_fleet", "not in the ANPR fleet"
        elif camera.recorded:
            item.pin_state, item.pin_note = "recorded", "replays a recorded clip"
        elif camera.always_on:
            item.pin_state, item.pin_note = "always_on", "analysed continuously already"
        elif camera.reads_no_plates:
            item.pin_state, item.pin_note = "reads_no_plates", "reads no plates"
        elif item.window not in _PINNABLE_WINDOWS:
            item.pin_state, item.pin_note = "outside_window", "not reachable in the next 15 min"
        elif grid_hold and camera.grid:
            item.pin_state, item.pin_note = "held", hold_note
        elif camera.code in waiting:
            item.pin_state, item.pin_note = "waiting", waiting[camera.code]
        else:
            item.pin_state, item.pin_note = "ranked_lower", "ranked below the cameras pinned"


# ─────────────────────────────────────────────────────────────────────
# State
# ─────────────────────────────────────────────────────────────────────
@dataclass(slots=True)
class PursuitState:
    plate: str
    started_at: datetime
    started_by: str
    started_by_id: str
    expires_at: datetime
    pins_wanted: int
    checked_to: datetime
    anchor: Anchor | None = None
    pins: list[Pin] = field(default_factory=list)
    #: Released cameras, code → when, kept while their stream may be open.
    released: dict[str, datetime] = field(default_factory=dict)
    sightings: list[dict[str, Any]] = field(default_factory=list)
    events: list[dict[str, Any]] = field(default_factory=list)
    seen_ids: list[str] = field(default_factory=list)
    viewers: list[str] = field(default_factory=list)
    predictions: list[dict[str, Any]] = field(default_factory=list)
    excluded_unplaced: int = 0
    basis: dict[str, Any] = field(default_factory=dict)
    renewed_at: datetime | None = None
    #: The grid's state as the last tick inferred it, for the panel.
    grid: dict[str, Any] = field(default_factory=dict)

    def note(self, at: datetime, text_: str) -> None:
        self.events.insert(0, {"at": at.isoformat(), "text": text_})
        del self.events[MAX_EVENTS:]

    def to_json(self) -> str:
        return json.dumps(
            {
                "plate": self.plate,
                "started_at": self.started_at.isoformat(),
                "started_by": self.started_by,
                "started_by_id": self.started_by_id,
                "expires_at": self.expires_at.isoformat(),
                "pins_wanted": self.pins_wanted,
                "checked_to": self.checked_to.isoformat(),
                "anchor": self.anchor.to_dict() if self.anchor else None,
                "pins": [pin.to_dict() for pin in self.pins],
                "released": {code: at.isoformat() for code, at in self.released.items()},
                "sightings": self.sightings,
                "events": self.events,
                "seen_ids": self.seen_ids,
                "viewers": self.viewers,
                "predictions": self.predictions,
                "excluded_unplaced": self.excluded_unplaced,
                "basis": self.basis,
                "renewed_at": _iso(self.renewed_at),
                "grid": self.grid,
            }
        )

    @staticmethod
    def from_json(raw: str) -> PursuitState:
        data = json.loads(raw)
        now = datetime.now(UTC)
        return PursuitState(
            plate=str(data["plate"]),
            started_at=_dt(data["started_at"]) or now,
            started_by=str(data.get("started_by") or ""),
            started_by_id=str(data.get("started_by_id") or ""),
            expires_at=_dt(data["expires_at"]) or now,
            pins_wanted=int(data.get("pins_wanted") or DEFAULT_PINS),
            checked_to=_dt(data.get("checked_to")) or now,
            anchor=Anchor.from_dict(data["anchor"]) if data.get("anchor") else None,
            pins=[Pin.from_dict(pin) for pin in data.get("pins") or []],
            released={
                code: at
                for code, at in ((c, _dt(a)) for c, a in (data.get("released") or {}).items())
                if at is not None
            },
            sightings=list(data.get("sightings") or []),
            events=list(data.get("events") or []),
            seen_ids=list(data.get("seen_ids") or []),
            viewers=list(data.get("viewers") or []),
            predictions=list(data.get("predictions") or []),
            excluded_unplaced=int(data.get("excluded_unplaced") or 0),
            basis=dict(data.get("basis") or {}),
            renewed_at=_dt(data.get("renewed_at")),
            grid=dict(data.get("grid") or {}),
        )


@dataclass(slots=True)
class GridHold:
    """Whether grid pins are held, shared by every pursuit: one grid, one login."""

    until: datetime | None = None
    streak: int = 0
    reason: str = ""

    def active(self, now: datetime) -> bool:
        return self.until is not None and now < self.until

    def to_json(self) -> str:
        return json.dumps({"until": _iso(self.until), "streak": self.streak, "reason": self.reason})

    @staticmethod
    def from_json(raw: str | None) -> GridHold:
        if not raw:
            return GridHold()
        data = json.loads(raw)
        return GridHold(
            until=_dt(data.get("until")),
            streak=int(data.get("streak") or 0),
            reason=str(data.get("reason") or ""),
        )


@dataclass(slots=True)
class Context:
    """What one tick knows about the whole platform, read once for every pursuit."""

    now: datetime
    cameras: list[FleetCamera]
    basis: SpeedBasis
    pair_seconds: dict[tuple[str, str], list[float]]
    last_grid_detection: datetime | None
    on_screen: frozenset[str]
    lingering: dict[str, datetime]
    hold: GridHold
    capacity: int

    @property
    def grid_silent(self) -> bool:
        if not any(camera.grid for camera in self.cameras):
            return False
        return (
            self.last_grid_detection is None
            or (self.now - self.last_grid_detection).total_seconds() > GRID_SILENCE_S
        )

    def grid_hold(self) -> tuple[bool, str]:
        """Whether grid pins are held now, and why, in words."""
        if self.hold.until is not None and self.hold.active(self.now):
            left = (self.hold.until - self.now).total_seconds()
            return True, f"{self.hold.reason} Grid pins are held for {_minutes(left)} more."
        if self.grid_silent:
            since = (
                f"for {_minutes((self.now - self.last_grid_detection).total_seconds())}"
                if self.last_grid_detection
                else f"in the last {HISTORY.days} days"
            )
            return True, (
                f"No grid camera has produced a detection {since}. From here that is what a "
                "refused login looks like (it is also what night or a grid outage look like), "
                "so grid cameras are not pinned until grid detections resume."
            )
        return False, ""


# ─────────────────────────────────────────────────────────────────────
# Reading the platform
# ─────────────────────────────────────────────────────────────────────
_cache: dict[str, tuple[datetime, Any]] = {}

#: Registry and activity change slowly; the keeper reads them this often.
_CACHE_TTL = timedelta(minutes=5)

_LEGS_SQL = """
WITH latest AS (
    SELECT DISTINCT ON (plate_normalised) plate_normalised, hops
    FROM vehicle_tracks
    WHERE created_at >= :since
    ORDER BY plate_normalised, created_at DESC
),
legs AS (
    SELECT
        lag(e.h ->> 'camera_code') OVER (
            PARTITION BY l.plate_normalised ORDER BY e.ord
        )                                   AS from_camera,
        e.h ->> 'camera_code'               AS to_camera,
        (e.h ->> 'distance_m')::float       AS distance_m,
        (e.h ->> 'elapsed_s')::float        AS elapsed_s,
        (e.h ->> 'implied_kmph')::float     AS implied_kmph,
        (e.h ->> 'plausible')::bool         AS plausible
    FROM latest l,
         jsonb_array_elements(l.hops -> 'hops') WITH ORDINALITY AS e(h, ord)
)
SELECT from_camera, to_camera, elapsed_s, implied_kmph
FROM legs
WHERE from_camera IS NOT NULL
  AND plausible
  AND implied_kmph IS NOT NULL
  AND distance_m >= :min_separation
  AND elapsed_s > 0
  AND elapsed_s <= :max_gap
LIMIT 20000
"""


async def _fleet(session: AsyncSession, now: datetime) -> list[FleetCamera]:
    cached = _cache.get("fleet")
    if cached and now - cached[0] < timedelta(seconds=60):
        fleet: list[FleetCamera] = cached[1]
        return fleet
    always_on = _codes(settings.ai_worker_always_on) | _codes(settings.ai_worker_pinned)
    location = Camera.location.cast(Geometry)
    rows = (
        await session.execute(
            select(
                Camera.id,
                Camera.camera_code,
                Camera.name,
                Camera.city,
                Camera.anpr_enabled,
                Camera.tags,
                func.ST_Y(location),
                func.ST_X(location),
                VmsInstance.adapter_type,
            )
            .join(VmsInstance, VmsInstance.id == Camera.vms_id, isouter=True)
            .order_by(Camera.camera_code)
            .limit(MAX_CAMERAS)
        )
    ).all()
    activity = await _activity(session, now)
    fleet = []
    for row in rows:
        tags = row[5] or []
        lat, lon = row[6], row[7]
        vehicles, plates = activity.get(str(row[0]), (0, 0))
        fleet.append(
            FleetCamera(
                camera_id=str(row[0]),
                code=row[1],
                name=row[2],
                city=row[3],
                lat=float(lat) if lat is not None else None,
                lon=float(lon) if lon is not None else None,
                placed=lat is not None and lon is not None and UNPLACED_TAG not in tags,
                town_level=candidates.TOWN_LEVEL_TAG in tags,
                anpr=bool(row[4]),
                grid=row[8] == "hosted_grid",
                recorded=RECORDED_TAG in tags,
                always_on=row[1] in always_on,
                vehicles_7d=vehicles,
                plates_7d=plates,
            )
        )
    _cache["fleet"] = (now, fleet)
    return fleet


async def _activity(session: AsyncSession, now: datetime) -> dict[str, tuple[int, int]]:
    """Vehicles analysed and plates read per camera over `HISTORY`."""
    cached = _cache.get("activity")
    if cached and now - cached[0] < _CACHE_TTL:
        activity: dict[str, tuple[int, int]] = cached[1]
        return activity
    rows = (
        await session.execute(
            select(Detection.camera_id, func.count(), func.count(Detection.plate_normalised))
            .where(Detection.ts >= now - HISTORY, Detection.camera_id.isnot(None))
            .group_by(Detection.camera_id)
            .limit(MAX_CAMERAS)
        )
    ).all()
    activity = {str(row[0]): (int(row[1]), int(row[2])) for row in rows}
    _cache["activity"] = (now, activity)
    return activity


async def _speeds(
    session: AsyncSession, now: datetime, recorded: frozenset[str]
) -> tuple[SpeedBasis, dict[tuple[str, str], list[float]]]:
    """The speed band, and observed journey times per camera pair.

    Legs touching a camera that replays a recorded clip are left out: the
    time between a clip and a live camera is set by the clip, not by travel.
    """
    cached = _cache.get("speeds")
    if cached and now - cached[0] < _CACHE_TTL:
        result: tuple[SpeedBasis, dict[tuple[str, str], list[float]]] = cached[1]
        return result
    rows = (
        await session.execute(
            text(_LEGS_SQL),
            {
                "since": now - HISTORY,
                "min_separation": MIN_SEPARATION_M,
                "max_gap": correlator.UNOBSERVED_GAP.total_seconds(),
            },
        )
    ).all()
    speeds: list[float] = []
    pairs: dict[tuple[str, str], list[float]] = {}
    for from_camera, to_camera, elapsed_s, kmph in rows:
        if from_camera in recorded or to_camera in recorded:
            continue
        speeds.append(float(kmph))
        pairs.setdefault((str(from_camera), str(to_camera)), []).append(float(elapsed_s))
    result = (speed_basis(speeds), pairs)
    _cache["speeds"] = (now, result)
    return result


async def _last_grid_detection(session: AsyncSession, grid_ids: list[str]) -> datetime | None:
    if not grid_ids:
        return None
    since = datetime.now(UTC) - HISTORY
    value = (
        await session.execute(
            select(func.max(Detection.ts)).where(
                Detection.camera_id.in_([uuid.UUID(i) for i in grid_ids]), Detection.ts >= since
            )
        )
    ).scalar_one_or_none()
    return value if isinstance(value, datetime) else None


def _client() -> aioredis.Redis:
    return focus.client()


async def _released(redis: aioredis.Redis, now: datetime) -> dict[str, datetime]:
    """Cameras any pursuit released whose streams the workers may still hold."""
    key = _key("released")
    floor = now.timestamp() - FOCUS_LINGER_S
    await redis.zremrangebyscore(key, "-inf", floor)
    entries = await redis.zrangebyscore(key, f"({floor}", "+inf", withscores=True)
    return {str(code): datetime.fromtimestamp(float(score), UTC) for code, score in entries}


async def _hold(redis: aioredis.Redis) -> GridHold:
    raw = await redis.get(_key("grid"))
    return GridHold.from_json(raw if isinstance(raw, str) else None)


async def context(session: AsyncSession, now: datetime | None = None) -> Context:
    """Everything a tick needs, read once."""
    now = now or datetime.now(UTC)
    redis = _client()
    cameras = await _fleet(session, now)
    recorded = frozenset(camera.code for camera in cameras if camera.recorded)
    basis, pairs = await _speeds(session, now, recorded)
    on_screen = frozenset(await focus.watched(now.timestamp()))
    return Context(
        now=now,
        cameras=cameras,
        basis=basis,
        pair_seconds=pairs,
        last_grid_detection=await _last_grid_detection(
            session, [camera.camera_id for camera in cameras if camera.grid]
        ),
        on_screen=on_screen,
        lingering=await _released(redis, now),
        hold=await _hold(redis),
        capacity=settings.focus_max_streams,
    )


async def anchor_for(
    session: AsyncSession, plate: str, cameras: Sequence[FleetCamera], now: datetime
) -> Anchor | None:
    """The newest confirmed read of `plate` at a camera with a known position."""
    placed = {camera.camera_id: camera for camera in cameras if camera.placed}
    rows = (
        await session.execute(
            select(Detection.id, Detection.ts, Detection.camera_id)
            .where(
                Detection.plate_normalised == plate,
                Detection.ts >= now - ANCHOR_LOOKBACK,
                Detection.ts <= now,
            )
            .order_by(Detection.ts.desc())
            .limit(200)
        )
    ).all()
    for detection_id, ts, camera_id in rows:
        camera = placed.get(str(camera_id))
        if camera is not None and camera.lat is not None and camera.lon is not None:
            return _anchor_at(camera, ts, str(detection_id))
    return None


def _anchor_at(camera: FleetCamera, seen_at: datetime, detection_id: str) -> Anchor:
    if camera.lat is None or camera.lon is None:
        raise ValueError(f"{camera.code} has no position to predict from")
    return Anchor(
        camera_id=camera.camera_id,
        camera_code=camera.code,
        camera_name=camera.name,
        lat=camera.lat,
        lon=camera.lon,
        town_level=camera.town_level,
        recorded=camera.recorded,
        seen_at=seen_at,
        detection_id=detection_id,
    )


# ─────────────────────────────────────────────────────────────────────
# One step of a pursuit
# ─────────────────────────────────────────────────────────────────────
async def _new_reads(session: AsyncSession, state: PursuitState, ctx: Context) -> None:
    """Reads of the plate — and of plates near it — since the last look.

    An exact read at a placed camera newer than the anchor advances the
    pursuit. A near read is shown as a possible sighting and never advances
    it: that would be merging a candidate into the route by the back door.
    """
    plate = state.plate
    by_id = {camera.camera_id: camera for camera in ctx.cameras}
    rows = (
        await session.execute(
            select(
                Detection.id,
                Detection.ts,
                Detection.plate_normalised,
                Detection.plate_confidence,
                Detection.camera_id,
            )
            .where(
                Detection.ts > state.checked_to - LOOKBACK,
                Detection.ts <= ctx.now,
                Detection.plate_normalised.isnot(None),
                func.length(Detection.plate_normalised).between(len(plate) - 2, len(plate) + 2),
            )
            .order_by(Detection.ts.asc())
            .limit(5_000)
        )
    ).all()
    seen = set(state.seen_ids)
    for detection_id, ts, read, confidence, camera_id in rows:
        key = str(detection_id)
        if key in seen:
            continue
        seen.add(key)
        state.seen_ids.append(key)
        exact = read == plate
        match = None if exact else candidates.near(plate, read or "")
        if not exact and match is None:
            continue
        camera = by_id.get(str(camera_id))
        advanced = False
        if exact and camera is not None and camera.placed:
            if state.anchor is None or ts > state.anchor.seen_at:
                moved = state.anchor is None or state.anchor.camera_id != camera.camera_id
                state.anchor = _anchor_at(camera, ts, key)
                if moved:
                    advanced = True
                    state.note(
                        ctx.now,
                        f"Read at {camera.code} — the pursuit advanced and re-ranked from there.",
                    )
        elif exact:
            state.note(
                ctx.now,
                f"Read at {camera.code if camera else 'a camera'}, whose position is unknown — "
                "the prediction cannot start from there.",
            )
        state.sightings.insert(
            0,
            {
                "kind": "confirmed" if exact else "possible",
                "plate": read,
                "detection_id": key,
                "detection_ts": ts.isoformat(),
                "camera_code": camera.code if camera else None,
                "camera_name": camera.name if camera else None,
                "seen_at": ts.isoformat(),
                "confidence": round(float(confidence or 0.0), 4),
                "placed": bool(camera and camera.placed),
                "difference": match.describe() if match else None,
                "advanced": advanced,
            },
        )
    del state.sightings[MAX_SIGHTINGS:]
    del state.seen_ids[: max(0, len(state.seen_ids) - MAX_SEEN_IDS)]
    state.checked_to = ctx.now


async def _unproven(
    session: AsyncSession, state: PursuitState, ctx: Context
) -> tuple[dict[str, str], bool]:
    """Pinned grid cameras the workers were probably not let in to.

    Returns those to release with why, and whether any grid pin was proven —
    a detection after it was pinned is the evidence that the login worked.
    """
    waiting = [pin for pin in state.pins if pin.grid and pin.proven_at is None]
    if not waiting:
        return {}, False
    earliest = min(pin.pinned_at for pin in waiting)
    rows = (
        await session.execute(
            select(Detection.camera_id, func.max(Detection.ts))
            .where(
                Detection.camera_id.in_([uuid.UUID(pin.camera_id) for pin in waiting]),
                Detection.ts >= earliest,
            )
            .group_by(Detection.camera_id)
        )
    ).all()
    latest = {str(camera_id): ts for camera_id, ts in rows}
    failed: dict[str, str] = {}
    proven = False
    for pin in waiting:
        ts = latest.get(pin.camera_id)
        if ts is not None and ts >= pin.pinned_at:
            pin.proven_at = ts
            proven = True
            continue
        pinned_for = (ctx.now - pin.pinned_at).total_seconds()
        others_answered = (
            ctx.last_grid_detection is not None and ctx.last_grid_detection > pin.pinned_at
        )
        if pinned_for >= PIN_PROOF_S and others_answered:
            failed[pin.camera_code] = (
                f"pinned {_minutes(pinned_for)} with no detection while other grid cameras "
                "produced some — the workers were probably not let in (a refused login, or the "
                "camera is down)"
            )
    return failed, proven


async def step(
    session: AsyncSession,
    state: PursuitState,
    ctx: Context,
    *,
    others_open: frozenset[str] = frozenset(),
    dry_run: bool = False,
) -> PinPlan:
    """Advance one pursuit by one tick. Mutates `state` (and `ctx.hold`)."""
    now = ctx.now
    if not dry_run:
        await _new_reads(session, state, ctx)
    failed, proven = ({}, False) if dry_run else await _unproven(session, state, ctx)
    if proven and ctx.hold.streak:
        ctx.hold = GridHold()
    if failed:
        streak = ctx.hold.streak + 1
        hold_s = min(HOLD_CAP_S, HOLD_BASE_S * 2 ** (streak - 1))
        first = next(iter(failed))
        ctx.hold = GridHold(
            until=now + timedelta(seconds=hold_s),
            streak=streak,
            reason=f"{first} was {failed[first]}.",
        )

    held, hold_note = ctx.grid_hold()
    blocked = (
        f"not pinned: the last sighting is on {state.anchor.camera_code}, a recorded clip — "
        "no camera is opened for a vehicle that is not on the road"
        if state.anchor is not None and state.anchor.recorded
        else ""
    )
    ranked = (
        predict(state.anchor, ctx.cameras, now, ctx.basis, ctx.pair_seconds) if state.anchor else []
    )
    state.excluded_unplaced = sum(1 for camera in ctx.cameras if camera.anpr and not camera.placed)
    state.basis = ctx.basis.to_dict()
    state.grid = {
        "held": held,
        "reason": hold_note or None,
        "hold_until": _iso(ctx.hold.until) if ctx.hold.active(now) else None,
        "last_grid_detection": _iso(ctx.last_grid_detection),
        "silent": ctx.grid_silent,
    }

    own_lingering = {
        code: at
        for code, at in state.released.items()
        if (now - at).total_seconds() < FOCUS_LINGER_S
    }
    state.released = own_lingering
    plan = plan_pins(
        ranked,
        state.pins,
        wanted=state.pins_wanted,
        capacity=ctx.capacity,
        now=now,
        own_lingering=own_lingering,
        lingering=ctx.lingering,
        others_open=others_open,
        grid_hold=held,
        hold_note=hold_note,
        unproven=failed,
        blocked=blocked,
    )

    pinned_codes = {pin.camera_code for pin in plan.keep} | {i.camera.code for i in plan.add}
    label_pins(
        ranked,
        pinned_codes,
        plan.waiting,
        grid_hold=held,
        hold_note=hold_note,
        dry_run=dry_run,
        blocked=blocked,
    )
    state.predictions = [item.to_dict() for item in ranked[:MAX_PREDICTIONS]]
    if dry_run:
        return plan

    for pin, why in plan.release:
        state.released[pin.camera_code] = now
        state.note(now, f"Released {pin.camera_code}: {why}.")
    state.pins = list(plan.keep) + [
        Pin(
            camera_code=item.camera.code,
            camera_id=item.camera.camera_id,
            pinned_at=now,
            grid=item.camera.grid,
        )
        for item in plan.add
    ]
    for item in plan.add:
        state.note(
            now,
            f"Pinned {item.camera.code}: ranked {item.rank}, "
            + ("window open now" if item.window == "open" else f"window {item.window}")
            + ".",
        )
    return plan


# ─────────────────────────────────────────────────────────────────────
# Store
# ─────────────────────────────────────────────────────────────────────
async def load(plate: str) -> PursuitState | None:
    raw = await _client().get(_key("state", plate))
    return PursuitState.from_json(raw) if isinstance(raw, str) and raw else None


async def save(state: PursuitState) -> None:
    redis = _client()
    # The key outlives the pursuit a little, so a reader racing an expiry
    # finds it ended rather than never begun; the keeper deletes it anyway.
    ttl = max(60, int((state.expires_at - datetime.now(UTC)).total_seconds()) + 120)
    async with redis.pipeline(transaction=True) as pipe:
        pipe.set(_key("state", state.plate), state.to_json(), ex=ttl)
        pipe.zadd(_key("active"), {state.plate: state.started_at.timestamp()})
        await pipe.execute()


async def save_hold(hold: GridHold) -> None:
    await _client().set(_key("grid"), hold.to_json(), ex=int(HOLD_CAP_S * 4))


async def active_plates() -> list[str]:
    return [str(plate) for plate in await _client().zrange(_key("active"), 0, -1)]


def lock(plate: str) -> Any:
    """Serialises every change to one pursuit, across processes."""
    return focus.client().lock(_key("lock", plate), timeout=20, blocking_timeout=10)


async def _release_streams(codes: Iterable[str], now: datetime) -> None:
    codes = list(codes)
    if codes:
        await _client().zadd(_key("released"), dict.fromkeys(codes, now.timestamp()))


async def end(state: PursuitState, now: datetime | None = None) -> None:
    """Stop a pursuit. Its pins lapse within the focus TTL; their streams are
    counted as open for `FOCUS_LINGER_S`, as the workers keep them."""
    now = now or datetime.now(UTC)
    redis = _client()
    await _release_streams((pin.camera_code for pin in state.pins), now)
    async with redis.pipeline(transaction=True) as pipe:
        pipe.delete(_key("state", state.plate))
        pipe.zrem(_key("active"), state.plate)
        await pipe.execute()


async def heartbeat(states: Iterable[PursuitState]) -> int:
    """Keep every pinned camera on the workers' focus list."""
    codes = sorted({pin.camera_code for state in states for pin in state.pins})
    for code in codes:
        await focus.watch(code)
    return len(codes)


def others_open(
    states: Sequence[PursuitState], plate: str, on_screen: frozenset[str]
) -> frozenset[str]:
    """Streams open for someone other than this pursuit: other pursuits' pins,
    and cameras on someone's screen that no pursuit pinned."""
    pinned_elsewhere = {
        pin.camera_code for state in states if state.plate != plate for pin in state.pins
    }
    all_pinned = {pin.camera_code for state in states for pin in state.pins}
    return frozenset(pinned_elsewhere | (set(on_screen) - all_pinned))


# ─────────────────────────────────────────────────────────────────────
# Describing a pursuit
# ─────────────────────────────────────────────────────────────────────
def describe(state: PursuitState, now: datetime | None = None) -> dict[str, Any]:
    """What the pursuit panel shows. Read from the stored state alone, so the
    panel can poll it every few seconds without touching the database."""
    now = now or datetime.now(UTC)
    grid: dict[str, Any] = {
        "held": False,
        "reason": None,
        "hold_until": None,
        "last_grid_detection": None,
        "silent": False,
        **state.grid,
        "visibility": (
            "The platform cannot see the AI workers' login state — it lives in their memory "
            "and logs. It infers a refusal from detections: grid pins are held while no grid "
            f"camera has produced a detection for {GRID_SILENCE_S / 60:.0f} min, and for "
            f"{HOLD_BASE_S / 60:.0f} min (doubling to {HOLD_CAP_S / 60:.0f}) after a pinned "
            f"grid camera produced none in {PIN_PROOF_S / 60:.0f} min while others did."
        ),
    }
    anchor = state.anchor
    notes: list[str] = []
    if anchor is None:
        notes.append(
            f"{state.plate} has not been read at a camera with a known position in the last "
            f"{int(ANCHOR_LOOKBACK.total_seconds() // 3600)} h, so there is nothing to predict "
            "from. The pursuit watches every analysed camera and pins as soon as it is read."
        )
    elif anchor.recorded:
        notes.append(
            f"{anchor.camera_code} replays a recorded clip, so this sighting is not a vehicle on "
            "the road now: the prediction shows how pursuit ranks cameras, not where a real "
            "vehicle is."
        )
    return {
        "plate": state.plate,
        "status": "active" if state.expires_at > now else "expired",
        "started_at": state.started_at.isoformat(),
        "started_by": state.started_by,
        "renewed_at": _iso(state.renewed_at),
        "expires_at": state.expires_at.isoformat(),
        "remaining_s": max(0, round((state.expires_at - now).total_seconds())),
        "pins_wanted": state.pins_wanted,
        "anchor": anchor.to_dict() if anchor else None,
        "basis": state.basis,
        "predictions": state.predictions,
        "excluded_unplaced": state.excluded_unplaced,
        "pins": [pin.to_dict() for pin in state.pins],
        "released": [
            {
                "camera_code": code,
                "released_at": at.isoformat(),
                "closes_at": (at + timedelta(seconds=FOCUS_LINGER_S)).isoformat(),
            }
            for code, at in sorted(state.released.items(), key=lambda item: item[1])
        ],
        "sightings": state.sightings,
        "events": state.events,
        "grid": grid,
        "policy": {
            "duration_s": DURATION.total_seconds(),
            "min_pin_s": MIN_PIN_S,
            "linger_s": FOCUS_LINGER_S,
            "horizon_s": HORIZON_S,
            "focus_capacity": settings.focus_max_streams,
            "grid_silence_s": GRID_SILENCE_S,
            "pin_proof_s": PIN_PROOF_S,
        },
        "notes": notes,
    }


def summary(state: PursuitState, now: datetime | None = None) -> dict[str, Any]:
    """One line of a pursuit, for the top bar. No sightings in it."""
    now = now or datetime.now(UTC)
    return {
        "plate": state.plate,
        "started_at": state.started_at.isoformat(),
        "started_by": state.started_by,
        "expires_at": state.expires_at.isoformat(),
        "remaining_s": max(0, round((state.expires_at - now).total_seconds())),
        "pins": [pin.camera_code for pin in state.pins],
    }


def clamp_pins(requested: int | None) -> int:
    """The pins a pursuit may hold: at least one, never above the workers'
    focus capacity."""
    capacity = max(1, settings.focus_max_streams)
    return max(1, min(capacity, requested or DEFAULT_PINS))


def new_state(plate: str, username: str, user_id: str, pins: int, now: datetime) -> PursuitState:
    return PursuitState(
        plate=plate,
        started_at=now,
        started_by=username,
        started_by_id=user_id,
        expires_at=now + DURATION,
        pins_wanted=pins,
        checked_to=now,
    )


# ─────────────────────────────────────────────────────────────────────
# The keeper
# ─────────────────────────────────────────────────────────────────────
class PursuitKeeper:
    """Runs every pursuit's tick, in the API process.

    One replica does the work per tick (a short Redis lock), so a scaled-out
    API does not pin twice or record an expiry twice.
    """

    def __init__(self) -> None:
        self._task: asyncio.Task[None] | None = None
        self._stop = asyncio.Event()

    def start(self) -> None:
        self._stop.clear()
        self._task = asyncio.create_task(self._loop(), name="pursuit-keeper")

    async def stop(self) -> None:
        self._stop.set()
        if self._task is not None:
            self._task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await self._task
            self._task = None

    async def _loop(self) -> None:
        while not self._stop.is_set():
            try:
                await self.tick()
            except Exception as exc:
                # Supervisor boundary: one bad tick must not end pursuit for
                # the rest of the process's life.
                log.error("pursuit.tick_failed", error=str(exc), exc_info=True)
            with contextlib.suppress(TimeoutError):
                await asyncio.wait_for(self._stop.wait(), timeout=TICK_S)

    async def tick(self, now: datetime | None = None) -> int:
        """One pass over every active pursuit. Returns how many are active."""
        now = now or datetime.now(UTC)
        redis = _client()
        try:
            got = await redis.set(
                _key("tick"), secrets.token_hex(4), nx=True, ex=max(1, int(TICK_S) - 1)
            )
        except RedisError as exc:
            log.warning("pursuit.redis_unavailable", error=str(exc))
            return 0
        if not got:
            return 0
        plates = await active_plates()
        if not plates:
            return 0

        from app.services import audit  # imported here: audit imports the ORM session

        states: list[PursuitState] = []
        async with SessionLocal() as session:
            ctx = await context(session, now)
            current = [s for s in [await load(p) for p in plates] if s is not None]
            for plate in plates:
                async with lock(plate):
                    state = await load(plate)
                    if state is None:
                        await redis.zrem(_key("active"), plate)
                        continue
                    if state.expires_at <= now:
                        await end(state, now)
                        await audit.record(
                            action="pursuit.expire",
                            username="system",
                            role="system",
                            resource_type="vehicle",
                            resource_id=state.plate,
                            params={
                                "plate": state.plate,
                                "started_by": state.started_by,
                                "pins": [pin.camera_code for pin in state.pins],
                                "sightings": len(state.sightings),
                            },
                        )
                        log.info("pursuit.expired", plate=state.plate)
                        continue
                    plan = await step(
                        session,
                        state,
                        ctx,
                        others_open=others_open(current, plate, ctx.on_screen),
                    )
                    await save(state)
                    await _release_streams((pin.camera_code for pin, _why in plan.release), now)
                    current = [state if s.plate == plate else s for s in current]
                    states.append(state)
            await save_hold(ctx.hold)
        await heartbeat(states)
        return len(states)


keeper = PursuitKeeper()
