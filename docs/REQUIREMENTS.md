# Sentinel requirements → where Contrail implements them

This maps every requirement of the Gujarat Police CCTV Hackathon "Sentinel" to code,
or to a clearly marked gap.

**Sources**

- The challenge site, sentinel.gujarat.gov.in (home, /resource, /faqs), as quoted in
  this file's earlier revision, retrieved 25 Aug 2026. FAQ numbers below are from
  that retrieval.
- The organisers' integrator guide revision of 2 Sep, recorded in
  `docs/BUILD_STATE.md` ("The grid moved").
- The current event brief: sandbox round 12–13 Oct 2026; the top six go on to real
  feeds at production scale.

**Legend**

| Mark | Meaning |
|---|---|
| ✅ | Implemented and tested |
| 🟡 | Partial (the row says what is missing) |
| 🔧 | Being built: in the working tree, not committed |
| 📐 | Designed, not built (the row says where the design is) |
| ❌ | Gap |

API paths are under `services/api/app/`. Screens are under `web/src/`. Every number
quoted is **MEASURED** unless labelled, and the source is named.

---

## 1. The architecture constraint

> **Q12** — Model 1 (Centralised CCTV Registry & GIS Foundation) is compulsory and
> must be combined with one or more of the other models. **Q23** permits a fully
> customised architecture.

| Requirement | Contrail | State |
|---|---|---|
| Model 1, compulsory | Registry + GIS + health + gap analysis (§2) | ✅ |
| Combined with at least one of Models 2, 3, 4 | **Model 3** (federation adapters) **+ selective Model 2** (on-demand direct viewing) **+ edge AI**. Model 4 is rejected with arithmetic: [HLD §2](HLD.md#2-the-architecture-choice) | ✅ |
| Justify the model choice | 320 Gbps vs 43.7 Mbps (7,324×) and 24–52 PB of central video for 7–15 days, from `scripts/capacity_model.py` ([HLD §2.2](HLD.md#22-why-not-model-4-the-arithmetic)) | ✅ (ARITHMETIC) |

---

## 2. Model 1 mandatory features (Q15)

> "Bulk/manual/API-based camera onboarding, interactive GIS map with layered filters,
> camera health monitoring, gap-analysis reports, and role-based search/audit trails."

| Feature | Where | State |
|---|---|---|
| Manual onboarding | `POST /api/v1/cameras` (`routers/cameras.py`); Network → Cameras form (`pages/Cameras.tsx`) | ✅ |
| Bulk onboarding | `POST /api/v1/cameras/bulk`: CSV with row-level errors and dry run (`routers/cameras.py`, `services/camera.py`). Sample with a deliberately bad row: `data/seed/sample_cameras.csv` | ✅ |
| API-based onboarding | `api_client` role holding only `camera.create` (`core/rbac.py`) | ✅ |
| Federated onboarding from a VMS | `POST /api/v1/vms/{id}/sync` (`routers/fleet.py`); `scripts/sync_sandbox.py` via `HostedGridAdapter` (`adapters/sandbox.py`) | ✅ |
| Camera metadata: location, department, type, ownership, connectivity | `cameras` (geography point, department, VMS, protocol, `stream_url`, `sub_stream_url`, type, status, tags, heading) and `vms_instances`. Migrations `0001`, `0004`, `0008` | ✅ |
| Interactive GIS map with layered filters | `pages/MapView.tsx` (filter by department, vendor, status, ANPR, free text; co-located cameras clustered; unplaced cameras listed, never drawn at a guess). `pages/Dashboard.tsx` + `components/CommandMap.tsx` (towns, live activity, vehicle contrails). Offline GeoJSON basemap, optional satellite | ✅ |
| Spatial queries | `GET /api/v1/cameras/geojson`, `/cameras/nearby`, `/cameras/in-district/{district}` (PostGIS) | ✅ |
| Camera health monitoring | `ingest` container (`ingest/monitor.py`, `services/health_monitor.py`) → `camera_health` hypertable; `GET /api/v1/health/fleet`, `/cameras/{id}/health`, `/cameras/{id}/probe`; `pages/FleetHealth.tsx`. Killed stream → offline in **19 s** | ✅ |
| Gap-analysis reports | `GET /api/v1/health/gaps` (`routers/fleet.py`); Fleet Health screen | ✅ |
| Role-based search | Six roles in one server-side matrix (`core/rbac.py`). `search.execute` gates plate search and routes; an auditor cannot search | ✅ |
| Audit trails | `middleware/audit.py`, `services/audit.py`. Every mutation, search and stream open is recorded, plus denied attempts. `GET /api/v1/audit` with CSV export, and reading it is itself audited (`pages/AuditLog.tsx`). Tested in `tests/test_audit.py` | ✅ |

---

## 3. Platform qualities the brief names

| Requirement | Contrail | State |
|---|---|---|
| **Secure** | argon2id, JWT with rotation and revocation, RBAC, audit, camera-scoped stream tokens, Redis rate limits, secrets as pointers, AES-256-GCM for sealed values. **TLS and at-rest encryption are not implemented** ([SECURITY.md §8](SECURITY.md#8-what-is-not-implemented)) | 🟡 |
| **Scalable to ~80,000 cameras without redesign** | Edge workers sharded by hash, with no coordinator (`ai_worker/discovery.py`). Consumer-group ingest scales by replicas (`docker-compose.scale.yml`). Measured at 80,000 camera identities: **2,774 events/s, 0 failed**. p95 latency **5.7 s missed its 3 s target** | 🟡 throughput ✅, latency ❌ |
| **Interoperable** | One `CameraAdapter` interface (`adapters/base.py`), with RTSP, ONVIF, vendor VMS (Milestone, Genetec, CP Plus and Hikvision vocabularies), the hosted grid, and simulated. An unknown vendor degrades to RTSP rather than vanishing | 🟡 RTSP and HostedGrid are proven live. ONVIF and VendorVMS are tested only on fixtures |
| **Cost-effective, reusing existing infrastructure** | No camera, NVR or VMS is replaced. Video stays in departments' recorders. Capex and opex computed per fleet size ([INFRASTRUCTURE §7](INFRASTRUCTURE.md#7-hardware-bill-of-materials-and-cost-80000-cameras)) | ✅ (costs ASSUMED) |
| **~26 departments** | `departments` table; cameras and VMS carry `department_id`; filters and reports by department. Federated cameras get their owner from the catalogue, else from their name, with provenance tagged | 🟡 **Six departments are seeded, and there is no API to add one.** 26 needs a seed or migration change |
| **Analog and IP** | IP: RTSP, ONVIF, VMS. Analog: through the DVR/encoder's RTSP, or through the VMS. A camera with no encoder can be registered and mapped (status `unknown`) | 🟡 no analog-specific adapter |
| **Up to ~1,000 km apart** | Only ~2 KB events cross the WAN: ~1.3 Mbps per 2,400 cameras (ARITHMETIC). Video is pulled on demand | ✅ design; 📐 a site spool for link outages is not built ([HLD §11](HLD.md#11-low-bandwidth-mode)) |

---

## 4. The live test case (Q26–28; sandbox 12–13 Oct)

> About 50 geographically distributed camera feeds from different departments.
> Onboard them, and enable centralised monitoring and analytics. Track a vehicle
> number given on the day across camera locations. Show the complete route, a
> timestamped location-wise movement history, and evidence of interoperability.
> Cross-reference live feeds against a watchlist with real-time alerts, and show
> GIS and end-to-end performance.

| Requirement | Where | State |
|---|---|---|
| Onboard ~50 mixed cameras from several departments | The organisers' grid (30 cameras, 24 H.264 and 6 HEVC, 960×576 to 2560×1440) onboarded from their catalogue by `HostedGridAdapter`. A department is assigned per camera with provenance. Any further feeds by form, CSV or API (§2) | ✅ |
| Centralised monitoring | Command (`pages/Dashboard.tsx`), Live (`pages/LiveAnpr.tsx`), Network, Fleet Health; the `/ws/events` live feed | ✅ |
| Analytics on those feeds | Edge ANPR (`services/ai-worker/`, `ai-lab/ailab/`), one worker or three (`make ai`, `make ai-multi`). Insights (`routers/analytics.py`, `pages/TrafficIntelligence.tsx`) | ✅ runs live. Accuracy unproven (§9) |
| **Track a designated vehicle across cameras** | `GET /api/v1/vehicles/{plate}/route` (`services/correlator.py`): hops, legs, great-circle distances (lower bounds), elapsed times, plausibility flags, GeoJSON. Investigate (`pages/VehicleSearch.tsx`, `?plate=&since=&until=`); ⌘K from any screen | ✅ |
| **Complete route, timestamped and location-wise** | The same endpoint, plus `GET /api/v1/reports/vehicle/{plate}.csv` and the printable report (`pages/VehicleReport.tsx`). Cameras without a position are listed as *unplaced*, not drawn | ✅ |
| Partial or uncertain plate | `GET /api/v1/vehicles/search` (Postgres `pg_trgm` similarity) | ✅ |
| **Watchlist cross-reference with real-time alerts** | `services/watchlist.py`: exact match, or a near match within one edit capped at medium. `services/alerts.py` → pub/sub → every replica → `/ws/events`. Alarms queue (`pages/Alerts.tsx`). Injected plate → alert on a WebSocket in **24 ms** | ✅ |
| GIS | §2 | ✅ |
| **Evidence of interoperability** | Per-camera provenance (VMS, adapter, `department-source:` tag). `GET /api/v1/integration/adapters`. Two hosts handled for the grid (CDN catalogue/HLS vs direct RTSP/WHEP) | ✅ |
| **End-to-end performance** | Capture → browser p50 **135 ms** / p90 201 ms on the recorded camera (`docs/PROGRESS.md`, 13 Sep). Worker coverage and latency on `GET /metrics` | ✅ |

---

## 5. Design asks

| Ask | Where it is answered | State |
|---|---|---|
| **Database structure** | [HLD §6](HLD.md#6-database-structure), derived from migrations `0001`–`0009` | ✅ |
| **Matching logic** | [HLD §7](HLD.md#7-matching-logic). Vehicle: exact or one-edit, capped near matches, validity windows, dedup. Persons: YuNet + SFace, thresholds, frames, margin, server re-check | ✅ vehicles · 🔧 persons |
| **Alerting mechanism** | [HLD §8](HLD.md#8-alerting-mechanism). Producers, priorities, triage order, `reasons`, delivery to every replica, a lifecycle with separate permissions, self-closing camera alerts | ✅ |
| **UI** | Seven workspaces plus ⌘K ([README](../README.md#the-command-centre)); browser flows in `tests/browser/flows.mjs` | ✅ |
| **Representative watchlist: stolen vehicles** | `data/seed/watchlist.csv`: four `stolen` entries, all fictional, `DEMO/…` case refs | ✅ |
| **… blacklisted vehicles** | One `blacklisted` entry; category supported | ✅ |
| **… suspect lists** | One `suspect` entry; `wanted`, `bolo` and `echallan` also supported | ✅ |
| **… wanted or missing persons** | `person_watchlist` (migration `0009`), categories `missing`, `wanted`, `demo`. Enrolment needs a case reference, a purpose and a second approver. `scripts/demo_persons.py`; demo camera `CAM-DEMO-02` | 🔧 backend and edge in the working tree; operator screen not finished; confirmation before acting not yet enforced |

---

## 6. The scale story (80,000 cameras)

| Ask | Where | State |
|---|---|---|
| Central / regional / edge compute | [HLD §10](HLD.md#10-deployment-tiers); [INFRASTRUCTURE §7](INFRASTRUCTURE.md#7-hardware-bill-of-materials-and-cost-80000-cameras) | ✅ design; regional tier 📐 |
| Compute sizing | `scripts/capacity_model.py`. CPU: 0.46 core per camera, **911 × 40-core nodes** at 80,000 (ARITHMETIC from MEASURED throughput). Per-frame costs measured in Docker and native CoreML ([INFRASTRUCTURE §2](INFRASTRUCTURE.md#2-cpu-per-camera-docker-against-native-coreml)) | ✅ (no x86 server measured) |
| **GPU needs** | `device: auto/cpu/cuda/coreml` is wired. GPU scenarios are **EXTRAPOLATED** (91–228 nodes) and need hardware decode, which is not built ([INFRASTRUCTURE §4](INFRASTRUCTURE.md#4-gpu-scenarios--extrapolated), [GPU.md](GPU.md)) | 🟡 |
| Bandwidth | 43.7 Mbps of events against 320 Gbps of video (ARITHMETIC). On-demand video at 4 Mbps per viewer ([INFRASTRUCTURE §5](INFRASTRUCTURE.md#5-bandwidth)) | ✅ |
| **Low-bandwidth modes** | Events only ✅. On-demand pull with a 60 s release ✅. Sub-stream probing ✅. Sub-stream viewing 📐. Regional crops 📐. Overlay gated to on-screen cameras 📐. Site spool 📐 ([HLD §11](HLD.md#11-low-bandwidth-mode)) | 🟡 |
| **Hot / warm / cold against 7–15+ day retention** | Video stays in departmental recorders under their retention. Contrail tiers: hot 7–15 d (3.3–7.1 TB), warm 90 d (361 TB), cold 5 y (861 TB). Today: one Postgres hypertable, 365-day `drop_chunks`, no compression, **vehicle-crop expiry not wired** ([HLD §12](HLD.md#12-storage-tiers-against-retention)) | 🟡 |
| **Load balancing** | Stateless API (tailer/consumer split makes N replicas correct); consumer replicas share one group | 🟡 no load-balancer config ships |
| **High availability** | [HLD §13](HLD.md#13-high-availability-and-disaster-recovery): Patroni Postgres, Redpanda ×3 (RF=3), MinIO erasure coding and replication | 📐 single instances today |
| **Disaster recovery** | DR site at 60% of central; WAL archiving; a timed restore drill as a rollout gate | 📐 **no backups exist; no RPO or RTO claimed** |
| **Monitoring** | `/health`, `/ready`, `/metrics` (JSON), worker coverage ✅. Prometheus exposition, Prometheus and Grafana 📐 ([HLD §14](HLD.md#14-monitoring)) | 🟡 |
| **Security** | [HLD §16](HLD.md#16-security), [SECURITY.md](SECURITY.md) | 🟡 (TLS, at-rest encryption) |
| **Costs** | INR capex and opex per fleet size; ₹39.31 crore and ₹8.78 crore/yr at 80,000 on CPU (unit prices ASSUMED) | ✅ |
| **Rollout plan for 80,000 cameras** | One district → one range → the state, each gated on measured numbers ([HLD §17](HLD.md#17-rollout-plan)) | ✅ |

---

## 7. Analytics scope (Q22)

> "ANPR, face recognition, crowd/vehicle counting, anomaly detection, statewide
> vehicle tracking", plus integration with VAHAN, SARTHI, eGujCop, AFIS and NAFIS.

| Capability | Where | State |
|---|---|---|
| ANPR | `ai-lab/ailab/` (YOLOv8n, ByteTrack, YOLO11n plate, PP-OCRv4, consensus); `services/ai-worker/` | ✅ runs live. Accuracy: §9 |
| Statewide vehicle tracking | `services/correlator.py`; `services/route_history.py` persists journeys to `vehicle_tracks` | ✅ |
| Vehicle counting | `GET /api/v1/analytics/flow`, `/traffic`, `/traffic/history`, `/heatmap`, `/hotspots` (`routers/analytics.py`). Direction of travel is emitted by the edge | ✅ |
| Anomaly detection | `services/anomaly.py`: impossible hop, rare transition, slow or fast transition, with `alerts.reasons` | ✅ |
| Congestion forecast | `GET /api/v1/predictions/congestion`, with a self-backtested error | ✅ |
| Face recognition | YuNet + SFace (`ai-lab/ailab/face/`), persons watchlist with safeguards ([HLD §7.2](HLD.md#72-persons-watchlist-yunet-and-sface-being-built)) | 🔧 |
| Crowd counting | — | ❌ not built |
| VAHAN / SARTHI / eGujCop / AFIS / NAFIS | — | ❌ not built. These services are not publicly reachable. The integration would be an adapter behind an interface, with any stand-in data clearly labelled as such |

---

## 8. Evaluation criteria (Q36) and bonus credit

| Criterion | What we offer | Where |
|---|---|---|
| Successful live test | Grid onboarded by federation; plate → route; watchlist → alert | `docs/DEMO_SCRIPT.md`, `tests/e2e/test_judge_flow.py`, `tests/browser/flows.mjs` |
| Presentation (model justification) | Model 1 + 3 + selective 2 with edge AI, argued by arithmetic | [HLD §2](HLD.md#2-the-architecture-choice) |
| Architecture (HLD quality) | Components, flows, database, matching, alerting, tiers, HA/DR, rollout, gaps | [HLD.md](HLD.md) |
| Working platform | `make demo`; tests (last full run: API 639 passed / 16 skipped, worker 116, simulator 22, web 332, e2e 34); CI | `docs/BUILD_STATE.md` |
| Analytics output | ANPR, routes, anomalies with reasons, traffic insights, forecast, CSV and printable reports | §7 |
| Scalability and PoC readiness | 2,774 events/s at 80,000 identities; capacity model with provenance | [INFRASTRUCTURE.md](INFRASTRUCTURE.md) |
| Completeness | HLD, infrastructure, security, requirements, runbooks, API docs | `docs/` |
| Bonus: hybrid architecture | Models 1 + 3 + selective 2 | ✅ |
| Bonus: cross-camera tracking | Correlator with flagged legs | ✅ |
| Bonus: extra analytics | Anomalies, traffic, forecast, faces 🔧 | ✅ / 🔧 |
| Bonus: edge processing | AI next to the video; events only | ✅ |
| Bonus: low bandwidth | On-demand video, events only | ✅ / 📐 (§6) |
| Bonus: security | Audit, RBAC, scoped tokens, four-eyes on persons | ✅ / 🔧 |
| Bonus: dashboards | Seven workspaces | ✅ |
| Bonus: APIs | OpenAPI at `/docs`; [API.md](API.md) generated from it | ✅ |

---

## 9. Measured where it matters, and the claims we do not make

| Topic | Statement | Source |
|---|---|---|
| ANPR accuracy | **No system figure is claimed.** On 60 AI-labelled legible grid crops: 61.7% exact as shipped, 83.3% with raw crops. Night yield on the grid: 11–20% of four-wheelers, 0% of two-wheelers | [research](research/ANPR_ACCURACY_LATENCY.md) §3 |
| Ingest latency at scale | p95 5.7 s against a 3 s target | `tests/load/results/load-20260905T064430.json` |
| GPU | Never executed | [GPU.md](GPU.md) |
| RPO / RTO | None claimed; no backups | [HLD §13](HLD.md#13-high-availability-and-disaster-recovery) |

---

## 10. Stream access from the organisers' grid (/resource, revised 2 Sep)

| Path | Form | Our use |
|---|---|---|
| Catalogue | `https://<cdn-host>/cameras.json`, falling back to `/api/ingest`, behind a portal login | `HostedGridAdapter.list_cameras()` |
| RTSP | `rtsp://<media-host>:8554/stream/<id>`, direct, with credentials | Edge worker ingest. Credentials are server-side only and redacted in logs |
| WebRTC (WHEP) | `http://<media-host>:8889/stream/<id>/whep` | Browser preview |
| HLS | `https://<cdn-host>/<id>/index.m3u8`, portal session | Proxied by `routers/grid_media.py` under the same scoped stream token |

**Behaviours the adapter is built around**

- The catalogue schema and camera ids change. The adapter parses defensively and
  stores the grid's own id (`grid-id:` tag) instead of deriving it.
- The grid refuses logins when sessions churn. The worker backs off per host, 120 s
  doubling to 15 min (`ai_worker/backoff.py`). The runbook is `docs/PANIC.md` §2a.
