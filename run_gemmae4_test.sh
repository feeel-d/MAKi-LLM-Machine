#!/usr/bin/env bash
# Gemma 4 E4B — Qwen 테스트와 동일하게 단일 ctx 로 스모크 (가벼운 쪽)
set -euo pipefail
export LC_ALL="${LC_ALL:-en_US.UTF-8}"
MODEL="${MODEL:-$HOME/models/gemma4-e4b.gguf}"
LLAMA_COMPLETION="${LLAMA_COMPLETION:-$HOME/llama.cpp/build/bin/llama-completion}"
THREADS=$(sysctl -n hw.ncpu 2>/dev/null || nproc 2>/dev/null || echo 4)
[[ -x "$LLAMA_COMPLETION" ]] || { echo "❌ llama-completion 없음: $LLAMA_COMPLETION"; exit 1; }
[[ -f "$MODEL" ]] || { echo "❌ 모델 없음: $MODEL"; exit 1; }
echo "=== Gemma 4 E4B Test Start ==="
"$LLAMA_COMPLETION" -m "$MODEL" -n 128 --ctx-size 16384 --threads "$THREADS" --temp 0.7 -no-cnv \
  -p "한 문장으로 답해줘: 머신러닝이란 무엇인가?"
echo ""
echo "✅ Gemma E4B test OK"
