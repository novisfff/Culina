import { renderHook, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { FoodQuickRecordState } from './FoodQuickRecordState';
import { useFoodQuickRecordCandidates } from './useFoodQuickRecordCandidates';

function state(): FoodQuickRecordState {
  return {
    food: { id: 'food-1', name: '米饭' } as FoodQuickRecordState['food'],
    date: '2026-08-30',
    mealType: 'lunch',
    target: { kind: 'new' },
    selectedCandidateId: null,
    candidateMode: 'none',
    candidates: [],
    candidateResolution: { status: 'loading' },
    targetTouchedByUser: true,
    clientRequestId: 'client-1',
    busy: false,
    error: null,
  };
}

describe('useFoodQuickRecordCandidates', () => {
  it('keeps a manually selected target while refreshing candidates', async () => {
    const current = state();
    const setQuickRecord = vi.fn();
    const loadMealCandidates = vi.fn().mockResolvedValue([
      { id: 'meal-1', title: '午餐', date: current.date, meal_type: current.mealType } as never,
    ]);

    renderHook(() => useFoodQuickRecordCandidates({ quickRecord: current, setQuickRecord, loadMealCandidates }));
    await waitFor(() => expect(loadMealCandidates).toHaveBeenCalledWith(current.date, current.mealType));

    const updates = setQuickRecord.mock.calls.map(([update]) => update).filter((update) => typeof update === 'function');
    const latest = updates.reduce((value, update) => update(value), current);
    expect(latest.candidateResolution).toEqual({ status: 'ready' });
    expect(latest.target).toEqual(current.target);
  });
});
