export class InternalApiError extends Error {
  constructor(statusCode, message, code) {
    super(message);
    this.name = 'InternalApiError';
    this.statusCode = statusCode;
    this.code = code ?? 'INTERNAL_API_ERROR';
  }
}

export function isInternalApiError(error) {
  return error instanceof InternalApiError;
}

