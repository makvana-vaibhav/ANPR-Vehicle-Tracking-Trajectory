#!/usr/bin/env bash
#
# Fetch the ONNX models the lab runs on.
#
# The three vehicle/plate models are Ultralytics exports with class names
# embedded in the model metadata, so the loader configures itself from the
# file. The two face models (the persons watchlist, `ailab/face/`) are OpenCV
# Zoo's YuNet and SFace, run through `cv2.FaceDetectorYN` /
# `cv2.FaceRecognizerSF`. Checksums are pinned: a model that changes under us
# would silently change every number the lab reports, and that must fail
# loudly instead. For the face models it would also make every enrolled
# embedding incomparable with what the cameras compute.
#
# Licences, checked at the source rather than assumed:
#   face_detection_yunet_2023mar.onnx     MIT        (opencv_zoo models/face_detection_yunet/LICENSE)
#   face_recognition_sface_2021dec.onnx   Apache-2.0 (opencv_zoo models/face_recognition_sface/LICENSE)
# Both URLs are pinned to the opencv_zoo commit that last changed the file, so
# the URL itself cannot drift; the SHA-256 is the second lock.
#
# Total download: ~61 MB. No API key, no login.
#
set -euo pipefail

cd "$(dirname "$0")/.."
MODELS_DIR="models"
mkdir -p "$MODELS_DIR"

HF="https://huggingface.co"
ZOO="https://github.com/opencv/opencv_zoo/raw"

# name | url | sha256 | description
MODELS=(
  "yolov8n.onnx|${HF}/unity/inference-engine-yolo/resolve/main/models/yolov8n.onnx|341ad75c98ff88775c63e899e7cbbf497c13161e3393b95b620a6cab65052811|YOLOv8n COCO — vehicles and people (fp16, 640px)"
  "yolo11n.onnx|${HF}/unity/inference-engine-yolo/resolve/main/models/yolo11n.onnx|0690c675a942f4dc4f463b3e4e89520117aeea3fd767784df2934705c91ed11b|YOLO11n COCO — newer alternative detector, for comparison runs"
  "plate_yolo11n.onnx|${HF}/morsetechlab/yolov11-license-plate-detection/resolve/main/license-plate-finetune-v1n.onnx|693133a1db97a3ba1e90068986f80afb72c3fcddb681e57181a89a9a3dc351d6|YOLO11n fine-tuned for licence plates (fp32, dynamic shape)"
  "face_detection_yunet_2023mar.onnx|${ZOO}/f12e12798e8314f7c074a6656816c048dcc95b7a/models/face_detection_yunet/face_detection_yunet_2023mar.onnx|8f2383e4dd3cfbb4553ea8718107fc0423210dc964f9f4280604804ed2552fa4|YuNet face detector (OpenCV Zoo, MIT) — persons watchlist"
  "face_recognition_sface_2021dec.onnx|${ZOO}/ba91a3b91d00d76e86540d4013f944bd6b514e39/models/face_recognition_sface/face_recognition_sface_2021dec.onnx|0ba9fbfa01b5270c96627c4ef784da859931e02f04419c829e83484087c34e79|SFace face recogniser (OpenCV Zoo, Apache-2.0) — 128-d embeddings"
)

sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | awk '{print $1}'
  else shasum -a 256 "$1" | awk '{print $1}'; fi
}

echo "Fetching models into ${MODELS_DIR}/"
for entry in "${MODELS[@]}"; do
  IFS='|' read -r name url expected description <<< "$entry"
  target="${MODELS_DIR}/${name}"

  if [[ -f "$target" ]] && [[ "$(sha256_of "$target")" == "$expected" ]]; then
    echo "  ✓ ${name} (already present)"
    continue
  fi

  echo "  ↓ ${name} — ${description}"
  if ! curl -fsSL --retry 3 --retry-delay 2 -o "${target}.part" "$url"; then
    rm -f "${target}.part"
    echo "    ✗ download failed: ${url}" >&2
    echo "      The lab still runs without this file if you select an engine that" >&2
    echo "      does not need it (e.g. --set plate.engine=contour)." >&2
    exit 1
  fi

  actual="$(sha256_of "${target}.part")"
  if [[ "$actual" != "$expected" ]]; then
    rm -f "${target}.part"
    echo "    ✗ checksum mismatch for ${name}" >&2
    echo "      expected ${expected}" >&2
    echo "      actual   ${actual}" >&2
    echo "      The upstream file changed. Verify it before updating the pin." >&2
    exit 1
  fi
  mv "${target}.part" "$target"
  echo "    ✓ verified"
done

# ── Derived copies (scripts/derive_models.py) ──────────────────────────
# Not downloads: transformations of the pinned files above — no retraining,
# the same weights and the same licence. Made only when asked for:
#   --derived       the fp32 detector and the static-shape plate model that
#                   the native macOS worker runs on CoreML. Data-free, seconds,
#                   bit-identical in the worker image and natively.
#   --int8          also the int8 plate model: Docker only, opt-in config
#                   `stream_int8`, NOT deployed (it loses borderline plates,
#                   ai-lab/PERFORMANCE.md §12). Calibrated on local frames
#                   (runs/_gridsurvey, data/videos/anpr_demo.mp4); ~4.4 GB peak
#                   in the worker image.
#   --python PATH   derive with this Python (requirements-derive.txt installed)
#                   instead of the worker image.
# The pins are what the committed script produced on 12 Oct in the worker image
# (onnxruntime 1.29.0, onnx 1.23.2). A mismatch fails, as a download's would.
# name | sha256 | set | description
DERIVED=(
  "yolov8n_fp32.onnx|f866cb781f690509fdad28303aaab9b0fe49cc81623f999598a8a549a3291c06|native|YOLOv8n COCO widened to fp32 — CoreML runs it whole"
  "plate_yolo11n_static320.onnx|315568cece53c81d7faeeafadb9224e767e3e1176f95bb086f5aa2a43db87e7e|native|plate YOLO11n, input fixed at 1x3x320x320 — CoreML"
  "plate_yolo11n_static320_int8.onnx|25e9f12704a98de60c19c8104af155baa17b8043374c9de8221426bb753943b7|int8|plate YOLO11n, static int8 QDQ — Docker only, opt-in"
)
want_derived=0; want_int8=0; derive_python=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --derived) want_derived=1 ;;
    --int8) want_derived=1; want_int8=1 ;;
    --python) derive_python="${2:?--python needs a path}"; shift ;;
    *) echo "unknown option: $1 (use --derived, --int8, --python PATH)" >&2; exit 2 ;;
  esac
  shift
done

if [[ "$want_derived" == 1 ]]; then
  echo
  echo "Derived copies into ${MODELS_DIR}/"
  todo=()
  for entry in "${DERIVED[@]}"; do
    IFS='|' read -r name expected set description <<< "$entry"
    [[ "$set" == "int8" && "$want_int8" != 1 ]] && continue
    if [[ -f "${MODELS_DIR}/${name}" ]] && [[ "$(sha256_of "${MODELS_DIR}/${name}")" == "$expected" ]]; then
      echo "  ✓ ${name} (already present)"
    else
      echo "  ⚙ ${name} — ${description}"
      todo+=("$name")
    fi
  done
  if [[ ${#todo[@]} -gt 0 ]]; then
    if [[ -n "$derive_python" ]]; then
      AILAB_INFERENCE_BUDGET="${AILAB_INFERENCE_BUDGET:-2}" \
        "$derive_python" scripts/derive_models.py --models "$MODELS_DIR" --only "${todo[@]}"
    else
      if ! docker image inspect contrail/ai-worker:dev >/dev/null 2>&1; then
        echo "    ✗ deriving needs the worker image (make ai) or --python PATH" >&2
        exit 1
      fi
      # onnx goes into a volume beside the image, never into the image itself.
      docker run --rm --pull never -v contrail-derive-tools:/opt/derive \
        -v "$PWD/requirements-derive.txt:/req.txt:ro" --entrypoint /bin/sh contrail/ai-worker:dev -c \
        'PYTHONUSERBASE=/opt/derive PIP_ROOT_USER_ACTION=ignore python -m pip install --user --quiet \
           --disable-pip-version-check --no-warn-script-location -r /req.txt numpy==1.26.4'
      docker run --rm --pull never --cpus 2 --network none -e PYTHONUSERBASE=/opt/derive \
        -e AILAB_INFERENCE_BUDGET=2 -e AILAB_OPENCV_THREADS=1 \
        -v contrail-derive-tools:/opt/derive:ro -v "$PWD:/opt/ailab" \
        -v "$PWD/../data/videos:/opt/data/videos:ro" -w /opt/ailab \
        --entrypoint python contrail/ai-worker:dev scripts/derive_models.py --only "${todo[@]}"
    fi
    for entry in "${DERIVED[@]}"; do
      IFS='|' read -r name expected set description <<< "$entry"
      [[ " ${todo[*]} " == *" ${name} "* ]] || continue
      actual="$(sha256_of "${MODELS_DIR}/${name}")"
      if [[ "$actual" != "$expected" ]]; then
        echo "    ✗ ${name} differs from the measured artifact" >&2
        echo "      expected ${expected}" >&2
        echo "      actual   ${actual}" >&2
        if [[ "$set" == "int8" ]]; then
          echo "      int8 depends on its calibration frames; check it with" >&2
          echo "      scripts/derive_models.py --verify before using it." >&2
        fi
        exit 1
      fi
      echo "  ✓ ${name} verified"
    done
  fi
fi

# RapidOCR ships PP-OCRv4 inside its wheel, so there is nothing to fetch for OCR.
echo
echo "Models ready. OCR models ship inside the rapidocr-onnxruntime wheel (no download)."
echo "Verify everything with:  ailab doctor"
