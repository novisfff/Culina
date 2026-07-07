// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Ingredient } from '../../api/types';
import type { RecipeUnresolvedIngredientTarget } from './RecipeWorkspaceModel';
import { RecipeIngredientResolutionDialog } from './RecipeIngredientResolutionDialog';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('../../hooks/useIngredientResourceSearch', () => ({
  useIngredientResourceSearch: () => ({
    ingredients: [buildIngredient()],
    isSearching: false,
    isFetchingNextPage: false,
    hasMore: false,
    fetchNextPage: vi.fn(),
    findIngredientById: (ingredientId: string) => (ingredientId === 'ingredient-1' ? buildIngredient() : null),
    onCompositionStart: vi.fn(),
    onCompositionEnd: vi.fn(),
  }),
}));

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

function buildIngredient(): Ingredient {
  return {
    id: 'ingredient-1',
    family_id: 'family-1',
    name: '番茄',
    category: '蔬菜',
    default_unit: '个',
    unit_conversions: [],
    default_storage: '冷藏',
    default_expiry_mode: 'none',
    notes: '',
    image: null,
    created_at: '2026-07-07T00:00:00Z',
    updated_at: '2026-07-07T00:00:00Z',
  };
}

function buildTarget(): RecipeUnresolvedIngredientTarget {
  return {
    rowId: 'row-1',
    index: 0,
    ingredient_id: null,
    ingredient_name: '番茄',
    quantity: '2',
    unit: '个',
    reason: 'missing_ingredient_id',
  };
}

function findButton(view: HTMLElement, text: string) {
  return Array.from(view.querySelectorAll<HTMLButtonElement>('button')).find((button) =>
    button.textContent?.includes(text),
  );
}

function renderDialog(options: { isCreatingIngredient?: boolean; targets?: RecipeUnresolvedIngredientTarget[] } = {}) {
  const onClose = vi.fn();
  const onResolveWithIngredient = vi.fn();
  const view = attachRoot();
  act(() => {
    root?.render(
      <RecipeIngredientResolutionDialog
        targets={options.targets ?? [buildTarget()]}
        ingredients={[buildIngredient()]}
        isCreatingIngredient={options.isCreatingIngredient}
        onClose={onClose}
        onRetrySave={vi.fn()}
        onResolveWithIngredient={onResolveWithIngredient}
        onCreateIngredient={vi.fn()}
        onRemoveIngredientRow={vi.fn()}
      />,
    );
  });
  return { onClose, onResolveWithIngredient, view };
}

describe('RecipeIngredientResolutionDialog', () => {
  it('uses the shared recipe overlay frame and closes when idle', () => {
    const { onClose, view } = renderDialog();

    expect(view.querySelector('.workspace-overlay-root.recipe-workspace-overlay-root')).not.toBeNull();
    expect(view.querySelector('.recipe-ingredient-resolution-modal')).not.toBeNull();
    expect(view.textContent).toContain('处理缺失食材');

    act(() => view.querySelector<HTMLDivElement>('.workspace-overlay-backdrop')?.click());
    act(() => view.querySelector<HTMLButtonElement>('.workspace-overlay-close')?.click());
    act(() => findButton(view, '稍后处理')?.click());

    expect(onClose).toHaveBeenCalledTimes(3);
  });

  it('keeps the dialog open and locks picker actions while creating an ingredient', () => {
    const { onClose, onResolveWithIngredient, view } = renderDialog({ isCreatingIngredient: true });
    const laterButton = findButton(view, '稍后处理');
    const ingredientOption = findButton(view, '番茄');

    expect(laterButton?.disabled).toBe(true);
    expect(ingredientOption?.disabled).toBe(true);

    act(() => view.querySelector<HTMLDivElement>('.workspace-overlay-backdrop')?.click());
    act(() => view.querySelector<HTMLButtonElement>('.workspace-overlay-close')?.click());
    act(() => laterButton?.click());
    act(() => ingredientOption?.click());

    expect(onClose).not.toHaveBeenCalled();
    expect(onResolveWithIngredient).not.toHaveBeenCalled();
  });
});
