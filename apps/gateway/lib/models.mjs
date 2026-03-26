export const MODEL_IDS = ['deepseek', 'qwen'];

export function normalizeModel(value) {
  if (value === 'deepseek' || value === 'qwen' || value === 'all') {
    return value;
  }

  return null;
}

export function resolveTargetModels(model) {
  if (model === 'all') {
    return MODEL_IDS;
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
