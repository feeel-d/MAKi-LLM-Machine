#!/usr/bin/env bash
# 로컬 GGUF 추론 스모크 (llama.cpp) — 기본: Gemma 4 E4B

set -euo pipefail

export LC_ALL="${LC_ALL:-en_US.UTF-8}"

LLAMA_COMPLETION="${LLAMA_COMPLETION:-$HOME/llama.cpp/build/bin/llama-completion}"
MODEL="${MODEL:-$HOME/models/gemma4-e4b.gguf}"
CTX="${CTX:-16384}"
N_PREDICT="${N_PREDICT:-256}"
THREADS="${THREADS:-$(sysctl -n hw.ncpu)}"

if [[ ! -x "$LLAMA_COMPLETION" ]]; then
  echo "❌ llama-completion 없음: $LLAMA_COMPLETION"
  echo "   빌드: bash $(dirname "$0")/scripts/build-llama-cpp.sh"
  exit 1
fi

if [[ ! -f "$MODEL" ]]; then
  echo "❌ 모델 파일 없음: $MODEL"
  echo "   예: ./setup-local-llm.sh  또는  ./scripts/download-gemma-models.sh"
  exit 1
fi

run_once() {
  local ctx="$1"
  local n="$2"
  local prompt="$3"
  "$LLAMA_COMPLETION" \
    -m "$MODEL" \
    -n "$n" \
    -c "$ctx" \
    -t "$THREADS" \
    --temp 0.7 \
    -no-cnv \
    -p "$prompt"
}

echo "Running test (ctx=$CTX, n_predict=$N_PREDICT)..."
set +e
run_once "$CTX" "$N_PREDICT" "$(cat <<'PROMPT'
다음 문장을 3줄로 요약하고 핵심을 bullet point로 정리해줘:
인공지능은 인간의 사고를 모방하는 기술로...
PROMPT
)"
EXIT_CODE=$?
set -e

if [[ $EXIT_CODE -ne 0 ]]; then
  echo "❌ Failed (exit $EXIT_CODE). Retrying with lower context..."
  run_once 8192 128 "AI를 간단히 설명해줘"
fi

echo "✅ Done."
