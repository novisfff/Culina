import { createContext, createElement, useContext, useMemo, useRef, useState, type ReactNode } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { aiApi, aiOperationRevertConflictFromError } from '../../api/aiApi';
import { invalidateAfterAiOperationSettled } from '../../api/cacheInvalidation';
import type { AiResultCard } from '../../api/types';

type RevertOperationInput = {
  operationId: string;
  conversationId: string;
  onResultCard: (card: AiResultCard) => void;
};

type RevertOperationState = {
  phase: 'pending' | 'temporary_error' | 'succeeded' | 'permanent_conflict';
  announcement: string;
  resultCard: AiResultCard | null;
};

export type AiOperationRevertController = {
  states: ReadonlyMap<string, RevertOperationState>;
  mutate: (input: RevertOperationInput) => void;
};

const AiOperationRevertContext = createContext<AiOperationRevertController | null>(null);

function useAiOperationRevertController(): AiOperationRevertController {
  const queryClient = useQueryClient();
  const requestIds = useRef(new Map<string, string>());
  const pendingOperations = useRef(new Set<string>());
  const [states, setStates] = useState<Map<string, RevertOperationState>>(() => new Map());
  const mutation = useMutation({
    networkMode: 'always',
    mutationFn: async (input: RevertOperationInput) => {
      const requestId = requestIds.current.get(input.operationId) ?? crypto.randomUUID();
      requestIds.current.set(input.operationId, requestId);
      if (!navigator.onLine) throw new TypeError('offline');
      return aiApi.revertAiOperation(input.operationId, { client_request_id: requestId });
    },
    onMutate: (input) => {
      setStates((current) => new Map(current).set(input.operationId, {
        phase: 'pending',
        announcement: '',
        resultCard: current.get(input.operationId)?.resultCard ?? null,
      }));
    },
    onSuccess: async (response, input) => {
      pendingOperations.current.delete(input.operationId);
      requestIds.current.delete(input.operationId);
      setStates((current) => new Map(current).set(input.operationId, {
        phase: 'succeeded',
        announcement: '操作已撤销',
        resultCard: response.result_card,
      }));
      input.onResultCard(response.result_card);
      await invalidateAfterAiOperationSettled(queryClient, {
        conversationId: input.conversationId,
        cacheScopes: response.cache_scopes,
      });
    },
    onError: async (error, input) => {
      pendingOperations.current.delete(input.operationId);
      const conflict = aiOperationRevertConflictFromError(error);
      if (!conflict) {
        setStates((current) => new Map(current).set(input.operationId, {
          phase: 'temporary_error',
          announcement: '撤销失败，请重试',
          resultCard: current.get(input.operationId)?.resultCard ?? null,
        }));
        return;
      }
      requestIds.current.delete(input.operationId);
      setStates((current) => new Map(current).set(input.operationId, {
        phase: 'permanent_conflict',
        announcement: conflict.message,
        resultCard: conflict.result_card,
      }));
      input.onResultCard(conflict.result_card);
      await invalidateAfterAiOperationSettled(queryClient, {
        conversationId: input.conversationId,
        cacheScopes: conflict.cache_scopes,
      });
    },
  });

  return useMemo(() => ({
    states,
    mutate: (input: RevertOperationInput) => {
      if (pendingOperations.current.has(input.operationId)) return;
      pendingOperations.current.add(input.operationId);
      mutation.mutate(input);
    },
  }), [mutation.mutate, states]);
}

export function AiOperationRevertProvider({ children }: { children: ReactNode }) {
  const controller = useAiOperationRevertController();
  return createElement(AiOperationRevertContext.Provider, { value: controller }, children);
}

export function useAiOperationRevertWithController(
  controller: AiOperationRevertController,
  input: {
    operationId?: string;
    conversationId: string;
    onResultCard: (card: AiResultCard) => void;
  },
) {
  const [localOperationId, setLocalOperationId] = useState(input.operationId ?? '');
  const operationId = input.operationId ?? localOperationId;
  const state = controller.states.get(operationId);

  return {
    mutate: (nextOperationId: string) => {
      setLocalOperationId(nextOperationId);
      controller.mutate({
        operationId: nextOperationId,
        conversationId: input.conversationId,
        onResultCard: input.onResultCard,
      });
    },
    isPending: state?.phase === 'pending',
    isPaused: false,
    isError: state?.phase === 'temporary_error' || state?.phase === 'permanent_conflict',
    announcement: state?.announcement ?? '',
    resultCard: state?.resultCard ?? null,
    hasAttempted: Boolean(state),
  };
}

export function AiOperationRevertBoundary({
  children,
}: {
  children: (controller: AiOperationRevertController) => ReactNode;
}): ReactNode {
  const sharedController = useContext(AiOperationRevertContext);
  if (sharedController) return children(sharedController);
  return createElement(
    AiOperationRevertProvider,
    null,
    createElement(AiOperationRevertBoundary, { children }),
  );
}

export function useAiOperationRevert(input: {
  operationId?: string;
  conversationId: string;
  onResultCard: (card: AiResultCard) => void;
}) {
  return useAiOperationRevertWithController(useAiOperationRevertController(), input);
}
