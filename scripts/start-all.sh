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

start_router_with_profile() {
  local profile="$1"
  stop_router
  echo "Starting llama router with MAKI_ROUTER_PROFILE=$profile …"
  : >"$ROUTER_LOG_FILE"
  nohup env MAKI_ROUTER_PROFILE="$profile" "$ROOT_DIR/scripts/run-llama-router.sh" >>"$ROUTER_LOG_FILE" 2>&1 &
  local pid=$!
  echo "$pid" >"$ROUTER_PID_FILE"
  echo "Started router with PID $pid (profile=$profile)"
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

# --- Router: 자동 프로필(full→g3→dq2) 또는 MAKI_ROUTER_PROFILE 고정 ---
if [[ -n "${MAKI_ROUTER_PROFILE:-}" ]]; then
  start_router_with_profile "$MAKI_ROUTER_PROFILE"
  wait_for_http "http://127.0.0.1:${ROUTER_PORT}/v1/models" "router" "$ROUTER_WAIT_ROUNDS"
  wait_for_slots "$MAKI_ROUTER_PROFILE" || {
    echo "❌ 라우터 슬롯 검증 실패 (profile=$MAKI_ROUTER_PROFILE). 로그: $ROUTER_LOG_FILE" >&2
    exit 1
  }
elif [[ "${MAKI_NO_AUTO_DOWNGRADE:-0}" == "1" ]]; then
  start_router_with_profile full
  wait_for_http "http://127.0.0.1:${ROUTER_PORT}/v1/models" "router" "$ROUTER_WAIT_ROUNDS"
  wait_for_slots full || {
    echo "❌ full 프로필 슬롯 검증 실패. MAKI_NO_AUTO_DOWNGRADE=1 이라 자동 전환 안 함." >&2
    exit 1
  }
else
  # E4B 우선: full(26B+E4B)보다 메모리 안정성이 높아 실사용 성공률이 높다
  for _try in e4 full g3 dq2; do
    start_router_with_profile "$_try"
    if ! wait_for_http "http://127.0.0.1:${ROUTER_PORT}/v1/models" "router" "$ROUTER_WAIT_ROUNDS"; then
      echo "❌ 라우터 HTTP 대기 실패 (profile=$_try)" >&2
      if [[ "$_try" == "dq2" ]]; then
        exit 1
      fi
      continue
    fi
    if wait_for_slots "$_try"; then
      export MAKI_ROUTER_PROFILE="$_try"
      echo "✅ 라우터 프로필 확정: $_try (슬롯 모두 loaded)"
      break
    fi
    echo "⚠️  profile=$_try 일부 슬롯 미로드 — 다음 프로필로 전환…"
    if [[ "$_try" == "dq2" ]]; then
      echo "❌ dq2 까지 실패. GGUF 경로·메모리·llama.cpp 로그 확인: $ROUTER_LOG_FILE" >&2
      exit 1
    fi
  done
fi

# --- Gateway (기존 3001 프로세스가 있으면 교체) ---
stop_gateway
start_background "gateway" "$GATEWAY_PID_FILE" "$GATEWAY_LOG_FILE" "$GATEWAY_PORT" \
  env LLAMA_SERVER_URL="http://127.0.0.1:${ROUTER_PORT}" "$ROOT_DIR/scripts/run-gateway.sh"
wait_for_http "http://127.0.0.1:${GATEWAY_PORT}/api/health" "gateway" 60

# --- Funnel ---
"$ROOT_DIR/scripts/start-funnel.sh"
echo "Funnel status:"
tailscale funnel status
