import { useCallback, useState } from 'react';
import { api } from '../../api/client';
import type { AiChatResponse } from '../../api/types/ai';
import { isExpectedAiStreamAbort } from '../../lib/aiStreamAbort';
import {
  buildStreamProgressEvent,
  clearActiveStreamRun,
  handleInaccessibleStreamError,
  removeRunController,
  type StreamMutationContext,
} from './aiStreamSupport';
import type { HumanInputStreamPayload } from './useAiConversationStreams';

export function useAiHumanInputStream(context: StreamMutationContext) {
  const [submittingRequestIds, setSubmittingRequestIds] = useState<Set<string>>(() => new Set());
  const [submittingByRequestId, setSubmittingByRequestId] = useState<
    Record<string, { messageId: string; conversationId: string; runId: string | null }>
  >({});

  const startHumanInput = useCallback(async (payload: HumanInputStreamPayload): Promise<AiChatResponse> => {
    const controller = new AbortController();
    const conversationKey = payload.message.conversation_id;
    const runId = payload.message.run_id;
    const requestId = payload.request.id;
    setSubmittingRequestIds((current) => new Set(current).add(requestId));
    setSubmittingByRequestId((current) => ({
      ...current,
      [requestId]: { messageId: payload.message.id, conversationId: conversationKey, runId: runId ?? null },
    }));
    if (runId) {
      context.chatAbortByRunIdRef.current = { ...context.chatAbortByRunIdRef.current, [runId]: controller };
      context.streamMessageTargetRef.current = { ...context.streamMessageTargetRef.current, [runId]: payload.message.id };
      context.setActiveStreamRunIdsByConversationKey((current) => ({ ...current, [conversationKey]: runId }));
      context.startThinking(runId);
    }
    try {
      const response = await api.streamAiHumanInputResponse(conversationKey, requestId, payload.response, {
        signal: controller.signal,
        onTimelineEvent: (event) => context.onTimelineEvent?.(event, conversationKey),
        onProgress: (event) => {
          const nextEvent = buildStreamProgressEvent(event, runId, 'human-input-stream');
          if (!context.streamMessageTargetRef.current[nextEvent.run_id]) {
            context.ensureStreamingAssistantMessage(nextEvent.run_id, conversationKey);
          }
          context.updateThinkingForProgressEvent(nextEvent, runId);
          context.upsertStreamProgressEvent(nextEvent);
        },
        onMessagePart: (event) => context.applyStreamPart(event, conversationKey),
        onMessageDelta: (event) => context.applyStreamDelta(event, conversationKey),
      });
      context.applyChatResponse(response, conversationKey, runId ?? response.run.id);
      return response;
    } catch (error) {
      if (isExpectedAiStreamAbort(error, controller.signal)) {
        await context.refreshAfterApprovalSettled();
        throw error;
      }
      if (!handleInaccessibleStreamError(context, error, conversationKey)) {
        context.stopThinking(runId);
        context.markStreamingAssistantStopped(runId ?? null, `AI 处理失败：${context.streamFailureMessage(error)}`);
      }
      throw error;
    } finally {
      if (runId) {
        context.stopThinking(runId);
        removeRunController(context.chatAbortByRunIdRef, runId);
        clearActiveStreamRun(context.setActiveStreamRunIdsByConversationKey, conversationKey, runId);
      }
      setSubmittingRequestIds((current) => {
        const next = new Set(current);
        next.delete(requestId);
        return next;
      });
      setSubmittingByRequestId((current) => {
        const next = { ...current };
        delete next[requestId];
        return next;
      });
    }
  }, [context]);

  return { startHumanInput, submittingRequestIds, submittingByRequestId };
}
