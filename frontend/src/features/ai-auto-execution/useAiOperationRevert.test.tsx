import React, { act } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { aiApi } from '../../api/aiApi';
import { queryKeys } from '../../api/queryKeys';
import { ApiError } from '../../api/request';
import type { AiOperationRevertResponse, AiResultCard } from '../../api/types';
import { useAiOperationRevert } from './useAiOperationRevert';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function projection(overrides: Partial<AiOperationRevertResponse['projection']> = {}): AiOperationRevertResponse['projection'] {
  return {
    draft_id: 'draft-1',
    operation_id: 'operation-1',
    result_status: 'reverted' as const,
    execution_mode: 'policy_auto' as const,
    operation_status: 'reverted' as const,
    execution_explanation: '已撤销自动收藏。',
    revert_availability: 'reverted' as const,
    revertible_until: '2026-08-24T08:42:00Z',
    revert_blocked_code: null,
    server_now: '2026-08-24T08:00:00Z',
    entities: [{ id: 'food-1', label: '食物', operation: 'set_favorite', operationLabel: '取消收藏' }],
    cache_scopes: ['food', 'ai_conversation'],
    ...overrides,
  };
}

function response(overrides: Partial<AiOperationRevertResponse['projection']> = {}): AiOperationRevertResponse {
  const value = projection(overrides);
  return {
    projection: value,
    result_card: { id: 'operation-card-1', type: 'operation_result', title: '收藏已撤销', data: value as unknown as AiResultCard['data'] },
    cache_scopes: [...value.cache_scopes],
    server_now: value.server_now,
    replayed: false,
  };
}

function Harness({ onCard }: { onCard: (card: AiResultCard) => void }) {
  const revert = useAiOperationRevert({ conversationId: 'conversation-1', onResultCard: onCard });
  return (
    <>
      <button type="button" onClick={() => revert.mutate('operation-1')}>撤销</button>
      <span role="status">{revert.announcement}</span>
    </>
  );
}

async function renderHarness(onCard: (card: AiResultCard) => void) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root: Root = createRoot(container);
  const queryClient = new QueryClient({ defaultOptions: { mutations: { retry: false }, queries: { retry: false } } });
  await act(async () => {
    root.render(<QueryClientProvider client={queryClient}><Harness onCard={onCard} /></QueryClientProvider>);
  });
  return { container, queryClient, unmount: () => act(() => { root.unmount(); container.remove(); }) };
}

afterEach(() => {
  vi.restoreAllMocks();
  document.body.innerHTML = '';
});

describe('useAiOperationRevert', () => {
  it('reuses the request id after a temporary failure and replaces from the eventual HTTP response', async () => {
    const cards: AiResultCard[] = [];
    const requestIds: string[] = [];
    vi.spyOn(aiApi, 'revertAiOperation')
      .mockImplementationOnce(async (_operationId, payload) => {
        requestIds.push(payload.client_request_id);
        throw new TypeError('network unavailable');
      })
      .mockImplementationOnce(async (_operationId, payload) => {
        requestIds.push(payload.client_request_id);
        return response();
      });
    const rendered = await renderHarness((card) => cards.push(card));
    const invalidationSpy = vi.spyOn(rendered.queryClient, 'invalidateQueries');
    const button = rendered.container.querySelector('button') as HTMLButtonElement;

    await act(async () => { button.click(); });
    expect(rendered.container.querySelector('[role="status"]')?.textContent).toBe('撤销失败，请重试');
    await act(async () => { button.click(); });

    expect(requestIds).toHaveLength(2);
    expect(requestIds[1]).toBe(requestIds[0]);
    expect(cards.at(-1)?.data.result_status).toBe('reverted');
    expect(rendered.container.querySelector('[role="status"]')?.textContent).toBe('操作已撤销');
    const invalidatedKeys = invalidationSpy.mock.calls.map(([filters]) => filters?.queryKey);
    expect(invalidatedKeys).toContainEqual(queryKeys.foods);
    expect(invalidatedKeys).toContainEqual(queryKeys.aiMessages('conversation-1'));
    rendered.unmount();
  });

  it('uses the fail-closed Task 15 parser to replace a permanent 409 conflict', async () => {
    const cards: AiResultCard[] = [];
    const conflictResponse = response({
      result_status: 'completed',
      operation_status: 'completed',
      execution_explanation: '相关内容后来被修改，无法安全撤销。',
      revert_availability: 'blocked',
      revert_blocked_code: 'revert_target_changed',
    });
    vi.spyOn(aiApi, 'revertAiOperation').mockRejectedValue(new ApiError({
      status: 409,
      detail: '目标已变化',
      path: '/api/ai/operations/operation-1/revert',
      payload: { detail: { ...conflictResponse, code: 'revert_target_changed', message: '相关内容后来被修改，无法安全撤销' } },
    }));
    const rendered = await renderHarness((card) => cards.push(card));

    await act(async () => { rendered.container.querySelector<HTMLButtonElement>('button')?.click(); });

    expect(cards.at(-1)?.data.revert_blocked_code).toBe('revert_target_changed');
    expect(rendered.container.querySelector('[role="status"]')?.textContent).toBe('相关内容后来被修改，无法安全撤销');
    rendered.unmount();
  });

  it('does not accept an unstructured 409 as a permanent replacement', async () => {
    const cards: AiResultCard[] = [];
    vi.spyOn(aiApi, 'revertAiOperation').mockRejectedValue(new ApiError({
      status: 409,
      detail: 'conflict',
      path: '/api/ai/operations/operation-1/revert',
      payload: { detail: { code: 'revert_target_changed', message: '缺少持久化卡片' } },
    }));
    const rendered = await renderHarness((card) => cards.push(card));

    await act(async () => { rendered.container.querySelector<HTMLButtonElement>('button')?.click(); });

    expect(cards).toEqual([]);
    expect(rendered.container.querySelector('[role="status"]')?.textContent).toBe('撤销失败，请重试');
    rendered.unmount();
  });
});
