export type AiStreamAbortReason =
  | { type: 'cancel_accepted'; runId: string }
  | { type: 'component_cleanup' }
  | { type: 'conversation_inaccessible'; conversationId: string }
  | { type: 'stream_replaced'; runId: string };

export function abortAiStream(
  controller: AbortController,
  reason: AiStreamAbortReason,
) {
  controller.abort(reason);
}

export function isExpectedAiStreamAbort(_error: unknown, signal: AbortSignal) {
  if (!signal.aborted || !signal.reason || typeof signal.reason !== 'object') {
    return false;
  }
  const type = (signal.reason as { type?: unknown }).type;
  return type === 'cancel_accepted'
    || type === 'component_cleanup'
    || type === 'conversation_inaccessible'
    || type === 'stream_replaced';
}
