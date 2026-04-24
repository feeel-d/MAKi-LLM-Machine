#!/usr/bin/env bash
# 단위 테스트 + 로컬 스택 스모크 + (가능하면) Gemma E4B API 스모크
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

echo "=== npm test (gateway 단위) ==="
npm test

echo ""
echo "=== scripts/test-local-stack.sh (Gemma, VERIFY_PROFILE=full) ==="
VERIFY_PROFILE="${VERIFY_PROFILE:-full}" CHAT_MODEL=gemmae4 "$ROOT/scripts/test-local-stack.sh"
