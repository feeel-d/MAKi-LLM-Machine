#!/usr/bin/env bash
# Qwen GGUF 배치 추론 테스트 (~/models/qwen.gguf 필요)

set -euo pipefail

export LC_ALL="${LC_ALL:-en_US.UTF-8}"

MODEL="${MODEL:-$HOME/models/qwen.gguf}"
LLAMA_COMPLETION="${LLAMA_COMPLETION:-$HOME/llama.cpp/build/bin/llama-completion}"
THREADS=$(sysctl -n hw.ncpu)

if [[ ! -x "$LLAMA_COMPLETION" ]]; then
  echo "❌ llama-completion 없음: $LLAMA_COMPLETION"
  exit 1
fi
if [[ ! -f "$MODEL" ]]; then
  echo "❌ 모델 없음: $MODEL"
  echo "   예: wget -c -O \"\$HOME/models/qwen.gguf\" \\"
  echo "     \"https://huggingface.co/bartowski/Qwen2.5-7B-Instruct-GGUF/resolve/main/Qwen2.5-7B-Instruct-Q4_K_M.gguf\""
  exit 1
fi

echo "=== Qwen Test Start ==="

"$LLAMA_COMPLETION" \
  -m "$MODEL" \
  -n 256 \
  --ctx-size 65536 \
  --threads "$THREADS" \
  --temp 0.7 \
  -no-cnv \
  -p "다음 내용을 보고 구조적으로 정리하고 핵심 논리를 설명해줘:

인공지능은 인간의 의사결정을 보조하는 도구로 발전하고 있으며..."

echo ""
echo "✅ Qwen test OK"
