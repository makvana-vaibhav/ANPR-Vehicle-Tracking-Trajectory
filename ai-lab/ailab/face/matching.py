"""When a face a camera sees becomes a *possible match* — and when it does not.

One frame is one chance to be wrong. Face recognition across a camera's field
of view meets every pose, blur and lighting a reference photo never had, and a
single frame scoring over a threshold is the weakest evidence there is. So a
face is followed across analysed frames (a light tracker on position and size)
and a possible match is announced only when **several frames of the same face
agree on the same entry**, each one above the threshold and clear of the
next-closest entry. Then it is announced once for that face, and not again for
that person on this camera until a cooldown has passed.

Even then it is a *possible* match. Nothing here identifies anyone, and nothing
downstream acts on it without a person comparing the two faces (see the alert
the API raises from it).

## Privacy by design — what this module never holds

These are properties of the code, asserted by `tests/test_face.py`:

* **No embedding.** `FaceWatch` is handed the *result* of comparing a face to
  the gallery, never the face's embedding. The embedding is computed, compared
  and discarded inside one call in `FaceStage.process`.
* **No crop of a face that did not match.** Evidence (the face crop) is asked
  for only for a frame whose comparison passed the threshold and the margin.
  A face that matches nothing never has a crop taken at all.
* **No crop of a face that matched once and then stopped.** Evidence for a
  candidate is held in memory only while its track is alive, at most one
  frame's worth per entry per track, and is released — never uploaded — when
  the track ends without enough frames agreeing.
"""

from __future__ import annotations

import dataclasses
import math
from collections.abc import Callable, Sequence
from dataclasses import dataclass, field
from typing import Any

from ailab.face.gallery import GalleryEntry, GalleryMatch, MatchPolicy
from ailab.face.models import FaceBox


@dataclass(frozen=True, slots=True)
class FaceObservation:
    """One face in one analysed frame, after it was compared with the gallery.

    `match` is the nearest active entry whatever the score, or None when the
    gallery is empty or every entry has expired. There is deliberately no
    embedding field.
    """

    box: FaceBox
    match: GalleryMatch | None


@dataclass(frozen=True, slots=True)
class PossibleMatch:
    """Enough frames of one face agreed on one entry. What the event reports."""

    person_id: str
    category: str
    case_ref: str
    #: The best agreeing frame's similarity.
    similarity: float
    #: Every agreeing frame's similarity, in the order they were seen.
    similarities: tuple[float, ...]
    frames_agreed: int
    frames_seen: int
    frames_required: int
    threshold: float
    min_margin: float
    #: The smallest margin over the next-closest entry among the agreeing
    #: frames — the weakest point of the claim, not the strongest. None when
    #: the gallery held only this entry.
    margin: float | None
    first_t_s: float
    last_t_s: float
    #: The face in the best agreeing frame.
    box: FaceBox
    #: What the evidence callback produced for that frame (the face crop).
    evidence: Any
    track_id: int

    @property
    def mean_similarity(self) -> float:
        return sum(self.similarities) / len(self.similarities)

    @property
    def window_s(self) -> float:
        return max(0.0, self.last_t_s - self.first_t_s)


@dataclass(slots=True)
class _Agreement:
    times: list[float] = field(default_factory=list)
    similarities: list[float] = field(default_factory=list)
    margins: list[float | None] = field(default_factory=list)
    best_similarity: float = -2.0
    best_box: FaceBox | None = None
    #: The crop of the best agreeing frame, held until announced or released.
    evidence: Any = None
    entry: GalleryEntry | None = None


@dataclass(slots=True)
class _Track:
    track_id: int
    box: FaceBox
    last_t_s: float
    frames_seen: int = 0
    agreements: dict[str, _Agreement] = field(default_factory=dict)
    announced: set[str] = field(default_factory=set)

    def release(self) -> None:
        for agreement in self.agreements.values():
            agreement.evidence = None
        self.agreements.clear()


@dataclass(slots=True)
class WatchStats:
    observations: int = 0
    candidate_frames: int = 0
    evidence_taken: int = 0
    evidence_released: int = 0
    announced: int = 0
    suppressed_cooldown: int = 0
    conflicts: int = 0
    tracks_started: int = 0
    tracks_dropped_full: int = 0

    def to_dict(self) -> dict[str, int]:
        return dataclasses.asdict(self)


class FaceWatch:
    """Per-camera face tracks and the agreement rule. Not thread-safe; one per
    camera run, like the pipeline it sits beside."""

    def __init__(
        self,
        policy: MatchPolicy,
        *,
        max_gap_s: float = 2.5,
        cooldown_s: float = 60.0,
        max_jump: float = 2.0,
        max_tracks: int = 64,
    ) -> None:
        self.policy = policy
        self.max_gap_s = max_gap_s
        self.cooldown_s = cooldown_s
        #: How far a face may move between analysed frames, in face widths,
        #: and still be the same face. Sampled at two frames a second, a person
        #: walking toward a camera moves well under one; crossing it, more.
        self.max_jump = max_jump
        #: A crowd must not grow memory without bound. Past this, new faces are
        #: not followed (and so cannot be announced) until older tracks end.
        self.max_tracks = max_tracks
        self.stats = WatchStats()
        self._tracks: dict[int, _Track] = {}
        self._next_track_id = 0
        #: person_id -> source time of the last announcement on this camera.
        self._announced_at: dict[str, float] = {}

    # ── public ─────────────────────────────────────────────────────────
    @property
    def held_evidence(self) -> int:
        """How many crops are held in memory right now. Bounded by tracks x
        entries with a candidate frame; zero whenever nothing is a candidate."""
        return sum(
            1
            for track in self._tracks.values()
            for agreement in track.agreements.values()
            if agreement.evidence is not None
        )

    @property
    def live_tracks(self) -> int:
        return len(self._tracks)

    def reset(self) -> None:
        """Forget every face in view — a scene cut, or analysis pausing.

        Cooldowns survive: they are about not announcing the same person on
        the same camera twice in a minute, which a recording looping does not
        change.
        """
        for track in self._tracks.values():
            self._release(track)
        self._tracks.clear()

    def retain(self, person_ids: set[str]) -> None:
        """Drop agreement held for any entry no longer in the gallery.

        An entry retired, rejected or expired between two frames must not be
        announced on the strength of frames compared while it was active.
        """
        for track in self._tracks.values():
            for person in [p for p in track.agreements if p not in person_ids]:
                self._release_agreement(track.agreements.pop(person))
        for person in [p for p in self._announced_at if p not in person_ids]:
            del self._announced_at[person]

    def observe(
        self,
        t_s: float,
        observations: Sequence[FaceObservation],
        evidence: Callable[[FaceObservation], Any] | None = None,
    ) -> list[PossibleMatch]:
        """Take one analysed frame's faces; return any match that just became
        possible. `evidence` is called only for a candidate frame (see the
        module docstring), and its result is what an announcement carries."""
        self._prune(t_s)
        assigned = self._associate(observations)

        announced: list[PossibleMatch] = []
        for observation, track in assigned:
            self.stats.observations += 1
            if track is None:
                continue
            track.box = observation.box
            track.last_t_s = t_s
            track.frames_seen += 1

            if not self._is_candidate(observation.match):
                continue
            match = observation.match
            assert match is not None  # narrowed by _is_candidate
            person = match.entry.person_id
            self.stats.candidate_frames += 1
            if person in track.announced:
                # Already said, for this face. Nothing more is gathered about
                # it — no further crop is taken of a face already reported.
                continue

            agreement = track.agreements.setdefault(person, _Agreement(entry=match.entry))
            agreement.times.append(t_s)
            agreement.similarities.append(match.similarity)
            agreement.margins.append(match.margin)
            if match.similarity > agreement.best_similarity:
                agreement.best_similarity = match.similarity
                agreement.best_box = observation.box
                if evidence is not None:
                    # Replaces the previous best frame's crop; the old one is
                    # dropped here rather than kept "in case".
                    if agreement.evidence is not None:
                        self.stats.evidence_released += 1
                    agreement.evidence = evidence(observation)
                    self.stats.evidence_taken += 1

            confirmed = self._confirm(track, person, t_s)
            if confirmed is not None:
                announced.append(confirmed)
        return announced

    # ── internals ──────────────────────────────────────────────────────
    def _is_candidate(self, match: GalleryMatch | None) -> bool:
        if match is None or match.similarity < self.policy.threshold:
            return False
        return match.margin is None or match.margin >= self.policy.min_margin

    def _confirm(self, track: _Track, person: str, t_s: float) -> PossibleMatch | None:
        agreement = track.agreements[person]
        if person in track.announced or len(agreement.times) < self.policy.min_frames:
            return None

        # Frames of this face that agreed with a *different* entry make the
        # face ambiguous. Saying nothing is the right answer to ambiguity.
        if any(other != person and a.times for other, a in track.agreements.items()):
            self.stats.conflicts += 1
            return None

        track.announced.add(person)
        last = self._announced_at.get(person)
        if last is not None and t_s - last < self.cooldown_s:
            self.stats.suppressed_cooldown += 1
            self._release_agreement(agreement)
            return None
        self._announced_at[person] = t_s
        self.stats.announced += 1

        entry = agreement.entry
        assert entry is not None and agreement.best_box is not None
        margins = [m for m in agreement.margins if m is not None]
        evidence = agreement.evidence
        # Handed over with the announcement; this module keeps no copy.
        agreement.evidence = None
        return PossibleMatch(
            person_id=person,
            category=entry.category,
            case_ref=entry.case_ref,
            similarity=agreement.best_similarity,
            similarities=tuple(agreement.similarities),
            frames_agreed=len(agreement.times),
            frames_seen=track.frames_seen,
            frames_required=self.policy.min_frames,
            threshold=self.policy.threshold,
            min_margin=self.policy.min_margin,
            margin=min(margins) if margins else None,
            first_t_s=agreement.times[0],
            last_t_s=agreement.times[-1],
            box=agreement.best_box,
            evidence=evidence,
            track_id=track.track_id,
        )

    def _associate(
        self, observations: Sequence[FaceObservation]
    ) -> list[tuple[FaceObservation, _Track | None]]:
        """Greedy nearest-first assignment of this frame's faces to tracks."""
        pairs: list[tuple[float, int, int]] = []
        for index, observation in enumerate(observations):
            box = observation.box
            for track in self._tracks.values():
                reference = max(track.box.w, box.w, 1.0)
                ratio = box.w / max(track.box.w, 1.0)
                if not 0.5 <= ratio <= 2.0:
                    continue
                distance = math.hypot(box.cx - track.box.cx, box.cy - track.box.cy) / reference
                if distance <= self.max_jump:
                    pairs.append((distance, index, track.track_id))
        pairs.sort()

        chosen: dict[int, _Track] = {}
        taken: set[int] = set()
        for _distance, index, track_id in pairs:
            if index in chosen or track_id in taken:
                continue
            chosen[index] = self._tracks[track_id]
            taken.add(track_id)

        result: list[tuple[FaceObservation, _Track | None]] = []
        for index, observation in enumerate(observations):
            assigned: _Track | None = chosen.get(index)
            if assigned is None:
                assigned = self._start(observation.box)
            result.append((observation, assigned))
        return result

    def _start(self, box: FaceBox) -> _Track | None:
        if len(self._tracks) >= self.max_tracks:
            self.stats.tracks_dropped_full += 1
            return None
        self._next_track_id += 1
        track = _Track(track_id=self._next_track_id, box=box, last_t_s=-math.inf)
        self._tracks[track.track_id] = track
        self.stats.tracks_started += 1
        return track

    def _prune(self, t_s: float) -> None:
        for track_id in [
            tid for tid, track in self._tracks.items() if t_s - track.last_t_s > self.max_gap_s
        ]:
            self._release(self._tracks.pop(track_id))
        # Cooldowns long past are forgotten, so a person's id is not kept for
        # the life of the process.
        for person in [p for p, at in self._announced_at.items() if t_s - at > self.cooldown_s]:
            del self._announced_at[person]

    def _release(self, track: _Track) -> None:
        for agreement in track.agreements.values():
            self._release_agreement(agreement)
        track.release()

    def _release_agreement(self, agreement: _Agreement) -> None:
        if agreement.evidence is not None:
            self.stats.evidence_released += 1
        agreement.evidence = None
