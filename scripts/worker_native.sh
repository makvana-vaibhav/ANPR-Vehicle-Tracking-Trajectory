#!/usr/bin/env bash
# ══════════════════════════════════════════════════════════════════════
#  One AI worker, run natively on macOS with CoreML — opt-in.
#
#  Inside Docker on Apple Silicon there is no accelerator (docs/GPU.md), and
#  ONNX Runtime in the Linux VM cannot use the CPU's SME units either. Natively
#  the same pipeline, same code, same plates, costs ~0.11 core-s per analysed
#  frame against ~0.30 in the worker image (docs/GPU.md, "Native worker").
#
#  It runs beside the Docker workers, against the same Redis / MinIO / MediaMTX
#  / API through their published ports, and by default it is a TRIAL:
#
#    * cameras      CAM-DEMO-01 only (NATIVE_CAMERAS). A grid camera (SBX-*)
#                   is refused unless NATIVE_ALLOW_GRID=1 — the organisers'
#                   watch quota applies to this process as much as any other,
#                   and a camera must never be opened by two workers at once.
#    * events       to nagarnetra:events:native-trial (NATIVE_EVENT_STREAM_KEY),
#                   which nothing consumes, so it cannot double-report a
#                   vehicle the Docker worker is also reporting.
#    * crops        to the private bucket nagarnetra-native-trial
#                   (NATIVE_MINIO_BUCKET), created if missing.
#
#  Switching a camera over for real (docs/GPU.md, "Switching over"): take it
#  off the Docker workers first, then run with
#      NATIVE_EVENT_STREAM_KEY=nagarnetra:events:detections
#      NATIVE_MINIO_BUCKET=nagarnetra-media
#
#  Usage:  make worker-native            (Ctrl-C stops it cleanly)
# ══════════════════════════════════════════════════════════════════════
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VENV="${REPO}/services/ai-worker/.venv"
MODELS="${REPO}/ai-lab/models"

die() { printf '\033[31m✗ %s\033[0m\n' "$*" >&2; exit 1; }

[[ "$(uname -s)" == "Darwin" && "$(uname -m)" == "arm64" ]] \
  || die "the native worker is for Apple Silicon macOS; everywhere else run the Docker workers (make ai)"

CAMERAS="${NATIVE_CAMERAS:-CAM-DEMO-01}"
if [[ "$(printf %s "${CAMERAS}" | tr "[:lower:]" "[:upper:]")" == *SBX* && "${NATIVE_ALLOW_GRID:-0}" != "1" ]]; then
  die "NATIVE_CAMERAS names a grid camera (${CAMERAS}); refused without NATIVE_ALLOW_GRID=1"
fi
EVENTS="${NATIVE_EVENT_STREAM_KEY:-nagarnetra:events:native-trial}"
BUCKET="${NATIVE_MINIO_BUCKET:-nagarnetra-native-trial}"

# ── environment: Python 3.11, the worker's own pins ─────────────────────
PY="${PYTHON311:-$(command -v python3.11 || true)}"
[[ -n "${PY}" ]] || die "python3.11 not found (set PYTHON311=/path/to/python3.11)"
if [[ ! -x "${VENV}/bin/python" ]]; then
  printf 'creating %s\n' "${VENV}"
  "${PY}" -m venv "${VENV}"
fi
STAMP="${VENV}/.requirements.sha256"
WANT="$(cat "${REPO}/services/ai-worker/requirements.txt" "${REPO}/ai-lab/requirements-derive.txt" | shasum -a 256 | cut -d' ' -f1)"
if [[ "$(cat "${STAMP}" 2>/dev/null)" != "${WANT}" ]]; then
  printf 'installing the worker pins into %s\n' "${VENV}"
  # As the worker image does it: RapidOCR without its non-headless OpenCV.
  grep -v '^rapidocr-onnxruntime' "${REPO}/services/ai-worker/requirements.txt" > "${VENV}/base-requirements.txt"
  "${VENV}/bin/python" -m pip install --quiet --disable-pip-version-check -r "${VENV}/base-requirements.txt"
  "${VENV}/bin/python" -m pip install --quiet --disable-pip-version-check --no-deps rapidocr-onnxruntime==1.4.4
  # onnx only to derive the two model copies below; numpy held at the pin.
  "${VENV}/bin/python" -m pip install --quiet --disable-pip-version-check \
      -r "${REPO}/ai-lab/requirements-derive.txt" numpy==1.26.4
  "${VENV}/bin/python" -m pip install --quiet --disable-pip-version-check --no-deps -e "${REPO}/ai-lab"
  printf '%s' "${WANT}" > "${STAMP}"
fi
"${VENV}/bin/python" -c "import onnxruntime as o, sys; sys.exit(0 if 'CoreMLExecutionProvider' in o.get_available_providers() else 1)" \
  || die "this onnxruntime build has no CoreML provider"

# ── the two model copies CoreML needs (pinned in ai-lab/scripts/fetch_models.sh) ──
"${REPO}/ai-lab/scripts/fetch_models.sh" --derived --python "${VENV}/bin/python"

# ── the platform, through its published ports ───────────────────────────
env_value() {  # a single key from .env, never echoed
  awk -F= -v k="$1" '$1==k { sub(/^[^=]*=/, ""); sub(/[ \t]+#.*$/, ""); gsub(/^["'\'']|["'\'']$/, ""); print; exit }' "${REPO}/.env"
}
[[ -f "${REPO}/.env" ]] || die ".env not found; the native worker needs the MinIO credentials from it"
MINIO_USER="$(env_value MINIO_ROOT_USER)"
MINIO_PASS="$(env_value MINIO_ROOT_PASSWORD)"
# Redis requires a password and MediaMTX an identity to read (docs/SECURITY.md);
# both come from .env and are passed through the environment, never echoed.
REDIS_PASS="$(env_value REDIS_PASSWORD)"
MTX_READ_PASS="$(env_value MEDIAMTX_READ_PASSWORD)"
[[ -n "${REDIS_PASS}" ]] || die "REDIS_PASSWORD is not set in .env — run make env"
REDISCLI_AUTH="${REDIS_PASS}" redis-cli -h localhost -p 6379 ping >/dev/null 2>&1 \
  || REDIS_PASSWORD="${REDIS_PASS}" "${VENV}/bin/python" -c "import os, redis; redis.Redis(host='localhost', port=6379, password=os.environ['REDIS_PASSWORD']).ping()" \
  || die "Redis is not reachable on localhost:6379 — is the stack up (make up)?"

MINIO_ROOT_USER="${MINIO_USER}" MINIO_ROOT_PASSWORD="${MINIO_PASS}" BUCKET="${BUCKET}" \
"${VENV}/bin/python" - <<'PY'
import os
from minio import Minio
client = Minio("localhost:9000", access_key=os.environ["MINIO_ROOT_USER"],
               secret_key=os.environ["MINIO_ROOT_PASSWORD"], secure=False)
bucket = os.environ["BUCKET"]
if not client.bucket_exists(bucket):
    client.make_bucket(bucket)   # private: no policy is ever set from here
PY

printf '\033[1mnative AI worker\033[0m — CoreML · cameras %s · events → %s · crops → %s\n' \
  "${CAMERAS}" "${EVENTS}" "${BUCKET}"

export PYTHONPATH="${REPO}/services/ai-worker"
export OPENCV_FFMPEG_CAPTURE_OPTIONS="rtsp_transport;tcp"
export REDIS_URL="redis://:${REDIS_PASS}@localhost:6379/0"
export MEDIAMTX_READ_PASSWORD="${MTX_READ_PASS}"
export EVENT_STREAM_KEY="${EVENTS}"
export MEDIAMTX_HOST="localhost"
export MEDIAMTX_API_URL="http://localhost:9997"
export MINIO_ENDPOINT="localhost:9000"
export MINIO_BUCKET="${BUCKET}"
export MINIO_ROOT_USER="${MINIO_USER}"
export MINIO_ROOT_PASSWORD="${MINIO_PASS}"
export AI_CONFIG="${NATIVE_AI_CONFIG:-stream_native}"
export AI_MODELS_DIR="${MODELS}"
export AI_WORKER_SOURCE="registry"
export AI_WORKER_CAMERAS="${CAMERAS}"
export AI_WORKER_INDEX=0
export AI_WORKER_COUNT=1
export AI_WORKER_MAX_CAMERAS="${NATIVE_SLOTS:-1}"
export AI_WORKER_PINNED="${CAMERAS}"
export AI_WORKER_ALWAYS_ON="${CAMERAS}"
export AI_WORKER_SLICE_SECONDS=0
# Two inference threads in all: the live demo shares this machine, and CoreML
# does the heavy lifting off the CPU anyway. Never AILAB_ORT_THREADS (trap 4).
export AILAB_INFERENCE_BUDGET="${NATIVE_INFERENCE_BUDGET:-2}"
export AILAB_OPENCV_THREADS=1
export LOG_LEVEL="${LOG_LEVEL:-INFO}"
exec "${VENV}/bin/python" -m ai_worker
