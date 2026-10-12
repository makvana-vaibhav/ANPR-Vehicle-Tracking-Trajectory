<div align="center">

# Contrail

**Statewide CCTV federation and vehicle intelligence**

One registry, one map and one alert queue over the CCTV that Gujarat's departments
already own. No department replaces its cameras or its video management system.

<sub>Gujarat Police CCTV Hackathon "Sentinel" · sandbox round 12–13 Oct 2026</sub>

</div>

---

## The idea

Gujarat's departments run CCTV on different vendors' systems, analog and IP, up to
about 1,000 km apart. Each recorder knows what its own cameras saw. Nobody can ask
**"where has this vehicle been today?"** across all of them.

Contrail answers that without centralising video:

> **The central tier carries events, not video.**

| Model | What Contrail does |
|---|---|
| **Model 1: registry + GIS** (compulsory) | Every camera, its owner, position and health, on one map |
| **Model 3: federation** | Departmental VMS stay authoritative. Adapters read their catalogues and stream URLs |
| **Selective Model 2: direct viewing** | Pulled on demand, only for the feed an operator is watching |
| **Edge AI** | ANPR runs next to the video, and only ~2 KB events cross the WAN |

**Why not one central VMS (Model 4).** For 80,000 cameras, computed by
`scripts/capacity_model.py`:

| | Centralise the video | Centralise the events (Contrail) |
|---|---|---|
| Bandwidth into the centre | **320 Gbps** | **43.7 Mbps** (7,324× less) |
| Central video storage, 7 / 15 days | 24.2 / 51.8 PB | none: video stays in the departments' recorders |

These are **arithmetic** from declared inputs: 4 Mbps per camera, and one ~2 KB event
per camera every 30 s. The full argument is in [docs/HLD.md](docs/HLD.md).

---

## Status

As of 12 Oct 2026. ✅ works and is tested · 🟡 partial · 🔧 being built · ❌ not built.

| Capability | State |
|---|---|
| Camera registry + GIS map with layered filters | ✅ |
| Onboarding: form, bulk CSV with dry run, API client, federated VMS sync | ✅ |
| Fleet health, `camera_down` alerts auto-closed on recovery, gap analysis | ✅ killed stream → offline in **19 s** (measured) |
| Federation with the organisers' grid | ✅ 30 cameras onboarded through `HostedGridAdapter` |
| ONVIF and vendor-VMS adapters (Milestone / Genetec / CP Plus / Hikvision mapping) | 🟡 unit-tested on fixture payloads, never run against a live VMS |
| Live video: WebRTC with HLS fallback, on demand, camera-scoped tokens | ✅ |
| ANPR at the edge: detect → track → plate → OCR → consensus | ✅ runs live on the grid; accuracy unproven (see [Accuracy](#accuracy)) |
| Track a plate across cameras: timestamped route, CSV, printable report | ✅ legs that fail plausibility are flagged, never dropped |
| Watchlist → alert → every operator's screen | ✅ **24 ms** detection-to-WebSocket (measured) |
| Trajectory anomalies with stated reasons | ✅ |
| Traffic insights: counts, flow, congestion, short-horizon forecast | ✅ gaps in the data are labelled, not filled |
| Audit of every search, stream open and watchlist change | ✅ tested |
| Persons watchlist (YuNet + SFace), with supervisor approval and four-eyes | 🔧 backend and edge in the working tree, operator screen not finished |
| Central ingest at 80,000 camera identities | ✅ **2,774 events/s**, 0 failed; ❌ p95 5.7 s against a 3 s target |
| Redpanda bus, Prometheus/Grafana, DB replicas, backups, TLS | ❌ designed, not built ([HLD §18](docs/HLD.md#18-what-is-not-built)) |

---

## The command centre

Seven workspaces sit across the top bar. A role sees only the workspaces it can use.

| Workspace | Screens | For |
|---|---|---|
| **Command** | `/dashboard` | The state at a glance: towns, open alarms, plates arriving now |
| **Live** | `/anpr` | One camera on the stage with its plate boxes, the rest in a rail |
| **Investigate** | `/vehicles` | A plate in, its timestamped location-wise route out; CSV and printable report |
| **Alarms** | `/alerts`, `/watchlist` | The triage queue (severity first, then exact hits before near matches) and the watchlist |
| **Network** | `/map`, `/cameras`, `/health` | GIS map, the camera registry and onboarding, fleet health and gaps |
| **Insights** | `/traffic` | Counts, flow, congestion, forecast |
| **Admin** | `/users`, `/audit` | Accounts, and an audit trail whose own reading is audited |

**⌘K** (or Ctrl K, or `/`) opens search from anywhere:

- type a plate to open its journey;
- type a camera code or a place (`cam10`, `Paldi`) to open that camera;
- type a word to find a screen.

---

## The pipeline

```
departmental cameras / VMS / the organisers' grid
        │ RTSP · ONVIF · vendor REST
        ├──────────────▶ registry + GIS (Model 1) ◀── health monitor
        │
        ├──▶ MediaMTX gateway ── on demand ──▶ operator (WebRTC / HLS)        (Model 2)
        │
        └──▶ edge ai-worker
               read (drop-to-latest) → YOLOv8n vehicles → ByteTrack
               → YOLO11n plate (only when the view changed) → PP-OCRv4
               → multi-frame consensus → one event per vehicle (+ crop to MinIO)
                        │  ~2 KB
                        ▼
               Redis Stream ──▶ EventConsumer (exactly once) ──▶ PostgreSQL/PostGIS/Timescale
                        │                     └─ watchlist match ─▶ alert ─▶ pub/sub
                        └──▶ EventTailer (every API replica) ──▶ /ws/events ──▶ operators
                                         correlator ─▶ routes · anomalies · analytics
```

**What each part runs on**

- **Runtime.** ONNX Runtime and OpenCV. The worker image has no PyTorch.
- **CPU.** One ONNX thread budget is divided across cameras
  ([docs/PERFORMANCE.md](docs/PERFORMANCE.md)). Inside Docker on Apple Silicon there
  is no GPU, and no setting creates one ([docs/GPU.md](docs/GPU.md)).
- **Split.** The worker publishes events and nothing else. Matching, alerts and
  storage belong to the platform.

---

## Run it

Requirements:

- Docker with **≥ 8 GB** allocated (`make preflight` checks this);
- `make`;
- Node 20, only for the browser tests.

```bash
make models     # once: fetch the detector and OCR weights (ANPR needs them)
make videos     # once: fetch the recorded demonstration clip
make demo       # build, start, migrate, seed, onboard the grid, start one AI worker, verify, open the browser
```

The command centre is at **http://localhost:8080**.

- **Admin.** Sign in as `admin` with `BOOTSTRAP_ADMIN_PASSWORD` from your `.env`. The
  file is created from `.env.example` and is never committed.
- **Other roles.** `supervisor`, `operator`, `analyst` and `auditor` use the demo
  password that `make seed` prints.

| Command | What it does |
|---|---|
| `make up` | Build and start the base platform, then wait until every container is healthy |
| `make demo` | `up`, plus migrate, seed, grid sync (`SANDBOX_SYNC=0` to skip), simulator and one AI worker, then checks |
| `make ai` | Start **one** AI worker (`ai` profile). Lowest latency for the camera on screen |
| `make ai-multi` | Start **three** AI workers, each owning a hash shard of the camera list (`AI_WORKER_COUNT=3`, `AILAB_INFERENCE_BUDGET=2`) |
| `make scale` | Scale overlay: the API stops ingesting and **three consumer replicas** share the stream. (Its help text also names Redpanda and Grafana. Neither exists yet.) |
| `make status` | Which dependencies are up, degraded or down (`/ready`) |
| `make logs S=api` | Tail one service |
| `make down` / `make clean` | Stop and keep data / stop and **delete** data volumes |

API docs are at http://localhost:8000/docs. The simulator's control page is at
http://localhost:9100/streams.

> **During a live session:**
>
> - **Do not restart the AI workers.** The organisers' grid answers repeated logins
>   by refusing ours for 2–15 minutes.
> - **Do not run `make test` or the browser flows while anyone is watching.** They
>   raise a real alarm on the live screens, and close it when done.
>
> See [docs/DEMO_SCRIPT.md](docs/DEMO_SCRIPT.md) and [docs/PANIC.md](docs/PANIC.md).

---

## Test and lint

```bash
make test        # pytest: API, AI worker, simulator, end-to-end against the live stack; then vitest
make lint        # ruff + format check + mypy (API, simulator, ai-lab, AI worker) + tsc --noEmit
```

**Browser flows.** These use real Chromium through `playwright-core`, against the
running stack:

```bash
cd tests/browser && npm install
node flows.mjs                       # sign-in, command, ⌘K plate, investigate + CSV, report,
                                     # live demo camera, watchlist → alarm, network, insights,
                                     # audit, sign-out
node flows.mjs --only palette-plate,report --headed
CHROME_PATH=/path/to/chrome node flows.mjs   # if Chrome is not found automatically
```

**Load tests.**

| Command | What it runs |
|---|---|
| `make load` | 80,000 camera identities at 2,667 events/s |
| `make load-quick` | A 30 s sanity run |
| `make load-operators` | k6: can operators still work while ingest runs at full rate? |

**The last full recorded run** (12 Oct, [docs/BUILD_STATE.md](docs/BUILD_STATE.md)):

| Suite | Result |
|---|---|
| API | 639 passed, 16 skipped |
| AI worker | 116 |
| Simulator | 22 |
| Web | 332 tests, 34 files |
| End-to-end | 34 |

CI (`.github/workflows/ci.yml`) also runs the ai-lab suite, which `make test` does
not, and builds the web bundle.

---

## Scale

Scale is three separate problems, solved in three places.

**1. The event tier: measured.**

```bash
make scale && make load
```

| Measured on one laptop, 80,000 camera identities, 3 consumer replicas, 150 s | |
|---|---|
| Ingest sustained (median) | **2,774 events/s** (offered 2,664) |
| Failed | **0**. 388,713 detections written, 397 alerts raised |
| p95 capture → persisted | **5.7 s. Missed the 3 s target.** The backlog grew to 10,237 during the run and cleared afterwards: queue wait, not processing |

The run also found three bugs that 443 tests had not. They are in
[docs/HLD.md §15](docs/HLD.md#15-scale-evidence).

**2. The inference tier: measured per frame, divided by a thread budget.**

- On the development Mac, one analysed 1080p frame costs **0.30–0.80 core-seconds in
  Docker** and **0.10 natively with CoreML**
  ([research](docs/research/ANPR_ACCURACY_LATENCY.md)).
- No x86 server or GPU has run this code.

**3. Fleet sizing: computed, never tabulated.**

```bash
python3 scripts/capacity_model.py --cameras 80000
python3 scripts/capacity_model.py --compare --provenance
```

80,000 cameras, CPU only:

| | |
|---|---|
| Edge compute | ~36,000 cores, **911 nodes** |
| Capex | **₹39.31 crore** |
| Opex | **₹8.78 crore / year** |

GPU scenarios are extrapolated and need hardware decode, which isn't built. Every
assumption is printed with its source.

An earlier sizing in the docs was about **4× too optimistic**. It treated a 4-thread
worker as one core. [docs/INFRASTRUCTURE.md](docs/INFRASTRUCTURE.md) replaces it.

---

## Accuracy

**We do not claim a system accuracy figure.** What has been measured
([research, 12 Oct](docs/research/ANPR_ACCURACY_LATENCY.md)):

**Single-crop exact match.** On 60 legible grid crops, labelled by an AI rather than
two humans, so ±10–12 points:

| Configuration | Exact match |
|---|---|
| As shipped | 61.7% |
| Raw crops fed to the recogniser | 83.3% |

**Plate yield on the grid at night.** The share of completed vehicles that produced a
grammar-valid plate:

| Vehicle class | Yield |
|---|---|
| Cars | 11.3% |
| Trucks | 19.7% |
| Buses | 14.8% |
| Two-wheelers | 0% |

Overview cameras at night mostly cannot read two-wheelers, and we say so.

**What claiming >90% would take:** a two-person, human-labelled set of about 400
vehicles scoring ≥93%. That set does not exist yet.

**Errors are kept visible.**

- Near matches are capped at medium priority and labelled "verify before acting".
- Route legs that fail plausibility are flagged, never dropped.
- The system reports a **trajectory anomaly**, never a "suspicious" vehicle.

---

## Security

This platform tracks people's movements. The controls that matter make misuse
visible, as well as keeping attackers out.

| Control | Implementation |
|---|---|
| Passwords and tokens | argon2id. JWT access tokens of 15 min. Refresh tokens of 7 days, rotated, with a denylist checked on HTTP and WebSocket |
| Roles | Six roles, enforced server-side on every request. Operators acknowledge; supervisors dispatch. **An auditor cannot run a vehicle search** |
| Audit | Every plate search, stream open and watchlist change. Denied attempts too. Reading the audit trail is itself audited |
| Stream tokens | Their own token type: ~2 min, scoped to one camera. Camera credentials never reach the browser and are redacted from every log |
| Rate limiting | Redis-backed, so per deployment rather than per replica. Auth counts **failures**, not attempts |
| Secrets | Secrets live in `.env` (gitignored). `credentials_ref` is a pointer. `enc://` values are sealed with AES-256-GCM |

**Not yet:**

- TLS (the `deploy/nginx` edge config is plain HTTP);
- volume and object encryption at rest;
- backups;
- a penetration test;
- replacing the AGPL-3.0 detector weights.

Full model: [docs/SECURITY.md](docs/SECURITY.md).

---

## Stack

| Layer | Choice |
|---|---|
| API | FastAPI (Python 3.11), SQLAlchemy 2.0 async, Alembic, Pydantic v2 |
| Database | PostgreSQL 16 + PostGIS + TimescaleDB (`timescale/timescaledb-ha`, one arm64/amd64 image) |
| Bus | Redis 7 Streams with consumer groups. A Redpanda backend is a config seam only |
| Media | MediaMTX 1.20.1: RTSP in, WebRTC (WHEP) / LL-HLS out, on demand |
| AI | YOLOv8n (vehicles), YOLO11n (plates), ByteTrack, PP-OCRv4 via RapidOCR, ONNX Runtime 1.29. Faces: YuNet + SFace (🔧) |
| Objects | MinIO (crops; a private bucket for persons media) |
| Search | Postgres `pg_trgm`. OpenSearch runs but indexes nothing yet |
| Frontend | React 18, Vite, TypeScript, Tailwind, MapLibre GL (offline GeoJSON basemap, optional satellite), Recharts, bundled fonts (no CDN) |
| Orchestration | Docker Compose profiles (`base`, `ai`, `ai-multi`) plus the scale overlay. No Kubernetes |
| Tests | pytest, vitest, Playwright (browser flows), k6 |

---

## Repository layout

```
services/api/          FastAPI: registry, adapters, health monitor, ingest, watchlist, alerts,
                       correlator, anomaly, analytics, persons (in progress), audit
services/ai-worker/    the edge worker: roster, sharding, rotation, back-off, publisher
ai-lab/                the vision pipeline the worker imports, and its accuracy harness
services/simulator/    replays recorded footage as RTSP; load generator
web/                   the command centre
scripts/               capacity_model.py, seed.py, sync_sandbox.py, demo_up.sh, …
tests/                 e2e (pytest), browser (Playwright), load (generator + k6)
docs/                  design, infrastructure, security, requirements, runbooks
deploy/                single-host EC2 staging/main (not on the demo path)
```

---

## Documentation

| Document | Contents |
|---|---|
| [docs/HLD.md](docs/HLD.md) | **The architecture.** Model choice, data flows, database, matching, alerting, tiers, HA/DR, rollout |
| [docs/INFRASTRUCTURE.md](docs/INFRASTRUCTURE.md) | Compute, bandwidth, storage, hardware and costs, from `capacity_model.py` |
| [docs/REQUIREMENTS.md](docs/REQUIREMENTS.md) | Every Sentinel requirement mapped to code, or to a marked gap |
| [docs/SECURITY.md](docs/SECURITY.md) | Controls, retention, lawful use, what is not implemented |
| [docs/DEMO_SCRIPT.md](docs/DEMO_SCRIPT.md) · [docs/PANIC.md](docs/PANIC.md) | The live test, step by step, and what to do when something breaks |
| [docs/research/ANPR_ACCURACY_LATENCY.md](docs/research/ANPR_ACCURACY_LATENCY.md) | Where ANPR time and accuracy go, measured |
| [docs/PERFORMANCE.md](docs/PERFORMANCE.md) · [docs/GPU.md](docs/GPU.md) | The worker's CPU budget; why there is no GPU in Docker on a Mac |
| [docs/API.md](docs/API.md) | Every endpoint, generated from the live OpenAPI document |
| [docs/BUILD_STATE.md](docs/BUILD_STATE.md) | Build history and the evidence behind every number |

**Lineage.** This codebase began as *Sentinel-GJ* for this challenge. It was briefly
re-aimed at SIH26127 (a city-wide brief) under the name *NagarNetra*, and is now back
on Sentinel as **Contrail**. Some identifiers, Redis keys and older documents still
carry the earlier names.

Superseded status documents are marked at the top:

- `docs/STATUS.md`
- `docs/PROGRESS.md`
- `docs/ROADMAP.md`
- `docs/BRIEFING.md`
- `COMPLETE_PROJECT_KNOWLEDGE.md`
- `docs/submission/DECK.md`

---

<div align="center">
<sub>Contrail · Gujarat Police CCTV Hackathon "Sentinel" · no LICENSE file is committed yet; the detector weights are AGPL-3.0 (see docs/SECURITY.md §8)</sub>
</div>
