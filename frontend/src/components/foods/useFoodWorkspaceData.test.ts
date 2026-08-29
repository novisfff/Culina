import { describe, expect, it } from 'vitest';
import type { Food } from '../../api/types/food';
import { buildFoodWorkspaceData } from './useFoodWorkspaceData';

describe('buildFoodWorkspaceData', () => {
  it('filters food cards while preserving stable usage and reset projections', () => {
    const foods = [
      { id: 'food-1', name: '番茄炒蛋', type: 'selfMade', suitable_meal_types: ['dinner'], scene_tags: [], images: [], routine_note: '', notes: '', scene: '', source_name: '', purchase_source: '', stock_quantity: null, stock_unit: '', storage_location: '', expiry_date: null, favorite: false } as unknown as Food,
      { id: 'food-2', name: '米饭', type: 'instant', suitable_meal_types: ['lunch'], scene_tags: [], images: [], routine_note: '', notes: '', scene: '', source_name: '', purchase_source: '', stock_quantity: null, stock_unit: '', storage_location: '', expiry_date: null, favorite: false } as unknown as Food,
    ];
    const result = buildFoodWorkspaceData({
      foods,
      searchAwareFoods: foods,
      recipes: [],
      ingredients: [],
      inventoryItems: [],
      mealLogs: [],
      appliedFoodSearch: '番茄',
      matchedFoodIds: [],
      typeFilter: 'all',
      mealFilter: 'all',
      lensFilter: 'all',
      sceneFilter: 'all',
      governanceIssueFilter: 'all',
    });

    expect(result.filteredFoods.map((food) => food.id)).toEqual(['food-1']);
    expect(result.foodUsageCards).toHaveLength(2);
    expect(result.foodCardResetKey).toBe('番茄|all|all|all|all|all');
  });
});
