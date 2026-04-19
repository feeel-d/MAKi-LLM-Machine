import { createSseParser, extractDeltaText } from './sse.mjs';
import { isRouterSlotReady } from './models.mjs';

export async function fetchRouterModels(config) {
  try {
    const response = await fetch(new URL('/v1/models', config.llamaServerUrl), {
      headers: buildHeaders(config),
    });

    if (!response.ok) {
      throw new Error(`Model lookup failed with status ${response.status}`);
    }

    const payload = await response.json();
    const raw = Array.isArray(payload?.data) ? payload.data : [];
    return raw.filter(isRouterSlotReady);
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('Model lookup failed')) {
      throw error;
    }
    throw new Error(formatUpstreamFetchError(error, config.llamaServerUrl));
  }
}

export async function streamChatCompletion({
  config,
  model,
  messages,
  temperature,
  maxTokens,
  systemPrompt,
  signal,
  onMeta,
  onToken,
  onDone,
  onError,
}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort('timeout'), config.requestTimeoutMs);

  const combinedSignal = mergeAbortSignals(signal, controller.signal);
  const requestId = crypto.randomUUID();

  try {
    onMeta({ model, requestId });

    const body = {
      model,
      messages: injectSystemPrompt(messages, systemPrompt),
      stream: true,
      temperature: typeof temperature === 'number' ? temperature : 0.7,
      max_tokens: typeof maxTokens === 'number' ? maxTokens : 768,
    };

    const response = await fetch(new URL('/v1/chat/completions', config.llamaServerUrl), {
      method: 'POST',
      headers: {
        ...buildHeaders(config),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: combinedSignal,
    });

    if (!response.ok || !response.body) {
      const text = await response.text();
      let message = text;
      try {
        const parsed = JSON.parse(text);
        const inner = parsed?.error?.message ?? parsed?.message;
        if (typeof inner === 'string' && inner.length > 0) {
          message = inner;
        }
      } catch {
        // keep raw text
      }
      throw new Error(message || `llama-server request failed with status ${response.status}`);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    const parse = createSseParser((data) => {
      if (data === '[DONE]') {
        return;
      }

      try {
        const payload = JSON.parse(data);
        const text = extractDeltaText(payload);
        if (text) {
          onToken({ model, requestId, text });
        }
      } catch (error) {
        onError({ model, requestId, error: 'Invalid upstream SSE payload.' });
      }
    });

    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }

      parse(decoder.decode(value, { stream: true }));
    }

    onDone({ model, requestId });
  } catch (error) {
    onError({
      model,
      requestId,
      error: formatUpstreamFetchError(error, config.llamaServerUrl),
    });
  } finally {
    clearTimeout(timeout);
  }
}

export async function completeJsonCompletion({
  config,
  model,
  messages,
  temperature,
  maxTokens,
  systemPrompt,
  requestId,
  retryCount = 1,
}) {
  const maxAttempts = Math.max(1, Number(retryCount) + 1);
  let lastError;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const text = await requestChatText({
        config,
        model,
        messages,
        systemPrompt,
        temperature,
        maxTokens,
      });
      return {
        requestId: requestId ?? crypto.randomUUID(),
        text,
        parsed: parseJsonObjectFromModelText(text),
      };
    } catch (error) {
      lastError = error;

      if (attempt >= maxAttempts) {
        break;
      }
    }
  }

  throw lastError;
}

/** Node undici 등에서 흔한 "fetch failed"를 그대로 쓰면 Gemma E4B만 실패한 것처럼 보여도, 실제는 라우터 연결/슬롯 로드 문제인 경우가 많음 */
function formatUpstreamFetchError(error, llamaServerUrl) {
  const base =
    error instanceof Error
      ? error.message
      : typeof error === 'string'
        ? error
        : 'Unknown upstream error.';
  let detail = base;
  if (error instanceof Error && error.cause instanceof Error) {
    detail = `${base} (${error.cause.message})`;
  }

  const lower = detail.toLowerCase();
  const routerHint =
    'Mac에서 llama-server(라우터)가 떠 있는지, `curl ' +
    String(llamaServerUrl).replace(/\/$/, '') +
    '/v1/models` 로 확인하세요. Gemma E4B만 실패하면 해당 GGUF 로드 실패·메모리 부족일 수 있습니다.';

  if (lower.includes('fetch failed') || lower.includes('failed to fetch')) {
    return `로컬 라우터(${llamaServerUrl})로 HTTP 요청 실패 — ${routerHint}`;
  }
  if (detail.includes('ECONNREFUSED')) {
    return `로컬 라우터가 꺼져 있거나 포트가 다릅니다(LLAMA_SERVER_URL=${llamaServerUrl}). ./scripts/run-llama-router.sh 실행 여부를 확인하세요.`;
  }
  if (
    detail.includes('ECONNRESET') ||
    detail.includes('UND_ERR_SOCKET') ||
    detail.includes('other side closed')
  ) {
    return `라우터 연결이 끊겼습니다(모델 슬롯·OOM·세그폴트 가능). ${detail}`;
  }
  if (base === 'timeout' || lower.includes('timeout')) {
    return `요청 시간 초과 — 모델이 크면 라우터 타임아웃일 수 있습니다. ${detail}`;
  }
  return detail;
}

function buildHeaders(config) {
  const headers = {};

  if (config.llamaApiKey) {
    headers.Authorization = `Bearer ${config.llamaApiKey}`;
  }

  return headers;
}

async function requestChatText({
  config,
  model,
  messages,
  temperature,
  maxTokens,
  systemPrompt,
}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort('timeout'), config.requestTimeoutMs);

  try {
    const response = await fetch(new URL('/v1/chat/completions', config.llamaServerUrl), {
      method: 'POST',
      headers: {
        ...buildHeaders(config),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model,
        messages: injectSystemPrompt(messages, systemPrompt),
        stream: false,
        temperature: typeof temperature === 'number' ? temperature : 0.4,
        max_tokens: typeof maxTokens === 'number' ? maxTokens : 512,
        response_format: {
          type: 'json_object',
        },
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      const text = await response.text();
      let message = text;
      try {
        const parsed = JSON.parse(text);
        const inner = parsed?.error?.message ?? parsed?.message;
        if (typeof inner === 'string' && inner.length > 0) {
          message = inner;
        }
      } catch {
        // keep raw text
      }
      throw new Error(message || `llama-server request failed with status ${response.status}`);
    }

    const payload = await response.json();
    const outputText = extractResponseText(payload).trim();
    if (!outputText) {
      throw new Error('Model returned empty content.');
    }

    return outputText;
  } catch (error) {
    throw new Error(formatUpstreamFetchError(error, config.llamaServerUrl));
  } finally {
    clearTimeout(timeout);
  }
}

export function parseJsonObjectFromModelText(value) {
  const input = String(value ?? '').trim();
  if (!input) {
    throw new Error('Model returned empty JSON content.');
  }

  const raw = unwrapCodeFence(input);
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('Model output JSON must be an object.');
    }
    return parsed;
  } catch {
    const first = raw.indexOf('{');
    const last = raw.lastIndexOf('}');
    if (first === -1 || last === -1 || last <= first) {
      throw new Error('Model did not return valid JSON.');
    }

    const sliced = raw.slice(first, last + 1);
    const parsed = JSON.parse(sliced);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('Model output JSON must be an object.');
    }
    return parsed;
  }
}

function unwrapCodeFence(value) {
  const trimmed = value.trim();
  if (!trimmed.startsWith('```')) {
    return trimmed;
  }

  const lines = trimmed.split('\n');
  if (lines.length < 2) {
    return trimmed;
  }

  if (lines[0].startsWith('```')) {
    lines.shift();
  }
  if (lines.length > 0 && lines[lines.length - 1].startsWith('```')) {
    lines.pop();
  }
  return lines.join('\n').trim();
}

function extractResponseText(payload) {
  const choice = payload?.choices?.[0];
  if (!choice) {
    return '';
  }

  if (typeof choice.text === 'string') {
    return choice.text;
  }

  const message = choice.message ?? choice.delta ?? {};
  const content = message.content;
  if (typeof content === 'string') {
    return content;
  }

  if (Array.isArray(content)) {
    return content
      .map((item) => {
        if (typeof item === 'string') {
          return item;
        }
        if (typeof item?.text === 'string') {
          return item.text;
        }
        return '';
      })
      .join('');
  }

  return '';
}

function injectSystemPrompt(messages, systemPrompt) {
  if (!systemPrompt || systemPrompt.trim().length === 0) {
    return messages;
  }

  return [{ role: 'system', content: systemPrompt.trim() }, ...messages];
}

function mergeAbortSignals(...signals) {
  const controller = new AbortController();

  for (const signal of signals) {
    if (!signal) {
      continue;
    }

    if (signal.aborted) {
      controller.abort(signal.reason);
      return controller.signal;
    }

    signal.addEventListener(
      'abort',
      () => {
        if (!controller.signal.aborted) {
          controller.abort(signal.reason);
        }
      },
      { once: true },
    );
  }

  return controller.signal;
}
