# Demo script — Sentinel live test, 12–13 Oct 2026

Contrail on one laptop, against the organisers' camera grid. The scored part is
the live test case; everything below is ordered around it. Every step names the
screen it happens on and what to do when it does not work. Something broken
mid-session: [PANIC.md](PANIC.md), and keep talking.

**Two rules before anything else.**

1. **Never restart the AI workers** to "fix" something, and never run
   `make down`/`make demo` between sessions. Every restart reopens grid sessions,
   and the grid answers churn by refusing our login for 2–15 minutes
   ([PANIC §2a](PANIC.md#2a-the-grid-refused-our-login)). Start early, then
   leave the stack running.
2. **Never run `make test` while anyone is watching.** The end-to-end suite
   raises a real critical alarm on the live screens (its own watchlist entry,
   closed when it finishes) and the API suite writes synthetic rows for a few
   seconds. Run it before the doors open or not at all.

---

## 0. The screens

Six workspaces across the top bar, in plain words; a role sees only the ones it can use.
The sun/moon button beside the account menu switches light and dark (the account menu also offers *System*, the default).

| Workspace | Screen | What it is for on the day |
|---|---|---|
| **Overview** | `/dashboard` | The network at a glance: a plate search box, "N of M cameras online" and "N reading plates", the map of towns, vehicle and camera alarms docked beside it, plates arriving along the bottom ("Reading now") |
| **Live** | `/anpr` | One camera on the stage with its plate boxes; the rest in a rail |
| **Search** | `/vehicles`, `/registries` | A plate in, its timestamped route out, candidate misreads, pursuit; CSV, printable report, plate-read export; VAHAN/SARTHI/eGujCop/AFIS lookups (reference data) |
| **Alarms** | `/alerts`, `/watchlist`, `/persons` | The alarm queue (vehicles and cameras; face matches in their own **Persons** lane at the right of the filter row, or `/alerts?kind=persons`), the vehicle watchlist, and the persons watchlist (four-eyes enrolment) |
| **Cameras** | `/map`, `/cameras`, `/health` | GIS map, the camera registry and onboarding (*All cameras*), fleet health (*Health*) |
| **More** | `/traffic`, `/users`, `/audit` | Traffic (counts, flow, congestion, forecast), accounts, and the audit trail |

**⌘K** (Ctrl K, or `/`) opens search from any screen: type a plate to open its
journey, a camera code or place (`cam10`, `Paldi`) to open it, or a screen name.

The **feed pill** at the right of the top bar says **Live** (pulsing) while
reads and alarms are arriving. Anything else means every figure on screen is
historical — see [PANIC §2](PANIC.md#2-no-plates-are-appearing).

Every account has its own password, generated for this install by `make env`
and kept only in `.env` (gitignored): `admin` → `BOOTSTRAP_ADMIN_PASSWORD`;
`supervisor`, `operator`, `analyst`, `auditor` → `DEMO_PASSWORD_SUPERVISOR`,
`_OPERATOR`, `_ANALYST`, `_AUDITOR`. There is no shared demo password, and
neither the login page nor `make seed` shows one — read it from `.env` off
screen. To let a judge try a role, hand them that one account's password on
paper; never put `.env` on the projector. The old `NagarNetra@2026` is refused
for every account.

---

## 1. Pre-flight — at least 20 minutes before

The 20 minutes are for the grid: it can refuse our login for up to fifteen
minutes after the workers connect, and that should be over before anyone is
watching.

```bash
docker compose ps                                     # all 12 containers healthy
curl -s localhost:8000/health                         # "status": "alive"
curl -s localhost:9100/streams | grep -o 'CAM-DEMO-0[12]' | sort -u   # both recorded clips are publishing
for w in contrail-ai-worker contrail-ai-worker-2 contrail-ai-worker-3; do
  docker logs $w --tail 2; done
```

| Worker log says | Meaning |
|---|---|
| `analysing N of M camera(s): CAM-DEMO-01, SBX-cam10 …` | Working |
| `… refused our login — next try in Ns` | The grid is pausing us. **Leave it**; it resumes on its own. CAM-DEMO-01 is unaffected |
| `no cameras assigned` | Roster empty — [PANIC §2b](PANIC.md#2b-the-roster-is-empty) |

**If the venue network or the grid is unreliable:** `make grid-replay` plays every grid camera
that has a recording (`data/videos/grid-SBX-camNN.mp4`, 60 s each, recorded 13 Oct) from that
recording instead, through the same gateway and pipeline, labelled "Recorded clip" in Live.
`make grid-live` switches back. `docker compose exec -T api python -m scripts.grid_replay status`
says which cameras are on which. Say it plainly if asked: *"these are recordings of the
organisers' cameras, replayed because the venue link cannot carry thirty live feeds."*

In the browser at **http://localhost:8080** (use `localhost`, not `127.0.0.1` — the API only
accepts the page's own origin). Every demo account signs in with **`admin@123`**, already filled in:

- [ ] Feed pill says **Live**
- [ ] **Overview** — the "Reading now" strip is moving and the recorded clip (CAM-DEMO-01) ripples
- [ ] **Alarms** — no test alarm left open (nothing with case `FIR/E2E/…` or a demo case from a rehearsal)
- [ ] **Watchlist** — the ten `DEMO/…` entries are watched (§6); the plate you mean to add live is **not** already on it
- [ ] **Cameras → All cameras** — 32 cameras: 30 from the organisers' grid, 2 recorded clips (CAM-DEMO-01 plates, CAM-DEMO-02 persons)
- [ ] **Alarms → Persons** — `DEMO/PERSONS/001` matched now; `DEMO/PERSONS/002` waiting for a second approver (keep it for the four-eyes moment, §2.4b)
- [ ] Top bar shows **no** Pursuit pill (none left running from a rehearsal)
- [ ] One browser tab only. A second tab on a grid camera spends the grid's watch quota twice

---

## 2. The live test, in order

About **13 minutes** for the full path. The short path (8 min) is steps 2.1,
2.3, 2.4 and 2.5.

### 2.1 Overview — the network now (60 s)

**Say:** departments keep their own cameras and recorders; we federate them.
Only events cross the network; video is pulled only while someone watches.

1. **Overview.** Read the two figures aloud — each says what it counts. "N reading
   plates" is cameras that read a plate in the last ten minutes, not cameras
   configured to; "N of M cameras online" says how many are only last known
   while the grid refuses us.
2. Point at the map: towns, a ring where plates were read in the last ten
   minutes, a ripple per plate read live, contrails for vehicles seen at two or
   more cameras.
3. Point at the alarm dock: most severe first, a watchlist hit first within a
   severity, and journeys to explain (trajectory anomalies) below every
   watchlist and camera alarm whatever their severity.

### 2.2 Onboard heterogeneous cameras, and interoperability (2 min)

The brief asks for about 50 cameras from several departments. **We have 32: the
organisers' 30 and two recorded clips.** Say so; do not round up. The registry
holds all 26 departments the brief lists; most grid cameras arrive with no
department, and the screen says so rather than guessing one.

1. **Cameras → All cameras.** The registry: each camera's department, integration,
   transport and position. "Connected systems" names the two VMS we federate
   (the organisers' hosted grid; the simulated recorder carrying the clip).
   "Available adapters" lists the integrations that exist as code: RTSP,
   ONVIF, vendor VMS API, hosted grid, simulated.
2. **Heterogeneous, measured:** the grid's 30 streams are 24 × H.264 and 6 ×
   HEVC, 960×576 to 2560×1440, read over RTSP for inference and served to the
   browser through our authenticated HLS proxy — the grid's credentials never
   reach the browser.
3. **Import CSV → Validate only** with `data/seed/sample_cameras.csv`: three
   cameras would be created and one is rejected *with its reason* (coordinates
   in London). That is the feature. Do not press **Import** unless you mean to
   add three cameras with no stream.
4. **Cameras → Map.** Filter by department, integration, status. Five grid
   cameras have no position — the catalogue names a place we could not find —
   and they are listed apart on the Map ("without a position"; also
   `/cameras?filter=unplaced`),
   never dropped on the map at a guess.
5. **If the organisers add cameras today:** re-sync the catalogue (reads the
   catalogue and checks the RTSP port; it does not open a stream):
   ```bash
   docker compose exec -T api python /app/scripts/sync_sandbox.py --dry-run   # look first
   docker compose exec -T api python /app/scripts/sync_sandbox.py             # then write
   ```
   New cameras join the workers' rotation within a minute; no restart.
6. **If the jury hands us a camera** (an RTSP URL, often with a username and password, from an
   NVR or a phone app), see JURY_PREP.md §2.7. In short:
   - **Onboard camera → Live stream URL.** Paste the URL exactly as given, password included.
     The form moves the login into **Username / Password** and says so. The password is sealed
     (AES-256-GCM) in the camera's `credentials_ref` and is never shown, logged or audited
     again. A typed username and password work the same way.
   - **Measured on a password-protected stand-in camera (12:49 IST):**
     - 201 in 0.4 s;
     - in the AI roster at +0.7 s;
     - health **online** at +3.0 s (probed at onboarding, with its login);
     - once Live is opened, a worker reads the stream after **1.2 s**;
     - the first plate is on screen **7 s** after opening Live.
   - Open Live straight away; there is no discovery pass to wait for.
   - A wrong password shows as `unauthorized` on the camera's health within about 4 s.
   - **A video file:** copy it into `data/videos/` and onboard it with **Recorded video**. It
     starts playing by itself: path ready at +1.6 s, first plate 5.9 s after opening Live.
   - **Clean-up:** delete the camera (admin) **before** stopping its source, so that no
     `camera_down` alarm is raised.

### 2.3 Track the vehicle number given on the day (4 min) — the scored task

1. **⌘K**, type the number exactly as given, Enter. Search opens on it (or type it into the Overview's search box).
2. Set the window: **24 h**, or **7 d** if nothing shows. The grid replays its
   footage on a loop, so history covers what we analysed since the stack came up.
3. **If it was read:** every sighting in order — time (IST), camera, place,
   department, read confidence, the plate crop. The route draws on the map;
   **Replay journey** plays it in proportion to real time. Say plainly: legs are
   straight lines between cameras, so every distance and speed is a lower
   bound; a red dashed leg is one the platform does not believe, shown rather
   than hidden.
4. **If the exact plate was not read:**
   - **Did you mean…** lists plates read that are close to it, with similarity.
     Open the closest and compare its **crop** before saying anything — a near
     match is a lead, not a finding.
   - **Not on the map** lists reads at cameras with no known position.
   - **Possibly the same vehicle** lists reads one or two characters away,
     counting the classic misreads (0/O, 1/I, 8/B, 5/S…) as half a difference,
     each with its reasons — which characters, the read's confidence, and
     whether it fits the confirmed route in time and distance. **Include** one
     and it joins the journey as a dashed *candidate* visit, never merged into
     a confirmed one; **Dismiss** removes it. Each decision is audited, and the
     CSV and printable report mark candidates as candidates.
   - On a sighting with no readable plate, **Find similar** offers candidates
     by appearance, labelled **Candidates · not confirmed**. Keep the label.
4a. **Pursue.** The pursuit panel predicts the cameras the vehicle can reach
   next from its last confirmed sighting (straight-line distance, a speed band
   from observed journeys or a stated 10–60 km/h default) and, on **Start**,
   keeps up to two of them analysed for 15 minutes. The top bar shows
   *Pursuit: <plate> · N min left*. A read of the exact plate anywhere moves the
   pursuit on. It never pins the recorded clips, and when the grid has gone
   quiet it pins no grid camera and says why. Stop it when done.
4b. **Registration.** The registry card under the figures shows what the
   reference VAHAN record says — maker, colour, validity, linked FIRs — and
   flags a mismatch with what the camera saw. It is labelled *Reference data —
   not a live VAHAN query*; say so.
5. **Then watchlist it** (§2.4) so the next pass on any analysed camera raises an
   alarm by itself.
6. **Export** (§2.5).

**What to say if it was never read:** *"We did not read that plate in the
window. That is not evidence the vehicle was absent: this laptop analyses three
grid cameras continuously, plus any camera opened in Live or pinned by a
pursuit, so a camera that was not being analysed when it passed could not have
read it."* The report prints the same sentence.

### 2.4 Cross-reference live feeds against the watchlist (2.5 min)

**Say:** matching runs on every settled read, on every camera, against every
active entry — exact matches at the entry's own priority, one-character near
matches capped at medium as a lead to verify.

1. **Alarms → Watchlist → Add a plate.** For a guaranteed live alarm use a plate
   you can see being read on **Live → CAM-DEMO-01** (a recorded UK road clip that
   loops every 15 s). Category **Stolen**, priority **Critical**, case reference
   `DEMO/FIR/2026/LIVE`, remark "Live demonstration".
   For the day's vehicle use the organisers' case reference.
2. The alarm usually arrives within a minute as the clip comes round (one
   measured run on 12 Oct: 7 s). Fill the gap with the queue, not by waiting.
3. **Alarms.** The queue runs most severe first, a watchlist hit first within a
   severity, and a journey to explain never above a watchlist hit. The detail
   pane shows the crop, camera, time, read confidence, **Why it fired** and
   **What to do**, and the watchlist entry with its case.
4. Triage from the keyboard: `j`/`k` move, `a` acknowledge, `d` dispatch,
   `c` close, `f` false positive. Every transition records who and when.
5. **Clean up straight after:** close the alarm (`c`, with a note) and **Retire**
   the entry on the Watchlist. Never leave a demonstration entry live.

**Fallback** if no alarm in two minutes — the same chain in a terminal, printing
each step (it picks the best-read plate itself):
```bash
docker compose exec -e NAGARNETRA_API_URL=http://api:8000 api python /app/scripts/demo_anpr.py
```
It leaves its entry active and its alarm open: retire and close them after.

### 2.4b Persons watchlist — wanted or missing persons (1.5 min, optional)

**Say:** the brief asks for persons watchlists too. Faces are matched only on
cameras explicitly tagged for it, never on the grid's junction cameras (faces
there are a few pixels), and every match waits for a person to confirm it.

1. **Alarms → Persons.** Two demonstration entries on recorded stock footage,
   fictional cases, category *demo* — never "wanted".
2. **Four-eyes:** `DEMO/PERSONS/002` was enrolled by `supervisor` and is waiting.
   Approve it as `admin` (a different account). Show that the enroller cannot
   approve their own entry.
3. **Alarms → the *Persons* filter** (right of the filter row; face matches are kept
   out of the vehicle queue and the Overview). A *Possible person match* shows the enrolled reference and the
   captured face side by side, the similarity against the 0.45 threshold, the
   frames that agreed, and **A person must confirm this match before anyone
   acts.**
4. **Say what is not stored:** faces that match nothing are never kept, not even
   as numbers; every view of a reference photo is audited; entries expire.

### 2.5 Export the report of detected plates (1.5 min)

1. **Search → Export plate reads (CSV)** — every plate read in the chosen
   window, on every camera, with timestamps. This is the submission's "report of
   detected plates with timestamps".
2. For one vehicle: **CSV** (every visit in order and the leg to it) and
   **Printable report** → **Print or save as PDF**: route to scale, visits with
   crops, the notes a reader needs. It is light on purpose — it is paper.
3. Opening either is a plate search and lands in the audit trail.

### 2.6 GIS (1 min)

**Cameras → Map**: cameras clustered where several stand at one place, filters,
the camera popup. Basemap **Satellite** when online, **Offline** with no network
at all — district outlines are committed GeoJSON, which is the "works on a
plane" claim. The Overview map needs no tiles in the first place.

### 2.7 End-to-end performance and architecture (1.5 min)

Quote only these, and say which kind each is.

| Figure | Kind |
|---|---|
| Capture → event on the worker: **385 ms** median (p90 493, p99 559), 720p | measured, Sep |
| Detection → alarm on a connected screen: **24 ms** | measured |
| Stream killed → camera offline: **19 s** | measured |
| **4.39 fps** per 720p stream per worker, CPU only | measured |
| 4 always-on cameras + the one on screen: **4.4–5.6 cores** | measured, 11 Oct |
| Ingest: **2,774 events/s** sustained for 80,000 camera identities, 0 failures — but p95 capture→persisted **5.7 s** against a 3 s target while a backlog drained | measured load test, synthetic events, no video |
| 80,000 × 4 Mbps ≈ 320 Gbps central, against ~43 Mbps of events | arithmetic |
| Anything with a GPU | **never measured** — say so |

The **Live** screen shows the current capture-to-event latency for the camera on
stage; read that rather than the table if it is better or worse. Details:
[HLD §15](HLD.md#15-scale-evidence) and [§21](HLD.md#21-scalability-strategy).

### 2.8 Who looked at what (optional, 1 min)

**More → Audit trail**: every plate search, stream open, watchlist change and
sign-in, filterable. Reading the trail is itself recorded — one row per view.
Sign in as `auditor`: Live and Search are not offered, and typing
`/vehicles` refuses cleanly, naming the missing permission.

---

## 3. Live: which camera to put on the stage

Opening a camera makes the workers analyse it (within about 3 s), and **every
grid camera opened spends the organisers' per-address watch time**.

- Default to **CAM-DEMO-01** — it reads plates continuously and is labelled
  **Recorded clip**, which it is. Say so before anyone asks.
- For a grid camera, prefer the always-on three: **SBX-cam10, SBX-cam21,
  SBX-cam22** (they read the most plates). Open one, show it, move on.
- A grid camera with boxes but no plates is a junction overview — say why
  (§5). Do not hop through grid cameras looking for a better one.

---

## 4. If something breaks

[PANIC.md](PANIC.md). The short version:

| Symptom | Do this |
|---|---|
| Feed pill not **Live** / no plates | Read the worker logs ([PANIC §2](PANIC.md#2-no-plates-are-appearing)). **Do not restart the workers** |
| Grid refused our login | Nothing. It resumes by itself; demonstrate on CAM-DEMO-01 meanwhile |
| A grid camera will not play | Their gateway. Say so, switch to CAM-DEMO-01, do not debug on stage |
| CAM-DEMO-01 black | `docker compose restart simulator`, wait 15 s (touches no grid session) |
| A screen is blank or everything 401s | Sign out and in (15-minute token); hard refresh |
| Nothing works | The rendered pipeline video — [PANIC §7](PANIC.md#7-nothing-works--the-fallback) |

---

## 5. What not to claim

Judges reward honesty and punish overreach. Do not say:

- *"It reads plates on every government camera."* By day the grid yields
  roughly one valid plate per hundred detections, at night almost none: junction
  overviews, glare, vehicles facing away. Detection, tracking, health and events
  work on all of them; ANPR does not. The best readers are SBX-cam10/21/22.
- *"It watches all 31 cameras all the time."* Four continuously; the rest in
  45-second slices, or immediately while open on Live. Absence from a report is
  not absence from the road.
- *"Over 90% accuracy."* There is no real-world accuracy figure. The 100% exact
  match is on generated plates and optimistic by construction.
- *"It scales to 80,000 cameras."* Say: the architecture is designed for it, the
  ingest path sustained 2,774 events/s for 80,000 camera identities on this
  laptop, the latency target was missed under backlog, and the infrastructure
  sizing beyond that is arithmetic.
- *"Suspicious vehicle"* about a trajectory anomaly. The screen says **Journey to
  explain**: movement that differs from the norm, for a person to judge.
- *"These are real cases."* The ten watchlist entries are fictional, labelled
  `DEMO/…` and "DEMO (fictional)" (§6). Say so if asked.
- *"Face recognition"* or a persons watchlist — unless that screen has been
  rehearsed on this build today.
- *"It's production ready."* No TLS, no backups, an AGPL model weight in the
  export toolchain; `docs/SECURITY.md` §8 lists it all.

Being the person who says it first is worth more than hoping nobody asks.

---

## 6. The demonstration watchlist

Ten entries from `data/seed/watchlist.csv`, the representative data the brief
asks for: stolen, wanted, blacklisted and suspect vehicles, an e-challan
defaulter, and one whose validity has ended. Every one is fictional, its case
reference starts `DEMO/`, and its plate was checked against every plate the
feeds had read by 12 Oct and is at least three characters from each — so none
fires on a vehicle the cameras have seen. `GJ03AB1234` (stolen, critical) is the
one to type when showing a search for a listed vehicle.

Re-applying them is idempotent: `make seed` (or `python -m scripts.seed --only
watchlist` in the api container) creates, reinstates or refreshes them.

---

## 7. After each session

- [ ] Close any alarm raised during the session (`c`, with a note) — closed,
      never deleted; it happened
- [ ] **Retire** every watchlist entry added during it
- [ ] Leave the stack running. No restarts between sessions
