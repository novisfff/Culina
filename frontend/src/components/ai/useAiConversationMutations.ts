import { useMutation, type QueryClient } from '@tanstack/react-query';
import type { Dispatch, SetStateAction } from 'react';
import { api, isApiError } from '../../api/client';
import { queryKeys } from '../../api/queryKeys';
import type { AiConversation, AiConversationVisibility, AiMessage } from '../../api/types/ai';

type UseAiConversationMutationsOptions = {
  conversations: AiConversation[];
  activeConversationId: string | null;
  deletingConversationId: string | null;
  queryClient: QueryClient;
  clearComposerScope: (conversationId: string) => void;
  clearAttachmentScope: (conversationId: string) => void;
  setActiveConversationKey: (conversationId: string | null) => void;
  setIsStartingNewConversation: (value: boolean) => void;
  setLocalMessagesByConversationKey: Dispatch<SetStateAction<Record<string, AiMessage[]>>>;
  setPendingDeleteConversation: (conversation: AiConversation | null) => void;
  setDeletingConversationId: (conversationId: string | null) => void;
  setFeedback: (message: string) => void;
};

export function useAiConversationMutations(options: UseAiConversationMutationsOptions) {
  const deleteConversationMutation = useMutation({
    mutationFn: api.deleteAiConversation,
    onSuccess: async (_, conversationId) => {
      const remainingConversations = options.conversations.filter((conversation) => conversation.id !== conversationId);
      if (conversationId === options.activeConversationId) {
        const nextConversation = remainingConversations[0] ?? null;
        options.setActiveConversationKey(nextConversation?.id ?? null);
        options.setIsStartingNewConversation(!nextConversation);
        options.setLocalMessagesByConversationKey((current) => {
          const next = { ...current };
          delete next[conversationId];
          return next;
        });
      }
      options.clearComposerScope(conversationId);
      options.clearAttachmentScope(conversationId);
      await options.queryClient.invalidateQueries({ queryKey: queryKeys.aiConversations });
      options.queryClient.removeQueries({ queryKey: queryKeys.aiMessages(conversationId) });
      options.queryClient.removeQueries({ queryKey: queryKeys.aiPendingApprovals(conversationId) });
      options.setPendingDeleteConversation(null);
    },
    onSettled: () => options.setDeletingConversationId(null),
  });

  const visibilityMutation = useMutation({
    mutationFn: ({ conversationId, visibility }: { conversationId: string; visibility: AiConversationVisibility }) =>
      api.updateAiConversationVisibility(conversationId, visibility),
    onSuccess: (updated) => {
      options.queryClient.setQueryData<AiConversation[]>(queryKeys.aiConversations, (items = []) =>
        items.map((item) => (item.id === updated.id ? updated : item)));
    },
    onError: (error) => {
      options.setFeedback(isApiError(error) && error.status === 409
        ? '会话正在生成回复，请先等待完成或取消当前任务'
        : error instanceof Error ? error.message : '更新公开状态失败');
    },
  });

  return {
    deleteConversationMutation,
    visibilityMutation,
    updatingConversationId: visibilityMutation.isPending
      ? visibilityMutation.variables?.conversationId ?? null
      : options.deletingConversationId,
  };
}
