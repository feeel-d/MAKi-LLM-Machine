#!/usr/bin/env bash
set -euo pipefail
export LC_ALL="${LC_ALL:-en_US.UTF-8}"
MODEL="${MODEL:-$HOME/models/qwen.gguf}"
LLAMA_COMPLETION="${LLAMA_COMPLETION:-$HOME/llama.cpp/build/bin/llama-completion}"
THREADS=$(sysctl -n hw.ncpu 2>/dev/null || nproc 2>/dev/null || echo 4)
[[ -x "$LLAMA_COMPLETION" ]] || { echo "❌ llama-completion 없음: $LLAMA_COMPLETION"; exit 1; }
[[ -f "$MODEL" ]] || { echo "❌ 모델 없음: $MODEL"; exit 1; }
echo "=== Qwen Test Start ==="
"$LLAMA_COMPLETION" -m "$MODEL" -n 256 --ctx-size 65536 --threads "$THREADS" --temp 0.7 -no-cnv \
  -p "다음 내용을 보고 구조적으로 정리하고 핵심 논리를 설명해줘:

인공지능은 인간의 의사결정을 보조하는 도구로 발전하고 있으며..."
echo ""
echo "✅ Qwen test OK"
