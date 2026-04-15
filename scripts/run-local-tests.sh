#!/usr/bin/env bash
# 단위 테스트(npm test) + 로컬 스택 스모크(게이트웨이·라우터 기동 필요)
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
echo "=== npm test (gateway 단위) ==="
npm test
echo ""
echo "=== scripts/test-local-stack.sh (router 8081 + gateway 3001) ==="
exec "$ROOT/scripts/test-local-stack.sh"
