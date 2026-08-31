import { act, renderHook } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, it } from 'vitest';
import type { Food } from '../../api/types/food';
import { useFoodQuickMealActions } from './useFoodQuickMealActions';
import type { FoodQuickMealDialogState } from './FoodQuickMealDialog';
import type { FoodQuickRecordState } from './FoodQuickRecordState';

const food = { id: 'food-1', name: '番茄炒蛋', type: 'selfMade', recipe_id: 'recipe-1', scene_tags: [], suitable_meal_types: [] } as unknown as Food;

describe('useFoodQuickMealActions', () => {
  it('opens recipe foods in cook confirmation with recipe servings', () => {
    const { result } = renderHook(() => {
      const [quickMealDialog, setQuickMealDialog] = useState<FoodQuickMealDialogState | null>(null);
      const [quickRecord, setQuickRecord] = useState<FoodQuickRecordState | null>(null);
      return { ...useFoodQuickMealActions({ recipes: [{ id: 'recipe-1', servings: 4 } as never], mealBusinessDate: '2026-08-30', suggestedMealType: 'dinner', setQuickMealDialog, setQuickRecord }), quickMealDialog, quickRecord };
    });

    act(() => result.current.handleFoodCardPrimaryAction(food, 'dinner'));
    expect(result.current.quickMealDialog).toMatchObject({ action: 'cook', recipeId: 'recipe-1', servings: 4 });
    expect(result.current.quickRecord).toBeNull();
  });
});
