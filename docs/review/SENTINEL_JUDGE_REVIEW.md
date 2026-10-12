# Contrail: judge's review for Sentinel (Gujarat Police CCTV Hackathon 2026)

| | |
|---|---|
| Reviewed | Branch `sentinel-gj` at HEAD `9cc9cc8` (pushed; `origin/sentinel-gj` = HEAD), **plus the uncommitted working tree**: 82 modified files (+7,630 / −1,386 lines) and about 65 untracked files at review time |
| Date | 12 Oct 2026, sandbox round day 1, 08:30–11:15 IST |
| Method | Read-only review. I read the code and docs directly. I queried the live stack (compose project `contrail`) with `GET`s as the bootstrap admin. Those `GET`s wrote ordinary audit rows, which is the platform working as designed. I captured screens with `tests/browser/shot.mjs` (PNGs in `tests/browser/out/review/`) and ran `scripts/capacity_model.py`. I did not open, focus or probe any `SBX-*` stream. I did not run the test suites, because they raise real alarms on the live screens. |
| Legend | ✅ Done (in code, committed, works) · 🟡 Partial · ❌ Missing · 📄 Doc-only · 🚧 In progress, uncommitted (exists only in this laptop's working tree) |

> **Read this first.** About a third of what makes this entry strong exists only in the
> working tree: persons watchlist, VAHAN/SARTHI/eGujCop/AFIS reference adapters, 26
> departments, gap-report CSV, pursuit mode, candidate sightings, event spool, Prometheus
> exposition and TLS work. That includes Alembic migrations `0009` and `0010`, which **are
> already applied to the live database but are untracked files**. A fresh clone of the
> pushed branch cannot reproduce today's demo, and any submission link points at a commit
> that has none of it. Committing and pushing is P0 item 1.

---

## 1. Architecture summary

### 1.1 What has been built, in plain words

Contrail does not replace any department's cameras or VMS. It **federates** them. It works
in five steps:

1. **Registry and map.** Every camera is registered in one PostgreSQL/PostGIS registry with
   owner, location, protocol and health, and drawn on one MapLibre map with an offline
   GeoJSON basemap.
2. **Adapters.** Cameras get into the registry through adapters: RTSP, ONVIF, vendor-VMS
   REST, the organisers' hosted grid, and a simulated VMS.
3. **Edge AI.** AI workers sit next to the video and read each stream (YOLOv8n vehicles →
   ByteTrack → YOLO11n plates → PP-OCRv4 via RapidOCR → multi-frame consensus). Each
   vehicle becomes a ~2 KB event on a Redis Stream; plate crops go to MinIO.
4. **Central matching.** The central API consumes the events exactly once, matches them
   against the watchlist and raises alerts. It reconstructs routes across cameras, flags
   trajectory anomalies with reasons, and computes traffic insights and a short forecast.
5. **Video only on demand.** Video is pulled only while an operator watches, through
   MediaMTX (WebRTC/HLS) or an authenticated HLS proxy for the grid.

The organising sentence is in the README and HLD, and the code honours it: **"the central
tier carries events, not video."**

### 1.2 The architecture as found in code (not as drawn in the docs)

```
 ORGANISERS' GRID (30 x SBX-*)                       OWN FEEDS
 CDN catalogue (portal login, 1 session/IP)          simulator (services/simulator) replays
 RTSP/WHEP direct on 103.250.160.189                 anpr_demo.mp4 -> CAM-DEMO-01 (UK plates)
 HLS on CDN                                          persons_demo.mp4 -> CAM-DEMO-02
     |  catalogue JSON          | RTSP                     | RTSP publish
     v                          |                          v
 +------------------------+     |              +----------------------------+
 | ingest container       |     |              | MediaMTX 1.20.1            |
 | app/ingest/monitor.py  |     |              | sourceOnDemand, WHEP/HLS   |<--- browser (WebRTC/HLS)
 | health_monitor.sweep   |     |              +-------------+--------------+
 | adapters/*: RTSP,ONVIF,|     |                            | RTSP
 | VendorVms, HostedGrid, |     v                            v
 | Simulated              |  +------------------------------------------------------+
 +-----------+------------+  | ai-worker x3  (services/ai-worker, imports ai-lab/ailab)|
             |               | roster from registry, hash shard, 2 slots/worker,       |
             |               | 45 s rotation, focus (on-screen camera first), back-off  |
             |               | decode -> YOLOv8n@640 -> ByteTrack -> YOLO11n@320 plate  |
             |               | -> RapidOCR PP-OCRv4 -> consensus -> event (+faces on    |
             |               | CAM-DEMO-02 only: YuNet+SFace)  [disk spool: in progress]|
             |               +------+-----------------------------+-------------------+
             |                      | ~2 KB event                 | plate crop JPEG
             |                      v                             v
             |         Redis 7 Stream nagarnetra:events:detections     MinIO (bucket public-read!)
             |                      |
             v                      v
 +--------------------------------------------------------------------------------+
 | api (FastAPI :8000)   EventConsumer (group, exactly once) -> detections         |
 |   watchlist match -> alerts -> Redis pub/sub -> EventTailer (every replica) ->  |
 |   /ws/events | correlator (routes, legs, flags) | anomaly (reasons) | analytics |
 |   predictions | reports CSV | audit | RBAC | registries (reference data) |      |
 |   persons | pursuit | candidates | grid HLS proxy /api/v1/grid                  |
 +-------------------------------------+------------------------------------------+
                                       |
          PostgreSQL 16 + PostGIS + TimescaleDB (hypertables: detections, camera_health)
          OpenSearch 2.19 (running, health-probed, indexes nothing)
                                       |
 web (nginx + React/Vite, :8080): Command | Live | Investigate (+Registries) | Alarms (+Watchlist,
 Persons) | Network (Map, Cameras, Fleet health) | Insights | Admin (Users, Audit)
```

Topology facts that matter on the day:

- Everything runs on one laptop: 12 containers in `docker-compose.yml`, plus a scale overlay
  in `docker-compose.scale.yml` with 3 consumer replicas.
- The "edge" is logical. The workers run in the same Compose project, not on a separate box.
- No Kubernetes, Kafka/Redpanda, Prometheus or Grafana container exists. Prometheus and
  Grafana configs are 🚧 untracked files in `infra/prometheus/` and `infra/grafana/`, not wired
  into Compose. The Redpanda backend is only a settings seam (`event_bus_backend`); no Kafka
  client is written.
- `packages/contracts/` holds a single `.gitkeep`. The event schema is hand-written in
  `ai-lab/ailab/stream/events.py`.

**Tech stack (verified):**

| Layer | Stack |
|---|---|
| API | FastAPI / Python 3.11, SQLAlchemy 2 async, Alembic (migrations `0001`–`0008` committed, `0009`–`0010` 🚧) |
| Database | PostgreSQL 16 + PostGIS 3.6 + TimescaleDB 2.29 (`/ready` reports the versions) |
| Bus and objects | Redis 7.4 Streams; MinIO |
| Media | MediaMTX 1.20.1 |
| AI | ONNX Runtime 1.29 + OpenCV, torch-free |
| Web | React 18 + Vite + Tailwind + MapLibre + Recharts |
| Tests | pytest, vitest, Playwright, k6 |
| CI | `.github/workflows/ci.yml` |

### 1.3 Which reference models the hybrid takes from

The entry presents itself as **Model 1 + Model 3 + selective Model 2 + edge AI, rejecting
Model 4 by arithmetic** (`docs/HLD.md` §2). The code bears that out.

The percentages below are my weighted scoring of the per-requirement rows in §2. Each row
scores ✅ = 1, 🟡 = 0.3–0.8 depending on the gap, ❌/📄 = 0–0.2. 🚧 items get partial credit.

| Model | Coverage | What is taken | What is not |
|---|---|---|---|
| **1. Registry + GIS** (compulsory) | **≈ 75%** | Onboarding by form, CSV with dry run, API client and VMS sync; GIS with filters and offline basemap; health monitor; gap analysis; audit; RBAC | No Excel; thin metadata (no storage, infrastructure or maintenance fields); gap geography is Ahmedabad wards, not Gujarat districts; no ageing analysis; no department-scoped RBAC; no registry export |
| **2. Direct unified viewer** | **≈ 70%** | RTSP pull through MediaMTX, WebRTC/HLS, ANPR, camera-wise indexed searchable events, alerts | No video wall (deliberate: the grid has a watch quota). ONVIF and vendor SDKs tested only on fixtures. Redis instead of Kafka. OpenSearch unused |
| **3. Federation middleware** | **≈ 75–80%** | Adapter architecture (5 camera adapters + 4 registry adapters 🚧), event bus, cross-camera correlator, unified alarm workflow | Only two systems are federated live (grid + own simulator). No live multi-camera correlation in the DB. No API gateway with keys. Redis instead of Kafka/RabbitMQ |
| **4. Central VMS** | **≈ 45%** | The analytics half: ANPR, vehicle counting, trajectory anomaly, statewide tracking, faces 🚧, VAHAN/SARTHI/eGujCop/AFIS readiness 🚧, S3, Timescale, edge | Rejected by design: central ingest, recording and playback. Missing: crowd counting, DR, encryption, network segmentation, Kubernetes, GPU (never run) |
| **5. Hybrid (claimed)** | **≈ 70% overall** | A coherent and well-argued hybrid. The strongest parts are federation, honesty about evidence, and the bandwidth argument | Security hardening, DR and the HLD's missing sections pull it down |

---

## 2. Feature compliance matrix

All API paths are under `services/api/app/` and all screens under `web/src/`, unless a path
says otherwise. "Live" means I verified it against the running stack.

### 2.1 Model 1: Central CCTV Registry + GIS (compulsory)

| Requirement | Status | Evidence | Notes |
|---|---|---|---|
| Bulk import, CSV | ✅ | `POST /api/v1/cameras/bulk` → `routers/cameras.py:bulk_upload` → `services/camera.py:bulk_upload` (row-level errors, `dry_run`); UI "Import CSV" in `pages/Cameras.tsx` | Sample with a deliberately bad row: `data/seed/sample_cameras.csv` (4 rows; one sits at London coordinates) |
| Bulk import, Excel | ❌ | `services/camera.py:539` decodes UTF-8 CSV only (tolerates the Excel BOM); the UI accepts `.csv` only (`pages/Cameras.tsx:1133`) | "Save as CSV" works, but the brief says CSV/Excel |
| Manual entry | ✅ | `POST /api/v1/cameras` (`routers/cameras.py:create_camera`); "Onboard camera" form | Audited (`camera.create`) |
| API-based onboarding | ✅ | `api_client` role holding only `camera.create` (`core/rbac.py`); OpenAPI at `/docs` | |
| Federated onboarding from a VMS | ✅ | `POST /api/v1/vms/{id}/sync` (`routers/fleet.py:sync_vms`); `scripts/sync_sandbox.py` via `adapters/sandbox.py:HostedGridAdapter.list_cameras` | 30 grid cameras onboarded (live `GET /api/v1/vms`) |
| Metadata: location, department, camera type, ownership, connectivity | 🟡 | `models/registry.py:Camera` (PostGIS point, department, VMS, protocol, stream URLs, type, status, resolution, fps, heading, `installed_on`, tags) | **Live: 27 of 32 cameras have no department.** The grid catalogue carries only id and name, and the sync refuses to guess (`scripts/sync_sandbox.py:owner_of`). `installed_on`, resolution and fps are NULL on all 30 grid cameras |
| Metadata: storage details, infrastructure info | ❌ | No retention, NVR, storage, power, network-link, pole or AMC/maintenance fields in `models/registry.py` or any migration | Named explicitly in the brief |
| Interactive GIS map | ✅ | `pages/MapView.tsx`, `components/CameraMap.tsx`, `pages/Dashboard.tsx` + `components/CommandMap.tsx`; offline GeoJSON basemap with optional Esri satellite | Screenshot `tests/browser/out/review/map.png` |
| Layer: department | ✅ | Department filter (`pages/MapView.tsx`) | |
| Layer: status | ✅ | Status filter and legend | |
| Layer: camera type | 🟡 | Only a "plate reading only" toggle and an integration filter; no fixed/PTZ/ANPR type filter (`grep camera_type pages/MapView.tsx` finds nothing) | |
| Layer: coverage | 🟡 | "Detection density" heatmap (`/api/v1/analytics/heatmap`) | No coverage layer: no field-of-view, no district coverage shading |
| Positions | 🟡 | 26 of 32 "placed", but **at town centroids** (`placement:city`). All 9 Ahmedabad grid cameras share one point (23.0225, 72.5714). 6 cameras, including SBX-cam22 (the best plate reader), have no position | The map is honest about this (`map.png`: "6 without a position"), but the routes it can draw are degenerate (§3) |
| Spatial queries | ✅ | `/cameras/geojson`, `/cameras/nearby`, `/cameras/in-district/{district}` (`services/camera.py:find_nearby`, `find_in_district`) | |
| Health and maintenance monitoring | 🟡 | `ingest` container → `services/health_monitor.py:sweep` → `camera_health` hypertable → `camera_down` alert, auto-closed; `GET /api/v1/health/fleet`; `pages/FleetHealth.tsx` | Works for own cameras (19 s to offline, team-measured). **For the grid it measures the catalogue login, not the cameras.** Live, the fleet flaps between 32 online and 30 degraded or unknown, and "Integration unreachable: Hosted Camera Grid" `camera_down` alerts are raised and auto-closed every few minutes (15 between 07:39 and 09:00 IST; §5.3). No maintenance status or ticket field |
| Gap analysis: uncovered zones | 🟡 | `services/fleet.py:gap_analysis`; `GET /api/v1/health/gaps`; 🚧 `GET /api/v1/reports/gaps.csv` (`routers/gap_report.py`) | **Uncovered zones are computed against a hard-coded set of 7 Ahmedabad city talukas** (`services/fleet.py:355-363`, `CITY_TALUKAS`), which is residue from NagarNetra. Live output: "no cameras in Asarva, Daskroi, Ghatlodiya, Maninagar, Vatva, Vejalpur". Meanwhile 24 of Gujarat's 33 districts have no camera at all and are not reported. `data/seed/gujarat_districts.geojson` is in the repo |
| Gap analysis: ageing infrastructure | ❌ | `installed_on` is never read by `services/fleet.py` or `routers/gap_report.py` | |
| Role-based search and filtering | ✅ | Six roles in one matrix (`core/rbac.py`); `search.execute` gates plate search; an auditor cannot search; camera filters in `services/camera.py:apply_filters` | |
| Department-wise RBAC (suggested stack) | ❌ | `users.department_id` exists (`models/security.py:58`), but **no query is scoped by it** (only `routers/auth.py` echoes it) | Every role sees every department's cameras, alerts and searches |
| Export | 🟡 | CSV exports: vehicle route (`routers/reports.py:vehicle_report_csv`), plate reads (`plates_report_csv`), gaps 🚧, audit (`routers/audit.py`) | **No registry export** (no cameras CSV or XLSX) |
| Metadata audit trail | 🟡 | `middleware/audit.py`, `services/audit.py`; `camera.update` records which fields changed (`routers/cameras.py:418-428`); `pages/AuditLog.tsx`; tested in `tests/test_audit.py` | Field names are recorded, not old→new values. `audit_log` has no tamper evidence (no hash chain, no trigger, no REVOKE) |
| Suggested stack | ✅ | PostgreSQL + PostGIS, React, FastAPI; MapLibre GL in place of Leaflet/OpenLayers | |
| **Deliverable:** registry portal with GIS map | ✅ | `/cameras`, `/map`, `/health` | |
| **Deliverable:** bulk + manual onboarding demo | ✅ | `docs/DEMO_SCRIPT.md` §2.2 (CSV "Validate only" with one rejected row) | |
| **Deliverable:** sample metadata dataset | 🟡 | `data/seed/sample_cameras.csv` (4 rows), `data/seed/cameras.csv` (2 rows) | Thin. Nothing near 50 rows with full metadata |
| **Deliverable:** registry API docs | ✅ | `docs/API.md` (generated from OpenAPI), live `/docs` | **`/docs` is titled "NagarNetra" and `GET /` says "City-wide … SIH26127"** (`main.py:66-78, 267-279`) |
| **Deliverable:** sample gap-analysis report | 🟡 | Endpoint and download button exist (🚧 CSV) | No sample committed, and its geography is wrong (above) |

### 2.2 Model 2: Direct unified viewer

| Requirement | Status | Evidence | Notes |
|---|---|---|---|
| Feed aggregation over RTSP | ✅ | `adapters/rtsp.py`; MediaMTX `sourceOnDemand` (`services/gateway.py`); grid RTSP straight into the workers | |
| ONVIF | 🟡 | `adapters/onvif.py` (Device and Media SOAP) | Unit-tested on fixtures (`tests/test_adapters.py`), never run against a device |
| Vendor SDKs and APIs | 🟡 | `adapters/vendor.py:VendorVmsAdapter` (Milestone, Genetec, CP Plus and Hikvision field vocabularies) | Fixtures only |
| ANPR metadata generation | ✅ | `ai-lab/ailab/` (detect, `track/bytetrack.py`, `plate/`, `ocr/rapid.py`, `aggregate/consensus.py`, `aggregate/grammar.py`); `services/ai-worker/ai_worker/worker.py` | Runs live. Accuracy is not established: 61.7% exact as shipped and 83.3% with raw crops on 60 AI-labelled grid crops (`docs/research/ANPR_ACCURACY_LATENCY.md` §3). The raw-crop fix is 🚧 (`ai-lab/configs/stream.yaml`) and is loaded by the workers restarted at 11:03 IST |
| Event tagging, camera-wise indexing | ✅ | `detections` hypertable keyed by camera and time; `GET /api/v1/detections?camera_id=&since=&plate=` (`routers/detections.py`) | |
| Searchable vehicle-movement records | ✅ | `GET /api/v1/vehicles/search` (pg_trgm), `/vehicles/{plate}/route`, `pages/VehicleSearch.tsx` (⌘K) | |
| Configurable video wall / multi-camera grid | ❌ (deliberate) | `pages/LiveAnpr.tsx:10-27`: one camera on a stage, the rest in a rail | Justified by the grid's per-IP watch quota and CPU. Explain it; do not hide it |
| Alerts for tagged events and vehicles of interest | ✅ | `services/watchlist.py:WatchlistIndex.match` (exact, or one-edit capped at medium) → `services/alerts.py:raise_for_match` → pub/sub → `/ws/events` | Live: a browser-E2E watchlist alarm fired at 11:05 IST today |
| Stack: WebRTC/HLS relay | ✅ | MediaMTX WHEP + LL-HLS; grid HLS proxied by `routers/grid_media.py` | |
| Stack: Kafka | ❌ | Redis Streams with a consumer group (`services/event_consumer.py`) | A defensible substitute. Redpanda is a seam only (HLD §13) |
| Stack: Elasticsearch | 🟡 | OpenSearch 2.19 runs, but only `routers/health.py` touches it. Search is `pg_trgm` | |
| **Deliverable:** unified viewer with feeds from 2+ different systems | ✅ / 🟡 | Hosted grid (`HostedGridAdapter`) + own simulator VMS (`SimulatedVmsAdapter`); live `GET /api/v1/vms` | The "own" system is a replayed clip, not a second real VMS |
| **Deliverable:** ANPR demo | ✅ | CAM-DEMO-01 recorded clip (continuous); grid cameras SBX-cam10/21/22 | The demo clip shows **UK plates** (`data/videos/ATTRIBUTION.md`), named "Paldi — Ashram Road" at real Ahmedabad coordinates |
| **Deliverable:** searchable metadata dashboard | ✅ | `/vehicles`, `/traffic`, `/dashboard` | |
| **Deliverable:** note proving departmental systems are unaffected | 🟡 | HLD §2.2 / §5.2; `docs/SECURITY.md` §6 ("consumes and never publishes") | Argued across documents; no single note. One page would close it |

### 2.3 Model 3: Federation middleware

| Requirement | Status | Evidence | Notes |
|---|---|---|---|
| Adapter/plugin architecture for VMS vendors | ✅ | `adapters/base.py:CameraAdapter`, `adapters/__init__.py` (5 adapters); live `GET /api/v1/integration/adapters` | "Adding a vendor is one class plus one registry entry" |
| Metadata exchange bus | ✅ | Redis Stream `nagarnetra:events:detections`; fleet roster and persons gallery over Redis (`services/fleet_roster.py`) | No schema contract: `packages/contracts/` is empty |
| Cross-system event-correlation engine | 🟡 | `services/correlator.py` (`cluster_into_hops`, `score_legs` with `co_located`, `impossible_simultaneous`, `implausible_speed`, `heading_conflict`, `unobserved_gap`); `services/anomaly.py:evaluate_new_hops`; convoys (`/vehicles/{plate}/convoy`); 🚧 `services/candidates.py`, 🚧 `services/pursuit.py` | Code is solid and tested. **Live: `GET /api/v1/vehicles/routable` returns no plate seen at ≥2 cameras, either in 24 h or since 1 Sep**, so no cross-system correlation is on record |
| Unified workflow and alert dashboard | ✅ | `pages/Alerts.tsx` (severity triage, `j/k/a/d/c/f`); `services/alerts.py:transition` with separate grants | Screenshot `alerts.png` |
| Extensible connector framework | ✅ | Camera adapters, plus 🚧 registry adapters behind `adapters/registries/base.py` with one-line swap in `registries_for` | |
| Stack: Kafka/RabbitMQ | ❌ | Redis Streams | As in §2.2 |
| Stack: Kong/NGINX gateway | 🟡 | nginx in `web` proxies `/api/` and `/ws/` (`web/nginx.conf:74-94`); Redis rate limiting (`core/ratelimit.py`) | The bundle still calls `http://localhost:8000` directly (§5.3). No API keys or gateway policy |
| Stack: PostgreSQL + Redis, React | ✅ | | |
| **Deliverable:** middleware federating 2+ systems | ✅ / 🟡 | Grid + simulator live; ONVIF and vendor adapters on fixtures | |
| **Deliverable:** event-correlation dashboard | 🟡 | Investigate route view, "Journeys" tab in Insights, Command "contrails" | Currently empty of multi-camera journeys (`dashboard.png`: "No vehicle seen at two cameras in 24 h") |
| **Deliverable:** adapter architecture docs | ✅ | HLD §4, §5.1; module docstrings in `adapters/` | No standalone "write an adapter" guide |
| **Deliverable:** sample federated analytics report | 🟡 | `GET /api/v1/reports/plates.csv`, `/reports/vehicle/{plate}.csv`, printable `pages/VehicleReport.tsx`, 🚧 `gaps.csv` | No sample output committed to `docs/submission/` |

### 2.4 Model 4: Central VMS (rejected by design; credit is for the analytics half)

| Requirement | Status | Evidence | Notes |
|---|---|---|---|
| Centralised feed ingestion | ❌ (by design) | Selective on-demand pull only | The rejection is argued in HLD §2.2: 320 Gbps vs 43.7 Mbps |
| Recording and playback | ❌ | MediaMTX `record: no` (`infra/mediamtx/mediamtx.yml:135`); `VendorVmsAdapter.get_recording` exists (`adapters/vendor.py:309`) but **no route or screen calls it** | "Playback stays in the department's VMS" is the right story, but nothing demonstrates it |
| Tiered hot/warm/cold storage | 🟡 | Timescale hypertables, retention sweeper (`services/retention.py:sweep`); 🚧 crop expiry (`retention.py:expire_crops`) | No compression or tiering. Design in HLD §12 |
| ANPR | ✅ | §2.2 | |
| Face recognition | 🚧 | `ai-lab/ailab/face/` (YuNet + SFace), `routers/persons.py`, `services/persons.py`, migration `0009`, `pages/Persons.tsx` | Works live on CAM-DEMO-02 stock footage, with four-eyes approval and audit (`persons.png`, `alerts.png`). All untracked |
| Crowd counting | ❌ | Not found | Person-class counts from the same detector would be an easy start |
| Vehicle counting | ✅ | `routers/analytics.py` (`/analytics/traffic`, `/flow`, `/heatmap`, `/hotspots`), `services/traffic.py` | **93% of "vehicles observed" (49,034 of 52,787 in 24 h) come from the 15 s looping clip on CAM-DEMO-01**, which Insights rates "severe" congestion (`traffic.png`) |
| Anomaly detection | ✅ | `services/anomaly.py` (rare, slow or fast transition, impossible hop), with `alerts.reasons` (migration `0005`) | Recorded footage is excluded from verdicts (`anomaly.py:_without_recordings`) |
| Statewide vehicle tracking and route reconstruction | 🟡 | `GET /api/v1/vehicles/{plate}/route`; `services/route_history.py` | Code ✅. Live evidence ❌ (no multi-camera plate). Grid positions are town-level |
| Integration readiness: VAHAN, SARTHI, eGujCop, AFIS, NAFIS | 🚧 | `adapters/registries/` (abstract + `reference.py`), `routers/registries.py`, `services/registry_checks.py`, migration `0010`, `data/seed/registries/*.csv`, `pages/Registries.tsx`, `components/RegistryCard.tsx` | Live `GET /api/v1/registries/vehicle/GJ03AB1234` returns `source: reference` with clear provenance text. This is **labelled fictional reference data**, the honest way to show readiness. NAFIS is folded into AFIS |
| Redundancy and DR | 📄 | HLD §13, INFRASTRUCTURE §8 | Single instances; no backups. 🚧 hardening agent reports backups in progress |
| Encryption | ❌ / 🚧 | No TLS today (`deploy/nginx/nagarnetra-edge.conf` listens on 80); 🚧 HTTPS :8443 (`core/public_origin.py`) was not answering at review time; no at-rest encryption. `core/crypto.py` seals credential values only | |
| Network segmentation | ❌ | Not found in any doc. Postgres, Redis, MinIO, OpenSearch and the MediaMTX API are published on all interfaces (§5.2) | |
| RBAC | 🟡 | Role-based ✅, department-scoped ❌ | |
| Stack: S3/Ceph | ✅ | MinIO | |
| Stack: Kafka + GPU inference | ❌ / 📄 | Redis; `device: auto/cpu/cuda/coreml` is wired but GPU never run (`docs/GPU.md`) | |
| Stack: PostgreSQL/TimescaleDB | ✅ | | |
| Stack: Kubernetes | ❌ | Not found; Compose only | |
| Stack: edge support | ✅ | Hash-sharded workers (`ai_worker/discovery.py`), back-off (`ai_worker/backoff.py`), 🚧 store-and-forward spool (`ai_worker/publisher.py`, `ai-worker-spool` volume) | |
| **Deliverable:** central VMS prototype with multi-department feeds | ❌ (by design) | | |
| **Deliverable:** ANPR + multi-location tracking demo | 🟡 | ANPR yes; multi-location not yet observed on live data | |
| **Deliverable:** scalability / load-test report for ~80,000 cameras | ✅ / 🟡 | `tests/load/run_load_test.py`, `tests/load/results/load-20260905T064430.json`, `latest.md`; `scripts/capacity_model.py`; `docs/INFRASTRUCTURE.md` | Ingest-only (no inference). The p95 of 5.7 s missed the 3 s target. `latest.md` contradicts itself on the backlog (Appendix A) |
| **Deliverable:** DR design | 📄 | HLD §13 (Patroni, WAL-G, MinIO replication, RPO 15 min / RTO 1 h as untested targets) | |
| **Deliverable:** security architecture doc | ✅ / 🟡 | `docs/SECURITY.md` | Good on identity, audit and lawful use. Silent on the exposures in §5.2; §8 is stale |

### 2.5 Mandatory test case

| Step | Status | Evidence | Notes |
|---|---|---|---|
| 1. Onboard ~50 cameras | 🟡 | 32 registered: 30 grid via `HostedGridAdapter` and 2 recorded clips (live `/cameras/summary`) | 18 short. 27 have no department. The runbook still says 31 (`docs/DEMO_SCRIPT.md:75`) |
| 2. Integrate live feeds | 🟡 | Grid RTSP into the workers; HLS proxy for viewing | At 11:10 IST, after the 11:02 restart, worker 1 was "analysing 0 of 8 cameras, 0 streams open", worker 2 had SBX-cam21 "dropped; reconnecting (attempt 6)", and the dashboard showed "Feeds answering 2 / 32" (`dashboard.png`). This depends entirely on the grid's tolerance |
| 3. Track a vehicle | 🟡 | `GET /api/v1/vehicles/{plate}/route`; ⌘K → Investigate; 🚧 Pursue, 🚧 "Possibly the same vehicle" | **Zero plates seen at ≥2 cameras in the live DB.** The best grid reader, SBX-cam22, has no position. All Ahmedabad cameras sit on one point |
| 4. Alerts and history | ✅ | Watchlist → alert → `/ws/events` (24 ms team-measured; 7 s on the clip loop); alarm lifecycle; audit | Queue noise from grid `camera_down` flaps and repeating person-match alarms on the persons clip |
| 5. Visualise on GIS | ✅ / 🟡 | `/map`, `/dashboard`, route map in `/vehicles` | Town-level placement |
| 6. Route, movement history, searchable events | ✅ code / 🟡 evidence | Route + CSV + printable report; `/reports/plates.csv`; fuzzy "close to what you typed" (`vehicles_plate_GJ08R6705.png`) | |

### 2.6 Required submission items

| Item | Status | Evidence | Notes |
|---|---|---|---|
| Solution presentation (PPT/PDF) | ❌ | Not found (no `.pptx`, `.pdf` or `.key` in the repo). `docs/submission/DECK.md` is 20 slides of **NagarNetra** content under a "Corrections before this deck is built" banner | Must be built and exported today |
| High-level design document | ✅ / 🟡 | `docs/HLD.md` (794 lines, Contrail-branded, honest labels) | Markdown only. Missing sections listed in §2.7 |
| Own-feed demonstration | 🟡 | CAM-DEMO-01 (recorded UK-plate clip), CAM-DEMO-02 (stock persons clip) via the simulator | No live camera of the team's own. A phone or IP camera on a Gujarat road, onboarded by the form, would make this real |
| Government-feed demonstration | 🟡 | 30 grid cameras federated; reads on SBX-cam10/21/22 | Works when the grid lets us in |
| Video | ❌ | `docs/submission/VIDEO_SCRIPT.md` only | |
| Output report | 🟡 | Plate-read CSV, vehicle CSV and printable report, gap CSV 🚧 | No sample outputs committed |
| Submission links | ❌ | Not found. The pushed branch lacks all 🚧 work | |
| Architecture diagrams | 🟡 | `docs/submission/architecture.svg/.png`, `workflow.svg/.png` (12 Sep) | **Branded "NagarNetra"** |

### 2.7 HLD coverage (`docs/HLD.md`, `docs/INFRASTRUCTURE.md`, `docs/SECURITY.md`)

| Required HLD section | Status | Where | Notes |
|---|---|---|---|
| Overall architecture | ✅ | HLD §3, §4 (Mermaid) | |
| Integration strategy | ✅ | HLD §5.1, §5.2; REQUIREMENTS §10 | |
| AI and video analytics | ✅ | HLD §5.4, §7, §9, §15.3; `docs/research/ANPR_ACCURACY_LATENCY.md` | The research doc is a standout |
| Cybersecurity architecture | 🟡 | HLD §16, `docs/SECURITY.md` | No zones, segmentation, edge↔centre mTLS/IPsec or key management; TLS absent; §8 stale |
| Deployment architecture | ✅ | HLD §10 (site, region, state, DR) | No Kubernetes or production manifests |
| Sizing: hardware and software | ✅ | INFRASTRUCTURE §3, §7; `capacity_model.py` | Apple-Silicon constants; no x86 measured |
| Sizing: network and bandwidth | ✅ | INFRASTRUCTURE §5; HLD §11 | |
| Sizing: storage and retention | ✅ | HLD §12; INFRASTRUCTURE §6 | |
| Sizing: AI processing capacity | ✅ / 🟡 | INFRASTRUCTURE §2–4; research §2 | GPU extrapolated |
| Disaster recovery | 📄 | HLD §13; INFRASTRUCTURE §8 | No backups (🚧 hardening) |
| Statewide rollout plan | ✅ | HLD §17 (gated stages) | |
| Cost-benefit analysis | 🟡 | INFRASTRUCTURE §7 (capex and opex); HLD §2.2 (one paragraph) | Costs, but no benefit side (what investigators gain, avoided Model 4 cost, avoided WAN) |
| Department-wise information requirements | ❌ | Not found anywhere in `docs/` | 26 departments seeded 🚧 (`scripts/seed.py:128-151`), but no matrix of what each department needs, sees and shares |
| Scalability strategy | ✅ | HLD §13, §15, §17 | |
| Future roadmap | 🟡 | HLD §17 gates, §18 gaps | No roadmap section. §18 is stale against the 🚧 work |

### 2.8 Evaluation criteria

| Criterion | Readiness | Why |
|---|---|---|
| Successful test case | 🟡 | Steps 4–5 are solid; 1–3 and 6 hinge on the grid and on camera placement (§3) |
| PPT/PDF presentation | ❌ | Not built |
| Solution architecture | ✅ | One of the strongest parts: hybrid argued by arithmetic, honest labels |
| Working demonstration | ✅ / 🟡 | Rich, polished UI; fragile on grid availability |
| Analytics quality | 🟡 | Strong design (reasons, labelled gaps, forecast backtest), but Insights is dominated by a looping clip |
| Scalability and PoC readiness | ✅ / 🟡 | Measured ingest at 80k identities; computed sizing; no HA, DR, TLS or Kubernetes |
| Bonus | ✅ | Hybrid, edge processing, cross-camera tracking, explainable anomalies, audit, faces with four-eyes 🚧, registries 🚧, pursuit 🚧 |

---

## 3. Test-case readiness (walked as a judge would)

State at 11:15 IST, about 13 minutes after the lead restarted the stack:

- `GET /api/v1/health/fleet`: 2 online, 30 unknown, availability 6.2%.
- Worker 1: "analysing 0 of 8 camera(s) … 0 streams open".
- The ingest log shows `grid.session_refused_again … another session holds this address` and a
  `403 Forbidden` from `cctv.corp8.cloud/api/ingest`.

**The grid was refusing us when I last looked.** `docs/PANIC.md` §2a expects 2–15 minutes of
this after any restart. Every step below that touches the grid inherits that risk.

### Step 1: Onboard ~50 cameras (target 2 min)

| | |
|---|---|
| Demo | `http://localhost:8080/cameras` (registry, "Source: Grid 30 / Recorded clip 2"), then **Import CSV → Validate only** with `data/seed/sample_cameras.csv` (3 valid, 1 rejected with a reason), then **Onboard camera** for manual entry. Federated sync dry run: `docker compose exec -T api python /app/scripts/sync_sandbox.py --dry-run` (reads the catalogue only) |
| Runs end to end? | Yes, mechanically |
| What breaks | **32, not ~50.** "Different departments" is weak: by-department shows **UNASSIGNED 27/32** (`health.png`). Grid positions are town centroids |
| Judge's verdict today | Federation onboarding is impressive. Count and department attribution look thin |

### Step 2: Integrate live feeds (target 2 min)

| | |
|---|---|
| Demo | `http://localhost:8080/anpr?camera=CAM-DEMO-01` (own, recorded). For grid cameras, use the runbook's always-on picks (SBX-cam10/21/22), one at a time. **Reviewer did not open any** |
| Runs end to end? | Own feed: yes. Grid: only when the grid accepts our session |
| What breaks | The command tile reads **"Feeds answering 2 / 32, 30 state unknown"**, in red. Fleet Health lists all 30 grid cameras as "Unreliable, ~42.9% uptime", because the monitor probes the catalogue login (§5.2). Alarms carries "Integration stopped answering" |
| Judge's verdict today | Risky. The interoperability story is good (HLS proxy, credentials kept server-side, H.264 and HEVC), but the screen says "mostly down" |

### Step 3: Track a vehicle (the scored task, target 4 min)

| | |
|---|---|
| Demo | ⌘K → plate → `http://localhost:8080/vehicles?plate=<PLATE>`; window 24 h / 7 d; **Pursue** (🚧, pins up to 2 predicted cameras); **Possibly the same vehicle** (🚧 candidates, include or dismiss, audited); **CSV**; **Printable report**. API: `GET /api/v1/vehicles/<PLATE>/route`, `GET /api/v1/reports/vehicle/<PLATE>.csv` |
| Runs end to end? | The software does. **The evidence does not exist yet**: `GET /api/v1/vehicles/routable` returns `[]` for 24 h and since 1 Sep. No plate has been read at two cameras |
| What breaks | (a) Coverage: 3 workers × 2 inference slots, 45 s rotation, so most grid cameras are analysed a fraction of the time (`docker-compose.yml:419-431`). (b) Yield: 11–20% of four-wheelers at night, 0% of two-wheelers (research §3.1). (c) Geography: SBX-cam22, the best reader, has **no position**, so its reads land under "Not on the map" (`vehicles_plate_GJ08R6705.png`). The 9 Ahmedabad cameras share one point, so any Ahmedabad leg is flagged `co_located` with no distance or speed (`services/correlator.py:score_legs`). (d) The pursuit predictor and candidate scorer lean on positions, so they inherit (c) |
| Judge's verdict today | The UI handles absence honestly ("not evidence the vehicle was absent"), but if the designated plate is read once or never, the scored moment is lost |

### Step 4: Generate alerts and history (target 2.5 min)

| | |
|---|---|
| Demo | **Alarms → Watchlist → Add a plate** being read on CAM-DEMO-01 (stolen, critical, case `DEMO/FIR/2026/LIVE`); wait for the clip to loop; **Alarms** detail ("Why it fired", crop, registry card 🚧); triage `a/d/c`; **Admin → Audit trail**. Fallback: `docker compose exec -e NAGARNETRA_API_URL=http://api:8000 api python /app/scripts/demo_anpr.py` |
| Runs end to end? | **Yes.** Verified indirectly: a browser-E2E watchlist alarm was raised and closed at 11:05 IST |
| What breaks | Queue noise: 812 alerts in the DB. Of the latest 400, 348 are closed trajectory anomalies (artefacts of earlier demo cameras sharing one clip) and 42 are grid `camera_down` flaps. CAM-DEMO-02's looping clip re-raises "Possible person match" (two within six minutes of the 11:03 restart; three open at 11:09, `alerts.png`). Watchlist alerts have `reasons = null`; only anomaly and person alerts carry structured reasons |
| Judge's verdict today | Strong |

### Step 5: Visualise on GIS (target 1 min)

| | |
|---|---|
| Demo | `http://localhost:8080/map` (filters, Offline/Satellite), `http://localhost:8080/dashboard` |
| Runs end to end? | Yes, with no internet needed (offline basemap) |
| What breaks | Points are towns, not junctions. "Coverage" means a detection heatmap, not coverage |
| Judge's verdict today | Good, and honest about unplaced cameras |

### Step 6: Route, movement history and searchable events (target 1.5 min)

| | |
|---|---|
| Demo | Investigate → **Export plate reads (CSV)** (`/api/v1/reports/plates.csv`); per-vehicle CSV and printable report; "Close to what you typed" fuzzy matches |
| Runs end to end? | Yes for single-camera histories. Multi-camera routes need step 3 to succeed first |
| Judge's verdict today | Good tooling; content depends on step 3 |

---

## 4. Strengths: what will impress judges

1. **The architecture choice is argued with numbers, not adjectives.** 320 Gbps vs 43.7 Mbps
   (7,324×), and 24–52 PB of central video avoided, computed by `scripts/capacity_model.py` with
   every constant's provenance printed (`--provenance`). A pure Model 4 team cannot answer the
   bandwidth question. A pure Model 2 team cannot answer the "statewide registry" question.
2. **Real federation against the organisers' own grid.** `HostedGridAdapter`
   (`adapters/sandbox.py`) handles:
   - two hosts: CDN catalogue and HLS versus direct RTSP and WHEP;
   - a changing id scheme, stored as a `grid-id:` tag;
   - catalogue login and one-session-per-IP;
   - watch-quota back-off (`ai_worker/backoff.py`);
   - an authenticated HLS proxy, so grid credentials never reach the browser (`routers/grid_media.py`).

   That is genuine interoperability engineering under hostile conditions.
3. **Edge AI split cleanly from central intelligence.** Workers publish events and nothing
   else. Matching, alerts and storage are central. Consumer-group ingest scales by replicas
   and is measured at **2,774 events/s for 80,000 camera identities, 0 failures**
   (`tests/load/results/load-20260905T064430.json`).
4. **Explainable, humane analytics.**
   - Trajectory anomalies carry `reasons` (`services/anomaly.py`, migration `0005`) and are
     called "Journey to explain", never "suspicious".
   - Recorded footage is excluded from verdicts.
   - Near matches are capped at medium and labelled.
   - Route legs that fail plausibility are flagged, never dropped (`services/correlator.py:score_legs`).
5. **Privacy and audit taken seriously.**
   - Every plate search, stream open and watchlist change is audited, and so is reading the
     audit log.
   - An auditor cannot search.
   - Stream tokens are camera-scoped.
   - The persons watchlist has four-eyes approval enforced in API and DB, expiry, no storage of
     non-matching faces, and a human confirms every match (`docs/SECURITY.md` §7.1; `persons.png`).
6. **Government-integration readiness done honestly** 🚧. VAHAN, SARTHI, eGujCop/CCTNS and
   AFIS sit behind abstract registry interfaces with a one-line swap (`adapters/registries/`).
   Every answer is stamped `source: reference` with provenance text. Judges asked for
   readiness, and this shows it without faking a government API.
7. **Investigator UX beyond OCR.**
   - ⌘K plate search.
   - Fuzzy "close to what you typed".
   - "Possibly the same vehicle" candidates with include/dismiss and audit 🚧.
   - Pursuit mode, which predicts the next cameras and pins them for analysis 🚧.
   - Printable route report.
   - Keyboard triage.
8. **Measurement culture.** `docs/research/ANPR_ACCURACY_LATENCY.md` is unusually rigorous:
   McNemar test, labelled versus measured, licence audit of models. The README refuses to claim
   >90%. Judges who probe accuracy will find the team already knows its numbers.
9. **Offline-capable demo.** GeoJSON basemap, bundled fonts, no paid APIs. The demo survives
   venue Wi-Fi.
10. **Engineering hygiene.**
    - Pinned images.
    - CI with type-checks (`.github/workflows/ci.yml`).
    - About 1,100 automated tests claimed (README; not re-run by me).
    - Browser E2E flows (`tests/browser/flows.mjs`).
    - A demo runbook and a panic runbook (`docs/DEMO_SCRIPT.md`, `docs/PANIC.md`).

**Differentiators against single-model entries:**

| Compared with | Contrail's advantage |
|---|---|
| Model 2 entries | A registry, federation and statewide sizing. Also no video wall that would burn the grid's quota |
| Model 3 entries | Working edge ANPR, cross-camera correlation and anomaly reasons |
| Model 4 entries | A cost and bandwidth story that survives 80,000 cameras, and departments keep their VMS |

---

## 5. Gaps and risks

### 5.1 Missing or weak features (by severity for scoring)

1. **No multi-camera journey on record.** `GET /api/v1/vehicles/routable` is empty. This is the
   scored task, and the "link" moment has never happened on live data in this database.
2. **Camera geography is town-level or absent.**
   - The grid gives no coordinates. The sync places cameras by gazetteer at town centroids
     (`scripts/sync_sandbox.py`, `data/seed/gujarat_places.csv`).
   - All 9 Ahmedabad cameras sit on one point.
   - SBX-cam20/22/23/25/26 and CAM-DEMO-02 are unplaced.
   - Distances, speeds, pursuit predictions and the route map all degrade as a result.
3. **Gap analysis uses the wrong geography.** `CITY_TALUKAS` (`services/fleet.py:355-363`) is 7
   Ahmedabad wards. District names are inconsistent: "Ahmadabad" on the grid, "Sabarmati" as the
   district of CAM-DEMO-01. No ageing-infrastructure gap is computed.
4. **Department attribution.** 27 of 32 cameras are unassigned. There is no department
   management API: `GET /api/v1/departments` only, and the 26 departments are 🚧 seeded by
   `scripts/seed.py`. There is no department-scoped RBAC.
5. **Registry metadata is thin.** No storage or retention, NVR, power, network-link or
   maintenance fields. No Excel import. No registry export.
6. **Insights is dominated by a 15 s looping clip.** CAM-DEMO-01 supplies 49,034 of 52,787
   "vehicles observed" and is rated "severe" congestion. Anomaly scoring excludes recorded
   footage; Insights does not.
7. **The own feed is not a real feed.** UK plates, labelled "Paldi — Ashram Road". The tag
   `not-a-real-camera` is honest, but the name is not.
8. **No recording or playback demonstration.** `VendorVmsAdapter.get_recording` is never wired
   to a route.
9. **No video wall** (deliberate), **no crowd counting**, **no Kubernetes**, **no Kafka**,
   **OpenSearch unused**, **`packages/contracts/` empty**.
10. **Alert noise.**
    - `camera_down` flaps for the whole grid.
    - Repeated person-match alarms from the looping persons clip.
    - Watchlist alerts lack structured `reasons`.

### 5.2 Security holes (verified with anonymous requests from the host)

| # | Hole | Evidence | Impact at the venue |
|---|---|---|---|
| S1 | **Plate-crop bucket is world-readable and listable** | `docker-compose.yml:135` `mc anonymous set download`; anonymous `GET` of a crop → 200; anonymous `?list-type=2` bucket listing → 200 | Anyone who can reach :9000 can enumerate and download every plate crop, with no audit. The UI already uses presigned URLs, so the public policy is not even needed |
| S2 | **Internal services on all interfaces** | `docker-compose.yml:40-41, 87-88, 110-112, 164-165, 190-195`: Postgres 5432, Redis 6379 (**no password**: `PING` → `PONG`), MinIO 9000/9001, OpenSearch 9200 (security plugin disabled, `_cat/indices` → 200), MediaMTX API 9997, RTSP 8554, HLS 8888, WHEP 8889 | On a shared venue LAN, anyone could `XADD` fake detections into `nagarnetra:events:detections` and **raise real-looking alarms**, or read the DB if the password is weak. "Network segmentation" is the Model 4 requirement this misses |
| S3 | **Stream tokens bypassable for own cameras** | `infra/mediamtx/mediamtx.yml:35-58` (`authMethod: internal`, `read` for any IP); anonymous HLS of CAM-DEMO-01 → 200; `GET /api/v1/streams/verify` exists but MediaMTX never calls it | The "camera-scoped token + audited `camera.view`" claim holds for the grid proxy only. Fix: `authMethod: http` pointing at `/api/v1/streams/verify` |
| S4 | **No TLS** | `deploy/nginx/nagarnetra-edge.conf` listens on 80; HTTPS :8443 🚧 not answering at review time | Credentials and JWTs in clear on venue Wi-Fi |
| S5 | **Committed shared demo password** for supervisor, operator, analyst and auditor | `scripts/seed.py:216`, used for every non-admin account (`seed.py:304-308`) | Supervisor holds `person.approve`, so anyone with the public password plus one admin action satisfies "four-eyes" |
| S6 | **`ENVIRONMENT=development`** in the running stack | Ingest and API logs show `environment=development` | Development behaviour (configuration logging) in a live demo |
| S7 | **Presigned crop URLs are signed with the MinIO root user** | `crop_url` carries `X-Amz-Credential=<root user>` | Use a scoped service account |
| S8 | **Audit log is not tamper-evident** | No hash chain, trigger or REVOKE in any migration | An admin with DB access can rewrite history |
| S9 | **AGPL-3.0 detector weights** | Acknowledged in `docs/SECURITY.md` §8 and CLAUDE.md | Licence decision before any deployment |
| S10 | **`docs/SECURITY.md` §8 is stale and incomplete** | It omits S1–S3, S5 and S11. It says crops are "not yet uploaded to MinIO at all" and "mypy does not pass" | A judge who finds S1 will compare it with the doc |
| S11 | **Client IP is spoofable** | `services/api/Dockerfile:83-88` runs uvicorn with `--proxy-headers --forwarded-allow-ips "*"`, and :8000 is published directly (the web bundle calls it directly). `docs/SECURITY.md` §6 trusts `X-Forwarded-For` "only because … nothing else can reach the API", which is not true here | `core/ratelimit.py:94-96` keys the limiter on the first `X-Forwarded-For` value as sent. Rotating that header against :8000 resets the "10 failures / 300 s" login limit on every request, and audit rows record whatever IP the caller wrote |

### 5.3 Demo fragility

- **Grid dependency.** One session per IP, a watch-time quota, and refusals after restarts.
  At 11:15 IST the grid was refusing (`grid.session_refused_again`, `403` on `/api/ingest`).
  Every restart, including the 11:02 one, re-logs every always-on grid camera.
- **Browser locality.** The web bundle has `http://localhost:8000` baked in (`.env`
  `VITE_API_BASE_URL`, `docker-compose.yml:276`). The CSP hard-codes `localhost:9000/8888/8889/8000`
  (`web/nginx.conf:54`), and crop URLs are `http://localhost:9000/…`. **The UI works only in a
  browser on the host laptop.** A projector PC or a judge's laptop pointed at `http://<lan-ip>:8080`
  will log in to nothing. 🚧 `services/api/app/core/public_origin.py` addresses this for HTTPS :8443
  only.
- **CPU.** 10 cores shared by 3 workers, MediaMTX, Postgres, OpenSearch (512 MB heap) and the
  browser. Opening grid cameras on Live adds decode load. Measured at ~10 cores with all 31
  open (`docker-compose.yml:405-418`).
- **Model and footage fetch need internet.** `make models` and `make videos` must have run. They
  have on this laptop; a fresh machine at the venue would need connectivity.
- **Uncommitted work and live migrations.** Migrations `0009`/`0010` are applied in the DB but
  untracked. A `git stash` or `git checkout .` mid-event would leave the DB ahead of the code.
- **Single points of failure.** One Postgres, one Redis, one MinIO, one laptop. The fallback is
  the recorded clip plus a pre-rendered video (`docs/PANIC.md` §7).

### 5.4 Scalability claims: backed vs not

| Claim | Backing |
|---|---|
| 2,774 events/s at 80,000 identities | ✅ Measured, ingest only, synthetic events. p95 5.7 s missed the 3 s target. `tests/load/results/latest.md` says both "no backlog formed" and "backlog … still growing" |
| 43.7 Mbps vs 320 Gbps | ✅ Arithmetic from stated inputs (`capacity_model.py`) |
| 911 CPU nodes, ₹39.31 crore | 🟡 Arithmetic from Apple-Silicon-in-Docker measurements. No x86 server measured. The script's provenance text is stale (cites `AILAB_ORT_THREADS=4 in docker-compose.yml`, "HLD §7", and still prints a "KNOWN ERROR" banner and the NagarNetra title) |
| GPU 91–228 nodes | 📄 Extrapolated, correctly labelled. Hardware decode not built |
| HA, DR, Redpanda, Patroni, regional stores | 📄 Design only (HLD §10, §13) |
| Store-and-forward at the edge | 🚧 Spool in `ai_worker/publisher.py` with an `ai-worker-spool` volume |

### 5.5 Residue from the NagarNetra / SIH framing

- `/docs` and `/openapi.json` are titled "NagarNetra".
- `GET /` says "City-wide vehicle intelligence platform — SIH26127" (`services/api/app/main.py`).
- The VMS record is named "Ahmedabad City ANPR Grid (simulated)".
- `docs/submission/*.svg|png` and `DECK.md` carry NagarNetra branding.
- `capacity_model.py` prints a "NagarNetra capacity model" header.
- `CITY_TALUKAS`.
- The CLAUDE.md "Start here" box still says SIH26127/P4. It is internal, but agents read it.

---

## 6. Prioritised action plan

**Ground rules for every item:**

- Each grid re-login risks a 2–15 minute refusal. The workers, the API and the ingest container
  all hold grid sessions, so batch any restarts into one window between sessions.
- Commits carry the owner's name and email only (branch rule in CLAUDE.md).
- "Agent overlap" names work an in-progress agent already owns, so it is not duplicated.

### P0: must fix before the judged demo (blocks the test case or a required item)

| # | What to do | Files | Time | Criterion | Agent overlap |
|---|---|---|---|---|---|
| P0-1 | **Commit and push the working tree** in logical commits (persons; registries + 26 departments + gap CSV; pursuit + candidates; spool, metrics and TLS; ANPR config), each after its own tests pass. Include migrations `0009` and `0010`, which the live DB already runs | `services/api/alembic/versions/0009_*.py`, `0010_*.py`, every `??` path in `git status` | 0.5–1 h | Submission links, working platform, PoC readiness | All agents; the lead sequences it |
| P0-2 | **Close the network exposure, with no restart now.** (a) `mc anonymous set none local/nagarnetra-media`; the UI already uses presigned URLs, so check one crop in Alarms afterwards. (b) macOS firewall/pf: block inbound LAN traffic to 5432, 6379, 9000, 9001, 9200, 9997, 8554, 8888, 8889 (and 8000 if the UI is only used on the host). (c) Queue for the next planned restart: bind those ports to `127.0.0.1:` in compose, add Redis `requirepass`, drop the public bucket policy from `minio-init` | `docker-compose.yml:40-41, 87-88, 110-112, 135, 164-165, 190-195` | 0.5 h now, 0.5 h queued | Security, PoC readiness | Hardening agent (TLS, Redis) — coordinate |
| P0-3 | **Place and attribute the grid cameras.** First ask the organisers for coordinates and owners. Otherwise hand-geocode the 30 names to junction level (Paldi Circle, Chimanbhai Bridge, Janpath, Visat, ONGC, CN Vidyalaya, Adalaj toll, Rajkot bus port, …) with a `placement:approx` tag. Set departments where the owner is evident, tagged `department-source:operator`. Prioritise SBX-cam22/21/10, the best readers. Rename CAM-DEMO-01 to say what it is (e.g. "Recorded demo clip (UK road) — not a Gujarat camera") and normalise district spellings | Network → Cameras → **Edit** (audited), or extend `data/seed/gujarat_places.csv` + `scripts/sync_sandbox.py` (catalogue read only); `data/seed/cameras.csv` | 1–1.5 h | Test case 1, 3, 5; Model 1 | Tracking agent (pursuit) benefits directly |
| P0-4 | **Stop the grid health flap and `camera_down` spam.** When the catalogue fails because of a refusal or cooldown (`grid_session.catalogue.failure`, `refused=True`), return a probe that `_should_flip` treats as "no change" and keep **one** open integration alert. Better still, use the workers' per-camera frame stats in Redis as liveness for grid cameras | `adapters/sandbox.py:probe_health`, `services/health_monitor.py:_should_flip` and `_raise_integration_alerts`, `services/fleet.py`; tests in `tests/test_fleet_health.py` | 1–1.5 h (restart ingest only, while the grid is already refusing) | Working demo, test step 2, Model 1 health | Hardening agent (Redis dedup) — check before starting |
| P0-5 | **Fix gap-analysis geography.** Replace `CITY_TALUKAS` with Gujarat's 33 districts from `data/seed/gujarat_districts.geojson`, ideally by PostGIS point-in-polygon rather than the free-text `district`. Add an "install date unknown / older than N years" ageing bucket from `installed_on` | `services/fleet.py:268-271, 355-363`, `routers/gap_report.py`, `tests/test_gap_report.py` | 1 h + API restart | Model 1 deliverable (gap report), GIS | Registries agent wrote `gap_report.py`; finished |
| P0-6 | **Prepare step 3: track a vehicle.** Set `AI_WORKER_ALWAYS_ON` to the grid cameras with plate-capable views, confirmed by `GET /api/v1/detections?camera_id=…` counts, so they are analysed continuously rather than in 45 s slices. Confirm the raw-crop fix is live (workers restarted 11:03 IST load `variants: [raw]`). Poll `GET /api/v1/vehicles/routable` and screenshot the first real two-camera journey as backup evidence. Rehearse Pursue and "Possibly the same vehicle" on a plate read today | `.env` (`AI_WORKER_ALWAYS_ON`, `AI_WORKER_MAX_CAMERAS`), `docs/DEMO_SCRIPT.md` §2.3 | 1 h (+ one planned worker restart) | Successful test case (the scored task) | ANPR agent (yield); tracking agent (done) |
| P0-7 | **Remove NagarNetra/SIH branding from judge-facing surfaces**: FastAPI title, description and root banner; `app_name`; VMS record name "Ahmedabad City ANPR Grid (simulated)"; `capacity_model.py` header; `docs/submission/architecture.svg/png` and `workflow.svg/png` | `services/api/app/main.py:66-78, 150-155, 267-279`, `core/config.py` (`app_name`), `scripts/seed.py` (VMS name), `scripts/capacity_model.py`, `docs/submission/*.svg` | 0.5 h code + 0.5 h diagrams | Presentation, architecture | — |
| P0-8 | **Build the required submission artefacts.** (a) PPT/PDF from `docs/submission/DECK.md` with the banner corrections applied: Contrail, 911 nodes, p95 miss, research accuracy numbers. (b) Record the video per `VIDEO_SCRIPT.md`, using the organisers' data as their form demands. (c) Screenshots per `SCREENSHOTS.md`. (d) Export HLD/INFRASTRUCTURE/SECURITY to PDF | `docs/submission/` | 3–4 h | PPT/PDF presentation, submission completeness | — |
| P0-9 | **Decide where the judges' screen is.** If anything other than this laptop's own browser will show the UI, rebuild `web` with a relative API base (`VITE_API_BASE_URL=""`, `VITE_WS_URL=""`) and serve crops and video through nginx. The HTTPS work does this for :8443 only. Otherwise present strictly from the host | `.env` `VITE_*`, `web/nginx.conf:54`, `core/public_origin.py` 🚧 | 0.25 h to decide; 1 h if rebuilding | Working demonstration | Hardening agent (TLS/:8443, `public_origin.py`) |

**P0 total: about 9–12 hours across people.** P0-1, P0-2(a/b), P0-7 (code) and P0-9 (decision)
take under an hour together and should be done first.

### P1: high scoring impact, doable today

| # | What to do | Files | Time | Criterion | Agent overlap |
|---|---|---|---|---|---|
| P1-1 | **Add the HLD sections the brief names:** cost-benefit analysis (Model 4 storage ₹51.8 crore and ~₹48 crore/yr of WAN versus ₹39.31 crore capex; investigator time saved); department-wise information requirements (26 departments × cameras contributed, events they need, alerts they receive, retention, data-sharing rules); future roadmap (90 days, 6 months, 1 year); cyber zones and segmentation (camera VLAN → edge DMZ → GSWAN with IPsec/mTLS → state DC zones, key management). Refresh HLD §18 and `REQUIREMENTS.md` for 🚧 items once committed | `docs/HLD.md`, `docs/REQUIREMENTS.md` | 2 h | Architecture, presentation | — |
| P1-2 | **A real own feed.** A phone with an RTSP camera app, or a cheap IP camera, aimed at a Gujarat road, onboarded through **Onboard camera** with a department. Indian plates live replace the UK clip as the "own-feed demonstration" | Registry form only; `AI_WORKER_ALWAYS_ON` | 0.5–1 h | Own-feed demonstration, test case 1–2, Model 2 | — |
| P1-3 | **Keep recorded clips out of Insights by default.** Exclude cameras tagged `recorded-footage` (reuse `anomaly.recorded_cameras`), with a labelled "include recordings" toggle | `routers/analytics.py`, `services/traffic.py`, `pages/TrafficIntelligence.tsx`, `routers/predictions.py` | 1 h | Analytics quality | — |
| P1-4 | **Registry completeness (Model 1 is compulsory).** `.xlsx` import (openpyxl) beside CSV; registry export `GET /api/v1/reports/cameras.csv` (+ xlsx) with a button; migration `0011` adding `retention_days`, `storage_tb`/`nvr_model`, `power_source`, `network_link`, `maintenance_status`, `last_maintained_on`, `amc_vendor`, shown in the form; audit old→new values on `camera.update` | `services/camera.py:bulk_upload`, `routers/cameras.py`, `models/registry.py`, `schemas/camera.py`, `pages/Cameras.tsx` | 2–3 h | Model 1 metadata, export, audit | — |
| P1-5 | **Department-scoped RBAC and a department API.** Non-admin users with `department_id` see only their department's cameras, alerts and reports unless they hold a statewide grant; add `POST/PATCH /api/v1/departments` | `core/rbac.py`, `api/deps.py`, `services/camera.py:apply_filters`, `routers/alerts.py`, `routers/cameras.py` | 2–3 h | Model 1 ("department-wise RBAC"), security | — |
| P1-6 | **GIS coverage layer and type filter.** District choropleth of cameras, ANPR share and uncovered districts (the basemap already has the polygons); camera-type filter | `pages/MapView.tsx`, `components/CameraMap.tsx`, `routers/cameras.py` | 1.5–2 h | GIS, Model 1 | — |
| P1-7 | **Alert hygiene.** Dedup person matches per entry and camera for ~30 min; populate `reasons` on watchlist hits (exact or near, edit distance, entry, case); one standing integration alert | `services/alerts.py:raise_for_match`, `services/event_consumer.py:_raise_person_matches` | 1 h | Analytics quality, demo | Hardening agent (Redis dedup) |
| P1-8 | **Make the stream token real.** MediaMTX `authMethod: http` → `/api/v1/streams/verify` (needs a small adapter for MediaMTX's auth payload). Rate-limit and audit on the socket peer, not a caller-supplied `X-Forwarded-For`, unless the request came through nginx | `infra/mediamtx/mediamtx.yml`, `routers/streams.py`, `core/ratelimit.py:79-97`, `services/api/Dockerfile:83-88` | 1.5 h (+ MediaMTX restart; own cameras only) | Security | Hardening agent |
| P1-9 | **Truth-up the docs judges will read.** `SECURITY.md` §8 (add S1–S3, S5, S11; remove the stale lines); `tests/load/results/latest.md` backlog contradiction; `capacity_model.py` provenance strings; `DEMO_SCRIPT.md` camera count (31 → 32) | as named | 0.5–1 h | Architecture credibility | — |
| P1-10 | **Commit sample outputs**: `plates.csv`, a vehicle CSV, the printable report PDF, `gaps.csv` (after P0-5), and a federated-analytics summary into `docs/submission/samples/` | `docs/submission/` | 0.5 h | Model 1/3 deliverables, output report | — |
| P1-11 | **Demonstrate federated playback.** `GET /api/v1/cameras/{id}/recording?start&end` calling `adapter.get_recording`, with the simulated VMS returning its clip, so "recordings stay with the department" is shown, not just said | `routers/cameras.py`, `adapters/simulated.py`, `adapters/vendor.py:309` | 1–1.5 h | Model 2/4 completeness | — |

### P2: document or explain in the PPT and HLD rather than build

| Topic | What to say | Where |
|---|---|---|
| Model 4 rejected | The arithmetic slide: 320 Gbps vs 43.7 Mbps; 24.2 / 51.8 PB vs none; disk alone exceeds Contrail's capex | Deck, HLD §2.2 |
| No video wall | Deliberate: a quota-metered grid and CPU. Production design: sub-stream walls served from regional relays, on demand | Deck slide on Live, HLD §11 |
| Kafka / Redpanda | Redis Streams behind the `EventBus` seam today; Redpanda ×3, RF=3 for production; consumer-group semantics are the same | HLD §13 |
| Kubernetes | Same images; state DC on Kubernetes (Helm), sites on k3s; not built | HLD §10 (add a line) |
| GPU | All GPU numbers extrapolated (91–228 nodes); hardware decode (NVDEC) is a prerequisite; ANPR only on ANPR-grade cameras | INFRASTRUCTURE §4 |
| HA / DR | Patroni + WAL-G, MinIO site replication, RPO 15 min / RTO 1 h as targets proven only by a timed restore drill | HLD §13 |
| Encryption at rest, segmentation | Encrypted volumes, MinIO SSE-KMS; zones and IPsec/mTLS over GSWAN | SECURITY (new section) |
| Crowd counting, other analytics | Roadmap: person-class counts from the same detector at the edge | HLD roadmap |
| VAHAN / SARTHI / eGujCop / AFIS / NAFIS | Reference adapters with labelled fictional data; live integration needs NIC/SCRB access and an MoU; the interface is the deliverable | Deck, HLD |
| ANPR accuracy | Claim nothing above what is measured; show the 61.7% → 83.3% raw-crop result and the plan for a 400-vehicle two-labeller set | Deck, HLD §15.3 |
| p95 5.7 s | Queue wait under backlog, not processing; fix by more consumer replicas or batching; gate in the rollout plan | HLD §15 |
| Audit tamper-evidence, DPIA, AGPL weights | Hash-chained audit and WORM export; legal sign-off; weight replacement before deployment | SECURITY |
| OpenSearch | Kept for statewide fuzzy search at billions of reads; pg_trgm is enough for the PoC | HLD §4 |

### Already being worked on by in-progress agents (do not duplicate)

| Area | Status |
|---|---|
| ANPR accuracy | 🚧 `variants: [raw]` in `ai-lab/configs/stream.yaml`, RapidOCR fallback bound (`ocr/rapid.py`), int8 and native-CoreML configs (`configs/stream_int8.yaml`, `stream_native.yaml`, `scripts/worker_native.sh`) |
| Production hardening | 🚧 Disk spool (`ai_worker/publisher.py`), Prometheus exposition (`routers/health.py` `/metrics/prometheus`, `services/metrics.py`, `middleware/metrics.py`), Prometheus/Grafana configs (`infra/`), HTTPS :8443 (`core/public_origin.py`), Redis alert dedup (`services/alerts.py`), crop retention (`services/retention.py:expire_crops`), backups |
| Finished but uncommitted | Pursuit and candidates, registries, persons. Commit them (P0-1) |

---

## 7. Scalability and sizing talking points (80,000 cameras)

**Labels.**

- **MEASURED**: produced by a run on this project.
- **ARITHMETIC**: `scripts/capacity_model.py` (run during this review) or inline sums from
  stated inputs.
- **EXTRAPOLATED**: any GPU figure.
- **REVIEWER**: my own arithmetic from the model's stated unit prices.

**Assumptions** (from `capacity_model.py --provenance`):

| Input | Value |
|---|---|
| Video | 4 Mbps per camera (1080p15 H.264) |
| Events | 1 per camera per 30 s, averaged over a day; 2 KB each |
| Plate crops | 15 KB per detection |
| Analysis rate | 0.5 analysed frames/s per camera (the most load-bearing assumption) |
| Nodes | 40-core |
| Sites | 2,400 cameras per edge site, so 33 sites |
| Prices | Unit prices are ASSUMED |

### 7.1 Bandwidth: central versus edge, metadata only

| Flow | Model 4 (centralise video) | Contrail (events only) | Label |
|---|---|---|---|
| Sustained into the centre | **320 Gbps** | **43.7 Mbps** (2,667 events/s × 2 KB), **7,324× less** | ARITHMETIC |
| Per 2,400-camera site | 9.6 Gbps | ~1.3 Mbps (80 events/s) | ARITHMETIC |
| Plate crops | n/a | ~328 Mbps if centralised; keep regional and pull only alert crops | ARITHMETIC (HLD §11) |
| Live viewing | always on | 4 Mbps per *concurrent* viewer, on demand; released 60 s after the last viewer | ARITHMETIC |
| WAN cost | 320 Gbps ≈ 3,200 × 100 Mbps links × ₹1.5 lakh ≈ **₹48 crore/yr** | 33 site uplinks ≈ **₹49.5 lakh/yr** | REVIEWER, from the model's own uplink price |

### 7.2 Storage per retention tier

| Tier | Contrail holds | 80,000 cameras | Model 4 equivalent |
|---|---|---|---|
| Video | nothing; video stays in departmental NVRs and VMS under their 7–15+ day retention | 0 | **24.2 PB (7 d) / 51.8 PB (15 d)** central (ARITHMETIC) |
| Hot (NVMe, Timescale) | detections, alerts, health, audit | **3.3 TB (7 d)**, 7.1 TB (15 d) | |
| Warm (HDD or regional MinIO) | detections + plate crops, 90 d | **361 TB**, of which ~320 TB is crops | |
| Cold (object store or compressed hypertables) | detections + audit, 5 y | **861 TB** | |

The lever: keep crops only for alerts and low-confidence reads. That shrinks the warm tier by
roughly 10× (HLD §12).

### 7.3 Compute and GPU count for ANPR

**Measured per-frame cost:**

| Setting | Cost per analysed 1080p frame |
|---|---|
| Docker on Apple Silicon | 0.30–0.80 core-s |
| Docker, with the raw-crop and fallback fixes | **0.44 core-s** |
| Native macOS with CoreML | **0.107 core-s** |

Decode costs 0.22–0.29 core per open H.264 1080p25 stream, and 0.38–0.55 for H.265
(MEASURED, research §2.2–2.4).

**What that sizes to:**

| Scenario | Nodes | Capex | Label |
|---|---|---|---|
| CPU only, 80,000 cameras (0.46 core per camera) | **36,446 cores = 911 nodes** | ₹39.31 crore; opex ₹8.78 crore/yr; ₹4,913 per camera | ARITHMETIC from MEASURED |
| GPU, assumed 4× speedup | **228 nodes** (1× A2/L4 each, so ~228 GPUs) | ₹19.94 crore | EXTRAPOLATED |
| GPU, assumed 10× speedup | **91 nodes** (~91 GPUs) | ₹9.69 crore | EXTRAPOLATED |
| ANPR on a 20% subset (16,000 cameras), CPU | 182 nodes | ₹8.36 crore | ARITHMETIC |
| ANPR on a 20% subset, GPU at 4× | ~46 nodes | ₹4.49 crore | EXTRAPOLATED |

Notes on these figures:

- **The GPU figures need hardware decode (NVDEC), which is not built.** In software, decode
  dominates once inference is accelerated.
- **Not every camera needs ANPR.** Most of the estate is overview CCTV; plate reading belongs
  on ANPR-grade junction and highway cameras. This subset argument is the strongest one for
  the judges.
- **Central event tier.** One measured stack sustains 2,774 events/s against 2,667 needed
  (0.96 of a stack). Plan for 2× headroom (5,334 events/s, the HLD §17 gate) and fix the p95,
  which missed its 3 s target at 5.7 s.

### 7.4 The cost-benefit argument for the hybrid

| | Model 4 (central VMS) | Contrail (Models 1 + 3 + selective 2, edge AI) |
|---|---|---|
| Existing VMS and NVRs | Replaced; retraining, re-procurement, migration | Kept; one adapter per vendor |
| Central decode | 80,000 × 0.13–0.17 core ≈ **10,000–14,000 cores** before any inference | Done at the site, where the video already is |
| Storage | ₹51.8 crore of disk for 15 days (ASSUMED ₹10k/TB) | ₹1.2 crore warm + cold; video stays with departments |
| WAN | ~₹48 crore/yr (REVIEWER) | ~₹0.5 crore/yr |
| Failure of a district link | Its cameras vanish from the centre | Shown as unreachable; local VMS keeps recording; spool 🚧 replays events |
| Data ownership | Centralised | Departments keep custody of video; the state gets searchable events |

Disk alone settles it: Model 4's 15-day storage (₹51.8 crore) exceeds Contrail's entire CPU
capex (₹39.31 crore). Inference costs the same wherever it runs; moving video is the
difference.

---

## 8. Pitch narrative (opening slide, five lines)

1. Gujarat already owns about 80,000 cameras across 26 departments and many vendors. What it
   lacks is one place to ask *"where has this vehicle been today?"*
2. Contrail federates the cameras and VMS every department already runs. Nothing is replaced,
   and every recorder stays the owner of its video.
3. AI runs next to the cameras and sends the state only what they *saw*: about 2 KB per vehicle,
   43.7 Mbps statewide instead of 320 Gbps of video.
4. One registry, one map and one alarm queue turn those events into routes, watchlist alerts and
   explained trajectory anomalies, with every search audited.
5. It is already running against the organisers' own grid, and it grows district by district
   on commodity hardware, without a redesign.

---

## Appendix A: evidence log (live checks, 12 Oct 2026, IST)

| Time | Check | Result |
|---|---|---|
| 08:40 | `docker compose ps` | 12 containers healthy (postgres, redis, minio, opensearch, mediamtx, api, web, ingest, simulator, ai-worker ×3). No Prometheus, Grafana or consumer containers |
| 08:41 | `GET /ready` | Postgres 16.14 (PostGIS 3.6.4, pg_trgm 1.6, TimescaleDB 2.29.2), Redis 7.4.11, OpenSearch green, MinIO ok, MediaMTX 2 active paths |
| 08:41 | `GET /api/v1/cameras/summary` | 32 cameras; 27 department `unassigned`; districts include "Ahmadabad" ×9 and "Sabarmati" ×1 |
| 08:41 | `GET /api/v1/departments` | 26 departments (seeded by 🚧 `scripts/seed.py:128-151`) |
| 08:45 | `GET /openapi.json` | `info.title = "NagarNetra"`; 76 paths / 86 operations. `/api/v1/departments` is GET only |
| 08:50 | `GET /api/v1/vms` | "Ahmedabad City ANPR Grid (simulated)" (2 cameras), "Hosted Camera Grid" (30); both `status: unknown`, `last_sync_at: null` |
| 08:55 | `GET /api/v1/health/fleet`, `/health/gaps` | Availability 6.2%; `sandbox_unreachable` × 6,180; coverage gaps = 6 Ahmedabad talukas; 31 "unreliable" cameras at ~44.8% |
| 09:00 | `GET /metrics` (no auth) | Ingest consumed 12,109, persisted 2,971, failed 0, p95 7 ms |
| 09:02 | `GET /api/v1/detections?limit=200` | All 200 from CAM-DEMO-01; UK plates (`AP05JEO`, `GX15OGJ`), junk (`1353521`). 5,597 readable detections total (24 h) |
| 09:03 | `GET /api/v1/analytics/traffic?hours=24` | CAM-DEMO-01: 13,616 vehicles in 6 h, congestion "severe". SBX-cam01 and SBX-cam02 at identical coordinates 23.0225, 72.5714 |
| 09:04 | `/cameras/summary` × 6 at 5 s intervals | `{'online': 32}` ×5 then `{'degraded': 30, 'online': 2}`: status flapping |
| 09:10 | `GET /api/v1/alerts?limit=200` (two pages) | 812 total; of the latest 400: anomaly 348 (all with `reasons`), camera_down 42, watchlist_hit 8 (`reasons` null), person_match 2 (with `reasons`) |
| 09:12 | `GET /api/v1/vehicles/routable` (24 h, and since 1 Sep) | `"plates": []` |
| 09:13 | Grid reads, 24 h | SBX-cam22 300, cam21 134, cam10 122, cam17 0, cam04 0. Nothing older than 24 h on any grid camera |
| 09:15 | `GET /api/v1/registries/vehicle/GJ03AB1234`, `/registries/afis/REF-0001` | `source: reference`, provenance text "not a live VAHAN query…", fictional owner "Reference Owner 001" |
| 09:20 | Anonymous `GET` of a plate crop; anonymous bucket listing | 200 / 200 |
| 09:20 | `PING` to 127.0.0.1:6379 with no password | `+PONG` |
| 09:21 | Anonymous `GET :9200/_cat/indices`, `:9997/v3/paths/list` | 200 / 200. MediaMTX path configs carry no credentials in URLs |
| 09:22 | Anonymous HLS `:8888/cam-demo-01/index.m3u8` (own camera only) | 200 `application/vnd.apple.mpegurl` |
| 09:25 | Web bundle `/assets/index-*.js` | Contains `localhost:8000`. CSP lists `http://localhost:9000/8888/8889/8000` |
| 09:25 | `https://localhost:8443/` | No answer (🚧) |
| 09:30 | File mtimes vs worker start | Workers started 06:49; `stream.yaml` changed 07:35, `worker.py` 09:02. Workers were then restarted by the lead at 11:03, so they now load the 🚧 config |
| 11:05 | `GET /api/v1/alerts` | Browser-E2E critical watchlist alarm raised and closed as false positive at 11:05:25; person-match alarms at 11:03 and 11:09 |
| 11:07–11:10 | Screenshots (`tests/browser/out/review/*.png`) | `dashboard.png` ("Feeds answering 2/32", "No vehicle seen at two cameras in 24 h"), `map.png`, `health.png`, `cameras.png`, `traffic.png` (52,787 vehicles, CAM-DEMO-01 49,034), `registries.png`, `vehicles_plate_GJ08R6705.png` (2 reads, "not on the map"), `alerts.png`, `persons.png`. No console errors reported by `shot.mjs` |
| 11:10–11:15 | Worker and ingest logs (credentials redacted) | Worker 1 "analysing 0 of 8 camera(s) … 0 streams open"; worker 2 SBX-cam21 "dropped; reconnecting (attempt 6)"; ingest `grid.session_refused_again` and `403 Forbidden` from `cctv.corp8.cloud/api/ingest` |
| 09:40 | `python3 scripts/capacity_model.py --cameras 80000` / `--compare` / `--provenance` / `--gpu-speedup 4,10` / `--cameras 16000` | Figures quoted in §7 |

**Not done, by design:**

- I opened no grid stream and did not run `make test` or `flows.mjs`, because they raise real
  alarms.
- I made no writes beyond this file and the screenshots.
- My `GET`s on plate routes, registries and detections were recorded in `audit_log` under the
  admin account, as the platform intends.

## Appendix B: files most worth a judge's time

- `docs/HLD.md`, `docs/INFRASTRUCTURE.md`, `docs/SECURITY.md`, `docs/REQUIREMENTS.md`
- `docs/research/ANPR_ACCURACY_LATENCY.md`
- `services/api/app/adapters/sandbox.py`, `services/api/app/services/correlator.py`, `services/api/app/services/anomaly.py`
- `services/ai-worker/ai_worker/worker.py`, `ai-lab/ailab/pipeline.py`
- `scripts/capacity_model.py`, `tests/load/results/latest.md`
