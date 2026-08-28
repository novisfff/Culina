export type AiRunViewState =
  | 'idle'
  | 'requesting'
  | 'running'
  | 'waiting-approval'
  | 'waiting-human-input'
  | 'cancelling'
  | 'cancelled'
  | 'failed'
  | 'partial';

export type AiStatusProjection = {
  isRunning: boolean;
  isWaiting: boolean;
  isCancellable: boolean;
  canRetry: boolean;
};

export function deriveAiStatus(state: AiRunViewState): AiStatusProjection {
  return {
    isRunning: state === 'requesting' || state === 'running' || state === 'cancelling',
    isWaiting: state === 'waiting-approval' || state === 'waiting-human-input',
    isCancellable: state === 'requesting' || state === 'running',
    canRetry: state === 'failed' || state === 'partial' || state === 'cancelled',
  };
}

export function isEventForActiveRun(
  event: { conversationKey?: string | null; runId?: string | null },
  activeConversationKey: string | null | undefined,
  activeRunId: string | null | undefined,
): boolean {
  return Boolean(
    event.conversationKey &&
      activeConversationKey &&
      event.conversationKey === activeConversationKey &&
      event.runId &&
      activeRunId &&
      event.runId === activeRunId,
  );
}
