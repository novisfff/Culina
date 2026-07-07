import type { InventoryOverviewItem, InventoryOverviewSourceType } from '../../api/types';

export type UnifiedInventorySourceFilter = 'all' | InventoryOverviewSourceType;

export type UnifiedInventoryFilter = {
  source: UnifiedInventorySourceFilter;
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
  return items.filter((item) => {
    const sourceMatches = filter.source === 'all' || item.source_type === filter.source;
    const searchMatches =
      !search ||
      item.title.includes(search) ||
      item.category.includes(search) ||
      item.storage_location.includes(search) ||
      item.search_text.includes(search);
    return sourceMatches && searchMatches;
  });
}

function groupWeight(key: string) {
  if (key === '食物库') return 0;
  if (key === '冷藏') return 1;
  if (key === '冷冻') return 2;
  if (key === '常温') return 3;
  return 4;
}

export function buildUnifiedInventoryGroups(items: InventoryOverviewItem[]): UnifiedInventoryGroup[] {
  const grouped = new Map<string, InventoryOverviewItem[]>();
  for (const item of items) {
    const key = item.storage_location || (item.source_type === 'food' ? '食物库' : '常温');
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
  };
}

export function getUnifiedInventorySourceLabel(item: Pick<InventoryOverviewItem, 'source_type'>) {
  return item.source_type === 'food' ? '成品速食' : '食材库存';
}

export function getUnifiedInventoryActionLabel(item: Pick<InventoryOverviewItem, 'primary_action'>) {
  switch (item.primary_action) {
    case 'record_meal':
      return '记到今天';
    case 'edit_food_stock':
      return '更新库存';
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
