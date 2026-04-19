# NestJS Internal Content API (Gateway)

외부 NestJS 백엔드가 MAKi Gateway를 서버-투-서버로 호출할 때 쓰는 내부 API입니다.

기본 규칙:

- Base URL: `https://<gateway-host>` 또는 내부망 URL
- 인증 헤더: `X-Service-Key: <SERVICE_API_KEY>`
- 요청 ID: `X-Request-Id` (선택, 없으면 Gateway 생성)
- 응답 공통: `requestId`, `latencyMs`

## 1) 본문 -> 제목

`POST /internal/v1/content/title-from-text`

```json
{
  "text": "본문 텍스트",
  "language": "ko",
  "style": "neutral",
  "maxLength": 48
}
```

응답:

```json
{
  "title": "생성된 제목",
  "model": "deepseek",
  "requestId": "req-123",
  "latencyMs": 214
}
```

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

## 에러 코드

- `400`: 입력값 오류
- `401`: `X-Service-Key` 불일치
- `413`: 본문/이미지 크기 초과
- `422`: 이미지 URL/MIME/형식 오류, 모델 출력 포맷 오류
- `503`: 모델 비가용, 큐 포화, 내부 키 미설정
- `504`: 이미지 fetch 또는 LLM 타임아웃

## 이미지 URL 정책

- `https://` 만 허용
- `localhost`, 사설 IP, link-local 대상 차단
- MIME 허용 목록: `image/jpeg,image/png,image/webp,image/gif`
- 최대 다운로드 용량: `MAX_IMAGE_BYTES` (기본 8MB)

