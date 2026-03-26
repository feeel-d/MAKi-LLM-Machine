#!/usr/bin/env bash
# llama.cpp upstream: Makefile는 제거되었고 CMake만 지원합니다.
# Metal은 macOS에서 기본 활성화입니다.
# 참고: https://github.com/ggerganov/llama.cpp/blob/master/docs/build.md

set -euo pipefail

ROOT="${LLAMA_CPP_ROOT:-$HOME/llama.cpp}"
JOBS="${JOBS:-$(sysctl -n hw.ncpu)}"

if [[ ! -d "$ROOT/.git" ]]; then
  git clone --depth 1 https://github.com/ggerganov/llama.cpp "$ROOT"
fi

cd "$ROOT"
cmake -B build -DCMAKE_BUILD_TYPE=Release
cmake --build build --config Release -j "$JOBS"

echo "Binaries: $ROOT/build/bin/llama-completion (배치 추론), llama-cli (대화형 TUI)"
