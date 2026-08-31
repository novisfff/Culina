import { describe, expect, it } from 'vitest';
import { buildIngredientImagePayload, formatExpiryRuleLabel, formatLowStockRuleLabel } from './ingredientWorkspaceModels';

describe('ingredient workspace models', () => {
  it('formats expiry and low-stock policies', () => {
    const ingredient = { default_expiry_mode: 'days', default_expiry_days: 7, default_low_stock_threshold: 2, default_unit: '个' } as never;
    expect(formatExpiryRuleLabel(ingredient)).toContain('7');
    expect(formatLowStockRuleLabel(ingredient)).toContain('2');
  });

  it('builds an image payload from the editor form', () => {
    expect(buildIngredientImagePayload({ name: ' 西红柿 ', category: '蔬菜', notes: '常用' } as never))
      .toEqual({ entity_type: 'ingredient', title: '西红柿', category: '蔬菜', notes: '常用' });
  });
});
