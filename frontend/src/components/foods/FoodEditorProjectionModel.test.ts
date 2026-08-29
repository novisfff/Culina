import { describe, expect, it } from 'vitest';
import { buildRecipeEditorCompletionState } from './FoodEditorProjectionModel';

describe('FoodEditorProjectionModel', () => {
  it('projects recipe completion without coupling to editor state', () => {
    const result = buildRecipeEditorCompletionState({
      title: '番茄炒蛋',
      servings: 2,
      ingredientRows: [{ ingredient_id: 'egg', ingredient_name: '' }, { ingredient_name: '番茄' }],
      steps: [{ text: '炒熟' }, { text: '' }],
      hasCover: true,
    });

    expect(result.ingredientCount).toBe(2);
    expect(result.stepCount).toBe(1);
    expect(result.percent).toBe(100);
  });

  it('does not count blank recipe editor fields as complete', () => {
    const result = buildRecipeEditorCompletionState({
      title: '',
      servings: 0,
      ingredientRows: [{ ingredient_name: '' }],
      steps: [{ text: ' ' }],
      hasCover: false,
    });

    expect(result.percent).toBe(0);
  });
});
