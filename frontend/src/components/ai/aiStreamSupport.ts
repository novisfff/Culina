import type { Dispatch, MutableRefObject, SetStateAction } from 'react';
import { isApiError } from '../../api/client';
import type { AiChatResponse, AiMessagePart, AiRunEvent, AiTimelineEvent } from '../../api/types/ai';

export type StreamProgressEvent = {
  id?: unknown;
  run_id?: unknown;
  type: AiRunEvent['type'];
  internal_code: string;
  user_message: string;
  status: AiRunEvent['status'];
  created_at?: unknown;
};

export type StreamMutationContext = {
  onTimelineEvent?: (event: AiTimelineEvent, conversationKey?: string) => void;
  activeStreamRunIdsByConversationKey: Record<string, string>;
  chatAbortByRunIdRef: MutableRefObject<Record<string, AbortController>>;
  streamMessageTargetRef: MutableRefObject<Record<string, string>>;
  streamConversationTargetRef: MutableRefObject<Record<string, string>>;
  setActiveStreamRunIdsByConversationKey: Dispatch<SetStateAction<Record<string, string>>>;
  startThinking: (runId: string | null | undefined) => void;
  stopThinking: (runId: string | null | undefined) => void;
  ensureStreamingAssistantMessage: (runId: string, conversationKey: string) => void;
  updateThinkingForProgressEvent: (event: AiRunEvent, fallbackRunId?: string | null) => void;
  upsertStreamProgressEvent: (event: AiRunEvent) => void;
  applyStreamPart: (event: { message_id?: string; conversation_id?: string; run_id?: string; part: AiMessagePart }, conversationKey: string) => void;
  applyStreamDelta: (event: { message_id?: string; conversation_id?: string; run_id?: string; part_id?: string; delta: string }, conversationKey: string) => void;
  applyChatResponse: (response: AiChatResponse, conversationKey: string, runId: string) => void;
  streamFailureMessage: (error: unknown) => string;
  markStreamingAssistantStopped: (runId: string | null, text?: string) => void;
  hasSuccessfulOperationResultForRun: (runId: string | null | undefined) => boolean;
  clearInaccessibleConversation: (conversationId: string) => void;
  refreshAfterApprovalSettled: () => Promise<void>;
  isApprovalDecisionSettledPart: (part: AiMessagePart, approvalId: string) => boolean;
};

export function buildStreamProgressEvent(event: StreamProgressEvent, fallbackRunId: string | null | undefined, idPrefix: string): AiRunEvent {
  const eventRunId = typeof event.run_id === 'string' && event.run_id !== 'pending'
    ? event.run_id
    : fallbackRunId ?? 'pending';
  return {
    id: typeof event.id === 'string' ? event.id : `${idPrefix}-${event.internal_code}-${Date.now()}`,
    run_id: eventRunId,
    type: event.type,
    internal_code: event.internal_code,
    user_message: event.user_message,
    status: event.status,
    created_at: typeof event.created_at === 'string' ? event.created_at : new Date().toISOString(),
  };
}

export function removeRunController(ref: MutableRefObject<Record<string, AbortController>>, runId: string) {
  const { [runId]: _removed, ...remainingControllers } = ref.current;
  ref.current = remainingControllers;
}

export function clearActiveStreamRun(
  setActiveStreamRunIdsByConversationKey: Dispatch<SetStateAction<Record<string, string>>>,
  conversationKey: string,
  runId: string,
) {
  setActiveStreamRunIdsByConversationKey((current) => {
    if (current[conversationKey] !== runId) return current;
    const next = { ...current };
    delete next[conversationKey];
    return next;
  });
}

export function handleInaccessibleStreamError(
  context: Pick<StreamMutationContext, 'clearInaccessibleConversation'>,
  error: unknown,
  conversationId: string | null | undefined,
) {
  if (!conversationId || !isApiError(error) || error.status !== 404) return false;
  context.clearInaccessibleConversation(conversationId);
  return true;
}
