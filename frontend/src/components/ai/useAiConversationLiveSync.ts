import { useEffect, useMemo, type Dispatch, type SetStateAction } from 'react';
import { api } from '../../api/client';
import type { AiConversation, AiRunEvent } from '../../api/types';

export function useAiConversationLiveSync(args: {
  activeConversationKey: string | null;
  activeConversationId: string | null;
  conversations: AiConversation[];
  historyConversations: AiConversation[];
  activeStreamRunIdsByConversationKey: Record<string, string>;
  setRunEventsById: Dispatch<SetStateAction<Record<string, AiRunEvent[]>>>;
}) {
  const activeConversation = useMemo(
    () => args.historyConversations.find((conversation) => conversation.id === args.activeConversationKey) ?? null,
    [args.activeConversationKey, args.historyConversations],
  );
  const serverActiveRunId =
    activeConversation && typeof activeConversation.context?.activeRunId === 'string'
      ? activeConversation.context.activeRunId
      : null;
  const isActiveConversationServerRunning = Boolean(
    args.activeConversationId &&
    activeConversation &&
    (activeConversation.last_run_status === 'pending' || activeConversation.last_run_status === 'running' || serverActiveRunId),
  );
  const runningConversationKeys = useMemo(() => {
    const keys = new Set(Object.keys(args.activeStreamRunIdsByConversationKey));
    for (const conversation of args.conversations) {
      if (
        conversation.last_run_status === 'pending' ||
        conversation.last_run_status === 'running' ||
        typeof conversation.context?.activeRunId === 'string'
      ) {
        keys.add(conversation.id);
      }
    }
    return keys;
  }, [args.activeStreamRunIdsByConversationKey, args.conversations]);

  useEffect(() => {
    if (!serverActiveRunId || !isActiveConversationServerRunning) return undefined;
    const runId = serverActiveRunId;
    let isCancelled = false;
    async function refreshRunEvents() {
      try {
        const events = await api.getAiRunEvents(runId);
        if (isCancelled) return;
        args.setRunEventsById((current) => ({ ...current, [runId]: events }));
      } catch {
        // Keep the last known progress; retry while the run stays active.
      }
    }
    void refreshRunEvents();
    const timer = window.setInterval(refreshRunEvents, 1200);
    return () => {
      isCancelled = true;
      window.clearInterval(timer);
    };
  }, [args.setRunEventsById, isActiveConversationServerRunning, serverActiveRunId]);

  return {
    serverActiveRunId,
    isActiveConversationServerRunning,
    runningConversationKeys,
  };
}
