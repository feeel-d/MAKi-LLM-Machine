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

  for _ in {1..60}; do
    if curl -fsS "$url" >/dev/null 2>&1; then
      echo "$label is ready at $url"
      return 0
    fi
    sleep 1
  done

  echo "Timed out waiting for $label at $url" >&2
  return 1
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

start_background "router" "$ROUTER_PID_FILE" "$ROUTER_LOG_FILE" "$ROUTER_PORT" "$ROOT_DIR/scripts/run-llama-router.sh"
wait_for_http "http://127.0.0.1:${ROUTER_PORT}/v1/models" "router"

start_background "gateway" "$GATEWAY_PID_FILE" "$GATEWAY_LOG_FILE" "$GATEWAY_PORT" \
  env LLAMA_SERVER_URL="http://127.0.0.1:${ROUTER_PORT}" "$ROOT_DIR/scripts/run-gateway.sh"
wait_for_http "http://127.0.0.1:${GATEWAY_PORT}/api/health" "gateway"

"$ROOT_DIR/scripts/start-funnel.sh"
echo "Funnel status:"
tailscale funnel status
