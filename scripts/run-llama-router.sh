#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUNTIME_DIR="${RUNTIME_DIR:-$ROOT_DIR/.runtime}"
PRESET_PATH="${PRESET_PATH:-$RUNTIME_DIR/llama-router-models.ini}"
# e4: gemmae4 슬롯만 / full: gemma26 + gemmae4
MAKI_ROUTER_PROFILE="${MAKI_ROUTER_PROFILE:-e4}"
LLAMA_SERVER_BIN="${LLAMA_SERVER_BIN:-$HOME/llama.cpp/build/bin/llama-server}"
MODELS_DIR="${MODELS_DIR:-$HOME/models}"
GEMMA26_MODEL_PATH="${GEMMA26_MODEL_PATH:-$MODELS_DIR/gemma4-26b.gguf}"
GEMMAE4_MODEL_PATH="${GEMMAE4_MODEL_PATH:-$MODELS_DIR/gemma4-e4b.gguf}"
# Gemma 4 E4B vision — bartowski HF (≈990MB). Required for image_url / internal body-from-image.
GEMMAE4_MMPROJ_PATH="${GEMMAE4_MMPROJ_PATH:-$MODELS_DIR/mmproj-google_gemma-4-E4B-it-f16.gguf}"
GEMMA26_CTX="${GEMMA26_CTX:-4096}"
# CoT·비전·긴 JSON 출력 여유 — RAM 부족 시 4096 등으로 낮춤
GEMMAE4_CTX="${GEMMAE4_CTX:-8192}"
GEMMAE4_N_GPU_LAYERS="${GEMMAE4_N_GPU_LAYERS:-0}"
ROUTER_HOST="${ROUTER_HOST:-127.0.0.1}"
ROUTER_PORT="${ROUTER_PORT:-8081}"
ROUTER_PARALLEL="${ROUTER_PARALLEL:-1}"
# 고해상도 비전 토큰·CoT 배치 여유 (메모리 ↑)
ROUTER_BATCH="${ROUTER_BATCH:-1024}"
# 비전(mmproj) 배치는 ubatch보다 클 수 있음 — 256이면 assert로 자식 서버가 죽을 수 있음
ROUTER_UBATCH="${ROUTER_UBATCH:-1024}"
ROUTER_MMPROJ_OFFLOAD="${ROUTER_MMPROJ_OFFLOAD:-0}"

if [[ "$MAKI_ROUTER_PROFILE" == "full" ]]; then
  TEMPLATE_PATH="${TEMPLATE_PATH:-$ROOT_DIR/config/llama-router-models.template.ini}"
  MODELS_MAX="${MODELS_MAX:-2}"
else
  TEMPLATE_PATH="${TEMPLATE_PATH:-$ROOT_DIR/config/llama-router-models-gemmae4.template.ini}"
  MODELS_MAX="${MODELS_MAX:-1}"
fi

mkdir -p "$RUNTIME_DIR"

if [[ ! -f "$GEMMAE4_MMPROJ_PATH" ]]; then
  echo "run-llama-router: Gemma E4B mmproj not found: $GEMMAE4_MMPROJ_PATH" >&2
  echo "  Fix: ./scripts/download-gemma-models.sh  또는 GEMMAE4_MMPROJ_PATH 설정" >&2
  exit 1
fi
if [[ ! -f "$GEMMAE4_MODEL_PATH" ]]; then
  echo "run-llama-router: Gemma E4B GGUF not found: $GEMMAE4_MODEL_PATH" >&2
  exit 1
fi

if [[ "$MAKI_ROUTER_PROFILE" == "full" ]]; then
  if [[ ! -f "$GEMMA26_MODEL_PATH" ]]; then
    echo "run-llama-router: Gemma 26B GGUF not found: $GEMMA26_MODEL_PATH" >&2
    exit 1
  fi
  sed \
    -e "s#__GEMMA26_MODEL_PATH__#$GEMMA26_MODEL_PATH#g" \
    -e "s#__GEMMAE4_MODEL_PATH__#$GEMMAE4_MODEL_PATH#g" \
    -e "s#__GEMMAE4_MMPROJ_PATH__#$GEMMAE4_MMPROJ_PATH#g" \
    -e "s#__GEMMA26_CTX__#$GEMMA26_CTX#g" \
    -e "s#__GEMMAE4_CTX__#$GEMMAE4_CTX#g" \
    -e "s#__GEMMAE4_N_GPU_LAYERS__#$GEMMAE4_N_GPU_LAYERS#g" \
    "$TEMPLATE_PATH" > "$PRESET_PATH"
else
  sed \
    -e "s#__GEMMAE4_MODEL_PATH__#$GEMMAE4_MODEL_PATH#g" \
    -e "s#__GEMMAE4_MMPROJ_PATH__#$GEMMAE4_MMPROJ_PATH#g" \
    -e "s#__GEMMAE4_CTX__#$GEMMAE4_CTX#g" \
    -e "s#__GEMMAE4_N_GPU_LAYERS__#$GEMMAE4_N_GPU_LAYERS#g" \
    "$TEMPLATE_PATH" > "$PRESET_PATH"
fi

ARGS=(
  --models-preset "$PRESET_PATH"
  --models-max "$MODELS_MAX"
  --host "$ROUTER_HOST"
  --port "$ROUTER_PORT"
  --parallel "$ROUTER_PARALLEL"
  --batch-size "$ROUTER_BATCH"
  --ubatch-size "$ROUTER_UBATCH"
  --no-webui
)

if [[ -n "${LLAMA_API_KEY:-}" ]]; then
  ARGS+=(--api-key "$LLAMA_API_KEY")
fi

if [[ "$ROUTER_MMPROJ_OFFLOAD" != "1" ]]; then
  ARGS+=(--no-mmproj-offload)
fi

exec "$LLAMA_SERVER_BIN" "${ARGS[@]}"
