#!/usr/bin/env bash
# 로컬 LLM 환경 일괄 구성 (Homebrew 의존성 → llama.cpp 빌드 → GGUF → 테스트 스크립트 → zsh 함수)
# 사용: ./setup-local-llm.sh
# 옵션(환경변수):
#   SKIP_DOWNLOAD=1     모델 wget 생략 (이미 ~/models 에 있을 때)
#   SKIP_ZSHRC=1        ~/.zshrc 에 deepseek-run / qwen-run 추가 생략
#   FORCE_LLAMA_REBUILD=1  llama.cpp 를 항상 다시 빌드
#   LLAMA_CPP_ROOT       기본 ~/llama.cpp
#   GEMMA26_URL / GEMMAE4_URL  Gemma 4 GGUF (기본 bartowski Q4_K_M)

set -euo pipefail

export LC_ALL="${LC_ALL:-en_US.UTF-8}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LLAMA_CPP_ROOT="${LLAMA_CPP_ROOT:-$HOME/llama.cpp}"
MODELS_DIR="${MODELS_DIR:-$HOME/models}"
JOBS="${JOBS:-$( (sysctl -n hw.ncpu 2>/dev/null || nproc 2>/dev/null || echo 4) )}"

DEEPSEEK_URL="${DEEPSEEK_URL:-https://huggingface.co/bartowski/DeepSeek-Coder-V2-Lite-Instruct-GGUF/resolve/main/DeepSeek-Coder-V2-Lite-Instruct-Q4_K_M.gguf}"
QWEN_URL="${QWEN_URL:-https://huggingface.co/bartowski/Qwen2.5-7B-Instruct-GGUF/resolve/main/Qwen2.5-7B-Instruct-Q4_K_M.gguf}"
GEMMA26_URL="${GEMMA26_URL:-https://huggingface.co/bartowski/google_gemma-4-26B-A4B-it-GGUF/resolve/main/google_gemma-4-26B-A4B-it-Q4_K_M.gguf}"
GEMMAE4_URL="${GEMMAE4_URL:-https://huggingface.co/bartowski/google_gemma-4-E4B-it-GGUF/resolve/main/google_gemma-4-E4B-it-Q4_K_M.gguf}"

echo "[1/6] 의존성 (git, cmake, wget)…"
if ! command -v brew >/dev/null 2>&1; then
  echo "Homebrew가 없습니다. https://brew.sh 에서 설치한 뒤 다시 실행하세요."
  exit 1
fi
brew install git cmake wget

echo "[2/6] llama.cpp 클론/빌드 (CMake, macOS 기본 Metal)…"
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

echo "[3/6] 모델 디렉터리…"
mkdir -p "$MODELS_DIR"

if [[ "${SKIP_DOWNLOAD:-0}" != "1" ]]; then
  echo "[4/6] GGUF 다운로드 (이미 있으면 wget -c 로 이어받기)…"
  wget -c -O "$MODELS_DIR/deepseek.gguf" "$DEEPSEEK_URL"
  wget -c -O "$MODELS_DIR/qwen.gguf" "$QWEN_URL"
  wget -c -O "$MODELS_DIR/gemma4-26b.gguf" "$GEMMA26_URL"
  wget -c -O "$MODELS_DIR/gemma4-e4b.gguf" "$GEMMAE4_URL"
else
  echo "[4/6] SKIP_DOWNLOAD=1 → 모델 다운로드 생략"
  [[ -f "$MODELS_DIR/deepseek.gguf" ]] || echo "  경고: $MODELS_DIR/deepseek.gguf 없음"
  [[ -f "$MODELS_DIR/qwen.gguf" ]] || echo "  경고: $MODELS_DIR/qwen.gguf 없음"
  [[ -f "$MODELS_DIR/gemma4-26b.gguf" ]] || echo "  경고: $MODELS_DIR/gemma4-26b.gguf 없음"
  [[ -f "$MODELS_DIR/gemma4-e4b.gguf" ]] || echo "  경고: $MODELS_DIR/gemma4-e4b.gguf 없음"
fi

echo "[5/6] 프로젝트 테스트 스크립트 갱신…"
cat > "$SCRIPT_DIR/run_deepseek_test.sh" <<'EOS'
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
EOS
chmod 0755 "$SCRIPT_DIR/run_deepseek_test.sh"

cat > "$SCRIPT_DIR/run_qwen_test.sh" <<'EOS'
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
EOS
chmod 0755 "$SCRIPT_DIR/run_qwen_test.sh"

cat > "$SCRIPT_DIR/run_gemma26_test.sh" <<'EOS'
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
EOS
chmod 0755 "$SCRIPT_DIR/run_gemma26_test.sh"

cat > "$SCRIPT_DIR/run_gemmae4_test.sh" <<'EOS'
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
EOS
chmod 0755 "$SCRIPT_DIR/run_gemmae4_test.sh"

if [[ "${SKIP_ZSHRC:-0}" != "1" ]]; then
  echo "[6/6] ~/.zshrc 에 deepseek-run / qwen-run 등록…"
  ZSH_MARK_BEGIN="# --- MAKi local LLM (llama.cpp: llama-completion + -no-cnv) ---"
  ZSH_MARK_END="# --- end MAKi local LLM ---"
  if [[ -f "$HOME/.zshrc" ]] && grep -qF "$ZSH_MARK_END" "$HOME/.zshrc" 2>/dev/null; then
    echo "  (이미 등록됨, 건너뜀)"
  else
    cat >> "$HOME/.zshrc" <<'ZSH'

# --- MAKi local LLM (llama.cpp: llama-completion + -no-cnv) ---
deepseek-run() {
  command "$HOME/llama.cpp/build/bin/llama-completion" \
    -m "$HOME/models/deepseek.gguf" \
    -t "$(sysctl -n hw.ncpu)" \
    --ctx-size 32768 \
    --temp 0.6 \
    -no-cnv \
    "$@"
}
qwen-run() {
  command "$HOME/llama.cpp/build/bin/llama-completion" \
    -m "$HOME/models/qwen.gguf" \
    -t "$(sysctl -n hw.ncpu)" \
    --ctx-size 65536 \
    --temp 0.7 \
    -no-cnv \
    "$@"
}
# --- end MAKi local LLM ---
ZSH
    echo "  새 터미널에서 적용되거나: source ~/.zshrc"
  fi
else
  echo "[6/6] SKIP_ZSHRC=1 → .zshrc 수정 생략"
fi

echo ""
echo "=============================="
echo "✅ SETUP COMPLETE"
echo ""
echo "바이너리: $LLAMA_COMPLETION"
echo "모델:     $MODELS_DIR/deepseek.gguf , $MODELS_DIR/qwen.gguf , $MODELS_DIR/gemma4-26b.gguf , $MODELS_DIR/gemma4-e4b.gguf"
echo ""
echo "GGUF 스모크: cd $SCRIPT_DIR && ./run_deepseek_test.sh && ./run_qwen_test.sh"
echo "             (선택) ./run_gemma26_test.sh  ./run_gemmae4_test.sh"
echo "스택 HTTP:   라우터+게이트웨이 기동 후  npm run test:local"
echo "빠른 실행:   deepseek-run -p '요약해줘: …'   /   qwen-run -p '정리해줘: …'"
echo "=============================="
