import type { IngredientSummaryViewModel, InventoryBatchGroupViewModel } from './workspaceTypes';

const ALL_CATEGORY_FILTER = 'all';

function normalizeCategoryLabel(value: string) {
  return value.trim() || '未分类';
}

export function filterIngredientSummaries(
  summaries: IngredientSummaryViewModel[],
  term: string,
  categoryFilter = ALL_CATEGORY_FILTER,
  matchedIngredientIds: readonly string[] = [],
) {
  const normalized = term.trim();
  const matchedIdSet = new Set(matchedIngredientIds);
  const matchedOrder = new Map(matchedIngredientIds.map((id, index) => [id, index]));
  const filtered = summaries.filter((summary) => {
    const matchesCategory = categoryFilter === ALL_CATEGORY_FILTER || normalizeCategoryLabel(summary.ingredient.category) === categoryFilter;
    if (!matchesCategory) return false;
    if (!normalized) return true;
    return (
      matchedIdSet.has(summary.ingredient.id) ||
      summary.ingredient.name.includes(normalized) ||
      summary.ingredient.category.includes(normalized) ||
      summary.ingredient.notes.includes(normalized) ||
      summary.recipeReferences.some((item) => item.title.includes(normalized))
    );
  });
  if (!normalized || matchedIngredientIds.length === 0) return filtered;
  return [...filtered].sort((left, right) => {
    const leftOrder = matchedOrder.get(left.ingredient.id);
    const rightOrder = matchedOrder.get(right.ingredient.id);
    if (leftOrder !== undefined && rightOrder !== undefined) return leftOrder - rightOrder;
    if (leftOrder !== undefined) return -1;
    if (rightOrder !== undefined) return 1;
    return 0;
  });
}

export function filterInventoryBatchGroups(groups: InventoryBatchGroupViewModel[], term: string) {
  const normalized = term.trim();
  if (!normalized) return groups;
  return groups
    .map((group) => ({
      ...group,
      items: group.items.filter((item) => (
        item.ingredientName.includes(normalized) ||
        item.storageLocation.includes(normalized) ||
        item.notes.includes(normalized)
      )),
    }))
    .filter((group) => group.items.length > 0);
}

export function filterIngredientSummariesForInventory(
  summaries: IngredientSummaryViewModel[],
  term: string,
  matchedIngredientIds: readonly string[] = [],
) {
  const normalized = term.trim();
  const matchedIdSet = new Set(matchedIngredientIds);
  if (!normalized) return summaries;
  return summaries.filter((summary) => (
    matchedIdSet.has(summary.ingredient.id) ||
    summary.ingredient.name.includes(normalized) ||
    summary.ingredient.category.includes(normalized) ||
    summary.ingredient.notes.includes(normalized) ||
    summary.primaryStorage.includes(normalized) ||
    summary.storageLocations.some((location) => location.includes(normalized)) ||
    summary.alerts.some((alert) => alert.title.includes(normalized) || alert.detail.includes(normalized))
  ));
}

export function hasExpiredCatalogAlert(summary: IngredientSummaryViewModel) {
  return summary.alerts.some((item) => item.kind === 'expiry' && item.severity === 'expired');
}

export function hasExpiringCatalogAlert(summary: IngredientSummaryViewModel) {
  return summary.alerts.some((item) => item.kind === 'expiry' && item.severity !== 'expired');
}

export function matchesCatalogStatusFilter(
  summary: IngredientSummaryViewModel,
  filter: 'all' | 'actionNeeded' | 'expired' | 'expiring' | 'lowStock' | 'stable',
) {
  if (filter === 'all') return true;
  if (filter === 'actionNeeded') return summary.alerts.length > 0;
  if (filter === 'expired') return hasExpiredCatalogAlert(summary);
  if (filter === 'expiring') return hasExpiringCatalogAlert(summary);
  if (filter === 'lowStock') return summary.alerts.some((item) => item.kind === 'lowStock');
  return summary.quantitySummaries.length > 0 && summary.alerts.length === 0;
}

export function filterIngredientSummariesByCatalogStatus(
  summaries: IngredientSummaryViewModel[],
  filter: 'all' | 'actionNeeded' | 'expired' | 'expiring' | 'lowStock' | 'stable',
) {
  return summaries.filter((summary) => matchesCatalogStatusFilter(summary, filter));
}
