export type AiStreamState = {
  conversationKey: string | null;
  runId: string | null;
  status: 'idle' | 'running' | 'failed' | 'cancelled' | 'completed';
  messages: Record<string, string>;
  error: string | null;
};

export type AiStreamAction =
  | { type: 'run-started'; conversationKey: string; runId: string }
  | { type: 'message-delta'; conversationKey: string; runId?: string; messageId?: string; delta: string }
  | { type: 'stream-failed'; conversationKey: string; runId?: string; message: string }
  | { type: 'run-cancelled'; conversationKey: string; runId: string }
  | { type: 'run-completed'; conversationKey: string; runId: string };

export const initialAiStreamState: AiStreamState = {
  conversationKey: null,
  runId: null,
  status: 'idle',
  messages: {},
  error: null,
};

function isCurrent(state: AiStreamState, conversationKey: string, runId?: string) {
  return state.conversationKey === conversationKey && (!runId || state.runId === runId);
}

export function aiStreamReducer(state: AiStreamState, action: AiStreamAction): AiStreamState {
  if (action.type === 'run-started') {
    return { ...state, conversationKey: action.conversationKey, runId: action.runId, status: 'running', error: null };
  }
  if (!isCurrent(state, action.conversationKey, 'runId' in action ? action.runId : undefined)) return state;
  if (action.type === 'message-delta') {
    if (!action.messageId) return state;
    return { ...state, messages: { ...state.messages, [action.messageId]: `${state.messages[action.messageId] ?? ''}${action.delta}` } };
  }
  if (action.type === 'stream-failed') return { ...state, status: 'failed', error: action.message };
  if (action.type === 'run-cancelled') return { ...state, status: 'cancelled', error: null };
  return { ...state, status: 'completed', error: null };
}
