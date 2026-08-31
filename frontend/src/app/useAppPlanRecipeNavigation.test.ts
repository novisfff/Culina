import { renderHook, act } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { useAppPlanRecipeNavigation } from './useAppPlanRecipeNavigation';

describe('useAppPlanRecipeNavigation', () => {
  it('prefers the latest fetched plan detail version', () => {
    const start = vi.fn();
    const { result } = renderHook(() => useAppPlanRecipeNavigation({
      foodPlanDetail: { id: 'plan-1', plan_date: '2026-08-31', meal_type: 'lunch', updated_at: 'new' },
      startPlanRecipe: start,
    }));
    act(() => result.current({ foodPlanItemId: 'plan-1', planDate: 'old', mealType: 'dinner', planItemBaseUpdatedAt: 'old' }));
    expect(start).toHaveBeenCalledWith({ foodPlanItemId: 'plan-1', planDate: '2026-08-31', mealType: 'lunch', planItemBaseUpdatedAt: 'new' });
  });
});
