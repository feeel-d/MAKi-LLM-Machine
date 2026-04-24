#!/usr/bin/env bash
set -euo pipefail
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUNTIME_DIR="${RUNTIME_DIR:-$ROOT_DIR/.runtime}"
EMBED_PID_FILE="$RUNTIME_DIR/embed.pid"
EMBED_LOG_FILE="$RUNTIME_DIR/llama-embed.log"
EMBED_PORT="${EMBED_PORT:-8083}"
LLAMA_SERVER_BIN="${LLAMA_SERVER_BIN:-$HOME/llama.cpp/build/bin/llama-server}"
EMBED_MODEL="${EMBED_MODEL_PATH:-$HOME/models/nomic-embed-text-v1.5.Q4_0.gguf}"

mkdir -p "$RUNTIME_DIR"

is_pid_running() {
  local pid="$1"
  [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null
}

pid_on_port() {
  lsof -ti tcp:"$1" 2>/dev/null | head -n 1 || true
}

stop_embed() {
  local pid
  pid="$(cat "$EMBED_PID_FILE" 2>/dev/null || true)"
  if [[ -n "$pid" ]] && is_pid_running "$pid"; then
    kill -TERM "$pid" 2>/dev/null || true
  fi
  for _ in $(seq 1 15); do
    if [[ -z "$(pid_on_port "$EMBED_PORT")" ]]; then
      break
    fi
    p="$(pid_on_port "$EMBED_PORT")"
    [[ -n "$p" ]] && kill -TERM "$p" 2>/dev/null || true
    sleep 1
  done
  rm -f "$EMBED_PID_FILE"
}

if [[ "${1:-}" == "stop" ]]; then
  stop_embed
  exit 0
fi

if [[ -f "$EMBED_PID_FILE" ]]; then
  ep="$(cat "$EMBED_PID_FILE" 2>/dev/null || true)"
  if is_pid_running "$ep"; then
    echo "embed server already running PID $ep"
    exit 0
  fi
fi

pp="$(pid_on_port "$EMBED_PORT")"
if [[ -n "$pp" ]]; then
  echo "embed port $EMBED_PORT busy PID $pp"
  echo "$pp" >"$EMBED_PID_FILE"
  exit 0
fi

: >"$EMBED_LOG_FILE"
nohup "$LLAMA_SERVER_BIN" -m "$EMBED_MODEL" --embeddings --host 127.0.0.1 --port "$EMBED_PORT" --no-webui >>"$EMBED_LOG_FILE" 2>&1 &
echo $! >"$EMBED_PID_FILE"
echo "Started llama embed server PID $(cat $EMBED_PID_FILE) on :$EMBED_PORT"
