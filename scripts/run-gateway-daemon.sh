#!/usr/bin/env bash
# launchd 전용: PATH 없이도 동작하도록 install-launchd.sh 가 NODE 절대 경로를 넣습니다.
set -euo pipefail
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"
export LLAMA_SERVER_URL="${LLAMA_SERVER_URL:-http://127.0.0.1:8081}"
exec "$NODE_BIN" apps/gateway/server.mjs
