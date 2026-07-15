// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from '../../api/client';
import { queryKeys } from '../../api/queryKeys';
import type { MealLogCandidate } from '../../api/types';
import { useMealCandidateData } from './useMealCandidateData';

function wrapperFor(client: QueryClient) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  };
}

const candidates: MealLogCandidate[] = [
  {
    meal_log_id: 'meal-1',
    row_version: 2,
    date: '2026-07-15',
    meal_type: 'dinner',
    created_at: '2026-07-15T10:00:00.000Z',
    foods: [{ food_id: 'food-1', name: '番茄炒蛋', food_type: 'selfMade' }],
    preview_media: null,
    photo_count: 0,
  },
];

describe('useMealCandidateData', () => {
  let client: QueryClient;

  beforeEach(() => {
    client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
  });

  afterEach(() => {
    client.clear();
    vi.restoreAllMocks();
  });

  it('loads authoritative candidates only when open and never reads mealLogs cache', async () => {
    const getCandidates = vi.spyOn(api, 'getMealCandidates').mockResolvedValue(candidates);
    const getMealLogs = vi.spyOn(api, 'getMealLogs').mockResolvedValue([]);
    client.setQueryData(queryKeys.mealLogs, [
      { id: 'timeline-only', date: '2026-07-15', meal_type: 'dinner' },
    ]);

    const { result, rerender } = renderHook(
      ({ open }) =>
        useMealCandidateData({
          open,
          date: '2026-07-15',
          mealType: 'dinner',
        }),
      {
        initialProps: { open: false },
        wrapper: wrapperFor(client),
      },
    );

    expect(getCandidates).not.toHaveBeenCalled();
    expect(result.current.candidates).toEqual([]);

    rerender({ open: true });
    await waitFor(() => {
      expect(getCandidates).toHaveBeenCalledWith('2026-07-15', 'dinner');
    });
    await waitFor(() => {
      expect(result.current.candidates).toEqual(candidates);
    });
    expect(getMealLogs).not.toHaveBeenCalled();
    expect(client.getQueryData(queryKeys.mealCandidates('2026-07-15', 'dinner'))).toEqual(candidates);
  });

  it('refetches candidates for new date/meal type without coupling to food search', async () => {
    const getCandidates = vi
      .spyOn(api, 'getMealCandidates')
      .mockResolvedValueOnce(candidates)
      .mockResolvedValueOnce([]);

    type CandidateHookProps = {
      date: string;
      mealType: 'breakfast' | 'lunch' | 'dinner' | 'snack';
    };
    const { result, rerender } = renderHook(
      ({ date, mealType }: CandidateHookProps) =>
        useMealCandidateData({
          open: true,
          date,
          mealType,
        }),
      {
        initialProps: { date: '2026-07-15', mealType: 'dinner' } as CandidateHookProps,
        wrapper: wrapperFor(client),
      },
    );

    await waitFor(() => expect(result.current.candidates).toHaveLength(1));

    rerender({ date: '2026-07-16', mealType: 'lunch' });
    await waitFor(() => {
      expect(getCandidates).toHaveBeenLastCalledWith('2026-07-16', 'lunch');
    });
    await waitFor(() => {
      expect(result.current.candidates).toEqual([]);
    });

    await act(async () => {
      await result.current.refetch();
    });
    expect(getCandidates).toHaveBeenCalledTimes(3);
  });
});
