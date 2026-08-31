import type { Ingredient } from '../../api/types';
import { tracksIngredientQuantity } from '../../lib/ingredientTracking';
import type { IngredientCategoryPreset } from './workspaceTypes';

const SEASONING_CATEGORY_LABELS = new Set(['调料', '调味料', '酱料']);

export const INGREDIENT_CATEGORY_PRESETS: IngredientCategoryPreset[] = [
  { label: '蔬菜', defaultUnit: '个', defaultStorage: '冷藏', icon: 'vegetable' },
  { label: '水果', defaultUnit: '个', defaultStorage: '常温', icon: 'fruit' },
  { label: '肉类', defaultUnit: '份', defaultStorage: '冷冻', icon: 'meat' },
  { label: '水产', defaultUnit: '块', defaultStorage: '冷冻', icon: 'fish' },
  { label: '蛋奶', defaultUnit: '个', defaultStorage: '冷藏', icon: 'egg' },
  { label: '豆制品', defaultUnit: '盒', defaultStorage: '冷藏', icon: 'tofu' },
  { label: '菌菇', defaultUnit: '盒', defaultStorage: '冷藏', icon: 'mushroom' },
  { label: '主食', defaultUnit: '份', defaultStorage: '常温', icon: 'staple' },
  { label: '干货', defaultUnit: '袋', defaultStorage: '常温', icon: 'dryGoods' },
  { label: '坚果果干', defaultUnit: '袋', defaultStorage: '常温', icon: 'nuts' },
  { label: '烘焙食材', defaultUnit: '袋', defaultStorage: '常温', icon: 'baking' },
  { label: '调料', defaultUnit: '瓶', defaultStorage: '常温', quantityTrackingMode: 'not_track_quantity', icon: 'seasoning' },
  { label: '调味料', defaultUnit: '瓶', defaultStorage: '常温', icon: 'seasoning' },
  { label: '酱料', defaultUnit: '瓶', defaultStorage: '常温', icon: 'seasoning' },
  { label: '罐头腌菜', defaultUnit: '罐', defaultStorage: '常温', icon: 'canned' },
  { label: '熟食', defaultUnit: '份', defaultStorage: '冷藏', icon: 'prepared' },
  { label: '速冻食品', defaultUnit: '袋', defaultStorage: '冷冻', icon: 'frozen' },
  { label: '零食饮品', defaultUnit: '包', defaultStorage: '常温', icon: 'snack' },
  { label: '其他', defaultUnit: '份', defaultStorage: '常温', icon: 'more' },
];

const EDITOR_CATEGORY_PRESET_LABELS = [
  '蔬菜', '肉类', '水产', '蛋奶', '调料', '水果', '主食', '豆制品', '干货', '其他',
];

const CATEGORY_PRESET_MAP = new Map(
  INGREDIENT_CATEGORY_PRESETS.map((item) => [item.label, item] satisfies [string, IngredientCategoryPreset]),
);

function normalizeCategoryLabel(value: string) {
  return value.trim() || '未分类';
}

export function isSeasoningIngredient(ingredient: Pick<Ingredient, 'category' | 'quantity_tracking_mode'>) {
  return !tracksIngredientQuantity(ingredient) || SEASONING_CATEGORY_LABELS.has(normalizeCategoryLabel(ingredient.category));
}

export function getIngredientCategoryPreset(category: string) {
  return CATEGORY_PRESET_MAP.get(normalizeCategoryLabel(category)) ?? null;
}

export function getIngredientEditorCategoryPresets() {
  return EDITOR_CATEGORY_PRESET_LABELS.map((label) => CATEGORY_PRESET_MAP.get(label)).filter(
    (item): item is IngredientCategoryPreset => Boolean(item),
  );
}

export function buildIngredientCategoryFilters(ingredients: Ingredient[]) {
  const existingCategories = [...new Set(ingredients.map((item) => normalizeCategoryLabel(item.category)).filter(Boolean))];
  const secondaryPresetLabels = INGREDIENT_CATEGORY_PRESETS
    .map((item) => item.label)
    .filter((label) => !EDITOR_CATEGORY_PRESET_LABELS.includes(label) && existingCategories.includes(label));
  const customLabels = existingCategories
    .filter((label) => !CATEGORY_PRESET_MAP.has(label))
    .sort((left, right) => left.localeCompare(right, 'zh-CN'));
  return [...EDITOR_CATEGORY_PRESET_LABELS, ...secondaryPresetLabels, ...customLabels];
}
