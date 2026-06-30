import { useMutation, type UseMutationResult } from '@tanstack/react-query';
import type { Dispatch, MutableRefObject, SetStateAction } from 'react';
import { api } from '../../api/client';
import type {
  AiApprovalRequest,
  AiChatAttachment,
  AiChatResponse,
  AiHumanInputRequest,
  AiMessage,
  AiMessagePart,
  AiRunEvent,
} from '../../api/types';
import type { AiApprovalDecisionSubmit } from './AiConversationThread';

type StreamProgressEvent = {
  id?: unknown;
  run_id?: unknown;
  type: AiRunEvent['type'];
  internal_code: string;
  user_message: string;
  status: AiRunEvent['status'];
  created_at?: unknown;
};

type ChatStreamPayload = {
  message: string;
  conversationKey: string;
  conversation_id?: string;
  client_message_id?: string;
  client_run_id: string;
  quick_task?: string;
  subject?: Record<string, unknown>;
  attachments?: AiChatAttachment[];
};

type ApprovalStreamPayload = {
  approval: Parameters<AiApprovalDecisionSubmit>[0];
  decision: 'approved' | 'rejected';
  values: Record<string, unknown>;
  comment?: string;
};

type HumanInputStreamPayload = {
  message: AiMessage;
  request: AiHumanInputRequest;
  response: { selected_option_ids?: string[]; text?: string };
};

type StreamMutationContext = {
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
  refreshAfterApprovalSettled: () => Promise<void>;
  isApprovalDecisionSettledPart: (part: AiMessagePart, approvalId: string) => boolean;
};

function buildStreamProgressEvent(event: StreamProgressEvent, fallbackRunId: string | null | undefined, idPrefix: string): AiRunEvent {
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

function removeRunController(ref: MutableRefObject<Record<string, AbortController>>, runId: string) {
  const { [runId]: _removed, ...remainingControllers } = ref.current;
  ref.current = remainingControllers;
}

function clearActiveStreamRun(
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

function useChatStreamMutation(context: StreamMutationContext): UseMutationResult<AiChatResponse, Error, ChatStreamPayload> {
  return useMutation({
    mutationFn: (payload: ChatStreamPayload) => {
      const controller = new AbortController();
      context.chatAbortByRunIdRef.current = { ...context.chatAbortByRunIdRef.current, [payload.client_run_id]: controller };
      context.startThinking(payload.client_run_id);
      const { conversationKey, ...requestPayload } = payload;
      return api.streamChatAi(requestPayload, {
        signal: controller.signal,
        onProgress: (event) => {
          const nextEvent = buildStreamProgressEvent(event, payload.client_run_id, 'stream');
          context.ensureStreamingAssistantMessage(nextEvent.run_id, conversationKey);
          context.updateThinkingForProgressEvent(nextEvent, payload.client_run_id);
          context.upsertStreamProgressEvent(nextEvent);
        },
        onMessagePart: (event) => context.applyStreamPart(event, conversationKey),
        onMessageDelta: (event) => context.applyStreamDelta(event, conversationKey),
      }).then((response) => {
        context.applyChatResponse(response, conversationKey, payload.client_run_id);
        return response;
      });
    },
    onSettled: (_data, _error, variables) => {
      if (!variables) return;
      context.stopThinking(variables.client_run_id);
      removeRunController(context.chatAbortByRunIdRef, variables.client_run_id);
      context.setActiveStreamRunIdsByConversationKey((current) => {
        const next = { ...current };
        let changed = false;
        for (const [conversationKey, runId] of Object.entries(current)) {
          if (conversationKey === variables.conversationKey || runId === variables.client_run_id) {
            delete next[conversationKey];
            changed = true;
          }
        }
        return changed ? next : current;
      });
      delete context.streamConversationTargetRef.current[variables.conversationKey];
      delete context.streamConversationTargetRef.current[variables.client_run_id];
    },
  });
}

function useApprovalStreamMutation(context: StreamMutationContext): UseMutationResult<void, Error, ApprovalStreamPayload> {
  return useMutation({
    mutationFn: async (payload: ApprovalStreamPayload) => {
      const controller = new AbortController();
      const conversationKey = payload.approval.conversation_id;
      const runId = payload.approval.run_id;
      const isRunAlreadyStreaming = Boolean(runId && context.activeStreamRunIdsByConversationKey[conversationKey] === runId);
      const decisionPayload = {
        decision: payload.decision,
        draft_version: payload.approval.draft_version,
        values: payload.values,
        comment: payload.comment,
      };
      if (isRunAlreadyStreaming) {
        throw new Error('当前确认结果已经在处理中，请稍后查看结果。');
      }
      if (runId) {
        context.chatAbortByRunIdRef.current = { ...context.chatAbortByRunIdRef.current, [runId]: controller };
        context.setActiveStreamRunIdsByConversationKey((current) => ({ ...current, [conversationKey]: runId }));
        context.startThinking(runId);
        if (payload.approval.message_id) {
          context.streamMessageTargetRef.current = { ...context.streamMessageTargetRef.current, [runId]: payload.approval.message_id };
        } else {
          context.ensureStreamingAssistantMessage(runId, conversationKey);
        }
      }
      let settleDecisionResult: (() => void) | null = null;
      let rejectDecisionResult: ((error: unknown) => void) | null = null;
      let isDecisionResultSettled = false;
      const decisionResultVisible = new Promise<void>((resolve, reject) => {
        settleDecisionResult = resolve;
        rejectDecisionResult = reject;
      });
      const settleDecisionVisible = () => {
        if (isDecisionResultSettled) return;
        isDecisionResultSettled = true;
        settleDecisionResult?.();
      };
      const rejectDecisionVisible = (error: unknown) => {
        if (isDecisionResultSettled) return;
        isDecisionResultSettled = true;
        rejectDecisionResult?.(error);
      };
      void api.streamAiApprovalDecision(
        payload.approval.conversation_id,
        payload.approval.id,
        decisionPayload,
        {
          signal: controller.signal,
          onProgress: (event) => {
            const nextEvent = buildStreamProgressEvent(event, runId, 'approval-stream');
            if (!context.streamMessageTargetRef.current[nextEvent.run_id]) {
              context.ensureStreamingAssistantMessage(nextEvent.run_id, conversationKey);
            }
            context.updateThinkingForProgressEvent(nextEvent, runId);
            context.upsertStreamProgressEvent(nextEvent);
          },
          onMessagePart: (event) => {
            context.applyStreamPart(event, conversationKey);
            if (context.isApprovalDecisionSettledPart(event.part, payload.approval.id)) {
              settleDecisionVisible();
            }
          },
          onMessageDelta: (event) => context.applyStreamDelta(event, conversationKey),
        },
      ).then((response) => {
        context.applyChatResponse(response, payload.approval.conversation_id, runId ?? response.run.id);
        settleDecisionVisible();
      }).catch((error) => {
        const message = context.streamFailureMessage(error);
        context.stopThinking(runId);
        context.markStreamingAssistantStopped(runId ?? null, `AI 后续处理失败：${message}`);
        void context.refreshAfterApprovalSettled();
        rejectDecisionVisible(error);
      }).finally(() => {
        if (!runId) return;
        context.stopThinking(runId);
        removeRunController(context.chatAbortByRunIdRef, runId);
        clearActiveStreamRun(context.setActiveStreamRunIdsByConversationKey, payload.approval.conversation_id, runId);
        void context.refreshAfterApprovalSettled();
      });
      return decisionResultVisible;
    },
    onSettled: () => {
      void context.refreshAfterApprovalSettled();
    },
  });
}

function useHumanInputStreamMutation(context: StreamMutationContext): UseMutationResult<AiChatResponse, Error, HumanInputStreamPayload> {
  return useMutation({
    mutationFn: (payload: HumanInputStreamPayload) => {
      const controller = new AbortController();
      const conversationKey = payload.message.conversation_id;
      const runId = payload.message.run_id;
      if (runId) {
        context.chatAbortByRunIdRef.current = { ...context.chatAbortByRunIdRef.current, [runId]: controller };
        context.streamMessageTargetRef.current = { ...context.streamMessageTargetRef.current, [runId]: payload.message.id };
        context.setActiveStreamRunIdsByConversationKey((current) => ({ ...current, [conversationKey]: runId }));
        context.startThinking(runId);
      }
      return api.streamAiHumanInputResponse(payload.message.conversation_id, payload.request.id, payload.response, {
        signal: controller.signal,
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
      }).then((response) => {
        context.applyChatResponse(response, payload.message.conversation_id, runId ?? response.run.id);
        return response;
      });
    },
    onSettled: (_data, _error, variables) => {
      const runId = variables?.message.run_id;
      if (!runId || !variables) return;
      context.stopThinking(runId);
      removeRunController(context.chatAbortByRunIdRef, runId);
      clearActiveStreamRun(context.setActiveStreamRunIdsByConversationKey, variables.message.conversation_id, runId);
    },
    onError: (error, variables) => {
      const message = context.streamFailureMessage(error);
      context.stopThinking(variables?.message.run_id);
      context.markStreamingAssistantStopped(variables?.message.run_id ?? null, `AI 后续处理失败：${message}`);
    },
  });
}

export function useAiStreamMutations(context: StreamMutationContext) {
  const chatMutation = useChatStreamMutation(context);
  const approvalStreamMutation = useApprovalStreamMutation(context);
  const humanInputMutation = useHumanInputStreamMutation(context);

  return {
    chatMutation,
    approvalStreamMutation,
    humanInputMutation,
  };
}
