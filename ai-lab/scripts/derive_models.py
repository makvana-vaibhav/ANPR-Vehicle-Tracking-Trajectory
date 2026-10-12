#!/usr/bin/env python3
"""Derive the deployment variants of the lab's detectors, reproducibly.

No retraining and no Ultralytics: every output is a transformation of a file
`fetch_models.sh` already pins by SHA-256, so it carries exactly that file's
weights and licence (the AGPL-3.0 export, see ai-lab/README.md). Needs `onnx`
(Apache-2.0) at derivation time only — `requirements-derive.txt` — never in
the worker image.

    yolov8n_fp32.onnx                  from yolov8n.onnx
        The Unity export is fp16 throughout. CoreML takes only part of an fp16
        graph (10 partitions, no speed-up) but all of an fp32 one, so the
        native macOS worker needs this copy. Initialisers, Constant tensors,
        Cast targets and graph I/O go fp16 -> fp32; nothing else changes.

    plate_yolo11n_static320.onnx       from plate_yolo11n.onnx
        The same graph with its input pinned to [1, 3, 320, 320] — the size the
        pipeline's `fixed` strategy always feeds — and shapes re-inferred.
        CoreML cannot take the dynamic-shape original whole. Also the base of:

    plate_yolo11n_static320_int8.onnx  from plate_yolo11n_static320.onnx
        Static QDQ int8: per-channel, S8 weights and activations, percentile
        calibration on real vehicle crops letterboxed exactly as the pipeline
        does it, with the detection head's decode (`/model.23/`, non-Conv) left
        in float. For the Docker workers only: the Linux aarch64 build has int8
        dot-product kernels and the plate search falls from ~29 to ~9 ms;
        natively on macOS the same graph is slower than fp32.

Calibration is deterministic: vehicle crops are cut by the lab's own vehicle
detector from a fixed, sorted list of frames — every other frame of
`runs/_gridsurvey/` (grid snapshots, local only) plus every 30th frame of
`data/videos/anpr_demo.mp4` — and the list is written to
`<model>.calibration.json` next to the model. The *other* half of those frames
is held out for `--verify`, which compares the int8 plate detector against the
fp32 one the workers run today and fails if it loses plates.

Run it in the worker image, which is where the int8 file runs and whose ONNX
Runtime build it was measured with (`make models-derived`); the SHA-256 pinned
in fetch_models.sh is what that produces. ORT sessions here, including those
the quantiser builds for itself, take their threads from `ailab.runtime`.

Usage:
    python scripts/derive_models.py [--models models] [--out DIR] [--only NAME ...] [--verify]
"""

from __future__ import annotations

import argparse
import contextlib
import hashlib
import json
import sys
from collections.abc import Iterator
from pathlib import Path

import cv2
import numpy as np
import onnx
import onnxruntime as ort
from onnx import TensorProto, numpy_helper

LAB = Path(__file__).resolve().parents[1]
REPO = LAB.parent
if str(LAB) not in sys.path:
    sys.path.insert(0, str(LAB))

from ailab import runtime  # noqa: E402
from ailab.detect.onnx_backend import OnnxYoloModel  # noqa: E402
from ailab.detect.postprocess import letterbox  # noqa: E402
from ailab.types import BBox  # noqa: E402

FP32_DETECTOR = "yolov8n_fp32.onnx"
STATIC_PLATE = "plate_yolo11n_static320.onnx"
INT8_PLATE = "plate_yolo11n_static320_int8.onnx"

PLATE_SIZE = 320
VEHICLE_CLASSES = {"car", "motorcycle", "bus", "truck"}
#: The pipeline searches a vehicle for a plate only above this width
#: (`plate.schedule.min_vehicle_width` in stream.yaml), with this much padding.
MIN_VEHICLE_WIDTH = 100
VEHICLE_PAD = 0.05
CALIBRATION_CROPS = 64
#: A plate narrower than this is never read (`plate.min_plate_width`), so it is
#: the size at which int8 and fp32 must agree.
VERIFY_MIN_PLATE_WIDTH = 40


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


# ── fp16 -> fp32 ─────────────────────────────────────────────────────────
def _to_fp32(tensor: TensorProto) -> TensorProto:
    array = numpy_helper.to_array(tensor).astype(np.float32)
    return numpy_helper.from_array(array, tensor.name)


def fp16_to_fp32(src: Path, dst: Path) -> None:
    model = onnx.load(str(src))
    graph = model.graph
    converted = 0
    for i, init in enumerate(graph.initializer):
        if init.data_type == TensorProto.FLOAT16:
            graph.initializer[i].CopyFrom(_to_fp32(init))
            converted += 1
    for node in graph.node:
        for attr in node.attribute:
            if node.op_type == "Cast" and attr.name == "to" and attr.i == TensorProto.FLOAT16:
                attr.i = TensorProto.FLOAT
            if attr.type == onnx.AttributeProto.TENSOR and attr.t.data_type == TensorProto.FLOAT16:
                attr.t.CopyFrom(_to_fp32(attr.t))
                converted += 1
    for value in [*graph.input, *graph.output, *graph.value_info]:
        if value.type.tensor_type.elem_type == TensorProto.FLOAT16:
            value.type.tensor_type.elem_type = TensorProto.FLOAT
    onnx.checker.check_model(model)
    onnx.save(model, str(dst))
    print(f"  {dst.name}: {converted} fp16 tensors widened to fp32")


# ── dynamic -> static 320 ────────────────────────────────────────────────
def pin_input(src: Path, dst: Path, size: int = PLATE_SIZE) -> None:
    model = onnx.load(str(src))
    graph = model.graph
    for dim, value in zip(graph.input[0].type.tensor_type.shape.dim, (1, 3, size, size),
                          strict=True):
        dim.ClearField("dim_param")
        dim.dim_value = value
    del graph.value_info[:]
    model = onnx.shape_inference.infer_shapes(model, strict_mode=True)
    # ONNX's inference cannot carry the anchor count through the export's
    # Shape/Reshape arithmetic, so the outputs are pinned to what ONNX Runtime
    # actually produces for this input.
    options = ort.SessionOptions()
    options.intra_op_num_threads = runtime.threads_per_model()
    options.inter_op_num_threads = 1
    session = ort.InferenceSession(model.SerializeToString(), options,
                                   providers=["CPUExecutionProvider"])
    produced = session.run(None, {graph.input[0].name: np.zeros((1, 3, size, size), np.float32)})
    for output, array in zip(model.graph.output, produced, strict=True):
        output.type.tensor_type.ClearField("shape")
        for value in array.shape:
            output.type.tensor_type.shape.dim.add().dim_value = int(value)
    onnx.checker.check_model(model)
    onnx.save(model, str(dst))
    shapes = [list(array.shape) for array in produced]
    print(f"  {dst.name}: input [1, 3, {size}, {size}], outputs {shapes}")


# ── calibration data ─────────────────────────────────────────────────────
def _frames(split: str) -> Iterator[tuple[str, np.ndarray]]:
    """Calibration ("calib") or held-out ("verify") frames, in a fixed order."""
    survey = sorted((LAB / "runs" / "_gridsurvey").glob("*.jpg"))
    for i, path in enumerate(survey):
        if (i % 2 == 0) == (split == "calib"):
            image = cv2.imread(str(path))
            if image is not None:
                yield f"runs/_gridsurvey/{path.name}", image
    clip = REPO / "data" / "videos" / "anpr_demo.mp4"
    capture = cv2.VideoCapture(str(clip))
    index = 0
    while capture.isOpened():
        ok, image = capture.read()
        if not ok:
            break
        if index % 30 == (0 if split == "calib" else 15):
            yield f"data/videos/anpr_demo.mp4#{index}", image
        index += 1
    capture.release()


def vehicle_crops(models: Path, split: str) -> list[tuple[str, np.ndarray]]:
    """Vehicle crops the pipeline would search, cut exactly as it cuts them."""
    detector = OnnxYoloModel(models / "yolov8n.onnx", imgsz=640, device="cpu")
    wanted = {cid for cid, name in detector.names.items() if name in VEHICLE_CLASSES}
    crops = []
    for source, image in _frames(split):
        height, width = image.shape[:2]
        boxes, _scores, _ids, _ = detector.infer(image, conf=0.30, iou=0.45,
                                                 allowed_class_ids=wanted)
        for box in sorted(boxes.tolist()):
            bbox = BBox(*box).clip(width, height)
            if bbox.width < MIN_VEHICLE_WIDTH:
                continue
            x1, y1, x2, y2 = bbox.expand(VEHICLE_PAD, width, height).as_int()
            crop = image[y1:y2, x1:x2]
            if crop.size:
                # A copy: a slice would keep the whole decoded frame alive.
                crops.append((f"{source}@{x1},{y1},{x2},{y2}", crop.copy()))
    return crops


def _blob(crop: np.ndarray) -> np.ndarray:
    """What `OnnxYoloModel.infer` feeds an fp32 model."""
    padded, _scale, _pad = letterbox(crop, PLATE_SIZE)
    blob = padded[:, :, ::-1].transpose(2, 0, 1)[None]
    return np.ascontiguousarray(blob, dtype=np.float32) / np.float32(255.0)


@contextlib.contextmanager
def _budgeted_sessions() -> Iterator[None]:
    """Sessions the quantiser builds for itself, sized by `ailab.runtime`.

    It constructs bare `SessionOptions()`, which is ONNX Runtime's one thread
    per core — CLAUDE.md trap 4, on a machine running the live demo.
    """
    real = ort.SessionOptions

    def budgeted() -> ort.SessionOptions:
        options = real()
        options.intra_op_num_threads = runtime.threads_per_model()
        options.inter_op_num_threads = 1
        # The calibration graph outputs every intermediate tensor, and the CPU
        # arena grows to hold them all and never gives memory back: measured
        # in the worker image, the int8 derivation was killed at 4 GB with
        # the arena on.
        options.enable_cpu_mem_arena = False
        return options

    ort.SessionOptions = budgeted
    try:
        yield
    finally:
        ort.SessionOptions = real


def quantize_plate(models: Path, src: Path, dst: Path) -> None:
    from onnxruntime.quantization import (
        CalibrationDataReader,
        CalibrationMethod,
        QuantFormat,
        QuantType,
        quantize_static,
    )
    from onnxruntime.quantization.shape_inference import quant_pre_process

    crops = vehicle_crops(models, "calib")
    # Round-robin over sources so neither the grid nor the demo clip dominates.
    by_source: dict[str, list[tuple[str, np.ndarray]]] = {}
    for name, crop in crops:
        by_source.setdefault(name.split("@")[0].split("#")[0], []).append((name, crop))
    chosen: list[tuple[str, np.ndarray]] = []
    while len(chosen) < CALIBRATION_CROPS and any(by_source.values()):
        for queue in by_source.values():
            if queue and len(chosen) < CALIBRATION_CROPS:
                chosen.append(queue.pop(0))
    if not chosen:
        sys.exit("no calibration crops: need runs/_gridsurvey/*.jpg or data/videos/anpr_demo.mp4")

    input_name = onnx.load(str(src)).graph.input[0].name

    class Reader(CalibrationDataReader):
        def __init__(self) -> None:
            self._items = iter([{input_name: _blob(crop)} for _name, crop in chosen])

        def get_next(self) -> dict[str, np.ndarray] | None:
            return next(self._items, None)

    pre = dst.with_suffix(".pre.onnx")
    with _budgeted_sessions():
        # The graph is fully static by now, so ONNX's own shape inference is
        # enough; the symbolic pass would only add sympy as a dependency.
        quant_pre_process(str(src), str(pre), skip_symbolic_shape=True)
        prepared = onnx.load(str(pre))
        head_decode = [
            node.name for node in prepared.graph.node
            if node.name.startswith("/model.23/") and node.op_type != "Conv"
        ]
        quantize_static(
            str(pre), str(dst), Reader(),
            quant_format=QuantFormat.QDQ,
            per_channel=True,
            activation_type=QuantType.QInt8,
            weight_type=QuantType.QInt8,
            calibrate_method=CalibrationMethod.Percentile,
            nodes_to_exclude=head_decode,
            # Bounded: unbounded, the calibrator holds every activation of
            # every crop at once, and on a laptop running the live stack
            # that was an out-of-memory kill inside the Docker VM.
            extra_options={"CalibMaxIntermediateOutputs": 16},
        )
    pre.unlink(missing_ok=True)

    # The loader configures itself from Ultralytics' metadata (class names,
    # stride); carry it over from the source.
    source_meta = {p.key: p.value for p in onnx.load(str(src)).metadata_props}
    model = onnx.load(str(dst))
    present = {p.key for p in model.metadata_props}
    for key, value in source_meta.items():
        if key not in present:
            model.metadata_props.add(key=key, value=value)
    onnx.save(model, str(dst))

    manifest = {
        "model": dst.name,
        "source": {"file": src.name, "sha256": sha256(src)},
        "method": "static QDQ, per-channel, S8/S8, percentile; /model.23/ non-Conv in float",
        "onnxruntime": ort.__version__,
        "onnx": onnx.__version__,
        "head_decode_left_in_float": len(head_decode),
        "crops": [name for name, _crop in chosen],
    }
    dst.with_suffix(".calibration.json").write_text(json.dumps(manifest, indent=2))
    print(f"  {dst.name}: {len(chosen)} calibration crops from {len(by_source)} source(s), "
          f"{len(head_decode)} head-decode nodes in float")


# ── verification ─────────────────────────────────────────────────────────
def verify_int8(models: Path, out: Path) -> bool:
    """Does the int8 plate model find the plates the fp32 one finds?

    Compared on held-out vehicle crops (the frames calibration did not use):
    every plate at least `VERIFY_MIN_PLATE_WIDTH` wide that the fp32 model the
    workers run today finds must be found by int8 at IoU > 0.5.
    """
    fp32 = OnnxYoloModel(models / "plate_yolo11n.onnx", imgsz=PLATE_SIZE, device="cpu")
    int8 = OnnxYoloModel(out / INT8_PLATE, imgsz=PLATE_SIZE, device="cpu")
    crops = vehicle_crops(models, "verify")
    reference = found = extra = 0
    for _name, crop in crops:
        def plates(model: OnnxYoloModel, image: np.ndarray = crop) -> list[BBox]:
            boxes, _s, _i, _ = model.infer(image, conf=0.25, iou=0.45, max_detections=16,
                                           imgsz=PLATE_SIZE)
            return [b for b in (BBox(*map(float, box)) for box in boxes)
                    if b.width >= VERIFY_MIN_PLATE_WIDTH]

        want, got = plates(fp32), plates(int8)
        reference += len(want)
        found += sum(1 for w in want if any(w.iou(g) > 0.5 for g in got))
        extra += sum(1 for g in got if not any(g.iou(w) > 0.5 for w in want))
    print(f"  verify: {len(crops)} held-out vehicle crops; int8 found {found}/{reference} "
          f"of the fp32 plates >= {VERIFY_MIN_PLATE_WIDTH}px; {extra} plate(s) fp32 did not find")
    return reference > 0 and found == reference


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--models", type=Path, default=LAB / "models",
                        help="where the pinned source models are")
    parser.add_argument("--out", type=Path, default=None,
                        help="where to write the derived ones (default: --models)")
    parser.add_argument("--only", nargs="*", default=None,
                        help=f"subset of {FP32_DETECTOR} {STATIC_PLATE} {INT8_PLATE}")
    parser.add_argument("--verify", action="store_true",
                        help="check the int8 plate model against fp32; exit 1 if it loses plates")
    args = parser.parse_args()

    runtime.apply_opencv_threads()
    models: Path = args.models
    out: Path = args.out or models
    out.mkdir(parents=True, exist_ok=True)
    wanted = set(args.only or [FP32_DETECTOR, STATIC_PLATE, INT8_PLATE])
    print(f"deriving from {models} into {out} (onnxruntime {ort.__version__}, onnx {onnx.__version__}, "
          f"{runtime.threads_per_model()} thread(s) per session)")
    if FP32_DETECTOR in wanted:
        fp16_to_fp32(models / "yolov8n.onnx", out / FP32_DETECTOR)
    if STATIC_PLATE in wanted or INT8_PLATE in wanted:
        pin_input(models / "plate_yolo11n.onnx", out / STATIC_PLATE)
    if INT8_PLATE in wanted:
        quantize_plate(models, out / STATIC_PLATE, out / INT8_PLATE)
    for name in sorted(wanted):
        path = out / name
        if path.exists():
            print(f"  sha256 {name} {sha256(path)}")
    if args.verify and not verify_int8(models, out):
        print("  int8 plate model LOST plates against fp32; do not deploy it", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
