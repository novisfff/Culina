import { useEffect, useMemo, useRef, type Dispatch, type SetStateAction } from 'react';
import { api, isApiError } from '../../api/client';
import type { AiConversation, AiRunEvent } from '../../api/types';
import { isPendingConversationKey } from './AiConversationHistory';

const SERVER_RUNNING_STATUSES = new Set(['pending', 'running']);
const UNFINISHED_CONVERSATION_STATUSES = new Set(['pending', 'running', 'waiting_approval', 'waiting_input']);
const WAITING_CONVERSATION_STATUSES = new Set(['waiting_approval', 'waiting_input']);

function isServerRunningStatus(status: string | null | undefined) {
  return SERVER_RUNNING_STATUSES.has((status ?? '').toLowerCase());
}

function isUnfinishedConversationStatus(status: string | null | undefined) {
  return UNFINISHED_CONVERSATION_STATUSES.has((status ?? '').toLowerCase());
}

function isWaitingConversationStatus(status: string | null | undefined) {
  return WAITING_CONVERSATION_STATUSES.has((status ?? '').toLowerCase());
}

export function useAiConversationLiveSync(args: {
  activeConversationKey: string | null;
  activeConversationId: string | null;
  conversations: AiConversation[];
  historyConversations: AiConversation[];
  activeStreamRunIdsByConversationKey: Record<string, string>;
  setRunEventsById: Dispatch<SetStateAction<Record<string, AiRunEvent[]>>>;
  isLoadingConversations?: boolean;
  onInaccessibleConversation?: (conversationId: string) => void;
}) {
  const activeConversation = useMemo(
    () => args.historyConversations.find((conversation) => conversation.id === args.activeConversationKey) ?? null,
    [args.activeConversationKey, args.historyConversations],
  );
  const activeConversationStatus = activeConversation?.last_run_status ?? null;
  const serverActiveRunId =
    activeConversation &&
    isUnfinishedConversationStatus(activeConversationStatus) &&
    typeof activeConversation.context?.activeRunId === 'string'
      ? activeConversation.context.activeRunId
      : null;
  const isActiveConversationServerRunning = Boolean(
    args.activeConversationId &&
    activeConversation &&
    (isServerRunningStatus(activeConversationStatus) || serverActiveRunId),
  );
  const runningConversationKeys = useMemo(() => {
    const keys = new Set(Object.keys(args.activeStreamRunIdsByConversationKey));
    for (const conversation of args.conversations) {
      if (isWaitingConversationStatus(conversation.last_run_status)) continue;
      const hasUnfinishedActiveRun =
        isUnfinishedConversationStatus(conversation.last_run_status) &&
        typeof conversation.context?.activeRunId === 'string';
      if (isServerRunningStatus(conversation.last_run_status) || hasUnfinishedActiveRun) {
        keys.add(conversation.id);
      }
    }
    return keys;
  }, [args.activeStreamRunIdsByConversationKey, args.conversations]);
  const waitingConversationKeys = useMemo(() => {
    const keys = new Set<string>();
    for (const conversation of args.conversations) {
      if (isWaitingConversationStatus(conversation.last_run_status)) {
        keys.add(conversation.id);
      }
    }
    return keys;
  }, [args.conversations]);
  const onInaccessibleConversationRef = useRef(args.onInaccessibleConversation);
  onInaccessibleConversationRef.current = args.onInaccessibleConversation;
  const verifyingMissingConversationRef = useRef<string | null>(null);

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

  useEffect(() => {
    const conversationId = args.activeConversationId;
    if (!conversationId || isPendingConversationKey(conversationId)) return undefined;
    if (args.isLoadingConversations) return undefined;
    if (args.conversations.some((conversation) => conversation.id === conversationId)) {
      verifyingMissingConversationRef.current = null;
      return undefined;
    }
    // Active conversation fell out of the polled list. Verify access with one message refetch
    // so a 20-item list limit cannot clear a still-accessible conversation.
    if (verifyingMissingConversationRef.current === conversationId) return undefined;
    verifyingMissingConversationRef.current = conversationId;
    let isCancelled = false;
    void (async () => {
      try {
        await api.getAiMessages(conversationId);
        if (isCancelled) return;
        // Still accessible; keep selection despite list eviction.
      } catch (error) {
        if (isCancelled) return;
        if (isApiError(error) && error.status === 404) {
          onInaccessibleConversationRef.current?.(conversationId);
        }
      } finally {
        if (verifyingMissingConversationRef.current === conversationId) {
          verifyingMissingConversationRef.current = null;
        }
      }
    })();
    return () => {
      isCancelled = true;
    };
  }, [args.activeConversationId, args.conversations, args.isLoadingConversations]);

  return {
    serverActiveRunId,
    isActiveConversationServerRunning,
    runningConversationKeys,
    waitingConversationKeys,
  };
}
