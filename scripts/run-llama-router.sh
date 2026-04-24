#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUNTIME_DIR="${RUNTIME_DIR:-$ROOT_DIR/.runtime}"
PRESET_PATH="${PRESET_PATH:-$RUNTIME_DIR/llama-router-models.ini}"
TEMPLATE_PATH="${TEMPLATE_PATH:-$ROOT_DIR/config/llama-router-models.template.ini}"
LLAMA_SERVER_BIN="${LLAMA_SERVER_BIN:-$HOME/llama.cpp/build/bin/llama-server}"
MODELS_DIR="${MODELS_DIR:-$HOME/models}"
GEMMA26_MODEL_PATH="${GEMMA26_MODEL_PATH:-$MODELS_DIR/gemma4-26b.gguf}"
GEMMAE4_MODEL_PATH="${GEMMAE4_MODEL_PATH:-$MODELS_DIR/gemma4-e4b.gguf}"
GEMMA26_CTX="${GEMMA26_CTX:-4096}"
GEMMAE4_CTX="${GEMMAE4_CTX:-2048}"
GEMMAE4_N_GPU_LAYERS="${GEMMAE4_N_GPU_LAYERS:-0}"
ROUTER_HOST="${ROUTER_HOST:-127.0.0.1}"
ROUTER_PORT="${ROUTER_PORT:-8081}"
MODELS_MAX="${MODELS_MAX:-2}"

ROUTER_PARALLEL="${ROUTER_PARALLEL:-1}"
ROUTER_BATCH="${ROUTER_BATCH:-512}"
ROUTER_UBATCH="${ROUTER_UBATCH:-256}"
ROUTER_MMPROJ_OFFLOAD="${ROUTER_MMPROJ_OFFLOAD:-0}"

mkdir -p "$RUNTIME_DIR"

sed \
  -e "s#__GEMMA26_MODEL_PATH__#$GEMMA26_MODEL_PATH#g" \
  -e "s#__GEMMAE4_MODEL_PATH__#$GEMMAE4_MODEL_PATH#g" \
  -e "s#__GEMMA26_CTX__#$GEMMA26_CTX#g" \
  -e "s#__GEMMAE4_CTX__#$GEMMAE4_CTX#g" \
  -e "s#__GEMMAE4_N_GPU_LAYERS__#$GEMMAE4_N_GPU_LAYERS#g" \
  "$TEMPLATE_PATH" > "$PRESET_PATH"

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
