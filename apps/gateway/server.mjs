import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { CapacityQueue } from './lib/capacity-queue.mjs';
import { loadConfig } from './lib/config.mjs';
import { readJsonBody, getClientIp, sendJson, setCorsHeaders } from './lib/http.mjs';
import { fetchRouterModels, streamChatCompletion } from './lib/llama-client.mjs';
import { ROUTER_MODEL_IDS, normalizeModel, resolveTargetModels } from './lib/models.mjs';
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
const repoRoot = process.cwd();
const webBasePath = '/MAKi-LLM-Machine';
const webDistPath = path.join(repoRoot, 'apps', 'web', 'dist');

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

    if (request.method === 'GET') {
      const served = await tryServeWebApp(url.pathname, response);
      if (served) {
        return;
      }
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
      .filter((id) => ROUTER_MODEL_IDS.includes(id));
    sendJson(response, 200, {
      status: 'ok',
      upstream: 'reachable',
      models: visibleModels,
    });
  } catch (error) {
    // GitHub Pages 등 프론트는 fetch().ok 가 false(503)이면 “연결 실패”로만 보인다.
    // 게이트웨이(Funnel)는 살아 있고 로컬 라우터만 죽은 경우도 200 + status 로 구분한다.
    sendJson(response, 200, {
      status: 'degraded',
      upstream: 'unreachable',
      error: error instanceof Error ? error.message : 'Upstream unavailable',
      models: [],
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
        { id: 'gemma26', label: 'Gemma 4 26B', available: available.has('gemma26') },
        { id: 'gemmae4', label: 'Gemma 4 E4B', available: available.has('gemmae4') },
        {
          id: 'gemma_all',
          label: 'Gemma All',
          available: available.has('gemma26') && available.has('gemmae4'),
        },
      ],
    });
  } catch (error) {
    sendJson(response, 200, {
      data: [
        { id: 'deepseek', label: 'DeepSeek', available: false },
        { id: 'qwen', label: 'Qwen', available: false },
        { id: 'all', label: 'All', available: false },
        { id: 'gemma26', label: 'Gemma 4 26B', available: false },
        { id: 'gemmae4', label: 'Gemma 4 E4B', available: false },
        { id: 'gemma_all', label: 'Gemma All', available: false },
      ],
      error: error instanceof Error ? error.message : 'Failed to fetch models',
    });
  }
}

async function handleChatStream(request, response) {
  const body = await readJsonBody(request, config.maxBodyBytes);
  const rawModel =
    body.model === undefined || body.model === null || body.model === ''
      ? 'gemmae4'
      : body.model;
  const model = normalizeModel(rawModel);
  if (!model) {
    sendJson(response, 400, { error: 'Invalid model.' });
    return;
  }

  if (!Array.isArray(body.messages) || body.messages.length === 0) {
    sendJson(response, 400, { error: 'messages is required.' });
    return;
  }

  const clientIp = getClientIp(request);
  const cost = model === 'all' || model === 'gemma_all' ? 2 : 1;

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
              (model === 'all' || model === 'gemma_all') && body.messagesByModel?.[targetModel]
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
                emit('done', { requestId, model, finished: true });
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

async function tryServeWebApp(pathname, response) {
  if (!(pathname === webBasePath || pathname === `${webBasePath}/` || pathname.startsWith(`${webBasePath}/`))) {
    return false;
  }

  const relativePath = pathname.slice(webBasePath.length).replace(/^\/+/, '');
  const safePath = relativePath.replace(/\.\./g, '');
  const targetPath = safePath.length > 0 ? path.join(webDistPath, safePath) : path.join(webDistPath, 'index.html');

  try {
    const targetStat = await stat(targetPath);

    if (targetStat.isDirectory()) {
      const indexFile = path.join(targetPath, 'index.html');
      await sendFile(indexFile, response);
      return true;
    }

    await sendFile(targetPath, response);
    return true;
  } catch {
    const fallbackPath = path.join(webDistPath, 'index.html');
    try {
      await sendFile(fallbackPath, response);
      return true;
    } catch {
      return false;
    }
  }
}

async function sendFile(filePath, response) {
  const content = await readFile(filePath);
  response.writeHead(200, {
    'Content-Type': contentTypeFor(filePath),
    'Cache-Control': filePath.endsWith('.html') ? 'no-cache' : 'public, max-age=600',
  });
  response.end(content);
}

function contentTypeFor(filePath) {
  if (filePath.endsWith('.html')) {
    return 'text/html; charset=utf-8';
  }
  if (filePath.endsWith('.js')) {
    return 'application/javascript; charset=utf-8';
  }
  if (filePath.endsWith('.css')) {
    return 'text/css; charset=utf-8';
  }
  if (filePath.endsWith('.json')) {
    return 'application/json; charset=utf-8';
  }
  if (filePath.endsWith('.svg')) {
    return 'image/svg+xml';
  }
  if (filePath.endsWith('.png')) {
    return 'image/png';
  }
  if (filePath.endsWith('.ico')) {
    return 'image/x-icon';
  }

  return 'application/octet-stream';
}
