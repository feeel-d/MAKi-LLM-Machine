# NestJS Internal Content API (Gateway)

외부 NestJS 백엔드가 MAKi Gateway를 서버-투-서버로 호출할 때 쓰는 내부 API입니다.

기본 규칙:

- Base URL: `https://<gateway-host>` 또는 내부망 URL
- 인증 헤더: `X-Service-Key: <SERVICE_API_KEY>`
- 요청 ID: `X-Request-Id` (선택, 없으면 Gateway 생성)
- 응답 공통: `requestId`, `latencyMs`

## 1) 본문 -> 제목 (SSE / 청크)

`POST /internal/v1/content/title-from-text/stream`  
`Content-Type: application/json` — 요청 본문은 이전과 동일.  
**응답:** `Content-Type: text/event-stream` (Server-Sent Events)

요청:

```json
{
  "text": "본문 텍스트",
  "language": "auto",
  "style": "neutral",
  "maxLength": 100,
  "inputMode": "digest",
  "bodyDigestMaxChars": 8000
}
```

| 필드 | 필수 | 설명 |
|------|------|------|
| `text` | 예 | 원문(최대 ~100k자). 프롬프트에는 `inputMode`에 따라 압축됨. |
| `language` | 아니오 | `auto` (기본) \| `ko` \| `en` — `auto`는 소스와 동일 언어로 제목. |
| `style` | 아니오 | `neutral` (기본) \| `marketing` \| `news` |
| `maxLength` | 아니오 | **8~200** 정수, 기본 **100**. 최종 `done.title`은 이 길이 이하. |
| `inputMode` | 아니오 | `digest` (기본): W 초과 시 앞·뒤 윈도우. `full`: 앞에서 `bodyDigestMaxChars`자만. |
| `bodyDigestMaxChars` | 아니오 | **256~8000**, 기본 8000 — LLM에 넣는 본문 예산 W. |

이벤트(순서):

- `event: meta` / `data: {"requestId":"…","model":"gemmae4"}`  
- `event: chunk` / `data: {"text":"…"}` (모델이 내보내는 토큰 델타, 여러 번)  
- `event: done` / `data: {"title":"최종 제목","model":"…","requestId":"…","latencyMs":123,"finished":true}`  
- 오류 시: `event: error` / `data: { "error": "…", "code": "…" }` (또는 upstream 형식)

**curl 예시:** `curl -N -X POST …/title-from-text/stream -H "Content-Type: application/json" -H "X-Service-Key: …" -d '{…}'`

## 2) 이미지 -> 제목

`POST /internal/v1/content/title-from-image`

```json
{
  "imageUrl": "https://signed-url.example.com/image.png",
  "contextText": "옵션 컨텍스트",
  "language": "ko",
  "style": "neutral",
  "maxLength": 48
}
```

응답:

```json
{
  "title": "이미지 기반 제목",
  "model": "gemmae4",
  "requestId": "req-124",
  "latencyMs": 438
}
```

## 3) 이미지 -> 본문

`POST /internal/v1/content/body-from-image`

```json
{
  "imageUrl": "https://signed-url.example.com/image.png",
  "titleHint": "옵션 제목 힌트",
  "language": "ko",
  "tone": "차분하고 전문적인 톤",
  "length": "medium"
}
```

응답:

```json
{
  "body": "이미지 분석 기반 본문...",
  "model": "gemmae4",
  "requestId": "req-125",
  "latencyMs": 820
}
```

## 4) 본문 -> 맞춤법 교정

`POST /internal/v1/content/proofread-from-text`

```json
{
  "text": "교정할 본문",
  "language": "auto",
  "preserveLanguage": true
}
```

응답:

```json
{
  "correctedText": "교정된 본문",
  "model": "gemmae4",
  "requestId": "req-127",
  "latencyMs": 305
}
```

## 5) 본문/노트 -> TODO 생성

`POST /internal/v1/content/todos-from-text`

```json
{
  "text": "회의록 또는 작업 본문",
  "language": "ko",
  "sourceType": "CHAT",
  "maxItems": 5,
  "memberList": ["김철수", "이영희"],
  "contextMessages": [
    { "authorName": "김철수", "text": "배포 준비 부탁드립니다" }
  ]
}
```

응답:

```json
{
  "items": [
    {
      "title": "배포 전 스모크 테스트",
      "description": "배포 전에 스모크 테스트를 진행하세요.",
      "assigneeNames": ["이영희"],
      "priority": "MEDIUM"
    }
  ],
  "model": "gemmae4",
  "requestId": "req-126",
  "latencyMs": 512
}
```

## 에러 코드

| HTTP | `code` (JSON, 자주 쓰는 것) | 설명 |
|------|-----------------------------|------|
| `400` | `TEXT_REQUIRED`, `INVALID_MAX_LENGTH` (8~200), `INVALID_LANGUAGE`, `INVALID_STYLE`, `INVALID_INPUT_MODE`, `INVALID_BODY_DIGEST_MAX_CHARS` | 입력값 오류 |
| `401` | — | `X-Service-Key` 불일치 |
| `413` | `TEXT_TOO_LARGE` | `text`가 상한(100k) 초과 |
| `422` | `INVALID_TITLE_OUTPUT` (세부 `reason`: `RAW_EMPTY`, `SANITIZE_EMPTY` 등) | 모델 출력이 유효한 제목이 아님 |
| `429` | — | Rate limit |
| `503` | `MODEL_UNAVAILABLE` 등 | 모델 비가용, 내부 키 미설정 |
- 이미지 API: `413`/`422` (MIME 등) — 위와 별도로 이미지 다운로드·형식 검증 실패 시에도 `422` 가능
- `504`: 이미지 fetch 또는 LLM 타임아웃(해당 경로)

## 이미지 URL 정책

- `https://` 만 허용
- `localhost`, 사설 IP, link-local 대상 차단
- MIME 허용 목록: `image/jpeg,image/png,image/webp,image/gif`
- 최대 다운로드 용량: `MAX_IMAGE_BYTES` (기본 8MB)
