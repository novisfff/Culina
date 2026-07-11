import { useCallback, useState, type Dispatch, type MutableRefObject, type SetStateAction } from 'react';
import { api, isApiError } from '../../api/client';
import type {
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
  clearInaccessibleConversation: (conversationId: string) => void;
  refreshAfterApprovalSettled: () => Promise<void>;
  isApprovalDecisionSettledPart: (part: AiMessagePart, approvalId: string) => boolean;
};

export type AiConversationStreams = {
  startChat: (payload: ChatStreamPayload) => Promise<AiChatResponse>;
  startApproval: (payload: ApprovalStreamPayload) => Promise<void>;
  startHumanInput: (payload: HumanInputStreamPayload) => Promise<AiChatResponse>;
  submittingApprovalIds: Set<string>;
  submittingHumanInputRequestIds: Set<string>;
  submittingHumanInputByRequestId: Record<string, { messageId: string; conversationId: string; runId: string | null }>;
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

function handleInaccessibleStreamError(
  context: Pick<StreamMutationContext, 'clearInaccessibleConversation'>,
  error: unknown,
  conversationId: string | null | undefined,
) {
  if (!conversationId || !isApiError(error) || error.status !== 404) return false;
  context.clearInaccessibleConversation(conversationId);
  return true;
}

export function useAiConversationStreams(context: StreamMutationContext): AiConversationStreams {
  const [submittingApprovalIds, setSubmittingApprovalIds] = useState<Set<string>>(() => new Set());
  const [submittingHumanInputRequestIds, setSubmittingHumanInputRequestIds] = useState<Set<string>>(() => new Set());
  const [submittingHumanInputByRequestId, setSubmittingHumanInputByRequestId] = useState<
    Record<string, { messageId: string; conversationId: string; runId: string | null }>
  >({});

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
      // cancelStreamingChat already marks the assistant stopped before aborting.
      // Do not overwrite cancel UX with a failure surface for abort errors.
      const isAbort = controller.signal.aborted
        || (error instanceof DOMException && error.name === 'AbortError')
        || (error instanceof Error && /aborted/i.test(error.message));
      if (!isAbort) {
        const conversationId = payload.conversation_id ?? conversationKey;
        if (handleInaccessibleStreamError(context, error, conversationId)) {
          throw error;
        }
        const message = context.streamFailureMessage(error);
        context.stopThinking(payload.client_run_id);
        context.markStreamingAssistantStopped(
          payload.client_run_id,
          `AI 后续处理失败：${message}`,
        );
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

  const startApproval = useCallback(async (payload: ApprovalStreamPayload) => {
    const controller = new AbortController();
    const conversationKey = payload.approval.conversation_id;
    const runId = payload.approval.run_id;
    const approvalId = payload.approval.id;
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

    setSubmittingApprovalIds((current) => {
      const next = new Set(current);
      next.add(approvalId);
      return next;
    });

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

    try {
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
        if (!handleInaccessibleStreamError(context, error, payload.approval.conversation_id)) {
          const message = context.streamFailureMessage(error);
          context.stopThinking(runId);
          context.markStreamingAssistantStopped(runId ?? null, `AI 后续处理失败：${message}`);
        }
        void context.refreshAfterApprovalSettled();
        rejectDecisionVisible(error);
      }).finally(() => {
        if (runId) {
          context.stopThinking(runId);
          removeRunController(context.chatAbortByRunIdRef, runId);
          clearActiveStreamRun(context.setActiveStreamRunIdsByConversationKey, payload.approval.conversation_id, runId);
        }
        void context.refreshAfterApprovalSettled();
      });
      await decisionResultVisible;
    } finally {
      setSubmittingApprovalIds((current) => {
        if (!current.has(approvalId)) return current;
        const next = new Set(current);
        next.delete(approvalId);
        return next;
      });
      void context.refreshAfterApprovalSettled();
    }
  }, [context]);

  const startHumanInput = useCallback(async (payload: HumanInputStreamPayload) => {
    const controller = new AbortController();
    const conversationKey = payload.message.conversation_id;
    const runId = payload.message.run_id;
    const requestId = payload.request.id;

    setSubmittingHumanInputRequestIds((current) => {
      const next = new Set(current);
      next.add(requestId);
      return next;
    });
    setSubmittingHumanInputByRequestId((current) => ({
      ...current,
      [requestId]: {
        messageId: payload.message.id,
        conversationId: conversationKey,
        runId: runId ?? null,
      },
    }));

    if (runId) {
      context.chatAbortByRunIdRef.current = { ...context.chatAbortByRunIdRef.current, [runId]: controller };
      context.streamMessageTargetRef.current = { ...context.streamMessageTargetRef.current, [runId]: payload.message.id };
      context.setActiveStreamRunIdsByConversationKey((current) => ({ ...current, [conversationKey]: runId }));
      context.startThinking(runId);
    }

    try {
      const response = await api.streamAiHumanInputResponse(payload.message.conversation_id, payload.request.id, payload.response, {
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
      });
      context.applyChatResponse(response, payload.message.conversation_id, runId ?? response.run.id);
      return response;
    } catch (error) {
      if (!handleInaccessibleStreamError(context, error, conversationKey)) {
        const message = context.streamFailureMessage(error);
        context.stopThinking(runId);
        context.markStreamingAssistantStopped(runId ?? null, `AI 后续处理失败：${message}`);
      }
      throw error;
    } finally {
      if (runId) {
        context.stopThinking(runId);
        removeRunController(context.chatAbortByRunIdRef, runId);
        clearActiveStreamRun(context.setActiveStreamRunIdsByConversationKey, conversationKey, runId);
      }
      setSubmittingHumanInputRequestIds((current) => {
        if (!current.has(requestId)) return current;
        const next = new Set(current);
        next.delete(requestId);
        return next;
      });
      setSubmittingHumanInputByRequestId((current) => {
        if (!(requestId in current)) return current;
        const next = { ...current };
        delete next[requestId];
        return next;
      });
    }
  }, [context]);

  return {
    startChat,
    startApproval,
    startHumanInput,
    submittingApprovalIds,
    submittingHumanInputRequestIds,
    submittingHumanInputByRequestId,
  };
}
