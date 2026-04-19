import { completeJsonCompletion, fetchRouterModels } from './llama-client.mjs';
import { fetchImageAsDataUrl } from './image-ingest.mjs';
import { InternalApiError } from './internal-errors.mjs';

const TITLE_STYLES = new Set(['neutral', 'marketing', 'news']);
const LANGUAGES = new Set(['ko', 'en']);
const BODY_LENGTHS = new Set(['short', 'medium', 'long']);

export const CONTENT_TASK_MODELS = {
  titleFromText: 'deepseek',
  titleFromImage: 'gemmae4',
  bodyFromImage: 'gemmae4',
};

export function createContentGenerationService(dependencies = {}) {
  const fetchModels = dependencies.fetchRouterModels ?? fetchRouterModels;
  const runJsonCompletion = dependencies.completeJsonCompletion ?? completeJsonCompletion;
  const fetchImage = dependencies.fetchImageAsDataUrl ?? fetchImageAsDataUrl;

  return {
    async titleFromText({ config, requestId, input }) {
      const normalized = validateTitleFromTextInput(input);
      await ensureModelAvailable(config, CONTENT_TASK_MODELS.titleFromText, fetchModels);

      const prompt = buildTitleFromTextPrompt(normalized);
      const completion = await runJsonCompletion({
        config,
        model: CONTENT_TASK_MODELS.titleFromText,
        requestId,
        retryCount: config.contentRetryCount,
        temperature: 0.3,
        maxTokens: 120,
        messages: [
          {
            role: 'user',
            content: prompt,
          },
        ],
      });

      const title = validateTitleOutput(completion.parsed?.title, normalized.maxLength);
      return {
        title,
        model: CONTENT_TASK_MODELS.titleFromText,
      };
    },

    async titleFromImage({ config, requestId, input }) {
      const normalized = validateTitleFromImageInput(input);
      await ensureModelAvailable(config, CONTENT_TASK_MODELS.titleFromImage, fetchModels);

      const image = await fetchImage({
        imageUrl: normalized.imageUrl,
        config,
      });

      const completion = await runJsonCompletion({
        config,
        model: CONTENT_TASK_MODELS.titleFromImage,
        requestId,
        retryCount: config.contentRetryCount,
        temperature: 0.4,
        maxTokens: 120,
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

      const title = validateTitleOutput(completion.parsed?.title, normalized.maxLength);
      return {
        title,
        model: CONTENT_TASK_MODELS.titleFromImage,
      };
    },

    async bodyFromImage({ config, requestId, input }) {
      const normalized = validateBodyFromImageInput(input);
      await ensureModelAvailable(config, CONTENT_TASK_MODELS.bodyFromImage, fetchModels);

      const image = await fetchImage({
        imageUrl: normalized.imageUrl,
        config,
      });

      const completion = await runJsonCompletion({
        config,
        model: CONTENT_TASK_MODELS.bodyFromImage,
        requestId,
        retryCount: config.contentRetryCount,
        temperature: 0.7,
        maxTokens: bodyMaxTokens(normalized.length),
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

      const body = validateBodyOutput(completion.parsed?.body);
      return {
        body,
        model: CONTENT_TASK_MODELS.bodyFromImage,
      };
    },
  };
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

export function buildTitleFromTextPrompt(input) {
  const styleLabel = input.style;
  const languageLabel = input.language === 'en' ? 'English' : 'Korean';

  return [
    'Generate exactly one title from the text.',
    `Language: ${languageLabel}.`,
    `Style: ${styleLabel}.`,
    `Max length: ${input.maxLength} characters.`,
    'Return JSON only with this shape: {"title":"..."}',
    `Text:\n${input.text}`,
  ].join('\n');
}

export function buildTitleFromImagePrompt(input) {
  const languageLabel = input.language === 'en' ? 'English' : 'Korean';
  const parts = [
    'Analyze the image and create exactly one concise title.',
    `Language: ${languageLabel}.`,
    `Style: ${input.style}.`,
    `Max length: ${input.maxLength} characters.`,
    'Return JSON only with this shape: {"title":"..."}',
  ];

  if (input.contextText) {
    parts.push(`Context:\n${input.contextText}`);
  }

  return parts.join('\n');
}

export function buildBodyFromImagePrompt(input) {
  const languageLabel = input.language === 'en' ? 'English' : 'Korean';
  const lengthGuide =
    input.length === 'short'
      ? 'Write around 1-2 short paragraphs.'
      : input.length === 'long'
        ? 'Write around 4-6 detailed paragraphs.'
        : 'Write around 2-4 paragraphs.';

  const parts = [
    'Analyze the image and write a coherent article body.',
    `Language: ${languageLabel}.`,
    lengthGuide,
    'Return JSON only with this shape: {"body":"..."}',
  ];

  if (input.titleHint) {
    parts.push(`Title hint: ${input.titleHint}`);
  }
  if (input.tone) {
    parts.push(`Tone: ${input.tone}`);
  }

  return parts.join('\n');
}

export async function ensureModelAvailable(config, modelId, fetchModels = fetchRouterModels) {
  const models = await fetchModels(config);
  const available = models.some((entry) => entry.id === modelId);
  if (!available) {
    throw new InternalApiError(503, `Model ${modelId} is unavailable.`, 'MODEL_UNAVAILABLE');
  }
}

export function validateTitleOutput(raw, maxLength) {
  const title = asString(raw).replace(/\s+/g, ' ').trim();
  if (!title) {
    throw new InternalApiError(422, 'Model did not produce a valid title.', 'INVALID_TITLE_OUTPUT');
  }
  if (title.length > maxLength) {
    return title.slice(0, maxLength).trim();
  }
  return title;
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

