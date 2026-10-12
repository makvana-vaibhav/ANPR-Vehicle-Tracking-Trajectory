# GPU acceleration

Short version: **on this development Mac, inside Docker, there is no GPU and no
setting that creates one.** Everything below explains what is real where, so
nobody spends an afternoon on a switch that cannot exist.

---

## What onnxruntime actually reports

Not inferred — read from the running worker:

```
$ docker exec contrail-ai-worker python -c \
    "import onnxruntime as ort; print(ort.get_available_providers())"
['AzureExecutionProvider', 'CPUExecutionProvider']
```

`AzureExecutionProvider` is a remote-inference client, not local hardware. So
the only compute available in the container is `CPUExecutionProvider`.

## Why, and why it is not fixable here

Docker Desktop on Apple Silicon runs Linux in **Virtualization.framework**,
which passes no GPU into the guest. There is no Metal device, no CoreML, and no
CUDA to forward — Apple Silicon has no NVIDIA hardware at all. This is a
property of the virtualisation layer:

* `--gpus all` is a no-op: it needs the NVIDIA container toolkit and an NVIDIA card.
* `onnxruntime-gpu` will not help — it is a CUDA build, and there is no CUDA.
* There is no "enable GPU" switch in Docker Desktop that changes this.

The CPU-only constraint is recorded in CLAUDE.md §6 and is why every GPU figure
in the docs is labelled **extrapolated**, never *measured*.

---

## The three real paths

| Where | Provider | Status | Use |
|---|---|---|---|
| Docker on Apple Silicon | `CPUExecutionProvider` | **What the demo runs.** | Development, the demo laptop |
| macOS natively (no Docker) | `CoreMLExecutionProvider` | Supported by the code; needs a host install | Getting more cameras out of this Mac |
| Linux + NVIDIA | `CUDAExecutionProvider` | Supported by the code; not testable here | Production / the city deployment |

`device` is set per model in the pipeline config and accepts
`auto` (default), `cpu`, `cuda`, `coreml`.

`auto` takes the best provider actually present. An explicit `cuda` or `coreml`
**raises at startup** when that provider is missing, rather than silently
running on CPU — a GPU deployment that quietly falls back is a capacity plan
wrong by an order of magnitude that reports nothing.

---

## Path 2 — CoreML, by running the worker on the host ("Native worker")

The Apple GPU and Neural Engine are reachable from macOS, just not from a
container — and inside the Linux VM ONNX Runtime cannot use the CPU's SME units
either. So one worker runs on the host and talks to the containerised stack over
published ports. Everything else stays in Docker.

```bash
make worker-native      # opt-in; Ctrl-C stops it cleanly
```

`scripts/worker_native.sh` builds a Python 3.11 venv at
`services/ai-worker/.venv` with the worker's own pins, derives the two model
copies CoreML needs (`make models-derived`: an fp32 copy of the detector —
CoreML takes only part of the fp16 export, for no speed-up — and a
static-shape plate model; both pinned by SHA-256, bit-identical natively and in
the worker image) and runs `python -m ai_worker` with `AI_CONFIG=stream_native`
(`detector.device: coreml`, which fails loudly where CoreML is absent).

**It is a trial by default, and fenced:**

* cameras: `CAM-DEMO-01` only (`NATIVE_CAMERAS`); a grid camera is refused
  without `NATIVE_ALLOW_GRID=1`, because the grid's watch quota applies to this
  process too and no camera may be opened by two workers at once;
* events go to `nagarnetra:events:native-trial`, which nothing consumes, so it
  cannot double-report a vehicle the Docker worker also reports;
* crops go to a private bucket, `nagarnetra-native-trial`;
* two inference threads in all (`AILAB_INFERENCE_BUDGET=2`).

The roster names our gateway `mediamtx`, which the host cannot resolve; the
worker rewrites those URLs to `MEDIAMTX_HOST=localhost`
(`ROSTER_GATEWAY_HOST`), so the camera keeps RTSP and its plate regions.

### Measured, 12 Oct

Same code, same config, same clip (`ai-lab/scripts/profile_clip.py`, demo clip,
38 analysed frames):

| | CPU per analysed frame | Detector | Plate search | Plates |
|---|---|---|---|---|
| Worker image (Docker, CPU) | 0.296–0.297 core-s | 107 ms | 128 ms / frame | 11 valid, 10 in labelled set, 0 wrong |
| **Native, CoreML** | **0.103–0.126 core-s** | **7.7–9.5 ms** | **13.6–16.9 ms / frame** | the same 11 |

CoreML took 230 of 233 detector nodes and 315 of 320 plate-model nodes.

Live, `CAM-DEMO-01`, the same 27 minutes (09:10–09:37 IST), native beside the
Docker worker — which was then still running the code from before the 12 Oct
OCR fixes, so this compares the two *as they stood*, not the two platforms
alone (`ai-lab/scripts/bus_window.py`):

| | Native (new code, CoreML) | Docker (old code) |
|---|---|---|
| Frames analysed | ~14.9 fps of 15 (3% dropped) | a fraction (shares the CPU with the grid) |
| Capture-to-event latency p50 / p90 | **28 / 49 ms** | 330 / 561 ms |
| Valid plates / distinct strings | 1,186 / 19 | 987 / 86 |
| Plates resting on a single OCR read | 9% | 24% |
| OCR reads behind a plate (median) | 5 | 2 |

The native worker read eight of the clip's labelled plates on every one of the
108 loops. Three strings it read just as consistently are not in the labelled
set: `LN13VCV` (the car the two labellers could not agree on: LM13VCV / LH13VCV),
`HN14CDY` (also read by the Docker worker; a plate no sampled crop showed, so
unscored) and `BW61USU` — which is **a misread of `BG65USJ`**: its saved crops
are that plate, legibly. And it never resolved `NA54KGJ` live.

Both workers on the new code, 11:07:30–11:14 IST (after the 11:02 restart):

| | Native (CoreML) | Docker |
|---|---|---|
| Valid plates / in labelled set / not in it / disputed car | 281 / 204 / 51 / 26 | 249 / 196 / 32 / 21 |
| Plates on a single read; reads per plate (median) | 9%; 5 | 9%; 4 |
| Capture-to-event p50 / p90 | 25 / 38 ms | 241 / 337 ms |
| Process CPU | **0.58 cores** at 14.9 analysed fps (0% dropped) — ≈0.039 core-s per analysed frame, every frame decoded | not separable: one process, several cameras |

Plate by plate over those 16 loops: native read the eight on every loop and `BW61USU` on every loop;
Docker read `NA54KGJ` on 10 loops and `BG65USJ` on 3 (and `NA13NRU` on 1 —
native 16). Analysing every frame, where the Docker worker analyses a fraction of them,
changes which looks the multi-frame vote sees, and the scheduler's intervals are counted in analysed frames, tuned
at the slower rate. **The native worker is not uniformly better at reading**:
before switching a camera over, make those intervals time-based and re-measure
on this clip.

### Switching over (not done)

0. **First, fix the reading at 15 fps.** `plate.schedule` and the crop gate
   count analysed frames; at several times the frame rate they look at a vehicle
   several times as often, at near-identical frames. Make them time-based, then
   re-run `profile_clip.py` and a live window on CAM-DEMO-01 until native reads
   at least what Docker reads (`BG65USJ`, `NA54KGJ` above).
1. **Decide per camera, never run both.** Take the camera off the Docker
   workers first (`AI_WORKER_CAMERAS_<n>` narrows each; or drop it from their
   shard), then start the native worker on it.
2. **Publish for real:** `NATIVE_EVENT_STREAM_KEY=nagarnetra:events:detections`
   and `NATIVE_MINIO_BUCKET=nagarnetra-media`, so its events and crops reach the
   API like any worker's.
3. **More cameras:** `NATIVE_CAMERAS=...` and `NATIVE_SLOTS=n`; grid cameras need
   `NATIVE_ALLOW_GRID=1` *and* removing them from the Docker workers, because the
   grid refuses a login when sessions churn.
4. **Supervision:** it runs in a terminal. For a long demo, give it a launchd
   agent or a `while` loop with backoff; nothing restarts it today.
5. **Watch:** thermals over hours on a fanless Air, and CoreML compile time
   (~1–2 s per model, once per process). Neither is measured.
6. **Rollback:** stop it and give the camera back to the Docker workers — no
   data migration, the events are the same shape.

It breaks the "one `docker compose up`" rule (CLAUDE.md §3), so the Docker
workers stay the default and the fallback; this is how to get far more out of
this Mac when that rule can bend.

---

## Path 3 — CUDA, for a real deployment

On a Linux host with an NVIDIA card and the container toolkit installed:

1. Swap `onnxruntime` for `onnxruntime-gpu` in `services/ai-worker/requirements.txt`.
2. Give the service a device reservation in `docker-compose.yml`:

   ```yaml
   ai-worker:
     deploy:
       resources:
         reservations:
           devices:
             - driver: nvidia
               count: 1
               capabilities: [gpu]
   ```

3. Set `device: cuda` in the detector and plate sections of the pipeline
   config, so a missing provider fails loudly instead of falling back.
4. Raise `AI_WORKER_MAX_CAMERAS` — the CPU thread budget stops being the
   constraint once inference leaves the CPU, and decode becomes the limit.

`scripts/capacity_model.py --gpu-speedup` models the fleet-sizing consequence.
Its speedup factor is an **assumption** until someone runs the harness on real
GPU hardware, and the script labels it as one.

---

## What to do instead, on this machine

The CPU path had far more headroom than the missing GPU would have provided,
and it was being wasted rather than used. Before tuning, the worker ran **168
OS threads on 10 cores at 866% CPU** because every ONNX session sized its
thread pool as though it were alone on the machine, and the worker runs one
pipeline per camera.

`ailab/runtime.py` now divides one process-wide budget across the cameras. See
[PERFORMANCE.md](PERFORMANCE.md) for the measurements and the knobs.
