import { useCallback } from 'react';
import { api } from '../../api/client';
import type {
  AiChatAttachment,
  AiChatResponse,
  AiHumanInputRequest,
  AiMessage,
} from '../../api/types';
import { isExpectedAiStreamAbort } from '../../lib/aiStreamAbort';
import type { AiApprovalDecisionSubmit } from './AiConversationThread';
import { useAiHumanInputStream } from './useAiHumanInputStream';
import { useAiApprovalStream } from './useAiApprovalStream';
import {
  buildStreamProgressEvent,
  handleInaccessibleStreamError,
  type StreamMutationContext,
} from './aiStreamSupport';

export type ChatStreamPayload = {
  message: string;
  conversationKey: string;
  conversation_id?: string;
  client_message_id?: string;
  client_run_id: string;
  quick_task?: string;
  subject?: Record<string, unknown>;
  attachments?: AiChatAttachment[];
};

export type ApprovalStreamPayload = {
  approval: Parameters<AiApprovalDecisionSubmit>[0];
  decision: 'approved' | 'rejected';
  values: Record<string, unknown>;
  comment?: string;
};

export type HumanInputStreamPayload = {
  message: AiMessage;
  request: AiHumanInputRequest;
  response: { selected_option_ids?: string[]; text?: string };
};

export type AiConversationStreams = {
  startChat: (payload: ChatStreamPayload) => Promise<AiChatResponse>;
  startApproval: (payload: ApprovalStreamPayload) => Promise<void>;
  startHumanInput: (payload: HumanInputStreamPayload) => Promise<AiChatResponse>;
  submittingApprovalIds: Set<string>;
  submittingHumanInputRequestIds: Set<string>;
  submittingHumanInputByRequestId: Record<string, { messageId: string; conversationId: string; runId: string | null }>;
};

export function useAiConversationStreams(context: StreamMutationContext): AiConversationStreams {
  const approval = useAiApprovalStream(context);
  const humanInput = useAiHumanInputStream(context);

  const startChat = useCallback(async (payload: ChatStreamPayload) => {
    const controller = new AbortController();
    context.chatAbortByRunIdRef.current[payload.client_run_id] = controller;
    context.setActiveStreamRunIdsByConversationKey((current) => ({
      ...current,
      [payload.conversationKey]: payload.client_run_id,
    }));
    context.startThinking(payload.client_run_id);
    const { conversationKey, ...requestPayload } = payload;
    try {
      const response = await api.streamChatAi(requestPayload, {
        signal: controller.signal,
        onProgress: (event) => {
          const nextEvent = buildStreamProgressEvent(event, payload.client_run_id, 'stream');
          context.ensureStreamingAssistantMessage(nextEvent.run_id, conversationKey);
          context.updateThinkingForProgressEvent(nextEvent, payload.client_run_id);
          context.upsertStreamProgressEvent(nextEvent);
        },
        onMessagePart: (event) => context.applyStreamPart(event, conversationKey),
        onMessageDelta: (event) => context.applyStreamDelta(event, conversationKey),
      });
      context.applyChatResponse(response, conversationKey, payload.client_run_id);
      return response;
    } catch (error) {
      if (isExpectedAiStreamAbort(error, controller.signal)) {
        await context.refreshAfterApprovalSettled();
        throw error;
      }
      const conversationId = payload.conversation_id ?? conversationKey;
      if (handleInaccessibleStreamError(context, error, conversationId)) {
        throw error;
      }
      const message = context.streamFailureMessage(error);
      context.stopThinking(payload.client_run_id);
      context.markStreamingAssistantStopped(
        payload.client_run_id,
        `AI 处理失败：${message}`,
      );
      throw error;
    } finally {
      context.stopThinking(payload.client_run_id);
      delete context.chatAbortByRunIdRef.current[payload.client_run_id];
      context.setActiveStreamRunIdsByConversationKey((current) => {
        if (current[conversationKey] !== payload.client_run_id) return current;
        const next = { ...current };
        delete next[conversationKey];
        return next;
      });
      delete context.streamConversationTargetRef.current[conversationKey];
      delete context.streamConversationTargetRef.current[payload.client_run_id];
    }
  }, [context]);

  return {
    startChat,
    startApproval: approval.startApproval,
    startHumanInput: humanInput.startHumanInput,
    submittingApprovalIds: approval.submittingApprovalIds,
    submittingHumanInputRequestIds: humanInput.submittingRequestIds,
    submittingHumanInputByRequestId: humanInput.submittingByRequestId,
  };
}
