#!/usr/bin/env bash
# 단위 테스트 + 로컬 스택 스모크 + (가능하면) Gemma E4B API 스모크
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

echo "=== npm test (gateway 단위) ==="
npm test

echo ""
echo "=== scripts/test-local-stack.sh (기본: deepseek) ==="
"$ROOT/scripts/test-local-stack.sh"

echo ""
echo "=== Gemma E4B API 스모크 (available=true 일 때만) ==="
if curl -fsS http://127.0.0.1:3001/api/models | node -e '
let s="";process.stdin.on("data",d=>s+=d);process.stdin.on("end",()=>{try{const j=JSON.parse(s);const m=(j.data||[]).find(x=>x.id==="gemmae4");process.exit(m&&m.available?0:1);}catch{process.exit(1);}})
'; then
  gemma_profile="e4"
  if curl -fsS http://127.0.0.1:3001/api/models | node -e '
let s="";process.stdin.on("data",d=>s+=d);process.stdin.on("end",()=>{try{const j=JSON.parse(s);const m=(j.data||[]).find(x=>x.id==="gemma26");process.exit(m&&m.available?0:1);}catch{process.exit(1);}})
'; then
    gemma_profile="full"
  fi
  VERIFY_PROFILE="${VERIFY_PROFILE:-$gemma_profile}" CHAT_MODEL=gemmae4 "$ROOT/scripts/test-local-stack.sh"
else
  echo "(skip) gemmae4 슬롯이 available=false 이므로 E4B API 스모크 생략"
fi
