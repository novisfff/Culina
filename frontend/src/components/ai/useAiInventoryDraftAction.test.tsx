// @vitest-environment jsdom

import type { Dispatch, SetStateAction } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { api } from '../../api/client';
import { queryKeys } from '../../api/queryKeys';
import type {
  AiConversationSnapshot,
  AiInventoryResultItem,
  AiMessage,
  AiResultCard,
} from '../../api/types';
import { useAiInventoryDraftAction } from './useAiInventoryDraftAction';

function message(id: string, content: string): AiMessage {
  return {
    id,
    conversation_id: 'conversation-1',
    role: 'assistant',
    content,
    content_type: 'parts',
    parts: [{ id: `${id}-part`, type: 'text', text: content }],
    run_id: 'run-1',
    status: 'completed',
    metadata: {},
    created_at: '2026-09-03T00:00:00Z',
  };
}

describe('useAiInventoryDraftAction', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('updates messages inside the snapshot envelope and preserves its timeline cursor', async () => {
    const original = message('message-1', '原始卡片');
    const updated = message('message-1', '已生成库存草稿');
    vi.spyOn(api, 'createAiInventoryOperationDraft').mockResolvedValue(updated);

    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    const snapshot: AiConversationSnapshot = {
      conversation_id: 'conversation-1',
      snapshot_sequence: 17,
      messages: [original],
    };
    queryClient.setQueryData(queryKeys.aiMessages('conversation-1'), snapshot);

    let localMessages = [original];
    let feedback = '';
    const setLocalMessages: Dispatch<SetStateAction<AiMessage[]>> = (next) => {
      localMessages = typeof next === 'function' ? next(localMessages) : next;
    };
    const setFeedback: Dispatch<SetStateAction<string>> = (next) => {
      feedback = typeof next === 'function' ? next(feedback) : next;
    };
    const wrapper = ({ children }: { children: React.ReactNode }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );

    const { result, unmount } = renderHook(
      () => useAiInventoryDraftAction({ setLocalMessages, setFeedback }),
      { wrapper },
    );

    const item = {
      id: 'inventory-1',
      sourceType: 'ingredient',
      ingredientId: 'ingredient-1',
      foodId: null,
      inventoryItemId: 'inventory-1',
      name: '番茄',
      quantity: '2',
      unit: '个',
      quantityTrackingMode: 'track_quantity',
      status: 'fresh',
      displayStatus: 'available',
    } satisfies AiInventoryResultItem;
    const card = { id: 'inventory-card-1', type: 'inventory_summary', title: '库存', data: {} } as AiResultCard;
    result.current.createDraft({ item, action: 'restock', card, messageId: original.id, partId: 'inventory-part-1' });

    await waitFor(() => expect(api.createAiInventoryOperationDraft).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(localMessages[0]).toEqual(updated));

    expect(queryClient.getQueryData<AiConversationSnapshot>(queryKeys.aiMessages('conversation-1'))).toEqual({
      ...snapshot,
      messages: [updated],
    });
    expect(feedback).toContain('番茄的补货草稿已生成');

    unmount();
    queryClient.clear();
  });
});
