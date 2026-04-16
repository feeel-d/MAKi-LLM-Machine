import type { Conversation, ModelKind, ResponseModel, Turn, TurnResponse } from './types';

const STORAGE_KEYS = {
  conversations: 'maki.conversations',
  selectedConversationId: 'maki.selectedConversationId',
  selectedModel: 'maki.selectedModel',
  systemPrompt: 'maki.systemPrompt',
  apiBaseUrl: 'maki.apiBaseUrl',
};

const RESPONSE_KEYS: ResponseModel[] = ['deepseek', 'qwen', 'gemma26', 'gemmae4'];

function idleTurnResponse(): TurnResponse {
  return { text: '', status: 'idle' };
}

function normalizeTurnResponses(raw: Turn['responses'] | undefined): Turn['responses'] {
  const out = {} as Turn['responses'];
  for (const key of RESPONSE_KEYS) {
    const prev = raw?.[key];
    out[key] = prev
      ? {
          text: prev.text ?? '',
          status: prev.status ?? 'idle',
          error: prev.error,
        }
      : idleTurnResponse();
  }
  return out;
}

function migrateConversation(raw: unknown): Conversation | null {
  if (!raw || typeof raw !== 'object') {
    return null;
  }

  const c = raw as Record<string, unknown>;
  if (typeof c.id !== 'string' || typeof c.title !== 'string') {
    return null;
  }

  const turnsRaw = Array.isArray(c.turns) ? c.turns : [];
  const turns: Turn[] = turnsRaw
    .map((t) => {
      if (!t || typeof t !== 'object') {
        return null;
      }
      const tr = t as Record<string, unknown>;
      if (typeof tr.id !== 'string' || typeof tr.prompt !== 'string' || typeof tr.mode !== 'string') {
        return null;
      }
      return {
        id: tr.id,
        prompt: tr.prompt,
        mode: tr.mode as Turn['mode'],
        createdAt: typeof tr.createdAt === 'number' ? tr.createdAt : Date.now(),
        responses: normalizeTurnResponses(tr.responses as Turn['responses'] | undefined),
      };
    })
    .filter((x): x is Turn => x !== null);

  return {
    id: c.id,
    title: c.title,
    createdAt: typeof c.createdAt === 'number' ? c.createdAt : Date.now(),
    updatedAt: typeof c.updatedAt === 'number' ? c.updatedAt : Date.now(),
    turns,
  };
}

export function loadConversations() {
  try {
    const raw = localStorage.getItem(STORAGE_KEYS.conversations);
    if (!raw) {
      return [];
    }

    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      return [];
    }

    return parsed
      .map((item) => migrateConversation(item))
      .filter((c): c is Conversation => c !== null);
  } catch {
    return [];
  }
}

export function saveConversations(conversations: Conversation[]) {
  localStorage.setItem(STORAGE_KEYS.conversations, JSON.stringify(conversations));
}

export function loadSelectedConversationId() {
  return localStorage.getItem(STORAGE_KEYS.selectedConversationId);
}

export function saveSelectedConversationId(value: string | null) {
  if (value) {
    localStorage.setItem(STORAGE_KEYS.selectedConversationId, value);
    return;
  }

  localStorage.removeItem(STORAGE_KEYS.selectedConversationId);
}

export function loadSelectedModel(): ModelKind {
  const raw = localStorage.getItem(STORAGE_KEYS.selectedModel);
  if (
    raw === 'deepseek' ||
    raw === 'qwen' ||
    raw === 'all' ||
    raw === 'gemma26' ||
    raw === 'gemmae4' ||
    raw === 'gemma_all'
  ) {
    return raw;
  }
  return 'gemmae4';
}

export function saveSelectedModel(value: ModelKind) {
  localStorage.setItem(STORAGE_KEYS.selectedModel, value);
}

export function loadSystemPrompt() {
  return localStorage.getItem(STORAGE_KEYS.systemPrompt) ?? '';
}

export function saveSystemPrompt(value: string) {
  localStorage.setItem(STORAGE_KEYS.systemPrompt, value);
}

export function loadApiBaseUrl(defaultValue: string) {
  return localStorage.getItem(STORAGE_KEYS.apiBaseUrl) ?? defaultValue;
}

export function saveApiBaseUrl(value: string) {
  localStorage.setItem(STORAGE_KEYS.apiBaseUrl, value);
}
