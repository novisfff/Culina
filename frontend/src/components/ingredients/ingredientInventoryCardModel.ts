import type { InventoryItem } from '../../api/types';
import { formatDate } from '../../lib/ui';
import { getInventoryRemainingQuantity } from '../../lib/ingredientUnits';
import { tracksIngredientQuantity } from '../../lib/ingredientTracking';
import { buildInventoryCardStatus } from './ingredientInventoryPresentationModel';
import type {
  DisposableExpiredInventoryItemViewModel,
  IngredientSummaryViewModel,
  InventoryCardExpiryTone,
  InventoryCardPresentationViewModel,
} from './workspaceTypes';

function buildInventoryCardSummaryLine(summary: IngredientSummaryViewModel) {
  if (summary.quantitySummaries.length === 0) return '还没有库存';
  return summary.quantitySummaries.slice(0, 2).map((item) => item.label).join(' · ');
}

function buildInventoryCardExpiry(summary: IngredientSummaryViewModel, referenceDate: string) {
  const earliestExpiryDate = !tracksIngredientQuantity(summary.ingredient)
    ? summary.inventoryState?.expiry_date ?? null
    : summary.inventoryItems
        .map((item) => item.expiry_date)
        .filter((value): value is string => Boolean(value))
        .sort((left, right) => left.localeCompare(right))[0] ?? null;

  if (!earliestExpiryDate) {
    return { hasExpiryInfo: false, expiryLabel: null, expiryDateLabel: null, expiryTone: null } satisfies Pick<
      InventoryCardPresentationViewModel,
      'hasExpiryInfo' | 'expiryLabel' | 'expiryDateLabel' | 'expiryTone'
    >;
  }
  const diffDays = Math.round(
    (new Date(earliestExpiryDate).getTime() - new Date(referenceDate).getTime()) / (1000 * 60 * 60 * 24),
  );
  const expiryLabel = diffDays < 0
    ? `已过期 ${Math.abs(diffDays)} 天`
    : diffDays === 0 ? '今天到期' : diffDays === 1 ? '距到期 1 天' : `距到期 ${diffDays} 天`;
  const expiryTone: InventoryCardExpiryTone = diffDays <= 2 ? 'danger' : diffDays <= 7 ? 'warning' : 'neutral';
  return {
    hasExpiryInfo: true,
    expiryLabel,
    expiryDateLabel: formatDate(earliestExpiryDate),
    expiryTone,
  } satisfies Pick<InventoryCardPresentationViewModel, 'hasExpiryInfo' | 'expiryLabel' | 'expiryDateLabel' | 'expiryTone'>;
}

export function buildDisposableExpiredInventoryItems(
  summary: IngredientSummaryViewModel,
  referenceDate: string,
): DisposableExpiredInventoryItemViewModel[] {
  const referenceKey = referenceDate.slice(0, 10);
  return summary.inventoryItems
    .filter((item) => item.expiry_date && item.expiry_date.slice(0, 10) < referenceKey && getInventoryRemainingQuantity(item) > 0)
    .sort((left, right) => left.expiry_date!.localeCompare(right.expiry_date!) || left.purchase_date.localeCompare(right.purchase_date) || left.created_at.localeCompare(right.created_at))
    .map((item) => {
      const remainingQuantity = getInventoryRemainingQuantity(item);
      return {
        id: item.id,
        ingredientId: item.ingredient_id,
        ingredientName: item.ingredient_name,
        remainingQuantity,
        remainingLabel: `${Number(remainingQuantity.toFixed(2))} ${item.unit}`,
        unit: item.unit,
        purchaseDate: item.purchase_date,
        expiryDate: item.expiry_date!,
        storageLocation: item.storage_location || summary.primaryStorage || summary.ingredient.default_storage || '常温',
        notes: item.notes,
        status: item.status,
        createdAt: item.created_at,
        rowVersion: item.row_version,
        expiryAlertSnoozedUntil: item.expiry_alert_snoozed_until ?? null,
        expiryReviewedAt: item.expiry_reviewed_at ?? null,
        expiryReviewedBy: item.expiry_reviewed_by ?? null,
      };
    });
}

export function countDisposableExpiredInventoryItems(summary: IngredientSummaryViewModel, referenceDate: string) {
  const referenceKey = referenceDate.slice(0, 10);
  return summary.inventoryItems.reduce((count, item) => (
    item.expiry_date && item.expiry_date.slice(0, 10) < referenceKey && getInventoryRemainingQuantity(item) > 0
      ? count + 1
      : count
  ), 0);
}

export function buildInventoryCardPresentation(
  summary: IngredientSummaryViewModel,
  referenceDate: string,
): InventoryCardPresentationViewModel {
  const status = buildInventoryCardStatus(summary);
  const expiry = buildInventoryCardExpiry(summary, referenceDate);
  const actionableTone: InventoryCardExpiryTone | null = summary.alerts.length === 0
    ? null
    : summary.alerts.some((item) => item.tone === 'danger') ? 'danger' : 'warning';
  const resolvedExpiryTone = expiry.hasExpiryInfo && actionableTone && expiry.expiryTone === 'neutral'
    ? actionableTone
    : expiry.expiryTone;
  const resolvedExpiry = { ...expiry, expiryTone: resolvedExpiryTone };
  const latestRestockLabel = summary.latestPurchaseDate ? formatDate(summary.latestPurchaseDate) : null;
  const hasExpiredInventory = summary.alerts.some((item) => item.kind === 'expiry' && item.tone === 'danger');
  const footerNote = hasExpiredInventory
    ? `当前有 ${summary.alerts.length} 条提醒，请先处理过期库存。`
    : summary.alerts.length > 0 ? `当前有 ${summary.alerts.length} 条提醒，建议优先处理。` : status.detail;
  const confirmation = {
    confirmationStatus: summary.confirmationStatus,
    confirmationLabel: summary.confirmationLabel,
    confirmationTone: summary.confirmationTone,
    lastConfirmedAt: summary.lastConfirmedAt,
  };
  if (summary.quantitySummaries.length > 0) {
    const secondaryParts = latestRestockLabel ? [`最近补货 ${latestRestockLabel}`] : [];
    secondaryParts.push(resolvedExpiry.hasExpiryInfo ? `最早 ${resolvedExpiry.expiryDateLabel} 到期` : '没有设置保质期');
    return { headline: buildInventoryCardSummaryLine(summary), secondary: secondaryParts.join(' · '), footerNote, ...resolvedExpiry, ...confirmation };
  }
  if (!tracksIngredientQuantity(summary.ingredient)) {
    return {
      headline: summary.inventoryState?.availability_level === 'absent' ? '没有库存' : '未确认',
      secondary: summary.inventoryState?.availability_level === 'absent' ? '家里没有库存' : '还没有确认家里是否有库存，建议先确认库存状态',
      footerNote, ...resolvedExpiry, ...confirmation,
    };
  }
  if (summary.inventoryItems.length > 0) {
    return {
      headline: '当前无可用库存',
      secondary: latestRestockLabel ? `最近补货 ${latestRestockLabel} · 当前无可用库存` : '当前无可用库存',
      footerNote, ...resolvedExpiry, ...confirmation,
    };
  }
  return { headline: '还没有库存', secondary: '还没有库存，适合先补充第一批', footerNote, ...resolvedExpiry, ...confirmation };
}
