// @vitest-environment jsdom

import { act, renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type {
  MealLog,
  MealLogRecordOperationSummary,
  RecordMealResponse,
  RevertMealRecordResponse,
  UpdateMealLogPayload,
} from '../../api/types';
import { useMealRecordResultState } from './useMealRecordResultState';

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
    notes: '',
    mood: '',
    photos: [],
    deduction_suggestions: [],
    row_version: 3,
    created_at: '2026-07-15T11:00:00.000Z',
    updated_at: '2026-07-15T11:00:00.000Z',
    ...overrides,
  };
}

function recordResponse(overrides: Partial<RecordMealResponse> = {}): RecordMealResponse {
  return {
    meal_log: mealLog(),
    created_foods: [],
    outcome: 'created',
    operation: {
      id: 'op-1',
      status: 'applied',
      revertible_until: '2026-07-15T11:15:00.000Z',
      can_revert: true,
    },
    ...overrides,
  };
}

function summary(
  overrides: Partial<MealLogRecordOperationSummary> = {},
): MealLogRecordOperationSummary {
  return {
    id: 'op-restored',
    meal_log_id: 'meal-restored',
    foods: [
      {
        food_id: 'food-2',
        name: '青菜',
        food_type: 'selfMade',
        cover: null,
      },
    ],
    preview_media: null,
    revertible_until: '2026-07-15T12:00:00.000Z',
    can_revert: true,
    ...overrides,
  };
}

describe('useMealRecordResultState', () => {
  it('publishes immediate ordinary record with full MealLog row version for optional rating', () => {
    const { result } = renderHook(() =>
      useMealRecordResultState({
        activeOperations: [],
        revertOperation: vi.fn(async () => ({ status: 'reverted', meal_log: null, removed_food_ids: [], replayed: false })),
        rateMeal: vi.fn(async () => mealLog()),
        onViewMeal: vi.fn(),
      }),
    );

    act(() => {
      result.current.publishRecordResult(recordResponse());
    });

    expect(result.current.result).toMatchObject({
      source: 'immediate',
      operationId: 'op-1',
      mealLogId: 'meal-1',
      canRevert: true,
      canRate: true,
      rowVersion: 3,
    });
    expect(result.current.result?.mealLog?.row_version).toBe(3);
    expect(result.current.result?.foods[0]?.name).toBe('番茄炒蛋');
  });

  it('restores the newest active operation on refresh with undo/view even without rating data', () => {
    const older = summary({
      id: 'op-older',
      meal_log_id: 'meal-older',
      revertible_until: '2026-07-15T11:30:00.000Z',
    });
    const newer = summary({
      id: 'op-newer',
      meal_log_id: 'meal-newer',
      foods: [{ food_id: 'food-9', name: '红烧肉', food_type: 'selfMade' }],
      revertible_until: '2026-07-15T12:30:00.000Z',
    });

    const { result, rerender } = renderHook(
      ({ activeOperations }) =>
        useMealRecordResultState({
          activeOperations,
          revertOperation: vi.fn(async () => ({
            status: 'reverted',
            meal_log: null,
            removed_food_ids: [],
            replayed: false,
          })),
          onViewMeal: vi.fn(),
        }),
      { initialProps: { activeOperations: [] as MealLogRecordOperationSummary[] } },
    );

    expect(result.current.result).toBeNull();

    rerender({ activeOperations: [older, newer] });
    expect(result.current.result).toMatchObject({
      source: 'restored',
      operationId: 'op-newer',
      mealLogId: 'meal-newer',
      canRevert: true,
      canRate: false,
      mealLog: null,
      rowVersion: null,
    });
    expect(result.current.result?.foods[0]?.name).toBe('红烧肉');

    act(() => {
      result.current.viewMeal();
    });
  });

  it('prefers the just-returned full result over restored summaries', () => {
    const { result, rerender } = renderHook(
      ({ activeOperations }) =>
        useMealRecordResultState({
          activeOperations,
          revertOperation: vi.fn(async () => ({
            status: 'reverted',
            meal_log: null,
            removed_food_ids: [],
            replayed: false,
          })),
        }),
      {
        initialProps: {
          activeOperations: [summary({ id: 'op-restored', meal_log_id: 'meal-restored' })],
        },
      },
    );

    act(() => {
      result.current.publishRecordResult(recordResponse());
    });
    expect(result.current.result?.operationId).toBe('op-1');
    expect(result.current.result?.source).toBe('immediate');

    rerender({
      activeOperations: [
        summary({ id: 'op-restored', meal_log_id: 'meal-restored' }),
        summary({
          id: 'op-1',
          meal_log_id: 'meal-1',
          foods: [{ food_id: 'food-1', name: '番茄炒蛋', food_type: 'selfMade' }],
        }),
      ],
    });
    expect(result.current.result?.source).toBe('immediate');
    expect(result.current.result?.mealLog?.row_version).toBe(3);
  });

  it('reverts with server operation id non-optimistically and keeps result on failure', async () => {
    const revertOperation = vi
      .fn<[], Promise<RevertMealRecordResponse>>()
      .mockRejectedValueOnce(new Error('network'))
      .mockResolvedValueOnce({
        status: 'reverted',
        meal_log: null,
        removed_food_ids: ['food-1'],
        replayed: false,
      });

    const { result } = renderHook(() =>
      useMealRecordResultState({
        activeOperations: [],
        revertOperation,
      }),
    );

    act(() => {
      result.current.publishRecordResult(recordResponse());
    });

    await act(async () => {
      await result.current.revert();
    });
    expect(revertOperation).toHaveBeenCalledWith('op-1');
    expect(result.current.result).not.toBeNull();
    expect(result.current.result?.operationId).toBe('op-1');
    expect(result.current.revertError).toBeTruthy();
    expect(result.current.isReverting).toBe(false);

    await act(async () => {
      await result.current.revert();
    });
    expect(revertOperation).toHaveBeenCalledTimes(2);
    expect(revertOperation.mock.calls[1]![0]).toBe('op-1');
    expect(result.current.result).toBeNull();
    expect(result.current.revertError).toBeNull();
  });

  it('rates only when full MealLog with row_version is present; blank rating is a no-op', async () => {
    const rateMeal = vi.fn(async (_id: string, _payload: UpdateMealLogPayload) => mealLog({ row_version: 4 }));
    const { result } = renderHook(() =>
      useMealRecordResultState({
        activeOperations: [summary()],
        revertOperation: vi.fn(async () => ({
          status: 'reverted',
          meal_log: null,
          removed_food_ids: [],
          replayed: false,
        })),
        rateMeal,
      }),
    );

    expect(result.current.result?.canRate).toBe(false);
    await act(async () => {
      await result.current.rate(4.5);
    });
    expect(rateMeal).not.toHaveBeenCalled();

    act(() => {
      result.current.publishRecordResult(recordResponse());
    });
    expect(result.current.result?.canRate).toBe(true);

    await act(async () => {
      await result.current.rate(undefined);
    });
    expect(rateMeal).not.toHaveBeenCalled();

    await act(async () => {
      await result.current.rate(4.5);
    });
    expect(rateMeal).toHaveBeenCalledWith('meal-1', {
      expected_row_version: 3,
      food_entry_ratings: [{ id: 'entry-1', rating: 4.5 }],
    });
  });

  it('exposes only ordinary record publish API; cook/plan/AI have no publish methods', () => {
    const { result } = renderHook(() =>
      useMealRecordResultState({
        activeOperations: [],
        revertOperation: vi.fn(async () => ({
          status: 'reverted',
          meal_log: null,
          removed_food_ids: [],
          replayed: false,
        })),
      }),
    );

    expect(typeof result.current.publishRecordResult).toBe('function');
    expect(result.current).not.toHaveProperty('publishCookResult');
    expect(result.current).not.toHaveProperty('publishPlanResult');
    expect(result.current).not.toHaveProperty('publishAiResult');
    expect(result.current).not.toHaveProperty('publishRecipeResult');
  });

  it('navigates view using meal_log_id from immediate or restored result', () => {
    const onViewMeal = vi.fn();
    const { result, rerender } = renderHook(
      ({ activeOperations }) =>
        useMealRecordResultState({
          activeOperations,
          revertOperation: vi.fn(async () => ({
            status: 'reverted',
            meal_log: null,
            removed_food_ids: [],
            replayed: false,
          })),
          onViewMeal,
        }),
      { initialProps: { activeOperations: [] as MealLogRecordOperationSummary[] } },
    );

    act(() => {
      result.current.publishRecordResult(recordResponse());
    });
    act(() => {
      result.current.viewMeal();
    });
    expect(onViewMeal).toHaveBeenCalledWith('meal-1');

    act(() => {
      result.current.dismiss();
    });
    rerender({ activeOperations: [summary({ meal_log_id: 'meal-restored' })] });
    act(() => {
      result.current.viewMeal();
    });
    expect(onViewMeal).toHaveBeenCalledWith('meal-restored');
  });
});
