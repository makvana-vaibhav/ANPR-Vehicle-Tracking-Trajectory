"""Face detection and matching for the persons watchlist.

    models.py    YuNet detector + SFace recogniser, via OpenCV, inside the
                 CPU thread budget (`ailab.runtime`)
    enrol.py     a reference photo -> one embedding, or a clear refusal
    gallery.py   the active entries as published by the API, and the policy
    matching.py  multi-frame agreement: when a face becomes a possible match
    stage.py     one camera's frames in, `person.match` events out
    events.py    the `person.match` event

Deliberately no imports here. The API imports `models`, `enrol` and `gallery`
for enrolment and must not pull in the stream runner, the tracker or `rich`
along the way; the worker imports `stage`.

The safeguards this package carries, and where each is enforced, are listed in
docs/SECURITY.md (§ Persons watchlist). The short version: it runs only on
cameras tagged `analytics:faces`, only while an approved gallery exists, it
never stores an embedding or a crop of a face that did not match, and what it
produces is a *possible* match that a person must confirm.
"""
