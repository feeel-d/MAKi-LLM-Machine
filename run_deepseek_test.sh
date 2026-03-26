#!/usr/bin/env bash
set -euo pipefail
export LC_ALL="${LC_ALL:-en_US.UTF-8}"
MODEL="${MODEL:-$HOME/models/deepseek.gguf}"
LLAMA_COMPLETION="${LLAMA_COMPLETION:-$HOME/llama.cpp/build/bin/llama-completion}"
THREADS=$(sysctl -n hw.ncpu 2>/dev/null || nproc 2>/dev/null || echo 4)
[[ -x "$LLAMA_COMPLETION" ]] || { echo "❌ llama-completion 없음: $LLAMA_COMPLETION"; exit 1; }
[[ -f "$MODEL" ]] || { echo "❌ 모델 없음: $MODEL"; exit 1; }
echo "=== DeepSeek Test Start ==="
PROMPT='다음 글을 구조적으로 분석해서:
1. 핵심 요약 (3줄)
2. 주요 개념 bullet point
3. 인간이 활용할 수 있는 방식

으로 정리해줘:

인공지능은 인간의 인지 능력을 모방하여 문제를 해결하는 기술이다.'
for ctx in 65536 49152 32768 16384; do
  echo "Trying ctx=$ctx"
  if "$LLAMA_COMPLETION" -m "$MODEL" -n 256 --ctx-size "$ctx" --threads "$THREADS" --temp 0.6 -no-cnv -p "$PROMPT"; then
    echo "✅ SUCCESS at ctx=$ctx"
    exit 0
  fi
done
echo "❌ FAILED: All ctx attempts"
exit 1
