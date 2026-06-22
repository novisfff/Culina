import type { AiApprovalRequest, AiChatResponse, AiMessage, AiMessagePart, AiRunEvent } from '../../api/types';

export function TrashIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path d="M3 6h18" />
      <path d="M8 6V4h8v2" />
      <path d="m19 6-1 14H6L5 6" />
      <path d="M10 11v6" />
      <path d="M14 11v6" />
    </svg>
  );
}

export function isPendingHumanInputPart(part: AiMessagePart) {
  if (part.type !== 'human_input_request' || !part.request) return false;
  return (part.status ?? 'pending') === 'pending';
}

export function mergePendingApprovalsIntoMessages(messages: AiMessage[], approvals: AiApprovalRequest[]): AiMessage[] {
  const embeddedApprovalIds = new Set(
    messages.flatMap((message) => message.parts.map((part) => part.approval?.id).filter((id): id is string => Boolean(id))),
  );
  const missingApprovals = approvals.filter((approval) => !embeddedApprovalIds.has(approval.id));
  if (missingApprovals.length === 0) return messages;

  const approvalsByMessageId = new Map<string, AiApprovalRequest[]>();
  for (const approval of missingApprovals) {
    if (!approval.message_id) continue;
    const items = approvalsByMessageId.get(approval.message_id) ?? [];
    items.push(approval);
    approvalsByMessageId.set(approval.message_id, items);
  }

  const merged = messages.map((message) => {
    const messageApprovals = approvalsByMessageId.get(message.id) ?? [];
    if (messageApprovals.length === 0) return message;
    approvalsByMessageId.delete(message.id);
    return {
      ...message,
      content_type: 'parts',
      parts: [
        ...message.parts,
        ...messageApprovals.map((approval) => ({
          id: `restored-approval-part-${approval.id}`,
          type: 'approval_request' as const,
          approval,
        })),
      ],
    };
  });

  const orphanedApprovalGroups = new Map<string, AiApprovalRequest[]>();
  for (const approval of missingApprovals) {
    if (approval.message_id && !approvalsByMessageId.has(approval.message_id)) continue;
    const groupId = approval.message_id ?? `restored-approval-message-${approval.id}`;
    orphanedApprovalGroups.set(groupId, [...(orphanedApprovalGroups.get(groupId) ?? []), approval]);
  }
  const syntheticMessages = Array.from(orphanedApprovalGroups, ([messageId, messageApprovals]): AiMessage => {
    const firstApproval = messageApprovals[0];
    return {
      id: messageId,
      conversation_id: firstApproval.conversation_id,
      role: 'assistant',
      content: firstApproval.instruction || '请确认以下操作。',
      content_type: 'parts',
      parts: messageApprovals.map((approval) => ({
        id: `restored-approval-part-${approval.id}`,
        type: 'approval_request',
        approval,
      })),
      run_id: firstApproval.run_id,
      status: 'completed',
      metadata: { restoredApproval: true },
      created_at: firstApproval.created_at,
    };
  });

  return [...merged, ...syntheticMessages];
}

export function normalizeStreamEventForFinalRun(event: AiRunEvent, response: AiChatResponse): AiRunEvent {
  const status =
    response.run.status === 'completed' && (event.status === 'pending' || event.status === 'running')
      ? 'completed'
      : event.status;
  return { ...event, run_id: response.run.id, status };
}

export function attachIncludedApprovalsToMessage(message: AiMessage, approvals: AiApprovalRequest[]): AiMessage {
  const relatedApprovals = approvals.filter((approval) => {
    if (approval.message_id) return approval.message_id === message.id;
    if (approval.run_id && message.run_id) return approval.run_id === message.run_id;
    return approval.conversation_id === message.conversation_id;
  });
  if (relatedApprovals.length === 0) return message;
  const embeddedApprovalIds = new Set(message.parts.map((part) => part.approval?.id).filter((id): id is string => Boolean(id)));
  const missingApprovals = relatedApprovals.filter((approval) => !embeddedApprovalIds.has(approval.id));
  if (missingApprovals.length === 0) return message;
  return {
    ...message,
    content_type: 'parts',
    parts: [
      ...message.parts,
      ...missingApprovals.map((approval) => ({
        id: `included-approval-part-${approval.id}`,
        type: 'approval_request' as const,
        approval,
      })),
    ],
  };
}

export function createLocalAssistantMessage(runId: string, conversationId: string | null): AiMessage {
  return {
    id: `local-assistant-${runId}`,
    conversation_id: conversationId || 'pending',
    role: 'assistant',
    content: '',
    content_type: 'parts',
    parts: [],
    run_id: runId,
    status: 'running',
    metadata: {},
    created_at: new Date().toISOString(),
  };
}

export function appendAssistantDelta(currentText: string, delta: string, shouldSeparate: boolean) {
  if (
    !shouldSeparate
    || !currentText.trim()
    || currentText.endsWith('\n\n')
    || delta.startsWith('\n')
  ) {
    return `${currentText}${delta}`;
  }
  return `${currentText}\n\n${delta}`;
}

export function messageTextFromParts(parts: AiMessage['parts']) {
  return parts
    .filter((part) => part.type === 'text' && part.text?.trim())
    .map((part) => part.text?.trim() ?? '')
    .join('\n\n');
}

export function appendDeltaToMessageParts(
  parts: AiMessage['parts'],
  delta: string,
  partId: string,
  _shouldSeparate: boolean,
  appendAfterNonText: boolean,
) {
  const existingContinuation = parts.find((part) => part.type === 'text' && part.id === partId);
  if (existingContinuation) {
    return parts.map((part) =>
      part.id === partId && part.type === 'text'
        ? { ...part, text: appendAssistantDelta(part.text ?? '', delta, false) }
        : part,
    );
  }
  if (appendAfterNonText || parts.length > 0) {
    return [...parts, { id: partId, type: 'text' as const, text: delta }];
  }
  return [{ id: partId, type: 'text' as const, text: delta }];
}
