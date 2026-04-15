import { createSseParser, extractDeltaText } from './sse.mjs';

export async function fetchRouterModels(config) {
  try {
    const response = await fetch(new URL('/v1/models', config.llamaServerUrl), {
      headers: buildHeaders(config),
    });

    if (!response.ok) {
      throw new Error(`Model lookup failed with status ${response.status}`);
    }

    const payload = await response.json();
    return Array.isArray(payload?.data) ? payload.data : [];
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
      throw new Error(text || `llama-server request failed with status ${response.status}`);
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
