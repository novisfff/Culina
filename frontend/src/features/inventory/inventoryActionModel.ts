import type { Ingredient, InventoryItem, ShoppingListItem } from '../../api/types';
import { calendarDaysBetweenDateKeys } from '../../lib/date';
import {
  getIngredientAvailableQuantityInDefault,
  getInventoryRemainingQuantity,
} from '../../lib/ingredientUnits';
import { tracksIngredientQuantity } from '../../lib/ingredientTracking';

export type InventoryActionBatch = {
  inventoryItemId: string;
  rowVersion: number;
  remainingQuantity: number;
  unit: string;
  storageLocation: string;
  purchaseDate: string;
  expiryDate: string;
  daysLeft: number;
  expiryAlertSnoozedUntil: string | null;
  expiryReviewedAt: string | null;
  expiryReviewedBy: string | null;
};

export type ExpiryInventoryActionGroup = {
  kind: 'expiry';
  id: string;
  ingredientId: string;
  ingredientName: string;
  severity: 'expired' | 'expires_today' | 'expires_soon' | 'expires_later';
  batches: InventoryActionBatch[];
  expiredBatchCount: number;
  todayBatchCount: number;
  soonBatchCount: number;
  laterBatchCount: number;
  totalBatchCount: number;
  quantityLabels: string[];
  storageLocations: string[];
  earliestExpiryDate: string | null;
  earliestDaysLeft: number | null;
  title: string;
  detail: string;
  primaryAction: 'manage_expiry';
};

export type LowStockInventoryActionGroup = {
  kind: 'low_stock';
  id: string;
  ingredientId: string;
  ingredientName: string;
  availableQuantity: number;
  unit: string;
  threshold: number;
  title: string;
  detail: string;
  primaryAction: 'add_shopping';
};

export type InventoryActionGroup = ExpiryInventoryActionGroup | LowStockInventoryActionGroup;

const SEVERITY_ORDER: Record<ExpiryInventoryActionGroup['severity'] | 'low_stock', number> = {
  expired: 0,
  expires_today: 1,
  expires_soon: 2,
  low_stock: 3,
  expires_later: 4,
};

function normalizeName(value: string) {
  return value.trim();
}

function formatQuantityValue(value: number) {
  return String(Number(value.toFixed(2))).replace(/\.0+$/, '');
}

function buildQuantityLabels(batches: Array<{ remainingQuantity: number; unit: string }>) {
  const totals = new Map<string, number>();
  const order: string[] = [];
  for (const batch of batches) {
    if (!totals.has(batch.unit)) {
      order.push(batch.unit);
    }
    totals.set(batch.unit, (totals.get(batch.unit) ?? 0) + batch.remainingQuantity);
  }
  return order.map((unit) => `${formatQuantityValue(totals.get(unit) ?? 0)} ${unit}`);
}

function isActionableSnoozeState(snoozedUntil: string | null | undefined, referenceDate: string) {
  if (!snoozedUntil) {
    return true;
  }
  return snoozedUntil.slice(0, 10) <= referenceDate;
}

export function isActionableInventoryBatch(item: InventoryItem, referenceDate: string) {
  if (getInventoryRemainingQuantity(item) <= 0) {
    return false;
  }
  if (!item.expiry_date) {
    return false;
  }
  const daysLeft = calendarDaysBetweenDateKeys(item.expiry_date.slice(0, 10), referenceDate);
  if (daysLeft > 7) {
    return false;
  }
  return isActionableSnoozeState(item.expiry_alert_snoozed_until, referenceDate);
}

export function getExpirySeverity(daysLeft: number): ExpiryInventoryActionGroup['severity'] | null {
  if (daysLeft < 0) return 'expired';
  if (daysLeft === 0) return 'expires_today';
  if (daysLeft <= 3) return 'expires_soon';
  if (daysLeft <= 7) return 'expires_later';
  return null;
}

function severityRankForGroup(group: InventoryActionGroup) {
  if (group.kind === 'low_stock') {
    return SEVERITY_ORDER.low_stock;
  }
  return SEVERITY_ORDER[group.severity];
}

function compareActionGroups(left: InventoryActionGroup, right: InventoryActionGroup) {
  const severityDiff = severityRankForGroup(left) - severityRankForGroup(right);
  if (severityDiff !== 0) {
    return severityDiff;
  }

  const leftDate =
    left.kind === 'expiry' ? left.earliestExpiryDate ?? '\uffff' : '\uffff';
  const rightDate =
    right.kind === 'expiry' ? right.earliestExpiryDate ?? '\uffff' : '\uffff';
  const dateDiff = leftDate.localeCompare(rightDate);
  if (dateDiff !== 0) {
    return dateDiff;
  }

  const nameDiff = left.ingredientName.localeCompare(right.ingredientName, 'zh-CN');
  if (nameDiff !== 0) {
    return nameDiff;
  }

  return left.ingredientId.localeCompare(right.ingredientId);
}

function hasPendingIngredientShopping(
  ingredient: Ingredient,
  shoppingItems: ShoppingListItem[]
) {
  return shoppingItems.some((item) => {
    if (item.done) {
      return false;
    }
    if (item.target_type && item.target_type !== 'ingredient') {
      return false;
    }
    if (item.ingredient_id) {
      return item.ingredient_id === ingredient.id;
    }
    return normalizeName(item.title) === normalizeName(ingredient.name);
  });
}

function sumPositiveNonExpiredAvailableQuantity(
  ingredient: Ingredient,
  inventoryItems: InventoryItem[],
  referenceDate: string
) {
  // Convert unlike units into the ingredient default unit before threshold compare.
  return getIngredientAvailableQuantityInDefault(
    ingredient,
    inventoryItems.filter((item) => item.ingredient_id === ingredient.id),
    { excludeExpiredAt: referenceDate },
  );
}

function buildExpiryDetail(args: {
  ingredientName: string;
  severity: ExpiryInventoryActionGroup['severity'];
  expiredBatchCount: number;
  todayBatchCount: number;
  soonBatchCount: number;
  laterBatchCount: number;
  quantityLabels: string[];
  storageLocations: string[];
  mixed: boolean;
}) {
  const {
    severity,
    expiredBatchCount,
    todayBatchCount,
    soonBatchCount,
    laterBatchCount,
    quantityLabels,
    storageLocations,
    mixed,
  } = args;

  if (!mixed && severity === 'expires_today') {
    const quantityPart = quantityLabels.join('、') || '';
    const storagePart = storageLocations[0] ?? '';
    return [quantityPart, storagePart].filter(Boolean).join(' · ');
  }

  const parts: string[] = [];
  if (expiredBatchCount > 0) {
    parts.push(`${expiredBatchCount} 批已过期`);
  }
  if (todayBatchCount > 0) {
    parts.push(`${todayBatchCount} 批今天到期`);
  }
  if (soonBatchCount > 0) {
    parts.push(`${soonBatchCount} 批 3 天内到期`);
  }
  if (laterBatchCount > 0) {
    parts.push(`${laterBatchCount} 批 7 天内到期`);
  }
  return parts.join('，');
}

function buildExpiryGroup(
  ingredient: Ingredient,
  batches: InventoryActionBatch[]
): ExpiryInventoryActionGroup {
  const expiredBatchCount = batches.filter((batch) => batch.daysLeft < 0).length;
  const todayBatchCount = batches.filter((batch) => batch.daysLeft === 0).length;
  const soonBatchCount = batches.filter((batch) => batch.daysLeft >= 1 && batch.daysLeft <= 3).length;
  const laterBatchCount = batches.filter((batch) => batch.daysLeft >= 4 && batch.daysLeft <= 7).length;
  const severity: ExpiryInventoryActionGroup['severity'] =
    expiredBatchCount > 0
      ? 'expired'
      : todayBatchCount > 0
        ? 'expires_today'
        : soonBatchCount > 0
          ? 'expires_soon'
          : 'expires_later';
  const mixed =
    [expiredBatchCount > 0, todayBatchCount > 0, soonBatchCount > 0, laterBatchCount > 0].filter(Boolean).length > 1;
  const quantityLabels = buildQuantityLabels(batches);
  const storageLocations = [...new Set(batches.map((batch) => batch.storageLocation).filter(Boolean))];
  const earliest = [...batches].sort(
    (left, right) => left.expiryDate.localeCompare(right.expiryDate) || left.daysLeft - right.daysLeft
  )[0];
  const title =
    !mixed && severity === 'expires_today'
      ? `${ingredient.name}今天到期`
      : `${ingredient.name}需要处理`;
  const detail = buildExpiryDetail({
    ingredientName: ingredient.name,
    severity,
    expiredBatchCount,
    todayBatchCount,
    soonBatchCount,
    laterBatchCount,
    quantityLabels,
    storageLocations,
    mixed: mixed || severity !== 'expires_today',
  });

  return {
    kind: 'expiry',
    id: `expiry:${ingredient.id}`,
    ingredientId: ingredient.id,
    ingredientName: ingredient.name,
    severity,
    batches: [...batches].sort(
      (left, right) =>
        left.daysLeft - right.daysLeft ||
        left.expiryDate.localeCompare(right.expiryDate) ||
        left.inventoryItemId.localeCompare(right.inventoryItemId)
    ),
    expiredBatchCount,
    todayBatchCount,
    soonBatchCount,
    laterBatchCount,
    totalBatchCount: batches.length,
    quantityLabels,
    storageLocations,
    earliestExpiryDate: earliest?.expiryDate ?? null,
    earliestDaysLeft: earliest?.daysLeft ?? null,
    title,
    detail,
    primaryAction: 'manage_expiry',
  };
}

function buildLowStockGroup(
  ingredient: Ingredient,
  availableQuantity: number,
  threshold: number
): LowStockInventoryActionGroup {
  const unit = ingredient.default_unit || '';
  return {
    kind: 'low_stock',
    id: `low_stock:${ingredient.id}`,
    ingredientId: ingredient.id,
    ingredientName: ingredient.name,
    availableQuantity,
    unit,
    threshold,
    title: `${ingredient.name}库存不足`,
    detail: `现有 ${formatQuantityValue(availableQuantity)} ${unit}，补货线 ${formatQuantityValue(threshold)} ${unit}`,
    primaryAction: 'add_shopping',
  };
}

export function buildInventoryActionGroups(args: {
  inventoryItems: InventoryItem[];
  ingredients: Ingredient[];
  shoppingItems: ShoppingListItem[];
  referenceDate: string;
}): InventoryActionGroup[] {
  const { inventoryItems, ingredients, shoppingItems, referenceDate } = args;
  const ingredientById = new Map(ingredients.map((ingredient) => [ingredient.id, ingredient]));
  const batchesByIngredient = new Map<string, InventoryActionBatch[]>();

  for (const item of inventoryItems) {
    if (!isActionableInventoryBatch(item, referenceDate)) {
      continue;
    }
    const ingredient = ingredientById.get(item.ingredient_id);
    if (!ingredient) {
      continue;
    }
    const expiryDate = item.expiry_date!.slice(0, 10);
    const daysLeft = calendarDaysBetweenDateKeys(expiryDate, referenceDate);
    const batch: InventoryActionBatch = {
      inventoryItemId: item.id,
      rowVersion: item.row_version,
      remainingQuantity: getInventoryRemainingQuantity(item),
      unit: item.unit,
      storageLocation: item.storage_location || ingredient.default_storage || '',
      purchaseDate: item.purchase_date,
      expiryDate,
      daysLeft,
      expiryAlertSnoozedUntil: item.expiry_alert_snoozed_until ?? null,
      expiryReviewedAt: item.expiry_reviewed_at ?? null,
      expiryReviewedBy: item.expiry_reviewed_by ?? null,
    };
    const current = batchesByIngredient.get(ingredient.id) ?? [];
    current.push(batch);
    batchesByIngredient.set(ingredient.id, current);
  }

  const groups: InventoryActionGroup[] = [];
  const expiryIngredientIds = new Set<string>();

  for (const [ingredientId, batches] of batchesByIngredient.entries()) {
    const ingredient = ingredientById.get(ingredientId);
    if (!ingredient || batches.length === 0) {
      continue;
    }
    groups.push(buildExpiryGroup(ingredient, batches));
    expiryIngredientIds.add(ingredientId);
  }

  for (const ingredient of ingredients) {
    if (expiryIngredientIds.has(ingredient.id)) {
      continue;
    }
    if (!tracksIngredientQuantity(ingredient)) {
      continue;
    }
    if (ingredient.default_low_stock_threshold === null || ingredient.default_low_stock_threshold === undefined) {
      continue;
    }
    if (hasPendingIngredientShopping(ingredient, shoppingItems)) {
      continue;
    }
    const availableQuantity = sumPositiveNonExpiredAvailableQuantity(ingredient, inventoryItems, referenceDate);
    if (availableQuantity > ingredient.default_low_stock_threshold) {
      continue;
    }
    groups.push(buildLowStockGroup(ingredient, availableQuantity, ingredient.default_low_stock_threshold));
  }

  return groups.sort(compareActionGroups);
}

export function selectHomeEligibleInventoryActionGroups(groups: InventoryActionGroup[]) {
  return groups.filter((group) => group.kind === 'low_stock' || group.severity !== 'expires_later');
}

export function selectHomeInventoryActionGroups(groups: InventoryActionGroup[], limit = 3) {
  return selectHomeEligibleInventoryActionGroups(groups).slice(0, limit);
}

export function countUniqueAvailableIngredients(args: {
  inventoryItems: InventoryItem[];
  referenceDate: string;
}) {
  const ids = new Set<string>();
  for (const item of args.inventoryItems) {
    if (getInventoryRemainingQuantity(item) <= 0) {
      continue;
    }
    if (item.expiry_date && item.expiry_date.slice(0, 10) < args.referenceDate) {
      continue;
    }
    ids.add(item.ingredient_id);
  }
  return ids.size;
}

export function ingredientHasInventoryAction(
  ingredientId: string,
  groups: InventoryActionGroup[]
) {
  return groups.some((group) => group.ingredientId === ingredientId);
}
