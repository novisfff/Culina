import type { InventoryItem } from '../../api/types';
import type { IngredientSummaryViewModel, InventoryCardStatusViewModel, QuantitySummaryViewModel } from './workspaceTypes';
import { getInventoryRemainingQuantity } from '../../lib/ingredientUnits';
import { tracksIngredientQuantity } from '../../lib/ingredientTracking';
import { formatDate } from '../../lib/ui';

export function buildQuantitySummaries(inventoryItems: InventoryItem[]): QuantitySummaryViewModel[] {
  const grouped = new Map<string, number>();
  for (const item of inventoryItems) {
    const remainingQuantity = getInventoryRemainingQuantity(item);
    if (remainingQuantity <= 0) continue;
    grouped.set(item.unit, (grouped.get(item.unit) ?? 0) + remainingQuantity);
  }
  return [...grouped.entries()]
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .map(([unit, total]) => ({
      unit,
      total,
      label: `${Number(total.toFixed(2)).toString().replace(/\.0+$/, '')} ${unit}`,
    }));
}

export function buildInventoryCardStatus(summary: IngredientSummaryViewModel): InventoryCardStatusViewModel {
  const hasDangerAlert = summary.alerts.some((item) => item.tone === 'danger');
  const hasWarningAlert = summary.alerts.some((item) => item.tone === 'warning');
  if (hasDangerAlert) {
    return {
      label: '临期或过期',
      tone: 'danger',
      detail: summary.alerts[0]?.detail ?? '有临期或过期的库存需要优先处理。',
      priority: 3,
    };
  }
  if (summary.quantitySummaries.length === 0) {
    return {
      label: '还没有可用库存',
      tone: 'empty',
      detail:
        !tracksIngredientQuantity(summary.ingredient)
          ? summary.inventoryState?.availability_level === 'absent'
            ? '家里没有库存，需要补充。'
            : '还没有确认家里是否有库存，建议先确认库存状态。'
          : summary.inventoryItems.length > 0
            ? '当前可用库存已空，可以处理到期库存，或补充新的库存。'
            : '还没有库存，适合先补充一些常用量。',
      priority: hasWarningAlert ? 2 : 1,
    };
  }
  if (hasWarningAlert || summary.inventoryState?.availability_level === 'low') {
    return {
      label: '库存偏低',
      tone: 'warning',
      detail:
        summary.alerts[0]?.detail ??
        (summary.inventoryState?.availability_level === 'low' ? '家里库存不多，建议尽快补货。' : '当前库存偏低，建议尽快补货。'),
      priority: 2,
    };
  }
  return {
    label: '库存正常',
    tone: 'stable',
    detail: summary.latestPurchaseDate ? `最近补货 ${formatDate(summary.latestPurchaseDate)}，库存正常。` : '库存正常，可正常使用。',
    priority: 0,
  };
}
