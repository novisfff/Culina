import { useCallback, useState } from 'react';
import { api } from '../../api/client';
import { isExpectedAiStreamAbort } from '../../lib/aiStreamAbort';
import { isSuccessfulOperationResultCard } from './aiWorkspaceHelpers';
import {
  buildStreamProgressEvent,
  clearActiveStreamRun,
  handleInaccessibleStreamError,
  removeRunController,
  type StreamMutationContext,
} from './aiStreamSupport';
import type { ApprovalStreamPayload } from './useAiConversationStreams';

function isSuccessfulApprovalResultPart(part: { type?: unknown; card?: unknown }, approvalId: string) {
  if (part.type !== 'result_card' || !part.card || typeof part.card !== 'object') return false;
  const card = part.card as { type?: unknown; data?: Record<string, unknown> };
  const approval = card.data?.approvalId ?? card.data?.approval_id;
  return String(approval ?? '') === approvalId && isSuccessfulOperationResultCard(card as never);
}

function responseHasSuccessfulApprovalResult(response: { message?: { parts?: Array<{ type?: unknown; card?: unknown }> }; included?: { result_cards?: Array<unknown> } }, approvalId: string) {
  if (response.message?.parts?.some((part) => isSuccessfulApprovalResultPart(part, approvalId))) return true;
  return response.included?.result_cards?.some((card) => {
    if (!card || typeof card !== 'object') return false;
    const value = card as { data?: Record<string, unknown> };
    const approval = value.data?.approvalId ?? value.data?.approval_id;
    return String(approval ?? '') === approvalId && isSuccessfulOperationResultCard(card as never);
  }) ?? false;
}

export function useAiApprovalStream(context: StreamMutationContext) {
  const [submittingApprovalIds, setSubmittingApprovalIds] = useState<Set<string>>(() => new Set());

  const startApproval = useCallback(async (payload: ApprovalStreamPayload) => {
    const controller = new AbortController();
    const conversationKey = payload.approval.conversation_id;
    const runId = payload.approval.run_id;
    const approvalId = payload.approval.id;
    if (runId && context.activeStreamRunIdsByConversationKey[conversationKey] === runId) {
      throw new Error('当前确认结果已经在处理中，请稍后查看结果。');
    }
    setSubmittingApprovalIds((current) => new Set(current).add(approvalId));
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

    let settleResult: (() => void) | null = null;
    let rejectResult: ((error: unknown) => void) | null = null;
    let settled = false;
    const decisionResultVisible = new Promise<void>((resolve, reject) => {
      settleResult = resolve;
      rejectResult = reject;
    });
    const settle = () => {
      if (settled) return;
      settled = true;
      settleResult?.();
    };
    const reject = (error: unknown) => {
      if (settled) return;
      settled = true;
      rejectResult?.(error);
    };
    const decisionPayload = {
      decision: payload.decision,
      draft_version: payload.approval.draft_version,
      values: payload.values,
      comment: payload.comment,
    };

    let successfulOperationResultReceived = false;
    try {
      void api.streamAiApprovalDecision(conversationKey, approvalId, decisionPayload, {
        signal: controller.signal,
        onTimelineEvent: (event) => context.onTimelineEvent?.(event, conversationKey),
        onProgress: (event) => {
          const nextEvent = buildStreamProgressEvent(event, runId, 'approval-stream');
          if (!context.streamMessageTargetRef.current[nextEvent.run_id]) {
            context.ensureStreamingAssistantMessage(nextEvent.run_id, conversationKey);
          }
          context.updateThinkingForProgressEvent(nextEvent, runId);
          context.upsertStreamProgressEvent(nextEvent);
        },
        onMessagePart: (event) => {
          if (isSuccessfulApprovalResultPart(event.part, approvalId)) successfulOperationResultReceived = true;
          context.applyStreamPart(event, conversationKey);
          if (context.isApprovalDecisionSettledPart(event.part, approvalId)) settle();
        },
        onMessageDelta: (event) => context.applyStreamDelta(event, conversationKey),
        onResponse: (response) => {
          if (responseHasSuccessfulApprovalResult(response, approvalId)) successfulOperationResultReceived = true;
        },
      }).then((response) => {
        context.applyChatResponse(response, conversationKey, runId ?? response.run.id);
        settle();
      }).catch(async (error) => {
        if (isExpectedAiStreamAbort(error, controller.signal)) {
          try {
            await context.refreshAfterApprovalSettled();
          } catch {
            // Refresh is best effort after the stream has ended.
          }
          if (successfulOperationResultReceived || context.hasSuccessfulOperationResultForRun(runId)) settle();
          else reject(error);
          return;
        }
        let operationResultPersisted = successfulOperationResultReceived || context.hasSuccessfulOperationResultForRun(runId);
        if (!operationResultPersisted) {
          try {
            await context.refreshAfterApprovalSettled();
            operationResultPersisted = context.hasSuccessfulOperationResultForRun(runId);
          } catch {
            // Retain the original stream error when refresh fails.
          }
        }
        const inaccessibleConversation = operationResultPersisted
          ? false
          : handleInaccessibleStreamError(context, error, conversationKey);
        if (!inaccessibleConversation && !operationResultPersisted) {
          context.stopThinking(runId);
          context.markStreamingAssistantStopped(runId ?? null, `AI 处理失败：${context.streamFailureMessage(error)}`);
        }
        void context.refreshAfterApprovalSettled();
        if (operationResultPersisted) settle();
        else reject(error);
      }).finally(() => {
        if (runId) {
          context.stopThinking(runId);
          removeRunController(context.chatAbortByRunIdRef, runId);
          clearActiveStreamRun(context.setActiveStreamRunIdsByConversationKey, conversationKey, runId);
        }
        void context.refreshAfterApprovalSettled();
      });
      await decisionResultVisible;
    } finally {
      setSubmittingApprovalIds((current) => {
        const next = new Set(current);
        next.delete(approvalId);
        return next;
      });
      void context.refreshAfterApprovalSettled();
    }
  }, [context]);

  return { startApproval, submittingApprovalIds };
}
