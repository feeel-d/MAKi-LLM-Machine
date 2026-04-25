import { assertServiceKey, getRequestId } from './internal-auth.mjs';
import { InternalApiError, isInternalApiError } from './internal-errors.mjs';
import {
  buildTitleFromTextPrompt,
  CONTENT_TASK_MODELS,
  ensureModelAvailable,
  validateTitleFromTextInput,
  validateTitleOutput,
} from './content-generation.mjs';
import { fetchRouterModels, streamChatCompletion } from './llama-client.mjs';
import { getClientIp, readJsonBody, sendJson } from './http.mjs';
import { sendEvent, writeSseHeaders } from './sse.mjs';

/** @param {'info' | 'warn' | 'error'} level */
function logTitleFromTextGateway(level, payload) {
  const row = { ts: new Date().toISOString(), service: 'maki-llm-gateway', route: 'title-from-text', level, ...payload };
  const line = JSON.stringify(row);
  if (level === 'error' || level === 'warn') {
    console.error(line);
  } else {
    console.log(line);
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
    logTitleFromTextGateway('warn', { phase: 'rate_limited', requestId: gatewayRequestId, clientIp });
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

  const prompt = buildTitleFromTextPrompt(normalized);

  writeSseHeaders(response);

  const emit = (event, data) => {
    if (!response.writableEnded && !response.destroyed) {
      sendEvent(response, event, data);
    }
  };

  emit('meta', { requestId: gatewayRequestId, model });
  logTitleFromTextGateway('info', { phase: 'stream_start', requestId: gatewayRequestId, model, maxLength: normalized.maxLength });

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
        messages: [{ role: 'user', content: prompt }],
        systemPrompt: undefined,
        temperature: 0.3,
        maxTokens: 512,
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
          logTitleFromTextGateway('error', {
            phase: 'llama_stream',
            requestId: gatewayRequestId,
            model,
            upstream: payload,
          });
          emit('error', { ...payload, requestId: gatewayRequestId });
        },
      });
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Queue unavailable.';
    logTitleFromTextGateway('error', { phase: 'queue_or_stream', requestId: gatewayRequestId, model, error: message });
    emit('error', { requestId: gatewayRequestId, error: message, code: 'QUEUE_ERROR' });
    streamErrored = true;
  } finally {
    request.off('close', closeHandler);
  }

  if (!streamErrored) {
    try {
      const title = validateTitleOutput(accumulated, normalized.maxLength);
      const latencyMs = Date.now() - startedAt;
      logTitleFromTextGateway('info', {
        phase: 'done',
        requestId: gatewayRequestId,
        model,
        latencyMs,
        titleChars: title.length,
        acc: {
          bytes: accumulated.length,
          lineCount: accumulated ? accumulated.split('\n').length : 0,
        },
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
        logTitleFromTextGateway('error', {
          phase: 'validate_output',
          requestId: gatewayRequestId,
          model,
          code: error.code,
          message: error.message,
          details: error.details,
          acc,
        });
        emit('error', payload);
      } else {
        const err = String(error);
        logTitleFromTextGateway('error', { phase: 'validate_unexpected', requestId: gatewayRequestId, model, error: err });
        emit('error', { requestId: gatewayRequestId, error: err, code: 'VALIDATE_THROW' });
      }
    }
  }

  response.end();
}
