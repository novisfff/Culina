// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { PropsWithChildren } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { api } from '../api/client';
import { invalidateAfterMealRecorded } from '../api/cacheInvalidation';
import type { RecordMealPayload, RecordMealResponse } from '../api/types';
import { useAppMutations } from './useAppMutations';

vi.mock('../api/cacheInvalidation', async () => {
  const actual = await vi.importActual<typeof import('../api/cacheInvalidation')>(
    '../api/cacheInvalidation',
  );
  return {
    ...actual,
    invalidateAfterMealRecorded: vi.fn(),
  };
});

const payload: RecordMealPayload = {
  client_request_id: 'request-1',
  date: '2026-07-15',
  meal_type: 'dinner',
  target: { kind: 'new' },
  entries: [{ food_id: 'food-1', servings: 1 }],
};

const response: RecordMealResponse = {
  meal_log: {
    id: 'meal-1',
    family_id: 'family-1',
    date: '2026-07-15',
    meal_type: 'dinner',
    food_entries: [
      {
        id: 'entry-1',
        food_id: 'food-1',
        food_name: '番茄炒蛋',
        servings: 1,
        note: '',
        rating: null,
      },
    ],
    participant_user_ids: ['user-1'],
    notes: '',
    mood: '',
    photos: [],
    deduction_suggestions: [],
    row_version: 1,
    created_at: '2026-07-15T11:00:00.000Z',
    updated_at: '2026-07-15T11:00:00.000Z',
    created_by: 'user-1',
    updated_by: 'user-1',
  },
  created_foods: [],
  outcome: 'created',
  operation: {
    id: 'operation-1',
    status: 'applied',
    revertible_until: '2026-07-15T11:15:00.000Z',
    can_revert: true,
    created_entry_ids: ['entry-1'],
  },
  completed_plan_item_ids: [],
};

function wrapper(queryClient: QueryClient) {
  return ({ children }: PropsWithChildren) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
}

describe('useAppMutations', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  it('settles a successful meal record while its cache refresh continues in the background', async () => {
    const queryClient = new QueryClient({
      defaultOptions: {
        mutations: { retry: false },
        queries: { retry: false },
      },
    });
    let finishRefresh: (() => void) | undefined;
    vi.mocked(invalidateAfterMealRecorded).mockImplementationOnce(
      () => new Promise<void>((resolve) => {
        finishRefresh = resolve;
      }),
    );
    vi.spyOn(api, 'recordMeal').mockResolvedValue(response);

    const { result } = renderHook(() => useAppMutations(), {
      wrapper: wrapper(queryClient),
    });

    let mutation: Promise<RecordMealResponse> | undefined;
    act(() => {
      mutation = result.current.recordMealMutation.mutateAsync(payload);
    });

    await waitFor(() => {
      expect(invalidateAfterMealRecorded).toHaveBeenCalledWith(queryClient, {
        createdFood: false,
      });
    });

    try {
      await waitFor(() => {
        expect(result.current.recordMealMutation.isPending).toBe(false);
      });
    } finally {
      finishRefresh?.();
      await act(async () => {
        await mutation;
      });
      queryClient.clear();
    }
  });
});
