import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { Dispatch, SetStateAction } from 'react';
import { api } from '../../api/client';
import { queryKeys } from '../../api/queryKeys';
import type {
  AiInventoryOperationAction,
  AiInventoryResultItem,
  AiMessage,
  AiResultCard,
} from '../../api/types';

type InventoryDraftRequest = {
  item: AiInventoryResultItem;
  action: AiInventoryOperationAction;
  card: AiResultCard;
  messageId: string;
  partId: string;
};

const ACTION_LABELS: Record<AiInventoryOperationAction, string> = {
  restock: '补货',
  consume: '消耗',
  dispose: '销毁',
};

export function useAiInventoryDraftAction({
  setLocalMessages,
  setFeedback,
}: {
  setLocalMessages: Dispatch<SetStateAction<AiMessage[]>>;
  setFeedback: Dispatch<SetStateAction<string>>;
}) {
  const queryClient = useQueryClient();
  const mutation = useMutation({
    mutationFn: (payload: InventoryDraftRequest) => api.createAiInventoryOperationDraft(payload.messageId, {
      part_id: payload.partId,
      card_id: payload.card.id,
      item_id: payload.item.id,
      action: payload.action,
    }),
    onSuccess: async (updatedMessage, payload) => {
      queryClient.setQueryData<AiMessage[]>(
        queryKeys.aiMessages(updatedMessage.conversation_id),
        (items = []) => items.map((item) => (item.id === updatedMessage.id ? updatedMessage : item)),
      );
      setLocalMessages((items) => items.map((item) => (item.id === updatedMessage.id ? updatedMessage : item)));
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.aiPendingApprovals(updatedMessage.conversation_id) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.aiConversations }),
      ]);
      setFeedback(`${payload.item.name}的${ACTION_LABELS[payload.action]}草稿已生成，请确认后执行`);
    },
    onError: (reason, payload) => {
      const message = reason instanceof Error && reason.message ? reason.message : '请稍后重试。';
      setFeedback(`${payload.item.name}的${ACTION_LABELS[payload.action]}草稿生成失败：${message}`);
    },
  });

  return {
    isPending: mutation.isPending,
    createDraft: (payload: InventoryDraftRequest) => {
      if (!mutation.isPending) mutation.mutate(payload);
    },
  };
}
