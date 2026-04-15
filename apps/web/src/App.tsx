import {
  startTransition,
  useEffect,
  useEffectEvent,
  useRef,
  useState,
} from 'react';
import { consumeEventStream } from './sse';
import {
  loadApiBaseUrl,
  loadConversations,
  loadSelectedConversationId,
  loadSelectedModel,
  loadSystemPrompt,
  saveApiBaseUrl,
  saveConversations,
  saveSelectedConversationId,
  saveSelectedModel,
  saveSystemPrompt,
} from './storage';
import type {
  ChatMessage,
  Conversation,
  HealthStatus,
  ModelInfo,
  ModelKind,
  ResponseModel,
  ResponseStatus,
  StreamPayload,
  Turn,
} from './types';

function normalizeApiBaseUrl(value: string): string {
  return value.trim().replace(/\/$/, '');
}

const DEFAULT_API_BASE_URL = normalizeApiBaseUrl(import.meta.env.VITE_API_BASE_URL ?? '');

const MODEL_LABELS: Record<ModelKind, string> = {
  deepseek: 'DeepSeek',
  qwen: 'Qwen',
  all: 'All',
  gemma26: 'Gemma 4 26B',
  gemmae4: 'Gemma 4 E4B',
  gemma_all: 'Gemma All',
};

const RESPONSE_MODELS: ResponseModel[] = ['deepseek', 'qwen', 'gemma26', 'gemmae4'];

const COMPARE_DEEPSEEK_QWEN: ResponseModel[] = ['deepseek', 'qwen'];
const COMPARE_GEMMA: ResponseModel[] = ['gemma26', 'gemmae4'];

const MODEL_GROUP_DEEPSEEK_QWEN: ModelKind[] = ['deepseek', 'qwen', 'all'];
const MODEL_GROUP_GEMMA: ModelKind[] = ['gemma26', 'gemmae4', 'gemma_all'];

const DEFAULT_MODELS: ModelInfo[] = [
  { id: 'deepseek', label: 'DeepSeek', available: true },
  { id: 'qwen', label: 'Qwen', available: true },
  { id: 'all', label: 'All', available: true },
  { id: 'gemma26', label: 'Gemma 4 26B', available: true },
  { id: 'gemmae4', label: 'Gemma 4 E4B', available: true },
  { id: 'gemma_all', label: 'Gemma All', available: true },
];

function modelsForGroup(allModels: ModelInfo[], group: ModelKind[]) {
  return group
    .map((id) => allModels.find((m) => m.id === id))
    .filter((m): m is ModelInfo => Boolean(m));
}

function temperatureForMode(mode: ModelKind) {
  if (mode === 'qwen' || mode === 'gemma26' || mode === 'gemmae4' || mode === 'gemma_all') {
    return 0.7;
  }
  return 0.6;
}

function primaryResponseModel(mode: ModelKind): ResponseModel {
  if (mode === 'all') {
    return 'deepseek';
  }
  if (mode === 'gemma_all') {
    return 'gemma26';
  }
  return mode;
}

export default function App() {
  const [conversations, setConversations] = useState<Conversation[]>(() => loadConversations());
  const [selectedConversationId, setSelectedConversationId] = useState<string | null>(() => loadSelectedConversationId());
  const [selectedModel, setSelectedModel] = useState<ModelKind>(() => loadSelectedModel());
  const [draft, setDraft] = useState('');
  const [systemPrompt, setSystemPrompt] = useState(() => loadSystemPrompt());
  const [apiBaseUrl, setApiBaseUrl] = useState(() => normalizeApiBaseUrl(loadApiBaseUrl(DEFAULT_API_BASE_URL)));
  const [endpointDraft, setEndpointDraft] = useState(() => normalizeApiBaseUrl(loadApiBaseUrl(DEFAULT_API_BASE_URL)));
  const [healthStatus, setHealthStatus] = useState<HealthStatus>('unknown');
  const [healthMessage, setHealthMessage] = useState('게이트웨이 상태를 확인하는 중입니다.');
  const [models, setModels] = useState<ModelInfo[]>(DEFAULT_MODELS);
  const [isStreaming, setIsStreaming] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const threadRef = useRef<HTMLElement | null>(null);
  const autoScrollRef = useRef(true);

  const selectedConversation =
    conversations.find((conversation) => conversation.id === selectedConversationId) ?? null;

  useEffect(() => {
    saveConversations(conversations);
  }, [conversations]);

  useEffect(() => {
    saveSelectedConversationId(selectedConversationId);
  }, [selectedConversationId]);

  useEffect(() => {
    saveSelectedModel(selectedModel);
  }, [selectedModel]);

  useEffect(() => {
    saveSystemPrompt(systemPrompt);
  }, [systemPrompt]);

  useEffect(() => {
    saveApiBaseUrl(apiBaseUrl);
  }, [apiBaseUrl]);

  useEffect(() => {
    if (!selectedConversationId && conversations.length > 0) {
      setSelectedConversationId(conversations[0].id);
    }
  }, [conversations, selectedConversationId]);

  useEffect(() => {
    autoScrollRef.current = true;
    requestAnimationFrame(() => {
      const thread = threadRef.current;
      if (!thread) {
        return;
      }

      thread.scrollTop = thread.scrollHeight;
    });
  }, [selectedConversationId]);

  useEffect(() => {
    if (!autoScrollRef.current) {
      return;
    }

    requestAnimationFrame(() => {
      const thread = threadRef.current;
      if (!thread) {
        return;
      }

      thread.scrollTop = thread.scrollHeight;
    });
  }, [selectedConversation?.updatedAt, isStreaming]);

  const pollGateway = useEffectEvent(async () => {
    if (!apiBaseUrl) {
      setHealthStatus('missing');
      setHealthMessage('공개 게이트웨이 URL을 입력하면 바로 연결 상태를 확인합니다.');
      return;
    }

    try {
      const [healthResponse, modelsResponse] = await Promise.all([
        fetch(`${apiBaseUrl}/api/health`),
        fetch(`${apiBaseUrl}/api/models`),
      ]);

      const healthPayload = await safeJson(healthResponse);
      const upstreamDown = healthPayload?.status === 'degraded';

      if (!healthResponse.ok && !upstreamDown) {
        throw new Error(healthPayload?.error ?? `Gateway HTTP ${healthResponse.status}`);
      }

      if (upstreamDown || (!healthResponse.ok && healthResponse.status === 503)) {
        setHealthStatus('upstream_degraded');
        setHealthMessage(
          healthPayload?.error
            ? `Funnel 연결됨 · 로컬 라우터: ${healthPayload.error}`
            : 'Funnel 연결됨 · 로컬 LLM 라우터가 응답하지 않습니다.',
        );
      } else {
        setHealthStatus('connected');
        setHealthMessage(
          healthPayload?.models?.length
            ? `연결 완료 · ${healthPayload.models.join(', ')}`
            : '연결 완료',
        );
      }

      if (modelsResponse.ok) {
        const modelsPayload = await modelsResponse.json();
        if (Array.isArray(modelsPayload?.data)) {
          setModels(modelsPayload.data);
        }
      }
    } catch (error) {
      setHealthStatus('degraded');
      setHealthMessage(error instanceof Error ? error.message : '게이트웨이에 연결할 수 없습니다.');
    }
  });

  useEffect(() => {
    pollGateway();
    const timer = window.setInterval(() => {
      pollGateway();
    }, 15_000);

    return () => window.clearInterval(timer);
  }, [apiBaseUrl, pollGateway]);

  async function handleSubmit() {
    const prompt = draft.trim();
    if (!prompt || isStreaming) {
      return;
    }

    if (!apiBaseUrl) {
      setHealthStatus('missing');
      setHealthMessage('게이트웨이 URL이 비어 있습니다.');
      return;
    }

    const nextConversationId = selectedConversation?.id ?? crypto.randomUUID();
    const nextTurnId = crypto.randomUUID();
    const priorTurns = selectedConversation?.turns ?? [];
    const title = selectedConversation?.title ?? trimTitle(prompt);
    const nextTurn = createTurn(nextTurnId, prompt, selectedModel);

    setDraft('');
    setIsStreaming(true);
    upsertConversation({
      id: nextConversationId,
      title,
      createdAt: selectedConversation?.createdAt ?? Date.now(),
      updatedAt: Date.now(),
      turns: [...priorTurns, nextTurn],
    });
    setSelectedConversationId(nextConversationId);

    const controller = new AbortController();
    abortRef.current = controller;

    try {
      const primaryModel = primaryResponseModel(selectedModel);
      const response = await fetch(`${apiBaseUrl}/api/chat/stream`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: selectedModel,
          messages: buildMessageHistory(priorTurns, primaryModel, prompt),
          messagesByModel:
            selectedModel === 'all'
              ? {
                  deepseek: buildMessageHistory(priorTurns, 'deepseek', prompt),
                  qwen: buildMessageHistory(priorTurns, 'qwen', prompt),
                }
              : selectedModel === 'gemma_all'
                ? {
                    gemma26: buildMessageHistory(priorTurns, 'gemma26', prompt),
                    gemmae4: buildMessageHistory(priorTurns, 'gemmae4', prompt),
                  }
                : undefined,
          maxTokens: 768,
          temperature: temperatureForMode(selectedModel),
          systemPrompt: systemPrompt.trim() || undefined,
        }),
        signal: controller.signal,
      });

      if (!response.ok) {
        const payload = await safeJson(response);
        throw new Error(payload?.error ?? `Request failed with status ${response.status}`);
      }

      await consumeEventStream(response, {
        onEvent: (event, payload) => {
          handleStreamEvent(nextConversationId, nextTurnId, event, payload);
        },
      });
    } catch (error) {
      const message =
        error instanceof Error
          ? error.name === 'AbortError'
            ? '중단됨'
            : formatBrowserFetchError(error.message)
          : '요청 처리 중 오류가 발생했습니다.';
      markStreamingAs(nextConversationId, nextTurnId, 'error', message);
    } finally {
      abortRef.current = null;
      setIsStreaming(false);
    }
  }

  function handleStop() {
    abortRef.current?.abort();
  }

  function handleStreamEvent(
    conversationId: string,
    turnId: string,
    event: string,
    payload: StreamPayload,
  ) {
    if (
      payload.model !== 'deepseek' &&
      payload.model !== 'qwen' &&
      payload.model !== 'gemma26' &&
      payload.model !== 'gemmae4'
    ) {
      return;
    }

    if (event === 'token' && payload.text) {
      appendResponse(conversationId, turnId, payload.model, payload.text);
      return;
    }

    if (event === 'done') {
      setResponseStatus(conversationId, turnId, payload.model, 'done');
      return;
    }

    if (event === 'error') {
      setResponseStatus(conversationId, turnId, payload.model, 'error', payload.error ?? '스트림 오류');
    }
  }

  function handleNewConversation() {
    const conversation = {
      id: crypto.randomUUID(),
      title: '새 대화',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      turns: [],
    };

    startTransition(() => {
      setConversations((current) => [conversation, ...current]);
      setSelectedConversationId(conversation.id);
    });
  }

  function handleDeleteConversation(id: string) {
    startTransition(() => {
      setConversations((current) => {
        const remaining = current.filter((conversation) => conversation.id !== id);
        if (selectedConversationId === id) {
          setSelectedConversationId(remaining[0]?.id ?? null);
        }
        return remaining;
      });
    });
  }

  function handleApplyEndpoint() {
    setApiBaseUrl(normalizeApiBaseUrl(endpointDraft));
    setEndpointDraft((current) => normalizeApiBaseUrl(current));
  }

  function handleThreadScroll() {
    const thread = threadRef.current;
    if (!thread) {
      return;
    }

    const distanceFromBottom = thread.scrollHeight - thread.scrollTop - thread.clientHeight;
    autoScrollRef.current = distanceFromBottom < 96;
  }

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="sidebar__header">
          <div>
            <p className="eyebrow">MAKi LLM Machine</p>
            <h1>Public LLM Console</h1>
          </div>
          <button className="ghost-button" onClick={handleNewConversation} type="button">
            New Chat
          </button>
        </div>

        <div className="status-card">
          <span className={`status-dot status-dot--${healthStatus}`} />
          <div>
            <strong>{healthLabel(healthStatus)}</strong>
            <p>{healthMessage}</p>
          </div>
        </div>

        <label className="field-label">
          Gateway URL
          <div className="endpoint-row">
            <input
              className="endpoint-input"
              value={endpointDraft}
              onChange={(event) => setEndpointDraft(event.target.value)}
              placeholder="https://your-funnel-url.ts.net"
            />
            <button className="ghost-button" onClick={handleApplyEndpoint} type="button">
              Apply
            </button>
          </div>
        </label>

        <div className="conversation-list">
          {conversations.length === 0 ? (
            <p className="sidebar__empty">첫 질문을 보내면 대화가 여기에 저장됩니다.</p>
          ) : (
            conversations.map((conversation) => (
              <div
                key={conversation.id}
                className={`conversation-item ${conversation.id === selectedConversationId ? 'is-active' : ''}`}
              >
                <button
                  className="conversation-item__button"
                  onClick={() => setSelectedConversationId(conversation.id)}
                  type="button"
                >
                  <span>{conversation.title}</span>
                  <small>{formatTimestamp(conversation.updatedAt)}</small>
                </button>
                <button
                  className="conversation-item__delete"
                  onClick={() => handleDeleteConversation(conversation.id)}
                  type="button"
                >
                  x
                </button>
              </div>
            ))
          )}
        </div>
      </aside>

      <main className="workspace">
        <header className="workspace__header">
          <div>
            <p className="eyebrow">Live Compare</p>
            <h2>{selectedConversation?.title ?? '새 대화'}</h2>
          </div>

          <div className="model-switcher">
            <div className="model-switcher__row">
              {modelsForGroup(models, MODEL_GROUP_DEEPSEEK_QWEN).map((model) => (
                <button
                  key={model.id}
                  type="button"
                  disabled={!model.available || isStreaming}
                  className={`model-pill ${selectedModel === model.id ? 'is-active' : ''}`}
                  onClick={() => setSelectedModel(model.id)}
                >
                  {model.label}
                </button>
              ))}
            </div>
            <div className="model-switcher__row">
              {modelsForGroup(models, MODEL_GROUP_GEMMA).map((model) => (
                <button
                  key={model.id}
                  type="button"
                  disabled={!model.available || isStreaming}
                  className={`model-pill ${selectedModel === model.id ? 'is-active' : ''}`}
                  onClick={() => setSelectedModel(model.id)}
                >
                  {model.label}
                </button>
              ))}
            </div>
          </div>
        </header>

        <section className="system-panel">
          <label className="field-label field-label--stacked">
            System Prompt
            <textarea
              value={systemPrompt}
              onChange={(event) => setSystemPrompt(event.target.value)}
              placeholder="선택 사항입니다. 전체 대화 톤이나 역할을 지정할 수 있습니다."
              rows={3}
            />
          </label>
        </section>

        <section className="chat-thread" onScroll={handleThreadScroll} ref={threadRef}>
          {selectedConversation?.turns.length ? (
            selectedConversation.turns.map((turn) => (
              <article key={turn.id} className="turn">
                <div className="bubble bubble--user">
                  <span className="bubble__label">You</span>
                  <p>{turn.prompt}</p>
                </div>

                {turn.mode === 'all' ? (
                  <div className="compare-grid">
                    {COMPARE_DEEPSEEK_QWEN.map((model) => (
                      <ResponseCard key={model} model={model} response={turn.responses[model]} />
                    ))}
                  </div>
                ) : turn.mode === 'gemma_all' ? (
                  <div className="compare-grid">
                    {COMPARE_GEMMA.map((model) => (
                      <ResponseCard key={model} model={model} response={turn.responses[model]} />
                    ))}
                  </div>
                ) : (
                  <div className="single-response">
                    <ResponseCard
                      model={turn.mode}
                      response={turn.responses[turn.mode]}
                    />
                  </div>
                )}
              </article>
            ))
          ) : (
            <div className="empty-state">
              <p className="eyebrow">Ready</p>
              <h3>DeepSeek·Qwen·Gemma를 한 화면에서 단일 또는 듀얼 비교로 테스트할 수 있습니다.</h3>
              <p>
                `All` 또는 `Gemma All`을 선택하면 같은 프롬프트를 두 모델에 동시에 보내고,
                좌우 비교 카드에서 실시간 스트리밍으로 확인합니다.
              </p>
            </div>
          )}
          <div className="chat-thread__anchor" />
        </section>

        <footer className="composer">
          <textarea
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault();
                void handleSubmit();
              }
            }}
            placeholder="프롬프트를 입력하세요. Shift+Enter로 줄바꿈합니다."
            rows={4}
          />
          <div className="composer__footer">
            <div className="composer__hint">
              현재 모드: <strong>{MODEL_LABELS[selectedModel]}</strong>
            </div>
            <div className="composer__actions">
              {isStreaming ? (
                <button className="danger-button" onClick={handleStop} type="button">
                  Stop
                </button>
              ) : null}
              <button className="primary-button" onClick={() => void handleSubmit()} type="button">
                Send
              </button>
            </div>
          </div>
        </footer>
      </main>
    </div>
  );

  function upsertConversation(nextConversation: Conversation) {
    startTransition(() => {
      setConversations((current) => {
        const remaining = current.filter((conversation) => conversation.id !== nextConversation.id);
        return [nextConversation, ...remaining];
      });
    });
  }

  function appendResponse(
    conversationId: string,
    turnId: string,
    model: ResponseModel,
    text: string,
  ) {
    startTransition(() => {
      setConversations((current) =>
        current.map((conversation) => {
          if (conversation.id !== conversationId) {
            return conversation;
          }

          return {
            ...conversation,
            updatedAt: Date.now(),
            turns: conversation.turns.map((turn) => {
              if (turn.id !== turnId) {
                return turn;
              }

              return {
                ...turn,
                responses: {
                  ...turn.responses,
                  [model]: {
                    ...turn.responses[model],
                    status: 'streaming',
                    text: `${turn.responses[model].text}${text}`,
                  },
                },
              };
            }),
          };
        }),
      );
    });
  }

  function setResponseStatus(
    conversationId: string,
    turnId: string,
    model: ResponseModel,
    status: ResponseStatus,
    error?: string,
  ) {
    startTransition(() => {
      setConversations((current) =>
        current.map((conversation) => {
          if (conversation.id !== conversationId) {
            return conversation;
          }

          return {
            ...conversation,
            updatedAt: Date.now(),
            turns: conversation.turns.map((turn) => {
              if (turn.id !== turnId) {
                return turn;
              }

              return {
                ...turn,
                responses: {
                  ...turn.responses,
                  [model]: {
                    ...turn.responses[model],
                    status,
                    error,
                  },
                },
              };
            }),
          };
        }),
      );
    });
  }

  function markStreamingAs(
    conversationId: string,
    turnId: string,
    status: ResponseStatus,
    error?: string,
  ) {
    const turn = conversations
      .find((conversation) => conversation.id === conversationId)
      ?.turns.find((item) => item.id === turnId);

    RESPONSE_MODELS.forEach((model) => {
      if (turn?.responses[model].status === 'streaming') {
        setResponseStatus(conversationId, turnId, model, status, error);
      }
    });
  }
}

function ResponseCard({
  model,
  response,
}: {
  model: ResponseModel;
  response: Turn['responses'][ResponseModel];
}) {
  return (
    <section className="response-card">
      <div className="response-card__header">
        <strong>{MODEL_LABELS[model]}</strong>
        <span className={`response-state response-state--${response.status}`}>{response.status}</span>
      </div>
      <div className="response-card__body">
        {response.text ? <p>{response.text}</p> : <p className="placeholder">응답 대기 중...</p>}
        {response.error ? <small className="error-text">{response.error}</small> : null}
      </div>
    </section>
  );
}

function createTurn(turnId: string, prompt: string, mode: ModelKind): Turn {
  return {
    id: turnId,
    prompt,
    mode,
    createdAt: Date.now(),
    responses: {
      deepseek: {
        text: '',
        status: mode === 'deepseek' || mode === 'all' ? 'streaming' : 'idle',
      },
      qwen: {
        text: '',
        status: mode === 'qwen' || mode === 'all' ? 'streaming' : 'idle',
      },
      gemma26: {
        text: '',
        status: mode === 'gemma26' || mode === 'gemma_all' ? 'streaming' : 'idle',
      },
      gemmae4: {
        text: '',
        status: mode === 'gemmae4' || mode === 'gemma_all' ? 'streaming' : 'idle',
      },
    },
  };
}

function buildMessageHistory(turns: Turn[], targetModel: ResponseModel, nextPrompt: string): ChatMessage[] {
  const messages: ChatMessage[] = [];

  for (const turn of turns) {
    messages.push({ role: 'user', content: turn.prompt });
    const response = turn.responses[targetModel].text.trim();
    if (response) {
      messages.push({ role: 'assistant', content: response });
    }
  }

  messages.push({ role: 'user', content: nextPrompt });
  return messages;
}

function trimTitle(prompt: string) {
  return prompt.length > 42 ? `${prompt.slice(0, 42)}...` : prompt;
}

function formatBrowserFetchError(message: string) {
  const lower = message.toLowerCase();
  if (
    lower === 'failed to fetch' ||
    lower === 'fetch failed' ||
    lower.includes('networkerror when attempting to fetch')
  ) {
    return '브라우저에서 게이트웨이에 연결하지 못했습니다(CORS·오프라인·URL 오타·HTTPS). 사이드바 Gateway URL과 Funnel 상태를 확인하세요.';
  }
  return message;
}

function healthLabel(status: HealthStatus) {
  switch (status) {
    case 'connected':
      return 'Gateway Online';
    case 'upstream_degraded':
      return 'Funnel OK · LLM offline';
    case 'degraded':
      return 'Gateway Issue';
    case 'missing':
      return 'Gateway Missing';
    default:
      return 'Checking';
  }
}

function formatTimestamp(timestamp: number) {
  return new Intl.DateTimeFormat('ko-KR', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(timestamp);
}

async function safeJson(response: Response) {
  try {
    return await response.json();
  } catch {
    return null;
  }
}
