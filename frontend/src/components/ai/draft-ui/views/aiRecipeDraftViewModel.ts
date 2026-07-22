import type { AiGeneratedRecipeDraft, Difficulty, Ingredient } from '../../../../api/types';
import { tracksIngredientQuantity } from '../../../../lib/ingredientTracking';
import { buildUnitPresetOptions } from '../../../ingredients/ingredientWorkspaceForms';
import { asDraftArray, asNumber, asText, draftNumberInputValue } from '../../aiDraftValueUtils';

export const RECIPE_DIFFICULTY_OPTIONS = [
  { value: 'easy', label: '简单' },
  { value: 'medium', label: '适中' },
  { value: 'hard', label: '较难' },
];

export function recipeDifficultyLabel(value: unknown) {
  const text = asText(value);
  return RECIPE_DIFFICULTY_OPTIONS.find((option) => option.value === text)?.label ?? text;
}

export function recipeDraftSummaryItems(recipe: AiGeneratedRecipeDraft) {
  return [
    { label: '菜谱名', value: recipe.title || '未命名菜谱' },
    { label: '份量', value: `${asNumber(recipe.servings, 0) || '?'} 人份` },
    { label: '预计时间', value: `${asNumber(recipe.prep_minutes, 0) || '?'} 分钟` },
    { label: '难度', value: recipeDifficultyLabel(recipe.difficulty) || '未设置' },
    { label: '食材', value: `${recipe.ingredient_items.length} 种` },
    { label: '步骤', value: `${recipe.steps.length} 步` },
  ];
}

export function recipeDraftUnitOptions(unit: string) {
  return buildUnitPresetOptions(unit).map((item) => ({ value: item, label: item }));
}

export function recipeIngredientUsesPresenceQuantity(
  item: AiGeneratedRecipeDraft['ingredient_items'][number],
  ingredients: readonly Ingredient[],
) {
  if (!item.ingredient_id) return false;
  const ingredient = ingredients.find((entry) => entry.id === item.ingredient_id);
  return Boolean(ingredient && !tracksIngredientQuantity(ingredient));
}

function recipeIngredientItemsFromUnknown(value: unknown): AiGeneratedRecipeDraft['ingredient_items'] {
  return asDraftArray(value).map((item) => ({
    ingredient_id: asText(item.ingredient_id) || asText(item.ingredientId) || null,
    ingredient_name: asText(item.ingredient_name) || asText(item.ingredientName) || asText(item.name),
    quantity: draftNumberInputValue(item.quantity, 1) as number,
    unit: asText(item.unit, '份'),
    note: asText(item.note),
  }));
}

function recipeStepsFromUnknown(value: unknown): AiGeneratedRecipeDraft['steps'] {
  return asDraftArray(value).map((item, index) => ({
    title: asText(item.title, `步骤 ${index + 1}`),
    text: asText(item.text),
    icon: asText(item.icon, 'pan'),
    summary: asText(item.summary),
    estimated_minutes: item.estimated_minutes === null ? null : asNumber(item.estimated_minutes, 5),
    tip: asText(item.tip),
    key_points: Array.isArray(item.key_points) ? item.key_points.map(String).filter(Boolean) : [],
  }));
}

export function recipeDraftFromRecord(record: Record<string, unknown>, fallback?: Record<string, unknown>): AiGeneratedRecipeDraft {
  const fallbackRecord = fallback ?? {};
  const difficulty = asText(record.difficulty) || asText(fallbackRecord.difficulty) || 'easy';
  return {
    title: asText(record.title) || asText(fallbackRecord.title),
    servings: draftNumberInputValue(record.servings, asNumber(fallbackRecord.servings, 1)) as number,
    prep_minutes: draftNumberInputValue(record.prep_minutes, asNumber(fallbackRecord.prep_minutes, 0)) as number,
    difficulty: (RECIPE_DIFFICULTY_OPTIONS.some((option) => option.value === difficulty) ? difficulty : 'easy') as Difficulty,
    ingredient_items: recipeIngredientItemsFromUnknown(record.ingredient_items ?? fallbackRecord.ingredient_items),
    steps: recipeStepsFromUnknown(record.steps ?? fallbackRecord.steps),
    tips: asText(record.tips) || asText(fallbackRecord.tips),
    scene_tags: Array.isArray(record.scene_tags) ? record.scene_tags.map(String).filter(Boolean) : Array.isArray(fallbackRecord.scene_tags) ? fallbackRecord.scene_tags.map(String).filter(Boolean) : [],
    media_ids: Array.isArray(record.media_ids) ? record.media_ids.map(String).filter(Boolean) : [],
  };
}
