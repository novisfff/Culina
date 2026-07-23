import { API_BASE_URL, ApiError, getAccessToken, request } from './request';
import type {
  AiApprovalDecisionResponse,
  AiApprovalRequest,
  AiChatAttachment,
  AiChatResponse,
  AiRunEvent,
  AiConversation,
  AiConversationVisibility,
  AiMessage,
  AiMessagePart,
  AiQualityMetrics,
  AiRunCancellationResponse,
  AiRunLLMExchange,
  AiRunLLMExchangeResponse,
  AiStatus,
  AiRunTraceResponse,
  AiRunTraceTreeResponse,
  GenerateRecipeDraftPayload,
  GenerateRecipeDraftResponse,
} from './types';

export const AI_DRAFT_CONTRACT_CAPABILITIES = [
  'recipe_cook_operation.v1',
  'recipe_cook_operation.v2',
] as const;

export const AI_DRAFT_CONTRACTS_HEADER = 'X-Culina-AI-Draft-Contracts';

export function aiContractHeaders(init?: HeadersInit) {
  const headers = new Headers(init);
  headers.set(AI_DRAFT_CONTRACTS_HEADER, AI_DRAFT_CONTRACT_CAPABILITIES.join(','));
  return headers;
}

function aiRequest<T>(path: string, init: RequestInit = {}) {
  return request<T>(path, { ...init, headers: aiContractHeaders(init.headers) });
}

type AiChatPayload = {
  message: string;
  conversation_id?: string;
  client_message_id?: string;
  client_run_id?: string;
  quick_task?: string;
  subject?: Record<string, unknown>;
  attachments?: AiChatAttachment[];
  persist_history?: boolean;
};
export type AssistantAudioStartEvent = {
  content_type: string;
  format: 'pcm16' | string;
  sample_rate: number;
  channels: number;
  provider?: string;
  model?: string;
};
export type AssistantAudioDeltaEvent = {
  audio: string;
  sequence: number;
};
export type AssistantAudioDoneEvent = {
  sequence: number;
};
export type AssistantAudioErrorEvent = {
  message: string;
};
export type AssistantAudioTraceEvent = {
  stage: string;
  elapsed_ms?: number;
  [key: string]: unknown;
};
type AiChatStreamHandlers = {
  signal?: AbortSignal;
  onProgress?: (event: AiRunEvent | { type: string; internal_code: string; user_message: string; status: AiRunEvent['status'] }) => void;
  onMessageDelta?: (event: { message_id?: string; conversation_id?: string; run_id?: string; part_id?: string; delta: string }) => void;
  onMessagePart?: (event: { message_id?: string; conversation_id?: string; run_id?: string; part: AiMessagePart }) => void;
  onResponse?: (response: AiChatResponse) => void;
  onAssistantAudioStart?: (event: AssistantAudioStartEvent) => void;
  onAssistantAudioDelta?: (event: AssistantAudioDeltaEvent) => void;
  onAssistantAudioDone?: (event: AssistantAudioDoneEvent) => void;
  onAssistantAudioError?: (event: AssistantAudioErrorEvent) => void;
  onAssistantAudioTrace?: (event: AssistantAudioTraceEvent) => void;
};
type AiApprovalDecisionPayload = {
  decision: 'approved' | 'rejected';
  draft_version: number;
  values: Record<string, unknown>;
  comment?: string;
};
type AiHumanInputResponsePayload = {
  selected_option_ids?: string[];
  text?: string;
};

async function streamAiResponse(url: string, payload: unknown, handlers: AiChatStreamHandlers = {}): Promise<AiChatResponse> {
  // Rebuild capability headers on every stream connect/reconnect so capability never
  // freezes to a response-derived value from a prior connection.
  const headers = aiContractHeaders({ 'Content-Type': 'application/json' });
  const token = getAccessToken();
  if (token) {
    headers.set('Authorization', `Bearer ${token}`);
  }
  const response = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(payload),
    signal: handlers.signal,
  });
  if (!response.ok || !response.body) {
    throw new Error(response.statusText || '流式请求失败');
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let finalResponse: AiChatResponse | null = null;
  const consumeBlock = (block: string) => {
    const lines = block.split('\n');
    const eventLine = lines.find((line) => line.startsWith('event:'));
    const dataLines = lines.filter((line) => line.startsWith('data:'));
    if (!eventLine || dataLines.length === 0) return;
    const event = eventLine.slice(6).trim();
    const dataText = dataLines.map((line) => line.replace(/^data: ?/, '')).join('\n');
    const data = JSON.parse(dataText) as unknown;
    if (event === 'progress') {
      handlers.onProgress?.(data as AiRunEvent);
    } else if (event === 'message_part') {
      handlers.onMessagePart?.(data as { message_id?: string; conversation_id?: string; run_id?: string; part: AiMessagePart });
    } else if (event === 'message_delta') {
      handlers.onMessageDelta?.(data as { message_id?: string; conversation_id?: string; run_id?: string; part_id?: string; delta: string });
    } else if (event === 'response') {
      finalResponse = data as AiChatResponse;
      handlers.onResponse?.(finalResponse);
    } else if (event === 'assistant_audio_start') {
      handlers.onAssistantAudioStart?.(data as AssistantAudioStartEvent);
    } else if (event === 'assistant_audio_delta') {
      handlers.onAssistantAudioDelta?.(data as AssistantAudioDeltaEvent);
    } else if (event === 'assistant_audio_done') {
      handlers.onAssistantAudioDone?.(data as AssistantAudioDoneEvent);
    } else if (event === 'assistant_audio_error') {
      handlers.onAssistantAudioError?.(data as AssistantAudioErrorEvent);
    } else if (event === 'assistant_audio_trace') {
      handlers.onAssistantAudioTrace?.(data as AssistantAudioTraceEvent);
    } else if (event === 'error') {
      const errorPayload = data && typeof data === 'object' ? data as { detail?: unknown; status?: unknown } : {};
      throw new ApiError({
        status: Number(errorPayload.status) || 500,
        detail: typeof errorPayload.detail === 'string' ? errorPayload.detail : '流式请求失败',
        path: url,
        payload: data,
      });
    }
  };
  while (true) {
    const { done, value } = await reader.read();
    buffer += decoder.decode(value ?? new Uint8Array(), { stream: !done });
    const blocks = buffer.split('\n\n');
    buffer = blocks.pop() ?? '';
    for (const block of blocks) {
      if (block.trim()) consumeBlock(block);
    }
    if (done) break;
  }
  if (buffer.trim()) consumeBlock(buffer);
  if (!finalResponse) {
    throw new Error('流式响应缺少最终结果');
  }
  return finalResponse;
}

async function streamChatAi(payload: AiChatPayload, handlers: AiChatStreamHandlers = {}): Promise<AiChatResponse> {
  return streamAiResponse(`${API_BASE_URL}/api/ai/chat/stream`, payload, handlers);
}

async function streamCookingAssistantVoiceAi(payload: AiChatPayload, handlers: AiChatStreamHandlers = {}): Promise<AiChatResponse> {
  return streamAiResponse(`${API_BASE_URL}/api/ai/audio/cooking/assistant/stream`, payload, handlers);
}

export const aiApi = {
  getAiStatus: () => aiRequest<AiStatus>('/api/ai/status'),
  getAiQualityMetrics: () => aiRequest<AiQualityMetrics>('/api/ai/quality-metrics?limit=50'),
  getAiConversations: () => aiRequest<AiConversation[]>('/api/ai/conversations'),
  deleteAiConversation: (conversationId: string) =>
    aiRequest<void>(`/api/ai/conversations/${conversationId}`, {
      method: 'DELETE',
    }),
  updateAiConversationVisibility: (conversationId: string, visibility: AiConversationVisibility) =>
    aiRequest<AiConversation>(`/api/ai/conversations/${conversationId}/visibility`, {
      method: 'PATCH',
      body: JSON.stringify({ visibility }),
    }),
  chatAi: (payload: AiChatPayload) =>
    aiRequest<AiChatResponse>('/api/ai/chat', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),
  streamChatAi,
  streamCookingAssistantVoiceAi,
  cancelAiRun: (runId: string) =>
    aiRequest<AiRunCancellationResponse>(`/api/ai/runs/${runId}/cancel`, {
      method: 'POST',
    }),
  getAiRunCancellation: (runId: string) =>
    aiRequest<AiRunCancellationResponse>(`/api/ai/runs/${runId}/cancellation`),
  retryAiRun: (runId: string) =>
    aiRequest<AiChatResponse>(`/api/ai/runs/${runId}/retry`, {
      method: 'POST',
    }),
  getAiMessages: (conversationId: string) =>
    aiRequest<AiMessage[]>(`/api/ai/conversations/${conversationId}/messages`),
  recordAiRecommendationSelection: (
    messageId: string,
    payload: { part_id: string; card_id: string; entity_id: string; food_plan_item_id: string },
  ) =>
    aiRequest<AiMessage>(`/api/ai/messages/${messageId}/recommendation-selection`, {
      method: 'POST',
      body: JSON.stringify(payload),
    }),
  createAiInventoryOperationDraft: (
    messageId: string,
    payload: { part_id: string; card_id: string; item_id: string; action: 'restock' | 'consume' | 'dispose' },
  ) =>
    aiRequest<AiMessage>(`/api/ai/messages/${messageId}/inventory-operation-draft`, {
      method: 'POST',
      body: JSON.stringify(payload),
    }),
  getAiRunEvents: (runId: string) =>
    aiRequest<AiRunEvent[]>(`/api/ai/runs/${runId}/events`),
  getAiRunTrace: (runId: string) =>
    aiRequest<AiRunTraceResponse>(`/api/ai/runs/${runId}/trace`),
  getAiRunTraceTree: (runId: string) =>
    aiRequest<AiRunTraceTreeResponse>(`/api/ai/runs/${runId}/trace/tree`),
  getAiRunLlmExchanges: (runId: string, options: { includePayload?: boolean } = {}) => {
    const includePayload = options.includePayload ?? true;
    const query = includePayload ? '' : '?includePayload=false';
    return aiRequest<AiRunLLMExchangeResponse>(`/api/ai/runs/${runId}/llm-exchanges${query}`);
  },
  getAiRunLlmExchange: (runId: string, exchangeId: string) =>
    aiRequest<AiRunLLMExchange>(`/api/ai/runs/${runId}/llm-exchanges/${exchangeId}`),
  getPendingAiApprovals: (conversationId: string) =>
    aiRequest<AiApprovalRequest[]>(`/api/ai/conversations/${conversationId}/approvals/pending`),
  decideAiApproval: (
    conversationId: string,
    approvalId: string,
    payload: AiApprovalDecisionPayload
  ) =>
    aiRequest<AiApprovalDecisionResponse>(`/api/ai/conversations/${conversationId}/approvals/${approvalId}/decision`, {
      method: 'POST',
      body: JSON.stringify(payload),
    }),
  streamAiApprovalDecision: (
    conversationId: string,
    approvalId: string,
    payload: AiApprovalDecisionPayload,
    handlers: AiChatStreamHandlers = {},
  ) => streamAiResponse(`${API_BASE_URL}/api/ai/conversations/${conversationId}/approvals/${approvalId}/decision/stream`, payload, handlers),
  respondAiHumanInput: (conversationId: string, requestId: string, payload: AiHumanInputResponsePayload) =>
    aiRequest<AiChatResponse>(`/api/ai/conversations/${conversationId}/human-input/${requestId}/response`, {
      method: 'POST',
      body: JSON.stringify(payload),
    }),
  streamAiHumanInputResponse: (
    conversationId: string,
    requestId: string,
    payload: AiHumanInputResponsePayload,
    handlers: AiChatStreamHandlers = {},
  ) => streamAiResponse(`${API_BASE_URL}/api/ai/conversations/${conversationId}/human-input/${requestId}/response/stream`, payload, handlers),
  generateRecipeDraft: (payload: GenerateRecipeDraftPayload) =>
    aiRequest<GenerateRecipeDraftResponse>('/api/ai/recipes/draft', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),
};
