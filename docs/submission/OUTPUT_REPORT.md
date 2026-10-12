# Output report — what Contrail detected at the Sentinel sandbox

Generated **12 Oct 12:05:48 IST** from the live API (`http://localhost:8000/api/v1`) by `python3 scripts/output_report.py --mask-plates`.

**Query window:** **12 Oct 00:00:00 → 12 Oct 12:05:48 IST** (2026-10-11T18:30:00Z → 2026-10-12T06:35:48Z).

Everything below is what the API returned at that moment — nothing is typed in by hand. Each route lookup the script made is a plate search, so it is in the audit trail under the admin account. The script made 108 API calls. Per-camera counts are also in [`OUTPUT_REPORT.csv`](OUTPUT_REPORT.csv).

## 1. Summary

| Feed | Cameras | Cameras that read a plate | Vehicles observed | Plate reads | Grammar-valid reads | Distinct valid plates |
|---|--:|--:|--:|--:|--:|--:|
| **Government** — the organisers' hosted grid (`SBX-*`, federated by `HostedGridAdapter`) | 30 | 3 | 1,744 | 251 | 130 | 121 |
| **Own** — recorded clips published by our simulator (`CAM-DEMO-*`) | 2 | 1 | 32,222 | 13,193 | 11,791 | 355 |

**Alarms raised in the window:** 61 — camera down 37, person match 13, watchlist hit 11.

**Journeys reconstructed** (a plate read at two or more cameras in the window): **0**.

What the columns mean:

- *Vehicles observed* — vehicles the edge workers detected and tracked, plate or not (`/analytics/traffic`).
- *Plate reads* — settled reads the workers published (one per tracked vehicle that yielded a plate). *Grammar-valid* — the read fits a plate format for that camera (Indian by default; British on `CAM-DEMO-01`, whose clip is a UK road).
- Vehicles observed were read in 5 time slices, each small enough for the analytics endpoint to count in full (it reads at most 20,000 detections per request); a vehicle tracked across a slice boundary is counted in both.

## 2. Government feed — the organisers' grid

30 cameras onboarded from the organisers' catalogue (Model 3 federation). The edge workers read them over RTSP; `SBX-cam10`, `SBX-cam21`, `SBX-cam22` are analysed continuously and the rest in 45-second slices, or at once while someone opens one on Live — so a camera with no read was not necessarily being analysed when traffic passed. Many grid views are junction overviews where plates are a few pixels high; detection and tracking work on them, plate reading mostly does not. **No grid camera read a plate after 12 Oct 09:10:17 IST.** Fleet health, below, shows whether the grid was refusing our session at the time; at night the cause is mostly plate yield.

| Camera | Name | District | Vehicles observed | Plate reads | Valid | Distinct | First read (IST) | Last read (IST) |
|---|---|---|--:|--:|--:|--:|---|---|
| `SBX-cam22` | BK Mervada tran Rasta | — | 349 | 131 | 87 | 80 | 12 Oct 00:14:54 | 12 Oct 09:10:17 |
| `SBX-cam10` | char-chowk-road-2-junagadh | Junagadh | 1,030 | 66 | 8 | 8 | 12 Oct 00:00:05 | 12 Oct 07:30:20 |
| `SBX-cam21` | Patan Dethali Char Rasta | Patan | 284 | 54 | 35 | 33 | 12 Oct 00:07:40 | 12 Oct 07:02:28 |
| `SBX-cam01` | Chiman bhai Bridge | Ahmedabad | 61 | 0 | 0 | 0 | — | — |
| `SBX-cam02` | Janpath | Ahmedabad | 20 | 0 | 0 | 0 | — | — |

No detection in the window on 25 camera(s): `SBX-cam03`, `SBX-cam04`, `SBX-cam05`, `SBX-cam06`, `SBX-cam07`, `SBX-cam08`, `SBX-cam09`, `SBX-cam11`, `SBX-cam12`, `SBX-cam13`, `SBX-cam14`, `SBX-cam15`, `SBX-cam16`, `SBX-cam17`, `SBX-cam18`, `SBX-cam19`, `SBX-cam20`, `SBX-cam23`, `SBX-cam24`, `SBX-cam25`, `SBX-cam26`, `SBX-cam27`, `SBX-cam28`, `SBX-cam29`, `SBX-cam30`.

## 3. Own feed — recorded clips

`CAM-DEMO-01` replays a recorded clip of a **UK road** (British plates) on a loop of about 15 s, published as an RTSP camera by our simulator; `CAM-DEMO-02` is stock footage for the persons watchlist and reads no plates. Their counts are repeated passes of the same few vehicles — evidence that the pipeline runs continuously, not traffic.

| Camera | Name | District | Vehicles observed | Plate reads | Valid | Distinct | First read (IST) | Last read (IST) |
|---|---|---|--:|--:|--:|--:|---|---|
| `CAM-DEMO-01` | Recorded demo clip (UK road) — not a Gujarat camera | Sabarmati | 32,222 | 13,193 | 11,791 | 355 | 12 Oct 00:00:01 | 12 Oct 12:05:47 |

No detection in the window on 1 camera(s): `CAM-DEMO-02`.

## 4. Sample detections, timestamped

Up to 5 per camera, each a different plate: the most confident grammar-valid read in hours spread across the window, newest first. *Frames* is how many reads of that vehicle the multi-frame consensus combined. Plates are masked (`--mask-plates`).

| Time (IST) | Camera | Feed | Plate | Read confidence | Vehicle | Frames |
|---|---|---|---|--:|---|--:|
| 12 Oct 08:29:51 | `SBX-cam22` | government | `GJ08CK••92` | 0.89 | car | 1 |
| 12 Oct 07:40:31 | `SBX-cam22` | government | `GJ08R••05` | 0.95 | car | 1 |
| 12 Oct 01:16:33 | `SBX-cam22` | government | `GJ02BP••71` | 0.99 | truck | 1 |
| 12 Oct 00:46:48 | `SBX-cam22` | government | `GJ08R••15` | 1.00 | truck | 1 |
| 12 Oct 01:40:57 | `SBX-cam10` | government | `GJ10DR••18` | 0.96 | car | 1 |
| 12 Oct 07:02:24 | `SBX-cam21` | government | `GJ08OG••80` | 0.91 | truck | 1 |
| 12 Oct 00:32:04 | `SBX-cam21` | government | `GJ31D••74` | 0.98 | car | 3 |
| 12 Oct 12:00:32 | `CAM-DEMO-01` | own | `NA5••GJ` | 0.99 | car | 1 |
| 12 Oct 11:50:57 | `CAM-DEMO-01` | own | `EY6••BG` | 0.97 | car | 3 |
| 12 Oct 09:37:16 | `CAM-DEMO-01` | own | `NA1••RU` | 1.00 | car | 3 |
| 12 Oct 07:58:24 | `CAM-DEMO-01` | own | `FJ1••HY` | 0.99 | car | 1 |
| 12 Oct 01:19:34 | `CAM-DEMO-01` | own | `BG6••SJ` | 0.98 | car | 1 |

## 5. Alarms raised

| Type | closed | false_positive | new | Total |
|---|--:|--:|--:|--:|
| camera down | 36 | 0 | 1 | 37 |
| person match | 0 | 0 | 13 | 13 |
| watchlist hit | 7 | 4 | 0 | 11 |

Watchlist hits and person matches:

| Raised (IST) | Type | Priority | Plate / subject | Camera | Status | Case ref | Note |
|---|---|---|---|---|---|---|---|
| 12 Oct 12:03:56 | person match | high | face (persons watchlist) | `CAM-DEMO-02` | new | — |  |
| 12 Oct 12:00:27 | watchlist hit | critical | `EY6••BG` | `CAM-DEMO-01` | closed | DEMO/VIDEO/2026 | test / rehearsal |
| 12 Oct 11:58:18 | person match | high | face (persons watchlist) | `CAM-DEMO-02` | new | — |  |
| 12 Oct 11:52:45 | person match | high | face (persons watchlist) | `CAM-DEMO-02` | new | — |  |
| 12 Oct 11:47:25 | person match | high | face (persons watchlist) | `CAM-DEMO-02` | new | — |  |
| 12 Oct 11:46:42 | watchlist hit | critical | `EY6••BG` | `CAM-DEMO-01` | closed | DEMO/VIDEO/2026 | test / rehearsal |
| 12 Oct 11:42:57 | watchlist hit | critical | `EY6••BG` | `CAM-DEMO-01` | closed | DEMO/VIDEO/2026 | test / rehearsal |
| 12 Oct 11:42:03 | person match | high | face (persons watchlist) | `CAM-DEMO-02` | new | — |  |
| 12 Oct 11:36:40 | person match | high | face (persons watchlist) | `CAM-DEMO-02` | new | — |  |
| 12 Oct 11:34:22 | watchlist hit | critical | `KH0••ZK` | `CAM-DEMO-01` | closed | FIR/E2E/JUDGE | test / rehearsal |
| 12 Oct 11:31:07 | person match | high | face (persons watchlist) | `CAM-DEMO-02` | new | — |  |
| 12 Oct 11:25:47 | person match | high | face (persons watchlist) | `CAM-DEMO-02` | new | — |  |
| 12 Oct 11:20:13 | person match | high | face (persons watchlist) | `CAM-DEMO-02` | new | — |  |
| 12 Oct 11:14:40 | person match | high | face (persons watchlist) | `CAM-DEMO-02` | new | — |  |
| 12 Oct 11:09:20 | person match | high | face (persons watchlist) | `CAM-DEMO-02` | new | — |  |
| 12 Oct 11:05:25 | watchlist hit | critical | `EY6••BG` | `CAM-DEMO-01` | false positive | E2E/TEST/AUTO-REMOVED | test / rehearsal |
| 12 Oct 11:03:37 | person match | high | face (persons watchlist) | `CAM-DEMO-02` | new | — |  |
| 12 Oct 09:12:20 | watchlist hit | critical | `GX1••GJ` | `CAM-DEMO-01` | false positive | E2E/TEST/AUTO-REMOVED | test / rehearsal |
| 12 Oct 07:18:32 | watchlist hit | critical | `EY6••BG` | `CAM-DEMO-01` | closed | FIR/E2E/JUDGE | test / rehearsal |
| 12 Oct 07:13:48 | watchlist hit | critical | `EY6••BG` | `CAM-DEMO-01` | false positive | E2E/TEST/AUTO-REMOVED | test / rehearsal |
| 12 Oct 07:01:05 | person match | high | face (persons watchlist) | `CAM-DEMO-02` | new | — |  |
| 12 Oct 06:55:24 | watchlist hit | critical | `GX1••GJ` | `CAM-DEMO-01` | false positive | E2E/TEST/AUTO-REMOVED | test / rehearsal |
| 12 Oct 01:32:30 | watchlist hit | critical | `EY6••BG` | `CAM-DEMO-01` | closed | FIR/E2E/JUDGE | test / rehearsal |
| 12 Oct 01:24:19 | watchlist hit | critical | `EY6••BG` | `CAM-DEMO-01` | closed | FIR/E2E/JUDGE | test / rehearsal |

*camera down* alarms are the health monitor reporting the grid's catalogue refusing or dropping our session (it allows one session per address); they close themselves when it answers again. Person matches come only from cameras tagged for faces — here `CAM-DEMO-02`'s stock footage, looping, against a fictional demonstration entry — and each says a person must confirm it. Every watchlist hit in this window was a rehearsal or a test on the recorded clip, closed afterwards; none concerns a real case.

## 6. Journeys reconstructed

**None.** No plate was read at two different cameras in this window, so no multi-camera journey was reconstructed. The route engine runs on every read (`GET /api/v1/vehicles/{plate}/route`) and the single-camera histories are in the plate report; what is missing is a second read. Why, plainly: the grid cameras that read plates at all are a handful in different towns, far apart; most grid cameras are analysed in slices rather than continuously; and night-time yield is low. Absence from this report is not absence from the road.

## 7. Fleet health when the report was generated

| Total | Online | Degraded | Offline | Unknown | Availability |
|--:|--:|--:|--:|--:|--:|
| 32 | 2 | 0 | 0 | 30 | 6.2% |

Most frequent probe errors: `sandbox_unreachable` × 5,970, `grid_refused` × 1,106.

## 8. How to regenerate, and the exports behind it

```bash
python3 scripts/output_report.py                                  # 12 Oct 00:00 IST → now
python3 scripts/output_report.py --since 2026-10-11T00:00:00+05:30 # include the evening before
python3 scripts/output_report.py --mask-plates                    # a copy to publish
```

It needs the stack running and `.env` holding the bootstrap admin. The same data is available in the product: **Investigate → Export plate reads (CSV)** (`GET /api/v1/reports/plates.csv?since=&until=&camera_id=`, every plate read with its time, camera, department and position), a vehicle's **CSV** and **Printable report** (`GET /api/v1/reports/vehicle/{plate}.csv`), and the gap report on Fleet health (`GET /api/v1/reports/gaps.csv`).

## 9. Read this before quoting a number

- A plate read is not a vehicle count, and the recorded clip loops: its counts are not traffic.
- No accuracy figure is claimed for these reads. On 60 AI-labelled grid crops the recogniser was 61.7% exact as shipped and 83.3% with raw crops (`docs/HLD.md` §15.3); a human-labelled set is the next gate.
- Grid camera positions are inferred from the catalogue's place names — a town centre, or an approximate point where the name identifies a junction — so no grid distance is exact.
- The grid allows one session per address and a watch-time quota; gaps in its rows can be refusals, not quiet roads.
