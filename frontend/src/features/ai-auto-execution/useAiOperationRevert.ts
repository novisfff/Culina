import { useRef, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { aiApi, aiOperationRevertConflictFromError } from '../../api/aiApi';
import { invalidateAfterAiOperationSettled } from '../../api/cacheInvalidation';
import type { AiResultCard } from '../../api/types';

export function useAiOperationRevert(input: {
  conversationId: string;
  onResultCard: (card: AiResultCard) => void;
}) {
  const queryClient = useQueryClient();
  const requestIds = useRef(new Map<string, string>());
  const [announcement, setAnnouncement] = useState('');
  const mutation = useMutation({
    networkMode: 'online',
    mutationFn: async (operationId: string) => {
      const requestId = requestIds.current.get(operationId) ?? crypto.randomUUID();
      requestIds.current.set(operationId, requestId);
      return aiApi.revertAiOperation(operationId, { client_request_id: requestId });
    },
    onMutate: () => {
      setAnnouncement('');
    },
    onSuccess: async (response, operationId) => {
      requestIds.current.delete(operationId);
      input.onResultCard(response.result_card);
      setAnnouncement('操作已撤销');
      await invalidateAfterAiOperationSettled(queryClient, {
        conversationId: input.conversationId,
        cacheScopes: response.cache_scopes,
      });
    },
    onError: async (error, operationId) => {
      const conflict = aiOperationRevertConflictFromError(error);
      if (!conflict) {
        setAnnouncement('撤销失败，请重试');
        return;
      }
      requestIds.current.delete(operationId);
      input.onResultCard(conflict.result_card);
      setAnnouncement(conflict.message);
      await invalidateAfterAiOperationSettled(queryClient, {
        conversationId: input.conversationId,
        cacheScopes: conflict.cache_scopes,
      });
    },
  });

  return { ...mutation, announcement };
}
