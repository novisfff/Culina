import { request } from './request';
import type {
  AiApprovalDecisionResponse,
  AiApprovalRequest,
  AiChatResponse,
  AiConversation,
  AiMessage,
  AiQueryResponse,
  GenerateRecipeDraftPayload,
  GenerateRecipeDraftResponse,
} from './types';

export const aiApi = {
  getAiConversations: () => request<AiConversation[]>('/api/ai/conversations'),
  deleteAiConversation: (conversationId: string) =>
    request<void>(`/api/ai/conversations/${conversationId}`, {
      method: 'DELETE',
    }),
  chatAi: (payload: { message: string; conversation_id?: string; client_message_id?: string; quick_task?: string; subject?: Record<string, unknown> }) =>
    request<AiChatResponse>('/api/ai/chat', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),
  getAiMessages: (conversationId: string) =>
    request<AiMessage[]>(`/api/ai/conversations/${conversationId}/messages`),
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
  queryAi: (payload: { mode: string; prompt: string; food_id?: string; ingredient_ids?: string[] }) =>
    request<AiQueryResponse>('/api/ai/query', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),
  generateRecipeDraft: (payload: GenerateRecipeDraftPayload) =>
    request<GenerateRecipeDraftResponse>('/api/ai/recipes/draft', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),
};
