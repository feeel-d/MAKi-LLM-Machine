import { createSseParser, extractDeltaText } from './sse.mjs';

export async function fetchRouterModels(config) {
  const response = await fetch(new URL('/v1/models', config.llamaServerUrl), {
    headers: buildHeaders(config),
  });

  if (!response.ok) {
    throw new Error(`Model lookup failed with status ${response.status}`);
  }

  const payload = await response.json();
  return Array.isArray(payload?.data) ? payload.data : [];
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
    const message =
      error instanceof Error
        ? error.message
        : typeof error === 'string'
          ? error
          : 'Unknown upstream error.';

    onError({ model, requestId, error: message });
  } finally {
    clearTimeout(timeout);
  }
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
