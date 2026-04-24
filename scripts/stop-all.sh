#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUNTIME_DIR="${RUNTIME_DIR:-$ROOT_DIR/.runtime}"
ROUTER_PID_FILE="$RUNTIME_DIR/router.pid"
GATEWAY_PID_FILE="$RUNTIME_DIR/gateway.pid"
ROUTER_PORT="${ROUTER_PORT:-8081}"
GATEWAY_PORT="${GATEWAY_PORT:-3001}"
EMBED_PORT="${EMBED_PORT:-8083}"
EMBED_PID_FILE="$RUNTIME_DIR/embed.pid"

is_pid_running() {
  local pid="$1"
  [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null
}

terminate_pid() {
  local label="$1"
  local pid="$2"

  if ! is_pid_running "$pid"; then
    return 0
  fi

  pkill -TERM -P "$pid" 2>/dev/null || true
  kill -TERM "$pid" 2>/dev/null || true

  for _ in {1..20}; do
    pkill -TERM -P "$pid" 2>/dev/null || true
    if ! is_pid_running "$pid"; then
      echo "Stopped $label PID $pid"
      return 0
    fi
    sleep 0.5
  done

  pkill -KILL -P "$pid" 2>/dev/null || true
  kill -KILL "$pid" 2>/dev/null || true
  echo "Force killed $label PID $pid"
}

stop_by_pid_file() {
  local label="$1"
  local pid_file="$2"
  if [[ ! -f "$pid_file" ]]; then
    return 0
  fi

  local pid
  pid="$(cat "$pid_file" 2>/dev/null || true)"
  terminate_pid "$label" "$pid"
  rm -f "$pid_file"
}

stop_by_port() {
  local label="$1"
  local port="$2"
  local pids
  pids="$(lsof -ti tcp:"$port" 2>/dev/null || true)"

  if [[ -z "$pids" ]]; then
    return 0
  fi

  while IFS= read -r pid; do
    [[ -z "$pid" ]] && continue
    terminate_pid "$label" "$pid"
  done <<< "$pids"
}

stop_descendants_of_matches() {
  local pattern="$1"
  local pids
  pids="$(pgrep -f "$pattern" 2>/dev/null || true)"

  if [[ -z "$pids" ]]; then
    return 0
  fi

  while IFS= read -r pid; do
    [[ -z "$pid" ]] && continue
    terminate_pid "$pattern" "$pid"
  done <<< "$pids"
}

stop_by_pid_file "gateway" "$GATEWAY_PID_FILE"
stop_by_pid_file "embed-server" "$EMBED_PID_FILE"
stop_by_port "embed-server" "$EMBED_PORT"
stop_by_pid_file "router" "$ROUTER_PID_FILE"

stop_by_port "gateway" "$GATEWAY_PORT"
stop_by_port "router" "$ROUTER_PORT"
stop_descendants_of_matches '/Users/markhub/llama.cpp/build/bin/llama-server --host 127.0.0.1 --port'
stop_descendants_of_matches 'apps/gateway/server.mjs'

tailscale funnel reset >/dev/null 2>&1 || true
echo "Funnel stopped"
