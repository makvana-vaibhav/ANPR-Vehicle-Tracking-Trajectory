# Contrail: speaker notes for the jury round

13 Oct 2026. Takes about 15 minutes to read. For the detail behind any answer, see
`docs/submission/JURY_PREP.md`.

**Before you start**

- Open **http://localhost:8080**. Type `localhost`, not `127.0.0.1`.
- Every demo account signs in with `admin@123`, which is already filled in.
- Keep one browser tab open. Restart nothing.
- Give every number its label:
  - **measured**: we ran it;
  - **estimated**: calculated from stated inputs;
  - **extrapolated**: anything about a GPU, never run.

---

## 1. The 60-second pitch

- **The problem.** Gujarat has about 80,000 cameras across 26 departments and many vendors. Each
  recorder knows only its own cameras. Nobody can ask: *"Where has this vehicle been today?"*
- **What Contrail does.**
  - It connects the cameras departments already own, and replaces nothing.
  - AI next to the cameras reads number plates.
  - Sightings from different cameras are linked into a journey.
  - A watchlist plate raises an alarm with photo evidence.
  - Everything is on one map, and every search is recorded.
- **The flow:** OBSERVE → IDENTIFY → LINK → ALERT.
- **Why it is different:** *"The central tier carries events, not video."*
  - About 2 KB goes to the centre per vehicle.
  - For 80,000 cameras that is **43.7 Mbps instead of 320 Gbps**, about 7,000× less
    (estimated).
- **Close with:** *"It runs now on this one laptop, and grows district by district on ordinary
  servers."*

---

## 2. Run of show

**Say these early, before the jury finds them:**

- **The grid cameras are recordings today.** Say: *"These are recordings of the organisers'
  cameras, replayed through the same gateway and AI, because the venue link can't carry 30 live
  feeds."*
  - The venue network is about 1 Mbps, and the grid locks us out on reconnects.
  - The UI labels them **Recorded clip**.
  - 15 of the 30 were recorded by 08:40 (the grid keeps locking us out); the rest stay on the live grid. Check with `docker compose exec -T api python -m scripts.grid_replay status`.
  - `make grid-live` switches back to the live grid.
- **CAM-DEMO-01 is a recorded road clip** that loops every 15 s.
- **Some data is fictional, and labelled on screen:** the watchlist entries (`DEMO/…`) and the
  VAHAN/eGujCop answers.

### 20-minute version

| Min | On screen | Say | If it fails |
|---|---|---|---|
| 0–1 | **Command** (map and alarms) | The pitch | Blank screen: sign out and back in |
| 1–3 | Command map, or the architecture picture | "Departments keep their cameras and video. We pull video only while someone watches. AI sends only events." | No projector: use the section 3 diagram |
| 3–5 | **Network → Cameras → Onboard camera** | "Give us any camera URL, even with a password, and watch it join." | Judge's camera unreachable: use our password-protected stand-in camera, or a video file |
| 5–7 | **Live**: CAM-DEMO-01, then the new camera | "Each box is a vehicle. The plate is read in several frames and voted on. The new camera shows plates within seconds." | No plates yet: stay on CAM-DEMO-01, return later |
| 7–9 | **Investigate**: press ⌘K and type a plate | "Every sighting in order: time, camera, place, confidence, photo, and the route on the map." | Never read: the honest line below, then show `EY61NBG` (deep history) |
| 9–11 | **Alarms → Watchlist**: add a plate being read right now | "The next time any camera reads it, the alarm fires by itself, with photo, camera and time." | No alarm in 2 min: a teammate runs `demo_anpr.py` (DEMO_SCRIPT §2.4) |
| 11–12 | **Network → Map** | "Works offline: no internet, no paid map. Cameras we can't place are listed apart, never guessed." | Blank map: click **Offline** |
| 12–13.5 | **Admin → Audit trail**, last 15 minutes | "Everything we just did, under our names. Reading this list is recorded too." | Show `docs/SECURITY.md` §1 |
| 13.5–15 | Section 7 numbers | "Ingest measured at 2,774 events/s; the rest is estimated, and labelled." | — |
| 15–16 | Section 9 | "Here's what isn't built, and how we'd close it." | — |
| 16–20 | Questions | Section 10 | — |

**If a plate was never read, say:** *"We didn't read that plate in this window. That doesn't mean
the vehicle wasn't there. A camera that wasn't being analysed when it passed couldn't read it."*

**If they ask for a two-camera journey and today's data has none, say:** *"The linking engine is
built and tested. Today's data hasn't caught the same plate at two cameras, and we won't fake
it."*

### 30-minute version

Run the 20-minute version with more time on each block, and add these:

| Add | Where | Time | Say |
|---|---|---|---|
| **Import CSV → Validate only** | Before onboarding | +1 min | "Bulk import checks every row and says why it rejects one." |
| **Possibly the same vehicle**, then **Pursue** | In Investigate | +1.5 min | "Misreads get close matches with reasons; a person decides. Pursue predicts the next cameras." |
| **Persons**: approval by two people | After the watchlist alarm | +1.5 min | "A second person approves each face entry, and a person confirms every match." |
| **Insights**, then sign in as `auditor` and try a search | After the map, then the audit trail | +2 min | "Each traffic figure says what data it rests on. The auditor can't search." |
| More questions | End | +4 min | — |

**More fallbacks**

- **Persons screen misbehaves:** describe the safeguards in section 8 instead.
- **Grid camera won't play:** say it's their gateway, switch to CAM-DEMO-01, and don't debug.
- **Everything fails:** play the recorded pipeline video (`docs/PANIC.md` §7) and keep talking.

---

## 3. How it works, simply

```
 Camera (any brand) ──RTSP──► Gateway (MediaMTX) ──► browser, only while watched
                                   │
                                   ▼
 AI worker near the camera:  find vehicle → follow it → find plate → read → vote
                                   │  one ~2 KB event per vehicle
                                   ▼
 Event bus (Redis) ──► API + database ──► watchlist check ──► alarm on screens
                                   │
                                   ▼
          search · journeys · map · alarms · insights · audit
```

1. **Camera** sends video over RTSP. The **gateway** fetches it only when someone needs it.
2. **Find vehicles:** a small AI model (YOLO) boxes each car, bus, truck or bike.
3. **Follow each one:** a tracker (ByteTrack) keeps one ID per vehicle across frames.
4. **Find and read the plate:** a second model finds the plate; OCR (PaddleOCR) turns it into
   letters.
5. **Vote across frames.**
   - Letters from several reads are voted on and checked against Indian plate formats.
   - Easily confused letters (0/O, 8/B) are marked "ambiguous", not hidden.
   - One event is sent when the vehicle leaves view: 241 ms median from frame to event
     (measured).
6. **Save, check, alert.** In one step the API saves the read, checks the watchlist and raises
   any alarm. Screens get it over a WebSocket (a connection that stays open) in 24 ms
   (measured).
7. **Link.** The same plate at different cameras becomes a journey. An impossible leg (too fast,
   or two places at once) is drawn red and dashed, never dropped.

---

## 4. What we used and why

| Piece | What it does | Why |
|---|---|---|
| **FastAPI** (Python) | The API behind every screen | Same language as the AI; fast |
| **PostgreSQL + PostGIS + TimescaleDB** | The database | One database for maps, time data and fuzzy plate search |
| **Redis Streams** | Event bus, AI to API | Light enough for a laptop; Kafka-type bus planned for the state |
| **MinIO** | Plate photos (evidence) | On our own servers; private, links expire in 5 minutes |
| **MediaMTX** | Video gateway | One small program: RTSP in on demand, browser video out |
| **YOLO + ONNX Runtime** | Finds vehicles and plates | Tiny models for plain CPUs; same model runs on a GPU; small image |
| **ByteTrack** | Follows vehicles | Simple and fast, with no extra model |
| **PaddleOCR via RapidOCR** | Reads plate letters | Beat 9 alternatives on Indian grid plates in our test; RapidOCR runs on this laptop's chip |
| **React + MapLibre** | Screens and map | Map from local files: no map server, works offline |
| **Docker Compose** | Starts everything | Whole system on one machine, versions pinned |

All of it is open source and on-premises, with no paid APIs.

---

## 5. Connecting a new camera

**Ways in** (each is an "adapter"):

- **RTSP:** any IP camera, NVR (network video recorder) or phone camera app. The main path, and
  rehearsed.
- **ONVIF:** finds a camera and asks for its stream. Tested on recorded replies only.
- **Vendor VMS API** (video management system): Milestone, Genetec, CP Plus and Hikvision are
  mapped. Tested on sample data only.
- **Hosted grid:** the organisers' system; 30 cameras in one sync.
- **Recorded clip:** a video file played as a camera.
- **Bulk CSV:** a dry run explains every rejected row.

**What the operator types:**

- code, name and place;
- latitude and longitude, which must be inside Gujarat;
- the video URL, pasted exactly as given, password included;
- the department;
- the tick for "analyse for number plates".

**What happens behind the scenes:** the password is taken out of the URL and sealed with
AES-256-GCM encryption. It is never shown, logged or audited. We searched every log, the
database, the audit trail and Redis for it, and found it 0 times.

**Measured on 12 Oct**, using a password-protected stand-in camera:

| When | What happened |
|---|---|
| 0.4 s after clicking Onboard | Camera saved |
| 0.7 s | AI workers know about it |
| 3 s | Health check: online, using its login |
| 1.2 s after opening Live | AI worker reading the stream |
| about 7 s after opening Live | First plate on screen |

- A wrong password shows `unauthorized` in about 4 s.
- A video file showed its first plate 5.9 s after opening Live.

**Tips**

- **Network.** The camera must be reachable from the laptop. Venue Wi-Fi often blocks devices
  from reaching each other, so use a hotspot.
- **Aim.** The AI finds a vehicle first, so a plate on paper won't be read. Point the camera at a
  road, or at a screen playing traffic.
- **Passwords.** Never show a judge's password on the projector.
- **Analog cameras** need an encoder or DVR that provides RTSP.
- **Afterwards,** delete the camera **before** switching its source off. Otherwise a "camera down"
  alarm fires.

---

## 6. Streaming and protocols, simply

| Term | Plain meaning |
|---|---|
| **RTSP** | How cameras send video |
| **ONVIF** | A standard for finding cameras and asking for their stream address |
| **WebRTC (WHEP)** | Browser video, under a second of delay. Used first |
| **HLS** | Video in small chunks over normal web ports: passes firewalls, a few seconds' delay. Fallback |
| **H.264 / H.265** | Compression formats. The grid mixes both (24 + 6), from 960×576 to 2560×1440. H.265 saves bandwidth, costs more CPU |

- **On demand.** The gateway connects only while someone watches, and lets go 60 s after the last
  viewer. One connection per camera, however many people watch.
- **AI near the cameras.** The AI costs the same wherever it runs; moving video is the expensive
  part. We move conclusions, not video.

---

## 7. How it scales

**The design**

- **Events, not video:** a 2,400-camera site sends about 1.3 Mbps instead of 9.6 Gbps
  (estimated).
- **33 edge sites, each with its own AI workers.** If a link drops, a site saves events to disk
  (about 20 days per worker, estimated) and replays them in order later.
- **No coordinator.** Workers split cameras by a formula on the camera code; add a worker and
  they spread out. The centre grows by adding API copies and bus readers.

**The numbers**

| Figure | Label |
|---|---|
| Central ingest **2,774 events/s** for 80,000 camera identities, 0 failures | Measured (test events, no video) |
| At that load, latency was 5.7 s against our 3 s target, so **we missed it**. It was queue wait; the fix is more readers | Measured |
| 43.7 Mbps of events vs 320 Gbps of video | Estimated |
| Laptop: 4 always-on cameras plus 1 on screen use 4.4–5.6 cores; all 31 grid streams use about 10 | Measured |
| Alarm on screen in 24 ms; dead camera noticed in 19 s | Measured |

**What a real deployment needs** (CPU only, estimated by `scripts/capacity_model.py`):

- About 0.46 core per camera, so roughly 2 cameras per core.
- 50 cameras: one 40-core server. A 2,400-camera site: 27 of them.
- 80,000 cameras:
  - 911 forty-core servers at the sites;
  - 3 database servers and 6 service servers at the centre, plus a disaster-recovery site;
  - **₹39.31 crore** capex and **₹8.78 crore a year** opex (indicative prices, cameras
    excluded).
- ANPR on ANPR-grade cameras only (20%): **182 servers, ₹8.36 crore**.
- GPUs: 228 servers at an assumed 4× speed-up, 91 at 10×. These are **extrapolated**, and they
  need hardware video decoding that isn't built.
- Storage: 3.3 TB for 7 days, 361 TB for 90 days with photos, 861 TB for 5 years. No video is
  stored centrally.

**This laptop.** It is an Apple Silicon Mac, and Docker on a Mac gets no GPU, so we run CPU-only.

- Three AI workers read plates on a few cameras all the time (CAM-DEMO-01 and the grid cameras that show plates).
- Any camera opened in Live starts being read within a few seconds; the rest stream without plate reading.
- With servers or GPUs, the same code runs more cameras.

The key assumption is half an analysed frame per second per camera. The pilot re-measures it on
a real server.

---

## 8. Security in plain words

- **Roles:** 6 roles and 23 permissions. The server checks them on every request.
- **Audit:**
  - every search, stream open, watchlist change, sign-in and edit is recorded with the user's
    name;
  - reading the audit trail is recorded too;
  - the auditor can read the trail but cannot search.
- **Camera passwords** are encrypted (AES-256-GCM), and a test checks they never appear in logs.
- **Ports:** only the web ports (8080, 8443) are open beyond the laptop. Everything else is
  local-only, and Redis has a password.
- **Stream tokens:** each works for one camera for about 2 minutes. The gateway asks the API
  before every viewer.
- **Evidence:** plate photos are in private storage, behind links that expire in 5 minutes.
- **Logins:** passwords are hashed with argon2id; sessions last 15 minutes; at most 10 failed
  logins every 5 minutes.
- **Retention means real deletion:** reads after 365 days, photos after 90, the audit trail after
  5 years.
- **Faces** (for example, missing persons):
  - only on tagged cameras;
  - two different people must approve each entry, and the database enforces it;
  - entries need a purpose and case reference, and expire after 30 days by default (90 at most);
  - faces that match nothing are never stored, not even as numbers;
  - a person must confirm every match, and nothing is dispatched automatically.

**Be honest about these:**

- **`admin@123` is shared for this jury round only**, by the owner's decision. Normally every
  account gets its own generated password.
- **Still open:**
  - HTTPS only at the web tier (:8443);
  - no disk encryption;
  - the audit log is not yet tamper-proof;
  - every role sees every department;
  - no penetration test.

---

## 9. What we don't have yet, and how we'd fix it

| Problem | Plan |
|---|---|
| **Accuracy not proven on real Gujarat footage at scale** (83–87% on legible night plates, AI-labelled) | Two people label 400+ vehicles in the pilot; a second reader must agree |
| **Grid feeds replayed today** | `make grid-live` switches back. In production the AI sits at the site |
| **Night and two-wheelers on overview cameras:** 11% of cars and 0% of two-wheelers read at night (measured, 11 Oct) | ANPR-grade cameras with infrared; sizing already assumes ANPR on 20% of cameras |
| **No live two-camera journey yet** (as of 12 Oct) | Pilot with ANPR-grade cameras at junctions |
| **No GPU here** | Measure one GPU server with hardware decoding in the pilot |
| **YOLO model files are under AGPL-3.0** | The owner decides; permissive models to retrain are listed |
| **Ingest latency target missed** (5.7 s against 3 s) | More readers, then a test at 2× statewide load |
| **The security gaps in section 8** | TLS everywhere, disk encryption, a tamper-proof audit, department access, single sign-on with MFA, a penetration test |
| **ONVIF and vendor VMS tested on recordings only** | A live VMS in the pilot |
| **Not built:** colour search, look-alike matching, tamper detection, SMS alerts, crowd counting, Kafka bus, failover | In the 30/90/180-day plan |

---

## 10. Likely jury questions: short answers

**Is it real or static?**
Live. Give us a camera or a plate to watch for, and it reacts to your choice. The audit trail
shows our actions from minutes ago.

**Can you add a new camera now?**
Yes: paste its RTSP URL, password included. Online in 3 s, first plate about 7 s after opening
Live (measured). It must be reachable from this laptop.

**How secure is it?**
Server-checked roles, every search audited, encrypted camera passwords, only web ports open. We
list our own open items (section 8), including today's shared password.

**Does it scale to 80,000 cameras?**
Ingest is measured at 2,774 events/s for 80,000 camera identities, but it missed the latency
target. The rest is estimated: 911 forty-core servers across 33 independent sites.

**What if the network fails?**
Recorders keep the video. Our edge worker keeps analysing, saves events and replays them later.
The hour-long outage test hasn't been run yet.

**Accuracy? Above 90%?**
We claim no system figure. On legible night plates it is 83–87% exact, and 92% of the plates it
commits to are right, labelled by AI. Labelling by two people is our first pilot gate.

**Night, rain, blur?**
If a person can't read the plate, neither can we. "Enhancing" the image made it worse (62%
against 83% raw). The fixes are more looks per vehicle and ANPR cameras with infrared.

**What does it cost?**
For 80,000 cameras: about ₹39 crore up front and ₹8.8 crore a year (estimated). Five years:
about ₹83 crore, against ₹345–373 crore to centralise video.

**Why not the cloud?**
Police data stays on government premises and video stays with departments. It works offline,
with no paid APIs.

**Many vendors?**
Yes: RTSP, ONVIF, vendor VMS, the hosted grid and recorded clips. A new vendor is one class plus
one line. ONVIF and VMS are tested on recordings only.

**Privacy and faces?**
Tagged cameras only, two-person approval, expiry, non-matches never stored, a person confirms
every match. Legal sign-off (DPDP Act) is a rollout gate.

**More than plain ANPR?**
Plain ANPR stops at the plate. We add one map over every department's cameras, journeys with
impossible legs flagged, alarms with evidence, and an audit of every search.

**Who uses it?**
- **Operator** (control-room constable): watches Live and acknowledges alarms.
- **Supervisor:** dispatches and closes alarms, manages the watchlist, approves face entries.
- **Analyst:** searches and views insights, with no live video.
- **Auditor:** reads the audit trail but cannot search.
- **Admin:** manages accounts.

**Track a vehicle across cameras?**
Yes: same plate, linked, impossible legs flagged. Show a journey if one exists, or use the honest
line from section 2.

**What's missing?**
Accuracy on real footage, live multi-camera journeys, and the security items. See section 9.

**Future plans?**
- **30 days:** security items, department access, a labelled accuracy set.
- **90 days:** a one-district pilot, re-measured on real servers.
- **180 days:** one police range: the Kafka bus, failover, a GPU server measured.
