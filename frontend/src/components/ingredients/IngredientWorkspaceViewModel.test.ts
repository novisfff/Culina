import { describe, expect, it } from 'vitest';
import type { Ingredient } from '../../api/types';
import type { IngredientSummaryViewModel } from './workspaceModel';
import { buildIngredientCatalogViewModel } from './IngredientWorkspaceViewModel';

describe('Ingredient catalog view model', () => {
  it('projects catalog filters and counts without React state', () => {
    const ingredient = { id: 'i-1', name: '番茄', category: '蔬菜' } as Ingredient;
    const summaries = [
      {
        ingredient,
        alerts: [],
        quantitySummaries: [],
      },
    ] as unknown as IngredientSummaryViewModel[];
    const model = buildIngredientCatalogViewModel({
      summaries,
      ingredients: [ingredient],
      search: '',
      categoryFilter: 'all',
      statusFilter: 'all',
      filterByStatus: (items, filter) => (filter === 'all' ? items : []),
    });

    expect(model.filteredSummaries).toHaveLength(1);
    expect(model.countLabel).toBe('共 1 项');
    expect(model.statusCounts).toMatchObject({ all: 1, actionNeeded: 0 });
  });
});
