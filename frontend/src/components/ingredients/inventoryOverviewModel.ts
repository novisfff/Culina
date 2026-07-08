import type { InventoryOverviewItem, InventoryOverviewSourceType } from '../../api/types';
import { parseFoodStockQuantity, resolveFoodStockDeductQuantity } from '../../lib/foodStockQuantity';

export type UnifiedInventorySourceFilter = 'all' | InventoryOverviewSourceType;
export type InventoryEntryFilter = 'all' | 'stocked' | 'pending';
export type UnifiedInventoryQuickFilter = 'all' | 'ingredient' | 'food' | 'seasoning' | 'alerted' | 'expiring';

export type UnifiedInventoryFilter = {
  source: UnifiedInventorySourceFilter;
  entry: InventoryEntryFilter;
  quick?: UnifiedInventoryQuickFilter;
  storage: 'all' | string;
  search: string;
};

export type UnifiedInventoryGroup = {
  key: string;
  label: string;
  items: InventoryOverviewItem[];
  ingredientCount: number;
  foodCount: number;
  alertCount: number;
};

const TONE_RANK: Record<InventoryOverviewItem['tone'], number> = {
  danger: 0,
  warning: 1,
  empty: 2,
  stable: 3,
};

export function filterUnifiedInventoryItems(items: InventoryOverviewItem[], filter: UnifiedInventoryFilter) {
  const search = filter.search.trim();
  const storage = filter.storage.trim();
  const quick = filter.quick ?? 'all';
  return items.filter((item) => {
    const sourceMatches = filter.source === 'all' || item.source_type === filter.source;
    const entryMatches =
      filter.entry === 'all' ||
      (filter.entry === 'stocked' && isStockedInventoryOverviewItem(item)) ||
      (filter.entry === 'pending' && isPendingInventoryOverviewItem(item));
    const quickMatches = matchesUnifiedInventoryQuickFilter(item, quick);
    const itemStorage = item.storage_location || '常温';
    const storageMatches = storage === 'all' || itemStorage === storage;
    const searchMatches =
      !search ||
      item.title.includes(search) ||
      item.category.includes(search) ||
      item.storage_location.includes(search) ||
      item.search_text.includes(search);
    return sourceMatches && entryMatches && quickMatches && storageMatches && searchMatches;
  });
}

export function filterUnifiedInventoryItemsByQuickFilter(
  items: InventoryOverviewItem[],
  quick: UnifiedInventoryQuickFilter
) {
  return items.filter((item) => matchesUnifiedInventoryQuickFilter(item, quick));
}

function matchesUnifiedInventoryQuickFilter(item: InventoryOverviewItem, quick: UnifiedInventoryQuickFilter) {
  if (quick === 'all') {
    return true;
  }
  if (quick === 'ingredient') {
    return item.source_type === 'ingredient';
  }
  if (quick === 'food') {
    return item.source_type === 'food';
  }
  if (quick === 'alerted') {
    return item.tone === 'warning' || item.tone === 'danger';
  }
  if (quick === 'expiring') {
    return item.days_until_expiry != null && item.days_until_expiry <= 7 && (item.tone === 'warning' || item.tone === 'danger');
  }
  const quickSearchText = `${item.title} ${item.category} ${item.search_text}`;
  return ['调料', '调味', '酱料', '香料', '佐料'].some((keyword) => quickSearchText.includes(keyword));
}

export function isPendingInventoryOverviewItem(
  item: Pick<InventoryOverviewItem, 'source_type' | 'quantity' | 'tone'>
) {
  if (item.tone === 'empty') {
    return true;
  }
  if (item.source_type === 'food') {
    return (item.quantity ?? 0) <= 0;
  }
  return item.quantity === 0;
}

export function isStockedInventoryOverviewItem(
  item: Pick<InventoryOverviewItem, 'source_type' | 'quantity' | 'tone'>
) {
  return !isPendingInventoryOverviewItem(item);
}

function groupWeight(key: string) {
  if (key === '冷藏') return 0;
  if (key === '冷冻') return 1;
  if (key === '常温') return 2;
  return 4;
}

export function buildUnifiedInventoryGroups(items: InventoryOverviewItem[]): UnifiedInventoryGroup[] {
  const grouped = new Map<string, InventoryOverviewItem[]>();
  for (const item of items) {
    const key = item.storage_location || '常温';
    grouped.set(key, [...(grouped.get(key) ?? []), item]);
  }

  return [...grouped.entries()]
    .sort((left, right) => groupWeight(left[0]) - groupWeight(right[0]) || left[0].localeCompare(right[0], 'zh-CN'))
    .map(([key, groupItems]) => ({
      key,
      label: key,
      items: groupItems.slice().sort((left, right) => TONE_RANK[left.tone] - TONE_RANK[right.tone] || right.updated_at.localeCompare(left.updated_at)),
      ingredientCount: groupItems.filter((item) => item.source_type === 'ingredient').length,
      foodCount: groupItems.filter((item) => item.source_type === 'food').length,
      alertCount: groupItems.filter((item) => item.tone === 'warning' || item.tone === 'danger').length,
    }));
}

export function buildUnifiedInventorySummary(items: InventoryOverviewItem[]) {
  return {
    totalCount: items.length,
    ingredientCount: items.filter((item) => item.source_type === 'ingredient').length,
    foodCount: items.filter((item) => item.source_type === 'food').length,
    alertCount: items.filter((item) => item.tone === 'warning' || item.tone === 'danger').length,
    pendingCount: items.filter(isPendingInventoryOverviewItem).length,
    stockedCount: items.filter(isStockedInventoryOverviewItem).length,
  };
}

export function getUnifiedInventorySourceLabel(item: Pick<InventoryOverviewItem, 'source_type'>) {
  return item.source_type === 'food' ? '成品速食' : '食材库存';
}

export function getUnifiedInventoryActionLabel(item: Pick<InventoryOverviewItem, 'primary_action'>) {
  switch (item.primary_action) {
    case 'record_meal':
      return '减扣';
    case 'edit_food_stock':
      return '补库存';
    case 'consume':
      return '消费';
    case 'dispose':
      return '处理提醒';
    case 'restock':
      return '补货';
    default:
      return '查看';
  }
}

export function getUnifiedInventoryFoodPrimaryActionKind(
  item: Pick<InventoryOverviewItem, 'primary_action'>
): 'recordMeal' | 'editStock' {
  return item.primary_action === 'edit_food_stock' ? 'editStock' : 'recordMeal';
}

export function parseUnifiedFoodStockQuantity(
  value: string,
  fieldLabel = '数量'
): { quantity: number | null; error: string | null } {
  return parseFoodStockQuantity(value, fieldLabel);
}

export function resolveUnifiedFoodStockDeductQuantity(
  requestedQuantity: number,
  availableQuantity: number | null | undefined,
  unit: string
): { quantity: number | null; error: string | null } {
  return resolveFoodStockDeductQuantity(requestedQuantity, availableQuantity, unit);
}
