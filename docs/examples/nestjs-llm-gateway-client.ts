/* eslint-disable max-classes-per-file */
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

type Language = 'auto' | 'ko' | 'en';
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
    /** 8~200, 기본 게이트웨이 100 */
    maxLength?: number;
    inputMode?: 'full' | 'digest';
    bodyDigestMaxChars?: number;
  }): Promise<{
    title: string;
    model?: string;
    requestId?: string;
    latencyMs?: number;
  }> {
    return this.readTitleFromTextSseResponse(input);
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

  async proofreadFromText(input: {
    text: string;
    language?: 'auto' | Language;
    preserveLanguage?: boolean;
  }) {
    return this.post('/internal/v1/content/proofread-from-text', input);
  }

  private async readTitleFromTextSseResponse(payload: unknown) {
    const requestId = crypto.randomUUID();
    const response = await fetch(`${this.baseUrl}/internal/v1/content/title-from-text/stream`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Service-Key': this.serviceKey,
        'X-Request-Id': requestId,
      },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      const body = await safeJson(response);
      throw new LlmGatewayError(
        response.status,
        mapGatewayErrorCode(response.status),
        body?.error ?? 'Gateway request failed.',
        body?.requestId ?? requestId,
      );
    }

    const ct = response.headers.get('content-type') ?? '';
    if (!ct.includes('text/event-stream')) {
      const body = (await response.json()) as { title?: string; model?: string; requestId?: string; latencyMs?: number };
      if (typeof body?.title === 'string') {
        return body;
      }
      throw new LlmGatewayError(502, 'INTERNAL_ERROR', 'Invalid gateway response (expected SSE or JSON with title).');
    }

    const title = await parseTitleFromTextSse(response);
    if (!title) {
      throw new LlmGatewayError(502, 'INTERNAL_ERROR', 'Stream ended without title.');
    }
    return title;
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

type TitleFromTextDone = {
  title: string;
  model?: string;
  requestId?: string;
  latencyMs?: number;
};

async function parseTitleFromTextSse(response: Response): Promise<TitleFromTextDone | null> {
  const reader = response.body?.getReader();
  if (!reader) {
    return null;
  }
  const decoder = new TextDecoder();
  let buffer = '';
  let lastDone: TitleFromTextDone | null = null;
  let errMsg: string | undefined;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    buffer += decoder.decode(value, { stream: true });
    for (;;) {
      const sep = buffer.indexOf('\n\n');
      if (sep === -1) {
        break;
      }
      const segment = buffer.slice(0, sep);
      buffer = buffer.slice(sep + 2);
      let eventName = '';
      const dataLines: string[] = [];
      for (const line of segment.split('\n')) {
        if (line.startsWith('event:')) {
          eventName = line.slice(6).trim();
        } else if (line.startsWith('data:')) {
          dataLines.push(line.slice(5).trimStart());
        }
      }
      const dataStr = dataLines.join('\n');
      if (!dataStr) {
        continue;
      }
      try {
        const data = JSON.parse(dataStr) as Record<string, unknown>;
        if (eventName === 'done' && typeof data.title === 'string') {
          lastDone = {
            title: data.title,
            model: typeof data.model === 'string' ? data.model : undefined,
            requestId: typeof data.requestId === 'string' ? data.requestId : undefined,
            latencyMs: typeof data.latencyMs === 'number' && Number.isFinite(data.latencyMs) ? data.latencyMs : undefined,
          };
        }
        if (eventName === 'error' && data.error) {
          errMsg = typeof data.error === 'string' ? data.error : JSON.stringify(data);
        }
      } catch {
        // ignore
      }
    }
  }
  if (errMsg) {
    throw new LlmGatewayError(400, 'UNPROCESSABLE', errMsg);
  }
  return lastDone;
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
