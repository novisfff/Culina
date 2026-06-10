import { API_BASE_URL, getAccessToken, request } from './request';
import type {
  AiApprovalDecisionResponse,
  AiApprovalRequest,
  AiChatResponse,
  AiRunEvent,
  AiConversation,
  AiMessage,
  GenerateRecipeDraftPayload,
  GenerateRecipeDraftResponse,
} from './types';

type AiChatPayload = {
  message: string;
  conversation_id?: string;
  client_message_id?: string;
  client_run_id?: string;
  quick_task?: string;
  subject?: Record<string, unknown>;
};
type AiChatStreamHandlers = {
  signal?: AbortSignal;
  onProgress?: (event: AiRunEvent | { type: string; internal_code: string; user_message: string; status: AiRunEvent['status'] }) => void;
  onMessageDelta?: (event: { message_id?: string; conversation_id?: string; run_id?: string; part_id?: string; delta: string }) => void;
};

async function streamChatAi(payload: AiChatPayload, handlers: AiChatStreamHandlers = {}): Promise<AiChatResponse> {
  const headers = new Headers({ 'Content-Type': 'application/json' });
  const token = getAccessToken();
  if (token) {
    headers.set('Authorization', `Bearer ${token}`);
  }
  const response = await fetch(`${API_BASE_URL}/api/ai/chat/stream`, {
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
    const eventLine = block.split('\n').find((line) => line.startsWith('event: '));
    const dataLine = block.split('\n').find((line) => line.startsWith('data: '));
    if (!eventLine || !dataLine) return;
    const event = eventLine.slice(7).trim();
    const data = JSON.parse(dataLine.slice(6)) as unknown;
    if (event === 'progress') {
      handlers.onProgress?.(data as AiRunEvent);
    } else if (event === 'message_delta') {
      handlers.onMessageDelta?.(data as { message_id?: string; conversation_id?: string; run_id?: string; part_id?: string; delta: string });
    } else if (event === 'response') {
      finalResponse = data as AiChatResponse;
    } else if (event === 'error') {
      const detail = typeof data === 'object' && data && 'detail' in data ? String((data as { detail: unknown }).detail) : '流式请求失败';
      throw new Error(detail);
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

export const aiApi = {
  getAiConversations: () => request<AiConversation[]>('/api/ai/conversations'),
  deleteAiConversation: (conversationId: string) =>
    request<void>(`/api/ai/conversations/${conversationId}`, {
      method: 'DELETE',
    }),
  chatAi: (payload: AiChatPayload) =>
    request<AiChatResponse>('/api/ai/chat', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),
  streamChatAi,
  cancelAiRun: (runId: string) =>
    request<{ run: Record<string, unknown>; events: AiRunEvent[] }>(`/api/ai/runs/${runId}/cancel`, {
      method: 'POST',
    }),
  retryAiRun: (runId: string) =>
    request<AiChatResponse>(`/api/ai/runs/${runId}/retry`, {
      method: 'POST',
    }),
  regenerateAiPart: (messageId: string, partId: string) =>
    request<AiChatResponse>(`/api/ai/messages/${messageId}/parts/${partId}/regenerate`, {
      method: 'POST',
    }),
  getAiMessages: (conversationId: string) =>
    request<AiMessage[]>(`/api/ai/conversations/${conversationId}/messages`),
  getAiRunEvents: (runId: string) =>
    request<AiRunEvent[]>(`/api/ai/runs/${runId}/events`),
  getPendingAiApprovals: (conversationId: string) =>
    request<AiApprovalRequest[]>(`/api/ai/conversations/${conversationId}/approvals/pending`),
  decideAiApproval: (
    conversationId: string,
    approvalId: string,
    payload: { decision: 'approved' | 'rejected'; draft_version: number; values: Record<string, unknown>; comment?: string }
  ) =>
    request<AiApprovalDecisionResponse>(`/api/ai/conversations/${conversationId}/approvals/${approvalId}/decision`, {
      method: 'POST',
      body: JSON.stringify(payload),
    }),
  generateRecipeDraft: (payload: GenerateRecipeDraftPayload) =>
    request<GenerateRecipeDraftResponse>('/api/ai/recipes/draft', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),
};
