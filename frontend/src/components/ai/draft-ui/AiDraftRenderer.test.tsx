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
});
