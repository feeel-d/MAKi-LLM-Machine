# MAKi-LLM-Machine: SSH·에이전트용 로그 가이드

## 개요

게이트웨이(`apps/gateway/server.mjs`)는 `process.title = maki-llm-gateway`이며, 주요 로그는 **JSON 한 줄**로 `service: "maki-llm-gateway"`·`ts`·`level`·`event` 필드를 갖는다.  
`start-all.sh`로 띄우면 보통 ` .runtime/gateway.log`에 stdout/stderr가 기록된다.

## 로그 파일 위치

| 구성요소 | 기본 경로(저장소 루트 기준) |
|----------|----------------------------|
| 게이트웨이 | `.runtime/gateway.log` |
| LLM 라우터 | `.runtime/router.log` |

## 자주 쓰는 명령 (Mac에 SSH로 접속한 뒤)

```bash
cd /path/to/MAKi-LLM-Machine
tail -f .runtime/gateway.log
```

**게이트웨이 JSON만** (잡음 제거에 가깝게):

```bash
grep maki-llm-gateway .runtime/gateway.log | tail -50
```

**이벤트 타입**

- `http_request` — 모든 HTTP 요청 완료 시(메서드, path, statusCode, durationMs, requestId)
- `title_from_text` — `route: title-from-text`, `phase`로 세부 (stream_start, done, validate_output 등)
- `llama_upstream` — `phase`: fetch_models | chat_completions_stream | chat_completions | embeddings, `upstream`에는 host·port·scheme만(경로/비밀 없음)
- `internal_content` — 내부 콘텐츠 API 핸들러에서 오류 응답 직전
- `unhandled_error` — 서버 최상위 catch
- `server_listen` — 기동

**requestId로 end-to-end 추적** (MAKi 서버 `X-Request-Id`와 동일 값을 쓰는 경우가 많음):

```bash
grep 'YOUR-UUID' .runtime/gateway.log
```

**jq**가 있으면:

```bash
grep maki-llm-gateway .runtime/gateway.log | jq -c 'select(.event=="llama_upstream")'
```

## 프로세스 확인

```bash
ps aux | grep maki-llm-gateway
# 또는
lsof -i tcp:3001
```

(기본 `GATEWAY_PORT`는 3001.)

## 주의

- 로그에 **사용자 본문·API 키**를 넣지 않도록 설계됨. `llama_upstream`의 `upstream`은 호스트/포트 수준만.
- 실패가 많으면 `llama_router` / `llama-server`·`LLAMA_SERVER_URL` 환경을 먼저 확인.
