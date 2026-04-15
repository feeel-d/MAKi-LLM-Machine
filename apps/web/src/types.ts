export type ResponseModel = 'deepseek' | 'qwen' | 'gemma26' | 'gemmae4';
export type ModelKind = ResponseModel | 'all' | 'gemma_all';
export type ResponseStatus = 'idle' | 'streaming' | 'done' | 'error';
export type HealthStatus = 'unknown' | 'connected' | 'degraded' | 'missing';

export type ChatMessage = {
  role: 'user' | 'assistant' | 'system';
  content: string;
};

export type TurnResponse = {
  text: string;
  status: ResponseStatus;
  error?: string;
};

export type Turn = {
  id: string;
  prompt: string;
  mode: ModelKind;
  createdAt: number;
  responses: Record<ResponseModel, TurnResponse>;
};

export type Conversation = {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  turns: Turn[];
};

export type ModelInfo = {
  id: ModelKind;
  label: string;
  available: boolean;
};

export type StreamPayload = {
  requestId?: string;
  model: ModelKind | ResponseModel;
  text?: string;
  error?: string;
  finished?: boolean;
};
