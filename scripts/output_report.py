"""Write the Sentinel output report from the live API: what Contrail detected.

    python3 scripts/output_report.py                       # event window: 12 Oct 00:00 IST → now
    python3 scripts/output_report.py --since 2026-10-11T00:00:00+05:30 --until 2026-10-13T23:59:59+05:30
    python3 scripts/output_report.py --mask-plates         # a copy safe to publish

Reads, never writes. Signs in as the bootstrap admin from `.env`
(`BOOTSTRAP_ADMIN_USERNAME` / `BOOTSTRAP_ADMIN_PASSWORD`; never printed) and
asks the API for:

* the registry — which cameras are the organisers' grid (government feed, the
  `hosted_grid` VMS, `SBX-*`) and which are our own (the recorded clips);
* every detection in the window, per camera, paged with a fixed upper bound so
  rows arriving while the report runs cannot shift the pages;
* vehicles observed per camera (`/analytics/traffic`), alarms raised in the
  window (`/alerts`), plates seen at two or more cameras (`/vehicles/routable`)
  and each such journey (`/vehicles/{plate}/route`), and fleet health now.

Writes `docs/submission/OUTPUT_REPORT.md` and `docs/submission/OUTPUT_REPORT.csv`
(per-camera counts, no plates). Every route lookup is a plate search, so it is
recorded in the audit trail against the admin account, as the platform intends.

Standard library only, so it runs on the host with any Python ≥ 3.11.
"""

from __future__ import annotations

import argparse
import csv
import json
import os
import re
import sys
import urllib.error
import urllib.parse
import urllib.request
from collections import Counter, defaultdict
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any
from zoneinfo import ZoneInfo

REPO = Path(__file__).resolve().parent.parent
IST = ZoneInfo("Asia/Kolkata")
EVENT_START = datetime(2026, 10, 12, 0, 0, tzinfo=IST)
PAGE = 200  # the API's maximum page size
INDIAN_PLATE = re.compile(r"^[A-Z]{2}\d{1,2}[A-Z]{0,3}\d{4}$")


# ── Talking to the API ──────────────────────────────────────────────────────


def env_values() -> dict[str, str]:
    """`.env` parsed the way a shell would read it. Values are never printed."""
    values: dict[str, str] = {}
    path = REPO / ".env"
    if not path.exists():
        return values
    for line in path.read_text(encoding="utf-8").splitlines():
        if not re.match(r"^[A-Z_]+=", line):
            continue
        key, _, raw = line.partition("=")
        raw = re.sub(r"\s+#.*$", "", raw).strip().strip("\"'")
        values[key] = raw
    return values


class Api:
    def __init__(self, base: str) -> None:
        self.base = base.rstrip("/")
        self.token = ""
        self.calls = 0

    def login(self) -> None:
        env = {**env_values(), **os.environ}
        user = env.get("BOOTSTRAP_ADMIN_USERNAME")
        password = env.get("BOOTSTRAP_ADMIN_PASSWORD")
        if not user or not password:
            sys.exit(
                "BOOTSTRAP_ADMIN_USERNAME / BOOTSTRAP_ADMIN_PASSWORD not found in .env"
            )
        body = self._request(
            "POST", "/auth/login", {"username": user, "password": password}
        )
        self.token = str(body.get("access_token", ""))
        if not self.token:
            sys.exit("Sign-in refused (check the bootstrap admin in .env)")

    def get(self, path: str, **params: Any) -> Any:
        query = {k: v for k, v in params.items() if v is not None}
        if query:
            path = f"{path}?{urllib.parse.urlencode(query, doseq=True)}"
        return self._request("GET", path)

    def _request(
        self, method: str, path: str, payload: dict[str, Any] | None = None
    ) -> Any:
        data = json.dumps(payload).encode() if payload is not None else None
        request = urllib.request.Request(f"{self.base}{path}", data=data, method=method)
        request.add_header("content-type", "application/json")
        if self.token:
            request.add_header("authorization", f"Bearer {self.token}")
        self.calls += 1
        try:
            with urllib.request.urlopen(request, timeout=60) as response:
                return json.loads(response.read().decode() or "null")
        except urllib.error.HTTPError as err:
            detail = err.read().decode(errors="replace")[:300]
            raise SystemExit(
                f"{method} {path.split('?')[0]} → {err.code}: {detail}"
            ) from err
        except urllib.error.URLError as err:
            raise SystemExit(
                f"Cannot reach the API at {self.base}: {err.reason}"
            ) from err


def rows(body: Any) -> list[dict[str, Any]]:
    """Some lists come back as an array, others as a page of `items`."""
    if isinstance(body, list):
        return body
    if isinstance(body, dict):
        items = body.get("items")
        return items if isinstance(items, list) else []
    return []


# ── Formatting ──────────────────────────────────────────────────────────────


def parse_ts(value: str) -> datetime:
    return datetime.fromisoformat(value.replace("Z", "+00:00"))


def ist(value: datetime | str | None, with_date: bool = True) -> str:
    if value is None or value == "":
        return "—"
    moment = parse_ts(value) if isinstance(value, str) else value
    fmt = "%d %b %H:%M:%S" if with_date else "%H:%M:%S"
    return moment.astimezone(IST).strftime(fmt)


def utc_iso(moment: datetime) -> str:
    return moment.astimezone(UTC).strftime("%Y-%m-%dT%H:%M:%SZ")


def n(value: int | float | None) -> str:
    if value is None:
        return "—"
    if isinstance(value, float):
        return f"{value:,.2f}"
    return f"{value:,}"


def mask(plate: str) -> str:
    """Keep the state and series, hide the number: GJ05CP3632 → GJ05CP••32."""
    if len(plate) <= 4:
        return "•" * len(plate)
    return plate[:-4] + "••" + plate[-2:]


def cell(text: Any) -> str:
    return str(text).replace("|", "\\|").replace("\n", " ")


def table(headers: list[str], body: list[list[Any]], align: str = "") -> str:
    """A Markdown table. `align` is "---|--:|…", one marker per column."""
    marks = align.split("|") if align else []
    lines = ["| " + " | ".join(headers) + " |"]
    lines.append(
        "|"
        + "|".join(
            marks[i] if i < len(marks) and marks[i] else "---"
            for i in range(len(headers))
        )
        + "|"
    )
    lines += ["| " + " | ".join(cell(c) for c in row) + " |" for row in body]
    return "\n".join(lines)


# ── Collecting ──────────────────────────────────────────────────────────────


@dataclass
class CameraStats:
    camera: dict[str, Any]
    source: str  # "grid", "jury" or "own"
    detections: list[dict[str, Any]] = field(default_factory=list)
    vehicles_observed: int | None = None

    @property
    def code(self) -> str:
        return str(self.camera["camera_code"])

    @property
    def reads(self) -> list[dict[str, Any]]:
        return [d for d in self.detections if d.get("plate")]

    @property
    def valid(self) -> list[dict[str, Any]]:
        return [d for d in self.reads if d.get("grammar_valid")]

    @property
    def distinct(self) -> int:
        return len({d["plate"] for d in self.valid})


def classify(camera: dict[str, Any]) -> str:
    """Government grid, a test feed handed over on the day, or one of our own."""
    code = str(camera.get("camera_code", ""))
    if camera.get("vms_vendor") == "hosted_grid" or code.startswith("SBX-"):
        return "grid"
    if code.startswith("JURY-") or any(
        str(t).startswith("jury") for t in camera.get("tags") or []
    ):
        return "jury"
    return "own"


FEED_LABEL = {"grid": "government", "jury": "test feed", "own": "own"}


def vehicles_by_camera(
    api: Api, since: datetime, until: datetime
) -> tuple[dict[str, int], int]:
    """Vehicles observed per camera, read in slices small enough not to be truncated.

    `/analytics/traffic` reads at most 20,000 detections per request and says so
    (`truncated`). A truncated window is split in half until every slice fits,
    then the slices are summed. Returns the counts and the number of requests.
    """
    counts: dict[str, int] = defaultdict(int)
    requests = 0
    pending = [(since, until)]
    while pending:
        start, end = pending.pop()
        # include_recorded: Insights leaves looping clips out by default; this report counts every camera.
        body = api.get(
            "/analytics/traffic",
            since=utc_iso(start),
            until=utc_iso(end),
            group_by="camera",
            include_recorded="true",
        )
        requests += 1
        if body.get("truncated") and end - start > timedelta(minutes=15):
            middle = start + (end - start) / 2
            pending += [(start, middle), (middle, end)]
            continue
        for zone in body.get("zones", []):
            counts[str(zone.get("key"))] += int(zone.get("vehicles") or 0)
    return counts, requests


def collect_detections(
    api: Api, camera_id: str, since: datetime, until: datetime, cap: int
) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    offset = 0
    while len(out) < cap:
        page = api.get(
            "/detections",
            camera_id=camera_id,
            since=utc_iso(since),
            until=utc_iso(until),
            limit=PAGE,
            offset=offset,
        )
        items = rows(page)
        out.extend(items)
        offset += len(items)
        if len(items) < PAGE or offset >= int(page.get("total", 0)):
            break
    return out[:cap]


def collect_alerts(api: Api, since: datetime, until: datetime) -> list[dict[str, Any]]:
    """Every alarm created in the window. The list is newest first, so stop past `since`."""
    out: list[dict[str, Any]] = []
    offset = 0
    while True:
        page = api.get("/alerts", limit=PAGE, offset=offset, sort="recent")
        items = rows(page)
        if not items:
            break
        for alert in items:
            created = parse_ts(alert["created_at"])
            if since <= created <= until:
                out.append(alert)
        offset += len(items)
        oldest = parse_ts(items[-1]["created_at"])
        if oldest < since or len(items) < PAGE:
            break
    return out


# ── The report ──────────────────────────────────────────────────────────────


def spread_samples(reads: list[dict[str, Any]], k: int) -> list[dict[str, Any]]:
    """Up to k grammar-valid reads of different plates, spread over the window, newest first.

    Each hour offers its most confident read of a plate not already picked;
    reads at 0.8 confidence or more are preferred when the camera has any.
    """
    valid = [d for d in reads if d.get("grammar_valid")]
    confident = [d for d in valid if (d.get("plate_confidence") or 0) >= 0.8]
    pool = confident or valid
    by_hour: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for d in pool:
        by_hour[parse_ts(d["ts"]).astimezone(IST).strftime("%d%H")].append(d)
    picked: list[dict[str, Any]] = []
    seen: set[str] = set()
    hours = sorted(by_hour, reverse=True)
    # Spread the picks: every ⌈hours/k⌉-th hour first, then fill from the rest.
    stride = max(1, -(-len(hours) // max(k, 1)))
    order = hours[::stride] + [h for i, h in enumerate(hours) if i % stride]
    for hour in order:
        if len(picked) >= k:
            break
        for d in sorted(
            by_hour[hour], key=lambda x: x.get("plate_confidence") or 0, reverse=True
        ):
            if d["plate"] not in seen:
                picked.append(d)
                seen.add(d["plate"])
                break
    return sorted(picked, key=lambda d: d["ts"], reverse=True)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument(
        "--api", default=os.environ.get("CONTRAIL_API", "http://localhost:8000/api/v1")
    )
    parser.add_argument(
        "--since",
        help="ISO time (default: 12 Oct 2026 00:00 IST, the start of the event)",
    )
    parser.add_argument("--until", help="ISO time (default: now)")
    parser.add_argument(
        "--out-md", default=str(REPO / "docs/submission/OUTPUT_REPORT.md")
    )
    parser.add_argument(
        "--out-csv", default=str(REPO / "docs/submission/OUTPUT_REPORT.csv")
    )
    parser.add_argument(
        "--samples", type=int, default=5, help="sample reads per camera"
    )
    parser.add_argument(
        "--max-rows",
        type=int,
        default=60_000,
        help="detections read per camera, at most",
    )
    parser.add_argument(
        "--mask-plates",
        action="store_true",
        help="hide the last digits of every plate shown",
    )
    args = parser.parse_args()

    generated = datetime.now(UTC)
    since = parse_ts(args.since) if args.since else EVENT_START
    until = parse_ts(args.until) if args.until else generated
    if since.tzinfo is None or until.tzinfo is None:
        sys.exit("--since/--until need a timezone, e.g. 2026-10-12T00:00:00+05:30")
    show = mask if args.mask_plates else (lambda p: p)

    api = Api(args.api)
    api.login()

    cameras = rows(api.get("/cameras", limit=100))
    stats = {c["camera_code"]: CameraStats(c, classify(c)) for c in cameras}
    print(
        f"{len(cameras)} cameras; reading detections {ist(since)} → {ist(until)} IST",
        file=sys.stderr,
    )
    for s in stats.values():
        s.detections = collect_detections(
            api, s.camera["id"], since, until, args.max_rows
        )

    observed, slices = vehicles_by_camera(api, since, until)
    for code, count in observed.items():
        if code in stats:
            stats[code].vehicles_observed = count
    traffic_note = (
        f"Vehicles observed were read in {slices} time slices, each small enough for the analytics endpoint "
        "to count in full (it reads at most 20,000 detections per request); a vehicle tracked across a slice "
        "boundary is counted in both."
        if slices > 1
        else ""
    )

    alerts = collect_alerts(api, since, until)
    watch_entries = {
        e["id"]: e for e in rows(api.get("/watchlist", active_only="false", limit=200))
    }
    routable = api.get(
        "/vehicles/routable", since=utc_iso(since), min_cameras=2, limit=50
    )
    journeys = []
    for item in (routable.get("plates") or [])[:20]:
        plate = item["plate"] if isinstance(item, dict) else str(item)
        route = api.get(
            f"/vehicles/{plate}/route", since=utc_iso(since), until=utc_iso(until)
        )
        journeys.append(route)
    fleet = api.get("/health/fleet")
    code_of = {c["id"]: c["camera_code"] for c in cameras}

    # ── Numbers ──
    groups: dict[str, list[CameraStats]] = defaultdict(list)
    for s in stats.values():
        groups[s.source].append(s)

    def totals(items: list[CameraStats]) -> list[Any]:
        reads = sum(len(s.reads) for s in items)
        valid = sum(len(s.valid) for s in items)
        distinct = len({d["plate"] for s in items for d in s.valid})
        observed = sum(s.vehicles_observed or 0 for s in items)
        reading = sum(1 for s in items if s.reads)
        return [len(items), reading, n(observed), n(reads), n(valid), n(distinct)]

    alert_types = Counter(a["alert_type"] for a in alerts)
    alert_status = Counter((a["alert_type"], a["status"]) for a in alerts)

    # ── CSV ──
    out_csv = Path(args.out_csv)
    out_csv.parent.mkdir(parents=True, exist_ok=True)
    with out_csv.open("w", newline="", encoding="utf-8") as handle:
        writer = csv.writer(handle)
        writer.writerow(
            [
                "window_from_utc",
                "window_to_utc",
                "source",
                "camera_code",
                "name",
                "district",
                "department",
                "vms",
                "vehicles_observed",
                "plate_reads",
                "grammar_valid_reads",
                "distinct_valid_plates",
                "indian_format_reads",
                "first_read_ist",
                "last_read_ist",
            ]
        )
        for s in sorted(
            stats.values(),
            key=lambda x: ("grid jury own".index(x.source), -len(x.reads), x.code),
        ):
            reads = s.reads
            writer.writerow(
                [
                    utc_iso(since),
                    utc_iso(until),
                    FEED_LABEL[s.source],
                    s.code,
                    s.camera.get("name"),
                    s.camera.get("district") or "",
                    s.camera.get("department_code") or "",
                    s.camera.get("vms_name") or "",
                    s.vehicles_observed if s.vehicles_observed is not None else "",
                    len(reads),
                    len(s.valid),
                    s.distinct,
                    sum(1 for d in reads if INDIAN_PLATE.match(d["plate"] or "")),
                    ist(min(d["ts"] for d in reads)) if reads else "",
                    ist(max(d["ts"] for d in reads)) if reads else "",
                ]
            )

    # ── Markdown ──
    md: list[str] = []
    w = md.append
    window_text = (
        f"**{ist(since)} → {ist(until)} IST** ({utc_iso(since)} → {utc_iso(until)})"
    )
    w("# Output report — what Contrail detected at the Sentinel sandbox")
    w("")
    w(
        f"Generated **{ist(generated)} IST** from the live API (`{args.api}`) by "
        f"`python3 scripts/output_report.py{' --mask-plates' if args.mask_plates else ''}"
        f"{f' --since {args.since}' if args.since else ''}{f' --until {args.until}' if args.until else ''}`."
    )
    w("")
    w(f"**Query window:** {window_text}.")
    w("")
    w(
        "Everything below is what the API returned at that moment — nothing is typed in by hand. "
        "Each route lookup the script made is a plate search, so it is in the audit trail under the admin account. "
        f"The script made {{CALLS}} API calls. Per-camera counts are also in "
        f"[`{out_csv.name}`]({out_csv.name})."
    )
    w("")
    w("## 1. Summary")
    w("")
    w(
        table(
            [
                "Feed",
                "Cameras",
                "Cameras that read a plate",
                "Vehicles observed",
                "Plate reads",
                "Grammar-valid reads",
                "Distinct valid plates",
            ],
            [
                [
                    "**Government** — the organisers' hosted grid (`SBX-*`, federated by `HostedGridAdapter`)",
                    *totals(groups["grid"]),
                ],
                *(
                    [
                        [
                            "**Test feeds onboarded on the day** (`JURY-*`, through the registry form)",
                            *totals(groups["jury"]),
                        ]
                    ]
                    if groups["jury"]
                    else []
                ),
                [
                    "**Own** — recorded clips published by our simulator (`CAM-DEMO-*`)",
                    *totals(groups["own"]),
                ],
            ],
            "---|--:|--:|--:|--:|--:|--:",
        )
    )
    w("")
    w(
        f"**Alarms raised in the window:** {n(len(alerts))}"
        + (
            " — "
            + ", ".join(
                f"{k.replace('_', ' ')} {v}" for k, v in alert_types.most_common()
            )
            if alerts
            else ""
        )
        + "."
    )
    w("")
    w(
        f"**Journeys reconstructed** (a plate read at two or more cameras in the window): **{len(journeys)}**."
    )
    w("")
    w("What the columns mean:")
    w("")
    w(
        "- *Vehicles observed* — vehicles the edge workers detected and tracked, plate or not (`/analytics/traffic`)."
    )
    w(
        "- *Plate reads* — settled reads the workers published (one per tracked vehicle that yielded a plate). "
        "*Grammar-valid* — the read fits a plate format for that camera (Indian by default; British on "
        "`CAM-DEMO-01`, whose clip is a UK road)."
    )
    if traffic_note:
        w(f"- {traffic_note}")
    w("")

    # Which grid cameras the workers keep open and analysed all the time (not a secret).
    always_on = [
        c.strip()
        for c in env_values().get("AI_WORKER_ALWAYS_ON", "").split(",")
        if c.strip().upper().startswith("SBX-")
    ]

    def camera_section(title: str, items: list[CameraStats], note: str) -> None:
        w(title)
        w("")
        w(note)
        w("")
        active = sorted(
            [s for s in items if s.detections or s.vehicles_observed],
            key=lambda s: -len(s.reads),
        )
        idle = sorted(
            s.code for s in items if not (s.detections or s.vehicles_observed)
        )
        if active:
            w(
                table(
                    [
                        "Camera",
                        "Name",
                        "District",
                        "Vehicles observed",
                        "Plate reads",
                        "Valid",
                        "Distinct",
                        "First read (IST)",
                        "Last read (IST)",
                    ],
                    [
                        [
                            f"`{s.code}`",
                            s.camera.get("name") or "",
                            s.camera.get("district") or "—",
                            n(s.vehicles_observed),
                            n(len(s.reads)),
                            n(len(s.valid)),
                            n(s.distinct),
                            ist(min(d["ts"] for d in s.reads)) if s.reads else "—",
                            ist(max(d["ts"] for d in s.reads)) if s.reads else "—",
                        ]
                        for s in active
                    ],
                    "---|---|---|--:|--:|--:|--:|---|---",
                )
            )
        else:
            w("_No camera in this feed detected anything in the window._")
        w("")
        if idle:
            w(
                f"No detection in the window on {len(idle)} camera(s): {', '.join(f'`{c}`' for c in idle)}."
            )
            w("")

    grid_reads = [d["ts"] for s in groups["grid"] for d in s.reads]
    quiet_note = ""
    if grid_reads and until - parse_ts(max(grid_reads)) > timedelta(minutes=30):
        quiet_note = (
            f" **No grid camera read a plate after {ist(max(grid_reads))} IST.** Fleet health, below, shows "
            "whether the grid was refusing our session at the time; at night the cause is mostly plate yield."
        )
    camera_section(
        "## 2. Government feed — the organisers' grid",
        groups["grid"],
        f"{len(groups['grid'])} cameras onboarded from the organisers' catalogue (Model 3 federation). The edge "
        "workers read them over RTSP"
        + (
            f"; {', '.join(f'`{c}`' for c in always_on)} are analysed continuously"
            if always_on
            else ""
        )
        + " and the rest in 45-second slices, or at once while someone opens one on Live — so a camera with no "
        "read was not necessarily being analysed when traffic passed. Many grid views are junction overviews "
        "where plates are a few pixels high; detection and tracking work on them, plate reading mostly does not."
        + quiet_note,
    )
    section = 3
    if groups["jury"]:
        onboarded = ", ".join(
            f"`{s.code}` ({s.camera.get('name')}, onboarded {ist(s.camera.get('created_at'))} IST)"
            for s in sorted(groups["jury"], key=lambda x: x.code)
        )
        camera_section(
            f"## {section}. Test feeds onboarded on the day",
            groups["jury"],
            f"Cameras added through the registry during the event, not through the grid's catalogue: {onboarded}. "
            "They join the workers' roster within a minute of being saved, with no restart.",
        )
        section += 1
    camera_section(
        f"## {section}. Own feed — recorded clips",
        groups["own"],
        "`CAM-DEMO-01` replays a recorded clip of a **UK road** (British plates) on a loop of about 15 s, published "
        "as an RTSP camera by our simulator; `CAM-DEMO-02` is stock footage for the persons watchlist and reads no "
        "plates. Their counts are repeated passes of the same few vehicles — evidence that the pipeline runs "
        "continuously, not traffic.",
    )
    section += 1

    w(f"## {section}. Sample detections, timestamped")
    section += 1
    w("")
    w(
        f"Up to {args.samples} per camera, each a different plate: the most confident grammar-valid read in hours "
        "spread across the window, newest first. "
        "*Frames* is how many reads of that vehicle the multi-frame consensus combined."
        + (" Plates are masked (`--mask-plates`)." if args.mask_plates else "")
    )
    w("")
    sample_rows = []
    for s in sorted(
        stats.values(), key=lambda x: ("grid jury own".index(x.source), -len(x.reads))
    ):
        for d in spread_samples(s.reads, args.samples):
            sample_rows.append(
                [
                    ist(d["ts"]),
                    f"`{s.code}`",
                    FEED_LABEL[s.source],
                    f"`{show(d['plate'])}`",
                    f"{(d.get('plate_confidence') or 0):.2f}",
                    d.get("vehicle_type") or "—",
                    d.get("reads_total") or "—",
                ]
            )
    if sample_rows:
        w(
            table(
                [
                    "Time (IST)",
                    "Camera",
                    "Feed",
                    "Plate",
                    "Read confidence",
                    "Vehicle",
                    "Frames",
                ],
                sample_rows,
                "---|---|---|---|--:|---|--:",
            )
        )
    else:
        w("_No grammar-valid read in the window._")
    w("")

    w(f"## {section}. Alarms raised")
    section += 1
    w("")
    if alerts:
        statuses = sorted({st for _, st in alert_status})
        w(
            table(
                ["Type", *statuses, "Total"],
                [
                    [
                        t.replace("_", " "),
                        *[n(alert_status.get((t, st), 0)) for st in statuses],
                        n(c),
                    ]
                    for t, c in alert_types.most_common()
                ],
                "---|" + "|".join("--:" for _ in statuses) + "|--:",
            )
        )
        w("")
        key = [
            a for a in alerts if a["alert_type"] in ("watchlist_hit", "person_match")
        ]
        if key:
            w("Watchlist hits and person matches:")
            w("")
            body = []
            for a in sorted(key, key=lambda x: x["created_at"], reverse=True)[:40]:
                entry = watch_entries.get(a.get("watchlist_id") or "")
                case = (entry or {}).get("case_ref") or ""
                test = any(
                    tag in (case + " " + (a.get("notes") or "")).upper()
                    for tag in ("E2E", "TEST", "DEMO/VIDEO")
                )
                subject = (
                    f"`{show(a['plate_normalised'])}`"
                    if a.get("plate_normalised")
                    else "face (persons watchlist)"
                )
                body.append(
                    [
                        ist(a["created_at"]),
                        a["alert_type"].replace("_", " "),
                        a["priority"],
                        subject,
                        f"`{code_of.get(a.get('camera_id'), '—')}`",
                        a["status"].replace("_", " "),
                        case or "—",
                        "test / rehearsal" if test else "",
                    ]
                )
            w(
                table(
                    [
                        "Raised (IST)",
                        "Type",
                        "Priority",
                        "Plate / subject",
                        "Camera",
                        "Status",
                        "Case ref",
                        "Note",
                    ],
                    body,
                )
            )
            w("")
        notes = {
            "camera_down": "*camera down* alarms are the health monitor reporting the grid's catalogue refusing or "
            "dropping our session (it allows one session per address); they close themselves when it answers again.",
            "anomaly": '*anomaly* alarms are trajectory anomalies ("journeys to explain"), each with its reasons.',
            "person_match": "Person matches come only from cameras tagged for faces — here `CAM-DEMO-02`'s stock "
            "footage, looping, against a fictional demonstration entry — and each says a person must confirm it.",
            "watchlist_hit": "Every watchlist hit in this window was a rehearsal or a test on the recorded clip, "
            "closed afterwards; none concerns a real case."
            if all(
                any(
                    tag
                    in (
                        (watch_entries.get(a.get("watchlist_id") or "") or {}).get(
                            "case_ref"
                        )
                        or ""
                    ).upper()
                    + " "
                    + (a.get("notes") or "").upper()
                    for tag in ("E2E", "TEST", "DEMO/")
                )
                for a in alerts
                if a["alert_type"] == "watchlist_hit"
            )
            else "",
        }
        w(
            " ".join(
                text for kind, text in notes.items() if kind in alert_types and text
            )
        )
    else:
        w("_No alarm was raised in the window._")
    w("")

    w(f"## {section}. Journeys reconstructed")
    section += 1
    w("")
    if journeys:
        body = []
        for r in journeys:
            cams = []
            for hop in r.get("hops", []):
                code = hop.get("camera_code")
                if code and code not in cams:
                    cams.append(code)
            body.append(
                [
                    f"`{show(r['plate'])}`",
                    n(r.get("camera_count")),
                    n(r.get("hop_count")),
                    f"{r.get('distance_km') or 0:.1f}",
                    str(timedelta(seconds=int(r.get("duration_s") or 0))),
                    "yes"
                    if r.get("is_plausible")
                    else f"no — {n(r.get('flagged_hop_count'))} flagged leg(s)",
                    " → ".join(f"`{c}`" for c in cams[:8])
                    + (" …" if len(cams) > 8 else ""),
                    ist(r.get("first_seen")),
                    ist(r.get("last_seen")),
                ]
            )
        w(
            table(
                [
                    "Plate",
                    "Cameras",
                    "Visits",
                    "Km (lower bound)",
                    "Elapsed",
                    "Plausible",
                    "Cameras in order",
                    "First (IST)",
                    "Last (IST)",
                ],
                body,
            )
        )
        w("")
        w(
            "Distances are straight lines between cameras, so every distance and speed is a lower bound."
        )
    else:
        w(
            "**None.** No plate was read at two different cameras in this window, so no multi-camera journey was "
            "reconstructed. The route engine runs on every read (`GET /api/v1/vehicles/{plate}/route`) and the "
            "single-camera histories are in the plate report; what is missing is a second read. Why, plainly: "
            "the grid cameras that read plates at all are a handful in different towns, far apart; most grid "
            "cameras are analysed in slices rather than continuously; and night-time yield is low. "
            "Absence from this report is not absence from the road."
        )
    w("")

    w(f"## {section}. Fleet health when the report was generated")
    section += 1
    w("")
    w(
        table(
            ["Total", "Online", "Degraded", "Offline", "Unknown", "Availability"],
            [
                [
                    n(fleet.get("total")),
                    n(fleet.get("online")),
                    n(fleet.get("degraded")),
                    n(fleet.get("offline")),
                    n(fleet.get("unknown")),
                    f"{fleet.get('availability_pct', 0)}%",
                ]
            ],
            "--:|--:|--:|--:|--:|--:",
        )
    )
    w("")
    errors = fleet.get("top_errors") or []
    if errors:
        w(
            "Most frequent probe errors: "
            + ", ".join(f"`{e['error_code']}` × {n(e['count'])}" for e in errors[:5])
            + "."
        )
        w("")

    w(f"## {section}. How to regenerate, and the exports behind it")
    section += 1
    w("")
    w("```bash")
    w(
        "python3 scripts/output_report.py                                  # 12 Oct 00:00 IST → now"
    )
    w(
        "python3 scripts/output_report.py --since 2026-10-11T00:00:00+05:30 # include the evening before"
    )
    w(
        "python3 scripts/output_report.py --mask-plates                    # a copy to publish"
    )
    w("```")
    w("")
    w(
        "It needs the stack running and `.env` holding the bootstrap admin. The same data is available in the "
        "product: **Investigate → Export plate reads (CSV)** (`GET /api/v1/reports/plates.csv?since=&until=&camera_id=`, "
        "every plate read with its time, camera, department and position), a vehicle's **CSV** and **Printable report** "
        "(`GET /api/v1/reports/vehicle/{plate}.csv`), and the gap report on Fleet health (`GET /api/v1/reports/gaps.csv`)."
    )
    w("")
    w(f"## {section}. Read this before quoting a number")
    section += 1
    w("")
    w(
        "- A plate read is not a vehicle count, and the recorded clip loops: its counts are not traffic."
    )
    w(
        "- No accuracy figure is claimed for these reads. On 60 AI-labelled grid crops the recogniser was 61.7% exact as "
        "shipped and 83.3% with raw crops (`docs/HLD.md` §15.3); a human-labelled set is the next gate."
    )
    w(
        "- Grid camera positions are inferred from the catalogue's place names — a town centre, or an approximate "
        "point where the name identifies a junction — so no grid distance is exact."
    )
    w(
        "- The grid allows one session per address and a watch-time quota; gaps in its rows can be refusals, not quiet roads."
    )
    w("")

    text = "\n".join(md).replace("{CALLS}", n(api.calls))
    out_md = Path(args.out_md)
    out_md.write_text(text, encoding="utf-8")
    print(f"wrote {out_md} and {out_csv} ({api.calls} API calls)", file=sys.stderr)


if __name__ == "__main__":
    main()
