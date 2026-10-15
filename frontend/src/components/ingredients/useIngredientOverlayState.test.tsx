import { act, renderHook } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import type { Ingredient, ShoppingListItem } from '../../api/types';
import { useIngredientOverlayState } from './useIngredientOverlayState';

const ingredient = { id: 'chicken-a', name: '鸡', default_unit: '克', quantity_tracking_mode: 'track_quantity', unit_conversions: [] } as unknown as Ingredient;
const row = { id: 'shopping-a', title: '鸡', row_version: 7, ingredient_id: null, food_id: null, target_type: 'free_text', quantity: 2, unit: '份', reason: '' } as unknown as ShoppingListItem;

function renderOverlay() {
  return renderHook(() => useIngredientOverlayState({ ingredientOptions: [ingredient, { ...ingredient, id: 'chicken-b', default_unit: '斤' }], foodOptions: [], summaries: [], inventoryActionGroups: [], referenceDate: '2026-10-15', onRequireCreate: vi.fn() }));
}

it('edits a free-text shopping row without binding a same-name ingredient', () => {
  const { result } = renderOverlay();
  act(() => result.current.openShoppingOverlay({ shoppingItem: row }));
  expect(result.current.shoppingForm).toMatchObject({ targetType: 'free_text', ingredientId: '', foodId: '', unit: '份' });
  expect(result.current.editingShoppingItemRowVersion).toBe(7);
  act(() => result.current.closeOverlay());
  expect(result.current.overlayMode).toBeNull();
  expect(result.current.editingShoppingItemId).toBeNull();
});

it('resolves a bound row by its ID even when another ingredient has the same name', () => {
  const { result } = renderOverlay();
  act(() => result.current.openShoppingOverlay({ shoppingItem: { ...row, target_type: 'ingredient', ingredient_id: 'chicken-b', unit: '' } }));
  expect(result.current.shoppingForm).toMatchObject({ targetType: 'ingredient', ingredientId: 'chicken-b', unit: '斤' });
});
