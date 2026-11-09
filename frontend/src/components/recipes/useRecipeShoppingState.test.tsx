// @vitest-environment jsdom

import { act, renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { Recipe } from '../../api/types';
import { useRecipeShoppingState } from './useRecipeShoppingState';
import type { RecipeCardViewModel } from './workspaceModel';

function buildCard(): RecipeCardViewModel {
  const recipe: Recipe = {
    id: 'recipe-1', family_id: 'family-1', title: '番茄炒蛋', servings: 2,
    prep_minutes: 10, difficulty: 'easy', tips: '', images: [], cook_logs: [], steps: [],
    created_at: '2026-11-09T00:00:00Z', updated_at: '2026-11-09T00:00:00Z',
    ingredient_items: ['番茄', '鸡蛋', '葱'].map((name, index) => ({
      id: `recipe-ingredient-${index}`, ingredient_id: `ingredient-${index}`,
      ingredient_name: name, quantity: 2, unit: '个', note: '',
    })),
  };
  return {
    recipe, availability: 'ready', availabilityLabel: '可做', availabilityDetail: '',
    availabilityScore: 1, shortages: [], ingredientAvailability: [], ingredientPreview: [],
    hiddenIngredientCount: 0, linkedFood: null, mealUsageCount: 0, lastUsedAt: null,
    searchText: recipe.title, updatedAt: recipe.updated_at,
  };
}

function buildRepeatedIngredientCard(): RecipeCardViewModel {
  const card = buildCard();
  const ingredient = card.recipe.ingredient_items[0];
  card.recipe.ingredient_items = [ingredient, { ...ingredient, id: 'recipe-ingredient-repeat', quantity: 3 }];
  card.shortages = card.recipe.ingredient_items.map((item) => ({
    ingredientId: item.ingredient_id,
    ingredientName: item.ingredient_name,
    requiredQuantity: item.quantity,
    availableQuantity: 0,
    missingQuantity: item.quantity,
    unit: item.unit,
    shortageType: 'quantity',
  }));
  return card;
}

function deferred() {
  let resolve!: (value: unknown) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<unknown>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

describe('recipe shopping submission', () => {
  it('edits and removes repeated ingredient shortages independently', () => {
    const { result } = renderHook(() => useRecipeShoppingState({
      ingredients: [], createShoppingItem: vi.fn(), showRecipeNotice: vi.fn(),
    }));
    act(() => result.current.openShoppingDialog(buildRepeatedIngredientCard(), vi.fn()));
    const [firstDraft, secondDraft] = result.current.shoppingDrafts;

    act(() => result.current.updateShoppingDraft(firstDraft.id, { quantity: '4' }));

    expect(result.current.shoppingDrafts.map((draft) => draft.quantity)).toEqual(['4', '3']);

    act(() => result.current.removeShoppingDraft(firstDraft.id));

    expect(result.current.shoppingDrafts).toEqual([secondDraft]);
  });

  it('retains and retries a failed shortage when another row for the same ingredient succeeds', async () => {
    const savedQuantities: number[] = [];
    let shouldFail = true;
    const { result } = renderHook(() => useRecipeShoppingState({
      ingredients: [], showRecipeNotice: vi.fn(),
      createShoppingItem: async (payload) => {
        if (payload.quantity === 3 && shouldFail) throw new Error('暂时无法加入');
        savedQuantities.push(payload.quantity!);
      },
    }));
    act(() => result.current.openShoppingDialog(buildRepeatedIngredientCard(), vi.fn()));
    const failedDraft = result.current.shoppingDrafts[1];

    await act(() => result.current.submitShoppingDrafts());

    expect(savedQuantities).toEqual([2]);
    expect(result.current.shoppingDrafts).toEqual([failedDraft]);
    expect(result.current.shoppingDialogCard).not.toBeNull();
    expect(result.current.shoppingSubmitError).toContain('已加入 1 项');
    expect(result.current.shoppingSubmitError).toContain('1 项未成功');

    shouldFail = false;
    await act(() => result.current.submitShoppingDrafts());

    expect(savedQuantities).toEqual([2, 3]);
    expect(result.current.shoppingDialogCard).toBeNull();
    expect(result.current.shoppingSubmitError).toBeNull();
  });

  it('keeps only failed and unsent drafts so retry does not repeat successful purchases', async () => {
    const savedTitles: string[] = [];
    let shouldFail = true;
    const { result } = renderHook(() => useRecipeShoppingState({
      ingredients: [], showRecipeNotice: vi.fn(),
      createShoppingItem: async (payload) => {
        if (payload.title === '葱' && shouldFail) throw new Error('暂时无法加入');
        savedTitles.push(payload.title);
      },
    }));
    act(() => result.current.openShoppingDialog(buildCard(), vi.fn(), 'all'));
    const invalidId = result.current.shoppingDrafts[0].id;
    act(() => result.current.updateShoppingDraft(invalidId, { quantity: '0' }));

    await act(() => result.current.submitShoppingDrafts());

    expect(savedTitles).toEqual(['鸡蛋']);
    expect(result.current.shoppingDrafts.map((draft) => draft.title)).toEqual(['番茄', '葱']);
    expect(result.current.shoppingDialogCard).not.toBeNull();
    expect(result.current.shoppingSubmitError).toContain('已加入 1 项');
    expect(result.current.shoppingSubmitError).toContain('1 项未成功');

    shouldFail = false;
    act(() => result.current.removeShoppingDraft(invalidId));
    await act(() => result.current.submitShoppingDrafts());

    expect(savedTitles).toEqual(['鸡蛋', '葱']);
    expect(result.current.shoppingDialogCard).toBeNull();
    expect(result.current.shoppingSubmitError).toBeNull();
  });

  it('blocks repeated submits and edits until every request has settled', async () => {
    const requests = [deferred(), deferred(), deferred()];
    const createShoppingItem = vi.fn((payload: { ingredient_id: string }) =>
      requests[Number(payload.ingredient_id.slice(-1))].promise,
    );
    const { result } = renderHook(() => useRecipeShoppingState({
      ingredients: [], createShoppingItem, showRecipeNotice: vi.fn(),
    }));
    act(() => result.current.openShoppingDialog(buildCard(), vi.fn(), 'all'));
    const originalDrafts = result.current.shoppingDrafts;
    let submission!: Promise<void>;
    act(() => {
      submission = result.current.submitShoppingDrafts();
      void result.current.submitShoppingDrafts();
      result.current.removeShoppingDraft(originalDrafts[0].id);
      result.current.closeShoppingDialog();
    });

    expect(createShoppingItem).toHaveBeenCalledTimes(3);
    expect(result.current.isSubmittingShopping).toBe(true);
    expect(result.current.shoppingDialogCard).not.toBeNull();
    expect(result.current.shoppingDrafts).toEqual(originalDrafts);

    await act(async () => { requests[0].reject(new Error('暂时无法加入')); });
    expect(result.current.isSubmittingShopping).toBe(true);
    await act(async () => {
      requests[1].resolve({ id: 'shopping-1' });
      requests[2].resolve({ id: 'shopping-2' });
      await submission;
    });

    expect(result.current.isSubmittingShopping).toBe(false);
    expect(result.current.shoppingDrafts.map((draft) => draft.title)).toEqual(['番茄']);
  });
});
