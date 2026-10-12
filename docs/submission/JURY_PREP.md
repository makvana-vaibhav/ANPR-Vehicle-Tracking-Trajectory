# Contrail: jury round preparation

Gujarat Police CCTV Hackathon **Sentinel**, jury round, 12–13 Oct 2026. You have 20–30 minutes
to explain the whole product, demo it live and answer questions.

The jury will check six things:

- Is it real, or static/mocked?
- Can a new camera be integrated on the spot?
- How secure is it?
- How scalable is it?
- What is missing, does the team know it, and is there a plan?
- What are the architecture, the stack and the code like?

This document prepares you for all six.

| | |
|---|---|
| Written | 12 Oct 2026, 11:30–12:30 IST, against the live stack on the demo laptop (branch `sentinel-gj`, HEAD `b4df4d1` plus other agents' uncommitted work) |
| How the facts were checked | Live API calls and SQL. A real onboarding rehearsal through the UI, timed (§2.7, Appendix A). All 13 browser flows passed (`tests/browser/flows.mjs --skip watchlist-alarm`, 0 console errors). `scripts/capacity_model.py`, run for this document |
| Screenshots | `tests/browser/out/jury/*.png` (gitignored). `rehearsal_*.png` are from the new-camera rehearsal |
| Number labels | **MEASURED**: a run on this project produced it. **ARITHMETIC**: computed by `scripts/capacity_model.py` from stated inputs. **EXTRAPOLATED**: anything with a GPU, never run. **NOT BUILT**: say so |
| "(being fixed now)" | Other agents were changing this item while this was written. The lead refreshes these lines before the jury |

---

## Read first: five facts that shape today's demo

1. **A pasted RTSP URL that contains a password is refused.** This is the most likely way a judge
   tests "integrate a new camera". The onboarding form returns `stream_url must not embed
   credentials` (`services/api/app/schemas/camera.py:129-142`). That rule is deliberate: passwords
   do not belong in the registry table. But the gateway has no second place to read credentials
   from for a plain RTSP camera (`services/gateway.py:59-104` sends `stream_url` as-is).
   - **Today, without code:** a credentialed camera goes through a one-line relay container. It
     was tested and works (§2.7, recipe B).
   - **Fix:** about 1–2 h. The gateway resolves the VMS record's `credentials_ref` when it
     registers the path. Recommended before the jury if anyone has the time. It is code, so it
     is not done here.
2. **A new camera takes 30–50 s to reach the AI workers.** The roster republishes every 30 s and
   each worker rediscovers every 20 s. Opening the camera in Live does not shorten this, because
   a worker honours focus only for cameras it already owns (`ai_worker/worker.py:300`).
   **Onboard first, talk for a minute, then open Live.**
3. **"Recorded video" in the onboarding form does not start playback by itself.** The simulator
   picks its clips at start-up, and only from the simulated VMS. The form never sets that VMS.
   - `curl -X POST localhost:9100/streams/<CODE>/start` starts it within about 5 s, with no
     restart. Measured (§2.7, recipe C).
4. **The organisers' grid has been refusing our login since about 09:10 IST.** At 11:40 no grid
   camera had read a plate for about 2.5 h. Command and Fleet health show "Feeds answering 2/32".
   - Health flapping: being fixed now.
   - Plan the demo on CAM-DEMO-01 plus the new camera. Treat the grid as a bonus.
5. **No plate has ever been read at two cameras.** `GET /api/v1/vehicles/routable` returns
   `[]` back to 1 Sep. That means no contrails, no drawn route, no Replay journey and Journeys = 0.
   - Camera positions: being fixed now.
   - §2.3 shows how to present the tracking step honestly anyway.

---

## 1. Run of show

### 1.1 Roles (4 presenters; for 3, merge C and D)

| | Role | Owns | Does not |
|---|---|---|---|
| **A** | Lead and narrator | Opening, architecture choice, limits and roadmap, closing; answers "why" questions | Touch the keyboard |
| **B** | Driver | Every click and URL. Keeps one browser tab, signed in as `admin`, zoom 110% | Talk over A; switch screens before A finishes the sentence |
| **C** | AI and scale | ANPR pipeline, accuracy, sizing, cost; Insights | Claim any figure without its label |
| **D** | Integration and security | New camera on the spot (terminal plus form), security, audit, the code tour | Restart any container |

**Q&A routing:**

- A takes the question and hands it to the owner in under 3 seconds.
- Nobody answers a question that belongs to someone else.
- A says "we don't know yet; here is how we'd find out" rather than guess.

### 1.2 The 25-minute version

Times are cumulative. **Before the jury enters:** D has already started the camera-feed container
(§2.7, recipe A), and B has `http://localhost:8080/dashboard` open.

| Time | Block | Who | On screen (exact URL) | The one sentence to land | If it fails (PANIC.md) |
|---|---|---|---|---|---|
| 0:00–1:30 | **Opening and pitch** | A | `http://localhost:8080/dashboard` (Command) | *"Gujarat already owns about 80,000 cameras across 26 departments; Contrail federates them so the state can ask 'where has this vehicle been?' without moving any video."* | A blank screen is the 15-minute token: sign out and in (PANIC §6). Keep talking |
| 1:30–4:00 | **Architecture and model choice** | A, then C | Architecture slide (`docs/submission/architecture.png`), then `docs/HLD.md` §2.2 table | *"We chose Models 1 + 3 + selective 2 with edge AI and rejected Model 4 by arithmetic: 320 Gbps of video against 43.7 Mbps of events, 7,324× less."* (ARITHMETIC) | No projector: read the numbers from the HLD on the laptop |
| 4:00–13:00 | **Live demo: the six test-case steps plus a new camera** (§2) | B drives, A narrates, D onboards | §2.1–2.7 | *"Everything you see is computed live from these feeds; watch this camera arrive while we talk."* | Per step in §2. Last resort: PANIC §7, the rendered pipeline video |
| 13:00–14:30 | **Analytics** | C | `http://localhost:8080/traffic` (Insights) and a "Journey to explain" in `/alerts` | *"Every figure says what it counts and how much data it rests on; an anomaly carries its reasons and is never called suspicious."* | Insights dominated by the clip: say so (§4, Q-AN3) |
| 14:30–16:30 | **Security** | D | `http://localhost:8080/audit`, filtered to the last 15 min, so the jury sees its own demo's actions | *"Every plate search, stream open and watchlist change is audited, including reading the audit trail; an auditor can read the trail but cannot search."* | Show `docs/SECURITY.md` §1 and `docs/HLD.md` §16.7 |
| 16:30–18:30 | **Scale and cost** | C | Terminal: `python3 scripts/capacity_model.py --cameras 80000` | *"Ingest measured 2,774 events/s for 80,000 camera identities with 0 failures; the p95 of 5.7 s missed our 3 s target, and the rest is arithmetic we label as such."* | Print the figures from §7 |
| 18:30–20:00 | **Limits and roadmap** | A | `docs/HLD.md` §16.7 and §22 (or the "What is not built" slide) | *"Here is what is not built and the order we'd close it; nobody should find a gap before we name it."* | — |
| 20:00–25:00 | **Q&A buffer** | All, routed by A | Whatever the question needs (§4) | — | — |

### 1.3 The 20-minute version

Cut, do not compress. Talking faster loses the jury.

| Time | Block | Change from 25 |
|---|---|---|
| 0:00–1:00 | Opening | Lines 1–3 of the pitch only (§8.3) |
| 1:00–3:00 | Architecture | One table: Model 4 vs Contrail |
| 3:00–10:30 | Demo | Short path: new camera (onboard during step 1, open it in step 2), CSV validate-only, a watchlist alarm on a live read, search and CSV export, map. Skip pursuit, registries and persons |
| 10:30–11:30 | Analytics | One Insights screen |
| 11:30–13:00 | Security | Audit trail of their own actions plus the RBAC sentence |
| 13:00–14:30 | Scale | Two numbers: 2,774 events/s measured; 43.7 Mbps vs 320 Gbps arithmetic |
| 14:30–15:30 | Limits | Three biggest gaps with their fixes (§5, rows 1–3) |
| 15:30–20:00 | Q&A | — |

### 1.4 The 30-minute version

The 25-minute run plus:

| Add | Where | Time | Who |
|---|---|---|---|
| Persons watchlist with four-eyes (DEMO_SCRIPT §2.4b): approve `DEMO/PERSONS/002` as admin, show the side-by-side match and "a person must confirm" | After the alert step | +1.5 min | B, narrated by D |
| Pursuit and "Possibly the same vehicle" on `NA54KGJ` | In the tracking step | +1 min | B |
| Registries card (`/registries?plate=GJ03AB1234`), labelled reference data | After tracking | +0.5 min | B |
| Code tour: 2 of the 5 files in §6.6 | After security | +2 min | D |
| Q&A | End | +5 min | All |

### 1.5 Presenter cues

- **A** opens and closes. The last sentence of the session is A's §8.3 line 5.
- **B** never narrates and never apologises for a screen. When something fails, B says
  *"switching to the recorded feed"* and does it. A carries on talking.
- **C** says the label with every number: *"measured"*, *"arithmetic"*, *"extrapolated"*. It costs
  half a second and is the team's whole credibility on scale.
- **D** keeps one terminal open in the repo root, font at 18 pt or more, with the §2.7 commands
  already in shell history.

---

## 2. The live demo, step by step

The mandatory test case has six steps. The order below runs the new camera *inside* steps 1 and
2, so the 30–50 s it takes to reach a worker passes while you talk.

**The data to use today (checked 11:40 IST):**

| Use | Value | Why |
|---|---|---|
| Camera for plates | `CAM-DEMO-01`: recorded UK road clip, loops every 15 s, labelled **Recorded clip** | 21,087 reads in 24 h. Reads continuously (always-on) |
| Plate with deep history | `EY61NBG` (2,084 reads, 9 visits, read confidence up to 0.97) | Investigate, CSV, report |
| Plate with candidates and pursuit | `NA54KGJ` (1,081 reads, 5 "Possibly the same vehicle" cards, a pursuit prediction) | The tracking step |
| Plate to watchlist live | Whatever **Live → CAM-DEMO-01** shows being read right now (EY61NBG, NA54KGJ, FJ14ZHY were reading at 0.97–0.99), or the new camera's `KA02MN1826` | The alarm must fire by itself |
| Listed plate for a search | `GJ03AB1234` (fictional, stolen, critical) | It has never been read, so use it on `/registries?plate=GJ03AB1234`. **Investigate shows no watchlist badge for a plate with no sightings** |
| Grid cameras, only if the workers log "analysing … SBX-cam…" | `SBX-cam10`, `SBX-cam21`, `SBX-cam22` | Best readers. One at a time. Never hop through grid cameras |

### 2.1 Step 1: Onboard ~50 cameras from different departments (about 2 min, starting at 4:00)

| | |
|---|---|
| **URL** | `http://localhost:8080/cameras` |
| **Clicks** | 1. Read the header: "32 registered · 31 enabled for plates · N without a position". 2. Scroll to the **Federation** panel at the bottom: connected systems (Hosted Camera Grid 30, Recorded demo feed 2) and available adapters (rtsp, onvif, vendor_api, hosted_grid, simulated). 3. **Import CSV** → choose `data/seed/sample_cameras.csv` → **Validate only**. Result: "Validation only — nothing was written · Would create 3 · Rejected 1 (CAM-SAMPLE-04 is outside Gujarat)". **Do not press Import.** 4. **D starts the new camera now** (§2.7): **Onboard camera** → fill in → **Onboard camera** |
| **Say** | *"The brief asks for about 50 cameras across departments. We have 32 real video sources: the organisers' 30, onboarded by federating their catalogue in one sync, and our two recorded clips. We don't pad the registry with cameras that have no video; that would make every count on every screen meaningless. The registry itself is not the limit: the load test onboarded 80,000 camera identities and tore them down again. Bulk onboarding is a CSV with a dry run, and every rejected row says why. And to show it's not canned, here is a camera we haven't seen before."* |
| **Proof it is real** | The CSV rejection reason is computed by the API's validator, not stored text. The new camera's row appears within 0.1 s of **Onboard camera** (MEASURED). `camera.create` lands in **Admin → Audit trail** under the presenter's name |
| **Expected timing** | Validate-only: under 2 s. Onboard form: about 30 s of typing; API 201 in under 0.2 s (MEASURED) |
| **Honest notes** | Most grid cameras have no department (27 of 32 unassigned) because the organisers' catalogue carries only an id and a name, and we refuse to guess an owner. Departments and positions: being fixed now. The registry table has no department column; department is a filter (top toolbar) |
| **Fallback** | CSV drawer will not open: run the same thing through the API. `curl -s -X POST "localhost:8000/api/v1/cameras/bulk?dry_run=true" -H "authorization: Bearer $TOKEN" -F file=@data/seed/sample_cameras.csv`. Federated sync, read-only: `docker compose exec -T api python /app/scripts/sync_sandbox.py --dry-run` |

### 2.2 Step 2: Integrate live feeds (about 2 min)

| | |
|---|---|
| **URL** | `http://localhost:8080/anpr?camera=CAM-DEMO-01`, then `http://localhost:8080/anpr?camera=JURY-01` (the new camera, at least 40 s after onboarding) |
| **Clicks** | 1. CAM-DEMO-01: point at **RECORDED CLIP** (say it before anyone asks), plate boxes, the **AI … ms** latency in the header (200–650 ms seen today), the **Reads** rail on the right with crops. 2. Click the new camera in the rail, or use the URL. Within about 7 s the video plays (MEASURED 7.2 s, HLS). Plate reads with the IND strip appear in the Reads rail about 30–40 s after opening (MEASURED: first read 32 s after Live opened, 41 s after onboarding) |
| **Say** | *"Video is pulled only while somebody watches: our gateway, MediaMTX, connects to the camera on demand and lets go 60 s after the last viewer. The AI worker that owns this camera, chosen by a hash of its code with no coordinator, has just opened it, because the camera on an operator's screen is analysed first. What crosses the network to the centre is one ~2 KB event per vehicle, not the video."* |
| **Proof it is real** | The plate crops in the Reads rail are cut from frames of *this* stream seconds ago, with timestamps in IST. The AI latency figure moves. A judge can wave a hand in front of their own camera (recipe A) |
| **Heterogeneous feeds (say, don't show)** | The grid's 30 streams are 24 × H.264 and 6 × HEVC, from 960×576 to 2560×1440. They are read over RTSP for inference and served to the browser through our authenticated HLS proxy, so the grid's credentials never reach a browser (`routers/grid_media.py`) |
| **Expected timing** | CAM-DEMO-01 plays in about 1 s (WebRTC). New camera: video about 7 s, first plate 30–40 s |
| **Fallback** | Grid refused: *"The organisers' grid is rate-limiting our login after a reconnect; we back off rather than hammer it"* (PANIC §2a). Never restart a worker. New camera shows no plates after 90 s: check `docker logs contrail-ai-worker-2 --tail 3` (one of the three owns it) for `analysing … JURY-01`. If it is not listed, the roster has not caught up; wait 30 s |

### 2.3 Step 3: Track a vehicle (the scored task, about 3 min)

| | |
|---|---|
| **URL** | ⌘K (Ctrl K) → type the plate → Enter → `http://localhost:8080/vehicles?plate=<PLATE>` |
| **Clicks** | 1. Type the jury's plate exactly as given. Window **24 h**, then **7 d**. 2. If it was read, show every sighting in order (IST time, camera, place, department, confidence, crop) and the figures panel. 3. **Close to what you typed** (when there are sightings) or **Did you mean…** (when there are none). 4. `NA54KGJ`: **Possibly the same vehicle**, 5 cards with reasons (which characters differ, OCR-confusable pairs counted as half, fit with the route in time and distance). **Include** one: it becomes a dashed *candidate* visit, never merged. 5. **Pursue** (in the header): the cameras it can reach next, and on **Start** up to two are kept analysed for 15 min. The top bar shows *Pursuit: <plate> · N min left*. **Stop** it afterwards. 6. **CSV** and **Printable report** |
| **Say (the honest version, which today is the only true one)** | *"Every sighting of this plate is here, in order, with its evidence. A route needs the same plate read at two cameras, and today our live data has none: we analyse 3 grid cameras continuously plus whatever is on screen, the grid has refused us since 9 a.m., and night yield on overview cameras is 11–20% for four-wheelers. So here's what the engine does when it has two sightings."* Then show `GET /api/v1/vehicles/<plate>/route` in `/docs`, or the route screenshot from the rehearsal, and explain the leg flags: `implausible_speed`, `impossible_simultaneous`, `heading_conflict`, `unobserved_gap`, `co_located`. A red dashed leg is shown, never dropped |
| **If the plate was never read** | *"We did not read that plate in the window. That is not evidence the vehicle was absent: a camera that wasn't being analysed when it passed could not have read it."* The printable report says the same |
| **Proof it is real** | Every plate search writes a `search.plate` audit row (and opening a route a `vehicle.read` row), visible in Audit seconds later. The candidate include/dismiss decisions are audited too |
| **Expected timing** | ⌘K to journey 2.6 s; candidates 3.9 s; pursuit prediction 5.2 s (today's browser flows, page loads included, MEASURED) |
| **Fallback** | No sightings anywhere: use `EY61NBG` to show the screens, then say the sentence above for the jury's plate. **Do not** invent a two-camera journey with a test script on stage |

> **To make step 3 real before the jury (team action, about 15 min):** run the new-camera recipe
> twice, as two cameras at two real junctions, each playing the same trimmed Indian-plate clip.
> The correlator then sees the same plates at two positions and draws a route with legs. Label
> both cameras honestly ("test feed, recorded") and tag them `recorded-footage`, so the anomaly
> engine excludes them from verdicts. Screenshot the route as backup. Remove them afterwards.
> This shows the engine working. It is **not** evidence of a real vehicle's journey; say so if asked.

### 2.4 Step 4: Generate alerts and history (about 2.5 min)

| | |
|---|---|
| **URL** | `http://localhost:8080/watchlist`, then `http://localhost:8080/alerts` |
| **Clicks** | 1. **Watchlist**: the **Add a plate** form is always on the right (not a button). Plate = one being read right now on CAM-DEMO-01, or `KA02MN1826` from the new camera. Category **Stolen**, priority **Critical**, case `DEMO/FIR/2026/LIVE`, remark "Live demonstration". 2. **Alarms**: while waiting, explain the queue order. 3. When it fires: detail pane with crop, camera, time, confidence, **Why it fired**, **What to do**, and the watchlist entry with its case. 4. Triage from the keyboard: `a` acknowledge, then `c` close with a note. 5. **Retire** the entry on Watchlist |
| **Say** | *"Matching runs on every settled read, on every camera, against every active entry: an exact match at the entry's own priority, and a one-character near miss capped at medium and labelled as a lead to verify. Detection to alarm on a connected screen measured 24 ms; the wait you see is the vehicle coming round again."* |
| **Proof it is real** | The plate was typed in front of the jury and the alarm cites the read that matched it, with its crop. The alarm count in the top bar changes. Afterwards, **Admin → Audit trail** shows `watchlist.create`, the `alert.transition` rows with your username, and `watchlist.deactivate` |
| **Expected timing** | Within one loop of the clip: CAM-DEMO-01 15 s (one measured run on 12 Oct: 7 s); the new camera 25 s (trimmed clip) |
| **Honest notes** | The alarm detail may say "This read was stored without a crop": 28 of the last 200 reads had none. Say *"the crop upload races the event; the read itself is evidence"* and move on. Watchlist alerts do not yet carry structured `reasons` (anomaly and person alerts do). The queue is currently full of "Possible person match" alarms from the persons clip loop: filter to **Watchlist** first |
| **Fallback** | Nothing after 2 min: `docker compose exec -e NAGARNETRA_API_URL=http://api:8000 api python /app/scripts/demo_anpr.py`. It picks the best-read plate and prints every step. Retire its entry and close its alarm afterwards (PANIC §4) |

### 2.5 Step 5: Visualise on GIS (about 1 min)

| | |
|---|---|
| **URL** | `http://localhost:8080/map`, then `http://localhost:8080/dashboard` |
| **Clicks** | Filters (status, department, integration, plate reading only). **Offline** / **Satellite** basemap toggle. The new camera at its junction. "Without a position N" list |
| **Say** | *"The basemap is committed GeoJSON: no tile server and no API key, so it works on a plane. Satellite is optional and probed before use. Cameras we couldn't place are listed apart, never dropped on the map at a guess."* |
| **Proof it is real** | The camera onboarded two minutes ago is on the map |
| **Honest notes** | Grid cameras are placed at town level (the catalogue gives names, not coordinates), and 6 have no position. "Coverage" today is a detection-density heatmap, not field-of-view coverage. Positions: being fixed now. In the rehearsal the new camera's map popup still said **State unknown** and "Nothing to play" 9 s after onboarding, although the API already had it online: use **Live ANPR** in the popup, or **Probe now** (`rehearsal_3_map.png`) |
| **Fallback** | Blank map: click **Offline** (PANIC §5). Command's map uses no tiles at all |

### 2.6 Step 6: Route, movement history and searchable events (about 1.5 min)

| | |
|---|---|
| **URL** | `http://localhost:8080/vehicles` → **Export plate reads (CSV)**; per vehicle, **CSV** and **Printable report** → **Print or save as PDF** |
| **Say** | *"This is the report of detected plates with timestamps the brief asks for: every read in the window, on every camera, in IST. For one vehicle: every visit in order and the leg to it, and a printable report with the route to scale and the evidence crops. Opening either is a plate search, so it is audited."* |
| **Proof it is real** | Open the CSV: the newest rows carry `KA02…` reads from the camera onboarded during the session, with seconds-old timestamps |
| **Expected timing** | CSV download about 2–10 s (browser flow: 9.9 s) |
| **Fallback** | The direct API link in `/docs`: `GET /api/v1/reports/plates.csv` |

### 2.7 A new camera, integrated on the spot (re-rehearsed 12 Oct, 12:45–12:53 IST)

The 11:40 rehearsal found three gaps, now fixed in code and measured again. The 11:40 numbers
appear below only as a comparison.

- **A password-protected camera is onboarded directly.** Paste the URL as the judge gives it
  (`rtsp://user:pass@host/…`), or type a username and password. The form moves the login out of
  the URL and says so on screen. The password is sealed with AES-256-GCM into the camera's
  `credentials_ref` (`enc://…`). It is opened only where the stream is opened: the gateway's
  pull, the health probe, and ONVIF calls. It is never returned, logged or audited. No relay
  container.
- **The AI workers pick a new camera up in seconds.** Onboarding republishes the roster at once,
  and each worker checks a version key every 2 s. The 30-second republish remains as a
  fallback.
- **"Recorded video" plays on onboarding.** The API asks the simulator to start it. The simulator
  refuses that call unless it carries a short-lived token from the API, so the old manual
  `curl` now gets **401**.
- **A new camera is probed once at onboarding**, using its login. It shows online in about 3 s,
  and a wrong password shows as `unauthorized` in about 4 s.

**What a judge could hand us, and what we do with it:**

| Judge offers | What we do | Time (measured on an equivalent stream) |
|---|---|---|
| A phone running an RTSP camera app ("IP Webcam" on Android, "RTSP Camera Server" and similar), with or without a password | Recipe A: paste the URL in the form | about 1 min to fill the form. First plate on screen 5–7 s after opening Live |
| An IP camera or NVR URL **with a username and password** (Hikvision `rtsp://user:pass@ip:554/Streaming/Channels/101`, CP Plus/Dahua `…/cam/realmonitor?channel=1&subtype=0`) | Recipe A: paste the whole URL. The form splits it | as above. **Rehearsed exactly this** |
| An ONVIF device | The ONVIF adapter now signs with the camera's login: WS-Security UsernameToken digest, a retry when the device's clock is wrong, and HTTP Digest as fallback. It has been **tested against recorded SOAP responses only, never a live device**. On stage: take the RTSP URL from the device's web page or ONVIF Device Manager and use recipe A with the same login | as A |
| A vendor VMS (Milestone, Genetec, CP Plus, Hikvision) | `VendorVmsAdapter`, tested on fixtures only. Do not attempt it live without the vendor's API. Explain how a vendor is added: one class plus one registry entry | not on stage |
| A video file on a USB stick | Recipe C: copy it into `data/videos/` and onboard it with **Recorded video**. It plays by itself | about 2 min. Plays about 1.6 s after onboarding once the clip is prepared |
| An analog camera | Not directly. It needs an encoder or DVR that exposes RTSP, then recipe A. This is how every IP platform takes analog | — |

**Network reality at a venue.** The camera must be reachable from the Docker containers on this
laptop.

- **Phone or camera on venue Wi-Fi:** client isolation often blocks device-to-device traffic. Put
  both on the laptop's hotspot or the phone's hotspot. Test before you type it into the form:
  `docker run --rm --network contrail-net --entrypoint ffprobe bluenviron/mediamtx:1.20.1-ffmpeg -rtsp_transport tcp 'rtsp://USER:PASS@<ip>:<port>/<path>'`.
  This one command puts the password in your shell history. Clear it afterwards with
  `history -d`, or press space before the command.
- **The pipeline is vehicle-first.** It detects a vehicle, then looks for its plate. A plate
  printed on paper and held up to a phone will **not** be read. Point the camera at a road, a
  car park, or a screen playing traffic.

#### Recipe A: any RTSP URL, with or without a password (what we rehearsed)

1. Network → Cameras → **Onboard camera**.
2. Fill in:
   - **Camera code** `JURY-01`
   - **Name**, e.g. "Jury test camera"
   - **Latitude / Longitude**: inside Gujarat. The form refuses anything else, which is itself a
     point to show.
   - **District / City / Junction**
   - **Video source**: **Live stream URL**. **Paste the URL exactly as given, password and all.**
     The URL field keeps only `rtsp://host:port/path`. The username and the masked password
     appear in their own fields, with the note: *"The username and password were taken out of
     the URL. The password goes to the encrypted credential store…"* You can also type them
     into **Username / Password** directly.
   - **Department** `Gujarat Police`
   - **Type** `anpr`, **Protocol** `rtsp`
   - Leave **Analyse this camera for number plates** ticked.
3. **Onboard camera**.
4. Open Live (`/anpr?camera=JURY-01`) whenever you like. There is no need to wait for a
   discovery pass any more.

**Timeline as measured** (12:49:47 IST; the real UI driven by Playwright). The camera was a
throwaway MediaMTX server on the compose network that **requires RTSP authentication**:
anonymous reads got `401`, the login read h264 1280×720. It looped the first 25 s of
`anpr_plates.mp4` (720p30, Indian plates). The password was pasted inside the URL and contained
an unescaped `@`. Times are from the click on **Onboard camera**:

| t | What happened | 11:40 rehearsal | Source |
|---|---|---|---|
| 0 s | **Onboard camera** clicked | | browser |
| +0.4 s | POST `/api/v1/cameras` → **201**, `has_credentials: true` | 201 | browser |
| +0.7 s | Camera in the AI roster | +18 s | Redis |
| +0.8 s | Gateway path `jury-01` registered, pulling with the login, on demand | +0.1 s | MediaMTX API |
| +0.9 s | Row visible in the registry | +0.1 s | browser |
| +3.0 s | Health status **online**: probed at onboarding, with the login | +3.5 s | API |
| +5.2 s | Live opened | +9 s | browser |
| +6.4 s | **Worker reading the stream: 1.2 s after opening Live** | +32 s (23 s after opening) | MediaMTX readers |
| +10.4 s | Video playing in the browser (WebRTC) | +16 s (HLS) | browser |
| **+12.3 s** | **First plate on screen**: `KA02H7256`, 7.1 s after opening Live | — | live feed |
| +35.9 s | First stored plate event: `KA02H7256`, conf 0.84 | +41 s | live feed |
| 120 s of Live | 9 stored plate events, 4 distinct: `KA02H7256`, `KA02MM9091`, `KA02MN1826`, `KA02HH7256` | | live feed |

- **A first run at 12:45:26 IST**, before the onboarding probe existed, gave:
  - roster +0.7 s;
  - worker reading 1.4 s after opening Live;
  - first plate on screen (`KA02WH7256`) 5.1 s after opening Live;
  - first stored plate +24.1 s;
  - 17 stored plate events and 7 distinct strings in 120 s;
  - health online at +36 s, the next sweep.

  Yield varies from run to run with where the 25 s loop is when the worker joins.
- **"On screen" versus "stored".** A plate on screen is the in-view reading (`vehicle.observed`).
  A stored plate event is written when the vehicle leaves the frame and consensus has settled
  (`vehicle.completed`). That is why the stored event comes later.
- **Checked during the run.** We searched for the camera's password, both raw and
  percent-encoded, in these places:
  - the logs of all ten platform containers;
  - the camera's database row (`row_to_json`);
  - the `audit_log` params;
  - the Redis roster.

  It appeared **0 times**. The row holds `stream_url = rtsp://jury-cam:8554/live` and an
  `enc://v1.…` pointer. The audit row records `login_stored: true` and nothing more.
- **The live feed, by role.** An auditor signed in during the run received 70 vehicle events for
  `JURY-01`. Every one had its plate **withheld**. None carried a crop, and no overlay boxes
  arrived. Operators, supervisors and admins receive the feed unchanged.
- **Wrong password.** We created a camera through the API with the wrong password. Its health
  probe recorded `unauthorized` 4 s later. Its status stays "unknown" rather than offline, and no
  `camera_down` alarm is raised. To fix it, edit the camera and type the right password.

**Say:**

> *"We've never seen this camera, and it wants a password. I pasted the URL as you gave it. The
> password was taken out of the URL and sealed in an encrypted store. The registry row holds a
> ciphertext, and nothing we return, log or audit carries the password. The camera is on the
> map and was probed online with that login. The gateway pulls it only while someone watches,
> and an AI worker picked it up about a second after I opened it. No restart, no config file,
> no relay. Its creation is in the audit trail under my name, recorded as 'login stored', never
> the login itself."*

If plates show variants:

> *"Consensus votes across frames. Where frames disagree we show it as ambiguous rather than
> pick one silently, and 'Possibly the same vehicle' links the variants for a person to decide."*

#### Recipe B: relay container (fallback only)

Recipe A covers credentialed cameras now. Use a relay only if the API refuses the login with
*"Camera credentials cannot be stored: no encryption key is configured"*. That means
`ENCRYPTION_KEYS` is missing from `.env`, and the platform will not store a camera password in
clear. The relay holds the credential instead:

```bash
docker run -d --rm --name judge-relay --network contrail-net \
  -e MTX_API=no -e MTX_HLS=no -e MTX_WEBRTC=no -e MTX_RTMP=no -e MTX_SRT=no -e MTX_RTSPTRANSPORTS=tcp \
  -e "MTX_PATHS_CAM_SOURCE=rtsp://USER:PASS@CAMERA_IP:554/Streaming/Channels/101" \
  -e MTX_PATHS_CAM_SOURCEONDEMAND=yes \
  bluenviron/mediamtx:1.20.1-ffmpeg
```

Then onboard with stream URL `rtsp://judge-relay:8554/cam`, and run `docker stop judge-relay`
afterwards.

#### Recipe C: a video file (USB stick)

1. `cp <file>.mp4 data/videos/`
2. Onboard camera → **Video source: Recorded video** → choose the file → **Onboard camera**.
   - The API tells the simulator to publish it. No curl and no restart.
   - The simulator first makes a keyframe-dense copy of a clip it has not seen before, once.
     Allow up to a minute for a long clip; `docker logs contrail-simulator` shows
     `simulator.preparing_clip`.
3. Open it in Live.

**Measured** (12:52:48 IST, the real form, `anpr_plates.mp4`, which was already prepared):

| t | What happened |
|---|---|
| +0.3 s | 201 |
| +0.6 s | in the AI roster |
| +1.6 s | gateway path ready, published by the simulator |
| +5.1 s | Live opened |
| +6.6 s | video playing; worker reading (1.5 s after opening) |
| +11.0 s | first plate on screen: `KA02HN1826`, conf 0.92, 5.9 s after opening |
| +15.7 s | first stored plate event |
| 120 s | 12 stored plate events, 5 distinct |

- **Health.** A recorded clip has no URL of its own, so the monitor checks its path on our
  gateway, reading it as the workers do. It reads **online** after three agreeing probes, about
  30 s. Before this change it stayed "unknown" (`no_stream_url`) while playing. If the replay
  stops, the camera reads offline.
- **Manual lever**, to restart a replay or take it down on purpose. The bare `curl :9100/…` is
  refused now:
  `docker compose exec api python /app/scripts/simulator_control.py start|stop <CODE>`.
- **Tag it `recorded-footage`** (edit the camera), so analytics and anomaly scoring treat it as a
  recording.
- **Two-wheelers:** on a bus-stand clip with parked two-wheelers we got 32 vehicle events and
  **no plates in 60 s**. That is expected: plate yield on two-wheelers is about 0% (research
  §3.5).

#### Recipe D: our own stand-in camera, password-protected (when no judge device is available)

This is exactly what we rehearsed. It plays the first 25 s of `data/videos/anpr_plates.mp4` on a
loop, and the 25 s limit cuts the clip's "Subscribe" end card. Set a real password in place of
`CHANGE-ME`. Anonymous reads are refused (401).

```bash
cat > /tmp/jury-cam.yml <<'YML'
api: no
hls: no
webrtc: no
rtmp: no
srt: no
rtspTransports: [tcp]
authInternalUsers:
  - user: any
    ips: ['127.0.0.1/32', '::1/128']
    permissions:
      - action: publish
  - user: juryop
    pass: CHANGE-ME
    permissions:
      - action: read
paths:
  live:
    runOnInit: ffmpeg -re -stream_loop -1 -i /clip.mp4 -t 25 -c copy -f rtsp rtsp://localhost:8554/live
    runOnInitRestart: yes
YML
docker run -d --rm --name jury-cam --network contrail-net \
  -v /tmp/jury-cam.yml:/mediamtx.yml:ro \
  -v "$PWD/data/videos/anpr_plates.mp4":/clip.mp4:ro \
  bluenviron/mediamtx:1.20.1-ffmpeg
```

- Onboard by pasting `rtsp://juryop:<password>@jury-cam:8554/live`.
- **Frame it honestly:** *"This container plays the role of an IP camera on your network: a
  vendor's sample recording with Indian plates, behind a password, like an NVR. The onboarding
  is exactly what a real camera gets."*
- Setting MediaMTX's user list through `MTX_AUTHINTERNALUSERS_*` environment variables **does
  not lock it down**. We tested this: the default entry keeps its anonymous `read`. Use the file.
- **Never** point a camera's stream URL at our own gateway path (`rtsp://mediamtx:8554/<its own
  code>`). MediaMTX would pull from itself and loop (CLAUDE.md trap 1). Recipes A–D never do
  this.

#### Clean-up after the session (D, 2 min)

1. Delete the camera: Network → Cameras → the camera → delete, or
   `DELETE /api/v1/cameras/{id}`. Deleting needs **admin**.
   - It is audited as `camera.delete`.
   - Its gateway path, its stored login and, for a recorded clip, the simulator's replay go with
     it.
   - Its detections stay, with `camera_id` set to NULL. Evidence is never cascaded away.
2. `docker stop jury-cam judge-relay` (whichever ran), and `rm /tmp/jury-cam.yml`.
   - Delete the camera **before** stopping its source. Otherwise the health monitor raises
     `camera_down` for it, and you have an alarm to close (`c`, with a note).
3. Retire any watchlist entry you added.

---

## 3. Proof it is real, not static

A jury that suspects a mock is looking for something a mock cannot do. Pick 4–6 of these. The
first five need no terminal.

| # | Show | How | Why a mock could not fake it |
|---|---|---|---|
| 1 | **A camera they choose, onboarded now** | §2.7: their phone or URL, or our stand-in, onboarded through the form | A canned demo cannot know the URL in advance. The reads carry plates from *that* stream |
| 2 | **A watchlist alarm from a plate they pick** | Let a juror read a plate off Live and type it into Watchlist → the alarm fires by itself on the next pass | The trigger is chosen by the jury, after the fact |
| 3 | **The audit trail of their own demo** | `http://localhost:8080/audit`, last 15 min: `camera.create`, `camera.view`, `search.plate`, `watchlist.create`, `alert.transition`, then the `audit.read` row that viewing the trail just wrote | The rows name the presenter, the time to the second, and actions taken minutes ago |
| 4 | **The live feed (WebSocket)** | Command's "Reading now" strip and the pulsing **Live** pill. For a technical jury: DevTools → Network → WS → `/ws/events`, frames scrolling | Frames arrive with server timestamps seconds old. Closing the laptop's network stops them |
| 5 | **A camera dying is noticed** | `docker stop jury-cam` (the stand-in) → Fleet health and Alarms show `camera_down` | MEASURED 19 s (Sep) and about 30 s in today's rehearsal, with the probe's actual error text |
| 6 | **The API itself** | `http://localhost:8000/docs` → **Try it out** on `GET /api/v1/detections?limit=5` | 77 paths, 87 operations (live `openapi.json`). The response timestamps are seconds old. Title still says "NagarNetra": being fixed now |
| 7 | **The containers** | `docker compose ps` | 14 containers healthy: postgres, redis, minio, opensearch, mediamtx, api, web, ingest, simulator, 3 × ai-worker, prometheus, grafana |
| 8 | **The workers thinking** | `docker logs contrail-ai-worker-2 --tail 3` | "analysing 3 of 13 camera(s): CAM-DEMO-01, JURY-02, SBX-cam10 · each for 45s every 1.1 min; on screen: …" (live line from the rehearsal), plus events published |
| 9 | **Counters moving** | `curl -s localhost:8000/metrics` twice, 10 s apart. Or Prometheus at `http://localhost:9090` and Grafana at `http://localhost:3000` ("Contrail — pipeline"), both loopback-only | At about 11:56 IST: 20,398 events consumed, 5,218 persisted, **0 failed**, ingest p50 5.5 ms, in 52 min of uptime (MEASURED, `/metrics`) |
| 10 | **The database growing** | `docker compose exec -T postgres psql -U nagarnetra -d nagarnetra -c "select count(*) from detections where ts > now() - interval '1 minute'"`, twice | Real rows from a TimescaleDB hypertable |
| 11 | **The bus** | `docker exec contrail-redis redis-cli XINFO GROUPS nagarnetra:events:detections` | The consumer group, its pending count and lag (stream capped at about 100,000 entries) |
| 12 | **Evidence links really expire** | Copy a crop URL from an alarm and open it after 5 minutes (403). An unsigned URL to the same object returns 403 too (since `b4df4d1`) | Presigned for 300 s, private bucket |
| 13 | **Roles really restrict** | Sign in as `auditor`: no Live, no Investigate. Typing `/vehicles` refuses and names the missing permission. The refusal is an `auth.permission_denied` audit row | Enforced server-side on every route (`core/rbac.py:212`), not just hidden in the UI |
| 14 | **A CSV of reads** | Investigate → **Export plate reads (CSV)** | Seconds-old rows from every camera, with the read confidence |
| 15 | **The code and tests** | §6.6's files. The test counts in §6.5 | 1,175 Python test functions and about 400 web tests. **Do not run `make test` live**: the e2e suite raises a real critical alarm (DEMO_SCRIPT rule 2) |

**What is honestly not live, and you say so before they find it:**

- `CAM-DEMO-01` is a recorded UK road clip on a loop, labelled **Recorded clip**.
- `CAM-DEMO-02` is a stock persons clip.
- The ten watchlist entries are fictional (`DEMO/…`).
- VAHAN, SARTHI, eGujCop and AFIS answers are **reference data**, labelled on every card.
- The grid is the organisers' own replayed footage.

---

## 4. Question bank

Each question has three parts:

- **A.** What to say. Plain words, 2–4 sentences.
- **Show.** The proof, with its source.
- **If pressed.** The follow-up.

The owner (A/B/C/D, §1.1) is in brackets after the question. Every number carries its label and
source. For a gap, the answer is: what we know, why it is so, how we'd close it and how long that
takes.

### 4.1 Product and demo reality

**Q-PR1. Is this really working, or is it static or mocked? [A]**
**A.** It is live: every screen is computed from the feeds you can see, through a real bus, a
real database and a real alarm path. Give us a camera, or a plate to watch for, and the system
reacts to your choice.
**Show:** §3 items 1–3: a camera onboarded now, an alarm on a plate you pick, the audit rows of
this session.
**If pressed:** Name what is *recorded* before they find it. CAM-DEMO-01 is a looping UK clip.
The watchlist entries and the VAHAN/eGujCop answers are fictional reference data, and both are
labelled on screen.

**Q-PR2. What exactly is the product, in one sentence? [A]**
**A.** A statewide layer over the cameras and recorders that departments already own. It
registers and maps them, runs plate reading next to the video, and sends the state only events,
which become searchable vehicle histories, routes, watchlist alarms and traffic insight.
**Show:** Command (`/dashboard`).
**If pressed:** *"The central tier carries events, not video"* (HLD §1). That one design rule
decides the cost, the bandwidth and the data ownership.

**Q-PR3. Which reference model did you choose? [A]**
**A.** A hybrid:

- **Model 1** (registry + GIS), which is compulsory.
- **Model 3** (federation through adapters).
- **Model 2**, selectively: video is pulled on demand only.
- **Edge AI.**

We rejected Model 4 because of the bandwidth and storage arithmetic, not taste.
**Show:** HLD §2.1–2.2. Review's coverage estimate: Model 1 ≈75%, 2 ≈70%, 3 ≈75–80%, analytics
half of 4 ≈45% (`docs/review/SENTINEL_JUDGE_REVIEW.md` §1.3, a self-assessment).
**If pressed:** Q-CV1.

**Q-PR4. What runs on this laptop right now? [D]**
**A.** Fourteen containers on one 10-core, 16 GB MacBook:

- data: Postgres + PostGIS + TimescaleDB, Redis, MinIO, OpenSearch;
- video: MediaMTX gateway;
- application: API, ingest/health monitor, web;
- feeds: the clip simulator;
- AI: three AI workers;
- monitoring: Prometheus and Grafana.

The "edge" is logical here; in production the workers sit at the district sites.
**Show:** `docker compose ps` (§3 item 7).
**If pressed:** Everything is pinned and offline-capable. The only optional external call is the
satellite basemap.

**Q-PR5. How many cameras are integrated? [A]**
**A.** Thirty-two with real video: the organisers' 30 grid cameras, federated from their
catalogue, and two recorded clips. Plus any camera you hand us today. We did not pad the registry
to 50 with cameras that have no video, because that makes every count meaningless.
**Show:** `/cameras` header; Federation panel.
**If pressed:** The load test onboarded 80,000 camera identities into the same registry and tore
them down (`tests/load/run_load_test.py`).

**Q-PR6. Why only one camera on the Live screen, and no video wall? [B]**
**A.** On purpose. The grid meters watch-time per address and locks out on session churn, and
every open 1080p stream costs CPU to decode. An investigator needs the right camera, not 30 tiny
ones.
**Show:** `/anpr`: stage plus rail; DEMO_SCRIPT §3.
**If pressed:** Production design: sub-stream walls served from regional relays, on demand
(HLD §11). It is not built.

**Q-PR7. What happens if your demo laptop fails? [A]**
**A.** For the demo: a rendered video of this pipeline reading plates (PANIC §7), plus the HLD's
measured numbers. In production there is no single laptop. Each of the 33 sites is independent,
and the departments' recorders keep the video whatever happens to us.
**Show:** HLD §13.1.
**If pressed:** Q-SC9 (HA/DR).

**Q-PR8. What did you build in the hackathon versus before it? [A]**
**A.** The platform core existed before the event; the git history shows it. During the sandbox
round we built:

- the federation with the organisers' grid, including their two authentication systems and
  watch quota;
- the persons watchlist;
- registry readiness;
- pursuit and candidate sightings;
- the measured ANPR fixes;
- the hardening work.

**Show:** `git log --oneline`; `docs/BUILD_STATE.md` sections dated 11–12 Oct.
**If pressed:** Be exact about dates. Do not blur them.

### 4.2 Integration and interoperability

**Q-IN1. Can you integrate a new camera right now? [D]**
**A.** Yes. Give us an RTSP URL the laptop can reach, and it is on the map in under a second and
playing in about 7 s. Plates arrive about 40 s after onboarding, because the AI roster refreshes
every 30 s.
**Show:** §2.7, live.
**If pressed:** If it needs a password, see Q-IN2.

**Q-IN2. My camera has a username and password. Can you add it? [D]**
**A.** Yes, but not by pasting `user:pass@` into the URL. The registry refuses that on purpose,
so passwords never land in the most valuable table in the system. For today we run a one-line
relay that holds the credential (§2.7 recipe B, tested). In production the VMS record carries a
`credentials_ref` pointing into a secret store (`vault://`, `env://`, `file://`, or `enc://`
sealed with AES-256-GCM).
**Show:** The 422 message in the form; `services/secrets.py` docstring.
**If pressed:** Honest gap: for a *plain* RTSP camera, the gateway does not yet resolve
`credentials_ref` when it registers the path. That is about 1–2 h, including a test.

**Q-IN3. Do you support ONVIF? [D]**
**A.** There is an ONVIF adapter: device information, profiles and stream URI over SOAP, with
RTSP as the health fallback (`adapters/onvif.py`). It is tested on recorded device responses,
not on a physical device. It does not yet send the WS-Security login many devices require.
**Show:** `GET /api/v1/integration/adapters`; `tests/test_adapters.py`.
**If pressed:** Adding the UsernameToken digest header is about 2–3 h. Until then we take the
RTSP URI from the device and onboard it as RTSP.

**Q-IN4. How do you integrate a vendor VMS such as Milestone, Genetec, CP Plus or Hikvision? [D]**
**A.** Through an adapter per vendor behind one interface: `CameraAdapter` with `probe_health`
and `get_stream_url`, plus optional `list_cameras` and `get_recording`. The generic
`VendorVmsAdapter` already maps the field names those four vendors use. It is tested on fixtures,
not against a live VMS.
**Show:** `services/api/app/adapters/base.py:152`, `adapters/__init__.py:33` (the registry dict).
**If pressed:** A new vendor is one class plus one line in `_ADAPTERS`, with no migration. Q-CD7.

**Q-IN5. How did you integrate the organisers' grid? [D]**
**A.** As a federated VMS:

- `HostedGridAdapter` reads their catalogue;
- it handles their two hosts (a CDN for catalogue and HLS, direct RTSP/WHEP), a changing id
  scheme, the portal login and one session per address;
- a refused login pauses the whole host with back-off, so we never lock their account out.

Video for browsers goes through our authenticated HLS proxy, so their credentials never reach a
browser.
**Show:** `adapters/sandbox.py`, `ai_worker/backoff.py`, `routers/grid_media.py`.
**If pressed:** Since about 09:10 IST the grid has refused our login. The workers retry once per
pause (2 → 15 min) rather than hammer it.

**Q-IN6. Do you affect the departments' existing systems? [A]**
**A.** No. We only consume:

- catalogue reads;
- on-demand stream pulls that MediaMTX releases 60 s after the last viewer.

We never write to a department's VMS, never re-point cameras, and never record their video.
**Show:** `services/gateway.py` (sourceOnDemand, 60 s close); `docs/SECURITY.md` §6 ("consumes
and never publishes").
**If pressed:** One pull per camera however many people watch it, because MediaMTX fans out.

**Q-IN7. What about analog cameras? [D]**
**A.** Through an encoder or a DVR that exposes RTSP, which is how every IP platform takes
analog. Then it is an ordinary RTSP or vendor-VMS onboarding.
**If pressed:** No direct analog capture is built, and none is planned.

**Q-IN8. Can you onboard many cameras at once? [D]**
**A.** Yes, three ways:

- **CSV:** `POST /api/v1/cameras/bulk` with a dry run, row-level errors and a 20 MB cap.
- **API:** an `api_client` role that can only create cameras.
- **Federated sync:** from a VMS catalogue, as we did with the grid's 30.

**Show:** Validate-only with `data/seed/sample_cameras.csv` (3 would be created, 1 rejected with
its reason).
**If pressed:** Excel import is **not built**; save as CSV today. Adding `.xlsx` with openpyxl is
about 1 h (HLD §22.1).

**Q-IN9. What camera metadata do you hold? [D]**
**A.** Location (a PostGIS point), department, VMS, protocol, stream URLs (never shown to
browsers), type, resolution, fps, heading, install date, tags and live health.
**If pressed:** **Not built:** storage/retention, NVR, power, network link and maintenance/AMC
fields. About 2–3 h with a migration (HLD §22.1, review P1-4).

**Q-IN10. Do you support H.265 and high resolutions? [C]**
**A.** Yes, measured on the grid: 24 H.264 and 6 HEVC streams, from 960×576 to 2560×1440. HEVC
costs more to decode: 0.154 → 0.121 core per open stream after our decode fix, against
0.140 → 0.070 for H.264 (MEASURED, BUILD_STATE 12 Oct).
**If pressed:** Use the camera's sub-stream for analysis where the plate is still at least about
56 px wide (Q-AC6).

**Q-IN11. What if port 554/8554 is blocked between a site and the centre? [D]**
**A.** Two answers:

- **The worker** probes RTSP versus HLS once per host and uses whichever works.
- **The design:** the worker sits at the site and only events cross the WAN, outbound to the
  centre, so no inbound video port is needed centrally.

**Show:** `fleet_roster.py` (both URLs travel and the worker chooses), HLD §16.2 zones.

**Q-IN12. Can you play back recordings from the department's VMS? [D]**
**A.** The adapter method exists (`VendorVmsAdapter.get_recording`), but no route or screen calls
it yet. So: designed, not demonstrated. Recordings stay in the department's VMS, which is the
right owner.
**If pressed:** A `GET /cameras/{id}/recording` route plus a player is about 1–1.5 h (review
P1-11).

### 4.3 ANPR accuracy (owner: C)

**Q-AC1. What is your plate-reading accuracy? Is it above 90%? [C]**
**A.** We do not claim a system accuracy figure, and we do not claim 90%. On legible night-time
grid plates, reading one crop, the deployed configuration got:

- **87.0%** exact on 54 crops both labellers were sure of (CI 76–94%);
- **83.3%** on the research set of 60;
- **92%** of the plates it commits as valid are right.

All of this was labelled by AI labellers, not people (MEASURED, `ai-lab/FINDINGS.md` §9,
HLD §15.3).
**Show:** HLD §15.3 table.
**If pressed:** A real claim needs about 400 vehicles labelled by two people, split by day/night,
plate type and vehicle class, with Wilson intervals. That is the first gate of the district
pilot (HLD §17, gate 1(b)).

**Q-AC2. Then how many vehicles get a plate at all? [C]**
**A.** On the grid's overview cameras at night (11 Oct, before the fixes), the share of
completed vehicles with a valid plate was:

- cars 11.3%;
- trucks 19.7%;
- buses 14.8%;
- two-wheelers 0%.

These are junction overviews, not ANPR-grade cameras: glare, distance, vehicles facing away
(MEASURED, research §3.1).
**If pressed:** ANPR belongs on ANPR-grade cameras with the right angle, shutter and IR. That is
why our sizing analyses a 20% subset of the estate (Q-SC4).

**Q-AC3. How did you measure it? [C]**
**A.** We pulled 160 grid crops and 50 demo crops through the API, one per vehicle, at random.

- Two independent AI labellers read them blind, and the results were adjudicated mechanically:
  54 gold, 44 agreed, 17 disputed (excluded).
- We re-ran the OCR configurations on them in the worker image.
- An exact McNemar test compared the configurations.

**Show:** `ai-lab/scripts/{fetch_eval_crops,label_sheets,ocr_bench}.py`; FINDINGS §9.
**If pressed:** The set is biased toward plates the pipeline could partly read, and 37 of 54 gold
crops come from one camera. It ranks configurations. It does not certify accuracy.

**Q-AC4. What improved accuracy the most? [C]**
**A.** Feeding the OCR the raw plate crop instead of a contrast-enhanced one. CLAHE alone cost
about 25 points. Measured results:

- research set: 61.7% → 83.3% (McNemar p = 0.001);
- rebuilt set: 77.8% → 87.0% gold;
- demo clip: wrong plates 3 → 0.

A counter-intuitive result, found by measuring.
**Show:** research §3.2 table.

**Q-AC5. Night, rain, blur? [C]**
**A.** None of the cheap image enhancements beat the raw crop on night crops (MEASURED,
research §3.6). Plates a human cannot read, we cannot read. The lever is more looks per vehicle,
so the sharpest frame gets read, and ANPR-grade cameras with IR.
**If pressed:** Super-resolution was researched (research §6.3) and not adopted: it invents characters,
which is the worst failure for a watchlist.

**Q-AC6. How small a plate can you read? [C]**
**A.** Reading collapses below about 50–56 px of plate width, roughly 5 px per character. At
56 px PP-OCR gets 70%; at 40 px, 5% (MEASURED on downscaled crops, so optimistic, research §3.4).
Our gates are 40 px to localise and 52 px to read, and lowering them buys nothing.

**Q-AC7. Two-wheelers? [C]**
**A.** Mostly not readable from overview cameras: 0% valid plates on 122 grid motorcycles at
night (MEASURED). The plate is small and often two-row, and two-row plates are 4.9% of stored
grid crops.
**If pressed:** Two-row reading is 3 of 7 on a tiny set. A plate-specific second reader is
planned (research #3). We will not promise two-wheelers on overview cameras.

**Q-AC8. Indian plate formats: HSRP, BH series, two-row? [C]**
**A.** The grammar knows:

- standard state series (`GJ01AB1234`, with valid state codes);
- the BH series (`22BH1234AB`);
- the legacy three-letter series.

It repairs at most 2 characters against a slot template, and drops a leading "IND" hologram
artefact only when what is left is valid. The region is a property of the camera (the demo
camera is tagged GB).
**Show:** `ai-lab/ailab/aggregate/grammar.py:27-47`.
**If pressed:** Temporary, trade and defence plates are not in the grammar. Adding a format is a
regex plus a slot template, about 1 h with tests.

**Q-AC9. Which models, and why? [C]**
**A.** All run on ONNX Runtime, torch-free:

- **YOLOv8n @640** finds vehicles.
- **ByteTrack** tracks them.
- **YOLO11n @320** searches for a plate inside each vehicle.
- **PP-OCRv4 recognition**, via RapidOCR, reads it.
- **Multi-frame consensus** decides.

Vehicle-first is cited at 90.0% vs 59.6% end-to-end against full-frame plate search (Laroca et
al. 2021). Nano models because inference runs on CPUs at the edge.
**Show:** HLD §5.4; research §6.2; `ai-lab/ailab/pipeline.py`.
**If pressed:** PP-OCRv4 beat 9 alternatives on Indian grid plates once given the raw crop
(research §3.3).

**Q-AC10. How does multi-frame consensus work? [C]**
**A.** Every look at a vehicle produces a read. Characters are voted per position, weighted by
OCR confidence times crop quality, with a weight floor. A disagreement between OCR-confusable
characters (0/O, 8/B, 5/S) is flagged as ambiguous, not hidden. One event per vehicle carries the
winner, the runners-up, how many frames agreed, and whether it is grammar-valid.
**Show:** `ai-lab/ailab/aggregate/consensus.py:34`; **AMBIGUOUS** chips in the Live Reads rail.
**If pressed:** Measured on the demo camera after the fixes: reads resting on a single frame fell
from 24% to 9%; median reads per plate rose from 2 to 4.

**Q-AC11. What is your false-read rate, the one that causes a false alarm? [C]**
**A.** Our proxy is "a valid plate claimed on a crop a human could not read": 2 of 31 with the
deployed configuration, down from 3 (MEASURED, FINDINGS §9). Near matches are capped at medium
and labelled, so a one-character misread is a lead, never a critical alarm.
**If pressed:** Planned: grade a read as "corroborated" only when two independent readers agree.
On the research set that gave 39 of 39 correct and 0 claims on 41 unreadable crops (research #3).

**Q-AC12. Did you train your own model? [C]**
**A.** No. We use pretrained detectors and OCR, exported to ONNX. Our work was measuring and
fixing the pipeline around them: crop conditioning, fallback bounds, decode cost, consensus and
grammar.
**If pressed:** The detector weights come from Ultralytics and are **AGPL-3.0**. That is an open
licensing decision before deployment. Permissive replacements to retrain (YOLOX, PP-PicoDet,
NanoDet-Plus, RT-DETR; Apache-2.0) are listed in research §6.2.

### 4.4 Tracking and route reconstruction

**Q-TR1. Show me a vehicle tracked across cameras. [B, narrated by A]**
**A.** The engine is built and tested. It clusters sightings into visits, scores each leg's
distance and implied speed, and flags any leg it does not believe. Today, though, the live
database has **no plate read at two cameras**: `GET /api/v1/vehicles/routable` returns empty back
to 1 Sep. The grid has refused us since 09:10, and night yield on overview cameras is low.
**Show:** `/vehicles?plate=EY61NBG` (2,084 reads at one camera); `services/correlator.py`
(`cluster_into_hops :442`, `score_legs :484`); a two-camera route on the test feeds, if the team
did the §2.3 box.
**If pressed:** Never fake a journey. Say: *"The first live multi-camera journey is our pilot's
headline gate, not something we'll stage."*

**Q-TR2. How do you link two sightings? [C]**
**A.** Today, by the same plate string within a time window. Each leg is then checked for
physics:

- `implausible_speed`;
- `impossible_simultaneous`: the same plate at two distant places at once;
- `heading_conflict`: against the camera's facing;
- `unobserved_gap`;
- `co_located`.

Legs are straight lines between cameras, so every distance and speed is a lower bound, and the
screen says so.
**If pressed:** Flagged legs are drawn red and dashed. They are never dropped.

**Q-TR3. What if the plate wasn't read at one camera? [C]**
**A.** "Possibly the same vehicle" lists reads one or two characters away. OCR-confusable pairs
count as half a difference. Each candidate carries its reasons and whether it fits the route in
time and distance. An officer **includes** a candidate as a dashed candidate visit, or
**dismisses** it. It is never merged automatically, and both decisions are audited.
**Show:** `/vehicles?plate=NA54KGJ`: 5 candidate cards (browser flow `investigate-candidates`).

**Q-TR4. Do you do vehicle re-identification by appearance? [C]**
**A.** Partly. The data model and API exist (`GET /api/v1/reid/candidates`, "Find similar"), but
no appearance-embedding producer runs at the edge yet. Today's candidates are ranked by
time-distance plausibility only, and the response says `embedding_available: false`.
**If pressed:** Next: an appearance embedding per vehicle crop at the edge, scored only within an
already time- and distance-narrowed set. It will be shown as a suggestion, never a merge.
Colour and type attributes come first (P9).

**Q-TR5. What is "pursuit"? [B]**
**A.** From a vehicle's last confirmed sighting, it predicts which cameras the vehicle can reach
next. It uses straight-line distance and a speed band from observed journeys, or a stated
10–60 km/h default. On **Start** it keeps up to two of those cameras analysed for 15 minutes, and
a read of the plate anywhere moves the pursuit on.
**Show:** `/vehicles?plate=NA54KGJ` → **Pursue**. Today it says it will not pin grid cameras
because the grid has produced nothing for 2 h 29 min, and explains why.
**If pressed:** It never pins recorded clips. It is audited (`pursuit.start`).

**Q-TR6. With 80,000 cameras, how do you avoid matching the wrong vehicle? [C]**
**A.** We match the plate only within a time window, run plausibility on every leg, and show
uncertainty instead of hiding it: candidates labelled, near matches capped, anomalies with
reasons.
**If pressed:** At state scale, the registry's class, colour and make checks (VAHAN, once live)
add a second identity signal (Q-CV4).

**Q-TR7. How do you find a vehicle with no plate at all? [C]**
**A.** Attribute search exists: type, camera and time window, "By attributes" in Investigate.
Colour is **not built**: no colour producer at the edge yet. So a no-plate search today is
type + place + time, labelled "Candidates · not confirmed".
**If pressed:** A colour classifier on the vehicle crop at the edge is about 1–2 days, including
measurement.

**Q-TR8. What is a "trajectory anomaly"? [C]**
**A.** A journey that differs from what the fleet usually does: a rare transition between two
cameras, an unusually slow or fast leg, or an impossible hop. It is raised with its reasons and
called "Journey to explain", never "suspicious". Recorded footage is excluded before scoring.
**Show:** `services/anomaly.py`; `alerts.reasons` (migration `0005`); the Journeys tab in Insights.
**If pressed:** It always sorts below watchlist and camera alarms, whatever its severity.

### 4.5 Alerts and watchlists

**Q-AL1. How fast is an alert? [C]**
**A.** Measured pieces:

- detection to alarm on a connected operator's screen: **24 ms**;
- capture to event at the edge: p50 **241 ms** (after the 12 Oct fixes);
- capture to browser: p50 **135 ms** (recorded camera, Sep).

The event is emitted when the vehicle's track settles, usually when it leaves the frame, so the
alarm follows the vehicle by its time in view plus well under a second.
**Show:** HLD §8, §15.1, §19.6.
**If pressed:** Under statewide synthetic load, capture-to-persisted p95 was 5.7 s, which missed
our 3 s target. That was queue wait, not processing (Q-SC2).

**Q-AL2. What triggers an alert, and how are they prioritised? [B]**
**A.** Every settled read is matched against every active watchlist entry:

- an exact match raises at the entry's own priority;
- a one-character near match is capped at **medium** and labelled as a lead to verify.

The queue orders most severe first, a watchlist hit first within a severity, and journeys to
explain below everything. Other types: `camera_down`, `person_match` (never critical),
`anomaly`.
**Show:** `/alerts`; `services/watchlist.py:164`; `services/alerts.py:361`.

**Q-AL3. How do you avoid false alarms? [C]**
**A.** Five ways:

- near matches are capped and labelled;
- duplicate alarms for the same kind, plate and camera are folded across replicas within 90 s;
- a false positive must record why;
- recorded footage never produces an anomaly verdict;
- a person match always needs a human.

**If pressed:** Two known noise sources today:

- grid `camera_down` flapping (being fixed now);
- the persons clip re-raising "Possible person match" every 5–6 minutes.

Neither is hidden.

**Q-AL4. Can an alert explain itself? [C]**
**A.** Anomaly and person-match alerts carry structured `reasons` (migration `0005`), shown as
**Why it fired**. A watchlist hit shows the matching read, the entry, its case reference and the
crop, but its `reasons` field is still empty.
**If pressed:** Filling watchlist `reasons` (exact or near, edit distance, entry, case) is about
1 h (HLD §22.1).

**Q-AL5. What is the alert lifecycle? Who can do what? [D]**
**A.** new → acknowledged → dispatched → closed, or false positive, and each transition records
who and when. The transitions are separate permissions:

- an operator can acknowledge;
- dispatching and closing need a supervisor.

**Show:** `routers/alerts.py:183` (transition, authorised per target state); keyboard
`j/k/a/d/c/f`.

**Q-AL6. What does a watchlist entry carry? [B]**
**A.** The plate, a category (stolen, wanted, blacklisted…), a priority, a case reference, a
remark, validity, and who added it. The case reference travels into the alarm. Every change is
audited (`watchlist.create/update/deactivate`).
**If pressed:** The ten demo entries are fictional (`DEMO/…`). Each was checked to be at least 3
characters from every plate the cameras had read, so none fires by accident.

**Q-AL7. How are operators notified? [B]**
**A.** On screen, through a WebSocket: an alarm card, the count in the top bar, the queue. It
reconnects with back-off.
**If pressed:** **Not built:** SMS, e-mail, wireless-set or CAD integration, and Prometheus
Alertmanager paging for system alerts. The alarm is an API object, so an integration is a
subscriber on the existing pub/sub channel.

**Q-AL8. Can the same alarm be seen in every control room? [D]**
**A.** Yes. Every API replica tails the event stream itself (`EventTailer`), and alerts fan out
over Redis pub/sub. The load test found that one class doing both persistence and fan-out would
have shown each of two replicas only half the state. We split them.
**Show:** HLD §5.3, §15.2.

### 4.6 Persons and face matching (owner: D)

**Q-PE1. You do face recognition? Is that legal? [D]**
**A.** A purpose-limited persons watchlist for missing persons and persons wanted under a named
warrant, behind controls built into the code:

- four-eyes enrolment, refused at both API and database;
- a written purpose and legal basis;
- expiry: 30 days by default, 90 at most;
- faces that match nothing are never stored;
- a human confirms every match.

The lawful basis, the DPIA and who may authorise an entry need the state's legal sign-off. That
is a rollout gate, not something engineers decide.
**Show:** `/persons`; `docs/SECURITY.md` §7.1; migration `0009` CHECK constraints.

**Q-PE2. Where does it run? On every camera? [D]**
**A.** No. Only on cameras tagged `analytics:faces`, and only while an approved entry exists.
With an empty gallery the face stage does not look at all. Never on the grid's junction cameras,
where faces are a few pixels.
**If pressed:** Today that is one camera: CAM-DEMO-02, a stock clip.

**Q-PE3. What models, and how accurate? [D]**
**A.**

- OpenCV Zoo YuNet for detection (MIT licence).
- SFace for recognition (Apache-2.0).
- Threshold 0.45, stricter than SFace's published 0.363.
- At least two agreeing frames.

The only measurement is three people in one well-lit clip: same person 0.581–0.963, others at
most 0.286. That is a check, not an accuracy figure.
**If pressed:** No measurement on real CCTV faces (angle, night, distance). It must be
re-measured on the cameras it will run on before any use.

**Q-PE4. What is stored? [D]**
**A.** For an approved entry: the reference photo, re-encoded (no EXIF or GPS), in a private
bucket, and its embedding while it can match. For a match: the captured face crop and the
similarity score. Never stored:

- faces that matched nothing, not even as numbers;
- embeddings of faces a camera saw;
- the original upload.

**Show:** SECURITY §7.1 "What is never stored"; `ailab/face/stage.py`.

**Q-PE5. Who can see a face? [D]**
**A.** Any human role with `person.read`, through a 2-minute signed link. Every list, view and
evidence read writes an audit row naming each photo. The live event feed never carries raw
person matches, and the gallery the cameras use holds no photo and no name.

**Q-PE6. What stops a rogue officer enrolling someone? [D]**
**A.** Three controls:

- four-eyes: a *different* account must approve, enforced by a CHECK constraint in the database
  as well as the API;
- every action is audited, including refused attempts;
- every entry expires.

**If pressed:** Honest gap: today's demo roles share one documented password (S5), so "two people"
is not yet guaranteed. Production uses named accounts through SSO with MFA.

**Q-PE7. Bias? [D]**
**A.** Not measured; three people in one clip is no basis. That is exactly why a match is
"possible", priority high and never critical, shown side by side for a human, and never acted on
automatically.
**If pressed:** Before any deployment: an evaluation across demographics on footage from the
target cameras, plus the state's DPIA.

**Q-PE8. Can a person-match trigger action automatically? [D]**
**A.** No. The alarm says "A person must confirm this match before anyone acts". Nothing is
dispatched by the system.
**If pressed:** Honest: refusing acknowledge or dispatch until the comparison is recorded is
designed, not yet enforced (HLD §19.6, §22.1).

### 4.7 Security (owner: D)

**Q-SE1. How secure is it? [D]**
**A.** Identity, authorisation and accountability are built and tested:

- argon2id passwords;
- 15-minute JWTs with rotating refresh tokens and revocation;
- 6 roles × 23 permissions, checked server-side on every route;
- an audit row for every mutation, search and stream open, and for reading the audit log.

Network hardening of this laptop prototype is **not** done, and we list exactly what is open.
**Show:** `docs/SECURITY.md` §1; `docs/HLD.md` §16.7 (S1–S11 with status and production fix).
**If pressed:** *"Of the eleven holes our own review found, one is closed, TLS is partial, and the
rest have named fixes. Here's the list."*

**Q-SE2. What is open today? [D]**
**A.** Five things, all in HLD §16.7:

- **S2:** Postgres, Redis (no password), MinIO, OpenSearch and the MediaMTX API are published on
  every interface.
- **S3:** our own camera streams can be read without the stream token.
- **S5:** demo roles share one documented password.
- **S11:** the API trusts `X-Forwarded-For` from anyone.
- **S8:** the audit log is not tamper-evident.

Also: the live WebSocket feed is not filtered by role.
**If pressed:** Order of work: S2 and S11 first, because together they let someone on the same
network inject alarms or reset the login limiter. About 0.5 h for compose port binding and a
Redis password, plus a restart. Then S3 (MediaMTX `authMethod: http` → `/api/v1/streams/verify`,
about 1.5 h), then S5 and S7 (HLD §16.7).

**Q-SE3. Is traffic encrypted? [D]**
**A.** Partly. The web tier serves HTTPS on **:8443**, TLS 1.2/1.3. Crops and video go through
same-origin read-only proxies, measured with no plain-HTTP request from the page. :8080, :8000 and
container-to-container traffic are cleartext today.
**Show:** `https://localhost:8443` (self-signed here; mkcert or a CA in production);
SECURITY §6.1.
**If pressed:** Production: TLS at the DMZ, TLS to the bus, database and object store, and IPsec
or mTLS on every site link (HLD §16.2).

**Q-SE4. Encryption at rest? [D]**
**A.** Not at the volume or object level today. Application-level AES-256-GCM seals credential
values (`enc://`, 44 tests).
**If pressed:** Production: LUKS on database and object disks, MinIO SSE-KMS per bucket (its own
key for faces), encrypted backups, keys in the state DC's HSM or KMS (HLD §16.5).

**Q-SE5. How do you stop misuse by an insider? [D, then A]**
**A.** By making misuse visible and attributable:

- every plate search and route read is audited with the plate and the window;
- reading the audit trail is itself audited, with no exception for admin;
- the auditor role can read the trail but cannot search vehicles;
- accounts are personal and deactivated, never deleted;
- watchlist entries need a case reference;
- persons enrolment is four-eyes.

**Show:** `/audit`: the jury's own session.
**If pressed:** Two gaps:

- **Tamper-evidence:** INSERT-only grant, hash chain, daily WORM export to a SIEM. About 1 day.
- **Department-scoped visibility:** about 2–3 h for the core filter.

**Q-SE6. Can a user see other departments' cameras and alerts? [D]**
**A.** Today, yes. Every role sees every department. `users.department_id` exists but no query is
scoped by it.
**If pressed:** Designed in HLD §20.1 (access classes). Core filter in `apply_filters` and the
alerts and stream routes, about 2–3 h plus tests. Department CRUD API about 1 h.

**Q-SE7. How are camera and VMS credentials stored? [D]**
**A.** Never in the registry. `credentials_ref` is a pointer (`vault://`, `env://`, `file://`) or
an AES-256-GCM sealed value (`enc://`), and a test asserts it. RTSP credentials are redacted from
every log line, also asserted by a test, and are never returned to a browser.
**If pressed:** That is why a pasted `user:pass@` URL is refused (Q-IN2).

**Q-SE8. What about the video streams themselves? [D]**
**A.** A browser gets a short-lived (120 s), camera-scoped stream token, and opening a stream is
audited (`camera.view`). The grid's HLS goes through our proxy, which checks that token.
**If pressed:** Honest: for our own MediaMTX paths the token is not yet enforced. MediaMTX allows
any reader (S3). Fix: `authMethod: http` to `/api/v1/streams/verify`, about 1.5 h.

**Q-SE9. Rate limiting and brute force? [D]**
**A.** Counted in Redis, per deployment:

- 300 requests per 60 s generally;
- 10 *failed* logins per 300 s.

It counts failures, not attempts, so a control room behind one NAT doesn't lock itself out at
shift change.
**If pressed:** S11: the limiter keys on `X-Forwarded-For`, which a caller can set when :8000 is
reachable directly. Fix: trust only the proxy and publish only via nginx.

**Q-SE10. Data protection: DPDP Act 2023? [A]**
**A.** We built the engineering half:

- purpose labels and case references;
- enforced retention, which actually deletes: detections 365 d, crops 90 d, audit 5 y;
- minimisation: non-matching faces are never stored;
- access logging;
- security safeguards.

DPDP §17 exempts processing for preventing, detecting and investigating offences from most
data-principal duties, but not from the duty to protect the data with reasonable safeguards.
**If pressed:** We are engineers, so the state's legal team must sign off the lawful basis,
proportionality (the *Puttaswamy* test), the DPIA and the authorisation rules. That is rollout
gate 3(e) (HLD §17).

**Q-SE11. Has it been pen-tested? [D]**
**A.** No. Our own judge-style review found 11 issues (S1–S11) and we published them. A
third-party penetration test is a gate before statewide rollout (HLD §17, gate 3(c)).

**Q-SE12. Network segmentation? [D]**
**A.** Not on the laptop: one Docker network. Production design in HLD §16.2 has seven zones, from
department camera networks to edge sites, regional nodes, and the DMZ, application and data zones
in the state DC. Nothing listens toward a department's camera network: Contrail always pulls.
**If pressed:** The site-to-centre link carries only outbound events (plus on-demand video pulled
through the DMZ relay), over IPsec or mTLS.

**Q-SE13. What about the supply chain and licences? [D]**
**A.**

- Every image and dependency is pinned.
- Runtime images are torch-free; Ultralytics *code* is used only in a throwaway export image.
- The detector *weights* are AGPL-3.0, and replacing them is an open decision before deployment
  (S9).

**If pressed:** Permissive retraining candidates are listed in research §6.2 (Q-AC12).

**Q-SE14. What did you fix today? [D]**
**A.** Six things:

- The plate-crop bucket was world-readable. It is now private: presigned links 200, unsigned
  object and bucket listing 403, verified live (`b4df4d1`).
- HTTPS on :8443.
- A store-and-forward event spool at the edge.
- Prometheus metrics with alert rules.
- Manual backups verified by restore.
- Shared alert de-duplication.

**If pressed:** The demo is on :8080 because the projector browser is local. Production publishes
only HTTPS.

### 4.8 Scalability (owner: C)

**Q-SC1. Does it scale to 80,000 cameras? [C]**
**A.** The architecture is designed for it and the central ingest is measured at that scale:
**2,774 events/s sustained for 80,000 camera identities, 0 failures, 388,713 rows**, on this
laptop with 3 consumers. The latency target was missed: p95 5.7 s against 3 s. Edge compute
beyond that is arithmetic, which we label as such.
**Show:** `tests/load/results/load-20260905T064430.json`, `latest.md`; HLD §15.1.
**If pressed:** That test is ingest-only, with synthetic events and no inference. Inference
scales by adding edge nodes, which are independent.

**Q-SC2. Why did p95 miss 3 s, and how do you fix it? [C]**
**A.** It was queue wait, not processing: the backlog peaked at 10,237 during the 150 s run and
cleared after the generator stopped. The rate was 2,774 against 2,667 needed, only 4% headroom.
**If pressed:** More consumer replicas, which is a compose flag. Production gate: 2× statewide
(5,334 events/s) with p95 < 3 s (HLD §17, gate 3(a)). Note: `latest.md` says both "no backlog
formed" and "still growing". The second is right.

**Q-SC3. Bandwidth? [C]**
**A.** If all video were centralised: 80,000 × 4 Mbps = **320 Gbps**. We send events only:
2,667 events/s × 2 KB = **43.7 Mbps**, **7,324× less** (ARITHMETIC, `capacity_model.py`). Video
moves only while someone watches, at 4 Mbps per concurrent viewer, released 60 s after the last
one.
**If pressed:** Plate crops would add about 328 Mbps if centralised. The design keeps them at
regional stores and pulls only alert crops (HLD §11).

**Q-SC4. How many servers or GPUs for 80,000 cameras? [C]**
**A.** CPU only, from per-frame costs measured on Apple Silicon in Docker:

- 0.46 core per camera;
- **36,446 cores = 911 forty-core nodes**;
- ₹39.31 crore capex.

GPU at an assumed 4× is 228 nodes (₹19.94 crore); at 10× it is 91 nodes (₹9.69 crore). Both are
**EXTRAPOLATED**: never run, and they need hardware decode we have not built.
**If pressed:** Not every camera needs ANPR. ANPR on a 20% subset (16,000 ANPR-grade cameras) is
**182 nodes, ₹8.36 crore** CPU (ARITHMETIC). The rest stay registry, map and on-demand video.

**Q-SC5. What is the single most important sizing assumption? [C]**
**A.** **0.5 analysed frames per second per camera** (ASSUMED). Halve it and compute halves. It
must be validated against measured junction transit times in the pilot (gate 1(c)). The second is
that all per-core costs are from Apple Silicon, so the first gate re-profiles on the real x86
node.
**Show:** `python3 scripts/capacity_model.py --provenance`.

**Q-SC6. Storage? [C]**
**A.** For 80,000 cameras (ARITHMETIC):

- hot (7 d, NVMe): **3.3 TB**;
- warm (90 d, with crops): **361 TB**, about 320 TB of it crops;
- cold (5 y): **861 TB**.

No central video at all. Model 4 would need **24.2 PB for 7 days, or 51.8 PB for 15**.
**If pressed:** Keeping crops only for alerts and low-confidence reads cuts warm by about 10×
(HLD §12).

**Q-SC7. Edge versus central: what runs where? [C]**
**A.**

- **At the edge site:** decode, detection, tracking, plate reading, consensus, face stage, crop
  storage and the event spool.
- **At the centre:** registry, matching, alerts, routes, analytics, audit and the UI.

The decode moves to where the video already is. It does not disappear.
**Show:** HLD §5.4, §10.

**Q-SC8. How do workers share cameras? [C]**
**A.** By a stable hash of the camera code, modulo the worker count, with no coordinator.
Analysis rotates through the open streams: always-on cameras first, then the one on an
operator's screen, then the least-served. The worker states its coverage ("analysing 3 of 13 …
each for 45 s every 1.1 min").
**Show:** `ai_worker/discovery.py:54`, `rotation.py:149`; worker logs.

**Q-SC9. HA and DR? RPO and RTO? [C, then D]**
**A.** Today: single instances, plus manual backups verified by restore. MEASURED:

- dump 1 s / 10.8 MB;
- 65,263 objects mirrored in 61 s;
- restore 3–5 s, counts matched.

**We claim no RPO or RTO.** The production design targets RPO 15 min and RTO 1 h:

- Patroni with a synchronous standby;
- WAL-G point-in-time recovery;
- MinIO site replication;
- a DR site at 60%.

A target counts only once a timed failover drill passes.
**Show:** HLD §13, §13.1.

**Q-SC10. What if the bus or the WAN goes down? [C]**
**A.** The edge worker spools settled sightings: in memory first (20,000 events / 48 MB), then up
to 1 GB on disk, about 524,000 events or roughly 20 days per worker at the model's rate
(ARITHMETIC). It replays them in order when the bus answers.
**Show:** `ai_worker/publisher.py` (`DiskSpool`); HLD §5.4. MEASURED against a paused-then-stopped
Redis: worst `emit` 1.1 ms; everything replayed in order.
**If pressed:** The hour-long WAN pull test (gate 1(d)) has not been run.

**Q-SC11. Why Redis Streams and not Kafka? [C]**
**A.** One fewer heavy container on a laptop demo, and the same consumer-group semantics: each
event goes to exactly one consumer and is acknowledged after commit. It measured 2,774 events/s.
Production uses Redpanda (Kafka API), 3 brokers, RF=3.
**If pressed:** Honest: only the settings seam (`event_bus_backend`) exists. No Kafka client is
written. About 1–2 days with tests (HLD §22.3).

**Q-SC12. How does it grow district by district? [A]**
**A.** Sites are independent, workers re-shard by hash, and the event tier adds consumer
replicas. The rollout is gated: one district, then one range, then the state. Each stage starts
only when the previous stage's gates have printed their numbers.
**Show:** HLD §17 (gates), §22 (work per stage).

### 4.9 Cost and deployment

**Q-CO1. What does it cost? [C]**
**A.** For 80,000 cameras, CPU only (ARITHMETIC, indicative unit prices):

- capex **₹39.31 crore**, of which ₹36.45 crore is edge compute;
- opex **₹8.78 crore/year** (uplinks ₹0.50, power ₹5.52, staff ₹2.76);
- per camera: ₹4,913 capex and ₹1,097/year.

Cameras are excluded because they already exist.
**Show:** `python3 scripts/capacity_model.py --cameras 80000`.
**If pressed:** These are not quotes. Every unit price is an editable constant with its source
printed.

**Q-CO2. Versus Model 4? [C]**
**A.** At the same unit prices and the same analytics:

| | Capex | Opex | 5-year |
|---|---|---|---|
| Model 4, 7-day video | ₹63.5 crore | ₹56.3 crore/yr (WAN alone ₹48 crore/yr) | ₹344.9 crore |
| Model 4, 15-day video | ₹91.2 crore | ₹56.3 crore/yr | ₹372.6 crore |
| Contrail | ₹39.3 crore | ₹8.8 crore/yr | **₹83.2 crore** |

Disk alone settles it: 15 days of central video storage, ₹51.8 crore, exceeds our entire capex
(HLD §19.2, ARITHMETIC).
**If pressed:** The Model 4 figures are a floor. Its recording servers, storage power and camera
re-pointing are not even priced.

**Q-CO3. What hardware per tier? [C]**
**A.**

- **Edge site** (33 sites of 2,400 cameras): 40-core, 128 GB CPU nodes; GPU optional later.
- **Centre:** a 3-node database cluster and 6 service nodes.
- **Storage:** NVMe hot and bulk warm/cold.
- **DR:** a site at 60% of central.

Footprint: 920 nodes total for 80,000 cameras, CPU (ARITHMETIC).
**If pressed:** Re-measure on the actual x86 node first (gate 1(a)).

**Q-CO4. How would you roll it out? [A]**
**A.** In three stages:

- **Stage 1, one district:** its police, municipal, toll and check-post ANPR-grade cameras first.
- **Stage 2, one range:** regional node, failover drill.
- **Stage 3, the state:** 33 sites.

Each stage has measured gates (HLD §17).
**If pressed:** Q-TM1 for 30/90/180 days.

**Q-CO5. Do departments need to buy anything? [A]**
**A.** No new cameras and no new VMS. Each edge site needs compute next to its video and an
uplink. Their recorders, licences and maintenance contracts stay valid.
**Show:** HLD §19.4.

**Q-CO6. What is the benefit, not just the cost? [A]**
**A.** One audited query instead of asking each department for footage and reviewing it by hand.
Every result shows its evidence. Alarms reached a connected screen in 24 ms (MEASURED), and a
dead camera is noticed in 19 s (MEASURED).
**If pressed:** We have **not** measured the manual baseline or the investigator-hours saved.
That is a pilot measurement (HLD §19.6, §22.2).

**Q-CO7. Cloud or on-premises? [C]**
**A.** On-premises by design: state DC plus edge sites, offline-capable, no paid APIs, no cloud
dependency. Everything is containerised with pinned images.
**If pressed:** Kubernetes is not built (Compose only). The plan is Helm at the DC and k3s at the
sites, with the same images (HLD §22.3).

### 4.10 Operations

**Q-OP1. How do you know a camera is down? [D]**
**A.** The ingest container probes every camera through its adapter (RTSP with `ffprobe`, ONVIF,
the VMS API or the gateway API) and writes a `camera_health` hypertable. A stream killed on
purpose was marked offline and alerted in **19 s** against a 30 s budget (MEASURED). Today's
rehearsal camera raised `camera_down` within about 30 s, with the probe's own error text.
**Show:** `/health` (Fleet health); `services/health_monitor.py`.
**If pressed:** For the grid we were probing their catalogue login, not each camera, which caused
flapping. Being fixed now: debounced status and one standing integration alarm, using the
workers' frame evidence as liveness.

**Q-OP2. How do you monitor the platform itself? [D]**
**A.**

- `/health` and `/ready`, where Postgres and Redis are critical and the others degrade.
- `/metrics` (JSON) and `/metrics/prometheus`: per-route latency, ingest counts, consumer lag,
  alerts, seconds since each always-on camera read a plate, and edge worker CPU, threads, RSS
  and spool.
- Prometheus and Grafana, with unit-tested alert rules.

**Show:** `http://localhost:9090/alerts`, `http://localhost:3000` (loopback only).
**If pressed:** No Alertmanager paging, and no node, Postgres or Redis exporters yet (HLD §14).

**Q-OP3. Coverage gaps? [D]**
**A.** Fleet health computes gaps (offline windows, unreliable cameras, uncovered zones) and
exports a gap report CSV (`GET /api/v1/reports/gaps.csv`, audited).
**If pressed:** Uncovered zones are still computed against 7 Ahmedabad talukas, not Gujarat's 33
districts (being fixed now). No "ageing infrastructure" bucket from the install date yet.

**Q-OP4. Maintenance of the AI models? [C]**
**A.**

- Models are files with SHA-256 pins, fetched by a script.
- The worker bind-mounts them, so a model swap is a file change plus a planned worker restart.
- Every configuration change is measured in `ai-lab` against labelled crops before it ships.
  That is how the raw-crop change was chosen.

**If pressed:** Each grid restart re-logs every always-on grid camera, so restarts are batched.

**Q-OP5. What happens when an AI worker crashes? [C]**
**A.** Its cameras show as unclaimed, not silently missing, and the other workers keep theirs. On
restart (compose `restart: unless-stopped`) it reclaims its hash shard and replays its disk spool.
**If pressed:** Automatic re-sharding across surviving workers (N−1) is not built. Shards are
fixed by `AI_WORKER_COUNT`.

**Q-OP6. How many operators can use it at once? [B]**
**A.** The API is stateless and scales by replica. The live feed is a WebSocket per client fed by
each replica's own tailer. A k6 script exercises operators while ingest runs (`tests/load/k6/api_load.js`, `make load-operators`); its results are not in the evidence pack, so quote no operator-concurrency figure.
**If pressed:** Video is the real limit: about 4 Mbps per concurrent viewer, on demand.

### 4.11 Data, retention and government systems

**Q-DA1. How long do you keep data? [D]**
**A.** Enforced daily (actual deletion, not a policy note):

- detections 365 days;
- camera health 90;
- plate crops 90;
- audit log 5 years, deliberately outliving what it describes.

A crop that an open alert points at is kept until the alert is closed. Persons media: 90 days
after retirement.
**Show:** `docs/SECURITY.md` §4; `services/retention.py`.

**Q-DA2. Can we export the data? [B]**
**A.** CSV exports, all audited:

- plate reads for a window;
- per-vehicle route;
- the gap report;
- the audit log.

Plus a printable route report (save as PDF), and a full OpenAPI at `/docs`.
**If pressed:** No registry (camera list) export yet. Excel is not built. CSV opens in Excel.

**Q-DA3. Do you integrate with VAHAN, SARTHI, eGujCop/CCTNS and AFIS? [A]**
**A.** We built the integration *interface* and show it with a clearly labelled **fictional
reference dataset**: 330 registrations, 146 licences, 20 FIRs, 9 AFIS records. Every answer is
stamped `source: reference` with provenance text, and every lookup is audited. A live connector
is one class plus one line in `registries_for`, and it needs the state's access and an MoU with
NIC/NCRB.
**Show:** `/registries?plate=GJ03AB1234`; `services/api/app/adapters/registries/`.
**If pressed:** The card checks the registration against what the camera saw. Only coarse
mismatches can be flagged, such as two-wheeler versus four-wheeler or bus versus car, because the
detector's classes are coarse.

**Q-DA4. Does AFIS mean you store fingerprints? [D]**
**A.** No. The AFIS record type has no field that could carry biometric data, in the code or the
table. It returns case and reference metadata only.

**Q-DA5. Where is the data physically? [C]**
**A.**

- **Video:** in the departments' own recorders.
- **Events, alerts, audit:** at the state DC (Postgres/Timescale).
- **Crops:** at regional object stores in the design; one MinIO today.

Nothing goes to a cloud.

**Q-DA6. Interoperability: what format are events in? [C]**
**A.** JSON, about 2 KB per vehicle, schema-tagged `ailab.vehicle.event.v1`: plate, confidence,
runners-up, every read, boxes, capture time, latency and the crop's object key.
**If pressed:** Honest: the schema is hand-written in `ailab/stream/events.py` and duplicated in
the load generator. JSON Schema contracts in `packages/contracts` are planned (HLD §22.1).

**Q-DA7. Search: how fast at state volume? [C]**
**A.** Plate search uses PostgreSQL `pg_trgm` similarity, so fuzzy "close to what you typed"
works. It answers in under a second on this data.
**If pressed:** Not measured at billions of reads. OpenSearch runs but indexes nothing. It is the
planned path if `pg_trgm` misses its latency target in the pilot (HLD §22.3).

### 4.12 Code, architecture and engineering

**Q-CD1. What is the stack, and why? [D]**
**A.** FastAPI on Python 3.11, async. PostgreSQL 16 with PostGIS and TimescaleDB, Redis Streams,
MinIO, MediaMTX, ONNX Runtime with OpenCV, and React, Vite and MapLibre. All open source, all
on-premises, all pinned.
**Show:** §6.3 table.

**Q-CD2. How big is the codebase? [D]**
**A.** About 45,000 lines of Python application code and 32,000 lines of TypeScript, excluding
tests:

| Area | Lines |
|---|---|
| API | 26.8k |
| ai-lab | 13.2k |
| Worker | 3.2k |
| Simulator | 1.5k |
| Web | 32.1k |

The API has 77 paths and 87 operations, and 10 Alembic migrations.
**If pressed:** Raw `wc -l`, including comments and docstrings, which are substantial.

**Q-CD3. How is it tested? [D]**
**A.**

- About **1,175 Python test functions**: API 704, ai-lab 267, worker 144, simulator 22, e2e 38.
  Parametrised cases run more; the API suite reported 820 passed on 12 Oct.
- About **400 web tests** (vitest).
- **14 browser end-to-end steps** (Playwright), all passing today.
- k6 load scripts.
- mypy and `tsc` at zero errors, enforced by `make lint` and CI.

**Show:** `.github/workflows/ci.yml`, with 5 jobs: compose validation, API lint, API tests
against real Timescale and Redis, ANPR lint and tests, web build and tests.
**If pressed:** CI does not run e2e, browser or load tests. Those need the full stack and are run
locally.

**Q-CD4. Why FastAPI and Python? [D]**
**A.** The AI ecosystem (ONNX Runtime, OpenCV) is Python, and async FastAPI with SQLAlchemy 2
holds thousands of events/s (measured) with typed Pydantic schemas and OpenAPI for free.

**Q-CD5. Why Postgres + PostGIS + TimescaleDB instead of separate stores? [D]**
**A.** One database gives us:

- spatial queries: nearby cameras, district point-in-polygon;
- time-series hypertables with chunk-drop retention for detections and health;
- trigram fuzzy search.

All transactional with the alerts they raise. Detections, the watchlist match and the alert are
written in one transaction.

**Q-CD6. Why MediaMTX and ONNX Runtime? [D]**
**A.**

- **MediaMTX:** one small binary that pulls RTSP on demand and serves WebRTC (WHEP) and LL-HLS to
  browsers.
- **ONNX Runtime:** runs the same model on CPU, CUDA or CoreML with no PyTorch, so the worker
  image is about 400 MB instead of about 2.5 GB, and no AGPL *code* ships.

**Q-CD7. How do I add a new camera vendor? [D]**
**A.** Four steps:

1. Subclass `CameraAdapter`, or `VendorVmsAdapter` with its paths overridden.
2. Implement `probe_health` and `get_stream_url`.
3. Add the type to `AdapterType`.
4. Add one line to `_ADAPTERS`.

No migration: `adapter_type` is a string. Unknown types fall back to RTSP rather than vanishing.
**Show:** `services/api/app/adapters/base.py:152-226`, `adapters/__init__.py:33-72`.

**Q-CD8. How do you keep the CPU from melting with many cameras? [C]**
**A.** `ailab.runtime` divides one process-wide thread budget across the cameras' ONNX sessions.
Before it existed, the default thread pools multiplied by cameras: **168 threads, 866% CPU**
measured. Decode uses one thread per stream, and frames that will not be analysed are never
converted.
**Show:** `ai-lab/ailab/runtime.py:95-124`; `docs/PERFORMANCE.md`.

**Q-CD9. Is there a GPU path? [C]**
**A.** Wired (`device: auto|cpu|cuda|coreml`), never measured on CUDA. Docker on Apple Silicon has
no GPU at all. A native CoreML worker was measured:

- 0.107 core-s per analysed frame, against 0.44 in Docker;
- capture-to-event p50 25 ms.

We did **not** switch to it, because it misread two plates the Docker worker reads.
**Show:** `docs/GPU.md`; `make worker-native` (opt-in).

**Q-CD10. Show us code you're proud of. [D]**
**A.** Pick from §6.6. Lead with consensus (accuracy) or the event consumer (correctness), then
the adapter seam (extensibility).

### 4.13 Team and roadmap

**Q-TM1. What will you do in the next 30, 90 and 180 days? [A]**
**A.**

- **30 days, code only:** close S2–S11; department-scoped RBAC; registry metadata, Excel import
  and export; district-level gap analysis; reasons on watchlist alerts; a two-person-labelled
  accuracy set of at least 400 vehicles; the AGPL decision; event contracts; federated playback.
- **90 days, one-district pilot:** re-profile on x86; validate the 0.5 fps assumption; an hour's
  WAN pull with zero loss; p95 < 3 s; TLS and encrypted volumes; scheduled off-site backups;
  measure time-to-locate against the manual baseline; the first live multi-camera journeys.
- **180 days, one range:** Redpanda; Patroni and point-in-time recovery; regional crop stores;
  one GPU node measured against CPU; crowd counting; Kubernetes.

**Show:** HLD §22.

**Q-TM2. What would you need from the police? [A]**
**A.**

- One district's camera list with coordinates and owners.
- RTSP or VMS API access at one edge site.
- A rack slot for one x86 node.
- Two people for a week to label 400 vehicles.
- An MoU path for VAHAN and eGujCop.
- Legal sign-off on watchlist authorisation.

**Q-TM3. Who built what? [A]**
**A.** Each presenter names their own part in one sentence. Keep it factual.

**Q-TM4. What was the hardest problem? [C or D]**
**A.** Pick one and tell it with its numbers:

- **The grid:** two authentication systems, a watch quota and lock-outs. Solved with a host-wide
  back-off and an authenticated proxy.
- **CPU:** 168 threads, 866%. Solved with one shared thread budget.
- **Accuracy:** CLAHE was costing 25 points.

### 4.14 Tough and curveball questions

**Q-CV1. Why not Model 4? Isn't central simpler? [A]**
**A.**

- **Bandwidth:** central video is 320 Gbps against our 43.7 Mbps.
- **Storage:** 24–52 PB of new central disk.
- **Decode:** 10,000–14,000 cores just to decode at the centre.

Every department's VMS would be replaced. And when a district link fails, its cameras vanish
from the centre. In ours they keep recording locally, and our edge spools events.
**If pressed:** *"Inference costs the same wherever it runs. Model 4 has to move the video; we
move the conclusions."*

**Q-CV2. What if the network to a district fails? [C]**
**A.** The district keeps recording in its own VMS and our edge worker keeps analysing and
spooling (1 GB on disk, about 524,000 events per worker). Its cameras show as unreachable on the
map, never silently missing. On reconnect, events replay in order.
**If pressed:** The hour-long pull test is gate 1(d), not yet run.

**Q-CV3. What if a camera is tampered with: covered, turned or defocused? [D]**
**A.** Today we detect "no stream", via health probes and `camera_down` in about 19 s, and
"no plates for 10 min on an always-on camera", via a Prometheus rule. We do **not** detect a
covered, turned or blurred camera that still streams.
**If pressed:** Planned at the edge: frame statistics (blur/variance, brightness) and scene drift
against a reference frame, raised as a `camera_tamper` alarm. About 1–2 days, including
measurement.

**Q-CV4. What if two vehicles share a plate (a cloned plate)? [C]**
**A.** The correlator flags it:

- `impossible_simultaneous` when the same plate is at two distant cameras at once;
- `implausible_speed` when the hop is faster than any vehicle could manage;

and the anomaly engine raises a "Journey to explain" with those reasons. The registry check flags
when the seen vehicle's class does not match its registration.
**If pressed:** With colour attributes and live VAHAN data, the mismatch check becomes far
stronger. Today colour has no producer, and the registry data is reference only.

**Q-CV5. What stops misuse by an insider, say a senior officer stalking someone? [D]**
**A.** Every vehicle search is audited with the plate, the window and the user. The audit is
readable by a separate auditor role that cannot itself search, and reading it is audited too.
Watchlist entries need a case reference, and person entries need four eyes and expire.
**If pressed:** Two gaps:

- a DB admin could still rewrite the audit table today; hash-chain plus WORM export is planned
  (S8);
- department scoping is not yet built.

**Q-CV6. How do you handle a judge's own RTSP feed? [D]**
**A.** §2.7. We paste it in the form and it's live in under a minute. With a password, we use the
relay in recipe B. The device must be reachable from this laptop; venue Wi-Fi often isolates
clients, so we use a hotspot.

**Q-CV7. What is mocked? [A]**
**A.** No pipeline stage is mocked. What is **not real-world** is stated on screen:

- the recorded clips (CAM-DEMO-01 UK road, CAM-DEMO-02 stock persons);
- the fictional watchlist (`DEMO/…`);
- the VAHAN, SARTHI, eGujCop and AFIS reference data;
- the synthetic events in the 80,000-identity load test (no inference);
- every GPU number (extrapolated).

**If pressed:** Also not wired: the Kafka driver, OpenSearch indexing and federated playback.
They are design seams, and we call them that.

**Q-CV8. Your accuracy is below 90%. Why should we trust any alert? [C]**
**A.** Because the system never pretends:

- a near match is labelled and capped at medium;
- the crop is on the alarm for a human to compare;
- 92% of committed reads were right on our set, and only 2 of 31 unreadable crops produced a
  claimed plate.

An alert is a lead with its evidence, not a verdict.
**If pressed:** Plus corroboration by a second reader, which gave 39/39 when both agreed
(research #3, planned).

**Q-CV9. Why should we believe your scale numbers? [C]**
**A.** Because we label every one. The 2,774 events/s is measured, and the run file is in the
repo, including the target we missed. The bandwidth and node counts are arithmetic from inputs
printed with their sources. The GPU numbers are extrapolated, and we say so.
**Show:** `capacity_model.py --provenance`.

**Q-CV10. What if the organisers' grid is down during the judging? [B]**
**A.** We switch to CAM-DEMO-01 and the camera we onboard live. The grid being unreachable is
shown as a problem, not an absence, and the workers back off politely.

**Q-CV11. Isn't this just an ANPR system? [A]**
**A.** No. ANPR is one capability. The product is the layer around it:

- the statewide registry and map of every department's cameras;
- federation without replacing anything;
- matching, alarms and audit;
- routes with flagged legs, candidates and pursuit;
- persons with four-eyes;
- registry readiness;
- traffic insight.

**Q-CV12. A judge asks for something not built: "Show crowd counting." [A]**
**A.** *"Not built. The same edge detector already sees people, so person-class counts per
camera, published as an event like vehicles, are the cheap first step. It's in our 90–180-day
plan."* Do not improvise a demo.

**Q-CV13. What happens at 3 a.m. when nobody watches the screen? [B]**
**A.** Alarms persist in the queue with their state and timestamps, and stay open until a person
acts. Paging (SMS, wireless, CAD) is not built. The alarm API is the integration point.

**Q-CV14. Can I see the raw database? [D]**
**A.** Yes: `docker compose exec -T postgres psql -U nagarnetra -d nagarnetra` (read-only
queries). The database is still named `nagarnetra`, a residue of the codebase's earlier name.
Say so if they notice.

---

## 5. What we lack, and how we'll tackle it

Say the gaps before the jury finds them. The "say it like this" column is phrased for the room.
Estimates are engineering time for one person who knows the code.

| # | Gap | Impact | Workaround today | Fix and estimate | Say it like this |
|---|---|---|---|---|---|
| 1 | **No plate read at two cameras in the live DB** (`/vehicles/routable` empty since 1 Sep) | The scored "track a vehicle" step has no live journey to show | Show single-camera history, candidates and pursuit. Optionally two honest test feeds (§2.3 box) | The pilot with ANPR-grade cameras. Meanwhile keep SBX-cam10/21/22 always-on and grid positions corrected (being fixed now) | *"The engine is built and tested; our live data hasn't yet caught one plate at two cameras, because the grid refused us since 9 and night yield on overview cameras is low. We won't stage it."* |
| 2 | **Grid refusing our login; fleet health flapping** ("Feeds answering 2/32") | Red tiles; `camera_down` noise | Demo on CAM-DEMO-01 and the live-onboarded camera | Debounce plus one standing integration alarm, worker frames as liveness (being fixed now, about 1–1.5 h) | *"The organisers' grid rate-limits after reconnects; we back off rather than hammer it, and our health screen is being changed to judge cameras by frames, not the catalogue login."* |
| 3 | **Camera positions town-level; 6 unplaced; 27/32 without department** | Distances, speeds and pursuit degrade; "different departments" looks thin | The map lists unplaced cameras apart | Hand-geocode to junctions with a `placement:approx` tag; set evident owners (being fixed now, about 1–1.5 h) | *"The grid's catalogue gives a name, not coordinates or an owner, and we refuse to guess an owner."* |
| 4 | **A camera with a password cannot be pasted in the form** | A judge's NVR URL is refused | Relay container (§2.7 recipe B), tested | Gateway resolves the VMS `credentials_ref` (or a sealed `enc://` per camera) at path registration; form field for credentials. About 1–2 h API, plus 1 h UI | *"Passwords never go in the registry; a secret store holds them. For your camera today, a relay holds it."* |
| 5 | **"Recorded video" onboarding doesn't start playback by itself** | A USB clip needs one extra command | `curl -X POST localhost:9100/streams/<CODE>/start` (§2.7 recipe C) | The simulator re-reads the registry periodically, or the API calls start on create. About 1 h | Only if asked |
| 6 | **New camera takes 30–50 s to reach a worker** | Dead air if you open Live too soon | Onboard, talk 40 s, then open Live | Publish the roster on camera create and let focus claim an unowned camera. About 0.5–1 h | *"The AI fleet picks up new cameras on its next pass, about half a minute."* |
| 7 | **No accuracy claim; >90% not met on evidence** | The brief's accuracy bar | Quote measured numbers with their labels (Q-AC1) | A two-person, human-labelled ≥400-vehicle set (gate 1(b)); second-reader corroboration (research #3, about 1 day) | *"83–87% on legible night crops, AI-labelled; we claim no system figure until two people label 400 vehicles."* |
| 8 | **Two-wheelers about 0%; night yield 11–20%** on overview cameras | ANPR coverage | ANPR on ANPR-grade cameras only (20% subset sizing) | Camera selection and placement; two-row reader; more looks per vehicle | *"No reader fixes a plate that is 30 px wide at night; ANPR belongs on ANPR cameras."* |
| 9 | **Network exposure (S2): Postgres, Redis without password, MinIO, OpenSearch, MediaMTX API on all interfaces** | Someone on the same LAN could inject alarms | Present from the host. Block inbound with the macOS firewall | Bind to 127.0.0.1, Redis `requirepass`, OpenSearch security on. About 0.5 h plus a restart | *"It's a single-laptop prototype; our HLD lists every exposed port and its production zone."* |
| 10 | **S11 `X-Forwarded-For` trusted; S3 own streams without token; S5 shared demo passwords; S7 root-signed URLs; S8 audit not tamper-evident; WebSocket not role-filtered** | Security posture | — | S11 0.5 h; S3 1.5 h; S5 SSO/MFA in production; S7 0.5 h; S8 about 1 day; WebSocket role check about 1 h | *"Our own review found eleven; here's each with its fix."* (HLD §16.7) |
| 11 | **TLS only at the web tier (:8443); no encryption at rest** | Data in transit and at rest | HTTPS on :8443 | TLS everywhere plus IPsec on site links; LUKS plus MinIO SSE-KMS. Deployment work, stage 1 gate 1(f) | *"HTTPS is on for the UI; volume encryption and TLS between services are pilot gates."* |
| 12 | **No HA/DR; backups manual (verified by restore)** | Any RPO/RTO claim | `make backup` + `make backup-verify` | Patroni, WAL-G, MinIO replication, DR site; timed drill (gate 2(b)) | *"We claim no RPO or RTO until a timed failover drill prints them."* |
| 13 | **Ingest p95 5.7 s against a 3 s target** at statewide synthetic load | Alert latency under backlog | — | More consumer replicas; gate at 2× statewide with p95 < 3 s | *"We missed our own target and published it; it was queue wait, fixed by replicas."* |
| 14 | **Kafka/Redpanda driver not written; OpenSearch unused; `packages/contracts` empty** | Production bus; schema discipline | Redis Streams (measured) | Redpanda driver about 1–2 days; JSON Schema contracts about 0.5 day | *"Seams, not features; we name them as seams."* |
| 15 | **Registry metadata thin; no Excel import; no registry export** | Model 1 completeness | CSV | Migration plus form plus export, about 2–3 h; `.xlsx` about 1 h | *"Storage, NVR, power, link and AMC fields are next."* |
| 16 | **No department-scoped RBAC; no department API** | Every role sees every department | — | About 2–3 h plus department CRUD about 1 h | *"Designed as access classes in HLD §20; not enforced yet."* |
| 17 | **Gap analysis uses 7 Ahmedabad talukas, not 33 districts; no ageing bucket** | Wrong geography in the gap report | — | Point-in-polygon on `gujarat_districts.geojson` (being fixed now, about 1 h) | — |
| 18 | **Insights dominated by the looping clip** (CAM-DEMO-01 52,297 of 56,050 vehicles) | Congestion looks fake | Say it | Exclude `recorded-footage` from analytics by default (being fixed now) | *"That's the recorded clip; Insights is being changed to exclude recordings, as the anomaly engine already does."* |
| 19 | **Watchlist alerts lack structured `reasons`; some reads lack a crop (28/200); person-match repeats** | Alert quality | Filter the queue to Watchlist | Reasons about 1 h; person dedupe per entry and camera about 30 min | — |
| 20 | **No federated playback; no video wall** | Model 2/4 completeness | Recordings stay in the department's VMS | `GET /cameras/{id}/recording` about 1–1.5 h; wall from regional sub-stream relays (design) | *"Playback belongs to the department's VMS; the adapter method exists, the route doesn't yet."* |
| 21 | **Not built: crowd counting, vehicle colour, appearance re-ID, camera tamper detection, paging (SMS/CAD)** | Analytics breadth | — | Person counts from the existing detector about 1 day; colour about 1–2 days; tamper about 1–2 days; paging via Alertmanager or a webhook subscriber about 1 day | *"Same edge detector, next events."* |
| 22 | **GPU never measured; AGPL-3.0 detector weights** | Sizing confidence; licence | CPU path measured; native CoreML measured, opt-in | One GPU node with NVDEC (gate 2(d)); retrain on a permissive detector (research §6.2) | *"Every GPU number is extrapolated; the weights' licence is an open decision we've flagged."* |
| 23 | **ONVIF without WS-Security; vendor adapters on fixtures only** | Live device integration | RTSP URI from the device | UsernameToken about 2–3 h; a live VMS in the pilot | — |
| 24 | **Kubernetes not built** (Compose only) | Operability at 33 sites | — | Helm at the DC, k3s at sites (HLD §22.3) | — |
| 25 | **"NagarNetra" residue** in `/docs` title, `GET /`, DB/bucket/Redis names | Looks unfinished | — | API title and root banner (being fixed now); internal names harmless | *"The codebase's earlier name; the identifiers are internal."* |

---

## 6. Architecture and code tour

### 6.1 The architecture as it runs

```mermaid
flowchart LR
  subgraph SRC["Video sources (department-owned)"]
    grid["Organisers' grid<br/>30 SBX cameras<br/>RTSP/WHEP + CDN HLS"]
    cam["Any RTSP / ONVIF camera<br/>or vendor VMS"]
    sim["Simulator<br/>recorded clips<br/>CAM-DEMO-01/02"]
  end
  subgraph EDGE["Edge (3 AI workers; logical edge on this laptop)"]
    w["ai-worker x3<br/>hash shard, rotation, focus<br/>YOLOv8n > ByteTrack > YOLO11n plate<br/>> PP-OCRv4 > consensus<br/>faces: YuNet + SFace (tagged cams)"]
    spool["Event spool<br/>memory + disk"]
  end
  gw["MediaMTX gateway<br/>pull on demand<br/>WebRTC/WHEP + LL-HLS"]
  bus["Redis Stream<br/>nagarnetra:events:detections<br/>~2 KB per vehicle"]
  s3["MinIO (private)<br/>plate crops, faces"]
  subgraph CENTRE["Central tier: events, not video"]
    api["FastAPI<br/>EventConsumer (group, once)<br/>watchlist match, alerts<br/>correlator, anomaly, analytics<br/>registry, RBAC, audit"]
    ingest["ingest container<br/>health monitor via adapters"]
    db["PostgreSQL 16<br/>PostGIS + TimescaleDB + pg_trgm"]
    roster["Redis: fleet roster,<br/>focus, alert fan-out"]
  end
  web["Web: nginx + React<br/>:8080 / HTTPS :8443<br/>/ws/events"]
  mon["Prometheus + Grafana<br/>loopback only"]

  cam -->|RTSP pull| gw
  sim -->|RTSP publish| gw
  gw -->|RTSP| w
  grid -->|RTSP direct| w
  w --> spool -->|XADD| bus
  w -->|crop upload| s3
  bus -->|XREADGROUP| api
  api --> db
  api -->|pub/sub + tailer| web
  api -->|roster every 30 s| roster
  roster -->|discovery 20 s, focus 2 s| w
  ingest -->|probe| gw
  ingest -->|catalogue| grid
  ingest --> db
  gw -->|on demand, while watched| web
  grid -->|HLS via authenticated proxy| api
  api --> s3
  mon -.->|scrape| api
```

The organising rule: **the central tier carries events, not video** (HLD §1). Video goes to a
browser only while someone watches. The AI reads it next to the source.

### 6.2 A plate read, end to end, with measured latencies

| # | Step | Where in code | Measured |
|---|---|---|---|
| 1 | Camera registered: MediaMTX path `<code>` pulls `stream_url` on demand, released 60 s after the last reader | `routers/cameras.py:397` → `services/gateway.py:59` | Path exists 0.1 s after onboarding (rehearsal) |
| 2 | API publishes the AI roster to Redis every 30 s; each worker rediscovers every 20 s; ownership = `blake2b(code) mod N` | `services/fleet_roster.py:142,165`; `ai_worker/discovery.py:54,299` | New camera in roster +18 s; worker opened it +32 s (rehearsal) |
| 3 | Operator opens Live → focus heartbeat every 15 s → `ZADD nagarnetra:focus` (TTL 45 s) → worker polls every 2 s and analyses it first | `hooks/useCameraFocus.ts:22` → `routers/streams.py:151` → `services/focus.py:53` → `ai_worker/worker.py:279`, `rotation.py:149` | Analysing about 3 s after opening, for an owned camera (BUILD_STATE 11 Oct); about 5 s (rehearsal, recipe C) |
| 4 | Per frame: drop-to-latest reader → YOLOv8n vehicles → ByteTrack → plate search (YOLO11n, scheduled) → PP-OCRv4 on the raw crop | `ailab/stream/reader.py`; `ailab/stream/runner.py:330-377`; `ailab/pipeline.py:400,563` | 0.30–0.80 core-s per analysed 1080p frame in Docker; 0.44 with the fixes; 0.107 native CoreML (research §2) |
| 5 | Track retires → multi-frame consensus → one `vehicle.completed` event (`ailab.vehicle.event.v1`) | `runner.py:789`; `aggregate/consensus.py:34`; `stream/events.py:390` | Capture → event p50 **241 ms** (330 before the 12 Oct fixes) |
| 6 | Crop key returned at once; upload on a bounded background queue to the private bucket | `ai_worker/crops.py:96,132` | — |
| 7 | `XADD` through the spool (memory → disk if Redis is away; replayed in order) | `ai_worker/publisher.py:456,476` | Worst `emit` 1.1 ms with the bus hung (HLD §5.4) |
| 8 | `XREADGROUP` (group `nagarnetra-api`) → batch → one transaction: detections + watchlist match + alert → commit → `XACK` | `services/event_consumer.py:234,256,443,474,477`; `services/watchlist.py:164`; `services/alerts.py:361` | Ingest p50 5.5 ms, p95 44.5 ms, 0 failed (live `/metrics`, 12 Oct). At statewide synthetic load: p95 5.7 s (queue wait) |
| 9 | After commit: alert → Redis pub/sub; every replica's `EventTailer` also streams every read | `alert_fanout.publish`; `services/event_tailer.py:52` | — |
| 10 | `/ws/events` → browser with a 300 s presigned crop URL → Command strip, alarm dock, top-bar count, Live overlay and Reads rail | `routers/events.py:63,88`; `hooks/useEventStream.tsx:73`; `pages/Dashboard.tsx`, `pages/LiveAnpr.tsx` | Detection → connected screen **24 ms**; capture → browser p50 **135 ms** / p99 345 ms (recorded camera, Sep) |

**Faces (tagged cameras only):** `FaceStage` (`ailab/face/stage.py:126`) emits `person.match` →
`event_consumer._raise_person_matches` (`:505`) → `services/persons.py:356` raises an alert with
reasons. The raw event never fans out to browsers.

### 6.3 Tech stack, and why each

| Layer | Choice (pinned) | Why this, here |
|---|---|---|
| API | FastAPI 0.115.6, Python 3.11, SQLAlchemy 2.0.36 async, Pydantic 2.10, Alembic (10 migrations) | Same language as the AI stack; async I/O for the bus and DB; OpenAPI at `/docs` for free |
| Database | `timescale/timescaledb-ha:pg16.14-ts2.29.2-all` (PostgreSQL 16, PostGIS, TimescaleDB, pg_trgm) | Spatial + time-series + fuzzy search in one transactional store; arm64 image (the `postgis/postgis` image is amd64-only) |
| Bus | Redis 7.4.11 Streams, consumer group | Exactly-once-per-group semantics, light enough for a laptop; Redpanda behind the same seam for production (driver not written) |
| Objects | MinIO (S3 API), private buckets, presigned links | S3-compatible on-premises; regional stores in production |
| Video gateway | MediaMTX 1.20.1 | One binary: RTSP pull on demand, WebRTC (WHEP) and LL-HLS out |
| Search | `pg_trgm` today; OpenSearch 2.19.6 running, unused | Enough for the PoC; OpenSearch kept for state volume if needed |
| AI runtime | ONNX Runtime 1.29.0 + OpenCV 4.11, RapidOCR 1.4.4; no PyTorch | ~400 MB image instead of ~2.5 GB; CPU/CUDA/CoreML from one model file; no AGPL code shipped |
| Models | YOLOv8n @640 (vehicles), YOLO11n @320 (plates), PP-OCRv4 rec, ByteTrack (NumPy), YuNet + SFace | Nano models for CPU at the edge; choices measured in `docs/research/ANPR_ACCURACY_LATENCY.md` |
| Web | React 18.3.1, Vite 6, TypeScript 5.7, Tailwind 3.4, MapLibre GL 4.7.1, Recharts 2.15 | Offline map from committed GeoJSON (no tile server, no key); bundled fonts |
| Auth | JWT (pyjwt), argon2id, RBAC matrix, Redis revocation | Standard, testable, no external IdP needed for a pilot; SSO/MFA planned |
| Monitoring | Prometheus v3.5.0, Grafana 12.1.1 (loopback) | Standard ops tooling; unit-tested alert rules |
| Orchestration | Docker Compose profiles (`ai`, `ai-multi`, `monitoring`, scale overlay); Makefile | One-laptop demo; Helm/k3s for production (not built) |

### 6.4 Repository map

| Path | What lives there |
|---|---|
| `services/api/app/routers/` | The HTTP surface: 21 routers (cameras + CSV, streams/focus, events WS, detections, vehicles, alerts, watchlist, persons, analytics, predictions, pursuits, reid, reports, gap report, fleet, registries, grid media proxy, users, audit, auth, health) |
| `services/api/app/services/` | Domain logic: `event_consumer`, `event_tailer`, `watchlist`, `alerts`, `correlator`, `anomaly`, `route_history`, `traffic`, `candidates`, `pursuit`, `reid`, `gateway`, `fleet_roster`, `focus`, `health_monitor`, `persons`, `evidence`, `secrets`, `retention`, `metrics` |
| `services/api/app/adapters/` | `base.py` (`CameraAdapter`), `rtsp.py`, `onvif.py`, `vendor.py`, `sandbox.py` (hosted grid), `simulated.py`; `registries/` (VAHAN, SARTHI, eGujCop, AFIS interface plus reference implementation) |
| `services/api/app/core/` | `config` (one Settings object), `security` (JWT, argon2), `rbac`, `ratelimit`, `crypto` (AES-256-GCM), `password_policy`, `urls` (credential redaction), `public_origin` |
| `services/api/app/middleware/` | `audit.py`, `metrics.py` |
| `services/api/alembic/versions/` | Migrations `0001`–`0010` |
| `services/ai-worker/ai_worker/` | `worker.py` (supervisor, one thread per camera), `discovery.py`, `rotation.py`, `publisher.py` (spool), `crops.py`, `backoff.py`, `gallery.py`, `face_pool.py` |
| `ai-lab/ailab/` | The vision pipeline *and* its evaluation harness: `detect/`, `track/`, `plate/`, `ocr/`, `aggregate/` (consensus, grammar), `stream/` (reader, runner, events), `face/`, `runtime.py`, `evaluate/` |
| `services/simulator/simulator/` | Clip publisher (control API :9100), `load_mode.py` (80,000-identity event generator) |
| `web/src/` | `pages/` (16 screens), `components/` (CommandMap, AnprOverlay, LivePlateFeed, RouteMap, PursuitPanel…), `hooks/` (useEventStream, useCameraFocus), `lib/` |
| `infra/` | `mediamtx/`, `prometheus/` (+ rules and rule tests), `grafana/`, `postgres/init`, `tls/` |
| `scripts/` | `seed.py`, `sync_sandbox.py`, `capacity_model.py`, `backup.sh`, `demo_up.sh`, fetchers |
| `tests/` | `e2e/`, `browser/` (Playwright flows, screenshots), `load/` (run_load_test.py, k6, results) |
| `docs/` | HLD, INFRASTRUCTURE, SECURITY, REQUIREMENTS, DEMO_SCRIPT, PANIC, PERFORMANCE, GPU, research, review, submission |

### 6.5 Test, lint and CI discipline

| | Count (12 Oct) | Source |
|---|---|---|
| API tests | 704 test functions, 41 files (820 passed / 16 skipped reported on 12 Oct, parametrised) | `services/api/tests`; BUILD_STATE |
| ai-lab tests | 267 functions (301 passed in the worker image) | `ai-lab/tests` |
| AI worker | 144 functions | `services/ai-worker/tests` |
| Simulator | 22 | `services/simulator/tests` |
| End-to-end (API) | 38 | `tests/e2e` |
| Web (vitest) | about 404 tests, 41 files | `web/src` |
| Browser flows (Playwright) | 14 steps; 13/13 run today, 0 console errors | `tests/browser/flows.mjs` |
| Load | k6 operators script; 80,000-identity ingest harness with teardown | `tests/load/` |
| Type checks | mypy zero errors on API, simulator, ai-lab and worker; `tsc --noEmit` clean | `make lint` |
| CI | 5 jobs on every push/PR: compose validation, API lint, API tests on real Timescale + Redis, ANPR lint + tests, web typecheck + tests + build | `.github/workflows/ci.yml` |

What CI does not run: e2e, browser flows and load tests. They need the full stack.

### 6.6 Five files to show if asked "show us the code"

| # | File | What it demonstrates | Open at |
|---|---|---|---|
| 1 | `ai-lab/ailab/aggregate/consensus.py` (with `grammar.py`) | How a plate is decided: per-character voting weighted by OCR confidence × crop quality, confusable-character ambiguity flagged, Indian grammar with bounded repair | `consensus()` line 34; `_vote_per_character` 172; `grammar.validate` 133 |
| 2 | `services/api/app/services/correlator.py` | The trajectory engine: sightings → visits → legs with distance, implied speed and the flags; uncertainty shown, never dropped | `cluster_into_hops` 442; `score_legs` 484; `build_route` 669 |
| 3 | `services/api/app/services/event_consumer.py` | Correctness: consumer group, one transaction per batch (detections + watchlist match + alert), fan-out only after commit, retry one-by-one on failure | `_handle_batch` 256; `_persist_batch` 443 |
| 4 | `services/api/app/adapters/base.py` + `adapters/__init__.py` | Extensibility: the vendor-neutral seam; a new vendor is one class plus one registry line; unknown types degrade to RTSP | `CameraAdapter` 152; `_ADAPTERS` 33; `adapter_for` 47 |
| 5 | `ai-lab/ailab/runtime.py` + `services/ai-worker/ai_worker/rotation.py` | Engineering under constraint: one thread budget across cameras (fixed 168 threads / 866% CPU), rotation that states its coverage | `total_budget` 95; `threads_per_model` 124; `next_up` 149 |

Reserve picks:

- `services/api/app/routers/persons.py:423` plus migration `0009`: four-eyes in both API and DB.
- `services/api/app/middleware/audit.py` plus `core/rbac.py:212`: audit and denial recording.
- `services/ai-worker/ai_worker/publisher.py`: store-and-forward.

---

## 7. Scale, cost, the future, and why us

### 7.1 Scalability and sizing talking points (80,000 cameras)

Run live if asked: `python3 scripts/capacity_model.py --cameras 80000` (add `--provenance` to
print every constant's source). Figures below are from that run on 12 Oct.

| Talking point | Figure | Label |
|---|---|---|
| Central ingest, one stack, 3 consumers | **2,774 events/s** sustained, 80,000 camera identities, 388,713 rows, 397 alerts, **0 failed** | MEASURED (5 Sep), synthetic events, no inference |
| Ingest latency at that rate | p50 4.8 s / **p95 5.7 s** / p99 5.9 s, **missed the 3 s target**: queue wait | MEASURED |
| Events needed statewide | 2,667 events/s (1 per camera per 30 s), so 0.96 of one measured stack | ARITHMETIC (rate ASSUMED) |
| Bandwidth into the centre | **43.7 Mbps** vs **320 Gbps** for central video: **7,324× less** | ARITHMETIC |
| Per 2,400-camera site | ~1.3 Mbps of events vs 9.6 Gbps of video | ARITHMETIC |
| Edge compute, CPU only | 0.46 core per camera → **36,446 cores = 911 forty-core nodes**, 33 sites | ARITHMETIC from MEASURED per-frame cost |
| GPU | 228 nodes at an assumed 4×, 91 at 10× | **EXTRAPOLATED**; needs NVDEC, not built |
| ANPR only on ANPR-grade cameras (20% = 16,000) | **182 nodes**, ₹8.36 crore capex | ARITHMETIC |
| Storage | Hot 3.3 TB (7 d), warm 361 TB (90 d incl. crops), cold 861 TB (5 y); **0 central video** | ARITHMETIC |
| Model 4 storage for comparison | 24.2 PB (7 d) / 51.8 PB (15 d) | ARITHMETIC |
| Live laptop | 4 always-on cameras + 1 on screen: **4.4–5.6 cores**; all 31 grid streams analysed: ~10 cores | MEASURED (11 Oct) |
| Edge resilience | 1 GB disk spool ≈ 524,000 events ≈ 20 days per worker | ARITHMETIC from config; spool behaviour MEASURED against a stopped Redis |

**The three sentences to land:**

1. *"Inference costs the same wherever it runs; moving video is the difference."*
2. *"Sites are independent, workers re-shard by hash, and the event tier scales by adding
   consumers, so it grows district by district without redesign."*
3. *"Every figure is labelled measured, arithmetic or extrapolated, and our first pilot gate
   re-measures the per-core cost on the real x86 node before any rupee is committed."*

### 7.2 Cost-benefit

| | Contrail | Model 4 (7-day) | Model 4 (15-day) |
|---|---|---|---|
| Capex | **₹39.31 crore** | ₹63.50 crore | ₹91.15 crore |
| Opex / year | **₹8.78 crore** | ₹56.28 crore | ₹56.28 crore |
| 5-year total | **₹83.19 crore** | ₹344.90 crore | ₹372.55 crore |
| WAN / year | ₹0.50 crore | ₹48.00 crore | ₹48.00 crore |
| Existing VMS and NVRs | Kept (one adapter per vendor) | Replaced | Replaced |
| District link fails | Unreachable on the map; local recording continues; edge spools | Cameras vanish from the centre | Same |

All ARITHMETIC from indicative unit prices (HLD §19.2). Model 4 is a *floor*: its recording
servers, storage power and camera re-pointing are not priced.

**Benefits that are not money**, from HLD §19.6:

- **Alert:** 24 ms to a connected screen (MEASURED).
- **Dead camera noticed:** in 19 s (MEASURED).
- **Custody:** stays with the department.
- **Accountability:** every search audited; 12,374 audit rows at the 11:23 IST backup.

Investigator-hours saved: **not measured**; it is a pilot measurement.

### 7.3 Future enhancements

| Horizon | Enhancement |
|---|---|
| **Short (0–30 days, code only)** | Close S2–S11; department-scoped RBAC and department API; credentialed RTSP via `credentials_ref`; registry metadata, Excel import and registry export; 33-district gap analysis with ageing; reasons on watchlist alerts; second-reader plate corroboration; ONVIF WS-Security; federated playback; event contracts; recorded footage excluded from Insights |
| **Medium (30–180 days, pilot to range)** | Human-labelled ≥400-vehicle accuracy set; x86 re-profiling; vehicle colour and type attributes; appearance re-ID embeddings (suggestion, never a merge); camera tamper detection; crowd/person counting; Redpanda bus; Patroni + WAL-G + MinIO replication; Alertmanager paging and CAD/SMS webhook; Kubernetes (Helm/k3s); one GPU node with NVDEC measured |
| **Long (state)** | 33 sites, 26 departments under access classes; live VAHAN/SARTHI/eGujCop/AFIS connectors under MoU; permissively licensed retrained detectors on Indian plates and two-wheelers; regional crop stores and sub-stream video walls; predictive traffic with stated factors; DPIA-governed persons watchlist re-measured on real CCTV |

### 7.4 Our differentiators

| Against | What we have that they won't |
|---|---|
| **Pure Model 2 teams** (a viewer plus ANPR) | A statewide registry with health, gaps and onboarding routes; federation without replacing VMS; sizing for 80,000 cameras; no video wall that would burn the grid's quota |
| **Pure Model 3 teams** (middleware) | Working edge ANPR with measured accuracy work; cross-camera correlation with flagged legs; explainable anomalies; a live alarm path measured in milliseconds |
| **Pure Model 4 teams** (central VMS) | A bandwidth and cost story that survives 80,000 cameras (43.7 Mbps vs 320 Gbps; ₹83 crore vs ₹345–373 crore over 5 years); departments keep custody of their video |
| **Everyone** | Real federation against the organisers' own hostile grid (two authentication systems, one-session-per-IP, a watch quota, back-off); audit of every search including reads of the audit; a four-eyes persons watchlist; registry readiness that never fakes a government API; a measurement culture with labels on every number |

---

## 8. Our suggestions to the team

### 8.1 Before the jury: worth doing if there is time (in order)

| # | Do | Why | Time |
|---|---|---|---|
| 1 | **Rehearse §2.7 recipe A with a real phone** on the laptop's hotspot ("IP Webcam" on Android, no password), pointed at traffic or at a screen playing traffic | The jury's most likely challenge, done with a device they can hold | 20 min |
| 2 | **Ask the lead whether credentialed RTSP can be fixed** (gateway resolves `credentials_ref`; "Read first" item 1). If not, have recipe B in shell history | A judge's NVR URL will have a password | 1–2 h code, or 0 with the relay |
| 3 | Optionally, **two honest test feeds at two junctions** (§2.3 box) to show a route with legs; screenshot it | The scored tracking step has no live journey | 15 min |
| 4 | **Clean the alarm queue**: close rehearsal and test alarms with a note; consider closing the repeating persons-clip matches as "demo clip loop" | The queue opens on noise | 5 min |
| 5 | **Refresh this document's "(being fixed now)" lines** once the other agents finish (health flapping, positions, departments, gap geography, Insights exclusion, branding) | Do not answer from stale facts | 10 min |
| 6 | **Decide the screen**: present from this laptop's own browser on `http://localhost:8080`. A projector PC pointed at the LAN IP fails on HTTP. HTTPS :8443 resolves the API from the page origin | Avoids a dead login on stage | 2 min |

### 8.2 Do and don't

**Do:**

- Say the label with every number: measured, arithmetic or extrapolated.
- Name what is recorded or fictional *before* anyone asks: CAM-DEMO-01, the watchlist, the
  registries.
- Answer a gap with three beats: *what we know → why → how we'd close it and how long*.
- Fill waiting time with narration, never silence. The alarm wait is the queue-order explanation.
- Keep one browser tab. A second tab on a grid camera spends the grid's watch quota twice.
- Hand questions to their owner within 3 seconds.
- If a judge offers a password, **don't project it**: mirror off, or let them type it.

**Don't:**

- Claim ">90% accuracy" or any system accuracy. Say 83–87% on legible night crops, AI-labelled.
- Say "it scales to 80,000 cameras" without "ingest measured, sizing arithmetic, p95 missed".
- Call a vehicle or person "suspicious", "criminal" or "wanted" because of a route. It is a
  *journey to explain*.
- Say "these are real cases" or "this is live VAHAN".
- Say "production-ready". It is a prototype with a gated rollout plan.
- Say "face recognition works on CCTV". It was checked on three people in one stock clip.
- Say "we watch all cameras all the time". 3–4 always-on, the rest in rotation or on screen.
- Restart the AI workers, simulator or ingest. Run `make test` or `make down`. Open grid cameras
  one after another. Debug on stage. Show `.env`.
- Promise two-wheeler plates on overview cameras.

### 8.3 The opening (A, 60–90 s)

1. *"Gujarat already owns about 80,000 cameras across 26 departments and many vendors. What it
   lacks is one place to ask: where has this vehicle been today?"*
2. *"Contrail federates the cameras and recorders every department already runs. Nothing is
   replaced, and every recorder stays the owner of its video."*
3. *"AI runs next to the cameras and sends the state only what they saw: about 2 KB per vehicle,
   43.7 Mbps statewide instead of 320 Gbps of video."*
4. *"One registry, one map and one alarm queue turn those events into routes, watchlist alerts
   and explained anomalies, with every search audited."*
5. *"It is running now, against the organisers' grid and against any camera you hand us, and it
   grows district by district on commodity hardware."*

**Closing (A, 20 s):** line 5, then *"We've shown you what works, what doesn't yet, and the order
we'd close it. Thank you."*

### 8.4 Rehearsal checklist

| # | Drill | Target | Pass when |
|---|---|---|---|
| 1 | Full 25-minute run, with a stopwatch, twice | Each block within ±30 s of §1.2 | Q&A buffer keeps ≥ 4 min |
| 2 | 20-minute variant once | §1.3 | Demo ≤ 7.5 min |
| 3 | New camera, recipe A with a phone | Video < 15 s after opening Live; first plate < 60 s after onboarding | Twice in a row |
| 4 | New camera, recipe B (relay) from shell history | < 3 min end to end | Once |
| 5 | Watchlist alarm on a live read | < 1 clip loop after adding | Twice |
| 6 | Fallback drills: grid refused (say the line), alarm not firing (`demo_anpr.py`), blank screen (sign out and in), blank map (Offline) | Recover in < 30 s while still talking | Each once |
| 7 | Q&A sprint: A reads 30 random questions from §4; the owner answers in ≤ 30 s | No "um, I think…" | 2 rounds |
| 8 | Clean-up after each rehearsal: delete test cameras, stop containers, close alarms, retire entries | Queue and registry back to baseline | Every time |

### 8.5 Pre-jury checklist (30 minutes before)

- [ ] `docker compose ps`: 14 containers healthy (12 core + Prometheus + Grafana). **Nothing
      restarted in the last 20 min.**
- [ ] `curl -s localhost:8000/health`: alive.
- [ ] `curl -s localhost:9100/streams | grep -o 'CAM-DEMO-0[12]' | sort -u`: both clips
      publishing.
- [ ] Worker logs (`docker logs contrail-ai-worker-2 --tail 3`): "analysing …". If "refused our
      login", leave it, and plan the demo on CAM-DEMO-01 plus the new camera.
- [ ] `GET /api/v1/vehicles/routable`: has a two-camera journey appeared? If yes, note the plate
      for step 3.
- [ ] Registry back to 32 cameras plus nothing left from rehearsals (no `JURY-*`).
- [ ] Stand-in camera ready: recipe D container running (`docker ps | grep jury-cam`), *not* yet
      onboarded. Phone on the hotspot tested with `ffprobe` (§2.7).
- [ ] Browser: one tab, `http://localhost:8080/dashboard`, freshly signed in as `admin`, zoom
      110%, notifications off, laptop on power, `caffeinate -d` running.
- [ ] Feed pill **Live**; "Reading now" moving; Alarms with no open rehearsal or e2e alarm; no
      Pursuit pill; the plate you'll add is **not** on the watchlist.
- [ ] Terminal in the repo root, font ≥ 18 pt, history loaded with recipe B/C/D, `demo_anpr.py`
      and `capacity_model.py`.
- [ ] Fallback assets open in another window: `tests/browser/out/jury/*.png`, the rendered
      pipeline video (`ai-lab/runs/*__demo/annotated.mp4`), `docs/HLD.md`.
- [ ] Roles confirmed: A narrates, B drives, C on numbers, D on the terminal.

---

## Appendix A: new-camera rehearsal log (12 Oct 2026)

All times IST. Run against the live stack, with no container of the platform restarted.

| Time | Event |
|---|---|
| 11:37:38 | Throwaway RTSP server `jury-cam` (`bluenviron/mediamtx:1.20.1-ffmpeg`) on `contrail-net`, looping `data/videos/anpr_plates.mp4` (720p30 vendor sample, Indian plates). Stream online in about 1 s |
| 11:39:08, 11:39:37 | Two attempts with `rtsp://viewer:…@jury-cam:8554/live`: **422 "stream_url must not embed credentials"** (a failed `camera.create` shows in the audit trail) |
| 11:40:26 | Third attempt, anonymous URL `rtsp://jury-cam:8554/live`: form opened (Playwright driving the real UI) |
| 11:40:34.9 | **Onboard camera** clicked → 201 in under 0.2 s → row visible 0.1 s later; MediaMTX path `jury-01` registered |
| 11:40:38.4 | Health status online (+3.5 s) |
| 11:40:44 | `/anpr?camera=JURY-01` opened (focus heartbeats start) |
| 11:40:51 | Video playing in the browser (HLS; +7.2 s after opening) |
| 11:40:53 | JURY-01 in the Redis roster (+18.2 s after onboarding) |
| 11:41:07 | Owning worker opened the stream (MediaMTX readers 2) |
| 11:41:16 | **First plate event** `KA02MM9091` (conf 0.97) (+41.3 s after onboarding) |
| 11:41:41 | `KA02MN1826` (+66 s) |
| 11:42:58 | `JURY-02` created via API with `source_file=rajkot-bus-stand.mp4` (no VMS) |
| 11:43:00–11:44:36 | **Not published by the simulator** (it selects clips at start-up, from the simulated VMS only) |
| 11:45:15 | `POST :9100/streams/JURY-02/start` → path ready at 11:45:20 (about 5 s) |
| 11:45:28 | Live opened on JURY-02 → worker reading at 11:45:33 (about 5 s); worker log "analysing 3 of 13 camera(s): CAM-DEMO-01, JURY-02, SBX-cam10" |
| by 11:47 | 32 vehicle events on JURY-02, **0 plates** (parked two-wheelers) |
| ~11:47 | Streams stopped; `camera_down` for JURY-01 raised at 11:47:22 with the probe error; closed with a note |
| 11:47:42 | Both cameras deleted via API (`camera.delete` audited; MediaMTX paths gone, 404); 83 detection rows and 6 crop objects from the rehearsal removed |
| 11:50 | Credential-relay test: an authenticated test camera refused a no-credential read (401); the same stream through a `judge-relay` container read fine (h264 1280×720). Both containers removed |
| 11:52 | Stand-in recipe D (environment variables only, 25 s loop) tested: stream online, then removed |

Screenshots: `tests/browser/out/jury/rehearsal_1_form.png`, `rehearsal_2_registry.png`,
`rehearsal_3_map.png`, `rehearsal_4_live_{10,30,60,90}s.png`, `anpr_camera_JURY-02.png`.

## Appendix B: command cheat sheet (D's terminal)

```bash
# health
docker compose ps
curl -s localhost:8000/health
for w in contrail-ai-worker contrail-ai-worker-2 contrail-ai-worker-3; do docker logs $w --tail 2; done

# stand-in camera (recipe D) and onboarding URL rtsp://jury-cam:8554/live
docker run -d --rm --name jury-cam --network contrail-net \
  -v "$PWD/data/videos/anpr_plates.mp4":/clip.mp4:ro \
  -e MTX_RTSPTRANSPORTS=tcp -e MTX_HLS=no -e MTX_WEBRTC=no -e MTX_RTMP=no -e MTX_SRT=no -e MTX_API=no \
  -e 'MTX_PATHS_LIVE_RUNONINIT=ffmpeg -re -stream_loop -1 -i /clip.mp4 -t 25 -c copy -f rtsp rtsp://localhost:8554/live' \
  -e MTX_PATHS_LIVE_RUNONINITRESTART=yes bluenviron/mediamtx:1.20.1-ffmpeg

# can the platform reach a judge's camera?
docker run --rm --network contrail-net --entrypoint ffprobe bluenviron/mediamtx:1.20.1-ffmpeg \
  -v error -rtsp_transport tcp -show_entries stream=codec_name,width,height -of csv=p=0 'rtsp://IP:PORT/PATH'

# credentialed camera via relay (recipe B); onboard rtsp://judge-relay:8554/cam
docker run -d --rm --name judge-relay --network contrail-net \
  -e MTX_API=no -e MTX_HLS=no -e MTX_WEBRTC=no -e MTX_RTMP=no -e MTX_SRT=no -e MTX_RTSPTRANSPORTS=tcp \
  -e "MTX_PATHS_CAM_SOURCE=rtsp://USER:PASS@IP:554/PATH" -e MTX_PATHS_CAM_SOURCEONDEMAND=yes \
  bluenviron/mediamtx:1.20.1-ffmpeg

# recorded clip camera (recipe C), after onboarding with "Recorded video"
curl -s -X POST localhost:9100/streams/CODE/start

# alarm fallback
docker compose exec -e NAGARNETRA_API_URL=http://api:8000 api python /app/scripts/demo_anpr.py

# numbers
curl -s localhost:8000/metrics | head -c 400
python3 scripts/capacity_model.py --cameras 80000
python3 scripts/capacity_model.py --cameras 16000

# clean-up
docker stop jury-cam judge-relay
```

