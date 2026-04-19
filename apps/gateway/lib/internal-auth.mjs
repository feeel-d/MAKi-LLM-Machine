import { InternalApiError } from './internal-errors.mjs';

export function getRequestId(request) {
  const header = request.headers['x-request-id'];
  if (typeof header === 'string' && header.trim().length > 0) {
    return header.trim();
  }

  return crypto.randomUUID();
}

export function assertServiceKey(request, config) {
  if (!config.serviceApiKey || config.serviceApiKey.trim().length === 0) {
    throw new InternalApiError(503, 'Service API key is not configured.', 'SERVICE_KEY_NOT_CONFIGURED');
  }

  const keyHeader = request.headers['x-service-key'];
  const requestKey = typeof keyHeader === 'string' ? keyHeader.trim() : '';

  if (!requestKey || requestKey !== config.serviceApiKey) {
    throw new InternalApiError(401, 'Invalid service key.', 'INVALID_SERVICE_KEY');
  }
}

