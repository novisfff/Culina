import type { AiApprovalRequest, AiChatResponse, AiMessage, AiMessagePart, AiRunEvent } from '../../api/types';

type MergeMessageOptions = {
  preferLocalOrder?: boolean;
};

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

export function hasOutputAfterHumanInputRequest(message: AiMessage, requestId: string) {
  let hasSeenRequest = false;
  for (const part of message.parts) {
    if (part.type === 'human_input_request' && part.request?.id === requestId) {
      hasSeenRequest = true;
      continue;
    }
    if (!hasSeenRequest) continue;
    if (part.type === 'text') {
      if (part.text?.trim()) return true;
      continue;
    }
    if (part.type === 'run_activity') return Boolean(part.activity);
    if (part.type === 'image') return Boolean(part.image);
    return Boolean(part.card || part.draft || part.approval || part.request);
  }
  return false;
}

function hasRenderableMessageContent(message: AiMessage) {
  return Boolean(message.content?.trim()) || message.parts.some((part) => part.type !== 'text' || Boolean(part.text?.trim()));
}

function messageTextLength(message: AiMessage) {
  const partsLength = message.parts
    .filter((part) => part.type === 'text' && part.text)
    .reduce((total, part) => total + (part.text?.length ?? 0), 0);
  return partsLength || message.content?.length || 0;
}

function hasStructurePart(message: AiMessage) {
  return message.parts.some((part) => part.type !== 'text');
}

function hasOnlyTextParts(message: AiMessage) {
  return message.parts.length > 0 && message.parts.every((part) => part.type === 'text');
}

export function extractRunActivitySkillName(event: AiRunEvent | undefined) {
  if (!event) return '任务规划';
  const match = event.user_message.match(/「(.+?)」技能/);
  if (match?.[1]) return match[1];
  return event.user_message.replace(/(?:执行完成|等待补充信息|等待补充)$/, '').trim() || event.user_message;
}

export function isDraftRunActivityEvent(event: AiRunEvent) {
  return event.internal_code.includes('.create_draft') || event.user_message.startsWith('生成「');
}

export function runActivityCollapseKey(event: AiRunEvent) {
  if (event.type === 'skill') return `skill:${extractRunActivitySkillName(event)}`;
  if (event.type === 'tool' || event.type === 'script') {
    return event.id ? `${event.type}:${event.id}` : `${event.type}:${event.internal_code || event.user_message}`;
  }
  return '';
}

export function messagePartKey(part: AiMessagePart) {
  if (part.type === 'approval_request' && part.approval?.id) return `approval:${part.approval.id}`;
  if (part.type === 'draft' && part.draft?.id) return `draft:${part.draft.id}`;
  if (part.type === 'result_card' && part.card?.id) return `card:${part.card.id}`;
  if (part.type === 'human_input_request' && part.request?.id) return `human-input:${part.request.id}`;
  if (part.type === 'run_activity' && part.activity) {
    const collapseKey = runActivityCollapseKey(part.activity);
    if (collapseKey) return `activity:${collapseKey}`;
  }
  if (part.type === 'run_activity' && part.id) return `activity-part:${part.id}`;
  if (part.type === 'run_activity' && part.activity?.id) return `activity:${part.activity.id}`;
  return `part:${part.id}`;
}

function approvalStatusRank(status: string | null | undefined) {
  if (status === 'approved' || status === 'rejected') return 3;
  if (status === 'expired' || status === 'cancelled') return 2;
  if (status === 'pending') return 1;
  return 0;
}

export function runActivityStatusRank(status: string | null | undefined) {
  if (status === 'completed' || status === 'failed') return 3;
  if (status === 'running' || status === 'waiting') return 2;
  if (status === 'pending') return 1;
  return 0;
}

export function runActivityTimeValue(event: AiRunEvent) {
  const value = new Date(event.created_at).getTime();
  return Number.isNaN(value) ? 0 : value;
}

export function preferredRunActivityEvent(current: AiRunEvent, next: AiRunEvent) {
  const currentRank = runActivityStatusRank(current.status);
  const nextRank = runActivityStatusRank(next.status);
  if (nextRank !== currentRank) return nextRank > currentRank ? next : current;
  return runActivityTimeValue(next) >= runActivityTimeValue(current) ? next : current;
}

export function mergeMessagePart(primary: AiMessagePart, secondary: AiMessagePart): AiMessagePart {
  if (primary.type === 'text' && secondary.type === 'text') {
    return (secondary.text?.length ?? 0) > (primary.text?.length ?? 0) ? secondary : primary;
  }
  if (primary.type === 'approval_request' && secondary.type === 'approval_request') {
    return approvalStatusRank(secondary.approval?.status) >= approvalStatusRank(primary.approval?.status)
      ? secondary
      : primary;
  }
  if (primary.type === 'run_activity' && secondary.type === 'run_activity') {
    if (!primary.activity || !secondary.activity) return secondary.activity ? secondary : primary;
    return {
      ...secondary,
      activity: preferredRunActivityEvent(primary.activity, secondary.activity),
    };
  }
  return secondary;
}

function messageTextPartToAppend(existingParts: AiMessagePart[], part: AiMessagePart) {
  if (part.type !== 'text') return part;
  const text = part.text?.trim();
  if (!text) return null;
  const existingText = messageTextFromParts(existingParts).trim();
  if (!existingText) return part;
  if (text === existingText || existingText.startsWith(text)) return null;
  const normalizedText = text.replace(/\s+/g, ' ');
  const normalizedExistingText = existingText.replace(/\s+/g, ' ');
  if (normalizedText.length >= 12 && normalizedExistingText.includes(normalizedText)) return null;
  if (text.startsWith(existingText)) {
    const remainingText = text.slice(existingText.length).trim();
    return remainingText ? { ...part, text: remainingText } : null;
  }
  return part;
}

function compactMessageText(value: string) {
  return value.replace(/\s+/g, '');
}

function sliceAfterCompactPrefix(text: string, compactPrefixLength: number) {
  if (compactPrefixLength <= 0) return text;
  let consumed = 0;
  for (let index = 0; index < text.length; index += 1) {
    if (/\s/.test(text[index])) continue;
    consumed += 1;
    if (consumed >= compactPrefixLength) {
      return text.slice(index + 1);
    }
  }
  return '';
}

function findTrailingTextPartIndex(parts: AiMessagePart[]) {
  for (let index = parts.length - 1; index >= 0; index -= 1) {
    const part = parts[index];
    if (part.type === 'text' && part.text?.trim()) return index;
  }
  return -1;
}

function completedTrailingTextParts(existingParts: AiMessagePart[], part: AiMessagePart) {
  if (part.type !== 'text') return null;
  const text = part.text?.trim();
  if (!text) return null;
  const trailingTextIndex = findTrailingTextPartIndex(existingParts);
  if (trailingTextIndex < 0 || !existingParts.slice(0, trailingTextIndex).some((item) => item.type !== 'text')) {
    return null;
  }
  const trailingTextPart = existingParts[trailingTextIndex];
  if (trailingTextPart.type !== 'text') return null;
  const trailingText = trailingTextPart.text?.trim() ?? '';
  const compactText = compactMessageText(text);
  const compactTrailingText = compactMessageText(trailingText);
  if (compactText.length > compactTrailingText.length && compactText.startsWith(compactTrailingText)) {
    return existingParts.map((item, index) => (index === trailingTextIndex ? { ...item, text } : item));
  }
  const existingText = messageTextFromParts(existingParts).trim();
  const compactExistingText = compactMessageText(existingText);
  if (compactText.length > compactExistingText.length && compactText.startsWith(compactExistingText)) {
    const suffix = sliceAfterCompactPrefix(text, compactExistingText.length).trim();
    if (!suffix) return existingParts;
    return existingParts.map((item, index) => (
      index === trailingTextIndex && item.type === 'text'
        ? { ...item, text: appendAssistantDelta(item.text ?? '', suffix, false) }
        : item
    ));
  }
  return null;
}

function mergeMessageParts(primary: AiMessage, secondary: AiMessage) {
  const secondaryPartsByKey = new Map(secondary.parts.map((part) => [messagePartKey(part), part]));
  const primaryPartKeys = new Set(primary.parts.map(messagePartKey));
  const primaryHasText = primary.parts.some((part) => part.type === 'text' && part.text?.trim());
  const primaryHasStructure = hasStructurePart(primary);
  const primaryText = messageTextFromParts(primary.parts);
  let parts = primary.parts.map((part) => {
    const secondaryPart = secondaryPartsByKey.get(messagePartKey(part));
    return secondaryPart ? mergeMessagePart(part, secondaryPart) : part;
  });
  for (const part of secondary.parts) {
    if (part.type === 'text' && primaryHasText && primaryHasStructure && part.text?.trim() === primaryText.trim()) continue;
    if (!primaryPartKeys.has(messagePartKey(part))) {
      const completedParts = completedTrailingTextParts(parts, part);
      if (completedParts) {
        parts = completedParts;
        continue;
      }
      const partToAppend = messageTextPartToAppend(parts, part);
      if (partToAppend) parts.push(partToAppend);
    }
  }
  return dedupeTextParts(parts);
}

function dedupeTextParts(parts: AiMessagePart[]) {
  const nextParts: AiMessagePart[] = [];
  let seenText = '';
  for (const part of parts) {
    if (part.type !== 'text') {
      nextParts.push(part);
      continue;
    }
    const text = part.text?.trim();
    if (!text) continue;
    const normalizedText = text.replace(/\s+/g, ' ');
    const normalizedSeenText = seenText.replace(/\s+/g, ' ');
    if (normalizedText.length >= 12 && normalizedSeenText.includes(normalizedText)) continue;
    nextParts.push(part);
    seenText = messageTextFromParts(nextParts);
  }
  return nextParts;
}

function mergeMessageStatus(remote: AiMessage, local: AiMessage, parts: AiMessagePart[]) {
  if (parts.some((part) => part.type === 'approval_request' && part.approval?.status === 'pending')) return 'waiting_approval';
  if (parts.some(isPendingHumanInputPart)) return 'waiting_input';
  if (remote.status === 'failed' || local.status === 'failed') return 'failed';
  if (remote.status === 'cancelled' || local.status === 'cancelled') return 'cancelled';
  if (remote.status === 'completed' || local.status === 'completed') return 'completed';
  if (remote.status === 'running' || local.status === 'running') return 'running';
  return remote.status || local.status;
}

function hasCanonicalStreamOrder(message: AiMessage) {
  return Boolean((message.metadata as Record<string, unknown> | undefined)?.streamOrderCanonical);
}

function isApprovalContinuationAppendOnly(remote: AiMessage, local: AiMessage) {
  if (local.status !== 'running') return false;
  if (!remote.parts.some((part) => part.type === 'approval_request')) return false;
  const remotePartKeys = new Set(remote.parts.map(messagePartKey));
  return local.parts.length > 0 && local.parts.every((part) => !remotePartKeys.has(messagePartKey(part)));
}

export function mergeRemoteAndLocalMessage(remote: AiMessage, local: AiMessage, options: MergeMessageOptions = {}): AiMessage {
  if (!hasRenderableMessageContent(local)) return remote;
  if (!hasRenderableMessageContent(remote)) return local;
  const remoteHasStructure = hasStructurePart(remote);
  const localHasStructure = hasStructurePart(local);
  if (remoteHasStructure || localHasStructure) {
    const shouldAppendLocalAfterRemote = isApprovalContinuationAppendOnly(remote, local);
    const preferLocalOrder = !shouldAppendLocalAfterRemote && (
      options.preferLocalOrder
      || hasCanonicalStreamOrder(local)
      || local.status === 'running'
      || local.status === 'waiting_input'
      || local.status === 'waiting_approval'
      || (localHasStructure && hasOnlyTextParts(remote))
    );
    const parts = preferLocalOrder ? mergeMessageParts(local, remote) : mergeMessageParts(remote, local);
    return {
      ...remote,
      status: mergeMessageStatus(remote, local, parts),
      content_type: 'parts',
      content: messageTextFromParts(parts) || remote.content || local.content,
      parts,
    };
  }
  return messageTextLength(remote) >= messageTextLength(local) ? remote : local;
}

export function mergePendingApprovalsIntoMessages(messages: AiMessage[], approvals: AiApprovalRequest[]): AiMessage[] {
  const pendingApprovalsById = new Map(approvals.map((approval) => [approval.id, approval]));
  const messagesWithFreshApprovals = messages.map((message) => {
    let hasConfirmedPendingApproval = false;
    let changed = false;
    const parts = message.parts.map((part) => {
      if (part.type !== 'approval_request' || !part.approval?.id) return part;
      const pendingApproval = pendingApprovalsById.get(part.approval.id);
      if (!pendingApproval) return part;
      hasConfirmedPendingApproval = true;
      if (part.approval === pendingApproval) return part;
      changed = true;
      return { ...part, approval: pendingApproval };
    });
    const nextStatus = hasConfirmedPendingApproval && message.status !== 'waiting_approval'
      ? 'waiting_approval'
      : message.status;
    if (!changed && nextStatus === message.status) return message;
    return {
      ...message,
      content_type: 'parts' as const,
      status: nextStatus,
      parts,
    };
  });
  const embeddedApprovalIds = new Set(
    messagesWithFreshApprovals.flatMap((message) => message.parts.map((part) => part.approval?.id).filter((id): id is string => Boolean(id))),
  );
  const missingApprovals = approvals.filter((approval) => !embeddedApprovalIds.has(approval.id));
  if (missingApprovals.length === 0) return messagesWithFreshApprovals;

  const approvalsByMessageId = new Map<string, AiApprovalRequest[]>();
  for (const approval of missingApprovals) {
    if (!approval.message_id) continue;
    const items = approvalsByMessageId.get(approval.message_id) ?? [];
    items.push(approval);
    approvalsByMessageId.set(approval.message_id, items);
  }

  const merged = messagesWithFreshApprovals.map((message) => {
    const messageApprovals = approvalsByMessageId.get(message.id) ?? [];
    if (messageApprovals.length === 0) return message;
    approvalsByMessageId.delete(message.id);
    return {
      ...message,
      content_type: 'parts',
      status: messageApprovals.some((approval) => approval.status === 'pending') ? 'waiting_approval' : message.status,
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
      status: messageApprovals.some((approval) => approval.status === 'pending') ? 'waiting_approval' : 'completed',
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
  const existingPartIndex = parts.findIndex((part) => part.type === 'text' && part.id === partId);
  const continuationPrefix = `continuation-${partId}`;
  const isContinuationPartId = (id: string) => id === continuationPrefix || id.startsWith(`${continuationPrefix}-`);
  const lastPart = parts[parts.length - 1];
  const canAppendToLastText =
    lastPart?.type === 'text'
    && (isContinuationPartId(lastPart.id) || (!appendAfterNonText && lastPart.id === partId));
  const nextContinuationPartId = () => {
    let candidate = continuationPrefix;
    let suffix = 2;
    const existingIds = new Set(parts.map((part) => part.id));
    while (existingIds.has(candidate)) {
      candidate = `${continuationPrefix}-${suffix}`;
      suffix += 1;
    }
    return candidate;
  };
  const shouldAppendAtTail = existingPartIndex >= 0 && (existingPartIndex < parts.length - 1 || appendAfterNonText);
  const effectivePartId = canAppendToLastText
    ? lastPart.id
    : appendAfterNonText
      ? nextContinuationPartId()
    : shouldAppendAtTail
      ? nextContinuationPartId()
      : partId;
  const existingContinuation = parts.find((part) => part.type === 'text' && part.id === effectivePartId);
  if (existingContinuation) {
    return parts.map((part) =>
      part.id === effectivePartId && part.type === 'text'
        ? { ...part, text: appendAssistantDelta(part.text ?? '', delta, false) }
        : part,
    );
  }
  if (appendAfterNonText || parts.length > 0) {
    return [...parts, { id: effectivePartId, type: 'text' as const, text: delta }];
  }
  return [{ id: effectivePartId, type: 'text' as const, text: delta }];
}
