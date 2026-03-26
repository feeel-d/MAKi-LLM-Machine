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

const DEFAULT_API_BASE_URL = (import.meta.env.VITE_API_BASE_URL ?? '').trim().replace(/\/$/, '');

const MODEL_LABELS: Record<ModelKind, string> = {
  deepseek: 'DeepSeek',
  qwen: 'Qwen',
  all: 'All',
};

const RESPONSE_MODELS: ResponseModel[] = ['deepseek', 'qwen'];

const DEFAULT_MODELS: ModelInfo[] = [
  { id: 'deepseek', label: 'DeepSeek', available: true },
  { id: 'qwen', label: 'Qwen', available: true },
  { id: 'all', label: 'All', available: true },
];

export default function App() {
  const [conversations, setConversations] = useState<Conversation[]>(() => loadConversations());
  const [selectedConversationId, setSelectedConversationId] = useState<string | null>(() => loadSelectedConversationId());
  const [selectedModel, setSelectedModel] = useState<ModelKind>(() => loadSelectedModel());
  const [draft, setDraft] = useState('');
  const [systemPrompt, setSystemPrompt] = useState(() => loadSystemPrompt());
  const [apiBaseUrl, setApiBaseUrl] = useState(() => loadApiBaseUrl(DEFAULT_API_BASE_URL));
  const [endpointDraft, setEndpointDraft] = useState(() => loadApiBaseUrl(DEFAULT_API_BASE_URL));
  const [healthStatus, setHealthStatus] = useState<HealthStatus>('unknown');
  const [healthMessage, setHealthMessage] = useState('게이트웨이 상태를 확인하는 중입니다.');
  const [models, setModels] = useState<ModelInfo[]>(DEFAULT_MODELS);
  const [isStreaming, setIsStreaming] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

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

      if (!healthResponse.ok) {
        const payload = await safeJson(healthResponse);
        throw new Error(payload?.error ?? 'Gateway is not healthy.');
      }

      const healthPayload = await healthResponse.json();
      setHealthStatus('connected');
      setHealthMessage(
        healthPayload.models?.length
          ? `연결 완료 · ${healthPayload.models.join(', ')}`
          : '연결 완료',
      );

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
      const primaryModel = selectedModel === 'all' ? 'deepseek' : selectedModel;
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
              : undefined,
          maxTokens: 768,
          temperature: selectedModel === 'qwen' ? 0.7 : 0.6,
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
            : error.message
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
    if (payload.model !== 'deepseek' && payload.model !== 'qwen') {
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
    setApiBaseUrl(endpointDraft.trim().replace(/\/$/, ''));
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
            {models.map((model) => (
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

        <section className="chat-thread">
          {selectedConversation?.turns.length ? (
            selectedConversation.turns.map((turn) => (
              <article key={turn.id} className="turn">
                <div className="bubble bubble--user">
                  <span className="bubble__label">You</span>
                  <p>{turn.prompt}</p>
                </div>

                {turn.mode === 'all' ? (
                  <div className="compare-grid">
                    {RESPONSE_MODELS.map((model) => (
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
              <h3>DeepSeek, Qwen, 그리고 All 비교 모드까지 한 화면에서 바로 테스트할 수 있습니다.</h3>
              <p>
                `All`을 선택하면 같은 프롬프트를 두 모델에 동시에 보내고,
                좌우 비교 카드에서 실시간 스트리밍으로 확인합니다.
              </p>
            </div>
          )}
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

function healthLabel(status: HealthStatus) {
  switch (status) {
    case 'connected':
      return 'Gateway Online';
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
