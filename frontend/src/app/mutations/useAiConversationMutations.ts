import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../../api/client';
import { queryKeys } from '../../api/queryKeys';
import type { AiConversation, AiConversationVisibility } from '../../api/types';

export function useAiConversationMutations(args: {
  onDeleted?: (conversationId: string) => void;
  onDeleteSettled?: () => void;
  onVisibilityError?: (error: unknown) => void;
}) {
  const queryClient = useQueryClient();
  const deleteConversationMutation = useMutation({
    mutationFn: api.deleteAiConversation,
    onSuccess: async (_, conversationId) => {
      args.onDeleted?.(conversationId);
      await queryClient.invalidateQueries({ queryKey: queryKeys.aiConversations });
      queryClient.removeQueries({ queryKey: queryKeys.aiMessages(conversationId) });
      queryClient.removeQueries({ queryKey: queryKeys.aiPendingApprovals(conversationId) });
    },
    onSettled: args.onDeleteSettled,
  });
  const visibilityMutation = useMutation({
    mutationFn: ({ conversationId, visibility }: { conversationId: string; visibility: AiConversationVisibility }) => api.updateAiConversationVisibility(conversationId, visibility),
    onSuccess: (updated) => queryClient.setQueryData<AiConversation[]>(queryKeys.aiConversations, (items = []) => items.map((item) => item.id === updated.id ? updated : item)),
    onError: args.onVisibilityError,
  });
  return { deleteConversationMutation, visibilityMutation };
}
