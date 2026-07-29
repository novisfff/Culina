import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { defaultIngredientForm } from './ingredientWorkspaceForms';
import { useIngredientWorkspaceState } from './useIngredientWorkspaceState';

describe('useIngredientWorkspaceState quick detail ownership', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it('does not open a catalog quick detail when navigating into and back from full detail', () => {
    const { result } = renderHook(() =>
      useIngredientWorkspaceState({
        persistedWorkspaceState: {},
        ingredientIds: ['ingredient-milk'],
        editingIngredientId: null,
        ingredientForm: defaultIngredientForm(),
      }),
    );

    act(() => result.current.toggleCatalogCard('ingredient-milk'));
    expect(result.current.expandedCatalogIngredientId).toBe('ingredient-milk');

    act(() => result.current.openDetailView('ingredient-milk'));

    expect(result.current.workspaceView).toBe('detail');
    expect(result.current.expandedCatalogIngredientId).toBeNull();

    act(() => result.current.goBackToWorkspace());

    expect(result.current.workspaceView).toBe('hub');
    expect(result.current.expandedCatalogIngredientId).toBeNull();
  });
});
