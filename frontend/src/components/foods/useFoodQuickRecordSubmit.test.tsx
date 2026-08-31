import { renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { FoodQuickRecordState } from './FoodQuickRecordState';
import { useFoodQuickRecordSubmit } from './useFoodQuickRecordSubmit';

function state(): FoodQuickRecordState {
  return {
    food: { id: 'food-1', name: '米饭', images: [], recipe_id: null } as unknown as FoodQuickRecordState['food'],
    date: '2026-08-30', mealType: 'lunch', target: { kind: 'new' }, selectedCandidateId: null,
    candidateMode: 'none', candidates: [], candidateResolution: { status: 'ready' },
    targetTouchedByUser: false, clientRequestId: 'client-1', busy: false, error: null,
  };
}

describe('useFoodQuickRecordSubmit', () => {
  it('clears the record and reports feedback after a successful submit', async () => {
    const setQuickRecord = vi.fn();
    const recordMeal = vi.fn().mockResolvedValue({ id: 'record-1' });
    const setFeedback = vi.fn();
    const { result } = renderHook(() => useFoodQuickRecordSubmit({
      quickRecord: state(), setQuickRecord, recordMeal, recipes: [], setFeedback,
      mealBusinessDate: '2026-08-30',
    }));

    await result.current.submitCompactRecord();
    expect(recordMeal).toHaveBeenCalledOnce();
    expect(setQuickRecord).toHaveBeenCalledWith(null);
    expect(setFeedback).toHaveBeenCalledWith('米饭 已记入今天午餐');
  });
});
