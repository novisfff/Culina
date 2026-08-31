import type { Ingredient } from '../../api/types/inventory';
import type { AiRenderPayload } from '../../lib/aiImages';
import { type IngredientCreateFormState } from './ingredientWorkspaceForms';

export function formatExpiryRuleLabel(ingredient: Ingredient) {
  const expiryMode =
    ingredient.default_expiry_mode === 'days' ||
    ingredient.default_expiry_mode === 'manual_date' ||
    ingredient.default_expiry_mode === 'none'
      ? ingredient.default_expiry_mode
      : 'none';
  if (expiryMode === 'days') {
    return ingredient.default_expiry_days ? `买后 ${ingredient.default_expiry_days} 天到期` : '按买后天数计算到期';
  }
  if (expiryMode === 'manual_date') {
    return '补充库存时填写包装到期日';
  }
  return '默认不设置到期日';
}

export function formatLowStockRuleLabel(ingredient: Ingredient) {
  return ingredient.default_low_stock_threshold !== null && ingredient.default_low_stock_threshold !== undefined
    ? `少于 ${ingredient.default_low_stock_threshold} ${ingredient.default_unit} 时提醒`
    : '没有设置低库存提醒';
}

export function buildIngredientImagePayload(form: IngredientCreateFormState): AiRenderPayload {
  return {
    entity_type: 'ingredient',
    title: form.name.trim() || '家庭食材',
    category: form.category.trim(),
    notes: form.notes.trim(),
  };
}
