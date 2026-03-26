# 공개 웹 LLM 배포 가이드

이 문서는 `MAKi-LLM-Machine` 저장소를 다음 구조로 운영하는 절차를 정리합니다.

- 프론트: GitHub Pages 정적 배포
- 백엔드: 현재 Mac에서 `Node gateway + llama-server router mode`
- 외부 공개: `Tailscale Funnel`

## 1. 준비

루트에서 의존성을 설치합니다.

```bash
npm install
chmod +x scripts/run-llama-router.sh scripts/run-gateway.sh scripts/start-funnel.sh scripts/install-launchd.sh
```

## 2. llama-server router 실행

기본 모델 경로는 `~/models/deepseek.gguf`, `~/models/qwen.gguf` 입니다.

```bash
./scripts/run-llama-router.sh
```

환경 변수로 조정 가능한 값:

- `DEEPSEEK_CTX`, `QWEN_CTX`: 기본 `16384`
- `ROUTER_PORT`: 기본 `8080`
- `LLAMA_API_KEY`: 내부 llama-server 보호가 필요할 때 사용

## 3. Gateway 실행

다른 터미널에서:

```bash
./scripts/run-gateway.sh
```

기본 포트는 `127.0.0.1:3001` 입니다.

주요 환경 변수:

- `LLAMA_SERVER_URL`: 기본 `http://127.0.0.1:8080`
- `ALLOWED_ORIGINS`: 기본 `https://feeel-d.github.io,http://localhost:5173,http://127.0.0.1:5173`
- `RATE_LIMIT_BURST`, `RATE_LIMIT_MINUTE`
- `QUEUE_CAPACITY`, `QUEUE_MAX_PENDING`

## 4. Funnel 공개

게이트웨이를 외부에 공개합니다.

```bash
./scripts/start-funnel.sh
tailscale funnel status
```

Funnel이 켜지면 `https://...ts.net` 형태의 HTTPS 주소가 생성됩니다. 이 주소를 프론트의 `VITE_API_BASE_URL` 또는 앱 내 Gateway URL 입력창에 넣으면 됩니다.

참고:

- 현재 Tailnet IP `100.109.70.54` 는 Tailnet 내부 접근용입니다.
- 일반 공개 웹 연결은 Tailnet IP가 아니라 Funnel HTTPS 주소를 사용해야 합니다.

## 5. GitHub Pages

저장소에는 [deploy-pages.yml](/Users/markhub/Desktop/workspace/MAKi-LLM-Machine/.github/workflows/deploy-pages.yml) 워크플로가 포함되어 있습니다.

필수 설정:

1. GitHub 저장소에서 Pages 소스를 `GitHub Actions`로 설정
2. 필요하면 저장소 변수 `VITE_API_BASE_URL` 를 Funnel 공개 URL로 등록

푸시 후 배포 주소:

- `https://feeel-d.github.io/MAKi-LLM-Machine/`

앱 내부에서도 Gateway URL을 바꿀 수 있으므로, 저장소 변수 없이 먼저 배포한 뒤 브라우저에서 직접 Funnel URL을 입력해도 됩니다.

## 6. launchd 자동 시작

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

## 7. 운영 점검

기본 점검 순서:

```bash
curl http://127.0.0.1:8080/v1/models
curl http://127.0.0.1:3001/api/health
curl http://127.0.0.1:3001/api/models
```

`All` 모드는 게이트웨이가 DeepSeek와 Qwen을 동시에 호출하고, SSE를 모델별 이벤트로 합쳐서 브라우저에 전달합니다.
