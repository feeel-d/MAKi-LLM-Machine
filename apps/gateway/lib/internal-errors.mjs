export class InternalApiError extends Error {
  /** @param {Record<string, unknown> | undefined} [details] — 클라이언트/로그용 세부(원문·개인정보는 넣지 말 것) */
  constructor(statusCode, message, code, details) {
    super(message);
    this.name = 'InternalApiError';
    this.statusCode = statusCode;
    this.code = code ?? 'INTERNAL_API_ERROR';
    this.details = details;
  }
}

export function isInternalApiError(error) {
  return error instanceof InternalApiError;
}

