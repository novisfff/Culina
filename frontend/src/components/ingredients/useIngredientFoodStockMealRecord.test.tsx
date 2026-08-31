import { renderHook, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { FoodQuickRecordState } from './useIngredientFoodStockState';
import { useIngredientFoodStockMealRecord } from './useIngredientFoodStockMealRecord';

function createQuickRecord(): FoodQuickRecordState {
  return {
    food: { id: 'food-1', name: '米饭' } as FoodQuickRecordState['food'],
    item: { source_id: 'food-1', title: '米饭', quantity: 2, unit: '份', row_version: 1 } as FoodQuickRecordState['item'],
    date: '2026-08-30',
    mealType: 'lunch',
    target: { kind: 'new' },
    selectedCandidateId: null,
    candidateMode: 'none',
    candidates: [],
    candidateResolution: { status: 'loading' },
    targetTouchedByUser: false,
    clientRequestId: 'client-1',
    busy: false,
    error: null,
  };
}

describe('useIngredientFoodStockMealRecord', () => {
  it('resolves a single candidate without mutating the target when the user already touched it', async () => {
    const initial = createQuickRecord();
    const setQuickRecord = vi.fn();
    const loadMealCandidates = vi.fn().mockResolvedValue([
      { id: 'meal-1', title: '午餐', date: initial.date, meal_type: initial.mealType } as never,
    ]);

    renderHook(() =>
      useIngredientFoodStockMealRecord({
        quickRecord: { ...initial, targetTouchedByUser: true },
        setQuickRecord,
        setInventoryFollowUp: vi.fn(),
        loadMealCandidates,
        recordMeal: vi.fn(),
        recipes: [],
        onRecordSuccess: vi.fn(),
      }),
    );

    await waitFor(() => expect(loadMealCandidates).toHaveBeenCalledWith(initial.date, initial.mealType));
    const updates = setQuickRecord.mock.calls.map(([update]) => update).filter((update) => typeof update === 'function');
    expect(updates.length).toBeGreaterThan(0);
    const latest = updates.reduce((state, update) => update(state), { ...initial, targetTouchedByUser: true });
    expect(latest.candidateResolution).toEqual({ status: 'ready' });
    expect(latest.target).toEqual(initial.target);
    expect(latest.selectedCandidateId).toBeNull();
  });
});
