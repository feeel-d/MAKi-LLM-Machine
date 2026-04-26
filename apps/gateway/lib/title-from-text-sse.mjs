import os from 'node:os';
import { assertServiceKey, getRequestId } from './internal-auth.mjs';
import { InternalApiError, isInternalApiError } from './internal-errors.mjs';
import {
  buildTitleFromTextSystemPrompt,
  buildTitleFromTextUserContent,
  CONTENT_TASK_MODELS,
  ensureModelAvailable,
  validateTitleFromTextInput,
  validateTitleOutput,
} from './content-generation.mjs';
import { fetchRouterModels, streamChatCompletion } from './llama-client.mjs';
import { getClientIp, readJsonBody, sendJson } from './http.mjs';
import { sendEvent, writeSseHeaders } from './sse.mjs';
import { logStructured } from './structured-log.mjs';

const TITLE_TEMPERATURE = 0.3;
/** 제목 한 줄 JSON — 200자 이하 출력에 맞춘 상한(지연·비용 안정) */
const TITLE_MAX_TOKENS = 384;

function logTitle(level, payload) {
  logStructured(level, { event: 'title_from_text', route: 'title-from-text', ...payload });
}

function modelDebugFields(model) {
  const m = String(model ?? '');
  const q = /:([A-Z0-9_]+)\s*$/i.exec(m);
  return {
    modelId: m,
    quantLabel: q ? q[1] : undefined,
    modelFamily: /gemma/i.test(m) ? 'gemma' : /llama|mistral|qwen/i.test(m) ? 'other' : undefined,
  };
}

function hostResourceSnapshot() {
  try {
    const la = os.loadavg();
    return {
      loadavg1m: la[0],
      loadavg5m: la[1],
      loadavg15m: la[2],
      freeMemMb: Math.round(os.freemem() / 1024 / 1024),
      totalMemMb: Math.round(os.totalmem() / 1024 / 1024),
    };
  } catch {
    return {};
  }
}

/**
 * POST /internal/v1/content/title-from-text/stream
 * Server-Sent Events (chunk 단위: event `chunk` { text } → 마지막 `done` { title, model, requestId, latencyMs, finished: true }).
 */
export async function handleTitleFromTextSse({ request, response, config, queue, rateLimiter }) {
  const gatewayRequestId = getRequestId(request);
  const startedAt = Date.now();

  try {
    assertServiceKey(request, config);
  } catch (error) {
    if (isInternalApiError(error)) {
      sendJson(response, error.statusCode, { error: error.message, code: error.code, requestId: gatewayRequestId });
      return;
    }
    throw error;
  }

  let body;
  try {
    body = await readJsonBody(request, config.maxBodyBytes);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Invalid body.';
    sendJson(response, 400, { error: message, requestId: gatewayRequestId });
    return;
  }

  let normalized;
  try {
    normalized = validateTitleFromTextInput(body);
  } catch (error) {
    if (isInternalApiError(error)) {
      sendJson(response, error.statusCode, { error: error.message, code: error.code, requestId: gatewayRequestId });
      return;
    }
    throw error;
  }

  const clientIp = getClientIp(request);
  if (!rateLimiter.allow(clientIp, 1)) {
    logTitle('warn', { phase: 'rate_limited', requestId: gatewayRequestId, clientIp });
    sendJson(response, 429, { error: 'Rate limit exceeded.', requestId: gatewayRequestId });
    return;
  }

  let model;
  try {
    model = await ensureModelAvailable(config, CONTENT_TASK_MODELS.titleFromText, fetchRouterModels);
  } catch (error) {
    if (isInternalApiError(error)) {
      sendJson(response, error.statusCode, { error: error.message, code: error.code, requestId: gatewayRequestId });
      return;
    }
    throw error;
  }

  const systemPrompt = buildTitleFromTextSystemPrompt(normalized);
  const userContent = buildTitleFromTextUserContent(normalized);

  writeSseHeaders(response);

  const emit = (event, data) => {
    if (!response.writableEnded && !response.destroyed) {
      sendEvent(response, event, data);
    }
  };

  emit('meta', { requestId: gatewayRequestId, model });
  logTitle('info', {
    phase: 'stream_start',
    requestId: gatewayRequestId,
    model,
    maxLength: normalized.maxLength,
    ...modelDebugFields(model),
    originalSourceChars: normalized.originalSourceChars,
    digestChars: normalized.digestChars,
    sourceTextChars: normalized.text.length,
    promptChars: systemPrompt.length + userContent.length,
    inputMode: normalized.inputMode,
    language: normalized.language,
    style: normalized.style,
    inference: { temperature: TITLE_TEMPERATURE, maxTokens: TITLE_MAX_TOKENS },
    queue: queue.getStats(),
    host: hostResourceSnapshot(),
    tracking: { feature: 'title_from_text', outcome: 'stream_start' },
    debugHint:
      'queue=inference·slot(GPU). RAW_EMPTY+inUse/pending↑·load↑면 동시성·Q4·temperature/top_p. VRAM/CUDA는 llama/호스트 nvidia-smi',
  });

  const abortController = new AbortController();
  const closeHandler = () => abortController.abort('client_closed');
  request.on('close', closeHandler);

  let accumulated = '';
  let streamErrored = false;

  const { signal } = abortController;

  try {
    await queue.enqueue(1, async () => {
      await streamChatCompletion({
        config,
        model,
        messages: [{ role: 'user', content: userContent }],
        systemPrompt,
        temperature: TITLE_TEMPERATURE,
        maxTokens: TITLE_MAX_TOKENS,
        signal,
        onMeta: () => {},
        onToken: ({ text }) => {
          if (text) {
            accumulated += text;
            emit('chunk', { text });
          }
        },
        onDone: () => {},
        onError: (payload) => {
          streamErrored = true;
        logTitle('error', {
          phase: 'llama_stream',
          requestId: gatewayRequestId,
          model,
          ...modelDebugFields(model),
          inference: { temperature: TITLE_TEMPERATURE, maxTokens: TITLE_MAX_TOKENS },
          queue: queue.getStats(),
          host: hostResourceSnapshot(),
          tracking: { feature: 'title_from_text', outcome: 'upstream_error', code: payload?.code },
          upstream: payload,
        });
          emit('error', { ...payload, requestId: gatewayRequestId });
        },
      });
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Queue unavailable.';
    logTitle('error', {
      phase: 'queue_or_stream',
      requestId: gatewayRequestId,
      model,
      ...modelDebugFields(model),
      err: message,
      queue: queue.getStats(),
      host: hostResourceSnapshot(),
      tracking: { feature: 'title_from_text', outcome: 'queue_or_stream_error', code: 'QUEUE_ERROR' },
    });
    emit('error', { requestId: gatewayRequestId, error: message, code: 'QUEUE_ERROR' });
    streamErrored = true;
  } finally {
    request.off('close', closeHandler);
  }

  if (!streamErrored) {
    try {
      const title = validateTitleOutput(accumulated, normalized.maxLength);
      const latencyMs = Date.now() - startedAt;
      logTitle('info', {
        phase: 'done',
        requestId: gatewayRequestId,
        model,
        ...modelDebugFields(model),
        latencyMs,
        titleChars: title.length,
        originalSourceChars: normalized.originalSourceChars,
        digestChars: normalized.digestChars,
        tracking: { feature: 'title_from_text', outcome: 'success' },
        acc: {
          bytes: accumulated.length,
          lineCount: accumulated ? accumulated.split('\n').length : 0,
        },
        inference: { temperature: TITLE_TEMPERATURE, maxTokens: TITLE_MAX_TOKENS },
        queue: queue.getStats(),
        host: hostResourceSnapshot(),
      });
      emit('done', {
        title,
        model,
        requestId: gatewayRequestId,
        latencyMs,
        finished: true,
      });
    } catch (error) {
      if (isInternalApiError(error)) {
        const acc = {
          bytes: accumulated.length,
          lineCount: accumulated ? accumulated.split('\n').length : 0,
        };
        const payload = {
          requestId: gatewayRequestId,
          error: error.message,
          code: error.code,
        };
        if (error.details && typeof error.details === 'object') {
          payload.details = error.details;
        }
        logTitle('error', {
          phase: 'validate_output',
          requestId: gatewayRequestId,
          model,
          ...modelDebugFields(model),
          code: error.code,
          message: error.message,
          details: error.details,
          acc,
          originalSourceChars: normalized.originalSourceChars,
          digestChars: normalized.digestChars,
          sourceTextChars: normalized.text.length,
          promptChars: systemPrompt.length + userContent.length,
          inference: { temperature: TITLE_TEMPERATURE, maxTokens: TITLE_MAX_TOKENS },
          queue: queue.getStats(),
          host: hostResourceSnapshot(),
          tracking: { feature: 'title_from_text', outcome: 'validate_error', errorCode: error.code },
          debugHint:
            error.code === 'INVALID_TITLE_OUTPUT' && (error.details && error.details.reason) === 'RAW_EMPTY'
              ? '누적 0바이트: llama·샘플링·슬롯·동시 title 요청과 queue/host 로그를 함께 본다'
              : undefined,
        });
        emit('error', payload);
      } else {
        const err = String(error);
        logTitle('error', { phase: 'validate_unexpected', requestId: gatewayRequestId, model, err });
        emit('error', { requestId: gatewayRequestId, error: err, code: 'VALIDATE_THROW' });
      }
    }
  }

  response.end();
}
