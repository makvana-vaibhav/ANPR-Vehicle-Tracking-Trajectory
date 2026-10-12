"""What each role may receive on the live event feed.

`/ws/events` used to send every event, whole, to every signed-in role. That
quietly undid the RBAC matrix: an auditor — who by design cannot search plates
(app/core/rbac.py) — received every plate the platform read, as it read it, with
a signed link to the crop; an analyst, who by design does not watch live video,
received stills cut from it. The REST surface already drew those lines
(`/detections` and `/vehicles` need `search.execute`; video needs `stream.view`).
This module draws the same lines on the feed.

## The rules, per event type

| Event | Who receives it | What is withheld |
|---|---|---|
| `connected`, `keepalive` | everyone on the feed | — |
| `vehicle.observed`, `vehicle.completed` | `camera.read` | plate text and every plate-derived field without `search.execute`; crops and the evidence block without `stream.view` + `search.execute` |
| `camera.tracks` (overlay boxes) | `stream.view` | plate labels without `search.execute` |
| `alert.raised` | `alert.read` | plate, notes, reasons and the watchlist entry, on an alert about a plate, without `search.execute` |
| anything else | roles holding both `search.execute` and `stream.view` | — (unknown shapes are not guessed at) |

A role that may receive none of these — `api_client` — is refused the socket.

**Operators, supervisors and admins hold every grant involved, so they receive
every event exactly as before**: the full-feed path returns the event object
untouched. Withholding is done by *rebuilding* a vehicle event from an
allow-list rather than deleting known plate fields, so a plate-bearing field
added to the event later is withheld by default instead of leaking by default.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from app.core.rbac import Permission, permissions_for

#: Always delivered: they carry nothing about any vehicle.
CONTROL_EVENTS = frozenset({"connected", "keepalive"})
VEHICLE_EVENTS = frozenset({"vehicle.observed", "vehicle.completed"})
TRACKS_EVENT = "camera.tracks"
ALERT_EVENT = "alert.raised"

#: Top-level keys of a vehicle event that identify no one: where and when, and
#: what kind of vehicle went which way. Everything else is withheld from a role
#: without plate search.
_VEHICLE_SAFE_KEYS = frozenset(
    {
        "schema",
        "event",
        "event_time",
        "captured_at",
        "position_refresh",
        "source",
        "frame",
        "vehicle",
        "run_id",
        "latency_ms",
    }
)

#: Keys of a track box that are the plate's reading, withheld without search.
_TRACK_PLATE_KEYS = frozenset(
    {"plate", "confidence", "grammar_valid", "ambiguous", "corrected_from"}
)

#: What an alert about a plate keeps for a role without plate search: that an
#: alarm of this kind and priority happened, where, and when.
_ALERT_SAFE_KEYS = frozenset(
    {
        "event",
        "alert_id",
        "alert_type",
        "priority",
        "status",
        "camera_id",
        "detection_id",
        "created_at",
    }
)


@dataclass(frozen=True, slots=True)
class FeedPolicy:
    """One subscriber's entitlements on the feed, derived from its role."""

    #: `camera.read`: vehicle events at all (counts, types, positions).
    vehicles: bool
    #: `search.execute`: plate text, as on `/detections`.
    plates: bool
    #: `stream.view` (+ plates): crops, and the overlay boxes for live video.
    imagery: bool
    #: `alert.read`: alarms.
    alerts: bool

    @classmethod
    def for_role(cls, role: str | None) -> FeedPolicy:
        granted = permissions_for(role or "")
        plates = Permission.SEARCH_EXECUTE in granted
        return cls(
            vehicles=Permission.CAMERA_READ in granted,
            plates=plates,
            imagery=plates and Permission.STREAM_VIEW in granted,
            alerts=Permission.ALERT_READ in granted,
        )

    @property
    def receives_anything(self) -> bool:
        return self.vehicles or self.alerts

    @property
    def full(self) -> bool:
        """Every grant the feed involves: events pass through untouched."""
        return self.vehicles and self.plates and self.imagery and self.alerts

    def apply(self, event: dict[str, Any]) -> dict[str, Any] | None:
        """The event as this subscriber may see it, or None to skip it."""
        kind = event.get("event")
        if kind in CONTROL_EVENTS:
            return event
        if self.full:
            return event
        if kind in VEHICLE_EVENTS:
            return self._vehicle(event) if self.vehicles else None
        if kind == TRACKS_EVENT:
            return self._tracks(event) if self.imagery else None
        if kind == ALERT_EVENT:
            return self._alert(event) if self.alerts else None
        # A shape this policy does not know: not guessed at.
        return None

    def _vehicle(self, event: dict[str, Any]) -> dict[str, Any]:
        if self.plates and self.imagery:
            return event
        if self.plates:
            # Plate text as `/detections` gives it; no stills from the video.
            return {key: value for key, value in event.items() if key != "evidence"}
        out = {key: value for key, value in event.items() if key in _VEHICLE_SAFE_KEYS}
        plate = event.get("plate")
        out["plate"] = {
            # Whether a plate was read is a count, not an identity.
            "readable": bool(isinstance(plate, dict) and plate.get("readable")),
            "text": "",
            "withheld": True,
        }
        return out

    def _tracks(self, event: dict[str, Any]) -> dict[str, Any]:
        if self.plates:
            return event
        tracks = event.get("tracks")
        if not isinstance(tracks, list):
            return event
        return {
            **event,
            "tracks": [
                {key: value for key, value in box.items() if key not in _TRACK_PLATE_KEYS}
                if isinstance(box, dict)
                else box
                for box in tracks
            ],
        }

    def _alert(self, event: dict[str, Any]) -> dict[str, Any]:
        if self.plates or not event.get("plate"):
            # Not about a plate (a camera down, an integration fault, a person
            # match without its photograph), or the role may see plates.
            return event
        out = {key: value for key, value in event.items() if key in _ALERT_SAFE_KEYS}
        out["plate"] = None
        out["withheld"] = True
        return out
