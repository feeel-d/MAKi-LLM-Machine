import http from 'node:http';
import { CapacityQueue } from './lib/capacity-queue.mjs';
import { loadConfig } from './lib/config.mjs';
import { readJsonBody, getClientIp, sendJson, setCorsHeaders } from './lib/http.mjs';
import { fetchRouterModels, streamChatCompletion } from './lib/llama-client.mjs';
import { MODEL_IDS, normalizeModel, resolveTargetModels } from './lib/models.mjs';
import { RateLimiter } from './lib/rate-limiter.mjs';
import { sendEvent, writeSseHeaders } from './lib/sse.mjs';

const config = loadConfig();
const rateLimiter = new RateLimiter({
  burstLimit: config.rateLimitBurst,
  burstWindowMs: config.rateLimitBurstWindowMs,
  minuteLimit: config.rateLimitMinute,
});
const queue = new CapacityQueue({
  capacity: config.queueCapacity,
  maxPending: config.queueMaxPending,
});

const server = http.createServer(async (request, response) => {
  setCorsHeaders(request, response, config.allowedOrigins);

  if (request.method === 'OPTIONS') {
    response.writeHead(200);
    response.end();
    return;
  }

  const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`);

  try {
    if (request.method === 'GET' && url.pathname === '/api/health') {
      await handleHealth(response);
      return;
    }

    if (request.method === 'GET' && url.pathname === '/api/models') {
      await handleModels(response);
      return;
    }

    if (request.method === 'POST' && url.pathname === '/api/chat/stream') {
      await handleChatStream(request, response);
      return;
    }

    sendJson(response, 404, { error: 'Not found' });
  } catch (error) {
    console.error(error);

    if (!response.headersSent) {
      sendJson(response, 500, { error: 'Internal server error' });
      return;
    }

    if (!response.writableEnded) {
      sendEvent(response, 'error', { error: 'Internal server error' });
      response.end();
    }
  }
});

server.listen(config.port, config.host, () => {
  console.log(`Gateway listening on http://${config.host}:${config.port}`);
});

async function handleHealth(response) {
  try {
    const models = await fetchRouterModels(config);
    const visibleModels = models
      .map((entry) => entry.id)
      .filter((id) => MODEL_IDS.includes(id));
    sendJson(response, 200, {
      status: 'ok',
      upstream: 'reachable',
      models: visibleModels,
    });
  } catch (error) {
    sendJson(response, 503, {
      status: 'degraded',
      error: error instanceof Error ? error.message : 'Upstream unavailable',
    });
  }
}

async function handleModels(response) {
  try {
    const models = await fetchRouterModels(config);
    const available = new Set(models.map((entry) => entry.id));

    sendJson(response, 200, {
      data: [
        { id: 'deepseek', label: 'DeepSeek', available: available.has('deepseek') },
        { id: 'qwen', label: 'Qwen', available: available.has('qwen') },
        {
          id: 'all',
          label: 'All',
          available: available.has('deepseek') && available.has('qwen'),
        },
      ],
    });
  } catch (error) {
    sendJson(response, 503, {
      error: error instanceof Error ? error.message : 'Failed to fetch models',
    });
  }
}

async function handleChatStream(request, response) {
  const body = await readJsonBody(request, config.maxBodyBytes);
  const model = normalizeModel(body.model);
  if (!model) {
    sendJson(response, 400, { error: 'Invalid model.' });
    return;
  }

  if (!Array.isArray(body.messages) || body.messages.length === 0) {
    sendJson(response, 400, { error: 'messages is required.' });
    return;
  }

  const clientIp = getClientIp(request);
  const cost = model === 'all' ? 2 : 1;

  if (!rateLimiter.allow(clientIp, cost)) {
    sendJson(response, 429, { error: 'Rate limit exceeded.' });
    return;
  }

  writeSseHeaders(response);
  const requestId = crypto.randomUUID();
  const emit = (event, payload) => {
    if (!response.writableEnded && !response.destroyed) {
      sendEvent(response, event, payload);
    }
  };

  emit('meta', { requestId, model });

  const abortController = new AbortController();
  const closeHandler = () => abortController.abort('client_closed');
  request.on('close', closeHandler);

  try {
    await queue.enqueue(cost, async () => {
      const targetModels = resolveTargetModels(model);
      let completed = 0;

      await Promise.all(
        targetModels.map((targetModel) =>
          streamChatCompletion({
            config,
            model: targetModel,
            messages:
              model === 'all' && body.messagesByModel?.[targetModel]
                ? body.messagesByModel[targetModel]
                : body.messages,
            systemPrompt: body.systemPrompt,
            temperature: body.temperature,
            maxTokens: body.maxTokens,
            signal: abortController.signal,
            onMeta: (payload) => emit('meta', payload),
            onToken: (payload) => emit('token', payload),
            onDone: (payload) => {
              completed += 1;
              emit('done', payload);
              if (completed === targetModels.length) {
                emit('done', { requestId, model: 'all', finished: true });
              }
            },
            onError: (payload) => emit('error', payload),
          }),
        ),
      );
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Queue unavailable.';
    emit('error', { requestId, model, error: message });
  } finally {
    request.off('close', closeHandler);
    response.end();
  }
}
