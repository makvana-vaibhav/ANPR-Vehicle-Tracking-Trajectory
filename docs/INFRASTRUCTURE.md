# Infrastructure — compute, bandwidth, storage, hardware and cost

How Contrail is sized for the Sentinel brief: from the ~50-camera live test up to
~80,000 cameras across the state.

**Every number in this document carries one of four labels.**

| Label | Meaning |
|---|---|
| **MEASURED** | Printed by a run we made, on the hardware named, with the source cited. |
| **ARITHMETIC** | Computed from measured or declared inputs. It's correct if the inputs are. |
| **ASSUMED** | A declared input such as a bitrate, event rate, retention or unit price. Challenge it, and override it in the script. |
| **EXTRAPOLATED** | Any GPU figure. No GPU has ever run this code (see [GPU.md](GPU.md)). |

**The sizing comes from a script, not a table.**

```bash
python3 scripts/capacity_model.py --cameras 80000        # one fleet, full breakdown
python3 scripts/capacity_model.py --compare              # 2,400 … 100,000 cameras
python3 scripts/capacity_model.py --provenance           # where every constant comes from
python3 scripts/capacity_model.py --cameras 80000 --gpu-speedup 4   # EXTRAPOLATED
```

Every figure in §3–§8 was printed by that script on 12 Oct 2026, unless a
row says otherwise.

> **This replaces the earlier sizing, which was about 4× too low.** The previous
> version of this file said "one core sustains roughly 8 cameras" and sized
> 80,000 cameras at ~10,000 cores / ~250 nodes. That figure took the measured
> 8.78 cameras per *worker* and treated the worker as one core. The worker used
> four threads, so the correct figure is **~2.2 cameras per core**. The same
> fleet needs **~36,000 cores / ~911 nodes** on CPU. `docs/BRIEFING.md` §13–14
> and `docs/submission/DECK.md` slide 15 repeat the old figure. Use this file.

---

## 1. What is actually measured

The capacity model has three inputs that come from runs. Everything else is
declared. Where a figure was produced:

| What | Value | Where measured | Source |
|---|---|---|---|
| Pipeline throughput | **4.39 analysed fps** per 4-thread worker, 720p, CPU | ai-lab harness, synthetic footage | `ai-lab/PERFORMANCE.md` |
| Central ingest | **2,774 events/s** median over a 150 s run, 80,000 camera identities, 0 failed, 388,713 rows written | dev laptop, 3 consumer replicas, Redis Streams | `tests/load/results/load-20260905T064430.json`; [HLD §15](HLD.md#15-scale-evidence) |
| Ingest latency at that rate | p50 / p95 / p99 capture→persisted **4.8 / 5.7 / 5.9 s**. Missed the 3 s target | same run | same |
| Inference cost, 1080p, in Docker | **0.30–0.80 core-s per analysed frame** (sparse scene to busy scene, as shipped). **0.44** with research fixes #1 and #2 | worker image `contrail/ai-worker:dev`, 1 ORT thread | [research §2.1, §2.4](research/ANPR_ACCURACY_LATENCY.md) |
| Inference cost, 1080p, native macOS | **0.19–0.22** core-s on the CPU EP. **0.096–0.107** on the CoreML EP | same models, same clips | research §2.4 |
| Decode, per open stream, in Docker (1 thread) | H.264 1080p25: **0.22–0.29 core**. H.265 1080p25: **0.38–0.55 core** | same | research §2.2 item 3 |
| Decode on the live grid | **~0.2 core per open stream**, whether analysed or not | 31 grid streams, 11 Oct | `docs/BUILD_STATE.md` "The grid refuses churn"; `docker-compose.yml` ai-worker notes |
| Live fleet on the laptop | 31 streams open and all analysed: **~10 cores**. 4 always-on plus the one on screen: **4.4–5.6 cores** | same | same |
| Event size | 1.8–2.4 KB per `vehicle.completed` with evidence | payload sample | earlier revision of this file; the model assumes 2,048 B |
| Overlay batch (`camera.tracks`) | **9.7 KB/s per camera** with ten vehicles at 5 batches/s | live stack, 12 Sep | `docs/PROGRESS.md` |

**The host for all of it.** Measured on an Apple Silicon laptop: M5, 4
performance and 6 efficiency cores, 16 GB. Docker Desktop gives the VM 10 vCPU.

ONNX Runtime inside that VM runs **without the CPU's SME units**. A scalar
Python loop runs 1.65× slower there than natively (research §2.2). No x86 server
has run this code, so per-core figures on a Xeon or EPYC node are **unmeasured**.
Measuring them is the first gate of the rollout ([HLD §17](HLD.md#17-rollout-plan)).

---

## 2. CPU per camera: Docker against native CoreML

The research measures **core-seconds per analysed frame**. Sizing needs **cores per
camera**, which also depends on two more things:

- **Analysis rate.** The model assumes **0.5 analysed fps per camera**, one frame
  every 2 s.
- **Decode.** The source is decoded continuously, whether or not a frame is analysed.
  At the assumed 1080p15 H.264 source, measured per-frame decode is 8.8–11.45 ms in
  Docker and ~7.2 ms natively.

These figures are **ARITHMETIC**, built from the measured parts above:

| Path | Core-s per analysed 1080p frame (**measured**) | Cores per camera at 0.5 fps, 1080p15 H.264 | Cameras per core |
|---|---|---|---|
| Docker, CPU EP, as shipped | 0.30 (sparse) – 0.80 (busy) | 0.24 – 0.53 | 1.9 – 4.2 |
| Docker, CPU EP, research fixes #1 + #2 | 0.44 (busy) | ~0.32 – 0.36 | ~2.8 – 3.1 |
| Native macOS, CPU EP | 0.19 – 0.22 | ~0.17 – 0.19 | ~5.3 – 5.9 |
| Native macOS, CoreML EP (fp32 detector) | 0.096 – 0.107 | ~0.12 – 0.14 | ~7 – 8 |
| **`capacity_model.py` (the sizing basis)** | 0.91 (4 cores ÷ 4.39 fps, 720p) | **0.46** | **2.2** |

**What the table says:**

1. **We size on the model's 0.46 core per camera.** It falls inside the range
   derived from the 12 Oct Docker measurements, toward the busy-scene end. It is
   neither the most optimistic reading nor the most pessimistic.
2. **An accelerator removes inference, not decode.** On CoreML the pipeline is
   about 4× cheaper per analysed frame, **measured** (0.436 → 0.107). About 80% of
   what is left is software decode.
   - That puts a floor of roughly **0.11–0.17 core per 1080p15 H.264 stream**, and
     about double for H.265.
   - At that floor, **no GPU scenario above about 6 cameras per CPU core is
     physically possible without hardware decode.**
   - Today the reader decodes in software through OpenCV/FFmpeg
     (`ai-lab/ailab/stream/reader.py`).
   - NVDEC or Quick Sync decode is **not implemented**. It is a prerequisite for
     every GPU row below.
3. **CoreML is a Mac-only path.** It shows what an accelerator does to *this*
   pipeline. It is not a server option. The CUDA path is wired (`device: cuda`) and
   unmeasured.

**The live laptop measures something different.** "~1 core per analysed camera"
there is a camera analysed **as fast as it can**: 2–3 fps, 5–6 frames per vehicle.
The 0.5 fps rows above are a budgeting rate. They are not what the demo runs.

---

## 3. Fleet sizing, CPU only

Output of `python3 scripts/capacity_model.py --compare`, plus a `--cameras 50`
run for the live test. Inference figures are ARITHMETIC from MEASURED throughput.
Costs are ASSUMED unit prices (§7).

| Cameras | Analysis cores | 40-core nodes | Events/s | Video if centralised | Storage (hot+warm+cold) | Capex | Opex / year |
|---|---|---|---|---|---|---|---|
| 50 (live test) | 23 | 1 | 2 | 0.2 Gbps | 0.7 TB | ₹69.60 lakh | ₹29.44 lakh |
| 2,400 (one edge site) | 1,093 | 27 | 80 | 10 Gbps | 37 TB | ₹1.83 crore | ₹45.50 lakh |
| 10,000 | 4,556 | 114 | 333 | 40 Gbps | 153 TB | ₹5.48 crore | ₹1.14 crore |
| 25,000 | 11,390 | 285 | 833 | 100 Gbps | 383 TB | ₹12.68 crore | ₹2.77 crore |
| 50,000 | 22,779 | 569 | 1,667 | 200 Gbps | 766 TB | ₹24.76 crore | ₹5.50 crore |
| **80,000 (statewide)** | **36,446** | **911** | **2,667** | **320 Gbps** | **1,225 TB** | **₹39.31 crore** | **₹8.78 crore** |
| 100,000 | 45,558 | 1,139 | 3,333 | 400 Gbps | 1,532 TB | ₹49.14 crore | ₹10.98 crore |

**Two observations:**

- **The 50-camera capex is almost all the HA floor.** That is three database nodes,
  three service nodes and a DR fraction. One 40-core node covers the 50 cameras'
  inference. The live test itself runs on one laptop; §9 has what is measured there.
- **The event tier is not the bottleneck at any size in the table.** 80,000 cameras
  offer 2,667 events/s against one central stack measured at 2,774. That leaves
  **~4% headroom**, so plan two ingest stacks.
  - During the 150 s run the backlog grew to 10,237 and cleared only after the
    generator stopped. A single stack at that rate is at its ceiling, not under it.
  - Scaling the event tier is horizontal: consumer replicas share one consumer
    group (`docker-compose.scale.yml`).

### 80,000 cameras in full (CPU only)

| | |
|---|---|
| Cameras per worker | 8.8 (4.39 fps ÷ 0.5 fps) |
| Workers / analysis cores / nodes | 9,112 / 36,446 / 911 |
| Events/s · metadata bandwidth | 2,667 · **43.7 Mbps** |
| Central ingest stacks needed | 0.96 of one measured stack |
| Edge sites (2,400 cameras each, ASSUMED) | 33 |
| Database / service nodes | 3 / 6 |
| Cost per camera | capex ₹4,913 · opex ₹1,097 / year |

---

## 4. GPU scenarios — EXTRAPOLATED

`--gpu-speedup` multiplies cameras-per-worker and switches the node price to a
40-core node with one A2/L4-class GPU (₹7.5 lakh, ASSUMED). We show two factors:

- **4×**: the whole-pipeline ratio **measured** on Apple's CoreML (research §2.4),
  applied to an NVIDIA card. The transfer is the extrapolation.
- **10×**: a round assumption. Nothing supports it except the shape of the
  CoreML result.

| Cameras | 4×: nodes | 4×: capex | 4×: opex/yr | 10×: nodes | 10×: capex | 10×: opex/yr |
|---|---|---|---|---|---|---|
| 2,400 | 7 | ₹1.24 crore | ₹33.20 lakh | 3 | ₹93.69 lakh | ₹30.74 lakh |
| 10,000 | 28 | ₹3.06 crore | ₹50.68 lakh | 11 | ₹1.78 crore | ₹40.43 lakh |
| 25,000 | 71 | ₹6.63 crore | ₹85.31 lakh | 28 | ₹3.43 crore | ₹59.68 lakh |
| 50,000 | 142 | ₹12.66 crore | ₹1.66 crore | 57 | ₹6.25 crore | ₹93.87 lakh |
| **80,000** | **228** | **₹19.94 crore** | **₹2.63 crore** | **91** | **₹9.69 crore** | **₹1.40 crore** |
| 100,000 | 285 | ₹24.94 crore | ₹3.29 crore | 114 | ₹12.12 crore | ₹1.75 crore |

**Read these with §2 point 2 in mind.**

- At 4× the model packs ~8.8 cameras onto each CPU core. At 10× it packs ~22.
- Software decode alone costs ~0.11–0.17 core per camera, so neither density is
  reachable unless decode moves to the GPU's hardware decoders.
- The model also does not price decode separately.
- So the GPU rows are a **ceiling on what a GPU could save**, not a plan.
- The plan is the CPU row, until the first rollout gate measures a real GPU node
  with hardware decode.

---

## 5. Bandwidth

### 5.1 The federation argument, at statewide scale (ARITHMETIC)

| | Centralised video (Model 2 everywhere, or Model 4) | Federated events (Contrail) |
|---|---|---|
| Per camera | 4 Mbps (ASSUMED: H.264 1080p15) | 1 event / 30 s × 2,048 B (ASSUMED) |
| 80,000 cameras | **320 Gbps** sustained into the centre | 2,667 events/s ≈ **43.7 Mbps** |
| Ratio | | **7,324× less** |
| One edge site (2,400 cameras) | 9.6 Gbps | **1.3 Mbps** |

### 5.2 What the 43.7 Mbps does *not* include

Two more flows exist in the code. Both have to stay regional in a statewide
deployment.

| Flow | Size | If forwarded to the centre at 80,000 cameras | Today | Design |
|---|---|---|---|---|
| Plate crops (evidence) | ~15 KB each (ASSUMED) | **~328 Mbps** (ARITHMETIC); ~9.8 Mbps per 2,400-camera site | The worker uploads each crop to MinIO, and only the object key rides the bus (P3) | Keep crops in a **regional** MinIO. Replicate to the centre only crops behind an alert. Fetch the rest on demand when an operator opens them |
| Live overlay (`camera.tracks`) | **9.7 KB/s per camera** (MEASURED: ten vehicles, five batches/s) ≈ 78 kbps | **~6.2 Gbps** (ARITHMETIC) | Published for **every analysed camera** (`ai-lab/configs/stream.yaml`: `track_batch_s: 0.1`). Fine on one LAN | **Gap.** Publish batches only for cameras an operator has on screen. The focus heartbeat (`POST /cameras/{id}/focus`, `app/services/focus.py`) already knows which those are |

### 5.3 Video on demand (ARITHMETIC)

MediaMTX paths are registered with `sourceOnDemand: true` and
`sourceOnDemandCloseAfter: 60s` (`services/api/app/services/gateway.py`).
An unwatched camera therefore pulls nothing.

| Concurrent viewers | Bandwidth, main stream @ 4 Mbps |
|---|---|
| 1 (the live test: one camera on stage) | 4 Mbps |
| 10 | 40 Mbps |
| 50 (every live-test camera at once) | 200 Mbps |
| 250 | 1 Gbps |

**Uplink check.** The model's site uplink is 100 Mbps (ASSUMED). Take away 1.3 Mbps
of events and 9.8 Mbps of crops (if they were forwarded). What is left carries
about **20 concurrent main-stream viewers per site**. With a 1 Mbps sub-stream it
would carry about 80, but the gateway always pulls `stream_url` today (§5.4).

### 5.4 Low-bandwidth mode

| Measure | State |
|---|---|
| Events only, not video, cross the WAN | ✅ The architecture: AI at the edge; the central tier carries events |
| Streams pulled only while watched | ✅ `sourceOnDemand`, released 60 s after the last reader |
| Health probes use the cheaper sub-stream | ✅ `RtspAdapter.probe_health` prefers `cameras.sub_stream_url` (`app/adapters/rtsp.py`) |
| VMS catalogues supply a sub-stream URL | ✅ `VendorVmsAdapter` maps `substream` / `subStreamUrl` / `low_url` (`app/adapters/vendor.py`) |
| **Viewing on the sub-stream** | ❌ **Not built.** `gateway.py` always registers `stream_url`. Planned: a "low bandwidth" toggle in the player that registers `sub_stream_url` instead |
| **Overlay batches gated to on-screen cameras** | ❌ **Not built** (§5.2) |
| **Crops kept regional** | ❌ **Not built.** One MinIO today |
| **Store-and-forward at the edge** | ❌ **Not built** (§8.3). The worker writes straight to the central Redis stream |
| Keyframe-only decode for 0.5 fps analysis | ❌ **Not built.** It would cut the decode floor in §2. Unmeasured |

---

## 6. Storage

### 6.1 What Contrail stores — and what it deliberately does not

**Contrail records no video.**

- MediaMTX recording is off (`infra/mediamtx/mediamtx.yml`).
- Departmental VMS and NVRs stay authoritative for their own footage, under their
  own retention.
- This is the Model 3 property, and the brief's "7–15+ day retention" applies to
  that footage where it already sits.

What centralising video would cost, using the model's own bitrate and bulk-storage
price (ARITHMETIC, ASSUMED inputs):

| Video retention at 80,000 × 4 Mbps | Capacity | At ₹10,000/TB bulk |
|---|---|---|
| 1 day | 3.46 PB | — |
| 7 days | **24.2 PB** | ₹24.2 crore |
| 15 days | **51.8 PB** | ₹51.8 crore |

On 15-day retention, the disks alone would cost more than Contrail's entire
CPU-only capex (₹39.31 crore). That is before the 320 Gbps needed to fill them.

### 6.2 Contrail's own data at 80,000 cameras (ARITHMETIC from ASSUMED sizes)

230.4 million detections a day, at 2,048 B per row and 15 KB per crop:

| Item | Per day | 7 days | 15 days | Model's tier |
|---|---|---|---|---|
| Detection rows | 472 GB | 3.3 TB | 7.1 TB | hot 7 d (NVMe) → **3.3 TB** |
| Plate crops | 3.54 TB | 24.8 TB | 53.1 TB | warm 90 d, with detections → **361 TB** |
| Detections, long-term | — | — | — | cold 5 y → **861 TB** |
| Audit rows | tens of MB | — | — | stays in the database (5 y) |

**Crops are the expensive tier**: 90 days of them is ~320 of the 361 TB in
warm. The lever is to keep crops for **alerts and low-confidence reads only**,
the ones a human might need to check.

### 6.3 Tiers against retention — design against code

| Tier | Design | What the code does today |
|---|---|---|
| Hot (7–15 d) | Detections, alerts, health on NVMe, in the Timescale hypertable | One Postgres. `detections` is a hypertable with 1-day chunks; `camera_health` has 7-day chunks |
| Warm (90 d) | Detections plus crops on HDD and object storage, in a regional MinIO | Crops in one MinIO bucket. **The 90-day media retention is configured and not wired**: `retention.py` deletes no vehicle crops ([SECURITY §8](SECURITY.md#8-what-is-not-implemented)). Persons media *is* purged (`services/persons.py`) |
| Cold (1–5 y) | Detections and audit, compressed, on object storage | **None.** No Timescale compression or tiering policy exists in any migration. Detections are kept 365 days and then dropped (`drop_chunks`). Audit is kept 1,825 days |

---

## 7. Hardware bill of materials and cost (80,000 cameras)

**All prices are ASSUMED, indicative, in INR, excluding GST. They are not quotes.**
Each one is a constant in `scripts/capacity_model.py` with its reasoning
(`--provenance`). Cameras, NVRs and VMS are excluded: they already exist and
belong to departments, which is the point of Model 3.

### 7.1 Unit prices (ASSUMED)

| Item | Spec | Price |
|---|---|---|
| Edge inference node, CPU | 40 cores, 128 GB, no accelerator | ₹4,00,000 |
| Edge inference node, GPU | 40 cores, 128 GB, 1× A2/L4 class | ₹7,50,000 |
| Database node | 32 cores, 256 GB, NVMe | ₹10,00,000 |
| Service node (API / bus / search) | mid-range | ₹4,00,000 |
| Hot storage | enterprise NVMe | ₹75,000 / TB |
| Warm and cold storage | tiered HDD / object | ₹10,000 / TB |
| Site uplink | 100 Mbps business fibre | ₹1,50,000 / site / year |
| Power and cooling | ~600 W average at ~₹8/kWh | ₹60,000 / node / year |
| Operations engineer | loaded | ₹12,00,000 / year, 1 per 40 nodes |
| DR site | 60% of the **central** tier only | — |

### 7.2 Per tier (CPU-only plan)

| Tier | What runs there | Quantity at 80,000 cameras | Capex |
|---|---|---|---|
| **Site edge** (×33, ~2,400 cameras each) | ai-worker processes, MediaMTX relay for that site's cameras | 911 inference nodes in total (~27 per site) | ₹36.45 crore |
| **Regional** (district / range) | Health monitor (`ingest`) for its cameras, regional MinIO (warm crops), regional bus broker | Not costed separately by the model. ASSUMED: an HA pair of service nodes per region, R regions → **+R × ₹8 lakh** on top of the total | open item |
| **State command centre** | Postgres/Timescale cluster, event bus cluster, API replicas behind a load balancer, OpenSearch, central MinIO, monitoring, web | 3 DB nodes, 6 service nodes, 3.3 TB NVMe, 1,222 TB warm+cold | ₹30.00 lakh + ₹24.00 lakh + ₹2.48 lakh + ₹1.22 crore |
| **DR site** | Standby of the central tier | 60% of central | ₹1.07 crore |
| **Total capex** | | | **₹39.31 crore** (₹4,913 per camera) |

### 7.3 Opex per year (CPU-only plan)

| | |
|---|---|
| Site uplinks (33) | ₹49.50 lakh |
| Power and cooling (920 nodes) | ₹5.52 crore |
| Operations staff (23 engineers) | ₹2.76 crore |
| **Total** | **₹8.78 crore / year** (₹1,097 per camera) |

### 7.4 What would change it most

1. **Analysed fps per camera (ASSUMED 0.5).** Compute scales linearly with it.
   Halve it and edge capex halves. Validate it against measured junction transit
   times in the pilot.
2. **Not every camera needs ANPR.** The brief's ~80,000 includes analog and
   overview cameras. Those join the registry, the map and on-demand viewing
   (Model 1 + 3) with **zero edge compute**. If 25% are ANPR-grade, edge capex
   falls about 4×. That share is a survey result, not a number we have.
3. **A measured GPU node with hardware decode** (§4). Until then, that saving
   is a ceiling.

---

## 8. Availability, HA and DR

### 8.1 What exists and is tested

| Property | Mechanism | Evidence |
|---|---|---|
| Camera outage noticed | Staggered health sweep, `camera_health` hypertable, `camera_down` alert, auto-close on recovery | **MEASURED**: killed stream → offline in **19 s** (budget 30 s) |
| Durable consumption, exactly once | Redis Stream with a consumer group (`EventConsumer`). The stream is capped at 100,000 entries, so a stopped consumer loses the oldest | Load test: 388,748 consumed / 388,713 written, 0 failed |
| Live picture identical on every API replica | `EventTailer` (plain `XREAD`) per replica, plus an alert pub/sub channel | Fixed after the load test found the split-feed bug |
| Horizontal ingest | `consumer` replicas share the group (`docker-compose.scale.yml`, `deploy.replicas: 3`) | Load test, 3 replicas |
| Stateless API and workers | No session state. Workers own a hash shard of the camera list (`ai_worker/discovery.py`, blake2b mod N) | `make ai-multi` runs 3 shards |
| Redis persistence | AOF on, `noeviction` | `docker-compose.yml` |
| Graceful degradation | WebRTC → HLS. Satellite → offline basemap. Rate limiter fails open if Redis is down. Grid login refused → whole-host back-off (`ai_worker/backoff.py`) | e2e and browser flows |

### 8.2 What a deployment needs and does not have (design targets, not claims)

| Component | Design | State |
|---|---|---|
| PostgreSQL | Primary plus a synchronous standby in the centre, an async replica at DR, WAL archiving to object storage (pgBackRest or WAL-G), managed by Patroni | ❌ Single instance. **No backups, no restore drill** |
| Object storage | MinIO erasure-coded per site, and site replication of the alert-evidence bucket to the centre and DR | ❌ Single MinIO, no replication |
| Event bus | Redpanda, 3 brokers, RF=3, behind the existing bus seam | ❌ Config seam only. `event_bus_backend="kafka"` is read nowhere except a startup log line. No Kafka client is a dependency |
| API | N replicas behind HAProxy or nginx, health-checked on `/ready` | 🟡 Replication is correct (the tailer/consumer split), and nginx proxies one API container. No load balancer config ships |
| Targets | RPO 15 min (WAL archiving), RTO 1 h (rehearsed restore) | **Aspiration.** No RPO or RTO can be claimed until a restore has been timed |

### 8.3 WAN outages at the edge

**The previous version of this file overstated this.**

- `ai_worker/publisher.py` writes straight to the central Redis stream.
- A publish failure is **counted** (`publish_failures`) and **the event is lost**.
- Nothing buffers it in worker memory.
- The durability that *was* measured is downstream: the stream holds a backlog
  while consumers catch up (10,237 events, cleared after the load).

The edge design is a **site-local bus** that forwards to the centre: a Redis Stream
or a Redpanda broker with a bounded on-disk spool, sized for the longest outage the
state will tolerate. At 80 events/s per site, a 24-hour outage is ~6.9 million
events, about 14 GB at 2 KB (ARITHMETIC). **Not built.**

---

## 9. The one-laptop deployment (what the live test runs)

| | |
|---|---|
| Host | MacBook Air M5, 16 GB. Docker Desktop VM: 10 vCPU, 11.7 GB |
| Containers | postgres, redis, minio (+ one-shot init), opensearch, mediamtx, api, web, ingest, simulator; plus 1 ai-worker (`make ai`) or 3 (`make ai-multi`) |
| Fleet | The organisers' grid (30 cameras, onboarded through `HostedGridAdapter`), plus a recorded ANPR clip (`CAM-DEMO-01`). A persons-demo camera (`CAM-DEMO-02`) is being added with the persons watchlist |
| Memory | Docker with ≥ 8 GB (`make preflight`). OpenSearch heap capped at 512 MB, Redis at 512 MB. All 31 streams open: worker memory ~3 GB (**MEASURED**) |
| CPU | 31 open and all analysed: ~10 cores, 0.3–1.2 fps per camera. 4 always-on plus the one on screen: **4.4–5.6 cores**, 2.1–2.8 grid plates/min at night (**MEASURED**, 11 Oct) |
| Latency | Capture → browser p50 135 ms / p90 201 ms / p99 345 ms on the recorded camera. Detection → alert on a WebSocket in **24 ms** (**MEASURED**) |
| Offline | Map, models, fonts and seed data are local. Satellite imagery is optional and falls back |

**No compose service has CPU or memory limits.** The thread budget
(`AILAB_INFERENCE_BUDGET`, [PERFORMANCE.md](PERFORMANCE.md)) is what stops the
workers starving the browser.

---

## 10. Monitoring

| What | State |
|---|---|
| `GET /health` (liveness), `GET /ready` (Postgres and Redis critical; OpenSearch, MinIO and MediaMTX optional → `degraded`) | ✅ `app/routers/health.py` |
| `GET /metrics` — ingest, worker fleet (p50/p95/p99, failures), tailer, alert fan-out, sockets | ✅ **as JSON.** Unauthenticated and aggregate-only (no plate, camera or user) |
| Worker coverage line ("analysing N of M camera(s) …") and per-worker stats in Redis | ✅ |
| **Prometheus exposition** | ❌ `prometheus-client` is pinned in `requirements.txt` and imported nowhere. `/metrics` is not in Prometheus text format |
| **Prometheus and Grafana** | ❌ Not in any compose file. `make scale`'s help text says "Redpanda, replicas, Grafana" and prints a Grafana URL; **neither exists**. The scale profile adds only the consumer replicas |
| MediaMTX metrics | 🟡 Enabled on :9998 inside the network, not published, not scraped |

**Design for the scale profile:**

- Prometheus scrapes the API (after a text-format exporter is added), MediaMTX
  :9998, node_exporter, postgres_exporter and redis_exporter.
- Grafana dashboards cover:
  - ingest rate and consumer lag;
  - capture→persisted p95;
  - per-site worker coverage;
  - camera availability by department;
  - alert rate by type.
- Alertmanager pages on consumer lag, a site going silent, and DB replication lag.

---

## 11. What is unproven

| Claim | Status |
|---|---|
| 43.7 Mbps of events against 320 Gbps of video | **Arithmetic.** Event size measured; event rate and bitrate assumed |
| ~911 CPU nodes for 80,000 cameras | **Arithmetic from measured throughput.** Per-core figures are from Apple Silicon. No x86 server has run this |
| 91–228 GPU nodes | **Extrapolated.** Also requires hardware decode, which isn't built |
| One central stack absorbs 80,000 cameras | **Measured, with no headroom.** 2,774 events/s median, but the backlog grew during the 150 s run. Plan two |
| p95 capture→persisted < 3 s at that rate | **Not met.** Measured 5.7 s |
| RPO 15 min / RTO 1 h | **Aspiration.** No backup exists |
| Hot/warm/cold tiering | **Design.** One Postgres, 365-day `drop_chunks`, no compression, crops never expire |
| Regional crops, gated overlay, edge spool, sub-stream viewing | **Design.** §5.4 |
| Prometheus and Grafana | **Design.** §10 |
| ₹ figures | **Assumed unit prices.** Indicative, not procurement quotes |
