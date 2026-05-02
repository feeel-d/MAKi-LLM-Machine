import { completeJsonCompletion, fetchRouterModels, fetchTextEmbedding, parseJsonObjectFromModelText } from './llama-client.mjs';
import { fetchImageAsDataUrl } from './image-ingest.mjs';
import { InternalApiError } from './internal-errors.mjs';
import { resolveLogicalRouterModelId } from './models.mjs';

/** llama-server 라우터 슬롯 id — title·proofread·todos·이미지 태스크 모두 E4B 슬롯 사용 */
const ROUTER_SLOT_GEMMA_E4B = 'gemmae4';

/** 제목 LLM에 넣는 본문 상한(문자) — MAKi `buildLocalTitleContext` / digest 정책과 맞출 것 */
export const TITLE_CONTEXT_MAX_CHARS = 8000;
/** 제목 출력 maxLength 상한 — MAKi GraphQL / LocalLLM과 동일 */
export const TITLE_MAX_OUTPUT_LENGTH = 200;
const TITLE_INPUT_MAX_CHARS = 100_000;
const TITLE_INPUT_MODES = new Set(['full', 'digest']);
const TITLE_LANGUAGES = new Set(['auto', 'ko', 'en']);

const TITLE_STYLES = new Set(['neutral', 'marketing', 'news']);
const LANGUAGES = new Set(['ko', 'en']);
const BODY_LENGTHS = new Set(['short', 'medium', 'long']);
const TODO_PRIORITIES = new Set(['HIGH', 'MEDIUM', 'LOW']);

const HANGUL_RE = /[\uAC00-\uD7A3]/;

/** 모델 출력 문자열에서 CoT(생각의 흐름) 및 불필요한 메타 텍스트 제거 */
export function stripBodyFromImageCoT(text) {
  let s = asString(text).trim();

  // 1. "Here's a thinking process" 패턴이 있고 뒤에 한글이 나오면 한글 시작점부터 사용
  if (/^here'?s\s+(a\s+)?thinking\b/im.test(s) && HANGUL_RE.test(s)) {
    const allLines = s.split('\n');
    const hangulLineIdx = allLines.findIndex((l) => HANGUL_RE.test(l));
    if (hangulLineIdx > 0) {
      s = allLines.slice(hangulLineIdx).join('\n').trim();
    }
  }

  // 2. 단락 단위로 CoT 패턴 검사하여 제거
  let guard = 0;
  while (guard < 20) {
    guard += 1;
    const parts = s.split(/\n{2,}/);
    if (parts.length <= 1) break;
    
    const firstBlock = parts[0].trim().toLowerCase();
    const isCot = 
      firstBlock.includes('thinking process') || 
      firstBlock.includes('chain of thought') ||
      firstBlock.startsWith("here's") ||
      firstBlock.includes('analyze the request') ||
      /^\d+\.\s+\*\*analyze\*\*/.test(firstBlock);

    if (!isCot) break;
    s = parts.slice(1).join('\n\n').trim();
  }

  // 3. 줄 단위로 선행 마커 제거
  const lines = s.split('\n');
  let start = 0;
  for (; start < lines.length && start < 15; start += 1) {
    const line = lines[start].trim().toLowerCase();
    if (!line) continue;
    if (/^#{1,6}\s*(thinking|analyze|constraints?)/.test(line)) continue;
    if (/^(here'?s|here\s+is)\s+(a\s+)?thinking/.test(line)) continue;
    if (/^\*{0,2}(analyze|thinking\s+process|drafting)/.test(line)) continue;
    if (/^\d+\.\s+(\*{1,2})?\s*analyze/.test(line)) continue;
    break;
  }
  s = lines.slice(start).join('\n').trim();

  // 4. 긴 영문 CoT 뒤에 한글 요약이 붙어있는 경우 (앵커 탐색)
  const anchor = s.search(/\n(?=[^\n]*[\uAC00-\uD7A3])/);
  if (anchor > 60 && /^[\x00-\x7F\n]{60,}/.test(s.slice(0, anchor))) {
    s = s.slice(anchor + 1).trim();
  }

  return s;
}

export const CONTENT_TASK_MODELS = {
  titleFromText: ROUTER_SLOT_GEMMA_E4B,
  titleFromImage: ROUTER_SLOT_GEMMA_E4B,
  bodyFromImage: ROUTER_SLOT_GEMMA_E4B,
  proofreadFromText: ROUTER_SLOT_GEMMA_E4B,
  todosFromText: ROUTER_SLOT_GEMMA_E4B,
};

export function createContentGenerationService(dependencies = {}) {
  const fetchModels = dependencies.fetchRouterModels ?? fetchRouterModels;
  const runJsonCompletion = dependencies.completeJsonCompletion ?? completeJsonCompletion;
  const fetchImage = dependencies.fetchImageAsDataUrl ?? fetchImageAsDataUrl;

  return {
    async titleFromText({ config, requestId, input }) {
      const normalized = validateTitleFromTextInput(input);
      const model = await ensureModelAvailable(config, CONTENT_TASK_MODELS.titleFromText, fetchModels);

      const systemPrompt = buildTitleFromTextSystemPrompt(normalized);
      const userContent = buildTitleFromTextUserContent(normalized);
      const completion = await runJsonCompletion({
        config,
        model,
        requestId,
        retryCount: config.contentRetryCount,
        temperature: 0.3,
        maxTokens: 384,
        jsonResponseFormat: false,
        systemPrompt,
        messages: [
          {
            role: 'user',
            content: userContent,
          },
        ],
      });

      const title = validateTitleOutput(completion.parsed?.title ?? completion.text, normalized.maxLength);
      return {
        title,
        model,
      };
    },

    async titleFromImage({ config, requestId, input }) {
      const normalized = validateTitleFromImageInput(input);
      const model = await ensureModelAvailable(config, CONTENT_TASK_MODELS.titleFromImage, fetchModels);

      const image = await fetchImage({
        imageUrl: normalized.imageUrl,
        config,
      });

      const completion = await runJsonCompletion({
        config,
        model,
        requestId,
        retryCount: config.contentRetryCount,
        temperature: 0.4,
        maxTokens: 512,
        jsonResponseFormat: false,
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'text',
                text: buildTitleFromImagePrompt(normalized),
              },
              {
                type: 'image_url',
                image_url: {
                  url: image.dataUrl,
                },
              },
            ],
          },
        ],
      });

      const title = validateTitleOutput(completion.parsed?.title ?? completion.text, normalized.maxLength);
      return {
        title,
        model,
      };
    },

    async bodyFromImage({ config, requestId, input }) {
      const normalized = validateBodyFromImageInput(input);
      const model = await ensureModelAvailable(config, CONTENT_TASK_MODELS.bodyFromImage, fetchModels);

      const image = await fetchImage({
        imageUrl: normalized.imageUrl,
        config,
      });

      const completion = await runJsonCompletion({
        config,
        model,
        requestId,
        retryCount: config.contentRetryCount,
        temperature: 0.0,
        maxTokens: bodyMaxTokens(normalized.length, config),
        jsonResponseFormat: true,
        systemPrompt: buildBodyFromImageSystemPrompt(normalized),
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'text',
                text: buildBodyFromImageUserPrompt(normalized),
              },
              {
                type: 'image_url',
                image_url: {
                  url: image.dataUrl,
                },
              },
            ],
          },
        ],
      });

    const rawBody = extractBodyForBodyFromImage(completion.parsed, completion.text);
    const sanitized = stripBodyFromImageCoT(rawBody);
    const body = validateBodyOutput(sanitized);

    return {
      body,
      model,
    };
    },

    async proofreadFromText({ config, requestId, input }) {
      const normalized = validateProofreadFromTextInput(input);
      const model = await ensureModelAvailable(config, CONTENT_TASK_MODELS.proofreadFromText, fetchModels);

      const completion = await runJsonCompletion({
        config,
        model,
        requestId,
        retryCount: config.contentRetryCount,
        temperature: 0.15,
        maxTokens: proofreadMaxTokens(normalized.text),
        messages: [
          {
            role: 'user',
            content: buildProofreadFromTextPrompt(normalized),
          },
        ],
      });

      const correctedText = validateProofreadOutput(completion.parsed?.correctedText ?? completion.text);
      return {
        correctedText,
        model,
      };
    },

    async todosFromText({ config, requestId, input }) {
      const normalized = validateTodosFromTextInput(input);
      const model = await ensureModelAvailable(config, CONTENT_TASK_MODELS.todosFromText, fetchModels);

      const completion = await runJsonCompletion({
        config,
        model,
        requestId,
        retryCount: config.contentRetryCount,
        temperature: 0.25,
        maxTokens: todoMaxTokens(normalized.maxItems),
        messages: [
          {
            role: 'user',
            content: buildTodosFromTextPrompt(normalized),
          },
        ],
      });

      const items = validateTodoItemsOutput(completion.parsed?.items ?? completion.text, normalized.maxItems);
      return {
        items,
        model,
      };
    },

    async embedFromText({ config, requestId, input }) {
      const normalized = validateEmbedFromTextInput(input);
      const embedUrl = config.llamaEmbeddingsUrl?.trim();
      if (!embedUrl) {
        throw new InternalApiError(
          503,
          'LLAMA_EMBEDDINGS_URL / llamaEmbeddingsUrl is not configured.',
          'EMBED_URL_MISSING',
        );
      }
      const embedModel = config.llamaEmbedModelId?.trim() || 'nomic-embed-text-v1.5.Q4_0.gguf';
      const raw = await fetchTextEmbedding({
        config,
        model: embedModel,
        input: normalized.text,
        signal: undefined,
      });
      const values = fitEmbeddingToDimensions(raw, normalized.dimensions);
      return {
        values,
        model: embedModel,
      };
    },
  };
}

export function validateEmbedFromTextInput(input) {
  const text = asString(input?.text);
  if (!text) {
    throw new InternalApiError(400, 'text is required.', 'TEXT_REQUIRED');
  }
  if (text.length > 12_000) {
    throw new InternalApiError(413, 'text is too large.', 'TEXT_TOO_LARGE');
  }
  let dimensions = 768;
  if (input?.dimensions !== undefined && input?.dimensions !== null && input?.dimensions !== '') {
    const d = Number(input.dimensions);
    if (!Number.isInteger(d) || d < 256 || d > 2048) {
      throw new InternalApiError(
        400,
        'dimensions must be an integer between 256 and 2048.',
        'INVALID_DIMENSIONS',
      );
    }
    dimensions = d;
  }
  return { text, dimensions };
}

function fitEmbeddingToDimensions(values, targetDim) {
  const v = values.map((x) => Number(x)).filter((n) => Number.isFinite(n));
  if (v.length === 0) {
    throw new InternalApiError(422, 'Empty embedding.', 'EMPTY_EMBEDDING');
  }
  if (v.length === targetDim) {
    return v;
  }
  if (v.length > targetDim) {
    return v.slice(0, targetDim);
  }
  const padded = [...v];
  while (padded.length < targetDim) {
    padded.push(0);
  }
  return padded;
}

/**
 * 긴 본문을 고정 예산으로 압축(앞·뒤). must match MAKi `buildLocalTitleContext` algorithm.
 * @param {string} text
 * @param {number} [maxChars]
 */
export function digestTitleSourceText(text, maxChars = TITLE_CONTEXT_MAX_CHARS) {
  const t = asString(text);
  const cap = Math.min(Math.max(256, Number(maxChars) || TITLE_CONTEXT_MAX_CHARS), TITLE_CONTEXT_MAX_CHARS);
  if (t.length <= cap) {
    return t;
  }
  const sep = '\n\n[...]\n\n';
  const budget = cap - sep.length;
  const headLen = Math.floor(budget * 0.5);
  const tailLen = budget - headLen;
  return `${t.slice(0, headLen).trimEnd()}${sep}${t.slice(-tailLen).trimStart()}`;
}

function normalizeInputMode(value) {
  if (value === undefined || value === null || value === '') {
    return 'digest';
  }
  const mode = asString(value).toLowerCase();
  if (!TITLE_INPUT_MODES.has(mode)) {
    throw new InternalApiError(400, 'inputMode must be "full" or "digest".', 'INVALID_INPUT_MODE');
  }
  return mode;
}

function normalizeBodyDigestMaxChars(value) {
  if (value === undefined || value === null || value === '') {
    return TITLE_CONTEXT_MAX_CHARS;
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 256 || parsed > TITLE_CONTEXT_MAX_CHARS) {
    throw new InternalApiError(
      400,
      `bodyDigestMaxChars must be an integer between 256 and ${TITLE_CONTEXT_MAX_CHARS}.`,
      'INVALID_BODY_DIGEST_MAX_CHARS',
    );
  }
  return parsed;
}

function normalizeTitleLanguage(value) {
  if (value === undefined || value === null || value === '') {
    return 'auto';
  }
  const language = asString(value).toLowerCase();
  if (!TITLE_LANGUAGES.has(language)) {
    throw new InternalApiError(400, 'language must be one of "auto", "ko", "en".', 'INVALID_LANGUAGE');
  }
  return language;
}

export function validateTitleFromTextInput(input) {
  const text = asString(input?.text);
  if (!text) {
    throw new InternalApiError(400, 'text is required.', 'TEXT_REQUIRED');
  }
  if (text.length > TITLE_INPUT_MAX_CHARS) {
    throw new InternalApiError(413, 'text is too large.', 'TEXT_TOO_LARGE');
  }

  const language = normalizeTitleLanguage(input?.language);
  const style = normalizeStyle(input?.style);
  const maxLength = normalizeMaxLength(input?.maxLength);
  const inputMode = normalizeInputMode(input?.inputMode);
  const bodyDigestMaxChars = normalizeBodyDigestMaxChars(input?.bodyDigestMaxChars);

  const originalSourceChars = text.length;
  const promptText =
    inputMode === 'full' ? text.slice(0, bodyDigestMaxChars) : digestTitleSourceText(text, bodyDigestMaxChars);

  return {
    text,
    promptText,
    originalSourceChars,
    digestChars: promptText.length,
    language,
    style,
    maxLength,
    inputMode,
  };
}

export function validateTitleFromImageInput(input) {
  const imageUrl = asString(input?.imageUrl);
  if (!imageUrl) {
    throw new InternalApiError(400, 'imageUrl is required.', 'IMAGE_URL_REQUIRED');
  }

  const contextText = asString(input?.contextText);
  if (contextText.length > 6_000) {
    throw new InternalApiError(413, 'contextText is too large.', 'CONTEXT_TOO_LARGE');
  }

  const language = normalizeTitleLanguage(input?.language);
  const style = normalizeStyle(input?.style);
  const maxLength = normalizeMaxLength(input?.maxLength);

  return {
    imageUrl,
    contextText,
    language,
    style,
    maxLength,
  };
}

export function validateBodyFromImageInput(input) {
  const imageUrl = asString(input?.imageUrl);
  if (!imageUrl) {
    throw new InternalApiError(400, 'imageUrl is required.', 'IMAGE_URL_REQUIRED');
  }

  const titleHint = asString(input?.titleHint);
  if (titleHint.length > 300) {
    throw new InternalApiError(413, 'titleHint is too large.', 'TITLE_HINT_TOO_LARGE');
  }

  const tone = asString(input?.tone);
  if (tone.length > 120) {
    throw new InternalApiError(413, 'tone is too large.', 'TONE_TOO_LARGE');
  }

  const language = normalizeLanguage(input?.language);
  const length = normalizeLength(input?.length);

  return {
    imageUrl,
    titleHint,
    tone,
    language,
    length,
  };
}

export function validateProofreadFromTextInput(input) {
  const text = asString(input?.text);
  if (!text) {
    throw new InternalApiError(400, 'text is required.', 'TEXT_REQUIRED');
  }
  if (text.length > 20_000) {
    throw new InternalApiError(413, 'text is too large.', 'TEXT_TOO_LARGE');
  }

  const language = normalizeProofreadLanguage(input?.language);
  const preserveLanguage = normalizePreserveLanguage(input?.preserveLanguage);

  return {
    text,
    language,
    preserveLanguage,
  };
}

export function validateTodosFromTextInput(input) {
  const text = asString(input?.text);
  if (!text) {
    throw new InternalApiError(400, 'text is required.', 'TEXT_REQUIRED');
  }
  if (text.length > 30_000) {
    throw new InternalApiError(413, 'text is too large.', 'TEXT_TOO_LARGE');
  }

  const language = normalizeLanguage(input?.language);
  const sourceType = normalizeSourceType(input?.sourceType);
  const maxItems = normalizeMaxItems(input?.maxItems);

  const memberList = Array.isArray(input?.memberList)
    ? input.memberList
        .map((member) => asString(member))
        .filter(Boolean)
        .slice(0, 100)
    : [];

  const contextMessages = Array.isArray(input?.contextMessages)
    ? input.contextMessages
        .map((message) => ({
          authorName: asString(message?.authorName),
          text: asString(message?.text),
        }))
        .filter((message) => message.authorName || message.text)
        .slice(0, 30)
    : [];

  return {
    text,
    language,
    sourceType,
    maxItems,
    memberList,
    contextMessages,
  };
}

function resolveTitlePromptText(input) {
  if (input.promptText != null && String(input.promptText).length > 0) {
    return asString(input.promptText);
  }
  return asString(input.text);
}

/**
 * System role: 규칙·언어·출력 형식 (user에는 본문만).
 */
export function buildTitleFromTextSystemPrompt(input) {
  const langRule =
    input.language === 'auto'
      ? 'Keep the title in the same language as the source text (do not translate to another language).'
      : input.language === 'en'
        ? 'The title must be written in English.'
        : 'The title must be written in Korean.';
  return `You are a title generator. Produce exactly one short headline for the source text.
Style: ${input.style}. Maximum length: ${input.maxLength} characters (stay within this limit).
Return a JSON object only, with the exact shape: {"title":"..."}.
Rules:
- Put a single short title string in the title field only.
- No reasoning, chain-of-thought, markdown, code fences, bullet lists, or "Title:" prefixes.
- ${langRule}`;
}

/**
 * User role: 소스 텍스트만 (이미 digest/limit 적용된 promptText).
 */
export function buildTitleFromTextUserContent(input) {
  return `Source text:\n${resolveTitlePromptText(input)}`;
}

/** @deprecated 벤치·단일 user 메시지 호환용 — production은 system+user 분리 */
export function buildTitleFromTextPrompt(input) {
  return `${buildTitleFromTextSystemPrompt(input)}\n\n${buildTitleFromTextUserContent(input)}`;
}

/**
 * body-from-image: 코드펜스·중첩 {"body":...}·잘린 JSON까지 단일 본문 문자열로 정규화.
 */
export function extractBodyForBodyFromImage(parsed, text) {
  const fromParsed = normalizeBodyContentCandidate(unwrapBodyFieldString(parsed?.body));
  if (fromParsed) {
    return fromParsed;
  }
  const rawText = asString(text);
  if (!rawText.trim()) {
    return '';
  }
  try {
    const obj = parseJsonObjectFromModelText(rawText);
    const inner = normalizeBodyContentCandidate(unwrapBodyFieldString(obj?.body));
    if (inner) {
      return inner;
    }
  } catch {
    /* fall through — 잘린 JSON 등 */
  }
  const loose = normalizeBodyContentCandidate(extractBodyJsonStringLoose(rawText));
  if (loose) {
    return loose;
  }
  const stripped = stripOuterCodeFence(rawText).trim();
  if (stripped.length > 0 && !/"body"\s*:/.test(stripped)) {
    return stripped;
  }
  return '';
}

function unwrapBodyFieldString(value) {
  return typeof value === 'string' ? value : '';
}

function normalizeBodyContentCandidate(raw) {
  const s0 = stripOuterCodeFence(asString(raw)).trim();
  if (!s0) {
    return '';
  }
  let s = s0;
  for (let depth = 0; depth < 3; depth += 1) {
    if (!s.startsWith('{') || !/"body"\s*:/.test(s)) {
      break;
    }
    try {
      const o = JSON.parse(s);
      if (o && typeof o === 'object' && !Array.isArray(o) && typeof o.body === 'string') {
        const inner = stripOuterCodeFence(o.body).trim();
        if (!inner) {
          return s;
        }
        s = inner;
        continue;
      }
    } catch {
      break;
    }
    break;
  }
  return s.trim();
}

function stripOuterCodeFence(s) {
  const trimmed = String(s).trim();
  if (!trimmed.startsWith('```')) {
    return trimmed;
  }
  const lines = trimmed.split('\n');
  if (lines[0].startsWith('```')) {
    lines.shift();
  }
  if (lines.length > 0 && lines[lines.length - 1].trim().startsWith('```')) {
    lines.pop();
  }
  return lines.join('\n').trim();
}

/** JSON 전체 파싱 실패 시 "body":"… 값 추출(스트림 잘림 시 가능한 만큼) */
function extractBodyJsonStringLoose(text) {
  const m = text.match(/"body"\s*:\s*"/);
  if (m == null || m.index === undefined) {
    return '';
  }
  let i = m.index + m[0].length;
  let out = '';
  let esc = false;
  for (; i < text.length; i += 1) {
    const c = text[i];
    if (esc) {
      if (c === 'n') {
        out += '\n';
      } else if (c === 'r') {
        out += '\r';
      } else if (c === 't') {
        out += '\t';
      } else {
        out += c;
      }
      esc = false;
      continue;
    }
    if (c === '\\') {
      esc = true;
      continue;
    }
    if (c === '"') {
      break;
    }
    out += c;
  }
  return out.trim();
}

export function buildTitleFromImagePrompt(input) {
  const languageLabel =
    input.language === 'auto'
      ? 'the same language as the image context or visible text'
      : input.language === 'en'
        ? 'English'
        : 'Korean';
  const context = input.contextText ? ` Context: ${input.contextText}` : '';
  const langInstruction =
    input.language === 'auto'
      ? 'Keep the title in the same language as the image context or on-image text when possible.'
      : `Write the title in ${languageLabel}.`;
  return `Create one short title for this image (${input.style}, max ${input.maxLength} chars). ${langInstruction} Return JSON: {"title":"..."}${context}`;
}

/** System: 규칙·출력 형식 */
export function buildBodyFromImageSystemPrompt(input) {
  const languageLabel = input.language === 'en' ? 'English' : 'Korean';
  if (input.language === 'ko') {
    return [
      '당신은 비즈니스 어시스턴트입니다. 이미지를 분석하여 한국어로 핵심 내용을 요약하세요.',
      '반드시 하나의 JSON 객체로만 응답하세요. 키 이름은 "body"입니다.',
      '- "body" 값은 반드시 이미지의 핵심 사실을 담은 3줄 요약이어야 합니다.',
      '- 줄 바꿈은 \\n을 사용하세요.',
      '- 생각의 흐름(thinking process), 분석 단계, 서론, 부연 설명은 절대 포함하지 마세요.',
      '- "Here\'s a thinking process"와 같은 문구로 시작하지 마세요.',
      '- 오직 요약된 3줄의 텍스트만 "body" 값에 넣으세요.',
      '- 반드시 한국어로만 작성하세요. 영어 문장을 쓰지 마세요.',
      '- 만약 "body" 값이 비어있거나 "..."이면 실패로 간주합니다. 반드시 실제 내용을 작성하세요.',
      '- JSON 형식 예시: {"body": "첫 번째 사실\\n두 번째 사실\\n세 번째 사실"}',
      '- 이미지에 텍스트가 많으면 가장 중요한 3가지만 골라 요약하세요.',
    ].join('\n');
  }
  return [
    `You are a business assistant. Analyze the image and provide a factual summary in ${languageLabel}.`,
    'Return exactly one JSON object with the key "body".',
    '- The "body" value must be a 3-line factual summary of the image.',
    '- Use \\n for line breaks.',
    '- NO thinking process, NO analysis steps, NO introductory text.',
    '- DO NOT start with "Here\'s a thinking process".',
    '- Example: {"body": "Fact 1\\nFact 2\\nFact 3"}',
  ].join('\n');
}

/** User: 과제·톤·힌트 */
export function buildBodyFromImageUserPrompt(input) {
  const languageLabel = input.language === 'en' ? 'English' : 'Korean';
  const titleHint = input.titleHint ? `\n참고: ${input.titleHint}` : '';
  const tone = input.tone ? `\n톤: ${input.tone}` : '';

  if (input.language === 'ko') {
    return [
      `이미지 내용을 한국어로 3줄 요약하여 JSON {"body":"..."} 형식으로 출력하세요.${titleHint}${tone}`,
      '다른 텍스트 없이 오직 JSON 객체 하나만 출력하세요. 반드시 한국어로만 작성하세요. 영어는 절대 사용하지 마세요. "..." 대신 실제 내용을 작성하세요.',
    ].join('\n');
  }

  return [
    `Summarize this image in exactly 3 lines (${languageLabel}) and output as JSON.${titleHint}${tone}`,
    'Output ONLY the JSON: {"body":"..."}. No other text. Do not use "..." in the output.',
  ].join('\n');
}

/** 테스트·문서 호환 */
export function buildBodyFromImagePrompt(input) {
  return `${buildBodyFromImageSystemPrompt(input)}\n\n${buildBodyFromImageUserPrompt(input)}`;
}

export function buildProofreadFromTextPrompt(input) {
  const languageLabel =
    input.language === 'en'
      ? 'English'
      : input.language === 'ko'
        ? 'Korean'
        : 'the same language as the input';
  const preserveSentence = input.preserveLanguage
    ? 'Preserve the original language. Do not translate.'
    : 'Preserve the original language unless the input explicitly mixes languages.';

  return `Proofread the following text in ${languageLabel}.

Rules:
- Fix only spelling, spacing, punctuation, and obvious typos.
- Keep the original meaning and structure as much as possible.
- Do not summarize, rewrite, or change tone.
- ${preserveSentence}
- Return JSON object only: {"correctedText":"..."}.

Source text:
${input.text}`;
}

function buildTodosFromTextPrompt(input) {
  const languageLabel = input.language === 'en' ? 'English' : 'Korean';
  const sourceLabel = input.sourceType === 'NOTE' ? 'note' : 'conversation';
  const memberSection = input.memberList.length
    ? `\nTeam member list:\n${input.memberList.map((member) => `- ${member}`).join('\n')}`
    : '';
  const contextSection = input.contextMessages.length
    ? `\nRecent context messages:\n${input.contextMessages.map((message) => `- [${message.authorName}] ${message.text}`).join('\n')}`
    : '';

  return `Extract actionable to-do items from this ${sourceLabel}.

Rules:
- Use ${languageLabel} for title and description.
- Only include clear, actionable tasks.
- Only include assigneeNames when someone is explicitly assigned or clearly responsible.
- If a deadline is mentioned, use dueDate in YYYY-MM-DD format.
- Set priority to HIGH, MEDIUM, or LOW.
- If there are no actionable tasks, return {"items":[]}.
- Return JSON object only, with the exact shape {"items":[...]}.

Each item must have:
- title (string)
- description (string, optional)
- assigneeNames (array of strings)
- dueDate (YYYY-MM-DD, optional)
- priority (HIGH | MEDIUM | LOW, optional)

Source text:
${input.text}${memberSection}${contextSection}`;
}

export async function ensureModelAvailable(config, modelId, fetchModels = fetchRouterModels) {
  const models = await fetchModels(config, { registeredOnly: true });
  const resolved = resolveLogicalRouterModelId(models, modelId);
  if (!resolved) {
    throw new InternalApiError(503, `Model ${modelId} is unavailable.`, 'MODEL_UNAVAILABLE');
  }
  return resolved;
}

export function validateTitleOutput(raw, maxLength) {
  const rawTrim = asString(raw).replace(/\r\n/g, '\n').trim();
  if (!rawTrim) {
    throw new InternalApiError(422, 'Model did not produce a valid title.', 'INVALID_TITLE_OUTPUT', {
      reason: 'RAW_EMPTY',
      stats: { bytes: 0, lineCount: 0, hasJsonBrace: false, hasJsonTitleKey: false },
    });
  }

  const sanitizeTitle = (value) => {
    let s = asString(value).replace(/\r\n/g, '\n').trim();
    if (!s) return '';

    const unwrapFence = (input) => {
      const m = /^```(?:json)?\s*\n?([\s\S]*?)\n?```\s*$/i.exec(input.trim());
      return m ? m[1].trim() : input.trim();
    };

    s = unwrapFence(s);

    const stripLeadingLabel = (input) => input.replace(/^(?:제목|title|headline|summary|요약)\s*[:：\-]\s*/i, '').trim();
    const isNoiseLine = (line) => {
      const t = line.trim();
      if (!t) return true;
      if (/^#{1,6}\s/.test(t)) return true;
      if (/^\d+\.\s/.test(t)) return true;
      if (/^[-*•]\s/.test(t)) return true;
      if (/^`(json)?`?$/i.test(t)) return true;
      if (/^(here'?s|the\s+following|analyze|analysis|thinking\s+process|step\s*\d)/i.test(t)) return true;
      if (/^(?:제목|title|headline|summary|요약)\s*[:：\-]\s*$/i.test(t)) return true;
      return false;
    };
    const titleFromJsonObject = (jsonStr) => {
      try {
        const parsed = JSON.parse(jsonStr);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
        const t = parsed.title;
        return typeof t === 'string' ? t.trim() : null;
      } catch {
        return null;
      }
    };
    const titlesFromBalancedBraces = (value) => {
      const found = [];
      for (let i = 0; i < value.length; i++) {
        if (value[i] !== '{') continue;
        let depth = 0;
        let j = i;
        for (; j < value.length; j++) {
          const c = value[j];
          if (c === '{') depth++;
          else if (c === '}') {
            depth--;
            if (depth === 0) break;
          }
        }
        if (depth !== 0) continue;
        const t = titleFromJsonObject(value.slice(i, j + 1));
        if (t) found.push(t);
        i = j;
      }
      return found;
    };

    const fromBlocks = titlesFromBalancedBraces(s);
    let extracted = fromBlocks.length > 0 ? fromBlocks[fromBlocks.length - 1] : null;
    if (!extracted) extracted = titleFromJsonObject(s);
    if (!extracted) {
      const start = s.indexOf('{');
      const end = s.lastIndexOf('}');
      if (start !== -1 && end > start) {
        extracted = titleFromJsonObject(s.slice(start, end + 1));
      }
    }

    const stripBulletPrefix = (input) => input.replace(/^[-*•]\s+/, '').trim();
    const lineSource = extracted ?? s.split('\n').find((line) => !isNoiseLine(line)) ?? s.split('\n').map(stripBulletPrefix).find((line) => line && !isNoiseLine(line)) ?? '';
    if (!lineSource) return '';

    return stripLeadingLabel(lineSource.replace(/\s+/g, ' ').trim());
  };

  const title = sanitizeTitle(raw);
  if (!title) {
    const stats = {
      bytes: rawTrim.length,
      lineCount: rawTrim.split('\n').length,
      hasJsonBrace: rawTrim.includes('{'),
      hasJsonTitleKey: /"title"\s*:/.test(rawTrim),
    };
    throw new InternalApiError(422, 'Model did not produce a valid title.', 'INVALID_TITLE_OUTPUT', {
      reason: 'SANITIZE_EMPTY',
      stats,
    });
  }
  if (title.length > maxLength) {
    return title.slice(0, maxLength).trim();
  }
  return title;
}

export function validateProofreadOutput(raw) {
  const correctedText = asString(raw).trim();
  if (!correctedText) {
    throw new InternalApiError(422, 'Model did not produce a valid proofread result.', 'INVALID_PROOFREAD_OUTPUT');
  }
  return correctedText;
}

export function validateBodyOutput(raw) {
  const body = asString(raw).trim();
  if (!body) {
    throw new InternalApiError(422, 'Model did not produce a valid body.', 'INVALID_BODY_OUTPUT');
  }
  return body;
}

function normalizeLanguage(value) {
  if (value === undefined || value === null || value === '') {
    return 'ko';
  }

  const language = asString(value).toLowerCase();
  if (!LANGUAGES.has(language)) {
    throw new InternalApiError(400, 'language must be "ko" or "en".', 'INVALID_LANGUAGE');
  }

  return language;
}

function normalizeProofreadLanguage(value) {
  if (value === undefined || value === null || value === '') {
    return 'auto';
  }

  const language = asString(value).toLowerCase();
  if (language === 'auto' || language === 'ko' || language === 'en') {
    return language;
  }

  throw new InternalApiError(400, 'language must be one of "auto", "ko", "en".', 'INVALID_LANGUAGE');
}

function normalizePreserveLanguage(value) {
  if (value === undefined || value === null || value === '') {
    return true;
  }

  if (value === true || value === 'true' || value === 1 || value === '1') {
    return true;
  }
  if (value === false || value === 'false' || value === 0 || value === '0') {
    return false;
  }

  throw new InternalApiError(400, 'preserveLanguage must be a boolean.', 'INVALID_PRESERVE_LANGUAGE');
}

function normalizeStyle(value) {
  if (value === undefined || value === null || value === '') {
    return 'neutral';
  }

  const style = asString(value).toLowerCase();
  if (!TITLE_STYLES.has(style)) {
    throw new InternalApiError(
      400,
      'style must be one of "neutral", "marketing", "news".',
      'INVALID_STYLE',
    );
  }
  return style;
}

function normalizeMaxLength(value) {
  if (value === undefined || value === null || value === '') {
    return 100;
  }

  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 8 || parsed > TITLE_MAX_OUTPUT_LENGTH) {
    throw new InternalApiError(
      400,
      `maxLength must be an integer between 8 and ${TITLE_MAX_OUTPUT_LENGTH}.`,
      'INVALID_MAX_LENGTH',
    );
  }
  return parsed;
}

function normalizeLength(value) {
  if (value === undefined || value === null || value === '') {
    return 'medium';
  }

  const normalized = asString(value).toLowerCase();
  if (!BODY_LENGTHS.has(normalized)) {
    throw new InternalApiError(400, 'length must be one of "short", "medium", "long".', 'INVALID_LENGTH');
  }
  return normalized;
}

function normalizeSourceType(value) {
  if (value === undefined || value === null || value === '') {
    return 'CHAT';
  }

  const sourceType = asString(value).toUpperCase();
  if (sourceType !== 'CHAT' && sourceType !== 'NOTE') {
    throw new InternalApiError(400, 'sourceType must be one of "CHAT", "NOTE".', 'INVALID_SOURCE_TYPE');
  }
  return sourceType;
}

function normalizeMaxItems(value) {
  if (value === undefined || value === null || value === '') {
    return 8;
  }

  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 20) {
    throw new InternalApiError(400, 'maxItems must be an integer between 1 and 20.', 'INVALID_MAX_ITEMS');
  }
  return parsed;
}

function todoMaxTokens(maxItems) {
  return Math.min(2000, 320 + maxItems * 180);
}

function proofreadMaxTokens(text) {
  const approx = Math.ceil(text.length / 2.5);
  return Math.min(2400, Math.max(512, approx));
}

function validateTodoItemsOutput(raw, maxItems) {
  const items = Array.isArray(raw)
    ? raw
    : raw && typeof raw === 'object' && Array.isArray(raw.items)
      ? raw.items
      : [];

  const normalized = [];
  for (const item of items.slice(0, maxItems)) {
    const title = asString(item?.title).replace(/\s+/g, ' ').trim();
    if (!title) {
      continue;
    }

    const description = asString(item?.description);
    const dueDate = normalizeDueDate(item?.dueDate);
    const priority = normalizePriority(item?.priority);
    const assigneeNames = Array.isArray(item?.assigneeNames)
      ? item.assigneeNames.map((name) => asString(name)).filter(Boolean).slice(0, 5)
      : [];

    normalized.push({
      title,
      ...(description ? { description } : {}),
      assigneeNames,
      ...(dueDate ? { dueDate } : {}),
      ...(priority ? { priority } : {}),
    });
  }

  return normalized;
}

function normalizeDueDate(value) {
  const dueDate = asString(value);
  if (!dueDate) {
    return undefined;
  }

  if (!/^\d{4}-\d{2}-\d{2}$/.test(dueDate)) {
    return undefined;
  }

  return dueDate;
}

function normalizePriority(value) {
  const priority = asString(value).toUpperCase();
  if (!priority) {
    return undefined;
  }

  return TODO_PRIORITIES.has(priority) ? priority : undefined;
}

function bodyMaxTokens(length, config) {
  const shortCap = config?.contentBodyMaxTokensShort ?? 320;
  const mediumCap = config?.contentBodyMaxTokensMedium ?? 512;
  const longCap = config?.contentBodyMaxTokensLong ?? 768;
  if (length === 'short') {
    return shortCap;
  }
  if (length === 'long') {
    return longCap;
  }
  return mediumCap;
}

function asString(value) {
  if (typeof value !== 'string') {
    return '';
  }
  return value.trim();
}
