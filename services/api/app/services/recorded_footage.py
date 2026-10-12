"""Cameras replaying a recorded clip on a loop, and keeping them out of traffic figures.

A camera tagged `recorded-footage` is not watching a road. CAM-DEMO-01 replays a
15-second clip of a UK street on a loop, so the same handful of vehicles pass it
again every 15 s — tens of thousands of "vehicles" a day from fifteen seconds of
footage. Counted as traffic it supplied ~93% of every vehicle Insights reported
and was rated severe congestion; scored as journeys, its replays raised 760
anomaly alerts in one evening. Neither figure described a road.

`app.services.anomaly` was the first to set such cameras aside, and explains why
the tag is the only reliable signal (the stream reader's discontinuity detector
never fires on an `ffmpeg -stream_loop` clip). This module is where that test
lives now, so the anomaly scorer and the traffic analytics cannot drift apart:

* `recorded_cameras` — the codes, for filtering in Python and for telling a
  caller which cameras were left out;
* `live_only_sql` / `sql_params` — the same test as a SQL predicate. A bounded
  read has to be bounded over live rows: capping first and filtering after would
  fill the cap with the loop and then throw most of it away.
"""

from __future__ import annotations

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

#: Cameras whose footage is a recording on a loop. Every revisit there is the
#: clip starting over, and every timing is the edit's, not the traffic's.
RECORDED_TAG = "recorded-footage"


async def recorded_cameras(session: AsyncSession) -> frozenset[str]:
    """Codes of cameras replaying recorded footage. See `RECORDED_TAG`."""
    rows = await session.execute(
        text("SELECT camera_code FROM cameras WHERE :tag = ANY(tags)"), {"tag": RECORDED_TAG}
    )
    return frozenset(code for (code,) in rows)


def live_only_sql(alias: str) -> str:
    """A predicate true for a row of `cameras` aliased `alias`, unless it is a
    recording and recordings were not asked for.

    `alias` is interpolated, so it must be a literal from the caller's own SQL,
    never request input. `tags` is nullable — `NULL = ANY(NULL)` is NULL, and
    `NOT NULL` would drop every untagged camera — hence the `coalesce`. A row
    whose camera no longer exists (a `LEFT JOIN` miss) is kept, as before.

    Bind the parameters with `sql_params`. Both are written `CAST(... AS ...)`
    rather than `::type`, for the reason the flow endpoint's SQL documents.
    """
    return (
        "(CAST(:include_recorded AS boolean) OR NOT coalesce("
        f"CAST(:recorded_tag AS text) = ANY({alias}.tags), false))"
    )


def sql_params(*, include_recorded: bool) -> dict[str, object]:
    """The bind parameters `live_only_sql` refers to."""
    return {"include_recorded": include_recorded, "recorded_tag": RECORDED_TAG}
