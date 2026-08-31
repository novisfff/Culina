import { describe, expect, it } from 'vitest';
import {
  buildFoodEditorSceneTagOptions,
  buildFoodGovernanceSummary,
  buildFoodMobileFilterTabs,
  buildFoodMobileWorkspaceViewModel,
  buildRecipeEditorSceneTagOptions,
} from './FoodWorkspaceViewModel';

describe('FoodWorkspaceViewModel scene options', () => {
  it('returns visible food and current editor tags once in locale order', () => {
    const result = buildFoodEditorSceneTagOptions({
      foodScenes: [
        { id: '1', name: '早餐', description: '', image_prompt: '', hidden: false, custom: true, sort_order: 0 } as never,
        { id: '2', name: '隐藏场景', description: '', image_prompt: '', hidden: true, custom: true, sort_order: 1 } as never,
      ],
      foods: [{ scene_tags: ['晚餐', '早餐'] } as never],
      editorSceneTags: ['自定义', '早餐'],
    });

    expect(result).toEqual(['晚餐', '早餐', '自定义']);
  });

  it('builds recipe tags from visible scenes and linked recipes', () => {
    const result = buildRecipeEditorSceneTagOptions({
      foodScenes: [{ id: '1', name: '家常', description: '', image_prompt: '', hidden: false, custom: true, sort_order: 0 } as never],
      recipes: [{ scene_tags: ['快手', '家常'] } as never],
    });

    expect(result).toEqual(['家常', '快手']);
  });

  it('projects mobile scene cards and library filters without React state', () => {
    const result = buildFoodMobileWorkspaceViewModel({
      foods: [{ id: 'f-1', name: '番茄炒蛋', scene: '晚餐', scene_tags: [], suitable_meal_types: [], favorite: false } as never],
      filteredFoods: [{ id: 'f-1', name: '番茄炒蛋', scene: '晚餐', scene_tags: [], suitable_meal_types: [], favorite: false } as never],
      sceneCards: [],
      defaultScenes: [],
      cookingFilter: 'all',
      appliedSearch: '',
      typeFilter: 'all',
      mealFilter: 'all',
      lensFilter: 'all',
      sceneFilter: 'all',
      governanceIssueFilter: 'all',
      getCookingSummary: () => null,
    });

    expect(result.mobileLibraryFoods).toHaveLength(1);
    expect(result.mobileLibraryResetKey).toContain('all');
    expect(result.mobileScenePages).toEqual([[]]);
  });

  it('keeps mobile filter tabs mutually exclusive and resets the cooking lens', () => {
    const calls: string[] = [];
    const tabs = buildFoodMobileFilterTabs({
      lensFilter: 'favorite',
      typeFilter: 'all',
      mealFilter: 'all',
      sceneFilter: '晚餐',
      governanceIssueFilter: 'all',
      cookingFilter: 'all',
      clearFilters: () => calls.push('clear'),
      setCookingFilter: (value) => calls.push(`cooking:${value}`),
      setLensFilter: (value) => calls.push(`lens:${value}`),
      setTypeFilter: (value) => calls.push(`type:${value}`),
      setMealFilter: (value) => calls.push(`meal:${value}`),
      setSceneFilter: (value) => calls.push(`scene:${value}`),
      setGovernanceIssueFilter: (value) => calls.push(`issue:${value}`),
    });

    expect(tabs.find((tab) => tab.label === '收藏')?.active).toBe(true);
    tabs.find((tab) => tab.label === '可做')?.onClick();
    expect(calls).toEqual(['cooking:ready', 'lens:all', 'type:all', 'meal:all', 'scene:all', 'issue:all']);
  });

  it('deduplicates governance issues and describes the next queued food', () => {
    const food = {
      id: 'f-1', name: '番茄', type: 'takeout', source_name: '外卖', purchase_source: '',
      images: [], suitable_meal_types: [], routine_note: '', notes: '', scene: '',
      stock_quantity: null, stock_unit: '',
    } as never;
    const result = buildFoodGovernanceSummary({
      expiringFoods: [food],
      needsInfoFoods: [food],
      governanceQueue: [food],
      recipes: [],
      hasFilters: true,
    });

    expect(result.managementIssueCount).toBe(1);
    expect(result.nextGovernanceFood).toBe(food);
    expect(result.nextGovernanceSummary).toContain('番茄');
    expect(result.hasFoodFilters).toBe(true);
  });
});
