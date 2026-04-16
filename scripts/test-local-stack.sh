#!/usr/bin/env bash
# 로컬 게이트웨이 + (선택) 라우터 HTTP 스모크. DeepSeek/Qwen 단일 모델 스트림으로 검증.
# 사전: ./scripts/start-all.sh 또는 router(8081) + gateway(3001) 기동
set -euo pipefail

GATEWAY_URL="${GATEWAY_URL:-http://127.0.0.1:3001}"
ROUTER_URL="${ROUTER_URL:-http://127.0.0.1:8081}"
SKIP_ROUTER="${SKIP_ROUTER:-0}"
SKIP_CHAT="${SKIP_CHAT:-0}"
CHAT_MODEL="${CHAT_MODEL:-gemmae4}"

echo "=== MAKi local stack smoke ==="
echo "Gateway: $GATEWAY_URL  (health, models, optional chat stream model=$CHAT_MODEL)"

if ! curl -fsS "$GATEWAY_URL/api/health" >/tmp/maki-health.json 2>/tmp/maki-health.err; then
  echo "❌ GET /api/health 실패"
  cat /tmp/maki-health.err 2>/dev/null || true
  echo "→ 게이트웨이를 켜세요: ./scripts/run-gateway.sh 또는 ./scripts/start-all.sh"
  exit 1
fi
echo "✅ GET /api/health"
head -c 400 /tmp/maki-health.json
echo ""

if ! curl -fsS "$GATEWAY_URL/api/models" >/tmp/maki-models.json 2>/tmp/maki-models.err; then
  echo "❌ GET /api/models 실패"
  cat /tmp/maki-models.err 2>/dev/null || true
  exit 1
fi
echo "✅ GET /api/models"
head -c 400 /tmp/maki-models.json
echo ""

VERIFY_PROFILE="${VERIFY_PROFILE:-dq2}"

if [[ "$SKIP_ROUTER" != "1" ]]; then
  if ! curl -fsS "$ROUTER_URL/v1/models" >/tmp/maki-router-models.json 2>/tmp/maki-router.err; then
    echo "⚠️  GET $ROUTER_URL/v1/models 실패 (라우터만 꺼진 경우). SKIP_ROUTER=1 로 재실행하면 생략 가능."
    cat /tmp/maki-router.err 2>/dev/null || true
    exit 1
  fi
  echo "✅ GET llama-server /v1/models"
  head -c 600 /tmp/maki-router-models.json
  echo ""
  echo "→ router-verify-slots (profile=$VERIFY_PROFILE)…"
  if ! node "$(dirname "$0")/router-verify-slots.mjs" "$ROUTER_URL/v1/models" "$VERIFY_PROFILE"; then
    echo "❌ 라우터 슬롯이 프로필 $VERIFY_PROFILE 기준으로 모두 loaded 가 아닙니다."
    exit 1
  fi
fi

if [[ "$SKIP_CHAT" != "1" ]]; then
  echo "→ POST /api/chat/stream (최대 90초, 첫 SSE 이벤트 확인)…"
  CHAT_BODY="$(printf '{"model":"%s","messages":[{"role":"user","content":"Reply with exactly: OK"}],"maxTokens":24,"temperature":0.6}' "$CHAT_MODEL")"
  if ! out="$(
    curl -sS --max-time 90 -N -X POST "$GATEWAY_URL/api/chat/stream" \
      -H 'Content-Type: application/json' \
      -d "$CHAT_BODY" \
      | head -n 40
  )"; then
    echo "❌ chat stream 요청 실패"
    exit 1
  fi
  if [[ "$out" != *"event:"* ]]; then
    echo "❌ SSE event: 없음. 응답 일부:"
    echo "$out" | head -c 800
    exit 1
  fi
  if [[ "$out" == *"event: error"* ]]; then
    echo "❌ SSE error 이벤트 감지:"
    echo "$out" | head -n 40
    exit 1
  fi
  if [[ "$out" == *'"error":"Rate limit exceeded."'* ]]; then
    echo "❌ rate limit 발생 — 잠시 후 재시도하세요."
    echo "$out" | head -n 20
    exit 1
  fi
  echo "✅ SSE 수신 (chat stream)"
  echo "$out" | head -n 15
fi

echo ""
echo "✅ Local stack smoke OK"
