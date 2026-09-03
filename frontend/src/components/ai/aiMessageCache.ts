import type { AiConversationSnapshot, AiMessage } from '../../api/types';

/**
 * Updates the canonical conversation snapshot without changing its envelope.
 * Message mutations must never replace the snapshot with a bare message list:
 * snapshot_sequence is the cursor used by the timeline reducer for ordering
 * and replay decisions.
 */
export function updateAiConversationSnapshot(
  snapshot: AiConversationSnapshot | undefined,
  updateMessages: (messages: AiMessage[]) => AiMessage[],
): AiConversationSnapshot | undefined {
  if (!snapshot) return snapshot;
  return {
    ...snapshot,
    messages: updateMessages(snapshot.messages),
  };
}
