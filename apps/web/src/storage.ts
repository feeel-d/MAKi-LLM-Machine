import type { Conversation, ModelKind } from './types';

const STORAGE_KEYS = {
  conversations: 'maki.conversations',
  selectedConversationId: 'maki.selectedConversationId',
  selectedModel: 'maki.selectedModel',
  systemPrompt: 'maki.systemPrompt',
  apiBaseUrl: 'maki.apiBaseUrl',
};

export function loadConversations() {
  try {
    const raw = localStorage.getItem(STORAGE_KEYS.conversations);
    if (!raw) {
      return [];
    }

    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as Conversation[]) : [];
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
  return raw === 'deepseek' || raw === 'qwen' || raw === 'all' ? raw : 'deepseek';
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
