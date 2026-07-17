import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('home dialog operation loading coverage', () => {
  it('covers every asynchronous home dialog and skips display-only dialogs', () => {
    const homeDialogs = readFileSync(resolve(__dirname, 'HomeDashboardDialogs.tsx'), 'utf8');
    const planDialog = readFileSync(
      resolve(__dirname, '../../components/foods/FoodPlanDialog.tsx'),
      'utf8',
    );
    const shoppingDialog = readFileSync(
      resolve(__dirname, '../../components/ingredients/IngredientShoppingOverlay.tsx'),
      'utf8',
    );
    const planDetail = readFileSync(
      resolve(__dirname, '../../components/foods/FoodPlanDetailModal.tsx'),
      'utf8',
    );
    const mealEnrichment = readFileSync(
      resolve(__dirname, '../meals/MealEnrichmentModal.tsx'),
      'utf8',
    );

    expect(homeDialogs).toContain('<FoodPlanDialog');
    expect(planDialog).toContain('OperationLoadingOverlay');
    expect(planDialog).toContain('正在加入菜单');
    expect(planDialog).toContain('busy={isUpdatingPlan}');
    expect(shoppingDialog).toContain('正在加入购物清单');
    expect(shoppingDialog).toMatch(/<WorkspaceModal[\s\S]*?busy=\{Boolean\(props\.isCreatingShopping\)\}/);
    expect(planDetail).toContain('正在保存菜单变更');
    expect(planDetail).toContain('正在准备这餐');
    expect(mealEnrichment).toContain('正在保存餐食记录');
    expect(homeDialogs).not.toContain('正在加载餐食详情');
  });
});
