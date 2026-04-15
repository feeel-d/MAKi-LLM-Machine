#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

NODE_BIN="${NODE_BIN:-$(command -v node)}"
if [[ -z "$NODE_BIN" || ! -x "$NODE_BIN" ]]; then
  echo "run-gateway: node 를 찾을 수 없습니다. PATH 또는 NODE_BIN 을 설정하세요." >&2
  exit 1
fi
exec "$NODE_BIN" apps/gateway/server.mjs
