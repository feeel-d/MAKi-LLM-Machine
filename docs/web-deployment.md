# 공개 웹 LLM 배포 가이드

이 문서는 `MAKi-LLM-Machine` 저장소를 다음 구조로 운영하는 절차를 정리합니다.

- 프론트: GitHub Pages 정적 배포
- 백엔드: 현재 Mac에서 `Node gateway + llama-server router mode`
- 외부 공개: `Tailscale Funnel`

## 1. 준비

루트에서 의존성을 설치합니다.

```bash
npm install
chmod +x scripts/run-llama-router.sh scripts/run-gateway.sh scripts/start-funnel.sh scripts/install-launchd.sh scripts/start-all.sh scripts/stop-all.sh scripts/restart-all.sh scripts/download-gemma-models.sh scripts/dev-web-4stack.sh
```

### 로컬 4모델(Gemma 포함) + 웹 UI

Gemma GGUF가 없으면 `~/models/gemma4-26b.gguf`, `gemma4-e4b.gguf` 를 먼저 받습니다(용량·시간 큼).

```bash
./scripts/download-gemma-models.sh
./scripts/dev-web-4stack.sh
```

- 브라우저: `http://127.0.0.1:5173/` (개발 모드 base는 `/` — [apps/web/vite.config.ts](apps/web/vite.config.ts) 참고)
- 게이트웨이는 스크립트가 `VITE_API_BASE_URL=http://127.0.0.1:3001` 로 띄웁니다.
- 다운로드 로그: `.runtime/gemma-download.log`, 라우터/게이트웨이 로그: `.runtime/router-dev.log`, `.runtime/gateway-dev.log`

## 2. 일괄 실행

개발/운영 중에는 아래 3개 스크립트로 한 번에 제어할 수 있습니다.

```bash
./scripts/start-all.sh
./scripts/stop-all.sh
./scripts/restart-all.sh
```

동작 순서:

- `start-all.sh`: router -> gateway -> funnel 순서로 기동
- `stop-all.sh`: gateway -> router -> funnel 순서로 종료
- `restart-all.sh`: 전체 종료 후 다시 기동

## 3. llama-server router 실행

기본 모델 경로는 `~/models/deepseek.gguf`, `~/models/qwen.gguf`, `~/models/gemma4-26b.gguf`, `~/models/gemma4-e4b.gguf` 입니다.

```bash
./scripts/run-llama-router.sh
```

환경 변수로 조정 가능한 값:

- `DEEPSEEK_CTX`, `QWEN_CTX`, `GEMMA26_CTX`, `GEMMAE4_CTX`: 기본 `16384`
- `DEEPSEEK_MODEL_PATH`, `QWEN_MODEL_PATH`, `GEMMA26_MODEL_PATH`, `GEMMAE4_MODEL_PATH`
- `MODELS_MAX`: 기본 `4` (프리셋 슬롯 수와 맞춤; 메모리에 따라 낮출 수 있음)
- `ROUTER_PORT`: 기본 `8081` (nginx 등이 8080을 쓰는 경우가 많음)
- `MAKI_ROUTER_PROFILE`: 기본 `full` (4모델). `dq2` 로 두면 DeepSeek+Qwen 2슬롯만 (`config/llama-router-models.template.dq2.ini`)
- `LLAMA_API_KEY`: 내부 llama-server 보호가 필요할 때 사용

## 4. Gateway 실행

다른 터미널에서:

```bash
./scripts/run-gateway.sh
```

기본 포트는 `127.0.0.1:3001` 입니다.

주요 환경 변수:

- `LLAMA_SERVER_URL`: 기본 `http://127.0.0.1:8081`
- `ALLOWED_ORIGINS`: 기본 `https://feeel-d.github.io,http://localhost:5173,http://127.0.0.1:5173`
- `RATE_LIMIT_BURST`, `RATE_LIMIT_MINUTE`
- `QUEUE_CAPACITY`, `QUEUE_MAX_PENDING`

## 5. Funnel 공개

게이트웨이를 외부에 공개합니다.

```bash
./scripts/start-funnel.sh
tailscale funnel status
```

Funnel이 켜지면 `https://...ts.net` 형태의 HTTPS 주소가 생성됩니다. 이 주소를 프론트의 `VITE_API_BASE_URL` 또는 앱 내 Gateway URL 입력창에 넣으면 됩니다.

참고:

- 현재 Tailnet IP `100.109.70.54` 는 Tailnet 내부 접근용입니다.
- 일반 공개 웹 연결은 Tailnet IP가 아니라 Funnel HTTPS 주소를 사용해야 합니다.

## 6. GitHub Pages

저장소에는 [deploy-pages.yml](/Users/markhub/Desktop/workspace/MAKi-LLM-Machine/.github/workflows/deploy-pages.yml) 워크플로가 포함되어 있습니다.

필수 설정:

1. GitHub 저장소에서 Pages 소스를 `gh-pages` 브랜치 `/ (root)` 로 설정
2. (선택) **Settings → Secrets and variables → Actions → Variables** 에 `VITE_API_BASE_URL` = Funnel URL(예: `https://feeeld-inc-macbookpro.tail15c8bb.ts.net`, **끝 `/` 없음**) 을 넣으면 빌드된 앱이 처음부터 해당 게이트웨이를 기본으로 씁니다.

푸시 후 배포 주소:

- `https://feeel-d.github.io/MAKi-LLM-Machine/`

앱 내부에서도 Gateway URL을 바꿀 수 있으므로, 저장소 변수 없이 먼저 배포한 뒤 브라우저에서 직접 Funnel URL을 입력해도 됩니다.

## 7. launchd 자동 시작

Mac 재부팅 후 자동 기동이 필요하면:

```bash
./scripts/install-launchd.sh
```

이 스크립트는 다음 LaunchAgent를 설치합니다.

- `com.maki.llama-router`
- `com.maki.gateway`

로그 파일:

- `.runtime/llama-router.log`
- `.runtime/gateway.log`

**저장소 위치:** `Desktop`/`Documents` 아래에 두면 macOS 데이터 보호 때문에 launchd가 스크립트 실행 또는 Node의 파일 읽기를 거절하는 경우가 있습니다(라우터 로그에 `Operation not permitted`, 게이트웨이가 `exit 78` 로 반복 등). 가능하면 **`~/Developer/...` 등으로 클론**하거나, launchd 대신 **로그인 후 `./scripts/start-all.sh`** 로 기동하세요.

## 8. 운영 점검

기본 점검 순서:

```bash
curl http://127.0.0.1:8081/v1/models
curl http://127.0.0.1:3001/api/health
curl http://127.0.0.1:3001/api/models
```

`All` 모드는 게이트웨이가 DeepSeek와 Qwen을 동시에 호출하고, `Gemma All` 모드는 `gemma26`와 `gemmae4`를 동시에 호출합니다. SSE는 모델별 이벤트로 합쳐져 브라우저에 전달됩니다.

## 9. GitHub Pages에서 `Gateway Issue` / `Failed to fetch` 일 때

브라우저가 게이트웨이 URL로 `fetch` 했을 때 **리다이렉트·HTML·CORS** 중 하나면 상태가 `degraded` 가 되고 메시지가 `Failed to fetch` 로 보일 수 있습니다.

### 9.1 반드시 나와야 하는 것 (Mac에서 확인)

게이트웨이가 **이 저장소의 Node 서버**(`apps/gateway/server.mjs`, 기본 `127.0.0.1:3001`)에 붙어 있어야 합니다. 터미널에서:

```bash
curl -sS http://127.0.0.1:3001/api/health
```

응답이 **JSON**이어야 합니다. 로컬 라우터가 꺼져 있어도 게이트웨이는 **HTTP 200** 과 `"status":"degraded"` 로 응답합니다(구버전은 503이었음). GitHub Pages 프론트는 Funnel까지 연결되면 **노란 상태**로 “Funnel OK · LLM offline” 을 보여 주고, 라우터만 켜면 초록으로 바뀝니다.

공개 URL( Tailscale Funnel 등)은 **리다이렉트 없이** 같은 JSON이 나와야 합니다.

```bash
curl -sSIL "https://(Funnel에 표시된 호스트)/api/health"
```

- **정상(라우터 포함):** `200`, `"status":"ok"`.
- **게이트웨이만 살아 있음:** `200`, `"status":"degraded"` (프론트는 Funnel 연결로 표시).
- **비정상 예:** `301` / `302` 로 **다른 도메인**(예: `app.markhub.ai`)으로 보내지거나, `200` 인데 본문이 **HTML**이면 — 앞단 **nginx 등 리버스 프록시**가 `3001` 이 아니라 다른 서비스로 보내고 있거나, 전역 리다이렉트가 걸린 상태입니다. 이 경우 GitHub Pages 프론트는 JSON을 못 받아 `Failed to fetch` 가 납니다.

### 9.2 권장 구성 (이 프로젝트 스크립트)

1. `./scripts/run-gateway.sh` 로 게이트웨이 기동 (또는 `start-all.sh`).
2. `tailscale funnel --bg 3001` (`scripts/start-funnel.sh` 와 동일).  
   - Funnel이 붙는 포트는 **반드시 게이트웨이가 듣는 포트**와 같아야 합니다.
3. `tailscale funnel status` 에 나오는 **`https://....ts.net` 주소**를 브라우저 Gateway URL에 넣습니다 (끝 `/` 없이).

nginx 를 443 에 두고 Tailscale 트래픽을 먼저 받는 경우, **전체를 `app.markhub.ai` 로 301** 하지 말고, 최소한 `location /api/` 는 `proxy_pass http://127.0.0.1:3001;` 로 게이트웨이에 넘기거나, Funnel 전용 호스트는 Node 게이트웨이만 보이게 분리합니다.

### 9.3 CORS

게이트웨이는 기본으로 `https://feeel-d.github.io` 출처를 허용합니다. 다른 Pages 도메인을 쓰면 `ALLOWED_ORIGINS` 환경 변수에 해당 Origin 을 추가한 뒤 게이트웨이를 다시 띄웁니다.
