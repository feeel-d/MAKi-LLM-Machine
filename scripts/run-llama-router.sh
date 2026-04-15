#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUNTIME_DIR="${RUNTIME_DIR:-$ROOT_DIR/.runtime}"
PRESET_PATH="${PRESET_PATH:-$RUNTIME_DIR/llama-router-models.ini}"
TEMPLATE_PATH="${TEMPLATE_PATH:-$ROOT_DIR/config/llama-router-models.template.ini}"
LLAMA_SERVER_BIN="${LLAMA_SERVER_BIN:-$HOME/llama.cpp/build/bin/llama-server}"
MODELS_DIR="${MODELS_DIR:-$HOME/models}"
DEEPSEEK_MODEL_PATH="${DEEPSEEK_MODEL_PATH:-$MODELS_DIR/deepseek.gguf}"
QWEN_MODEL_PATH="${QWEN_MODEL_PATH:-$MODELS_DIR/qwen.gguf}"
GEMMA26_MODEL_PATH="${GEMMA26_MODEL_PATH:-$MODELS_DIR/gemma4-26b.gguf}"
GEMMAE4_MODEL_PATH="${GEMMAE4_MODEL_PATH:-$MODELS_DIR/gemma4-e4b.gguf}"
DEEPSEEK_CTX="${DEEPSEEK_CTX:-16384}"
QWEN_CTX="${QWEN_CTX:-16384}"
GEMMA26_CTX="${GEMMA26_CTX:-16384}"
GEMMAE4_CTX="${GEMMAE4_CTX:-16384}"
ROUTER_HOST="${ROUTER_HOST:-127.0.0.1}"
ROUTER_PORT="${ROUTER_PORT:-8080}"
# DeepSeek + Qwen + Gemma26 + GemmaE4 = 4 slots; raises unified-memory use — lower ctx or load-on-startup in preset if needed.
MODELS_MAX="${MODELS_MAX:-4}"

mkdir -p "$RUNTIME_DIR"

sed \
  -e "s#__DEEPSEEK_MODEL_PATH__#$DEEPSEEK_MODEL_PATH#g" \
  -e "s#__QWEN_MODEL_PATH__#$QWEN_MODEL_PATH#g" \
  -e "s#__GEMMA26_MODEL_PATH__#$GEMMA26_MODEL_PATH#g" \
  -e "s#__GEMMAE4_MODEL_PATH__#$GEMMAE4_MODEL_PATH#g" \
  -e "s#__DEEPSEEK_CTX__#$DEEPSEEK_CTX#g" \
  -e "s#__QWEN_CTX__#$QWEN_CTX#g" \
  -e "s#__GEMMA26_CTX__#$GEMMA26_CTX#g" \
  -e "s#__GEMMAE4_CTX__#$GEMMAE4_CTX#g" \
  "$TEMPLATE_PATH" > "$PRESET_PATH"

ARGS=(
  --models-preset "$PRESET_PATH"
  --models-max "$MODELS_MAX"
  --host "$ROUTER_HOST"
  --port "$ROUTER_PORT"
  --no-webui
)

if [[ -n "${LLAMA_API_KEY:-}" ]]; then
  ARGS+=(--api-key "$LLAMA_API_KEY")
fi

exec "$LLAMA_SERVER_BIN" "${ARGS[@]}"
