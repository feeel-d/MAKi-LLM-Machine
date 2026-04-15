#!/usr/bin/env bash
# DeepSeek + Qwen + Gemma26 + GemmaE4 라우터, 게이트웨이, Vite 웹을 로컬에서 기동합니다.
# 사용: 리포 루트에서 ./scripts/dev-web-4stack.sh
# 종료: Ctrl+C (자식 프로세스 그룹 종료)
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUNTIME_DIR="${RUNTIME_DIR:-$ROOT_DIR/.runtime}"
MODELS_DIR="${MODELS_DIR:-$HOME/models}"
ROUTER_PORT="${ROUTER_PORT:-8080}"
GATEWAY_PORT="${GATEWAY_PORT:-3001}"

# 부분 다운로드 방지 — 대략적 최소 크기 (Q4_K_M, bartowski 기본 기준)
need_file() {
  local f="$1"
  local sz
  sz="$(stat -f%z "$f" 2>/dev/null || stat -c%s "$f" 2>/dev/null || echo 0)"
  [[ -f "$f" ]] || return 1
  case "$f" in
    */deepseek.gguf) [[ "$sz" -ge 8000000000 ]] ;;
    */qwen.gguf) [[ "$sz" -ge 4000000000 ]] ;;
    */gemma4-26b.gguf) [[ "$sz" -ge 12000000000 ]] ;;
    */gemma4-e4b.gguf) [[ "$sz" -ge 5000000000 ]] ;; # Q4_K_M 전체 약 5.4GB
    *) [[ "$sz" -ge 1000000 ]] ;;
  esac
}

mkdir -p "$RUNTIME_DIR"

for name in deepseek.gguf qwen.gguf gemma4-26b.gguf gemma4-e4b.gguf; do
  if ! need_file "$MODELS_DIR/$name"; then
    echo "필요 파일 없음 또는 너무 작음: $MODELS_DIR/$name"
    echo "Gemma가 없으면: ./scripts/download-gemma-models.sh (시간·용량 큼)"
    echo "DeepSeek/Qwen은: ./setup-local-llm.sh 또는 기존 경로 확인"
    exit 1
  fi
done

if ! [[ -x "${LLAMA_SERVER_BIN:-$HOME/llama.cpp/build/bin/llama-server}" ]]; then
  echo "llama-server 없음: LLAMA_SERVER_BIN 또는 ~/llama.cpp/build/bin/llama-server"
  exit 1
fi

if lsof -ti tcp:"$ROUTER_PORT" >/dev/null 2>&1; then
  echo "포트 $ROUTER_PORT 사용 중 — 기존 라우터를 쓰거나 종료 후 다시 실행하세요."
  exit 1
fi
if lsof -ti tcp:"$GATEWAY_PORT" >/dev/null 2>&1; then
  echo "포트 $GATEWAY_PORT 사용 중 — 기존 게이트웨이를 종료 후 다시 실행하세요."
  exit 1
fi

cd "$ROOT_DIR"
export VITE_API_BASE_URL="http://127.0.0.1:${GATEWAY_PORT}"
export LLAMA_SERVER_URL="${LLAMA_SERVER_URL:-http://127.0.0.1:${ROUTER_PORT}}"

echo "Starting llama-server router (4 models)…"
: >"$RUNTIME_DIR/router-dev.log"
nohup "$ROOT_DIR/scripts/run-llama-router.sh" >>"$RUNTIME_DIR/router-dev.log" 2>&1 &
ROUTER_PID=$!

cleanup() {
  echo ""
  echo "Stopping…"
  kill "$GATEWAY_PID" 2>/dev/null || true
  kill "$ROUTER_PID" 2>/dev/null || true
  kill "$VITE_PID" 2>/dev/null || true
  lsof -ti tcp:"$GATEWAY_PORT" 2>/dev/null | xargs kill -9 2>/dev/null || true
  lsof -ti tcp:"$ROUTER_PORT" 2>/dev/null | xargs kill -9 2>/dev/null || true
}
trap cleanup EXIT INT TERM

for i in $(seq 1 90); do
  if curl -fsS "http://127.0.0.1:${ROUTER_PORT}/v1/models" >/dev/null 2>&1; then
    echo "Router OK on :${ROUTER_PORT}"
    break
  fi
  sleep 1
  if [[ "$i" -eq 90 ]]; then
    echo "라우터 응답 타임아웃. 로그: $RUNTIME_DIR/router.log 또는 터미널 출력 확인"
    exit 1
  fi
done

echo "Starting gateway on :${GATEWAY_PORT}…"
cd "$ROOT_DIR"
: >"$RUNTIME_DIR/gateway-dev.log"
nohup node apps/gateway/server.mjs >>"$RUNTIME_DIR/gateway-dev.log" 2>&1 &
GATEWAY_PID=$!

for i in $(seq 1 60); do
  if curl -fsS "http://127.0.0.1:${GATEWAY_PORT}/api/health" >/dev/null 2>&1; then
    echo "Gateway OK on :${GATEWAY_PORT}"
    break
  fi
  sleep 1
  if [[ "$i" -eq 60 ]]; then
    echo "게이트웨이 타임아웃"
    exit 1
  fi
done

echo "Starting Vite (http://127.0.0.1:5173) — Gateway URL 기본: $VITE_API_BASE_URL"
cd "$ROOT_DIR"
npm run dev --workspace @maki/web &
VITE_PID=$!

echo ""
echo "브라우저: http://127.0.0.1:5173/"
echo "게이트웨이 헬스: curl http://127.0.0.1:${GATEWAY_PORT}/api/health"
echo "종료하려면 Ctrl+C"
wait "$VITE_PID" || true
