#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUNTIME_DIR="${RUNTIME_DIR:-$ROOT_DIR/.runtime}"
ROUTER_PID_FILE="$RUNTIME_DIR/router.pid"
GATEWAY_PID_FILE="$RUNTIME_DIR/gateway.pid"
ROUTER_LOG_FILE="$RUNTIME_DIR/router.log"
GATEWAY_LOG_FILE="$RUNTIME_DIR/gateway.log"
ROUTER_PORT="${ROUTER_PORT:-8081}"
GATEWAY_PORT="${GATEWAY_PORT:-3001}"
# 라우터(특히 Gemma) 기동이 느리면 늘림
ROUTER_WAIT_ROUNDS="${ROUTER_WAIT_ROUNDS:-120}"

mkdir -p "$RUNTIME_DIR"

is_pid_running() {
  local pid="$1"
  [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null
}

pid_on_port() {
  local port="$1"
  lsof -ti tcp:"$port" 2>/dev/null | head -n 1 || true
}

wait_for_http() {
  local url="$1"
  local label="$2"
  local rounds="${3:-60}"

  for _ in $(seq 1 "$rounds"); do
    if curl -fsS "$url" >/dev/null 2>&1; then
      echo "$label is ready at $url"
      return 0
    fi
    sleep 1
  done

  echo "Timed out waiting for $label at $url" >&2
  return 1
}

stop_router() {
  local pid
  pid="$(cat "$ROUTER_PID_FILE" 2>/dev/null || true)"
  if [[ -n "$pid" ]] && is_pid_running "$pid"; then
    kill -TERM "$pid" 2>/dev/null || true
  fi
  for _ in $(seq 1 40); do
    if [[ -z "$(pid_on_port "$ROUTER_PORT")" ]]; then
      break
    fi
    pkill -TERM -f "llama-server.*--port ${ROUTER_PORT}" 2>/dev/null || true
    sleep 1
  done
  rm -f "$ROUTER_PID_FILE"
}

stop_gateway() {
  local pid
  pid="$(cat "$GATEWAY_PID_FILE" 2>/dev/null || true)"
  if [[ -n "$pid" ]] && is_pid_running "$pid"; then
    kill -TERM "$pid" 2>/dev/null || true
  fi
  for _ in $(seq 1 25); do
    if [[ -z "$(pid_on_port "$GATEWAY_PORT")" ]]; then
      break
    fi
    local p
    p="$(pid_on_port "$GATEWAY_PORT")"
    [[ -n "$p" ]] && kill -TERM "$p" 2>/dev/null || true
    sleep 1
  done
  rm -f "$GATEWAY_PID_FILE"
}

start_background() {
  local label="$1"
  local pid_file="$2"
  local log_file="$3"
  local port="$4"
  shift 4

  if [[ -f "$pid_file" ]]; then
    local existing_pid
    existing_pid="$(cat "$pid_file" 2>/dev/null || true)"
    if is_pid_running "$existing_pid"; then
      echo "$label already running with PID $existing_pid"
      return 0
    fi
    rm -f "$pid_file"
  fi

  local port_pid
  port_pid="$(pid_on_port "$port")"
  if [[ -n "$port_pid" ]]; then
    echo "$label already running on port $port with PID $port_pid"
    echo "$port_pid" >"$pid_file"
    return 0
  fi

  : >"$log_file"
  nohup "$@" >"$log_file" 2>&1 &
  local pid=$!
  echo "$pid" >"$pid_file"
  echo "Started $label with PID $pid"
}

start_router() {
  stop_router
  echo "Starting llama router (Gemma 26B + E4B) …"
  : >"$ROUTER_LOG_FILE"
  nohup "$ROOT_DIR/scripts/run-llama-router.sh" >>"$ROUTER_LOG_FILE" 2>&1 &
  local pid=$!
  echo "$pid" >"$ROUTER_PID_FILE"
  echo "Started router with PID $pid"
}

verify_slots() {
  local profile="$1"
  node "$ROOT_DIR/scripts/router-verify-slots.mjs" "http://127.0.0.1:${ROUTER_PORT}/v1/models" "$profile"
}

# 슬롯이 loading → loaded 될 때까지 폴링 (즉시 검증하면 전부 실패함)
SLOT_POLL_ROUNDS="${SLOT_POLL_ROUNDS:-120}"
SLOT_POLL_SEC="${SLOT_POLL_SEC:-2}"

wait_for_slots() {
  local profile="$1"
  local i
  for i in $(seq 1 "$SLOT_POLL_ROUNDS"); do
    if verify_slots "$profile" 2>/dev/null; then
      return 0
    fi
    sleep "$SLOT_POLL_SEC"
  done
  verify_slots "$profile"
}

# --- Router: Gemma 26B + E4B (2 slots) ---
start_router
if ! wait_for_http "http://127.0.0.1:${ROUTER_PORT}/v1/models" "router" "$ROUTER_WAIT_ROUNDS"; then
  echo "❌ 라우터 HTTP 대기 실패. 로그: $ROUTER_LOG_FILE" >&2
  exit 1
fi
if ! wait_for_slots full; then
  echo "❌ 라우터 슬롯 검증 실패 (필요: gemma26, gemmae4). GGUF·메모리·로그: $ROUTER_LOG_FILE" >&2
  exit 1
fi
echo "✅ 라우터 슬롯: gemma26, gemmae4 loaded"

# --- Embedding server (nomic @ 8083, 채팅 라우터와 분리) ---
EMBED_PORT="${EMBED_PORT:-8083}"
if [[ -z "$(pid_on_port "$EMBED_PORT")" ]]; then
  echo "Starting llama embedding server on :${EMBED_PORT} …"
  nohup "$ROOT_DIR/scripts/run-llama-embed-server.sh" >>"$RUNTIME_DIR/llama-embed-boot.log" 2>&1 &
  wait_for_http "http://127.0.0.1:${EMBED_PORT}/v1/models" "embed-server" 30 || {
    echo "⚠️  embedding server HTTP 대기 실패 — 로그: $RUNTIME_DIR/llama-embed.log" >&2
  }
else
  echo "Embedding port ${EMBED_PORT} already in use — skip start"
fi

# --- Gateway (기존 3001 프로세스가 있으면 교체) ---
stop_gateway
start_background "gateway" "$GATEWAY_PID_FILE" "$GATEWAY_LOG_FILE" "$GATEWAY_PORT" \
  env LLAMA_SERVER_URL="http://127.0.0.1:${ROUTER_PORT}" LLAMA_EMBEDDINGS_URL="http://127.0.0.1:${EMBED_PORT}" "$ROOT_DIR/scripts/run-gateway.sh"
wait_for_http "http://127.0.0.1:${GATEWAY_PORT}/api/health" "gateway" 60

# --- Funnel ---
"$ROOT_DIR/scripts/start-funnel.sh"
echo "Funnel status:"
tailscale funnel status
