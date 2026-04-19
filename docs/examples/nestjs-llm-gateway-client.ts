/* eslint-disable max-classes-per-file */
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

type Language = 'ko' | 'en';
type TitleStyle = 'neutral' | 'marketing' | 'news';
type BodyLength = 'short' | 'medium' | 'long';

type GatewayErrorCode =
  | 'INVALID_INPUT'
  | 'UNAUTHORIZED'
  | 'TOO_LARGE'
  | 'UNPROCESSABLE'
  | 'UPSTREAM_UNAVAILABLE'
  | 'TIMEOUT'
  | 'INTERNAL_ERROR';

export class LlmGatewayError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly code: GatewayErrorCode,
    message: string,
    public readonly requestId?: string,
  ) {
    super(message);
    this.name = 'LlmGatewayError';
  }
}

@Injectable()
export class LlmGatewayClient {
  private readonly baseUrl: string;
  private readonly serviceKey: string;

  constructor(private readonly config: ConfigService) {
    this.baseUrl = String(this.config.get<string>('LLM_GATEWAY_BASE_URL') ?? '').replace(/\/$/, '');
    this.serviceKey = String(this.config.get<string>('LLM_GATEWAY_SERVICE_KEY') ?? '');
  }

  async createTitleFromText(input: {
    text: string;
    language?: Language;
    style?: TitleStyle;
    maxLength?: number;
  }) {
    return this.post('/internal/v1/content/title-from-text', input);
  }

  async createTitleFromImage(input: {
    imageUrl: string;
    contextText?: string;
    language?: Language;
    style?: TitleStyle;
    maxLength?: number;
  }) {
    return this.post('/internal/v1/content/title-from-image', input);
  }

  async createBodyFromImage(input: {
    imageUrl: string;
    titleHint?: string;
    language?: Language;
    tone?: string;
    length?: BodyLength;
  }) {
    return this.post('/internal/v1/content/body-from-image', input);
  }

  private async post(path: string, payload: unknown) {
    const requestId = crypto.randomUUID();
    const response = await fetch(`${this.baseUrl}${path}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Service-Key': this.serviceKey,
        'X-Request-Id': requestId,
      },
      body: JSON.stringify(payload),
    });

    const body = await safeJson(response);
    if (!response.ok) {
      throw new LlmGatewayError(
        response.status,
        mapGatewayErrorCode(response.status),
        body?.error ?? 'Gateway request failed.',
        body?.requestId ?? requestId,
      );
    }

    return body;
  }
}

function mapGatewayErrorCode(statusCode: number): GatewayErrorCode {
  if (statusCode === 400) return 'INVALID_INPUT';
  if (statusCode === 401) return 'UNAUTHORIZED';
  if (statusCode === 413) return 'TOO_LARGE';
  if (statusCode === 422) return 'UNPROCESSABLE';
  if (statusCode === 503) return 'UPSTREAM_UNAVAILABLE';
  if (statusCode === 504) return 'TIMEOUT';
  return 'INTERNAL_ERROR';
}

async function safeJson(response: Response) {
  const text = await response.text();
  if (!text) {
    return null;
  }

  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

