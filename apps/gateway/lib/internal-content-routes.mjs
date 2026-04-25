import { createContentGenerationService } from './content-generation.mjs';
import { readJsonBody, sendJson } from './http.mjs';
import { getRequestId, assertServiceKey } from './internal-auth.mjs';
import { InternalApiError, isInternalApiError } from './internal-errors.mjs';

const ROUTE_HANDLERS = {
  '/internal/v1/content/title-from-image': 'titleFromImage',
  '/internal/v1/content/body-from-image': 'bodyFromImage',
  '/internal/v1/content/proofread-from-text': 'proofreadFromText',
  '/internal/v1/content/todos-from-text': 'todosFromText',
  '/internal/v1/content/embed-from-text': 'embedFromText',
};

export function createInternalContentRouter({ config, queue }) {
  const service = createContentGenerationService();

  return async function handleInternalContentRoute(request, response, pathname) {
    const methodName = ROUTE_HANDLERS[pathname];
    if (request.method !== 'POST' || !methodName) {
      return false;
    }

    const requestId = getRequestId(request);
    response.setHeader('X-Request-Id', requestId);
    const startedAt = Date.now();

    try {
      assertServiceKey(request, config);
      const body = await readJsonBody(request, config.maxBodyBytes);

      const result = await queue.enqueue(1, async () =>
        service[methodName]({
          config,
          requestId,
          input: body,
        }),
      );

      sendJson(response, 200, {
        ...result,
        requestId,
        latencyMs: Date.now() - startedAt,
      });
      return true;
    } catch (error) {
      const mapped = mapInternalError(error);
      sendJson(response, mapped.statusCode, {
        error: mapped.message,
        code: mapped.code,
        requestId,
      });
      return true;
    }
  };
}

function mapInternalError(error) {
  if (isInternalApiError(error)) {
    return error;
  }

  if (error instanceof Error) {
    if (error.message === 'Invalid JSON body.') {
      return new InternalApiError(400, 'Invalid JSON body.', 'INVALID_JSON_BODY');
    }

    if (error.message === 'Request body is too large.') {
      return new InternalApiError(413, 'Request body is too large.', 'REQUEST_BODY_TOO_LARGE');
    }

    if (error.message === 'Queue is full.' || error.message === 'Requested capacity exceeds queue limit.') {
      return new InternalApiError(503, 'Gateway queue is full.', 'QUEUE_FULL');
    }

    const lower = error.message.toLowerCase();
    if (lower.includes('timeout')) {
      return new InternalApiError(504, 'LLM request timeout.', 'LLM_TIMEOUT');
    }

    if (lower.includes('json')) {
      return new InternalApiError(422, error.message, 'INVALID_MODEL_OUTPUT');
    }

    if (
      lower.includes('model') &&
      (lower.includes('unavailable') || lower.includes('lookup failed'))
    ) {
      return new InternalApiError(503, error.message, 'MODEL_UNAVAILABLE');
    }

    if (
      lower.includes('router') ||
      lower.includes('라우터') ||
      lower.includes('econnrefused') ||
      lower.includes('failed to fetch')
    ) {
      return new InternalApiError(503, error.message, 'UPSTREAM_UNAVAILABLE');
    }

    return new InternalApiError(500, error.message, 'INTERNAL_ERROR');
  }

  return new InternalApiError(500, 'Internal server error.', 'INTERNAL_ERROR');
}
