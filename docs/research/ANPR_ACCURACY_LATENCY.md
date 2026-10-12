# ANPR accuracy and latency: what to change, and the evidence

Research and measurements from 12 October 2026, during the live demo window. **No production code
was changed.** Every number below is labelled:

* **measured**: produced by a script in this investigation, on this machine, with the data named.
* **cited**: read from a primary source (paper, README, licence file, model card), with a link.
* **estimated**: reasoned from measured parts. These are never quoted as results.

Scripts, downloaded models and raw outputs are in the session scratchpad. They are not in the repo; see §9.

---

## 0. Decision summary: what to do tonight, in order

| # | Change | Effect (label) | CPU cost | Licence | Integration point |
|---|---|---|---|---|---|
| 1 | **Give the recogniser the raw plate crop.** Stop applying CLAHE and replicate-padding before PP-OCR | Grid crops, single read, exact match **61.7% → 83.3%** (n=60, McNemar p=0.001). Precision of grammar-valid reads **76% → 91%**. Demo clip, whole pipeline with #2: **9 of 14 → 12 of 13** resolved plates correct. #2 on its own leaves it at 9 of 14 (**measured**) | **Less**: one OCR call per look instead of two | n/a | `ai-lab/configs/stream.yaml`: `preprocess.variants: [raw]`. The variant already exists in `build_variants` |
| 2 | **Bound PP-OCR's text-detection fallback.** Cap the input size and drop the angle classifier | Fallback costs **~730–890 ms → ~150 ms** CPU per firing in Docker. Two-row plates read **1–2/7 → 3/7**. With #1, the busy clip drops from **0.58 to 0.44 core-s per analysed frame** in Docker (**measured**) | Less | Apache-2.0 (current models) | `ailab/ocr/rapid.py`: `RapidOCR(..., det_limit_side_len=128, det_limit_type="min")`, and `use_cls=False` in `_detect_and_recognise` |
| 3 | **Add a second, plate-specific reader**, fast-plate-ocr `cct_xs_v2_global` (3.3 MB ONNX). Use it to corroborate reads, and as a two-row fallback | When it **agrees** with PP-OCR: 39/39 correct, and 0 readings claimed on 41 unreadable crops (**measured**). As a fallback: 88.3% exact, but 14/41 unreadable crops then get a "valid" plate. Use agreement to grade a read, never fallback alone, to raise an alert | +4.9 ms per crop in Docker | MIT code and weights (maintainer's statement, [#97](https://github.com/ankandrew/fast-plate-ocr/issues/97)); no Indian training data | New `ailab/ocr/fast_plate.py` engine; grade the read in `Pipeline._read_plate` |
| 4 | **Run the AI worker natively on macOS, not in Docker,** with CoreML on an fp32 copy of the same detector | Whole pipeline, same fixes: **0.436 → 0.107 core-s per analysed frame**. Same 13 plates resolved, 12 correct. Detector **~11 ms CPU** vs 115–300 ms in Docker. 232/234 detections identical on 116 grid frames (**measured**) | **~4× less** per frame. Spend it on more frames per vehicle | Same weights as today (AGPL export; §6.4) | `docs/GPU.md` Path 2. fp32 conversion needs no retraining (§4.4) |
| 5 | **Decode every frame, but convert to BGR only the frame that will be analysed** (`grab()`, then `retrieve()`) | **−0.07 core per open H.264 1080p25 stream, −0.17 per H.265 stream**, in Docker (**measured**). Today 89–95% of decoded frames are thrown away | Less | n/a | `ailab/stream/reader.py` `StreamReader._run` / `read()` |
| 6 | Grammar: **drop one leading junk character** (the HSRP hologram/IND strip read as a letter) **only when what is left is valid** | +1 of 60 exact (**measured**); free | ~0 | n/a | `ailab/aggregate/grammar.py` `normalise()` or `consensus()` |
| 7 | **int8 plate detector, for the Docker workers only.** A static-shape, statically quantised copy of the same plate model | Plate search **28.8 → 8.8 ms CPU (−69%)** in Docker. Found the same 21/21 plates ≥40 px as fp32 on grid and demo vehicle crops (**measured**). On macOS natively int8 is *slower*; use it only under Docker | Less | Same AGPL lineage as today | `plate.weights` in `stream.yaml` → `plate_yolo11n_static320_int8.onnx` (§4.7) |
| 8 | *(not tonight)* Cheaper vehicle detector: int8, or input 640 → 512 | int8: **−30% to −58%** detector CPU in Docker, but it keeps only **87–93%** of the ≥100 px vehicles fp32 finds. 512: −30%, but only 75% match. Measured on 114 grid frames without ground truth, so the net recall effect is unknown | Less | Same AGPL lineage | `detector.weights` (§4.8) |
| 9 | *(hygiene)* Keep 1 intra-op thread per model per camera, as production does. If that is ever raised, set `session.intra_op.allow_spinning=0` | At 2 threads, spinning costs +60% CPU for −10% wall time (**measured** natively, plate model @320) | Less | n/a | `ailab/detect/onnx_backend.py`, `ailab/ocr/rapid.py` |

**Recommended order for tonight:** #1 (one config line) → #2 (two lines) → #6 → #7 (a model file and one
config line, Docker only) → #5, then #3 if time allows.
**#4 is the biggest single lever, and the riskiest on a demo day.** Stand it up beside the Docker
workers and switch only once it is proven (§4.4).

Do **not** do any of these. The evidence is in §5, and for the int8 vehicle detector in §4.8:

* Ship an int8 *vehicle* detector before it has ground truth (#8).
* Run a full-frame tiled plate search.
* Change the plate detector input from 320.
* Lower `min_plate_width` or `min_crop_width`.
* Add CLAHE, gamma, unsharp or auto-level before OCR.
* Use the 9-slot fast-plate-ocr models.

---

## 1. What was measured, and on what

**Host.** M5 MacBook Air: 4 performance and 6 efficiency cores, 16 GB, macOS. The live demo stack
was running throughout, with three AI workers and load average 5–9. Docker Desktop VM: 10 vCPU,
11.7 GB, Linux 6.12 aarch64. ONNX Runtime 1.29.0 and OpenCV 4.11.0 in both the worker image and
the native venv. All Docker figures come from **throwaway containers** of the real worker image
`contrail/ai-worker:dev`, run with `--cpus 2 --network none` and read-only mounts. The running
containers were never touched.

**Production thread setting, as found.** The three workers run with `AILAB_INFERENCE_BUDGET=2` and
`AI_WORKER_MAX_CAMERAS=3`. That gives `threads_per_model = max(1, 2 // 3) = 1`, so every
benchmark here uses **1 intra-op thread** unless it says otherwise.

**Data used. None of it came from opening an organisers' stream.**

| Set | What | Use |
|---|---|---|
| Grid plate crops | 329 crops the workers had already saved to MinIO: 326 from SBX-cam10/21/22, 3 from other grid cameras. 11 Oct, 20:30–00:15 IST (evening and night). Pulled through `GET /api/v1/detections` | OCR accuracy |
| Grid crops, labelled | Random 150 of the 329, labelled blind (pipeline output hidden) by the research agent from upscaled crops: **60 confident**, 49 best-guess, 40 unreadable, 1 not a plate. Two-row: 3 confident, 4 best-guess | All grid accuracy numbers use the 60 confident labels unless stated |
| Demo crops, labelled | 45 random CAM-DEMO-01 crops (UK plates): 40 confident | Regression check for the demo camera |
| Clips | `data/videos/anpr_demo.mp4` (1080p15 H.264, the clip CAM-DEMO-01 replays). `data/videos/rajkot-bus-stand.mp4` (1080p25 H.264, recorded from the grid camera now listed as cam17 "1 CENTER") | Whole-pipeline profiles |
| Grid frames | 116 grid snapshots from September (`ai-lab/runs/_gridsurvey/`) plus 2 from 11 Oct (cam04, cam17) | Detector and plate-detector comparisons |
| Live yield | 28,066 detection rows from the last 7 days via the API. 1,498 are grid vehicles | Where plates are lost |

> **Label caveat.** The labels were made by an AI reading upscaled crops, not by two humans, and
> nobody has checked them. They are good enough to rank options against each other, where the gaps
> are 15–25 points. They are **not** good enough to publish as system accuracy. Crops reach MinIO
> only when the current pipeline produced *some* reading, so the set leans toward plates the
> current conditioning can partly read. That bias works *against* the raw-crop result in #1, not
> for it.
>
> **The confident set is mostly one camera:** 51 crops from SBX-cam22 and 9 from SBX-cam21. 25 of
> SBX-cam10's crops in the sample were unreadable, mostly one dark, smeared car seen over and over.
> Results transfer to other cameras only as far as their plates look like cam22's.

---

## 2. Latency: where ~0.4 core-seconds per analysed frame goes

### 2.1 Whole-pipeline profile in the worker image (measured)

`profile_pipeline.py` runs the real `ailab` `Pipeline` with the `stream`/`stream_demo` configs,
1 ORT thread and 1 OpenCV thread. It skips frames by a stride that imitates the live analysed rate,
and accumulates **process CPU** per stage. The pipeline is sequential, so per-stage process CPU
equals stage CPU.

| Stage, CPU per analysed frame | Rajkot grid recording (sparse, 1 in 10 of 25 fps) | Demo clip, busy (1 in 6 of 15 fps), run 1 | Demo clip, run 2 |
|---|---|---|---|
| Vehicle detection, YOLOv8n fp16 @640 | **190 ms (63%)** | 223 ms | 178 ms |
| Plate detection, YOLO11n @320, per vehicle searched | 36 ms (0.8 searches × 43 ms) | **259 ms** (5.4 × 48 ms) | 199 ms (5.4 × 37 ms) |
| OCR | 0 (no legible plate in the clip) | **225 ms**: 2.3 recognitions × 50 ms, plus 4 det-fallbacks × **1,034 ms** each | 136 ms |
| Decode, every source frame | 74 ms (10 frames) | 73 ms (6 frames) | 61 ms |
| Tracking, preprocessing, consensus | ~1 ms | ~7 ms | ~6 ms |
| **Total** | **0.30 core-s** | **0.80 core-s** | **0.58 core-s** |

The same clip run twice gives 0.80 and 0.58 core-s. The live stack shares the machine, so Docker
timings move by ±30% from run to run. Treat single Docker numbers as ranges.

The batch profile decodes with OpenCV's default decoder threading; the live worker uses one thread.
Per-frame decode at one thread was measured separately (§2.2, item 3).

This reproduces the field observation of "~0.4 core-s per analysed 1080p frame". On a sparse grid
scene **the detector is about two thirds of it**, and decode about a quarter. On a busy scene, plate
detection and OCR catch up.

### 2.2 Why it costs this much

1. **ONNX Runtime inside Docker on Apple Silicon is slow (measured).** The host CPU has SME/SME2
   (`hw.optional.arm.FEAT_SME2: 1`). The Linux guest's `/proc/cpuinfo` lists no `sme`, and a
   scalar Python loop runs 1.65× slower in the guest (2.60 s against 1.58 s). The same YOLOv8n
   detect() call costs:

   | Where | CPU per call |
   |---|---|
   | Docker, interleaved runs, live stack busy | 280–300 ms |
   | Docker, one quieter run, `session.run` only | 115–120 ms |
   | Native macOS, CPU EP | 55–78 ms |
   | Native macOS, CoreML EP (fp32 graph) | **~11 ms** (model run ≈2 ms CPU, 4 ms wall) |

2. **The detector runs at 640 on every analysed frame.** It is the largest fixed cost, and it does
   not shrink when the scene is empty.
3. **Every source frame is decoded *and* converted to BGR, then 89–95% of them are dropped.** In
   Docker at 1 FFmpeg thread, H.264 1080p25 costs 11.45 ms per frame with `read()` and 8.80 ms with
   `grab()`. That is 0.29 against 0.22 core per open stream. H.265 1080p25 costs 22.1 against
   15.4 ms: 0.55 against 0.38 core. The frame-drop figures come from the compose notes; the decode
   costs are **measured**.
4. **One PP-OCR det-fallback firing costs 0.7–1.0 core-s.** RapidOCR's shipped config resizes the
   crop so its *short* side is 736 px (`limit_side_len: 736`, `limit_type: min`). A 60×20 plate
   becomes a ~2,200×736 DBNet input. The angle classifier also runs, although plates are never
   upside down. Measured on 10–20 grid crops: 830–890 ms in Docker, 560–860 ms natively.
5. **Two identical OCR calls per look.** The default variants are `[rectified, upscaled]`. When no
   plate quadrilateral is found, `rectified_fallback` produces exactly the same pixels as
   `upscaled`. On the demo clip that was 41 of 44 crops, so recognition ran twice on identical input
   whenever the first read was not clean. Fixing #1 removes this too.

### 2.3 Per-component costs (1 thread)

| Component | Docker (worker image) | Native CPU EP | Native CoreML EP |
|---|---|---|---|
| YOLOv8n @640, `detect()` with pre- and post-processing | 115–300 ms | 55–78 ms | 11 ms (fp32 graph only; fp16 graph no gain) |
| …of which building the fp16 input tensor | 12.7 ms (8.3 ms with fp32 maths then a cast; 3.7 ms for an fp32 model) | 13–20 ms | — |
| YOLOv8n @640 **int8** static QDQ (percentile; fp32 head + stem) | 98 ms (vs 140 ms fp16, same interleaved run) | slower than fp32 | — |
| YOLOv8n @640 **int8** static QDQ (percentile; fp32 head decode only) | 55 ms (vs 132 ms fp16, same run) | slower than fp32 | — |
| YOLO11n plate model @320, per vehicle | 26–48 ms | 15–22 ms | 1.0 ms CPU / 1.7 ms wall (static-shape copy) |
| YOLO11n plate model @320 **int8** static QDQ, static shape | **8.8 ms** (vs 28.8 ms fp32, same session) | — | — |
| PP-OCRv4 recognition, per crop | 28–32 ms | 15 ms | not tested |
| PP-OCR det-fallback as shipped | 727–889 ms | 555–860 ms | — |
| Det-fallback, `128/min`, no classifier | 154 ms (two-row crops) | 115 ms | — |
| Det-fallback, `192/max`, no classifier | 34 ms (one-row) to 103 ms (two-row) | 24–93 ms | — |
| fast-plate-ocr `cct_xs_v2`, per crop | 4.9 ms (12.5 ms on two-row crops) | 2.1–2.8 ms | not tested |

### 2.4 Whole-pipeline effect of the fixes (measured, demo clip, 38 analysed frames)

| Configuration | Where | Core-s per analysed frame | Plates resolved | Correct |
|---|---|---|---|---|
| As shipped | Docker | 0.58–0.80 | 14 | **9** (64%) |
| #2 + variant dedupe only | Docker | 0.56 | 14 | 9 |
| **#1 + #2** | Docker | **0.44** | 13 | **12** (92%) |
| #1 + #2 | Native, CPU EP | 0.22 | 13 | 12 |
| **#1 + #2 + #4** (CoreML; fp32 detector; static-320 plate model) | Native | **0.107** (81 ms wall) | 13 | 12 |

On the sparse grid recording (Rajkot), no plate is legible, so OCR never runs and only the
platform matters. CPU per analysed frame:

| Where | Core-s per analysed frame | Detect | Decode (10 frames) | Plate detection |
|---|---|---|---|---|
| Docker, as shipped | 0.30 | 190 ms | 74 ms | 36 ms |
| Native, CPU EP | 0.19 | 83 ms | 74 ms | 20 ms |
| Native, CoreML | **0.096** | 11 ms | **72 ms (82%)** | 4.6 ms |

Once inference is on the ANE, **decode is what is left**. That makes #5, and analysing a larger
share of the decoded frames, the next lever.

The whole-pipeline runs bounded the fallback at `192/max`. The recommended `128/min` costs about
1.5× more per firing; at one firing per 38 frames that adds ~3 ms per frame (**estimated**).

"Correct" means the plate is in the set of 12 plates hand-read from labelled crops of this clip.
The five errors as shipped were all misreads of known plates: MY51YSU for MW51VSU, VR02FKD for
WR02FKD, LH13VCV for LM13VCV, AV08HVE for AV08HVF, and a cut-off HN144S. After the fixes, one
remains: R02FKO. With CoreML the remaining 0.107 core-s is mostly decode (45 ms) and OCR (26 ms).

**Why latency is also the recall lever (measured).** 67% of grid vehicles that produced any plate
text produced it from **exactly one** OCR read; the median is 1 and p75 is 2 (7-day DB). The
multi-frame consensus the pipeline was built around almost never gets to vote on the grid. Every
core-second saved per frame becomes more looks at each vehicle, which is the only cheap way to
catch a plate at its closest and sharpest.

---

## 3. Accuracy: where plates are lost

### 3.1 Live yield on the grid (measured, DB rows, 11 Oct 20:27–00:15 IST)

| Class | Completed vehicles | Any plate text | Grammar-valid plate |
|---|---|---|---|
| Car | 1,046 | 24.9% | 11.3% |
| Truck | 249 | 34.9% | 19.7% |
| Bus | 81 | 24.7% | 14.8% |
| **Motorcycle** | 122 | **0.8%** | **0%** |

On the 60 confidently labelled legible crops, the reading the platform *stored* was exact on 35
(58%). Of the 45 it marked grammar-valid, **35 were exact (78%)**. So **about one committed grid
plate in five is wrong today, even when the plate is legible**. Typical errors: GJ27DN4954 for
GJ27DM4954, GJ01VF7558 for GJ01WF7558, GJ08DR5116 for GJ08DP5116. These are precisely the reads a
watchlist would act on.

### 3.2 Crop conditioning is the largest accuracy fault (measured)

PP-OCRv4 recognition, run on the same 60 confident grid crops with only the conditioning changed.
Exact match is after the pipeline's own grammar repair.

| Conditioning before recognition | Exact |
|---|---|
| **Raw crop, as the plate detector cut it** | **81.7%** |
| Upscale to 64 px (cubic) or 48 px (linear) only | 81.7% |
| Grayscale | 78.3% |
| Auto-level 2–98% | 78.3% |
| Trim left 7% (HSRP strip) | 78.3% |
| 8% replicate padding only | 73.3% |
| Gamma 0.6 (brighten) | 71.7% |
| Unsharp mask | 68.3% |
| CLAHE only (clip 2.0, 8×8, as configured) | **56.7%** |
| **Pad + CLAHE + upscale: the current `upscaled` variant** | **55.0%** |

**CLAHE is the culprit**: −25 points on its own. Replicate-padding costs 8 more. Upscaling is
neutral, because PP-OCR resizes to 48 px high anyway. With the production engine and only
`variants: [raw]` changed, the result is **50/60 = 83.3%** (95% CI 72–91%). The current path gets
**37/60 = 61.7%** (49–73%). Discordant pairs: 14 crops right only with raw, 1 right only with the
current path. Exact McNemar **p = 0.001**.

The demo camera does not regress. On 40 UK crops it goes from 25/40 to **27/40** (current path to
raw). On the whole demo clip the resolved plates go from 9/14 correct to 12/13 (§2.4).

This reverses `ai-lab/FINDINGS.md` §6 and `PERFORMANCE.md`, which chose the variants on synthetic
plates. On real grid plates the variants hurt.

### 3.3 Recogniser comparison on single grid crops (measured)

| Reader | Grid exact (n=60) | Demo exact (n=40) | Precision of grammar-valid reads | Valid plate claimed on 41 unreadable crops | Docker CPU per crop |
|---|---|---|---|---|---|
| As shipped: 2 variants + fallback | 61.7% | 62.5% | 76% | 5 | 38–50 ms per recognition, up to 2 per look, plus ~0.9 s per fallback |
| **Same engine, `variants: [raw]`** | **83.3%** | **67.5%** | **91%** | 6 | ~30 ms |
| fast-plate-ocr `cct_xs_v2_global`, raw crop | 73.3% | **82.5%** | 86% | 10 | 4.9 ms |
| Raw PP-OCR, fast-plate-ocr if invalid | **88.3%** | 70.0% | 90% | **14** | ~35 ms |
| fast-plate-ocr, PP-OCR if invalid | 83.3% | 82.5% | — | — | ~35 ms |
| **Both agree** (otherwise "uncorroborated") | 39/60 committed, **39/39 correct** | 25 of 27 agreements correct | **100% (grid)** | **0** | ~35 ms |
| PaddleOCR `PP-OCRv6_small_rec` (official ONNX), raw crop | 78.3% | 87.5% | — | 6 | ~23 ms native |
| PaddleOCR `latin_PP-OCRv5_mobile_rec`, raw crop | 71.7% | 75.0% | — | 6 | ~28 ms native |
| PaddleOCR `en_PP-OCRv5_mobile_rec`, raw crop | 61.7% | **90.0%** | — | 3 | ~26–29 ms native |
| PaddleOCR `PP-OCRv6_tiny_rec`, raw crop | 41.7% | 47.5% | — | 3 | ~6 ms native |
| fast-plate-ocr `cct_s_v2_global` | 6.7% | — | — | — | — |
| fast-plate-ocr v1 models and `global_mobile_vit_v2` | 0% | — | — | — | — |

**The recogniser already shipped, `ch_PP-OCRv4_rec`, is the best single model tested on Indian grid
plates, once it is given the raw crop.**

* The newer official PaddleOCR models gain on UK plates but lose on Indian ones: en_PP-OCRv5 has
  90% on the demo but 62% on the grid.
* Swapping models does not beat fixing the conditioning.

* The v1 models and `global_mobile_vit_v2` have **9 output slots**. A standard Indian plate is 10
  characters (GJ01AB1234), so they cannot spell one.
* `cct_s_v2` scored 6.7% for a reason not established. Possibly a preprocessing mismatch; it is not
  recommended.
* fast-plate-ocr v2's published `plate_regions` list 65 countries and "Unknown". **India is not
  among them** (read from the downloaded `*_plate_config.yaml`). It reaches 73% on Indian plates
  without having seen any. A fine-tune is the obvious next step (§6.1), not a task for tonight.

The fallback combination raises exact match, but **it also puts a "valid" plate on 14 of 41 crops a
human could not read**. That is why #3 uses agreement to *grade* a read rather than to replace it:

* **Corroborated**, when the two engines agree: alert-grade.
* **Single-engine**: shown, but not alert-grade.

### 3.4 How small is too small (measured, optimistic)

The 57 confident single-row crops were downscaled with `INTER_AREA`. Real distant plates are also
blurrier, so these numbers are upper bounds.

| Plate width | Original | 80 px | 64 px | 56 px | 48 px | 40 px | 32 px |
|---|---|---|---|---|---|---|---|
| PP-OCRv4, raw | 86% | 76% | 65% | 70% | 28% | 5% | 0% |
| fast-plate-ocr `xs_v2` | 75% | 76% | 56% | 19% | 11% | 0% | 0% |

Reading collapses **below ~50–56 px**, about 5 px per character. The current gates are
`min_plate_width: 40` (localise) and `min_crop_width: 52` (read). Both are in the right place.
**Lowering them buys nothing.**

### 3.5 Two-wheelers and two-row plates

* **Motorcycles: 0.8% plate yield on the grid** (§3.1).
* Only 21 motorcycles were detected against 106 cars on 116 grid snapshots (YOLOv8n COCO, confidence
  0.30). That is implausibly few for Indian traffic, so detector recall on two-wheelers at night is
  suspect (**measured count; the cause is an inference**).
* A two-wheeler plate is far smaller than a car plate. By the width curve above it is unreadable at
  most distances on an overview camera (**estimated** from plate geometry).
* Two-row plates are 4.9% of the stored grid crops, judged by aspect ratio under 2.6.
* On the 7 labelled two-row crops (**too few to rank on**):

  | Reader | Exact | Docker CPU per crop |
  |---|---|---|
  | Shipped fallback | 1–2/7 | 727–737 ms |
  | Fallback at `128/min` | 3/7 | 154 ms |
  | Split into halves, recognise each | 3/7 | 109–122 ms |
  | fast-plate-ocr | 2/7 | 12.5 ms |

**Say so plainly in the demo: two-wheelers are mostly not readable from these overview cameras.**
Do not promise them.

### 3.6 Night

None of the cheap enhancements beat the raw crop on the labelled night-heavy set (§3.2). The dark,
smeared crops (for example the repeated GJ03HR4879 car on SBX-cam10) are unreadable to a human too.

* **Measured**: no conditioning tested here rescues them.
* **Recommended**: get more looks per vehicle (latency, §2) so the sharpest one is read.
* Super-resolution: §6.3.

### 3.7 Plate detection (measured, 58 grid frames)

| Plate-detector input | Plates ≥40 px found in vehicle crops | Native CPU per search |
|---|---|---|
| 256 | 5 (misses 2 of 320's) | 10 ms |
| **320 (current)** | **7** | 14.5 ms |
| 416 | 3 | 23 ms |
| 640 | 4 | 52 ms |

**Keep 320.**

A full-frame search over 640×640 tiles at native resolution found 15 plate-like boxes ≥40 px. Nine
fell outside every detected vehicle, and on inspection they were mostly signboards, the camera's
own on-screen text ("1 CENTER") and motion smear. It costs 407 ms CPU per frame natively, and
several times that in Docker. **Rejected.**

---

## 4. The changes in detail

### 4.1 #1 — Raw crop into the recogniser

* **Change.** In `ai-lab/configs/stream.yaml`:

  ```yaml
  preprocess:
    # Measured on 60 labelled grid crops: CLAHE + replicate padding cost 20+ points of exact
    # match before PP-OCRv4. See docs/research/ANPR_ACCURACY_LATENCY.md §3.2.
    variants: [raw]
  ```

  `stream_demo.yaml` extends `stream.yaml`, so it inherits this. The `raw` variant is already
  implemented: `build_variants` appends the untouched crop.
* **Interaction with the det-fallback.** `_detection_could_help` needs a prepared image ≥36 px
  high. Raw single-row crops are 15–40 px high, so the expensive fallback almost stops firing. That
  is why this change saves CPU on its own. Taller two-row crops still qualify.
* **Verify.**

  ```bash
  python -I eval_ocr.py --engines current,cfg_raw            # on the labelled crops
  python bus_window.py <start> <end>                         # live: before/after plate yield per camera
  ```

  `bus_window.py` (scratchpad root) reads the bus only and opens no stream. It connects to
  `redis://redis:6379`, so run it on the compose network, or change the URL to the published
  `localhost:6379`.
* **Then revisit `plate.schedule.min_interval`.** `stream.yaml` keeps it at 4 because a lower value
  "measured worse … Do not lower this without first buying back the CPU it costs". #1 + #2 buy back
  ~25% on busy scenes; re-measure 3 against 4 with `bus_window.py` before changing it.

### 4.2 #2 — Bound the det-fallback

* **Change.** In `ailab/ocr/rapid.py`:

  ```python
  RapidOCR(intra_op_num_threads=threads, inter_op_num_threads=1,
           det_limit_side_len=128, det_limit_type="min")
  ```

  And in `_detect_and_recognise`: `self._engine(image, use_cls=False)`. Both keyword arguments are
  accepted by `rapidocr-onnxruntime==1.4.4`; the measured cost drop confirms they take effect.
* **Choosing the size.**
  * `192/max` is cheaper on one-row crops: 34 ms against ~150 ms in Docker.
  * `128/min` read one more of the 7 two-row plates.
  * Both are about 5× cheaper than today, or more.
* **Risk.** Two-row recall has only n=7 behind it. The worst plausible case is the same recall as
  today at a fifth of the cost.

### 4.3 #3 — Second reader for corroboration (fast-plate-ocr `cct_xs_v2_global`)

* **Files.**
  * Model: `cct_xs_v2_global.onnx` (3.3 MB), SHA-256
    `8031afb5fdc6b4d80462c9d542f1284ebd2cfddf5dbacd62609848d7e2855f44`, from
    `https://github.com/ankandrew/cnn-ocr-lp/releases/download/arg-plates/cct_xs_v2_global.onnx`.
  * Config: `cct_xs_v2_global_plate_config.yaml`, SHA-256
    `0335c74a305173bb6f393efed0fde03cadeaa0b649ed8e19f431016d8232d0a6`, from the same release.
  * These are the URLs hard-coded in `fast_plate_ocr/inference/hub.py` of `fast-plate-ocr==1.1.0`,
    whose wheel METADATA says `License-Expression: MIT`. `cnn-ocr-lp` is the repo's old name and
    redirects to `https://github.com/ankandrew/fast-plate-ocr/releases/download/arg-plates/`.
  * The [release asset list](https://github.com/ankandrew/fast-plate-ocr/releases/expanded_assets/arg-plates)
    publishes the same SHA-256 (cited). The hub downloader does not check it, so pin it the way
    `fetch_models.sh` already does for the YOLO files.
* **Interface.**
  * Input: `uint8` tensor `[N, 64, 128, 3]`, RGB, plain resize with no aspect keep. Normalisation
    happens inside the graph.
  * Outputs: `plate [N, 10, 37]` (per-slot probabilities over `0-9A-Z_`, with `_` as padding) and
    `region [N, 66]`.
  * Decoding: argmax per slot, drop `_`.
* **Integration.**
  1. Add `ailab/ocr/fast_plate.py`, registered as `@register("ocr", "fast_plate_onnx")`, returning
     `OcrResult` with real `char_confidences` (it produces per-slot probabilities).
  2. In `Pipeline._read_plate`, after the primary read, run the second engine on the same raw crop.
     Store `corroborated = (primary.text == second.text)` on the `PlateRead`. Add the field in
     `ailab/types.py` and carry it into the event.
  3. Let the API raise watchlist alerts automatically only on corroborated reads. Show the rest as
     "single-engine".
  4. Only as a two-row fallback, when the primary read is grammar-invalid **and** the crop aspect is
     below 2.6, accept the second engine's read, tagged uncorroborated.
* **Load the session through `ailab.runtime`.** CLAUDE.md trap #4 applies:
  `intra_op_num_threads=runtime.threads_per_model()`, `inter_op_num_threads=1`.
* **Licence.** Code MIT (verified in the wheel). Weights MIT, by the maintainer's statement in
  [issue #97](https://github.com/ankandrew/fast-plate-ocr/issues/97). There is no LICENSE file
  inside the release assets themselves, so record that issue link next to the pin. The training
  data's sources are undisclosed (§6.1).

### 4.4 #4 — Native macOS worker with CoreML

* **Why.** §2.2. Inside Docker this Mac cannot use SME or the ANE. Natively the detector runs
  10–27× cheaper on CoreML (2–4× on the CPU EP), and the whole pipeline about 4× cheaper.
* **Steps.** `docs/GPU.md` Path 2 already documents a host venv pointed at the published ports.
  Additionally:
  1. **fp32 detector.** The Unity export is all-fp16 (127 fp16 initialisers, no casts), and CoreML
     takes only part of it: 10 partitions, 334 of 411 nodes, no speed-up. The fp32 copy is taken
     whole. It is produced **without retraining or Ultralytics**:

     ```python
     # scratchpad/anpr-research/scripts/fp16_to_fp32.py — initialisers, Constant tensors, Cast targets
     # and graph I/O types fp16 -> fp32; onnx.checker passes
     ```

     Output SHA-256: `f866cb781f690509fdad28303aaab9b0fe49cc81623f999598a8a549a3291c06`.
     Detections are identical to the fp16 export on the CPU EP: 40/40 boxes, IoU > 0.9, mean
     |Δconf| 0.0002.
  2. **Static-shape plate model.** Pin the input to `[1, 3, 320, 320]` with `onnx`, then re-run shape
     inference. SHA-256 `9b0f110c243c683e2140a69a216ede57bd94a69f137fd9f54eebda6b7e7c4864`. CoreML
     cannot take the dynamic-shape original whole. The pipeline's `fixed` strategy already feeds 320.
  3. `detector.device: coreml` (or `auto`). `select_providers` already prefers CoreML when present.
* **Measured.**
  * Whole pipeline (§2.4): 0.107 core-s per analysed frame, identical plates.
  * Detector on 116 grid frames: 232/234 detections match the CPU EP; CPU 11.3 against 71.3 ms per
    frame.
* **Risks.**
  * It breaks the "one `docker compose up`" story, so keep the Docker workers as the fallback.
  * The worker-on-host path has never been run end to end in this repo.
  * The CoreML compile is ~1.4 s per model, once per process.
  * Do not run both on the same cameras at once. The grid quota rules apply to the host worker too.
* **Not measured here.** OCR on CoreML. Thermal behaviour over hours on a fanless Air.

### 4.5 #5 — Do not convert frames that will be dropped

* **Change.** In `StreamReader._run`, call `capture.grab()` for every frame. Call
  `capture.retrieve()` only when a consumer is waiting, or when the held frame is older than about
  one analysis period. Count the rest as dropped, as now. Timing still comes from PTS
  (`CAP_PROP_POS_MSEC` after `grab()`).
* **Effect.** Measured above. With 4–6 streams open per worker, that is roughly 0.3–1 core back
  (**estimated** from the per-stream figures).
* **Risk.** The threading change is small but real. Keep the drop-to-latest semantics and the
  latency accounting exactly as they are.

### 4.6 #6 — Leading junk character

HSRP plates carry a hologram and a vertical "IND" at the left. The recogniser sometimes reads it as
a letter: HGJ01HU2061, KCJ1Y83455. `_NOISE_PREFIX` already strips `IND`. Add one rule: if the
string is invalid, and dropping its first character makes it valid, drop it. +1/60 measured. Unit
test: `HGJ01HU2061 → GJ01HU2061`, and `GJ01HU2061` unchanged.

### 4.7 #7 — int8 plate detector (Docker workers only)

* **How the file was made.** It is derived from the repo's own `plate_yolo11n.onnx`; no retraining.
  * Pin the input to `[1, 3, 320, 320]`.
  * Run `onnxruntime.quantization.quant_pre_process`, then `quantize_static`: QDQ, per-channel,
    S8 weights and S8 activations, percentile calibration on 43 real vehicle crops letterboxed to
    320, with the detection head's decode (`/model.23/`, non-Conv) left in float.
  * Output `plate_yolo11n_static320_int8.onnx`, 3.1 MB, SHA-256
    `155382000413c91698c7785aa8b767816ac63cbc47fa5f97de42b2ddfa42621f`.
  * Reproduce with `scratchpad/anpr-research/scripts/quantize_plate.py`. Calibration crops vary, so
    re-measure agreement after re-generating.
* **Measured.**
  * Docker: 8.8 ms against 28.8 ms per search.
  * The same 21/21 plates ≥40 px as fp32 on vehicle crops from 58 grid snapshots plus 2 demo frames,
    all matched at IoU > 0.5.
  * **Caveat:** some calibration crops come from frames in the test set, and 21 plates is a small
    sample.
* **Why Docker only.** The Linux aarch64 build has the int8 dot-product and i8mm kernels, and the
  guest CPU advertises `asimddp` and `i8mm`. Natively on macOS the same int8 graph was slower than
  fp32.
* **Change.**
  1. Place the file in `ai-lab/models/` (gitignored).
  2. Add it to `scripts/fetch_models.sh` as a *derived* artifact: either a committed conversion
     script, or a pinned hash once it is hosted.
  3. Set `plate.weights: models/plate_yolo11n_static320_int8.onnx` in `stream.yaml`.

  `OnnxYoloModel` takes the fixed input size from the file and warns if `imgsz` disagrees.
* **Verify.** Plate localisations per vehicle over a `bus_window.py` interval before and after.

### 4.8 #8 — A cheaper vehicle detector (later, needs ground truth)

All rows are relative to the fp32/fp16 detector at 640, on 114 grid snapshots.

| Variant | Docker CPU change (interleaved) | ≥100 px vehicles that fp32 @640 finds, also found | Other ≥100 px boxes appearing |
|---|---|---|---|
| int8, fp32 head + stem (percentile, 49 calibration frames) | **−30%** | **107/115 (93%)** | 7 |
| int8, only the head's decode in fp32 (percentile) | **−58%** | 100/115 (87%) | 5 |
| int8, minmax calibration | −58% | 93/115 (81%) | 8 |
| Input 512 (re-export) | −30% | 86/115 (75%) | 29 |
| Input 416 (re-export) | −51% | 83/115 (72%) | 28 |

Most of the disagreements are low-confidence boxes (0.3–0.5) near the threshold. Without labelled
vehicles the **net recall effect is unknown**.

* The int8 variant with a float head and stem is the best candidate: the same saving as 512 input,
  with far better agreement.
* Ship either only after a labelled frame set exists (§7).
* Quantisation-aware training, or calibrating on night frames from the grid, are the obvious next
  steps.
* The re-exports were made in a throwaway venv with Ultralytics 8.3.78 from the official
  `yolov8n.pt` (SHA-256 `f59b3d83…3b36`). Same AGPL lineage as today.

---

## 5. Tried and rejected (measured)

| Idea | Result |
|---|---|
| int8 static QDQ YOLO **natively on macOS** | **Slower**: 94.6 against 86.9 ms (vehicle detector). The same files are 2–3× *faster* in Docker (§4.7–4.8), so where it runs decides |
| fp16 → fp32 detector, in Docker | No gain. fp16 is 5–7% faster interleaved in Docker. fp32 matters only for CoreML (#4). This fits ORT 1.29's source: fp16 CPU kernels are compiled for ARM64 Linux but disabled `__APPLE__`, so natively fp16 pays for Cast pairs (§6.2, cited) |
| CoreML on the fp16 detector | No gain (partial partition) |
| Plate detector at 256, 416 or 640 | Fewer plates ≥40 px than 320 (§3.7) |
| Full-frame tiled plate search | Mostly false positives; 407 ms per frame natively |
| CLAHE, gamma, unsharp, auto-level, grayscale, left-trim before OCR | All at or below the raw crop (§3.2) |
| Lower `min_plate_width` or `min_crop_width` | Exact match collapses below ~50 px (§3.4) |
| fast-plate-ocr v1 and mobile-ViT models | 9 slots; cannot output 10-character Indian plates; 0% |
| More intra-op threads per model | At 2 threads (native, detector @640 and plate model @320): wall −10% to −29%, CPU +35% to +117% depending on spinning. Production's 1 thread is right |
| OpenCV hardware decode (VideoToolbox) natively | Not compiled into the pip OpenCV build: `CAP_PROP_HW_ACCELERATION` stays 0 |
| Run a PaddleOCR rec model through the existing `crnn_onnx` engine | It squashes the crop to 320×48 and feeds RGB; PaddleOCR expects aspect-preserving resize and BGR. en_PP-OCRv5 on the demo set: 77.5% this way against 90.0% with correct preprocessing |

---

## 6. Candidate models and licences (web research)

*Filled from primary sources; see the subsections. Anything not verified on a primary source is
marked as such.*

### 6.1 Plate OCR

**No permissively licensed, ONNX-published plate-OCR model trained on Indian plates was found.**
The table below is cited from primary sources unless a cell says "ours".

| Option | Code licence | Weights licence | Indian plates in training? | Size | Our grid result (§3.3) | Verdict |
|---|---|---|---|---|---|---|
| **PaddleOCR `ch_PP-OCRv4_rec`**, as bundled in `rapidocr-onnxruntime==1.4.4` | Apache-2.0 ([LICENSE](https://github.com/PaddlePaddle/PaddleOCR/blob/main/LICENSE)) | Apache-2.0 | Not stated; document text, not plates | 10.9 MB; wheel file SHA-256 `48fc40f2…683b` | **83.3% with raw crops** | **Keep. Fix the conditioning (#1)** |
| **fast-plate-ocr `cct_xs_v2_global`** ([repo](https://github.com/ankandrew/fast-plate-ocr)) | MIT ([LICENSE](https://github.com/ankandrew/fast-plate-ocr/blob/master/LICENSE)) | **MIT**: the maintainer, 5 Oct 2026, "all code and as well as .keras/.onnx artifacts/models are MIT" ([issue #97](https://github.com/ankandrew/fast-plate-ocr/issues/97)) | **No**: "I didn't include Indian license plate … you need to fine-tune" ([#89](https://github.com/ankandrew/fast-plate-ocr/issues/89)). The custom dataset's sources are not stated | 3.2 MB, 10 slots | 73.3%; 82.5% on UK plates | **Use as the corroborating second reader (#3). Fine-tune on Indian crops later** |
| fast-plate-ocr v1 / mobile-ViT | MIT | MIT | No | 2–7.6 MB, **9 slots** | 0% | Reject: cannot spell a 10-character plate |
| PaddleOCR `en_PP-OCRv5_mobile_rec`, `latin_PP-OCRv5`, `PP-OCRv6_tiny/small` (official ONNX on [Hugging Face, PaddlePaddle](https://huggingface.co/PaddlePaddle)) | Apache-2.0 | Apache-2.0 (model cards) | Not stated. The v5 report covers documents, PDFs and e-books ([arXiv 2507.05595](https://arxiv.org/html/2507.05595v1)) | 4.5–21 MB | 41.7–78.3% | Reject for the grid. en_v5 is the best on UK plates (90%) |
| [Awiros/anpr-ocr](https://huggingface.co/Awiros/anpr-ocr) (India; PP-OCRv5-server architecture, 37.3M parameters) | Apache-2.0 | Apache-2.0, "Copyright 2026 Awiros" | **Yes**: 558,767 samples including 101,774 two-row, but **Gujarat only 1.0%**. Self-reported 98.4% (96.9% two-row) on its own held-out split | 149 MB safetensors, **no ONNX** | not run | **Conditional.** Its seed set is Kaggle "Indian Vehicle Dataset", listed **CC BY-NC-ND 4.0**, plus internal CCTV. Needs a legal read and a Paddle→ONNX export. Not for tonight |
| PARSeq / ViTSTR / clovaai CRNN | Apache-2.0 | Not stated on the releases; scene-text training data under unchecked terms | No | 6–91 MB | not run | Conditional; generic scene text, no plate evidence |
| docTR `crnn_mobilenet_v3_small` via [OnnxTR](https://github.com/felixdittrich92/OnnxTR) | Apache-2.0 | Not stated separately | No (private data) | 7.95 MB | not run | Possible low-risk option; untested |
| TrOCR-small-printed | MIT (unilm) | **No licence field on the model card** | No (receipts) | 62M parameters, autoregressive | not run | Reject: licence unclear, too slow for CPU |
| `Ajitesh-07/PlateOCR`, `subash1652007/indian-plate-ocr`, `zenitsu09/indian-plate-ocr-model` | — | No grant / "non-commercial-research-only" / none | Yes | — | not run | **Reject** |

**Evidence worth knowing** (cited; the licence-less PlateOCR repo is used as evidence only):

* Stock `cct-xs-v2` read **35.4%** of 1,684 real Indian crops exactly. A `cct-s-v2` fine-tune reached
  **72.7%**, at 9.4 ms per crop on a laptop CPU
  ([model card](https://github.com/Ajitesh-07/PlateOCR/blob/main/MODEL_CARD.md)).
* Laroca et al. find two-row plates "challenging to sequential/recurrent-based methods". Commercial
  systems read motorcycles at **33–46%** against cars at **81–96%**
  ([arXiv 2201.00267](https://arxiv.org/abs/2201.00267), [arXiv 2601.07671](https://arxiv.org/html/2601.07671v1)).
  That matches the 0.8% motorcycle yield here.
* No controlled study of "split the rows" against a whole-plate model was found.

**Fine-tune path** (not tonight):

* fast-plate-ocr ships an MIT training CLI and accepts fixed-slot labels for two-row plates
  ("be **consistent**", [issue #39](https://github.com/ankandrew/fast-plate-ocr/issues/39)).
* A few thousand human-checked grid crops (§7) plus synthetic Indian plates is the realistic route
  to a permissive Indian reader.
* Kaggle sets labelled Apache-2.0, MIT or CC0 exist, but their image provenance is unchecked
  (§7.4).

### 6.2 Plate and vehicle detectors

**Design evidence (cited)**

* **Vehicle first, then plate, is right.** Laroca et al. 2021, Table 9: UFPR-ALPR end-to-end
  **90.0%** with vehicle-first detection against **59.6%** detecting plates in the full frame;
  96.9% against 92.7% averaged over 8 datasets ([arXiv 1909.01754](https://arxiv.org/abs/1909.01754)).
  This agrees with our measured rejection of full-frame tiled search (§3.7).
* **Smaller input costs small-object recall.** For the same YOLOv4 weights, small-object AP is
  20.4 / 24.3 / 26.7 at 416 / 512 / 608 ([arXiv 2004.10934](https://arxiv.org/abs/2004.10934)).
  That is why #8 must not ship on the measured CPU saving alone.
* **SAHI tiling** (MIT) gains +5 AP50 on aerial datasets at linear extra cost
  ([arXiv 2202.06934](https://arxiv.org/abs/2202.06934)). It is not tested on plates, and here the
  extra plates were mostly false positives.

**Permissive replacements, if the AGPL detectors have to go** (cited; none measured here)

| Need | Candidate | Licence | Notes |
|---|---|---|---|
| Plate detector, ready-made | [Topurrra/rtdetr-license-plate-detection-onnx](https://huggingface.co/Topurrra/rtdetr-license-plate-detection-onnx) | Apache-2.0 (RT-DETRv2-R18 base; ~3,000 Open Images plates, CC BY) | Fixed 640 ONNX, ~79 MB. Low confidence scores (top box ~0.10–0.15). **Not tested on Indian CCTV**, and an R18 RT-DETR at 640 is far heavier than YOLO11n at 320 (**estimated**). A fine-tune starting point, not a drop-in |
| Train a vehicle or plate detector | [YOLOX](https://github.com/Megvii-BaseDetection/YOLOX) nano/tiny | Apache-2.0 | Nano 0.91M params / 1.08 GFLOPs @416. Ships ONNX |
| | [PP-PicoDet](https://github.com/PaddlePaddle/PaddleDetection) | Apache-2.0 | XS @320: 0.70M params; 3.9 ms on an i7-10750H (vendor figure) |
| | [NanoDet-Plus](https://github.com/RangiLyu/nanodet) | Apache-2.0 | m @320: 1.17M params; 5.25 ms on an i7-8700 (OpenVINO) |
| | [D-FINE](https://github.com/Peterande/D-FINE) N, [DEIM v1](https://github.com/Intellindust-AI-Lab/DEIM), [RT-DETR](https://github.com/lyuwenyu/RT-DETR), [RTMDet via mmdetection](https://github.com/open-mmlab/mmdetection) | Apache-2.0 | Use COCO-only checkpoints. Pin DEIM v1: the same owner relicensed DEIMv2 as non-commercial on 2026-08-24 |
| | [RF-DETR](https://github.com/roboflow/rf-detr) **N/S/M/L only** | Apache-2.0 | Atto/Femto/Pico/XL/2XL are under PML 1.0: **rejected** |

**Rejected:**

* DEIMv2 (non-commercial since 2026-08-24).
* RTMDet via mmyolo (GPL-3.0).
* open-image-models YOLOv9 plate detectors (trained with a GPL-3.0 fork; web-scraped data).
* keremberke YOLOv5 plate models.
* Any "MIT/Apache"-tagged Ultralytics fine-tune: the tag contradicts the framework's terms (§6.4).

**Training data that is clean enough for a detector:**

* Open Images V7 `Vehicle registration plate`: annotations CC BY 4.0, images listed CC BY 2.0.
* [CCPD](https://github.com/detectRecog/CCPD) (MIT; Chinese plates).
* The [Romanian set](https://github.com/RobertLucian/license-plate-dataset) (MIT; day and night).
* Our own grid crops (§7).

**ONNX Runtime facts that explain our measurements** (cited, ORT v1.29.0 source and docs):

* **fp16.** fp16 CPU kernels exist only for Add/Sub/Mul/Div/Conv/pooling/Relu-type ops. They are
  compiled for ARM64 **but disabled under `__APPLE__`**
  ([mlas.h](https://github.com/microsoft/onnxruntime/blob/v1.29.0/onnxruntime/core/mlas/inc/mlas.h)).
  Sigmoid and Resize have none, so SiLU nets get Cast pairs. That is why fp16 lost natively and
  broke even in Docker.
* **int8.** "S8S8 with QDQ is the default setting… should be the first choice"; ARM64 dot-product
  and i8mm kernels exist on Linux
  ([quantization docs](https://onnxruntime.ai/docs/performance/model-optimizations/quantization.html),
  [platform.cpp](https://github.com/microsoft/onnxruntime/blob/v1.29.0/onnxruntime/core/mlas/lib/platform.cpp)).
  That matches int8 winning in Docker and losing natively.
* **Threads.** Spinning is on by default and costs CPU; disable it with
  `session.intra_op.allow_spinning=0`
  ([threading docs](https://onnxruntime.ai/docs/performance/tune-performance/threading.html)).
* **Layout.** ARM64 NCHWc layout kernels are a build option (`onnxruntime_USE_ARM_NEON_NCHWC`)
  that is off by default; the aarch64 PyPI wheel likely lacks them (unverified).

### 6.3 Night, blur and super-resolution

* **Enhancement in front of a frozen recogniser does not help, and often hurts.** That is our CLAHE
  result (§3.2), and it is what the literature found:
  * Fu et al. 2026, "Reading in the Dark": a frozen low-light enhancer in front of TrOCR *raised* CER
    on synthetic dark text (53.16 → 53.57). Only joint training helped (50.02; real night set
    25.26 → 14.43) ([arXiv 2604.23685](https://arxiv.org/abs/2604.23685)).
  * EasyOCR on Brazilian plates: no preprocessing 71.7%; grayscale, CLAHE or a bilateral filter each
    70.75% ([arXiv 2410.13622](https://arxiv.org/abs/2410.13622)).
  * Binarisation loses to grayscale for CRNNs ([arXiv 2008.02777](https://arxiv.org/abs/2008.02777)).
  * Rule: **apply no transform at inference that the recogniser did not see in training.**
  * Zero-DCE / Zero-DCE++ are CC BY-NC: **rejected**.
* **Multi-frame voting is the proven cheap gain.** Per-character majority voting over a vehicle's
  frames took UFPR-ALPR (1080p) from 64.89% to 78.33%, and SSIG from 85.45% to 93.53%
  ([arXiv 1802.09567](https://arxiv.org/abs/1802.09567)). Fusing several OCR *models* took the best
  single model from 92.4% to 97.6% average ([arXiv 2309.04331](https://arxiv.org/abs/2309.04331)).
  * The pipeline already votes per character. What it lacks on the grid is **frames**: a median of
    1 read per vehicle (§2.4). That is the case for #4/#5/#7 and for #3's second model.
  * No paper was found that quantifies variance-of-Laplacian frame selection on its own.
* **Super-resolution: do not use it.**
  * On 11,027 real plates, pre-trained SR then OCR made results **better / equal / worse** for:
    * Real-ESRGAN: 647 / 8,435 / 1,945.
    * LCDNet: 314 / 972 / 9,741.
    * LPSRGAN: 251 / 588 / 10,188.

    The authors note SR "introduces hallucinated characters that were not present in the original
    images" ([LPLC, arXiv 2508.18425](https://arxiv.org/abs/2508.18425)). Documented substitutions
    include W→K, B→R/H, Q→O and M→H.
  * Real-ESRGAN code is BSD-3. The weights carry no separate licence (repo default). The general
    x4v3 weight is small (~1.2M parameters, 4.9 MB), but nothing shows it helps plates.
  * Every plate-specific SR repo checked (LCDNet, PLNET, LPSRGAN, GP_LPR) has **no LICENSE**, and
    their training data is non-commercial: **rejected**.
  * If SR is ever tried, it must never become the evidence of record; keep the original crop.

### 6.4 Licence position of what runs today

| Model in `ai-lab/models/` | Licence string embedded in the ONNX metadata (**read**) | Notes |
|---|---|---|
| `yolov8n.onnx`, `yolo11n.onnx` (COCO; fetched from `huggingface.co/unity/inference-engine-yolo`) | `AGPL-3.0 License (https://ultralytics.com/license)`, Ultralytics 8.3.78 export | Status quo per CLAUDE.md §11 #3. The fp32 and static-shape copies proposed in #4 are derivatives with the same position |
| `plate_yolo11n.onnx` (`morsetechlab/yolov11-license-plate-detection`) | `AGPL-3.0 License`, Ultralytics 8.3.123, trained on ".../License-Plate-Recognition-11/data.yaml" | `ai-lab/README.md` already says it "must be retrained on a permissively licensed or self-collected dataset" before production |
| `activity_yolov8n.onnx` | `AGPL-3.0 License` | Not part of ANPR |
| RapidOCR PP-OCRv4 det, rec and cls (inside the wheel) | Apache-2.0 (cited, §6.1) | Permissive |

None of tonight's recommendations changes this position. #3 adds an MIT model. #4, #7 and #8
re-package the same AGPL weights. The permissive path for the detectors is in §6.2.

**This position is weaker than the repo's docs imply (cited):**

* Ultralytics' licence page says: "All Ultralytics YOLO trained models fall under the AGPL-3.0
  License by default… covers the training code and the models produced by that training code"
  ([ultralytics.com/license](https://www.ultralytics.com/license)).
* The plate model's card is tagged `agpl-3.0`
  ([morsetechlab](https://huggingface.co/morsetechlab/yolov11-license-plate-detection)).
* The Hugging Face repo the COCO detectors are fetched from carries a `gpl-3.0` tag.

So CLAUDE.md §11 #3 ("AGPL code never ships") is true of the *code* in the worker image and **not
of the weights it loads**. Before deployment beyond the hackathon, either:

* open the project under AGPL-3.0 (permitted for "non-profit or government research if the project
  is completely disclosed", per the same page), or
* retrain the detectors in an Apache/MIT framework (§6.2).

---

## 7. Evaluation plan

### 7.1 What to run (none of it opens an organisers' stream)

1. **Crop-level OCR benchmark.** This is what decided #1–#3.

   ```bash
   python -I scratchpad/.../scripts/eval_ocr.py --engines current,cfg_raw,fpo_xs_v2 --dump out.csv
   ```

   It runs against a human-labelled crop CSV (`lid,label,conf,rows`). It reports exact match,
   CER, precision of grammar-valid reads, and **valid plates claimed on unreadable crops** — the
   false-alert proxy. Fold it into the lab as an `ailab ocr-bench` subcommand, so it lives next to
   `ailab evaluate`.
2. **Whole pipeline on a recorded clip with a plate-set ground truth**, through the existing harness:

   ```bash
   ailab run <clip> --config stream_demo --ground-truth gt.csv
   ```

   `gt.csv` holds a `plate` column. For `anpr_demo.mp4` that is the 12 plates in `demo45_labels.csv`.
   The harness's calibration table and threshold sweep are the right place to choose
   `consensus.emit_min_confidence`.
3. **Live before/after on the bus.** Run `bus_window.py <start> <end>` (scratchpad root; it needs
   the compose network or a `localhost:6379` URL) for equal windows at the same time of night,
   before and after #1+#2. It reports plates per minute and the
   share of completed vehicles with a plate, per camera. It reads Redis only and **opens no stream**.
   It is confounded by traffic, so report it as a before/after observation, never as accuracy.
4. **Latency.** Run `profile_pipeline.py --clock cpu` in a throwaway container of the worker image
   (§1) to get core-s per analysed frame. In production, read processing fps and drop rate from the
   worker's progress log.

### 7.2 Which numbers to publish

* **Exact plate match on N human-labelled grid crops**, one read each, with a 95% Wilson interval.
  Split it four ways: day/night, single/two-row, car-truck-bus/two-wheeler, and by camera. Name the
  set "legible grid plates" unless it was sampled without the OCR-success bias (§7.3).
* **Precision of committed (grammar-valid) reads.** This is what a watchlist hit stands on: 76% →
  91% here, after #1.
* **Plate yield**: completed vehicles with a grammar-valid plate, per class, from the live bus.
  Today it is 11–20% for four-wheelers and 0% for two-wheelers.
* **Never quote** the synthetic-footage figures (87.5%/100%, `ai-lab/FINDINGS.md`) or this
  document's AI-labelled numbers as system accuracy. The PS's ">90% under real-world conditions"
  can only be claimed from a human-labelled, representative grid set. On today's evidence it would
  not be met: about 83% on *legible* single crops, before the many unreadable ones are counted.

### 7.3 Labelling 200 grid crops tonight, quickly and honestly

1. **Sample.**
   * The crops in MinIO exist only where the pipeline produced a read. `OutputConfig.save_all_read_crops`
     is defined and **used nowhere**. It is the natural hook for saving every localised plate
     ≥40 px during a sampling window, on cameras already being watched, so no extra stream.
   * Until it exists, sample from MinIO with `fetch_crops.py` and **state the bias**.
   * Stratify 200 crops across cameras and hours, and cap any one vehicle at 2 crops.
2. **Label blind, twice.**
   * Use contact sheets (`blind_sheet.py`) with the model output hidden. Two people label
     independently: the plate text, or `UNREADABLE`, `PARTIAL` or `NOT_A_PLATE`, plus `rows=1|2`.
   * Read only what is visible. Never complete a plate from context.
   * About 10 s per crop, so roughly 35 minutes per person.
3. **Adjudicate.** Disagreements become `UNREADABLE` unless both labellers agree on a fix. Report
   inter-annotator exact agreement.
4. **Split by vehicle, not by crop.** Hold out whole tracks or plates (and ideally whole hours) before
   any tuning or fine-tuning. Multiple crops of one car are not independent samples.
5. **Freeze it.** Version the CSV and crop hashes, and **never tune thresholds on the test split**.

Methodology points from the literature (cited):

* **Score per vehicle pass as the headline; keep per-crop as a diagnostic.** UFPR-ALPR: 64.89% per
  frame against 78.33% per vehicle with voting ([arXiv 1802.09567](https://arxiv.org/abs/1802.09567)).
* **Choose sampled passes independently of the OCR output, and count readable plates the system
  missed.** Otherwise recall failures disappear from the denominator.
* **Hold out by plate, camera and night.**
  * Near-duplicates of training images were found in 19–68% of test images of public LPR sets.
  * CCPD accuracy fell from 80.3% to 77.6% on a fair split
    ([arXiv 2304.04653](https://arxiv.org/abs/2304.04653)).
  * A classifier can tell which dataset a plate came from with more than 95% accuracy
    ([arXiv 2208.10657](https://arxiv.org/abs/2208.10657)), so report seen and unseen cameras
    separately.
* **Label legibility as well as text**: perfect / good / poor / illegible, text only for the first
  three, after LPLC ([arXiv 2508.18425](https://arxiv.org/abs/2508.18425)). Publish the illegible
  count instead of dropping it.
* **How many vehicles it takes to claim ">90%"** (Wilson 95%, one item per vehicle):

  | Vehicles labelled | Accuracy needed for the lower bound to exceed 90% |
  |---|---|
  | 100 | ≥96.0% |
  | 200 | ≥94.5% |
  | 400 | ≥93.0% |
  | 1,000 | ≥91.9% |

  A 200-crop set can *rank* options, as here. It cannot certify 90%.

### 7.4 Datasets vetted (cited; licence read on the primary page or the host's API)

**No permissively licensed, CCTV-style Indian dataset with plate text labels was found.**

| Dataset | Licence | What it is | Verdict |
|---|---|---|---|
| [Zenodo 13954136](https://zenodo.org/records/13954136), Bapatla Engg. College | **CC BY 4.0** | 1,700 phone photos, Andhra Pradesh, with plate strings in an Excel file | **Usable for eval and training**, with attribution. Out of domain: phone, not CCTV. A second test set, never the headline |
| [Gujarat Vehicle Number Plates](https://www.kaggle.com/datasets/paneraghanshyam/gujarat-vehicle-number-plates-yolo-ready) (Kaggle) | Apache-2.0 | 355 images, boxes only, resized to 640 | Detector training only. Provenance not stated; some copy duplicates |
| [tkm22092 Indian Number Plate Images](https://www.kaggle.com/datasets/tkm22092/indian-number-plate-images) | CC0 | ~410 gate-camera images, partial YOLO labels | Detector training only |
| Open Images V7 plates; [CCPD](https://github.com/detectRecog/CCPD); [Romanian LP](https://github.com/RobertLucian/license-plate-dataset); [Roboflow US/EU (350, Open Images subset)](https://public.roboflow.com/object-detection/license-plates-us-eu) | CC BY 4.0 annotations (CC BY 2.0 images) / MIT / MIT / CC BY 4.0 | Boxes. CCPD also has Chinese plate strings | Detector training. Keep per-image attribution for Open Images |
| [abtexp synthetic Indian plates](https://www.kaggle.com/datasets/abtexp/synthetic-indian-license-plates) | CC0 | 18,000 rendered single-row plates | OCR pre-training only; never evaluation |
| UFPR-ALPR, RodoSol-ALPR, LSV-LP, LPLC, UFPR-SR-Plates | Academic / non-commercial only | Closest in kind to our footage. RodoSol has night and two-row plates | **Rejected** |
| OpenALPR benchmarks | AGPL-3.0 | — | **Rejected** |
| DataCluster Labs Indian plates (Kaggle/HF) | Kaggle "CC0", but the owner's own HF copy says CC BY-NC-ND 4.0 | — | **Rejected** (conflicting; newest is NC-ND) |
| IND-VNP, IDD (IIIT-H), ILPD (never released), IEEE DataPort LPR sets | Non-commercial, login-gated, or no licence | — | **Rejected** |
| kedarsai, Mendeley IURS/ANPRIND, thundarstrom/*, umar1103, andrewmvd, CLPD | Permissive tags on **scraped or third-party** images | — | **Rejected**: the uploader cannot grant rights they do not hold |
| Many Kaggle "CC0/Apache" Indian sets with no stated provenance (elysian01, NPDS, avinashjadjasadf, …) | Permissive tag, unknown source | — | **Hold**: not for anything that ships |
| `sonnetechnology/license-plate-text-recognition-full` | — | Text produced by TrOCR | **Never** use for accuracy: machine-made labels |

**Conclusion.** The ">90% real-world" figure can only come from **our own labelled grid crops**
(§7.3). A permissive Indian OCR fine-tune would need our own crops plus synthetic plates; no clean
public Indian text-labelled CCTV set exists.

---

## 8. What is uncertain

* **All grid accuracy figures rest on 60 crops labelled by an AI.** Confidence intervals are wide
  (±10–12 points). The ranking of the options is solid: McNemar p=0.001 for #1. The absolute levels
  are not. Two humans must re-label before anything is published.
* **Vehicle-level gains on the grid are not measured.** Only single-crop accuracy is. The
  whole-pipeline before/after is on the UK demo clip. On the grid the before/after has to come from
  the live bus (`bus_window.py`), not from a recording.
* **Docker timings vary ±30%** with the load of the live stack. Ratios from interleaved runs are
  reliable; single absolute numbers are not.
* **Two-row results are n=7.**
* **The native-CoreML worker has not been run as a service**, only as the batch pipeline.
* **Night two-wheeler recall of the COCO detector** is suspected, not measured, to be poor.
* **The fast-plate-ocr weights' licence rests on a maintainer statement** in a GitHub issue, not on a
  LICENSE file shipped with the weights. Its training data's sources are undisclosed.
* **int8 rests on small checks, and it runs differently natively.**
  * The plate model's agreement is 21 plates, and part of the calibration came from test frames.
  * The vehicle detector's agreement has no ground truth.
  * int8 is a Docker-only win: natively the same files are slower.
* **Native fp16 vs Docker fp16** behave differently, for a cited reason (§6.2). Any number measured
  natively must be re-measured in the worker image before it decides anything for Docker.
* **Untested:** CoreML for OCR; the permissive RT-DETR plate detector; quantised OCR; QAT; and
  longer-running thermal behaviour.

---

## 9. Artifacts (scratchpad, not in the repo)

Root:
`/private/tmp/claude-501/-Users-cypherops-coding-Projects-SIH-ANPR-Vehicle-Tracking/40f51bed-4386-4a51-a0e6-439035dca998/scratchpad/anpr-research/`

| Path | What |
|---|---|
| `scripts/profile_pipeline.py` | Whole-pipeline stage profile, wall or CPU clock. Flags: `--fix-ocr-det`, `--dedupe-variants`, `--coreml`, `--set k=v` |
| `scripts/eval_ocr.py`, `eval_preprocess.py`, `width_curve.py`, `two_row.py` | OCR accuracy on the labelled crops |
| `scripts/bench_yolo.py`, `ab_detector.py`, `bench_coreml.py`, `bench_decode.py`, `bench_blob.py`, `bench_ocr_engines.py` | Micro-benchmarks |
| `scripts/plate_recall.py`, `size_agreement.py`, `quantize_yolo.py`, `quantize_plate.py`, `fp16_to_fp32.py`, `export_sizes.py` | Detector experiments |
| `scripts/fetch_crops.py` | Pulls crops through the API. The token is never printed |
| `data/label/labels150.csv`, `sample150.csv`, `demo45_labels.csv`, `demo45.csv` | Labels: `C` confident, `U` best guess, `X` unreadable, `N` not a plate |
| `data/minio_crops/` | 1,264 + 329 crops, with `manifest*.csv` |
| `models/yolov8n_fp32.onnx` (`f866cb78…1c06`), `models/plate_yolo11n_static320.onnx` (`9b0f110c…7864`) | Derived from the repo's own models |
| `models/plate_yolo11n_static320_int8.onnx` (`15538200…621f`) | #7 |
| `models/yolov8n_int8_pct_fphead.onnx` (`db27e53e…c964`), `yolov8n_int8_pct.onnx` (`5e98dd49…d3bd`) | #8 candidates (not for shipping) |
| `downloads/fpo-*/` | fast-plate-ocr ONNX models and configs; SHA-256 in §4.3 and the list below |
| `downloads/pp-*/` | Official PaddleOCR rec ONNX models (`inference.onnx` + `.yml`) from `huggingface.co/PaddlePaddle/<repo>/resolve/main/` |
| `downloads/yolov8n-export/` | Re-exports at 640/512/480/416 |
| `results/`, `results_docker/` | JSON and CSV outputs behind every table |
| `venv/` (Python 3.11, worker pins + `onnx`), `venv-export/` (torch + Ultralytics, build-time only) | Environments |

SHA-256 of the other downloads:

* `cct_s_v2_global.onnx` — `384bbbd2cea3ef54761d3df70822ef3a349ee1a112aeafddbe0e3ba06bc6e47b`
* `cct_xs_v1_global.onnx` — `c1ae2ae031b10f8ab7ed6e3cdaf8d9c753477e299dbad3579c8f705a7d882134`
* `cct_s_v1_global.onnx` — `5c95b3231fff415b05cb48a3a39fab7c009364c2ee441bef092e0162ab75ea74`
* `global_mobile_vit_v2_ocr.onnx` — `e2fe5946c02e73901f73d21b3b7223a0c3e3b02059d4964fbf279b01af38d63c`
* `en_PP-OCRv5_mobile_rec_onnx/inference.onnx` — `b5f833dfc5d0eb71da397b4efa06ebeee9b431b690a47d6af40d77d8eabc557f`
* `latin_PP-OCRv5_mobile_rec_onnx/inference.onnx` — `7888113072263cb471b93f66dd5e2ad70548dc526fa1ace760d0d973dd121498`
* `PP-OCRv6_tiny_rec_onnx/inference.onnx` — `9ef676d6ed3c88256a2d92c640c44f25b0c40947e111b14b8be8f594091563e6`
* `PP-OCRv6_small_rec_onnx/inference.onnx` — `5435fd747c9e0efe15a96d0b378d5bd157e9492ed8fd80edf08f30d02fa24634`
* `yolov8n.pt` (Ultralytics release v8.3.0, for the re-exports only) — `f59b3d833e2ff32e194b5bb8e08d211dc7c5bdf144b90d2c8412c47ccfc83b36`

The PaddleOCR and fast-plate-ocr hashes match those published by their hosts (cited in §6.1).
