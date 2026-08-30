import { describe, expect, it } from 'vitest';
import {
  buildFoodEditorSceneTagOptions,
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
});
