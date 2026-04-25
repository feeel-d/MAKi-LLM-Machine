#!/usr/bin/env bash
set -euo pipefail
# 단독 실행 시 로그는 터미널; start-all.sh 가 .runtime/gateway.log 로 리다이렉트. 상세: docs/ops-logs.md

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

NODE_BIN="${NODE_BIN:-$(command -v node)}"
if [[ -z "$NODE_BIN" || ! -x "$NODE_BIN" ]]; then
  echo "run-gateway: node 를 찾을 수 없습니다. PATH 또는 NODE_BIN 을 설정하세요." >&2
  exit 1
fi
exec "$NODE_BIN" apps/gateway/server.mjs
