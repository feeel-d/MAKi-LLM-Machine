#!/usr/bin/env bash
# 로컬 LLM 환경: Homebrew → llama.cpp 빌드 → Gemma 4 GGUF → 테스트 스크립트
# 사용: ./setup-local-llm.sh
# 옵션(환경변수):
#   SKIP_DOWNLOAD=1     모델 wget 생략
#   SKIP_ZSHRC=1        ~/.zshrc 셸 도우미 추가 생략
#   FORCE_LLAMA_REBUILD=1  llama.cpp 재빌드
#   LLAMA_CPP_ROOT       기본 ~/llama.cpp
#   GEMMA26_URL / GEMMAE4_URL  Gemma 4 GGUF (기본 bartowski Q4_K_M)

set -euo pipefail

export LC_ALL="${LC_ALL:-en_US.UTF-8}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LLAMA_CPP_ROOT="${LLAMA_CPP_ROOT:-$HOME/llama.cpp}"
MODELS_DIR="${MODELS_DIR:-$HOME/models}"
JOBS="${JOBS:-$( (sysctl -n hw.ncpu 2>/dev/null || nproc 2>/dev/null || echo 4) )}"

GEMMA26_URL="${GEMMA26_URL:-https://huggingface.co/bartowski/google_gemma-4-26B-A4B-it-GGUF/resolve/main/google_gemma-4-26B-A4B-it-Q4_K_M.gguf}"
GEMMAE4_URL="${GEMMAE4_URL:-https://huggingface.co/bartowski/google_gemma-4-E4B-it-GGUF/resolve/main/google_gemma-4-E4B-it-Q4_K_M.gguf}"

echo "[1/5] 의존성 (git, cmake, wget)…"
if ! command -v brew >/dev/null 2>&1; then
  echo "Homebrew가 없습니다. https://brew.sh 에서 설치한 뒤 다시 실행하세요."
  exit 1
fi
brew install git cmake wget

echo "[2/5] llama.cpp 클론/빌드 (CMake, macOS 기본 Metal)…"
if [[ ! -d "$LLAMA_CPP_ROOT/.git" ]]; then
  git clone --depth 1 https://github.com/ggerganov/llama.cpp "$LLAMA_CPP_ROOT"
fi
cd "$LLAMA_CPP_ROOT"
if [[ "${FORCE_LLAMA_REBUILD:-0}" == "1" ]] || [[ ! -x "$LLAMA_CPP_ROOT/build/bin/llama-completion" ]]; then
  cmake -B build -DCMAKE_BUILD_TYPE=Release
  cmake --build build --config Release -j "$JOBS"
else
  echo "  (기존 llama-completion 사용, FORCE_LLAMA_REBUILD=1 로 재빌드 가능)"
fi

LLAMA_COMPLETION="$LLAMA_CPP_ROOT/build/bin/llama-completion"
if [[ ! -x "$LLAMA_COMPLETION" ]]; then
  echo "❌ 빌드 실패: $LLAMA_COMPLETION"
  exit 1
fi

echo "[3/5] 모델 디렉터리…"
mkdir -p "$MODELS_DIR"

if [[ "${SKIP_DOWNLOAD:-0}" != "1" ]]; then
  echo "[4/5] Gemma 4 GGUF 다운로드 (이미 있으면 이어받기)…"
  wget -c -O "$MODELS_DIR/gemma4-26b.gguf" "$GEMMA26_URL"
  wget -c -O "$MODELS_DIR/gemma4-e4b.gguf" "$GEMMAE4_URL"
else
  echo "[4/5] SKIP_DOWNLOAD=1 → 모델 다운로드 생략"
  [[ -f "$MODELS_DIR/gemma4-26b.gguf" ]] || echo "  경고: $MODELS_DIR/gemma4-26b.gguf 없음"
  [[ -f "$MODELS_DIR/gemma4-e4b.gguf" ]] || echo "  경고: $MODELS_DIR/gemma4-e4b.gguf 없음"
fi

echo "[5/5] 프로젝트 테스트 스크립트 갱신…"
cat > "$SCRIPT_DIR/run_gemma26_test.sh" <<'EOS'
#!/usr/bin/env bash
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
EOS
chmod 0755 "$SCRIPT_DIR/run_gemma26_test.sh"

cat > "$SCRIPT_DIR/run_gemmae4_test.sh" <<'EOS'
#!/usr/bin/env bash
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
EOS
chmod 0755 "$SCRIPT_DIR/run_gemmae4_test.sh"

if [[ "${SKIP_ZSHRC:-0}" != "1" ]]; then
  echo "[5b] ~/.zshrc 에 gemmae4-run 등록…"
  if [[ -f "$HOME/.zshrc" ]] && grep -qF "gemmae4-run()" "$HOME/.zshrc" 2>/dev/null; then
    echo "  (이미 등록됨, 건너뜀)"
  else
    cat >> "$HOME/.zshrc" <<'ZSH'

# --- MAKi local LLM: Gemma E4B (llama-completion) ---
gemmae4-run() {
  command "$HOME/llama.cpp/build/bin/llama-completion" \
    -m "$HOME/models/gemma4-e4b.gguf" \
    -t "$(sysctl -n hw.ncpu)" \
    --ctx-size 16384 \
    --temp 0.7 \
    -no-cnv \
    "$@"
}
# --- end MAKi local LLM ---
ZSH
    echo "  새 터미널에서 적용되거나: source ~/.zshrc"
  fi
else
  echo "[5b] SKIP_ZSHRC=1 → .zshrc 수정 생략"
fi

echo ""
echo "=============================="
echo "✅ SETUP COMPLETE"
echo ""
echo "바이너리: $LLAMA_COMPLETION"
echo "모델:     $MODELS_DIR/gemma4-26b.gguf , $MODELS_DIR/gemma4-e4b.gguf"
echo ""
echo "GGUF 스모크: cd $SCRIPT_DIR && ./run_gemma26_test.sh && ./run_gemmae4_test.sh"
echo "스택 HTTP:   ./scripts/start-all.sh 후  npm run test:local"
echo "빠른 실행:   gemmae4-run -p '요약해줘: …'"
echo "=============================="
