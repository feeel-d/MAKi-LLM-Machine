#!/usr/bin/env bash
# Gemma 4 GGUF 두 개를 ~/models 에 받습니다 (llama-server 4슬롯용).
# 사용: ./scripts/download-gemma-models.sh
set -euo pipefail

export LC_ALL="${LC_ALL:-en_US.UTF-8}"
MODELS_DIR="${MODELS_DIR:-$HOME/models}"
GEMMA26_URL="${GEMMA26_URL:-https://huggingface.co/bartowski/google_gemma-4-26B-A4B-it-GGUF/resolve/main/google_gemma-4-26B-A4B-it-Q4_K_M.gguf}"
GEMMAE4_URL="${GEMMAE4_URL:-https://huggingface.co/bartowski/google_gemma-4-E4B-it-GGUF/resolve/main/google_gemma-4-E4B-it-Q4_K_M.gguf}"

mkdir -p "$MODELS_DIR"
command -v wget >/dev/null 2>&1 || { echo "wget 필요: brew install wget"; exit 1; }

echo "→ $MODELS_DIR/gemma4-26b.gguf"
wget -c -O "$MODELS_DIR/gemma4-26b.gguf" "$GEMMA26_URL"
echo "→ $MODELS_DIR/gemma4-e4b.gguf"
wget -c -O "$MODELS_DIR/gemma4-e4b.gguf" "$GEMMAE4_URL"
echo "✅ Gemma GGUF 다운로드 완료"
