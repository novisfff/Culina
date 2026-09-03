import { useCallback } from 'react';
import { api } from '../../api/client';
import type { AiChatResponse } from '../../api/types/ai';
import { isExpectedAiStreamAbort } from '../../lib/aiStreamAbort';
import { buildStreamProgressEvent, handleInaccessibleStreamError, type StreamMutationContext } from './aiStreamSupport';
import type { ChatStreamPayload } from './useAiConversationStreams';

export function useAiChatStream(context: StreamMutationContext) {
  return useCallback(async (payload: ChatStreamPayload): Promise<AiChatResponse> => {
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
        onTimelineEvent: (event) => context.onTimelineEvent?.(event, conversationKey),
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
      if (handleInaccessibleStreamError(context, error, conversationId)) throw error;
      let operationResultPersisted = context.hasSuccessfulOperationResultForRun(payload.client_run_id);
      if (!operationResultPersisted) {
        try {
          await context.refreshAfterApprovalSettled();
          operationResultPersisted = context.hasSuccessfulOperationResultForRun(payload.client_run_id);
        } catch {
          // A failed refresh must not hide the original stream error.
        }
      }
      context.stopThinking(payload.client_run_id);
      if (!operationResultPersisted) {
        context.markStreamingAssistantStopped(payload.client_run_id, `AI 处理失败：${context.streamFailureMessage(error)}`);
      }
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
}
