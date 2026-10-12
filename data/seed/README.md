# Seed data

What is here, and — more importantly — what is deliberately *not*.

| File | What it is |
|---|---|
| `watchlist.csv` | The demo watchlist, loaded by `seed.py` (on unless `SEED_WATCHLIST=false`). Ten fictional vehicles — stolen, wanted, blacklisted, suspect, e-challan defaulter, one expired — each with a `DEMO/` case reference and a `DEMO (fictional)` remark. Every plate is at least three characters from any plate the feeds had read by 12 Oct 2026, so none can fire on a real vehicle seen so far; check again before adding one. Includes `GJ03AB1234`, the plate `docs/DEMO_SCRIPT.md` types. |
| `registries/` | **Reference data for the VAHAN / SARTHI / eGujCop / AFIS lookups — fictional, and labelled as such in every API response.** `vahan.csv` (330 registrations), `egujcop_firs.csv` (20 FIRs), `sarthi.csv` (146 licences), `afis.csv` (9 existence-and-reference records, no biometric data). Loaded by `seed.py` (on unless `SEED_REGISTRIES=false`; `--only registries` reloads just these), which replaces each table with its file. Owners are "Reference Owner NNN", holders "Reference Holder NNN", addresses are a district only, case numbers start `DEMO/` or `REF/`. Covers all ten watchlist plates (the six FIR cases carry the FIR their watchlist case reference names), and the states worth showing: expired insurance/fitness/PUC/permit, blacklisted and hypothecated vehicles, open and closed FIRs, suspended/revoked/lapsed licences. Written by `scripts/generate_registry_reference.py`, which keeps every generated plate at least three characters from every plate the cameras had read (1,700 on 12 Oct 2026) — regenerate with a fresh export before relying on that for new reads. |
| `sample_cameras.csv` | **Four rows for demonstrating CSV onboarding live.** Not loaded by the seed. |
| `gujarat_districts.geojson` | District boundaries for the offline basemap. |
| `gujarat_places.csv` | Place names for the map, rendered as HTML labels. |

## Why there is no 250-camera fleet any more

There used to be a `cameras.csv` with 250 synthetic cameras, so the GIS map had
something to show at scale. It was a mistake, and removing it is the point of
this change.

**251 of 281 cameras had no stream URL at all.** They sat permanently at status
`unknown`, they could never be watched, they could never contribute a
detection, and they made every screen that counted cameras report a number that
was mostly fiction. Fleet health reported on cameras that could not be
unhealthy. The map looked impressive and meant nothing.

The registry now contains only cameras with a real video source: the
organisers' grid, plus one demonstration camera carrying a recorded clip that
says so in its name. Roughly 31 instead of 281 — and every one of them can be
opened, watched, and analysed.

## The sample CSV, and its deliberately bad row

`sample_cameras.csv` exists to *demonstrate* bulk onboarding rather than to
populate anything, so it is small enough to read on a projector.

Row 4 is invalid on purpose: its coordinates are in London. Uploading this file
shows three cameras created and one rejected, with the reason — which is the
feature. A CSV that imports cleanly demonstrates nothing that an empty file
would not.

These cameras have no `stream_url`, so they onboard as registry records with no
feed. That is honest, and it is what onboarding a camera the state has recorded
but not yet connected actually looks like. Delete them from the admin panel
when you are done demonstrating.

## camera_positions.csv — OpenStreetMap attribution

The organisers' grid publishes a name for each of its 30 cameras, never
coordinates. `camera_positions.csv` holds an approximate position for each,
geocoded from that name with **OpenStreetMap Nominatim** on **12 Oct 2026**
(74 rate-limited requests, one per query, cached).

**These positions are approximate.** Each is the OSM feature the camera's name
matched (a junction, landmark, locality, village or town), not a surveyed
camera position. The file records the query, the OSM object and a confidence
for every row. If the organisers publish real coordinates, those must win.

- 19 of 30 placed: 14 `geocoded` (6 high, 8 medium confidence) and 5 `city`
  (the name gives only a town: Rajkot, Dehgam, Bilimora ×3).
- 11 of 30 left `unknown` with empty coordinates, because no OSM feature
  matched or the name was ambiguous. Each row's `note` says why.

Geodata © OpenStreetMap contributors, available under the Open Database
Licence (ODbL) 1.0 — <https://www.openstreetmap.org/copyright>. Any screen or
export that shows these positions must carry the attribution
"© OpenStreetMap contributors".
