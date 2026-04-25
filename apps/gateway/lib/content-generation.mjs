import { completeJsonCompletion, fetchRouterModels, fetchTextEmbedding } from './llama-client.mjs';
import { fetchImageAsDataUrl } from './image-ingest.mjs';
import { InternalApiError } from './internal-errors.mjs';
import { resolveLogicalRouterModelId } from './models.mjs';

/** llama-server 라우터 슬롯 id — title·proofread·todos·이미지 태스크 모두 E4B 슬롯 사용 */
const ROUTER_SLOT_GEMMA_E4B = 'gemmae4';

const TITLE_STYLES = new Set(['neutral', 'marketing', 'news']);
const LANGUAGES = new Set(['ko', 'en']);
const BODY_LENGTHS = new Set(['short', 'medium', 'long']);
const TODO_PRIORITIES = new Set(['HIGH', 'MEDIUM', 'LOW']);

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

      const prompt = buildTitleFromTextPrompt(normalized);
      const completion = await runJsonCompletion({
        config,
        model,
        requestId,
        retryCount: config.contentRetryCount,
        temperature: 0.3,
        maxTokens: 512,
        jsonResponseFormat: false,
        messages: [
          {
            role: 'user',
            content: prompt,
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
        temperature: 0.7,
        maxTokens: bodyMaxTokens(normalized.length),
        jsonResponseFormat: false,
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'text',
                text: buildBodyFromImagePrompt(normalized),
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

      const body = validateBodyOutput(completion.parsed?.body ?? completion.text);
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

export function validateTitleFromTextInput(input) {
  const text = asString(input?.text);
  if (!text) {
    throw new InternalApiError(400, 'text is required.', 'TEXT_REQUIRED');
  }
  if (text.length > 12_000) {
    throw new InternalApiError(413, 'text is too large.', 'TEXT_TOO_LARGE');
  }

  const language = normalizeLanguage(input?.language);
  const style = normalizeStyle(input?.style);
  const maxLength = normalizeMaxLength(input?.maxLength);

  return { text, language, style, maxLength };
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

  const language = normalizeLanguage(input?.language);
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

export function buildTitleFromTextPrompt(input) {
  const languageLabel = input.language === 'en' ? 'English' : 'Korean';
  return `Create one ${languageLabel} title (${input.style}, max ${input.maxLength} chars). Return JSON object only: {"title":"..."}.
Rules:
- Output a single short title line only inside the title field.
- Do not include reasoning, analysis, markdown, code fences, lists, or prefixes.
- Keep the title in the same language as the input.

Source text:
${input.text}`;
}

export function buildTitleFromImagePrompt(input) {
  const languageLabel = input.language === 'en' ? 'English' : 'Korean';
  const context = input.contextText ? ` Context: ${input.contextText}` : '';
  return `Create one ${languageLabel} title for this image (${input.style}, max ${input.maxLength} chars). Return JSON: {"title":"..."}${context}`;
}

export function buildBodyFromImagePrompt(input) {
  const languageLabel = input.language === 'en' ? 'English' : 'Korean';
  const lengthGuide =
    input.length === 'short'
      ? 'Write around 1-2 short paragraphs.'
      : input.length === 'long'
        ? 'Write around 4-6 detailed paragraphs.'
        : 'Write around 2-4 paragraphs.';

  const titleHint = input.titleHint ? ` Title hint: ${input.titleHint}.` : '';
  const tone = input.tone ? ` Tone: ${input.tone}.` : '';
  return `Write a ${languageLabel} article body from this image. ${lengthGuide} Return JSON: {"body":"..."}${titleHint}${tone}`;
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
    throw new InternalApiError(422, 'Model did not produce a valid title.', 'INVALID_TITLE_OUTPUT');
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
    return 48;
  }

  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 8 || parsed > 120) {
    throw new InternalApiError(400, 'maxLength must be an integer between 8 and 120.', 'INVALID_MAX_LENGTH');
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

function bodyMaxTokens(length) {
  if (length === 'short') {
    return 360;
  }
  if (length === 'long') {
    return 1200;
  }
  return 760;
}

function asString(value) {
  if (typeof value !== 'string') {
    return '';
  }
  return value.trim();
}
