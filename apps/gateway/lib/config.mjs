function readNumber(name, fallback) {
  const raw = process.env[name];
  if (!raw) {
    return fallback;
  }

  const value = Number(raw);
  return Number.isFinite(value) ? value : fallback;
}

export function loadConfig() {
  const allowedOrigins = new Set(
    (process.env.ALLOWED_ORIGINS ?? 'https://feeel-d.github.io,http://localhost:5173,http://127.0.0.1:5173')
      .split(',')
      .map((origin) => origin.trim())
      .filter(Boolean),
  );

  const allowedImageMime = new Set(
    (process.env.ALLOWED_IMAGE_MIME ?? 'image/jpeg,image/png,image/webp,image/gif')
      .split(',')
      .map((mime) => mime.trim().toLowerCase())
      .filter(Boolean),
  );

  return {
    host: process.env.GATEWAY_HOST ?? '127.0.0.1',
    port: readNumber('GATEWAY_PORT', 3001),
    llamaServerUrl: process.env.LLAMA_SERVER_URL ?? 'http://127.0.0.1:8081',
    llamaApiKey: process.env.LLAMA_API_KEY ?? '',
    allowedOrigins,
    rateLimitBurst: readNumber('RATE_LIMIT_BURST', 4),
    rateLimitBurstWindowMs: readNumber('RATE_LIMIT_BURST_WINDOW_MS', 10_000),
    rateLimitMinute: readNumber('RATE_LIMIT_MINUTE', 12),
    queueCapacity: readNumber('QUEUE_CAPACITY', 2),
    queueMaxPending: readNumber('QUEUE_MAX_PENDING', 8),
    requestTimeoutMs: readNumber('REQUEST_TIMEOUT_MS', 180_000),
    maxBodyBytes: readNumber('MAX_BODY_BYTES', 65_536),
    serviceApiKey: process.env.SERVICE_API_KEY ?? '',
    contentRetryCount: readNumber('CONTENT_RETRY_COUNT', 1),
    imageFetchTimeoutMs: readNumber('IMAGE_FETCH_TIMEOUT_MS', 15_000),
    maxImageBytes: readNumber('MAX_IMAGE_BYTES', 8 * 1024 * 1024),
    allowedImageMime,
  };
}
