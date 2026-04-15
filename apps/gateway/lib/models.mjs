export const ROUTER_MODEL_IDS = ['deepseek', 'qwen', 'gemma26', 'gemmae4'];

export function normalizeModel(value) {
  if (
    value === 'deepseek' ||
    value === 'qwen' ||
    value === 'all' ||
    value === 'gemma26' ||
    value === 'gemmae4' ||
    value === 'gemma_all'
  ) {
    return value;
  }

  return null;
}

export function resolveTargetModels(model) {
  if (model === 'all') {
    return ['deepseek', 'qwen'];
  }

  if (model === 'gemma_all') {
    return ['gemma26', 'gemmae4'];
  }

  return [model];
}

export function buildMessageHistory(turns, targetModel, nextPrompt) {
  const messages = [];

  for (const turn of turns) {
    if (!turn.prompt) {
      continue;
    }

    messages.push({ role: 'user', content: turn.prompt });

    const response = turn.responses?.[targetModel]?.text?.trim();
    if (response) {
      messages.push({ role: 'assistant', content: response });
    }
  }

  messages.push({ role: 'user', content: nextPrompt });
  return messages;
}
