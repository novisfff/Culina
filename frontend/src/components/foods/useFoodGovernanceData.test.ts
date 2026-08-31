import { describe, expect, it } from 'vitest';
import type { Food, Recipe } from '../../api/types/food';
import { FOOD_GOVERNANCE_ISSUE_OPTIONS } from './FoodWorkspaceOptions';
import { buildFoodGovernanceData } from './useFoodGovernanceData';

describe('buildFoodGovernanceData', () => {
  it('keeps expiring and incomplete foods separate and orders the governance queue by issue count', () => {
    const foods = [
      { id: 'complete', name: '完整', updated_at: '2026-08-28', expiry_date: '2027-01-01', type: 'instant', suitable_meal_types: ['dinner'], images: [{ id: 'cover', url: '/cover.jpg', alt: '完整' }], routine_note: '晚餐备用', notes: '', scene: '', scene_tags: [], source_name: '自制', purchase_source: '', stock_quantity: 1, stock_unit: '份', storage_location: '冷冻' } as unknown as Food,
      { id: 'incomplete', name: '待完善', updated_at: '2026-08-30', expiry_date: null, type: 'instant', suitable_meal_types: [], images: [], routine_note: '', notes: '', scene: '', scene_tags: [], source_name: '', purchase_source: '', stock_quantity: null, stock_unit: '', storage_location: '' } as unknown as Food,
    ];
    const recipes: Recipe[] = [];
    const result = buildFoodGovernanceData(foods, recipes, 'all', FOOD_GOVERNANCE_ISSUE_OPTIONS);

    expect(result.expiringFoods).toEqual([]);
    expect(result.needsInfoFoods.map((food) => food.id)).toContain('incomplete');
    expect(result.governanceIssueSummaries).toHaveLength(FOOD_GOVERNANCE_ISSUE_OPTIONS.length);
    expect(result.governanceQueue[0]?.id).toBe('incomplete');
  });
});
