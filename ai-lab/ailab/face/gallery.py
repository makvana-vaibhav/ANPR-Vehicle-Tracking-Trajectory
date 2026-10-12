"""The active persons gallery: what the API publishes and what the edge matches.

The API owns the persons watchlist (enrolment, four-eyes approval, expiry) and
publishes the entries that are *active right now* to Redis whenever that set
changes. A worker reads the payload and builds a `Gallery`; a face seen by a
camera is compared against it and nothing else.

What travels is deliberately thin: an entry's id, category, case reference,
expiry and its SFace embedding(s). **Never the photograph, never the name.** A
worker needs to know *whether* a face matches an approved entry and how
closely; who the entry is about is for an operator with the `person.read`
permission, behind an audited API call.

The payload also carries the platform's match policy (threshold, frames that
must agree, margin over the next-closest entry), so the policy has one owner —
the API's settings — and a worker applies whichever of its own configuration
and the platform's is stricter. A worker can be made more careful locally; it
cannot be made less careful than the platform allows.

And the payload expires. A worker that loses contact with the platform keeps
the last gallery only until `expires_at`, then matches against nothing: an
entry retired while the link was down must not go on being matched for as long
as the outage lasts.
"""

from __future__ import annotations

import base64
import logging
from collections.abc import Mapping, Sequence
from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import Any

import numpy as np

from ailab.face.models import EMBEDDING_DIM, SFACE_MODEL_ID

log = logging.getLogger(__name__)

GALLERY_SCHEMA = "contrail.persons.gallery.v1"

#: Platform defaults, used when a payload predates the policy block. The API's
#: settings are the real source; these exist so a worker never runs with no
#: policy at all.
DEFAULT_THRESHOLD = 0.45
DEFAULT_MIN_FRAMES = 2
DEFAULT_MIN_MARGIN = 0.05


@dataclass(frozen=True, slots=True)
class MatchPolicy:
    """When a face counts as a possible match.

    * `threshold` — cosine similarity a frame must reach against an entry.
    * `min_frames` — how many analysed frames of the same face must reach it
      for the same entry before anything is said. One frame is one chance to
      be wrong; agreement across frames is what makes a match worth a person's
      attention.
    * `min_margin` — how far ahead of the next-closest entry the best one must
      be. Two enrolled people who resemble each other must not let a face
      "match" whichever of them happened to score higher by a hair.
    """

    threshold: float = DEFAULT_THRESHOLD
    min_frames: int = DEFAULT_MIN_FRAMES
    min_margin: float = DEFAULT_MIN_MARGIN

    def stricter(self, other: MatchPolicy) -> MatchPolicy:
        """The stricter of two policies, setting by setting."""
        return MatchPolicy(
            threshold=max(self.threshold, other.threshold),
            min_frames=max(self.min_frames, other.min_frames),
            min_margin=max(self.min_margin, other.min_margin),
        )

    def to_dict(self) -> dict[str, Any]:
        return {
            "threshold": self.threshold,
            "min_frames": self.min_frames,
            "min_margin": self.min_margin,
        }

    @classmethod
    def from_dict(cls, data: Mapping[str, Any] | None) -> MatchPolicy:
        data = data or {}
        return cls(
            threshold=float(data.get("threshold", DEFAULT_THRESHOLD)),
            min_frames=max(1, int(data.get("min_frames", DEFAULT_MIN_FRAMES))),
            min_margin=max(0.0, float(data.get("min_margin", DEFAULT_MIN_MARGIN))),
        )


def encode_embedding(vector: np.ndarray) -> str:
    """A 128-d embedding as base64 of little-endian float32 — exact, and a
    third the size of the same numbers written out as JSON."""
    array = np.asarray(vector, dtype="<f4").reshape(-1)
    if array.shape != (EMBEDDING_DIM,):
        raise ValueError(f"an embedding has {EMBEDDING_DIM} values, not {array.shape[0]}")
    return base64.b64encode(array.tobytes()).decode("ascii")


def decode_embedding(text: str) -> np.ndarray:
    """The inverse of `encode_embedding`, unit-normalised and validated."""
    raw = base64.b64decode(text, validate=True)
    if len(raw) != EMBEDDING_DIM * 4:
        raise ValueError(f"an embedding is {EMBEDDING_DIM * 4} bytes, not {len(raw)}")
    vector = np.frombuffer(raw, dtype="<f4").astype(np.float32)
    if not np.all(np.isfinite(vector)):
        raise ValueError("an embedding contains a non-finite value")
    norm = float(np.linalg.norm(vector))
    if norm <= 0.0:
        raise ValueError("an embedding of all zeros matches nothing")
    # Re-normalised only when it is not unit length already, so a vector that
    # was published normalised arrives bit-for-bit as it was computed.
    return vector if abs(norm - 1.0) < 1e-4 else vector / norm


def _parse_time(value: Any) -> datetime | None:
    if not isinstance(value, str) or not value:
        return None
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None
    return parsed if parsed.tzinfo else parsed.replace(tzinfo=UTC)


@dataclass(frozen=True, slots=True)
class GalleryEntry:
    """One approved, active entry, as a worker needs it. No photo, no name."""

    person_id: str
    category: str
    case_ref: str
    valid_until: datetime | None
    #: (k, 128) float32, each row unit length. Usually one row: one reference
    #: photo per entry.
    embeddings: np.ndarray = field(repr=False)

    def is_valid_at(self, when: datetime) -> bool:
        """Expiry enforced at match time as well as at publish time, so an
        entry that lapses between two publishes stops matching on the minute."""
        return self.valid_until is None or when <= self.valid_until


@dataclass(frozen=True, slots=True)
class GalleryMatch:
    """How close one face came to the nearest active entry."""

    entry: GalleryEntry
    similarity: float
    #: The best similarity to any *other* entry, or None when there is no
    #: other entry. What `margin` is measured against.
    runner_up: float | None

    @property
    def margin(self) -> float | None:
        return None if self.runner_up is None else self.similarity - self.runner_up


class Gallery:
    """Active entries, stacked into one matrix so a face costs one product."""

    def __init__(
        self,
        entries: Sequence[GalleryEntry],
        *,
        version: str = "",
        model: str = SFACE_MODEL_ID,
        policy: MatchPolicy | None = None,
        published_at: datetime | None = None,
        expires_at: datetime | None = None,
    ) -> None:
        self.entries = tuple(entries)
        self.version = version
        self.model = model
        self.policy = policy or MatchPolicy()
        self.published_at = published_at
        self.expires_at = expires_at
        rows = [entry.embeddings for entry in self.entries if entry.embeddings.size]
        self._matrix = (
            np.vstack(rows).astype(np.float32)
            if rows
            else np.zeros((0, EMBEDDING_DIM), dtype=np.float32)
        )
        owners: list[int] = []
        for index, entry in enumerate(self.entries):
            owners.extend([index] * int(entry.embeddings.shape[0]))
        self._owner = np.asarray(owners, dtype=np.int64)

    def __len__(self) -> int:
        return len(self.entries)

    @property
    def is_empty(self) -> bool:
        return not self.entries

    def is_expired(self, now: datetime) -> bool:
        return self.expires_at is not None and now > self.expires_at

    def best(self, embedding: np.ndarray, when: datetime | None = None) -> GalleryMatch | None:
        """The nearest entry valid at `when`, and how far ahead of the rest.

        Returns the nearest entry whatever its score; whether that score is a
        match is the policy's decision, not the gallery's.
        """
        if self.is_empty:
            return None
        moment = when or datetime.now(UTC)
        vector = np.asarray(embedding, dtype=np.float32).reshape(-1)
        scores = self._matrix @ vector

        per_entry: dict[int, float] = {}
        for row, owner in enumerate(self._owner.tolist()):
            score = float(scores[row])
            if score > per_entry.get(owner, -2.0):
                per_entry[owner] = score

        valid = [
            (score, owner)
            for owner, score in per_entry.items()
            if self.entries[owner].is_valid_at(moment)
        ]
        if not valid:
            return None
        valid.sort(reverse=True)
        best_score, best_owner = valid[0]
        runner_up = valid[1][0] if len(valid) > 1 else None
        return GalleryMatch(
            entry=self.entries[best_owner], similarity=best_score, runner_up=runner_up
        )

    # ── the wire format ────────────────────────────────────────────────
    @classmethod
    def from_payload(
        cls, payload: Mapping[str, Any], *, model: str = SFACE_MODEL_ID
    ) -> Gallery:
        """Parse what the API published. Entries that cannot be trusted are
        skipped and logged, never guessed at: a malformed vector compared
        against faces would produce scores that mean nothing."""
        if payload.get("schema") not in (None, GALLERY_SCHEMA):
            raise ValueError(f"unknown gallery schema {payload.get('schema')!r}")
        published_model = str(payload.get("model") or model)
        if published_model != model:
            # Comparing embeddings from two models is comparing two unrelated
            # spaces. Refuse the whole gallery rather than produce scores.
            log.warning(
                "persons gallery is in %s space but this worker computes %s; matching nothing",
                published_model,
                model,
            )
            return cls([], version=str(payload.get("version") or ""), model=model)

        entries: list[GalleryEntry] = []
        for item in payload.get("entries") or []:
            try:
                vectors = [decode_embedding(text) for text in item.get("embeddings") or []]
                if not vectors:
                    raise ValueError("no embeddings")
                entries.append(
                    GalleryEntry(
                        person_id=str(item["person_id"]),
                        category=str(item.get("category") or ""),
                        case_ref=str(item.get("case_ref") or ""),
                        valid_until=_parse_time(item.get("valid_until")),
                        embeddings=np.vstack(vectors),
                    )
                )
            except (KeyError, TypeError, ValueError) as exc:
                log.warning("skipping a gallery entry that cannot be read: %s", exc)

        return cls(
            entries,
            version=str(payload.get("version") or ""),
            model=published_model,
            policy=MatchPolicy.from_dict(payload.get("policy")),
            published_at=_parse_time(payload.get("published_at")),
            expires_at=_parse_time(payload.get("expires_at")),
        )


#: What a worker matches against before it has read anything, or after the
#: gallery it had expired: nothing.
EMPTY_GALLERY = Gallery([])


def build_payload(
    entries: Sequence[Mapping[str, Any]],
    *,
    version: str,
    policy: MatchPolicy,
    published_at: datetime,
    expires_at: datetime,
    model: str = SFACE_MODEL_ID,
) -> dict[str, Any]:
    """The payload the API publishes. `entries` carry already-encoded
    embeddings (`encode_embedding`), never photographs or names."""
    return {
        "schema": GALLERY_SCHEMA,
        "version": version,
        "model": model,
        "published_at": published_at.isoformat(),
        "expires_at": expires_at.isoformat(),
        "policy": policy.to_dict(),
        "entries": [
            {
                "person_id": str(entry["person_id"]),
                "category": str(entry.get("category") or ""),
                "case_ref": str(entry.get("case_ref") or ""),
                "valid_until": (
                    entry["valid_until"].isoformat()
                    if isinstance(entry.get("valid_until"), datetime)
                    else entry.get("valid_until")
                ),
                "embeddings": list(entry.get("embeddings") or []),
            }
            for entry in entries
        ],
    }
