// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Food, MealType, Recipe } from '../../api/types';
import { FoodDetailDrawer } from './FoodDetailDrawer';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let container: HTMLDivElement | null = null;

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
});

function attachRoot() {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  return container;
}

function buildFood(): Food {
  return {
    id: 'food-1',
    family_id: 'family-1',
    name: '番茄炒蛋',
    type: 'selfMade',
    category: '家常菜',
    flavor_tags: [],
    scene_tags: ['工作日晚餐'],
    suitable_meal_types: ['dinner'],
    source_name: '',
    purchase_source: '',
    scene: '',
    images: [],
    notes: '',
    routine_note: '适合晚餐',
    stock_unit: '份',
    storage_location: '',
    favorite: false,
    recipe_id: 'recipe-1',
    row_version: 1,
    created_at: '2026-07-07T00:00:00Z',
    updated_at: '2026-07-07T00:00:00Z',
  };
}

function buildRecipe(): Recipe {
  return {
    id: 'recipe-1',
    family_id: 'family-1',
    title: '番茄炒蛋',
    servings: 2,
    prep_minutes: 12,
    difficulty: 'easy',
    ingredient_items: [],
    steps: [],
    tips: '',
    scene_tags: ['工作日晚餐'],
    images: [],
    cook_logs: [],
    created_at: '2026-07-07T00:00:00Z',
    updated_at: '2026-07-07T00:00:00Z',
  };
}

function findButtons(view: HTMLElement, text: string) {
  return Array.from(view.querySelectorAll<HTMLButtonElement>('button')).filter((button) =>
    button.textContent?.includes(text),
  );
}

function expectButtonsDisabled(view: HTMLElement, text: string) {
  const buttons = findButtons(view, text);
  expect(buttons.length).toBeGreaterThan(0);
  expect(buttons.every((button) => button.disabled)).toBe(true);
}

function renderDrawer(options: { isQuickAdding?: boolean } = {}) {
  const onClose = vi.fn();
  const view = attachRoot();
  act(() => {
    root?.render(
      <FoodDetailDrawer
        food={buildFood()}
        audienceText="适合全家"
        cover={null}
        coverAsset={null}
        detailMealOptions={[{ value: 'dinner' as MealType, label: '晚餐' }]}
        expiry={null}
        factRows={[{ label: '餐别', value: '晚餐' }]}
        history={[]}
        inventoryConfirmation={null}
        isOutsideFood={false}
        isQuickAdding={options.isQuickAdding}
        isReadyLikeFood={false}
        normalizedType="selfMade"
        recipe={buildRecipe()}
        relation={{
          linkedRecipeCard: null,
          lastMealLog: null,
          relationFacts: [],
          shortagePreview: [],
          summary: '已有菜谱',
          detail: '全部原料均有库存。',
        }}
        status={{ label: '可安排', detail: '适合今天', tone: 'ready' }}
        usage={{ count: 0, last: null }}
        getDefaultMealType={() => 'dinner'}
        getPrimaryFoodActionLabel={() => '记一餐'}
        getRepurchaseLabel={() => '适合复吃'}
        getSecondaryFoodActionLabel={() => '编辑资料'}
        getSceneTags={(food) => food.scene_tags ?? []}
        onClose={onClose}
        onOpenPlanDialog={vi.fn()}
        onStartCook={vi.fn()}
        onEditRecipe={vi.fn()}
        onQuickAdd={vi.fn()}
        onEdit={vi.fn()}
        resolveAssetUrl={(url) => url}
        overlayRootClassName="food-workspace-overlay-root"
      />,
    );
  });
  return { onClose, view };
}

describe('FoodDetailDrawer', () => {
  it('uses the shared food overlay frame and closes when idle', () => {
    const { onClose, view } = renderDrawer();

    expect(view.querySelector('.workspace-overlay-root.food-workspace-overlay-root')).not.toBeNull();
    expect(view.querySelector('.food-detail-drawer')).not.toBeNull();
    expect(view.querySelector('.workspace-overlay-footer .food-detail-actions-desktop')).not.toBeNull();
    expect(view.querySelector('.workspace-overlay-body .food-detail-actions-mobile')).not.toBeNull();
    expect(view.textContent).toContain('番茄炒蛋');
    expect(view.querySelectorAll('.food-detail-actions-desktop .ui-form-actions-row > button')).toHaveLength(3);
    expect(view.querySelectorAll('.food-detail-actions-mobile .ui-form-actions-row > button')).toHaveLength(3);
    expect(view.textContent).not.toContain('完整记一餐');

    act(() => view.querySelector<HTMLDivElement>('.workspace-overlay-backdrop')?.click());
    act(() => view.querySelector<HTMLButtonElement>('.workspace-overlay-close')?.click());

    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it('keeps the drawer open and locks detail actions while quick adding', () => {
    const { onClose, view } = renderDrawer({ isQuickAdding: true });

    expectButtonsDisabled(view, '处理中...');
    expectButtonsDisabled(view, '编辑资料');
    expectButtonsDisabled(view, '加入菜单');
    expectButtonsDisabled(view, '编辑菜谱');
    expectButtonsDisabled(view, '+ 晚餐');

    act(() => view.querySelector<HTMLDivElement>('.workspace-overlay-backdrop')?.click());
    act(() => view.querySelector<HTMLButtonElement>('.workspace-overlay-close')?.click());

    expect(onClose).not.toHaveBeenCalled();
  });
});
