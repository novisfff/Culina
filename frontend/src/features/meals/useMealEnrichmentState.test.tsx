// @vitest-environment jsdom

import { act, renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../api/request';
import type { MealLog } from '../../api/types';
import { useMealEnrichmentState } from './useMealEnrichmentState';

function mealLog(overrides: Partial<MealLog> = {}): MealLog {
  return {
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
    notes: '初始备注',
    mood: '',
    photos: [],
    deduction_suggestions: [],
    row_version: 3,
    created_at: '2026-07-15T11:00:00.000Z',
    updated_at: '2026-07-15T11:00:00.000Z',
    ...overrides,
  };
}

describe('useMealEnrichmentState 409 recovery', () => {
  it('merges an immediately recorded food without clearing the unsaved meal draft', () => {
    const updateMealLog = vi.fn();
    const { result, rerender } = renderHook(
      ({ meal }) => useMealEnrichmentState({ meal, isUpdating: false, updateMealLog }),
      { initialProps: { meal: mealLog() } },
    );

    act(() => {
      result.current.setNotes('少油一点');
      result.current.updateEntryRating('entry-1', '4.5');
    });

    rerender({
      meal: mealLog({
        row_version: 4,
        food_entries: [
          ...mealLog().food_entries,
          { id: 'entry-2', food_id: 'food-2', food_name: '米饭', servings: 1, note: '', rating: null },
        ],
      }),
    });

    expect(result.current.notes).toBe('少油一点');
    expect(result.current.entryRatings).toEqual({ 'entry-1': '4.5', 'entry-2': '' });
    expect(result.current.expectedRowVersion).toBe(4);
  });

  it('preserves local draft notes/ratings on 409 and advances expected_row_version', async () => {
    const serverMeal = mealLog({
      notes: '服务器备注',
      row_version: 9,
      food_entries: [
        {
          id: 'entry-1',
          food_id: 'food-1',
          food_name: '番茄炒蛋',
          servings: 1,
          note: '',
          rating: 2,
        },
      ],
      participant_user_ids: ['user-2'],
    });
    const updateMealLog = vi.fn(async () => {
      throw new ApiError({
        status: 409,
        detail: '这餐已被其他人更新',
        path: '/api/meal-logs/meal-1',
        payload: {
          detail: {
            code: 'meal_log_stale',
            message: '这餐已被其他人更新',
            current: serverMeal,
            recovery_hint: 'refresh_and_review',
          },
        },
      });
    });
    const onStale = vi.fn();

    const { result } = renderHook(() =>
      useMealEnrichmentState({
        meal: mealLog(),
        isUpdating: false,
        updateMealLog,
        onStale,
      }),
    );

    act(() => {
      result.current.setNotes('我本地草稿备注');
      result.current.updateEntryRating('entry-1', '4.5');
    });

    await act(async () => {
      await result.current.save(false);
    });

    expect(result.current.notes).toBe('我本地草稿备注');
    expect(result.current.entryRatings['entry-1']).toBe('4.5');
    expect(result.current.participants).toEqual(['user-1']);
    expect(result.current.expectedRowVersion).toBe(9);
    expect(result.current.staleMessage).toContain('请查看最新内容后再保存');
    expect(onStale).toHaveBeenCalledWith(
      expect.objectContaining({
        message: expect.stringContaining('请查看最新内容后再保存'),
        current: expect.objectContaining({ row_version: 9 }),
      }),
    );
  });
});
