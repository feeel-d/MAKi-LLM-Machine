#!/usr/bin/env bash
# Gemma4 지원 포함 최신 llama.cpp 갱신/재빌드 (macOS/Metal 기준)
set -euo pipefail

LLAMA_CPP_ROOT="${LLAMA_CPP_ROOT:-$HOME/llama.cpp}"
BUILD_DIR="${BUILD_DIR:-$LLAMA_CPP_ROOT/build}"
JOBS="${JOBS:-$(sysctl -n hw.ncpu 2>/dev/null || echo 8)}"

if [[ ! -d "$LLAMA_CPP_ROOT/.git" ]]; then
  echo "❌ llama.cpp git 저장소가 아닙니다: $LLAMA_CPP_ROOT"
  echo "   먼저: git clone https://github.com/ggml-org/llama.cpp \"$LLAMA_CPP_ROOT\""
  exit 1
fi

cd "$LLAMA_CPP_ROOT"
echo "[1/3] git fetch/pull ..."
git fetch origin
current_branch="$(git rev-parse --abbrev-ref HEAD)"
if [[ "$current_branch" == "HEAD" ]]; then
  current_branch="master"
fi
git pull --ff-only origin "$current_branch" || git pull --ff-only origin master || git pull --ff-only origin main

echo "[2/3] cmake configure ..."
cmake -B "$BUILD_DIR" -DCMAKE_BUILD_TYPE=Release

echo "[3/3] cmake build -j $JOBS ..."
cmake --build "$BUILD_DIR" -j "$JOBS"

echo ""
echo "✅ llama.cpp updated"
"$BUILD_DIR/bin/llama-server" --version || true
"$BUILD_DIR/bin/llama-completion" --version || true
