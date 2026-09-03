import type {
  AiConversationReplay,
  AiConversationSnapshot,
  AiMessage,
  AiMessagePart,
  AiTimelineEvent,
} from '../../api/types';

export type AiTimelineState = {
  conversationId: string;
  messagesById: Record<string, AiMessage>;
  messageOrder: string[];
  lastSequence: number;
  seenEventIds: Set<string>;
  activeRunId: string | null;
  gap: { from: number; to: number } | null;
  integrityError: string | null;
  terminalMessageIds: Set<string>;
};

export type AiTimelineApplyResult = {
  state: AiTimelineState;
  needsReplay: boolean;
};

function clonePart(part: AiMessagePart): AiMessagePart {
  return { ...part };
}

function cloneMessage(message: AiMessage): AiMessage {
  return {
    ...message,
    metadata: { ...(message.metadata ?? {}) },
    parts: (message.parts ?? []).map(clonePart),
  };
}

function messageFromPayload(value: unknown): AiMessage | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const candidate = value as Partial<AiMessage>;
  if (typeof candidate.id !== 'string' || !candidate.id || typeof candidate.conversation_id !== 'string') return null;
  if (!Array.isArray(candidate.parts) || typeof candidate.role !== 'string' || typeof candidate.status !== 'string') return null;
  return cloneMessage(candidate as AiMessage);
}

function aggregateText(parts: AiMessagePart[]) {
  return parts
    .filter((part) => part.type === 'text' && Boolean(part.text?.trim()))
    .map((part) => part.text?.trim() ?? '')
    .join('\n\n');
}

function replaceMessage(
  state: AiTimelineState,
  messageId: string,
  updater: (message: AiMessage) => AiMessage,
): AiTimelineState | null {
  const current = state.messagesById[messageId];
  if (!current) return null;
  const nextMessage = updater(cloneMessage(current));
  return {
    ...state,
    messagesById: { ...state.messagesById, [messageId]: nextMessage },
  };
}

function insertMessageOrder(state: AiTimelineState, message: AiMessage) {
  if (state.messageOrder.includes(message.id)) return state.messageOrder;
  const position = Number(message.timeline_position ?? 0);
  if (!position) return [...state.messageOrder, message.id];
  const index = state.messageOrder.findIndex((id) => {
    const existing = state.messagesById[id];
    return Number(existing?.timeline_position ?? 0) > position;
  });
  if (index < 0) return [...state.messageOrder, message.id];
  return [...state.messageOrder.slice(0, index), message.id, ...state.messageOrder.slice(index)];
}

function withIntegrityError(state: AiTimelineState, message: string): AiTimelineApplyResult {
  return {
    state: { ...state, integrityError: message },
    needsReplay: true,
  };
}

function eventPart(event: AiTimelineEvent) {
  const part = event.payload?.part;
  if (!part || typeof part !== 'object' || Array.isArray(part)) return null;
  const candidate = part as AiMessagePart;
  const partId = String(candidate.id ?? event.part_id ?? '');
  if (!partId || !candidate.type) return null;
  return { ...candidate, id: partId };
}

function applyPayload(state: AiTimelineState, event: AiTimelineEvent): AiTimelineApplyResult {
  const messageId = event.message_id ?? '';
  if (event.event_type === 'message.created') {
    const message = messageFromPayload(event.payload?.message);
    if (!message) return withIntegrityError(state, 'message.created missing message payload');
    if (message.conversation_id !== state.conversationId) {
      return withIntegrityError(state, 'message.created belongs to another conversation');
    }
    const existing = state.messagesById[message.id];
    const messagesById = { ...state.messagesById, [message.id]: message };
    const nextState = { ...state, messagesById };
    return {
      state: {
        ...nextState,
        messageOrder: existing ? state.messageOrder : insertMessageOrder(nextState, message),
        activeRunId: message.run_id ?? state.activeRunId,
      },
      needsReplay: false,
    };
  }

  if (!messageId || !state.messagesById[messageId]) {
    return withIntegrityError(state, `unknown message: ${messageId || '(missing)'}`);
  }
  if (state.terminalMessageIds.has(messageId) && event.event_type !== 'run.terminal') {
    return withIntegrityError(state, `visible event after terminal message: ${messageId}`);
  }

  if (event.event_type === 'part.appended') {
    const part = eventPart(event);
    if (!part) return withIntegrityError(state, 'part.appended missing part payload');
    const current = state.messagesById[messageId];
    if (current.parts.some((item) => item.id === part.id)) {
      return withIntegrityError(state, `duplicate part id: ${part.id}`);
    }
    const nextState = replaceMessage(state, messageId, (message) => {
      const parts = [...message.parts, part];
      return { ...message, content: aggregateText(parts) || message.content, content_type: 'parts', parts };
    });
    return nextState ? { state: nextState, needsReplay: false } : withIntegrityError(state, `unknown message: ${messageId}`);
  }

  if (event.event_type === 'part.delta') {
    const partId = event.part_id ?? '';
    const delta = event.payload?.delta;
    if (!partId || typeof delta !== 'string') return withIntegrityError(state, 'part.delta missing target or delta');
    const current = state.messagesById[messageId];
    const index = current.parts.findIndex((part) => part.id === partId);
    if (index < 0) return withIntegrityError(state, `unknown part id: ${partId}`);
    if (current.parts[index]?.type !== 'text') return withIntegrityError(state, `part.delta target is not text: ${partId}`);
    const nextState = replaceMessage(state, messageId, (message) => {
      const parts = message.parts.map((part, partIndex) => partIndex === index ? { ...part, text: `${part.text ?? ''}${delta}` } : part);
      return { ...message, content: aggregateText(parts), content_type: 'parts', parts };
    });
    return nextState ? { state: nextState, needsReplay: false } : withIntegrityError(state, `unknown message: ${messageId}`);
  }

  if (event.event_type === 'part.replaced') {
    const partId = event.part_id ?? '';
    if (!partId) return withIntegrityError(state, 'part.replaced missing target part');
    const current = state.messagesById[messageId];
    const index = current.parts.findIndex((part) => part.id === partId);
    if (index < 0) return withIntegrityError(state, `unknown part id: ${partId}`);
    const replacement = eventPart(event);
    const patch = event.payload?.patch;
    if (!replacement && (!patch || typeof patch !== 'object' || Array.isArray(patch))) {
      return withIntegrityError(state, 'part.replaced missing replacement payload');
    }
    const nextState = replaceMessage(state, messageId, (message) => {
      const nextPart = replacement ?? { ...message.parts[index], ...(patch as Partial<AiMessagePart>) };
      const parts = message.parts.map((part, partIndex) => partIndex === index ? { ...nextPart, id: partId } : part);
      return { ...message, content: aggregateText(parts) || message.content, content_type: 'parts', parts };
    });
    return nextState ? { state: nextState, needsReplay: false } : withIntegrityError(state, `unknown message: ${messageId}`);
  }

  if (event.event_type === 'message.metadata') {
    const metadata = event.payload?.metadata;
    if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return withIntegrityError(state, 'message.metadata missing metadata payload');
    const nextState = replaceMessage(state, messageId, (message) => ({ ...message, metadata: { ...(metadata as Record<string, unknown>) } }));
    return nextState ? { state: nextState, needsReplay: false } : withIntegrityError(state, `unknown message: ${messageId}`);
  }

  if (event.event_type === 'message.status') {
    const status = event.payload?.status;
    if (typeof status !== 'string') return withIntegrityError(state, 'message.status missing status payload');
    const nextState = replaceMessage(state, messageId, (message) => ({ ...message, status }));
    return nextState ? { state: nextState, needsReplay: false } : withIntegrityError(state, `unknown message: ${messageId}`);
  }

  if (event.event_type === 'run.terminal') {
    const terminalMessage = messageFromPayload(event.payload?.message);
    const status = typeof event.payload?.status === 'string' ? event.payload.status : undefined;
    const nextState = replaceMessage(state, messageId, (message) => {
      const next = terminalMessage ?? (status ? { ...message, status } : message);
      const content = aggregateText(next.parts);
      return content ? { ...next, content, content_type: 'parts' } : next;
    });
    if (!nextState) return withIntegrityError(state, `unknown message: ${messageId}`);
    return {
      state: {
        ...nextState,
        terminalMessageIds: new Set([...state.terminalMessageIds, messageId]),
        activeRunId: state.activeRunId === event.run_id ? null : state.activeRunId,
      },
      needsReplay: false,
    };
  }

  return withIntegrityError(state, `unknown timeline event type: ${event.event_type}`);
}

export function createAiTimelineState(
  snapshot: AiConversationSnapshot | AiMessage[],
  conversationIdOverride?: string,
): AiTimelineState {
  const isSnapshot = !Array.isArray(snapshot);
  const messages = (isSnapshot ? snapshot.messages : snapshot).map(cloneMessage);
  const messagesById: Record<string, AiMessage> = {};
  messages.forEach((message) => { messagesById[message.id] = message; });
  const positivePositions = messages.some((message) => Number(message.timeline_position ?? 0) > 0);
  const orderedMessages = positivePositions
    ? [...messages].sort((a, b) => {
      const positionDiff = Number(a.timeline_position ?? 0) - Number(b.timeline_position ?? 0);
      return positionDiff || messages.indexOf(a) - messages.indexOf(b);
    })
    : messages;
  const lastSequence = isSnapshot ? Number(snapshot.snapshot_sequence || 0) : Math.max(0, ...messages.map((message) => Number(message.snapshot_sequence ?? 0)));
  return {
    // A newly-created conversation can receive its first canonical event
    // before the optimistic message has migrated into the real conversation
    // key.  Keep the transport identity supplied by the caller instead of
    // creating an unusable state with an empty conversation id.
    conversationId: conversationIdOverride
      || (isSnapshot ? snapshot.conversation_id : messages[0]?.conversation_id ?? ''),
    messagesById,
    messageOrder: orderedMessages.map((message) => message.id),
    lastSequence,
    seenEventIds: new Set(),
    activeRunId: messages.find((message) => message.status === 'running' && message.run_id)?.run_id ?? null,
    gap: null,
    integrityError: null,
    terminalMessageIds: new Set(messages.filter((message) => ['completed', 'failed', 'cancelled'].includes(message.status) && message.role === 'assistant' && message.run_id).map((message) => message.id)),
  };
}

export function applyAiTimelineEvent(state: AiTimelineState, event: AiTimelineEvent): AiTimelineApplyResult {
  if (event.conversation_id !== state.conversationId) return withIntegrityError(state, 'timeline event belongs to another conversation');
  if (state.seenEventIds.has(event.event_id) || event.sequence <= state.lastSequence) {
    return { state, needsReplay: false };
  }
  if (event.sequence > state.lastSequence + 1) {
    return {
      state: { ...state, gap: { from: state.lastSequence + 1, to: event.sequence - 1 } },
      needsReplay: true,
    };
  }
  const result = applyPayload(state, event);
  if (result.needsReplay) return result;
  const seenEventIds = new Set(state.seenEventIds);
  seenEventIds.add(event.event_id);
  return {
    state: {
      ...result.state,
      lastSequence: event.sequence,
      seenEventIds,
      gap: result.state.gap && event.sequence >= result.state.gap.to ? null : result.state.gap,
      integrityError: null,
    },
    needsReplay: false,
  };
}

export function mergeAiTimelineReplay(state: AiTimelineState, replay: AiConversationReplay): AiTimelineState {
  if (replay.conversation_id !== state.conversationId) return { ...state, integrityError: 'replay belongs to another conversation' };
  return [...replay.events]
    .sort((a, b) => a.sequence - b.sequence)
    .reduce((current, event) => applyAiTimelineEvent(current, event).state, state);
}

export function selectAiTimelineMessages(state: AiTimelineState): AiMessage[] {
  return state.messageOrder.map((id) => state.messagesById[id]).filter((message): message is AiMessage => Boolean(message));
}
