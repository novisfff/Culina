// @vitest-environment jsdom

import { act } from 'react';
import type { ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { approval, recipeDraft } from '../aiWorkspaceTestFixtures';
import { AiDraftRenderer } from './AiDraftRenderer';

describe('AiDraftRenderer', () => {
  let container: HTMLDivElement | null = null;
  let root: Root | null = null;
  const actEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
  const previousActEnvironment = actEnvironment.IS_REACT_ACT_ENVIRONMENT;

  beforeAll(() => {
    actEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
  });

  afterAll(() => {
    actEnvironment.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment;
  });

  afterEach(() => {
    act(() => root?.unmount());
    container?.remove();
    root = null;
    container = null;
  });

  function renderRenderer(element: ReactElement) {
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    act(() => {
      root?.render(element);
    });
    return container;
  }

  function renderer(draftType: string, structuredDraft: Record<string, unknown>, status: 'pending' | 'approved' = 'pending') {
    return (
      <AiDraftRenderer
        approval={approval({ status })}
        draftType={draftType}
        recipeApproval={false}
        recipe={recipeDraft('番茄炒蛋')}
        structuredDraft={structuredDraft}
        readonly={status !== 'pending'}
        foodOptions={[]}
        foodCategoryOptions={[{ value: '饮品', label: '饮品' }]}
        ingredientOptions={[]}
        ingredients={[]}
        recipeCookSchemaVersion="recipe_cook_operation.v2"
        recipeCookRequiresRegeneration={false}
        onRecipeChange={vi.fn()}
        onStructuredDraftChange={vi.fn()}
        onLoadResourceOptions={async () => []}
      />
    );
  }

  it('dispatches every supported Draft without a legacy fallback', () => {
    const supportedDrafts = [
      { draftType: 'recipe', structuredDraft: { draftType: 'recipe', action: 'create', payload: { title: '番茄炒蛋' } } },
      { draftType: 'recipe_cook', structuredDraft: { draftType: 'recipe_cook', title: '番茄炒蛋', date: '2026-06-10', mealType: 'dinner', servings: 2, previewItems: [], shortages: [] } },
      { draftType: 'meal_plan', structuredDraft: { draftType: 'meal_plan', operations: [] } },
      { draftType: 'shopping_list', structuredDraft: { draftType: 'shopping_list', items: [{ title: '鸡蛋', quantity: 1, unit: '盒' }] } },
      { draftType: 'inventory_intake', structuredDraft: { draftType: 'inventory_intake', intakeDate: '2026-06-10', items: [] } },
      { draftType: 'meal_log', structuredDraft: { draftType: 'meal_log', date: '2026-06-10', mealType: 'dinner', foods: [] } },
      { draftType: 'food_profile', structuredDraft: { draftType: 'food_profile', name: '蓝莓酸奶', type: 'readyMade', category: '饮品' } },
      { draftType: 'ingredient_profile', structuredDraft: { draftType: 'ingredient_profile', action: 'create', payload: { name: '鸡蛋', default_unit: '盒', default_storage: '冷藏', default_expiry_mode: 'none', unit_conversions: [] } } },
      { draftType: 'inventory_operation', structuredDraft: { draftType: 'inventory_operation', operations: [{ action: 'consume', ingredientName: '番茄', quantity: 1, unit: '个' }] } },
      { draftType: 'composite_operation', structuredDraft: { draftType: 'composite_operation', stepPreviews: [] } },
    ] as const;

    let view: HTMLDivElement | null = null;
    for (const item of supportedDrafts) {
      const element = renderer(item.draftType, item.structuredDraft);
      if (view) {
        act(() => {
          root?.render(element);
        });
      } else {
        view = renderRenderer(element);
      }

      expect(view.textContent).not.toContain('草稿内容');
      expect(view.querySelector('.ai-recipe-editor, .ai-inventory-intake-editor')).not.toBeNull();
    }
  });

  it('keeps the special meal and ingredient Draft paths inside the renderer', () => {
    const view = renderRenderer(renderer('ingredient_profile', {
      draftType: 'ingredient_profile',
      action: 'transition_tracking_mode',
      before: { name: '鸡蛋', quantity_tracking_mode: 'track_quantity' },
      payload: { target_mode: 'not_track_quantity', observed_batches: [] },
    }));

    expect(view.textContent).toContain('数量追踪方式切换');

    act(() => {
      root?.render(renderer('meal_log', {
        draftType: 'meal_log',
        action: 'update_composition',
        before: { foods: [] },
        payload: { foods: [], inventoryAdjustment: 'none' },
      }));
    });

    expect(view.querySelector('.ai-meal-composition-correction')).not.toBeNull();
    expect(view.textContent).toContain('库存调整边界');
  });

  it('compresses resolved special Drafts into summaries without editor controls', () => {
    const view = renderRenderer(renderer('ingredient_profile', {
      draftType: 'ingredient_profile',
      action: 'transition_tracking_mode',
      before: { name: '鸡蛋', quantity_tracking_mode: 'track_quantity' },
      payload: {
        target_mode: 'not_track_quantity',
        observed_batches: [],
        presence_resolution: { availability_level: 'sufficient', storage_location: '冷藏' },
      },
    }, 'approved'));

    expect(view.querySelector('.ai-draft-resolved-summary')).not.toBeNull();
    expect(view.querySelector('input, select, textarea')).toBeNull();

    act(() => {
      root?.render(renderer('meal_log', {
        draftType: 'meal_log',
        action: 'update_composition',
        before: { foods: [{ foodId: 'food-milk', name: '牛奶', servings: 1 }] },
        payload: { foods: [{ foodId: 'food-bread', name: '全麦面包', servings: 0.5 }], inventoryAdjustment: 'none' },
      }, 'approved'));
    });

    expect(view.querySelector('.ai-draft-resolved-summary')).not.toBeNull();
    expect(view.querySelector('input, select, textarea')).toBeNull();
  });

  it('renders nothing for unknown Draft types because the panel owns raw JSON fallback', () => {
    const view = renderRenderer(renderer('unknown', { draftType: 'unknown' }));

    expect(view.textContent).toBe('');
  });
});
