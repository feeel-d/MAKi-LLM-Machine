#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUNTIME_DIR="${RUNTIME_DIR:-$ROOT_DIR/.runtime}"
PRESET_PATH="${PRESET_PATH:-$RUNTIME_DIR/llama-router-models.ini}"
# MAKI_ROUTER_PROFILE=dq2 → DeepSeek+Qwen 만
# MAKI_ROUTER_PROFILE=g3  → DeepSeek+Qwen+Gemma26 (E4B 슬롯 제외, 메모리·로드 실패 회피)
_DEFAULT_TEMPLATE="$ROOT_DIR/config/llama-router-models.template.ini"
if [[ "${MAKI_ROUTER_PROFILE:-full}" == "dq2" ]]; then
  _DEFAULT_TEMPLATE="$ROOT_DIR/config/llama-router-models.template.dq2.ini"
elif [[ "${MAKI_ROUTER_PROFILE:-full}" == "g3" ]]; then
  _DEFAULT_TEMPLATE="$ROOT_DIR/config/llama-router-models.template.g3.ini"
fi
TEMPLATE_PATH="${TEMPLATE_PATH:-$_DEFAULT_TEMPLATE}"
LLAMA_SERVER_BIN="${LLAMA_SERVER_BIN:-$HOME/llama.cpp/build/bin/llama-server}"
MODELS_DIR="${MODELS_DIR:-$HOME/models}"
DEEPSEEK_MODEL_PATH="${DEEPSEEK_MODEL_PATH:-$MODELS_DIR/deepseek.gguf}"
QWEN_MODEL_PATH="${QWEN_MODEL_PATH:-$MODELS_DIR/qwen.gguf}"
GEMMA26_MODEL_PATH="${GEMMA26_MODEL_PATH:-$MODELS_DIR/gemma4-26b.gguf}"
GEMMAE4_MODEL_PATH="${GEMMAE4_MODEL_PATH:-$MODELS_DIR/gemma4-e4b.gguf}"
DEEPSEEK_CTX="${DEEPSEEK_CTX:-16384}"
QWEN_CTX="${QWEN_CTX:-16384}"
# Gemma는 KV가 커서 기본 8192 — OOM·로드 실패 시 4096 등으로 낮춤
GEMMA26_CTX="${GEMMA26_CTX:-8192}"
GEMMAE4_CTX="${GEMMAE4_CTX:-8192}"
ROUTER_HOST="${ROUTER_HOST:-127.0.0.1}"
# nginx 등이 8080을 쓰는 경우가 많아 기본은 8081 (게이트웨이 기본 LLAMA_SERVER_URL과 맞춤)
ROUTER_PORT="${ROUTER_PORT:-8081}"
# DeepSeek + Qwen + Gemma26 + GemmaE4 = 4 slots; dq2=2, g3=3
_MODELS_MAX_DEFAULT=4
if [[ "${MAKI_ROUTER_PROFILE:-full}" == "dq2" ]]; then
  _MODELS_MAX_DEFAULT=2
elif [[ "${MAKI_ROUTER_PROFILE:-full}" == "g3" ]]; then
  _MODELS_MAX_DEFAULT=3
fi
MODELS_MAX="${MODELS_MAX:-$_MODELS_MAX_DEFAULT}"

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
