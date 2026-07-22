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

  it('delegates genuinely unknown Drafts to the legacy fallback', () => {
    const fallback = vi.fn(() => <p>原始草稿</p>);
    const view = renderRenderer(
      <AiDraftRenderer
        approval={approval()}
        draftType="unknown"
        recipeApproval={false}
        recipe={recipeDraft('番茄炒蛋')}
        structuredDraft={{ draftType: 'unknown' }}
        readonly={false}
        foodOptions={[]}
        foodCategoryOptions={[]}
        ingredientOptions={[]}
        ingredients={[]}
        recipeCookSchemaVersion="unknown"
        recipeCookRequiresRegeneration={false}
        onRecipeChange={vi.fn()}
        onStructuredDraftChange={vi.fn()}
        onLoadResourceOptions={async () => []}
        renderLegacyFallback={fallback}
      />,
    );

    expect(fallback).toHaveBeenCalledOnce();
    expect(view.textContent).toContain('原始草稿');
  });

  it('routes shopping list Drafts through the shared structured view', () => {
    const fallback = vi.fn(() => <p>原始草稿</p>);
    const view = renderRenderer(
      <AiDraftRenderer
        approval={approval()}
        draftType="shopping_list"
        recipeApproval={false}
        recipe={recipeDraft('番茄炒蛋')}
        structuredDraft={{
          draftType: 'shopping_list',
          items: [{ title: '鸡蛋', ingredient_id: 'ingredient-egg', quantity: 1, unit: '盒' }],
        }}
        readonly={false}
        foodOptions={[]}
        foodCategoryOptions={[]}
        ingredientOptions={[]}
        ingredients={[]}
        recipeCookSchemaVersion="unknown"
        recipeCookRequiresRegeneration={false}
        onRecipeChange={vi.fn()}
        onStructuredDraftChange={vi.fn()}
        onLoadResourceOptions={async () => []}
        renderLegacyFallback={fallback}
      />,
    );

    expect(fallback).not.toHaveBeenCalled();
    expect(view.querySelector('.ai-draft-summary-card.ai-shopping-list-summary-card')).not.toBeNull();
    expect(view.textContent).toContain('待确认购物清单');
  });

  it('routes food profile Drafts through the shared structured view', () => {
    const fallback = vi.fn(() => <p>原始草稿</p>);
    const view = renderRenderer(
      <AiDraftRenderer
        approval={approval()}
        draftType="food_profile"
        recipeApproval={false}
        recipe={recipeDraft('番茄炒蛋')}
        structuredDraft={{
          draftType: 'food_profile',
          name: '蓝莓酸奶',
          type: 'readyMade',
          category: '饮品',
          suitable_meal_types: ['breakfast'],
        }}
        readonly={false}
        foodOptions={[]}
        foodCategoryOptions={[{ value: '饮品', label: '饮品' }]}
        ingredientOptions={[]}
        ingredients={[]}
        recipeCookSchemaVersion="unknown"
        recipeCookRequiresRegeneration={false}
        onRecipeChange={vi.fn()}
        onStructuredDraftChange={vi.fn()}
        onLoadResourceOptions={async () => []}
        renderLegacyFallback={fallback}
      />,
    );

    expect(fallback).not.toHaveBeenCalled();
    expect(view.querySelector('.ai-draft-summary-card.ai-food-profile-summary-card')).not.toBeNull();
    expect(view.textContent).toContain('核心信息');
  });

  it('routes meal log Drafts through the shared view but preserves composition correction', () => {
    const fallback = vi.fn(() => <p>餐食组成修正</p>);
    const view = renderRenderer(
      <AiDraftRenderer
        approval={approval()}
        draftType="meal_log"
        recipeApproval={false}
        recipe={recipeDraft('番茄炒蛋')}
        structuredDraft={{
          draftType: 'meal_log',
          date: '2026-06-10',
          mealType: 'dinner',
          foods: [{ foodId: 'food-tomato-egg', name: '番茄炒蛋', servings: 1 }],
        }}
        readonly={false}
        foodOptions={[]}
        foodCategoryOptions={[]}
        ingredientOptions={[]}
        ingredients={[]}
        recipeCookSchemaVersion="unknown"
        recipeCookRequiresRegeneration={false}
        onRecipeChange={vi.fn()}
        onStructuredDraftChange={vi.fn()}
        onLoadResourceOptions={async () => []}
        renderLegacyFallback={fallback}
      />,
    );

    expect(fallback).not.toHaveBeenCalled();
    expect(view.querySelector('.ai-draft-summary-card.ai-meal-log-summary-card')).not.toBeNull();
    expect(view.textContent).toContain('待确认餐食记录');

    const correctionFallback = vi.fn(() => <p>餐食组成修正</p>);
    act(() => {
      root?.render(
        <AiDraftRenderer
          approval={approval()}
          draftType="meal_log"
          recipeApproval={false}
          recipe={recipeDraft('番茄炒蛋')}
          structuredDraft={{ draftType: 'meal_log', action: 'update_composition' }}
          readonly={false}
          foodOptions={[]}
          foodCategoryOptions={[]}
          ingredientOptions={[]}
          ingredients={[]}
          recipeCookSchemaVersion="unknown"
          recipeCookRequiresRegeneration={false}
          onRecipeChange={vi.fn()}
          onStructuredDraftChange={vi.fn()}
          onLoadResourceOptions={async () => []}
          renderLegacyFallback={correctionFallback}
        />,
      );
    });

    expect(correctionFallback).toHaveBeenCalledOnce();
    expect(view.textContent).toContain('餐食组成修正');
  });
});
