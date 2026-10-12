"""`person.match`: the one event the face stage emits.

Hand-rolled like the vehicle events in `ailab/stream/events.py` (CLAUDE.md §5:
the contracts package is still empty), and consumed by
`services/api/app/services/event_consumer.py`, which turns it into a
`person_match` alert. Change one, change the other.

What it carries is the claim and its working — which entry, how similar, over
how many frames, against what threshold — plus the *object key* of the face
crop, uploaded from the edge to the private persons bucket. Never the crop's
bytes (the central tier carries events, not pixels), never an embedding, and
never the entry's name or photograph: those stay behind the API's audited
`person.read` endpoints.

It is only ever emitted for a face that several frames agreed on. Faces that
matched nothing produce no event, no crop and no log line naming them.
"""

from __future__ import annotations

import uuid
from collections.abc import Mapping
from datetime import UTC, datetime
from typing import Any

from ailab.face.matching import PossibleMatch
from ailab.face.models import (
    SFACE_MODEL_ID,
    SFACE_PUBLISHED_COSINE_THRESHOLD,
    YUNET_MODEL_ID,
)

SCHEMA_PERSON_MATCH = "ailab.person.match.v1"
EVENT_PERSON_MATCH = "person.match"


def person_match_event(
    match: PossibleMatch,
    source: Mapping[str, Any],
    *,
    captured_at: datetime | None,
    frame_size: tuple[int, int] | None,
    face_crop_key: str | None,
    gallery_version: str,
    latency_ms: float | None = None,
    run_id: str = "",
) -> dict[str, Any]:
    """One possible match, shaped for the platform."""
    payload: dict[str, Any] = {
        "schema": SCHEMA_PERSON_MATCH,
        "event": EVENT_PERSON_MATCH,
        # Lets the consumer recognise a redelivery of this exact event.
        "event_id": uuid.uuid4().hex,
        "event_time": datetime.now(UTC).isoformat(),
        "captured_at": captured_at.isoformat() if captured_at is not None else None,
        "source": dict(source),
        "frame": (
            {"width": frame_size[0], "height": frame_size[1]} if frame_size is not None else None
        ),
        "person": {
            "id": match.person_id,
            "category": match.category,
            "case_ref": match.case_ref,
        },
        "match": {
            "similarity": round(match.similarity, 4),
            "similarity_mean": round(match.mean_similarity, 4),
            "similarities": [round(s, 4) for s in match.similarities],
            "threshold": round(match.threshold, 4),
            "model_threshold": SFACE_PUBLISHED_COSINE_THRESHOLD,
            "frames_agreed": match.frames_agreed,
            "frames_required": match.frames_required,
            "frames_seen": match.frames_seen,
            "margin": round(match.margin, 4) if match.margin is not None else None,
            "min_margin": round(match.min_margin, 4),
            "window_s": round(match.window_s, 2),
            "model": SFACE_MODEL_ID,
            "detector": YUNET_MODEL_ID,
            "gallery_version": gallery_version,
        },
        "face": match.box.to_dict(),
        "evidence": {"face_crop": face_crop_key},
        "run_id": run_id,
    }
    if latency_ms is not None:
        payload["latency_ms"] = round(latency_ms, 1)
    return payload
