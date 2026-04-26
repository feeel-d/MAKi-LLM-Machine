# ADR-001: title-from-text 정책 (입력 예산 W / 출력 N / 다국어)

## 상태

채택됨 (2026-04)

## 맥락

- 제목 한 줄(`title-from-text`) 경로는 본문 길이와 무관하게 **지연·비용·실패 패턴**이 안정적이어야 함.
- 제품 정책: 제목 **최대 200자(N)**. 게이트웨이·MAKi·문서의 숫자가 달랐음(120 등).

## 결정

1. **출력 N**: `maxLength`는 **8~200** 정수, 게이트웨이 `validateTitleOutput`이 초과 시 잘라서 `done.title`에 맞춤.
2. **입력 W**: LLM에 넣는 본문은 **고정 상한 8000자**(`TITLE_CONTEXT_MAX_CHARS`). 초과 시 기본 `inputMode: digest`로 **앞·뒤 + `[...]`** 압축. `inputMode: full`은 **앞에서부터** `bodyDigestMaxChars`만 사용.
3. **요청 본문 최대**: `text`는 **최대 100_000자**까지 허용(MAKi `content` 정합). HTTP는 `MAX_BODY_BYTES`로 제한.
4. **다국어**: `language`는 **`auto` | `ko` | `en`**, 기본 `auto` — `auto`는 소스와 **동일 언어**로 제목(번역 금지).
5. **프롬프트**: **system**에 규칙·JSON 형식, **user**에 `Source text:\n` + (digest된) 본문만.
6. **폴백**: 게이트웨이는 JSON/노이즈 정리(`validateTitleOutput`). MAKi는 SSE 실패 시 **로컬 첫 줄/앞부분** 폴백(기존 `extractFallbackTitleFromContent`).

## 결과

- 경로: `POST /internal/v1/content/title-from-text/stream` (기존).
- 정본 상수: `content-generation.mjs`의 `TITLE_CONTEXT_MAX_CHARS`, `TITLE_MAX_OUTPUT_LENGTH`.
