// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Ingredient, RecipeIngredient } from '../../api/types';
import type { RecipeShoppingDraftItem } from './RecipeWorkspaceModel';
import { RecipeShoppingDialog } from './RecipeShoppingDialog';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('../../hooks/useIngredientResourceSearch', () => ({
  useIngredientResourceSearch: () => ({
    ingredients: [buildIngredient()],
    isSearching: false,
    isFetchingNextPage: false,
    hasMore: false,
    fetchNextPage: vi.fn(),
    findIngredientById: (ingredientId: string) => (ingredientId === 'ingredient-1' ? buildIngredient() : null),
    findIngredientByName: (ingredientName: string) => (ingredientName === '番茄' ? buildIngredient() : null),
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

function buildRecipeIngredient(): RecipeIngredient {
  return {
    id: 'recipe-ingredient-1',
    ingredient_id: 'ingredient-1',
    ingredient_name: '番茄',
    quantity: 2,
    unit: '个',
    note: '',
  };
}

function buildDraft(): RecipeShoppingDraftItem {
  return {
    id: 'draft-1',
    ingredientId: 'ingredient-1',
    title: '番茄',
    quantity: '2',
    unit: '个',
    reason: '来自菜谱：番茄炒蛋',
    source: 'existing',
    requirement: 'required',
    recipeIngredientId: 'recipe-ingredient-1',
  };
}

function buildCard() {
  return {
    recipe: {
      id: 'recipe-1',
      title: '番茄炒蛋',
      ingredient_items: [buildRecipeIngredient()],
    },
    shortages: [],
    ingredientAvailability: [],
  } as any;
}

function findButton(view: HTMLElement, text: string) {
  return Array.from(view.querySelectorAll<HTMLButtonElement>('button')).find((button) =>
    button.textContent?.includes(text),
  );
}

function renderDialog(options: {
  isCreatingShopping?: boolean;
  customIngredientId?: string | null;
  drafts?: RecipeShoppingDraftItem[];
} = {}) {
  const onClose = vi.fn();
  const onAddCustomDraft = vi.fn();
  const onUpdateDraft = vi.fn();
  const view = attachRoot();
  act(() => {
    root?.render(
      <RecipeShoppingDialog
        card={buildCard()}
        ingredients={[buildIngredient()]}
        drafts={options.drafts ?? [buildDraft()]}
        customForm={{
          ingredientId: options.customIngredientId ?? null,
          title: options.customIngredientId ? '番茄' : '',
          quantity: '1',
          unit: '个',
        }}
        isIngredientPickerOpen={false}
        isCreatingShopping={options.isCreatingShopping}
        unitOptions={['个', '份']}
        resolveIngredientImageUrl={() => ''}
        onClose={onClose}
        onUpdateDraft={onUpdateDraft}
        onAdjustDraftQuantity={vi.fn()}
        onRemoveDraft={vi.fn()}
        onAddRecipeIngredient={vi.fn()}
        onChangeCustomForm={vi.fn()}
        onSetIngredientPickerOpen={vi.fn()}
        onSelectIngredientOption={vi.fn()}
        onAdjustCustomQuantity={vi.fn()}
        onAddCustomDraft={onAddCustomDraft}
        onSubmit={vi.fn()}
      />,
    );
  });
  return { onAddCustomDraft, onClose, onUpdateDraft, view };
}

describe('RecipeShoppingDialog', () => {
  it('uses the shared recipe overlay frame and closes when idle', () => {
    const { onClose, view } = renderDialog();

    expect(view.querySelector('.workspace-overlay-root.recipe-workspace-overlay-root')).not.toBeNull();
    expect(view.querySelector('.recipe-shopping-modal')).not.toBeNull();
    expect(view.querySelector('.workspace-overlay-footer .recipe-shopping-actions')).not.toBeNull();
    expect(view.textContent).toContain('加入采购清单');

    act(() => view.querySelector<HTMLDivElement>('.workspace-overlay-backdrop')?.click());
    act(() => view.querySelector<HTMLButtonElement>('.workspace-overlay-close')?.click());
    act(() => findButton(view, '取消')?.click());

    expect(onClose).toHaveBeenCalledTimes(3);
  });

  it('keeps the dialog open and locks shopping edits while submitting', () => {
    const { onClose, view } = renderDialog({ isCreatingShopping: true });

    expect(findButton(view, '取消')?.disabled).toBe(true);
    expect(findButton(view, '删除')?.disabled).toBe(true);
    expect(findButton(view, '已加入')?.disabled).toBe(true);
    expect(findButton(view, '加入')?.disabled).toBe(true);
    expect(view.querySelector<HTMLInputElement>('input[placeholder="采购项名称"]')?.disabled).toBe(true);

    act(() => view.querySelector<HTMLDivElement>('.workspace-overlay-backdrop')?.click());
    act(() => view.querySelector<HTMLButtonElement>('.workspace-overlay-close')?.click());
    act(() => findButton(view, '取消')?.click());

    expect(onClose).not.toHaveBeenCalled();
  });

  it('keeps custom shopping additions bound to a selected ingredient', () => {
    const emptySelection = renderDialog({ drafts: [] });

    expect(findButton(emptySelection.view, '加入')?.disabled).toBe(true);

    act(() => root?.unmount());
    emptySelection.view.remove();
    root = null;
    container = null;

    const selectedIngredient = renderDialog({ customIngredientId: 'ingredient-1', drafts: [] });
    const addButton = findButton(selectedIngredient.view, '加入');

    expect(addButton?.disabled).toBe(false);
    act(() => addButton?.click());
    expect(selectedIngredient.onAddCustomDraft).toHaveBeenCalledTimes(1);
  });

  it('lets the user edit a recipe ingredient shopping quantity', () => {
    const { onUpdateDraft, view } = renderDialog();
    const quantityInput = view.querySelector<HTMLInputElement>('.recipe-shopping-draft-row input[aria-label="数量"]');

    act(() => {
      const valueSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
      valueSetter?.call(quantityInput, '3');
      quantityInput?.dispatchEvent(new Event('input', { bubbles: true }));
      quantityInput?.dispatchEvent(new Event('change', { bubbles: true }));
    });

    expect(onUpdateDraft).toHaveBeenCalledWith('draft-1', { quantity: '3' });
  });

  it('disables submit when drafts do not contain real ingredient ids', () => {
    const invalidDraft = { ...buildDraft(), ingredientId: null };
    const { view } = renderDialog({ drafts: [invalidDraft] });

    expect(findButton(view, '确认加入清单')?.disabled).toBe(true);
    expect(view.textContent).toContain('已选择 0 项');
  });
});
