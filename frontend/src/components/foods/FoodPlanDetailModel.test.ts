import { describe, expect, it } from 'vitest';
import type { Food } from '../../api/types';
import { getFoodPlanDetailFacts } from './FoodPlanDetailModel';

function buildFood(overrides: Partial<Food> = {}): Food {
  return {
    id: 'food-1',
    family_id: 'family-1',
    name: '盒装牛奶',
    type: 'readyMade',
    category: '乳制品',
    flavor_tags: [],
    suitable_meal_types: ['breakfast'],
    source_name: '',
    purchase_source: '社区超市',
    scene: '',
    images: [],
    notes: '',
    routine_note: '',
    price: null,
    rating: null,
    repurchase: null,
    expiry_date: '2026-07-18',
    stock_quantity: 2,
    stock_unit: '盒',
    storage_location: '冷藏',
    favorite: false,
    recipe_id: null,
    row_version: 1,
    created_at: '2026-07-10T00:00:00Z',
    updated_at: '2026-07-10T00:00:00Z',
    ...overrides,
  };
}

describe('getFoodPlanDetailFacts', () => {
  it('shows recipe-oriented facts for homemade food', () => {
    expect(
      getFoodPlanDetailFacts(
        buildFood({
          type: 'selfMade',
          category: '家常菜',
          suitable_meal_types: ['lunch', 'dinner'],
          recipe_id: 'recipe-1',
        }),
      ),
    ).toEqual([
      { label: '分类', value: '家常菜' },
      { label: '适合餐次', value: '午餐、晚餐' },
      { label: '关联菜谱', value: '已关联' },
    ]);
  });

  it('shows source and decision facts for outside food', () => {
    expect(
      getFoodPlanDetailFacts(
        buildFood({
          type: 'takeout',
          category: '粉面',
          source_name: '巷口米粉',
          price: 26,
          repurchase: true,
        }),
      ),
    ).toEqual([
      { label: '分类', value: '粉面' },
      { label: '店铺', value: '巷口米粉' },
      { label: '价格', value: '¥26' },
      { label: '复购', value: '愿意复购' },
    ]);
  });

  it('shows inventory facts for ready-made food', () => {
    expect(getFoodPlanDetailFacts(buildFood(), '2026-07-14')).toEqual([
      { label: '分类', value: '乳制品' },
      { label: '库存', value: '2盒' },
      { label: '存放', value: '冷藏' },
      { label: '到期', value: '4 天后到期' },
    ]);
  });
});
