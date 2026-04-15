#!/usr/bin/env bash
# Gemma 4 26B — DeepSeek 테스트와 동일하게 ctx 를 내려가며 재시도 (메모리·KV 한계 대비)
set -euo pipefail
export LC_ALL="${LC_ALL:-en_US.UTF-8}"
MODEL="${MODEL:-$HOME/models/gemma4-26b.gguf}"
LLAMA_COMPLETION="${LLAMA_COMPLETION:-$HOME/llama.cpp/build/bin/llama-completion}"
THREADS=$(sysctl -n hw.ncpu 2>/dev/null || nproc 2>/dev/null || echo 4)
[[ -x "$LLAMA_COMPLETION" ]] || { echo "❌ llama-completion 없음: $LLAMA_COMPLETION"; exit 1; }
[[ -f "$MODEL" ]] || { echo "❌ 모델 없음: $MODEL"; exit 1; }
echo "=== Gemma 4 26B Test Start ==="
PROMPT='다음을 한국어로 간단히 요약해줘 (3문장 이내):
인공지능은 패턴 인식과 예측을 통해 문제를 해결하는 기술이다.'
for ctx in 16384 8192 4096; do
  echo "Trying ctx=$ctx"
  if "$LLAMA_COMPLETION" -m "$MODEL" -n 128 --ctx-size "$ctx" --threads "$THREADS" --temp 0.7 -no-cnv -p "$PROMPT"; then
    echo "✅ SUCCESS at ctx=$ctx"
    exit 0
  fi
done
echo "❌ FAILED: All ctx attempts"
exit 1
