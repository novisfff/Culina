import type { AiMessage, AiMessagePart, AiRunEvent } from '../../../api/types/ai';
import { isPendingHumanInputPart } from '../aiWorkspaceHelpers';

export function getLocalPendingRunId(conversationKey: string, messages: AiMessage[]) {
  return messages.find((message) => message.role === 'assistant' && message.run_id)?.run_id
    ?? conversationKey.replace(/^pending-conversation-/, '');
}

export function hasRenderableMessageContent(message: AiMessage) {
  return Boolean(message.content?.trim())
    || message.parts.some((part) => part.type !== 'text' || Boolean(part.text?.trim()));
}

export function isActiveStreamProgressStatus(status: AiRunEvent['status']) {
  return status === 'pending' || status === 'running' || status === 'waiting';
}

export function isUnfinishedConversationStatus(status: string | null | undefined) {
  return ['pending', 'running', 'waiting_approval', 'waiting_input'].includes((status ?? '').toLowerCase());
}

export function isCompletedToolProgress(event: AiRunEvent) {
  return event.status === 'completed' && (event.type === 'tool' || event.type === 'script');
}

export function shouldStopThinkingForPart(part: AiMessagePart) {
  if (part.type === 'draft' || part.type === 'approval_request') return true;
  if (part.type === 'human_input_request') return isPendingHumanInputPart(part);
  return part.type === 'run_activity' && part.activity
    ? isActiveStreamProgressStatus(part.activity.status)
    : false;
}

export function shouldStartThinkingAfterPart(part: AiMessagePart) {
  return part.type === 'run_activity' && part.activity ? isCompletedToolProgress(part.activity) : false;
}

export function isApprovalDecisionSettledPart(part: AiMessagePart, approvalId: string) {
  if (part.type === 'approval_request' && part.approval?.id === approvalId) {
    return part.approval.status !== 'pending';
  }
  if (part.type !== 'result_card' || part.card?.type !== 'operation_result') return false;
  const data = part.card.data;
  if (!data || typeof data !== 'object' || !('approvalId' in data)) return false;
  return String((data as { approvalId?: unknown }).approvalId ?? '') === approvalId;
}

export function collectSettledApprovalIds(messages: AiMessage[]) {
  const settledApprovalIds = new Set<string>();
  for (const message of messages) {
    for (const part of message.parts) {
      if (part.approval?.id && part.approval.status !== 'pending') {
        settledApprovalIds.add(part.approval.id);
      }
      if (part.type === 'result_card' && part.card?.type === 'operation_result') {
        const data = part.card.data;
        const approvalId = data && typeof data === 'object' && 'approvalId' in data
          ? String((data as { approvalId?: unknown }).approvalId ?? '')
          : '';
        if (approvalId) settledApprovalIds.add(approvalId);
      }
    }
  }
  return settledApprovalIds;
}
