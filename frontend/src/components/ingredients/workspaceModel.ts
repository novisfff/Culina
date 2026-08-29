import type {
  Food,
  Ingredient,
  IngredientInventoryState,
  InventoryItem,
  Recipe,
  ShoppingListItem,
} from '../../api/types';
import {
  buildInventoryActionGroups,
  type ExpiryInventoryActionGroup,
  type InventoryActionGroup,
} from '../../features/inventory/inventoryActionModel';
import { formatDate, todayKey } from '../../lib/ui';
import {
  getIngredientAvailableQuantityInDefault,
  getIngredientUnitConversions,
  getInventoryRemainingQuantity,
} from '../../lib/ingredientUnits';
import { tracksIngredientQuantity } from '../../lib/ingredientTracking';
import { formatNumericString } from './ingredientWorkspaceForms';

export type {
  CatalogCardStatusTone,
  DisposableExpiredInventoryItemViewModel,
  IngredientAlertTone,
  IngredientAlertViewModel,
  IngredientCategoryPreset,
  IngredientOverlayMode,
  IngredientSummaryViewModel,
  IngredientWorkspacePanel,
  IngredientWorkspaceView,
  InventoryBatchGroupViewModel,
  InventoryBatchItemViewModel,
  InventoryCardExpiryTone,
  InventoryCardPresentationViewModel,
  InventoryCardStatusViewModel,
  InventoryCardTone,
  InventoryConfirmationTone,
  InventoryStorageOverviewTone,
  InventoryStorageOverviewViewModel,
  QuantitySummaryViewModel,
  ShoppingCardFocus,
  ShoppingCardStatusTone,
  ShoppingCardTone,
  ShoppingCardViewModel,
  ShoppingOverviewTone,
  ShoppingOverviewViewModel,
  StorageGroupViewModel,
} from './workspaceTypes';
export { buildShoppingOverview, filterShoppingCards } from './shoppingWorkspaceModel';
export {
  buildIngredientCategoryFilters,
  getIngredientCategoryPreset,
  getIngredientEditorCategoryPresets,
  INGREDIENT_CATEGORY_PRESETS,
  isSeasoningIngredient,
} from './ingredientCategoryModel';
export {
  aggregateConfirmationStatus,
  buildExactIngredientConfirmation,
  buildFoodConfirmation,
  buildPresenceIngredientConfirmation,
  confirmationStatusFromLastConfirmedAt,
  confirmationStatusLabel,
  confirmationStatusTone,
  earliestConfirmationAt,
  staleAfterDaysForStorageLocation,
  CONFIRMATION_STATUS_LABELS,
  CONFIRMATION_STATUS_TONES,
  FOOD_STALE_AFTER_DAYS,
  FROZEN_INGREDIENT_STALE_AFTER_DAYS,
  PRESENCE_INGREDIENT_STALE_AFTER_DAYS,
  REFRIGERATED_INGREDIENT_STALE_AFTER_DAYS,
  ROOM_TEMPERATURE_INGREDIENT_STALE_AFTER_DAYS,
} from './ingredientConfirmationModel';
import {
  buildExactIngredientConfirmation,
  buildPresenceIngredientConfirmation,
  buildFoodConfirmation,
} from './ingredientConfirmationModel';
import {
  isSeasoningIngredient,
} from './ingredientCategoryModel';
import type {
  CatalogCardStatusTone,
  DisposableExpiredInventoryItemViewModel,
  IngredientAlertTone,
  IngredientAlertViewModel,
  IngredientSummaryViewModel,
  InventoryBatchGroupViewModel,
  InventoryBatchItemViewModel,
  InventoryCardExpiryTone,
  InventoryCardPresentationViewModel,
  InventoryCardStatusViewModel,
  InventoryConfirmationTone,
  InventoryStorageOverviewViewModel,
  QuantitySummaryViewModel,
  ShoppingCardStatusTone,
  ShoppingCardTone,
  ShoppingCardViewModel,
  StorageGroupViewModel,
} from './workspaceTypes';

export function getIngredientAlertTone(summary: IngredientSummaryViewModel): IngredientAlertTone {
  return summary.alerts.some((item) => item.tone === 'danger') ? 'danger' : 'warning';
}

export function buildInventorySummaryLine(summary: IngredientSummaryViewModel): string {
  if (!tracksIngredientQuantity(summary.ingredient)) {
    const level = summary.inventoryState?.availability_level;
    if (level === 'sufficient' || level === 'present_unknown') return '有库存';
    if (level === 'low') return '少量';
    if (level === 'absent') return '没有库存';
    return '未确认';
  }
  if (summary.quantitySummaries.length === 0) return '还没有库存';
  return summary.quantitySummaries.slice(0, 2).map((item) => item.label).join(' · ');
}

export function buildInventoryRowDescription(summary: IngredientSummaryViewModel): string {
  if (!tracksIngredientQuantity(summary.ingredient)) {
    return `${summary.primaryStorage} · 库存状态：${buildInventorySummaryLine(summary)}`;
  }
  if (summary.inventoryItems.length === 0) {
    return `${summary.primaryStorage} · 还没有库存，适合先补充第一批常用量。`;
  }
  if (summary.quantitySummaries.length === 0) {
    return `${summary.primaryStorage} · 当前没有可用库存，可处理到期库存或补充新的库存。`;
  }
  return [
    buildInventorySummaryLine(summary),
    summary.primaryStorage,
    summary.latestPurchaseDate ? `最近补货 ${formatDate(summary.latestPurchaseDate)}` : null,
  ].filter(Boolean).join(' · ');
}

export function buildInventoryTotalLabel(summary: IngredientSummaryViewModel): string {
  if (!tracksIngredientQuantity(summary.ingredient)) return buildInventorySummaryLine(summary);
  const totalQuantity = getIngredientAvailableQuantityInDefault(summary.ingredient, summary.inventoryItems);
  if (totalQuantity <= 0) return `0 ${summary.ingredient.default_unit || '个'}`;
  return `${formatNumericString(totalQuantity)} ${summary.ingredient.default_unit || '个'}`;
}

export function buildCatalogCardStatus(summary: IngredientSummaryViewModel): {
  label: string;
  tone: CatalogCardStatusTone;
  stockLine: string;
  hint: string;
} {
  const expiredAlert = summary.alerts.find((item) => item.kind === 'expiry' && item.severity === 'expired');
  const expiringAlert = summary.alerts.find((item) => item.kind === 'expiry' && item.severity !== 'expired');
  const firstWarningAlert = summary.alerts.find((item) => item.tone === 'warning');
  const tracksQuantity = tracksIngredientQuantity(summary.ingredient);
  const availableLabel = tracksQuantity ? summary.quantitySummaries[0]?.label ?? '还没有库存' : buildInventorySummaryLine(summary);
  const stockLine = tracksQuantity
    ? summary.inventoryItems.length > 0 ? `库存 ${availableLabel} · ${summary.inventoryItems.length} 批` : `库存 ${availableLabel}`
    : `库存状态 ${availableLabel} · 只记录有无`;
  if (expiredAlert) return { label: '已过期', tone: 'danger', stockLine, hint: '优先处理过期库存' };
  if (expiringAlert) return { label: '临期', tone: expiringAlert.tone === 'danger' ? 'danger' : 'warning', stockLine, hint: '建议优先安排使用' };
  if (summary.quantitySummaries.length === 0) {
    return { label: '还没有可用库存', tone: 'empty', stockLine, hint: summary.inventoryItems.length > 0 ? '可补货或加入采购清单' : '建议先加入库存' };
  }
  if (firstWarningAlert) return { label: '库存偏低', tone: 'warning', stockLine, hint: '建议加入采购清单或补货' };
  return { label: '库存正常', tone: 'stable', stockLine, hint: summary.latestPurchaseDate ? `最近补货 ${formatDate(summary.latestPurchaseDate)}` : '可以记录用量或补货' };
}

export function buildCatalogExpandedNote(summary: IngredientSummaryViewModel): string {
  if (summary.ingredient.notes.trim()) return summary.ingredient.notes.trim();
  if (summary.latestPurchaseDate) return `最近补货于 ${formatDate(summary.latestPurchaseDate)}，当前主要放在 ${summary.primaryStorage}。`;
  if (summary.inventoryItems.length > 0) return `当前有 ${summary.inventoryItems.length} 批库存，可继续补货或查看详情。`;
  return '这项食材还没有库存，先补充一些会更方便。';
}

export function resolveShoppingReason(summary: IngredientSummaryViewModel): string {
  if (summary.alerts.some((item) => item.kind === 'lowStock')) return '库存偏低，准备补货';
  if (summary.alerts.some((item) => item.kind === 'expiry')) return '备一份新的，替换临期库存';
  return '加入近期采购清单';
}

export type SeasoningStatus = 'stocked' | 'needsRestock' | 'unconfigured';

export type SeasoningSummaryViewModel = {
  summary: IngredientSummaryViewModel;
  status: SeasoningStatus;
  statusLabel: '有库存' | '需要补充库存' | '还没有库存记录';
  detail: string;
};

export type ShoppingCardGroupKey = 'regular' | 'seasoning';

export type ShoppingCardGroupViewModel = {
  key: ShoppingCardGroupKey;
  title: string;
  detail: string;
  cards: ShoppingCardViewModel[];
};

const STORAGE_ORDER = ['冷藏', '冷冻', '常温'];
const ALL_CATEGORY_FILTER = 'all';
function normalizeCategoryLabel(value: string) {
  return value.trim() || '未分类';
}

function storageWeight(label: string) {
  const index = STORAGE_ORDER.indexOf(label);
  return index === -1 ? STORAGE_ORDER.length : index;
}

function sortByStorage(left: string, right: string) {
  const weightDiff = storageWeight(left) - storageWeight(right);
  if (weightDiff !== 0) return weightDiff;
  return left.localeCompare(right);
}

function uniqueLabels(values: string[]) {
  return [...new Set(values.filter(Boolean))];
}

function maxTimestamp(...values: Array<string | undefined>) {
  return values
    .filter((value): value is string => Boolean(value))
    .sort((left, right) => right.localeCompare(left))[0] ?? '';
}

function formatQuantityValue(value: number) {
  return String(Number(value.toFixed(2)));
}

function presenceAvailabilityLabel(level: IngredientInventoryState['availability_level'] | null | undefined) {
  if (level === 'sufficient' || level === 'present_unknown') return '有库存';
  if (level === 'low') return '少量';
  if (level === 'absent') return '没有库存';
  return '未确认';
}

function isPresentAvailability(level: IngredientInventoryState['availability_level'] | null | undefined) {
  return level === 'sufficient' || level === 'present_unknown' || level === 'low';
}

function buildSummaryQuantityLabel(summary: IngredientSummaryViewModel) {
  if (!tracksIngredientQuantity(summary.ingredient)) {
    return presenceAvailabilityLabel(summary.inventoryState?.availability_level);
  }
  if (summary.quantitySummaries.length > 0) {
    return summary.quantitySummaries
      .slice(0, 2)
      .map((item) => item.label)
      .join(' · ');
  }
  if (summary.inventoryItems.length > 0) {
    return '当前无可用库存';
  }
  return '还没有库存';
}

function getInventoryStatusPriority(summary: IngredientSummaryViewModel) {
  if (summary.alerts.some((item) => item.tone === 'danger')) {
    return 3;
  }
  if (summary.alerts.some((item) => item.tone === 'warning')) {
    return 2;
  }
  if (summary.quantitySummaries.length === 0) {
    return 1;
  }
  return 0;
}

function sortInventorySummariesForInventory(left: IngredientSummaryViewModel, right: IngredientSummaryViewModel) {
  const priorityDiff = getInventoryStatusPriority(right) - getInventoryStatusPriority(left);
  if (priorityDiff !== 0) {
    return priorityDiff;
  }
  const updatedDiff = right.latestUpdatedAt.localeCompare(left.latestUpdatedAt);
  if (updatedDiff !== 0) {
    return updatedDiff;
  }
  return left.ingredient.name.localeCompare(right.ingredient.name, 'zh-CN');
}

function isRemainingInventory(item: InventoryItem) {
  return getInventoryRemainingQuantity(item) > 0;
}


function isAvailableInventory(item: InventoryItem, todayTime: number) {
  return (
    isRemainingInventory(item) &&
    (!item.expiry_date || new Date(item.expiry_date).getTime() >= todayTime)
  );
}

export function buildIngredientAlerts(
  inventoryItems: InventoryItem[],
  ingredients: Ingredient[],
  today: string,
  shoppingItems: ShoppingListItem[] = [],
  inventoryStates: IngredientInventoryState[] = [],
) {
  const groups = buildInventoryActionGroups({
    inventoryItems,
    ingredients,
    shoppingItems,
    inventoryStates,
    referenceDate: today,
  });
  return inventoryActionGroupsToAlerts(groups, ingredients);
}

export function inventoryActionGroupsToAlerts(
  groups: InventoryActionGroup[],
  ingredients: Ingredient[]
): IngredientAlertViewModel[] {
  const ingredientById = new Map(ingredients.map((ingredient) => [ingredient.id, ingredient]));
  const alerts: IngredientAlertViewModel[] = [];

  for (const group of groups) {
    const ingredient = ingredientById.get(group.ingredientId);
    if (group.kind === 'low_stock') {
      alerts.push({
        id: group.id,
        ingredientId: group.ingredientId,
        ingredientName: group.ingredientName,
        title: group.title,
        detail: group.detail,
        tone: 'warning',
        kind: 'lowStock',
        storageLocation: ingredient?.default_storage || '',
      });
      continue;
    }

    // One alert per shared group so priority/action counts stay ingredient-level.
    alerts.push({
      id: group.id,
      ingredientId: group.ingredientId,
      ingredientName: group.ingredientName,
      title: group.title,
      detail: group.detail,
      tone: group.severity === 'expires_later' ? 'warning' : 'danger',
      kind: 'expiry',
      severity: group.severity,
      storageLocation: group.storageLocations[0] || ingredient?.default_storage || '',
    });
  }

  return alerts;
}

export function buildIngredientPriorityActionGroups(args: {
  inventoryItems: InventoryItem[];
  ingredients: Ingredient[];
  shoppingItems?: ShoppingListItem[];
  inventoryStates?: IngredientInventoryState[];
  referenceDate: string;
}) {
  return buildInventoryActionGroups({
    inventoryItems: args.inventoryItems,
    ingredients: args.ingredients,
    shoppingItems: args.shoppingItems ?? [],
    inventoryStates: args.inventoryStates ?? [],
    referenceDate: args.referenceDate,
  });
}

export type PrioritySurfaceShoppingBinding = {
  ingredientId: string;
  ingredientName: string;
  reason: string;
};

export type PrioritySurfaceRow = {
  group: InventoryActionGroup;
  shoppingBinding: PrioritySurfaceShoppingBinding | null;
};

export function buildPrioritySurfaceRows(groups: InventoryActionGroup[]): PrioritySurfaceRow[] {
  return groups.map((group) => ({
    group,
    shoppingBinding:
      group.kind === 'low_stock'
        ? {
            ingredientId: group.ingredientId,
            ingredientName: group.ingredientName,
            reason: '库存不足',
          }
        : null,
  }));
}

export function buildPriorityGroupStatus(group: InventoryActionGroup): InventoryCardStatusViewModel {
  if (group.kind === 'low_stock') {
    return {
      label: '库存偏低',
      tone: 'warning',
      detail: group.detail,
      priority: 2,
    };
  }
  if (group.severity === 'expires_later') {
    return {
      label: '临期或过期',
      tone: 'warning',
      detail: group.detail,
      priority: 2,
    };
  }
  return {
    label: '临期或过期',
    tone: 'danger',
    detail: group.detail,
    priority: 3,
  };
}

export function getPriorityGroupPrimaryLabel(group: InventoryActionGroup) {
  if (group.kind === 'low_stock') {
    return '加入采购清单';
  }
  return group.severity === 'expired' ? '处理过期库存' : '处理临期库存';
}

export function buildQuantitySummaries(inventoryItems: InventoryItem[]): QuantitySummaryViewModel[] {
  const grouped = new Map<string, number>();
  for (const item of inventoryItems) {
    const remainingQuantity = getInventoryRemainingQuantity(item);
    if (remainingQuantity <= 0) {
      continue;
    }
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

function pickPrimaryStorage(ingredient: Ingredient, inventoryItems: InventoryItem[]) {
  if (inventoryItems.length === 0) {
    return ingredient.default_storage || '常温';
  }

  const counts = new Map<string, number>();
  for (const item of inventoryItems) {
    const key = item.storage_location || ingredient.default_storage || '常温';
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }

  return [...counts.entries()].sort((left, right) => right[1] - left[1] || sortByStorage(left[0], right[0]))[0][0];
}

export function buildIngredientSummaries(args: {
  ingredients: Ingredient[];
  inventoryItems: InventoryItem[];
  recipes: Recipe[];
  /** Explicit business-date reference; required for presence/expiry projections. */
  referenceDate: string;
  shoppingItems?: ShoppingListItem[];
  inventoryStates?: IngredientInventoryState[];
  /** @deprecated Use referenceDate. Kept for transitional call sites. */
  today?: string;
}) {
  const referenceDate = args.referenceDate ?? args.today;
  if (!referenceDate) {
    throw new Error('buildIngredientSummaries requires an explicit referenceDate');
  }
  const { ingredients, inventoryItems, recipes, shoppingItems = [], inventoryStates = [] } = args;
  const todayTime = new Date(referenceDate).getTime();
  const stateByIngredientId = new Map(inventoryStates.map((state) => [state.ingredient_id, state]));
  const alerts = buildIngredientAlerts(inventoryItems, ingredients, referenceDate, shoppingItems, inventoryStates);

  return ingredients
    .map<IngredientSummaryViewModel>((ingredient) => {
      const tracksQuantity = tracksIngredientQuantity(ingredient);
      const state = tracksQuantity ? null : stateByIngredientId.get(ingredient.id) ?? null;
      // Exact ingredients remain batch-derived. Presence ignores legacy placeholder InventoryItems.
      const ingredientInventory = tracksQuantity
        ? inventoryItems
            .filter((item) => item.ingredient_id === ingredient.id)
            .sort((left, right) => right.updated_at.localeCompare(left.updated_at))
        : [];
      const availableInventory = tracksQuantity
        ? ingredientInventory.filter((item) => isAvailableInventory(item, todayTime))
        : [];
      const remainingInventory = tracksQuantity ? ingredientInventory.filter(isRemainingInventory) : [];
      const totalAvailableInDefault = tracksQuantity
        ? getIngredientAvailableQuantityInDefault(ingredient, availableInventory)
        : 0;
      const quantitySummaries = !tracksQuantity
        ? isPresentAvailability(state?.availability_level)
          ? [
              {
                unit: '',
                total: state?.availability_level === 'low' ? 0.5 : 1,
                label: presenceAvailabilityLabel(state?.availability_level),
              },
            ]
          : []
        : totalAvailableInDefault > 0
          ? [
              {
                unit: ingredient.default_unit,
                total: totalAvailableInDefault,
                label: `${Number(totalAvailableInDefault.toFixed(2)).toString().replace(/\.0+$/, '')} ${ingredient.default_unit}`,
              },
            ]
          : [];
      const presenceStorage = state?.storage_location?.trim() || ingredient.default_storage || '常温';
      const storageLocations = tracksQuantity
        ? uniqueLabels(remainingInventory.map((item) => item.storage_location).concat(ingredient.default_storage)).sort(
            sortByStorage,
          )
        : uniqueLabels([presenceStorage, ingredient.default_storage]).sort(sortByStorage);
      const recipeReferences = recipes
        .filter((recipe) => recipe.ingredient_items.some((item) => item.ingredient_id === ingredient.id))
        .map((recipe) => ({ id: recipe.id, title: recipe.title }));
      const ingredientAlerts = alerts.filter((item) => item.ingredientId === ingredient.id);
      const latestUpdatedAt = tracksQuantity
        ? maxTimestamp(ingredient.updated_at, ...ingredientInventory.map((item) => item.updated_at))
        : maxTimestamp(ingredient.updated_at, state?.updated_at);
      const latestPurchaseDate = tracksQuantity
        ? ingredientInventory.map((item) => item.purchase_date).sort((left, right) => right.localeCompare(left))[0] ??
          null
        : state?.purchase_date ?? null;
      const primaryStorage = tracksQuantity
        ? pickPrimaryStorage(ingredient, availableInventory.length > 0 ? availableInventory : remainingInventory)
        : presenceStorage;
      const confirmation = tracksQuantity
        ? buildExactIngredientConfirmation({
            batches: remainingInventory,
            referenceDate,
            fallbackStorage: primaryStorage,
          })
        : buildPresenceIngredientConfirmation({
            state,
            referenceDate,
          });

      return {
        ingredient,
        inventoryItems: remainingInventory,
        availableInventoryItems: availableInventory,
        inventoryState: state,
        alerts: ingredientAlerts.sort(
          (left, right) =>
            Number(right.tone === 'danger') - Number(left.tone === 'danger') || left.title.localeCompare(right.title),
        ),
        quantitySummaries,
        hasMultipleUnits: getIngredientUnitConversions(ingredient).length > 0,
        primaryStorage,
        storageLocations,
        recipeReferences,
        latestPurchaseDate,
        latestUpdatedAt,
        confirmationStatus: confirmation.confirmationStatus,
        confirmationLabel: confirmation.confirmationLabel,
        confirmationTone: confirmation.confirmationTone,
        lastConfirmedAt: confirmation.lastConfirmedAt,
      };
    })
    .sort((left, right) => {
      const alertDiff = right.alerts.length - left.alerts.length;
      if (alertDiff !== 0) return alertDiff;
      return left.ingredient.name.localeCompare(right.ingredient.name, 'zh-CN');
    });
}

export function buildStorageGroups(summaries: IngredientSummaryViewModel[]): StorageGroupViewModel[] {
  const grouped = new Map<string, IngredientSummaryViewModel[]>();
  for (const summary of summaries) {
    const key = summary.primaryStorage || '常温';
    grouped.set(key, [...(grouped.get(key) ?? []), summary]);
  }

  return [...grouped.entries()]
    .sort((left, right) => sortByStorage(left[0], right[0]))
    .map(([key, items]) => ({
      key,
      label: key,
      items: items.sort(sortInventorySummariesForInventory),
      totalBatches: items.reduce((sum, item) => sum + item.inventoryItems.length, 0),
      alertCount: items.reduce((sum, item) => sum + item.alerts.length, 0),
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
    detail: summary.latestPurchaseDate
      ? `最近补货 ${formatDate(summary.latestPurchaseDate)}，库存正常。`
      : '库存正常，可正常使用。',
    priority: 0,
  };
}

function buildInventoryCardSummaryLine(summary: IngredientSummaryViewModel) {
  if (summary.quantitySummaries.length === 0) {
    return '还没有库存';
  }

  return summary.quantitySummaries
    .slice(0, 2)
    .map((item) => item.label)
    .join(' · ');
}

function buildInventoryCardExpiry(summary: IngredientSummaryViewModel, referenceDate: string) {
  const earliestExpiryDate = !tracksIngredientQuantity(summary.ingredient)
    ? summary.inventoryState?.expiry_date ?? null
    : summary.inventoryItems
        .map((item) => item.expiry_date)
        .filter((value): value is string => Boolean(value))
        .sort((left, right) => left.localeCompare(right))[0] ?? null;

  if (!earliestExpiryDate) {
    return {
      hasExpiryInfo: false,
      expiryLabel: null,
      expiryDateLabel: null,
      expiryTone: null,
    } satisfies Pick<
      InventoryCardPresentationViewModel,
      'hasExpiryInfo' | 'expiryLabel' | 'expiryDateLabel' | 'expiryTone'
    >;
  }

  const diffDays = Math.round(
    (new Date(earliestExpiryDate).getTime() - new Date(referenceDate).getTime()) / (1000 * 60 * 60 * 24)
  );
  const expiryLabel =
    diffDays < 0
      ? `已过期 ${Math.abs(diffDays)} 天`
      : diffDays === 0
        ? '今天到期'
      : diffDays === 1
          ? '距到期 1 天'
          : `距到期 ${diffDays} 天`;

  const expiryTone: InventoryCardExpiryTone =
    diffDays <= 2 ? 'danger' : diffDays <= 7 ? 'warning' : 'neutral';

  return {
    hasExpiryInfo: true,
    expiryLabel,
    expiryDateLabel: formatDate(earliestExpiryDate),
    expiryTone,
  } satisfies Pick<
    InventoryCardPresentationViewModel,
    'hasExpiryInfo' | 'expiryLabel' | 'expiryDateLabel' | 'expiryTone'
  >;
}

export function buildDisposableExpiredInventoryItems(
  summary: IngredientSummaryViewModel,
  referenceDate: string,
): DisposableExpiredInventoryItemViewModel[] {
  // Calendar-key compare keeps dispose eligibility aligned with Shanghai businessDateKey.
  const referenceKey = referenceDate.slice(0, 10);

  return summary.inventoryItems
    .filter((item) => {
      if (!item.expiry_date) {
        return false;
      }
      if (item.expiry_date.slice(0, 10) >= referenceKey) {
        return false;
      }
      return getInventoryRemainingQuantity(item) > 0;
    })
    .sort(
      (left, right) =>
        left.expiry_date!.localeCompare(right.expiry_date!) ||
        left.purchase_date.localeCompare(right.purchase_date) ||
        left.created_at.localeCompare(right.created_at)
    )
    .map((item) => {
      const remainingQuantity = getInventoryRemainingQuantity(item);
      return {
        id: item.id,
        ingredientId: item.ingredient_id,
        ingredientName: item.ingredient_name,
        remainingQuantity,
        remainingLabel: `${formatQuantityValue(remainingQuantity)} ${item.unit}`,
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

export function countDisposableExpiredInventoryItems(
  summary: IngredientSummaryViewModel,
  referenceDate: string,
) {
  const referenceKey = referenceDate.slice(0, 10);

  return summary.inventoryItems.reduce((count, item) => {
    if (!item.expiry_date) {
      return count;
    }
    if (item.expiry_date.slice(0, 10) >= referenceKey) {
      return count;
    }
    return getInventoryRemainingQuantity(item) > 0 ? count + 1 : count;
  }, 0);
}

export function buildInventoryCardPresentation(
  summary: IngredientSummaryViewModel,
  referenceDate: string,
): InventoryCardPresentationViewModel {
  const status = buildInventoryCardStatus(summary);
  const expiry = buildInventoryCardExpiry(summary, referenceDate);
  // Decorative date badge may keep its own day-window colors, but must never look calm
  // when the shared action projection includes this ingredient.
  const actionableTone: InventoryCardExpiryTone | null =
    summary.alerts.length === 0
      ? null
      : summary.alerts.some((item) => item.tone === 'danger')
        ? 'danger'
        : 'warning';
  const resolvedExpiryTone: InventoryCardExpiryTone | null =
    expiry.hasExpiryInfo && actionableTone && expiry.expiryTone === 'neutral'
      ? actionableTone
      : expiry.expiryTone;
  const resolvedExpiry = {
    ...expiry,
    expiryTone: resolvedExpiryTone,
  };
  const latestRestockLabel = summary.latestPurchaseDate ? formatDate(summary.latestPurchaseDate) : null;
  const hasExpiredInventory = summary.alerts.some((item) => item.kind === 'expiry' && item.tone === 'danger');
  const footerNote =
    hasExpiredInventory
      ? `当前有 ${summary.alerts.length} 条提醒，请先处理过期库存。`
      : summary.alerts.length > 0
        ? `当前有 ${summary.alerts.length} 条提醒，建议优先处理。`
        : status.detail;
  const confirmation = {
    confirmationStatus: summary.confirmationStatus,
    confirmationLabel: summary.confirmationLabel,
    confirmationTone: summary.confirmationTone,
    lastConfirmedAt: summary.lastConfirmedAt,
  };

  if (summary.quantitySummaries.length > 0) {
    const secondaryParts = latestRestockLabel ? [`最近补货 ${latestRestockLabel}`] : [];
    secondaryParts.push(resolvedExpiry.hasExpiryInfo ? `最早 ${resolvedExpiry.expiryDateLabel} 到期` : '没有设置保质期');

    return {
      headline: buildInventoryCardSummaryLine(summary),
      secondary: secondaryParts.join(' · '),
      footerNote,
      ...resolvedExpiry,
      ...confirmation,
    };
  }

  if (!tracksIngredientQuantity(summary.ingredient)) {
    // State absent/default: no current presence fact.
    return {
      headline: summary.inventoryState?.availability_level === 'absent' ? '没有库存' : '未确认',
      secondary:
        summary.inventoryState?.availability_level === 'absent'
          ? '家里没有库存'
          : '还没有确认家里是否有库存，建议先确认库存状态',
      footerNote,
      ...resolvedExpiry,
      ...confirmation,
    };
  }

  if (summary.inventoryItems.length > 0) {
    return {
      headline: '当前无可用库存',
      secondary: latestRestockLabel ? `最近补货 ${latestRestockLabel} · 当前无可用库存` : '当前无可用库存',
      footerNote,
      ...resolvedExpiry,
      ...confirmation,
    };
  }

  return {
    headline: '还没有库存',
    secondary: '还没有库存，适合先补充第一批',
    footerNote,
    ...resolvedExpiry,
    ...confirmation,
  };
}

export function buildInventoryStorageOverview(
  summaries: IngredientSummaryViewModel[]
): InventoryStorageOverviewViewModel[] {
  return STORAGE_ORDER.map((storage) => {
    const items = summaries.filter((summary) => summary.primaryStorage === storage);
    const alertCount = items.reduce((sum, item) => sum + item.alerts.length, 0);
    const totalBatches = items.reduce((sum, item) => sum + item.inventoryItems.length, 0);
    const highestPriority = Math.max(0, ...items.map((item) => buildInventoryCardStatus(item).priority));

    return {
      key: storage,
      label: storage,
      ingredientCount: items.length,
      totalBatches,
      alertCount,
      tone:
        items.length === 0
          ? 'muted'
          : highestPriority >= 3
            ? 'danger'
            : highestPriority >= 2
              ? 'warning'
              : 'stable',
      statusLabel:
        items.length === 0
          ? '这里还没有食材'
          : alertCount > 0
            ? `${alertCount} 条提醒需要处理`
            : totalBatches > 0
              ? '库存正常'
              : '建议加入库存',
    };
  });
}

function getInventorySummaryEarliestExpiry(summary: IngredientSummaryViewModel) {
  return (
    summary.inventoryItems
      .map((item) => item.expiry_date)
      .filter((value): value is string => Boolean(value))
      .sort((left, right) => left.localeCompare(right))[0] ?? null
  );
}

export function sortInventorySummariesByExpiry(
  summaries: IngredientSummaryViewModel[]
): IngredientSummaryViewModel[] {
  return [...summaries].sort((left, right) => {
    const leftExpiry = getInventorySummaryEarliestExpiry(left);
    const rightExpiry = getInventorySummaryEarliestExpiry(right);

    if (leftExpiry && rightExpiry && leftExpiry !== rightExpiry) {
      return leftExpiry.localeCompare(rightExpiry);
    }
    if (leftExpiry && !rightExpiry) {
      return -1;
    }
    if (!leftExpiry && rightExpiry) {
      return 1;
    }

    const priorityDiff = buildInventoryCardStatus(right).priority - buildInventoryCardStatus(left).priority;
    if (priorityDiff !== 0) {
      return priorityDiff;
    }

    return sortInventorySummariesForInventory(left, right);
  });
}

export function buildInventoryBatchGroups(args: {
  ingredients: Ingredient[];
  inventoryItems: InventoryItem[];
  referenceDate: string;
  shoppingItems?: ShoppingListItem[];
  inventoryStates?: IngredientInventoryState[];
  /** @deprecated Use referenceDate. */
  today?: string;
}) {
  const referenceDate = args.referenceDate ?? args.today;
  if (!referenceDate) {
    throw new Error('buildInventoryBatchGroups requires an explicit referenceDate');
  }
  const { ingredients, inventoryItems, shoppingItems = [], inventoryStates = [] } = args;
  const alerts = buildIngredientAlerts(inventoryItems, ingredients, referenceDate, shoppingItems, inventoryStates);
  const grouped = new Map<string, InventoryBatchItemViewModel[]>();

  for (const item of inventoryItems) {
    if (!isRemainingInventory(item)) {
      continue;
    }
    const ingredient = ingredients.find((entry) => entry.id === item.ingredient_id);
    const key = item.storage_location || ingredient?.default_storage || '常温';
    const normalizedBatchQuantity = ingredient
      ? getIngredientAvailableQuantityInDefault(ingredient, [item])
      : getInventoryRemainingQuantity(item);
    const batch: InventoryBatchItemViewModel = {
      id: item.id,
      ingredientId: item.ingredient_id,
      ingredientName: item.ingredient_name,
      ingredientImageUrl: ingredient?.image?.url ?? undefined,
      quantityLabel: `${Number(normalizedBatchQuantity.toFixed(2)).toString().replace(/\.0+$/, '')} ${ingredient?.default_unit ?? item.unit}`,
      status: item.status,
      purchaseDate: item.purchase_date,
      expiryDate: item.expiry_date,
      storageLocation: key,
      notes: item.notes,
      alerts: alerts.filter((alert) => alert.ingredientId === item.ingredient_id && alert.kind === 'expiry'),
    };
    grouped.set(key, [...(grouped.get(key) ?? []), batch]);
  }

  return [...grouped.entries()]
    .sort((left, right) => sortByStorage(left[0], right[0]))
    .map(([key, items]) => ({
      key,
      label: key,
      items: items.sort((left, right) => right.purchaseDate.localeCompare(left.purchaseDate)),
    }));
}

export function filterIngredientSummaries(
  summaries: IngredientSummaryViewModel[],
  term: string,
  categoryFilter = ALL_CATEGORY_FILTER,
  matchedIngredientIds: readonly string[] = []
) {
  const normalized = term.trim();
  const matchedIdSet = new Set(matchedIngredientIds);
  const matchedOrder = new Map(matchedIngredientIds.map((id, index) => [id, index]));
  const filtered = summaries.filter((summary) => {
    const matchesCategory =
      categoryFilter === ALL_CATEGORY_FILTER || normalizeCategoryLabel(summary.ingredient.category) === categoryFilter;
    if (!matchesCategory) {
      return false;
    }
    if (!normalized) {
      return true;
    }
    return (
      matchedIdSet.has(summary.ingredient.id) ||
      summary.ingredient.name.includes(normalized) ||
      summary.ingredient.category.includes(normalized) ||
      summary.ingredient.notes.includes(normalized) ||
      summary.recipeReferences.some((item) => item.title.includes(normalized))
    );
  });
  if (!normalized || matchedIngredientIds.length === 0) {
    return filtered;
  }
  return [...filtered].sort((left, right) => {
    const leftOrder = matchedOrder.get(left.ingredient.id);
    const rightOrder = matchedOrder.get(right.ingredient.id);
    if (leftOrder !== undefined && rightOrder !== undefined) {
      return leftOrder - rightOrder;
    }
    if (leftOrder !== undefined) {
      return -1;
    }
    if (rightOrder !== undefined) {
      return 1;
    }
    return 0;
  });
}

export function filterInventoryBatchGroups(groups: InventoryBatchGroupViewModel[], term: string) {
  const normalized = term.trim();
  if (!normalized) return groups;
  return groups
    .map((group) => ({
      ...group,
      items: group.items.filter((item) => {
        return (
          item.ingredientName.includes(normalized) ||
          item.storageLocation.includes(normalized) ||
          item.notes.includes(normalized)
        );
      }),
    }))
    .filter((group) => group.items.length > 0);
}

export function filterIngredientSummariesForInventory(
  summaries: IngredientSummaryViewModel[],
  term: string,
  matchedIngredientIds: readonly string[] = []
) {
  const normalized = term.trim();
  const matchedIdSet = new Set(matchedIngredientIds);
  if (!normalized) {
    return summaries;
  }

  return summaries.filter((summary) => {
    return (
      matchedIdSet.has(summary.ingredient.id) ||
      summary.ingredient.name.includes(normalized) ||
      summary.ingredient.category.includes(normalized) ||
      summary.ingredient.notes.includes(normalized) ||
      summary.primaryStorage.includes(normalized) ||
      summary.storageLocations.some((location) => location.includes(normalized)) ||
      summary.alerts.some((alert) => alert.title.includes(normalized) || alert.detail.includes(normalized))
    );
  });
}

export function hasExpiredCatalogAlert(summary: IngredientSummaryViewModel) {
  return summary.alerts.some((item) => item.kind === 'expiry' && item.severity === 'expired');
}

export function hasExpiringCatalogAlert(summary: IngredientSummaryViewModel) {
  return summary.alerts.some((item) => item.kind === 'expiry' && item.severity !== 'expired');
}

export function matchesCatalogStatusFilter(
  summary: IngredientSummaryViewModel,
  filter: 'all' | 'actionNeeded' | 'expired' | 'expiring' | 'lowStock' | 'stable'
) {
  if (filter === 'all') {
    return true;
  }
  if (filter === 'actionNeeded') {
    // Shared 需处理 projection: any ingredient present in InventoryActionGroup alerts.
    return summary.alerts.length > 0;
  }
  if (filter === 'expired') {
    return hasExpiredCatalogAlert(summary);
  }
  if (filter === 'expiring') {
    return hasExpiringCatalogAlert(summary);
  }
  if (filter === 'lowStock') {
    return summary.alerts.some((item) => item.kind === 'lowStock');
  }
  return summary.quantitySummaries.length > 0 && summary.alerts.length === 0;
}

export function filterIngredientSummariesByCatalogStatus(
  summaries: IngredientSummaryViewModel[],
  filter: 'all' | 'actionNeeded' | 'expired' | 'expiring' | 'lowStock' | 'stable'
) {
  return summaries.filter((summary) => matchesCatalogStatusFilter(summary, filter));
}

export function buildShoppingCards(
  shoppingItems: ShoppingListItem[],
  summaries: IngredientSummaryViewModel[],
  options?: { completed?: boolean; foods?: Food[] }
): ShoppingCardViewModel[] {
  const summaryByName = new Map(
    summaries.map((summary) => [summary.ingredient.name.trim(), summary] satisfies [string, IngredientSummaryViewModel])
  );
  const summaryById = new Map(
    summaries.map((summary) => [summary.ingredient.id, summary] satisfies [string, IngredientSummaryViewModel])
  );
  const foodById = new Map((options?.foods ?? []).map((food) => [food.id, food] satisfies [string, Food]));

  return [...shoppingItems]
    .map((shoppingItem) => {
      const normalizedTitle = shoppingItem.title.trim();
      const linkedSummary =
        (shoppingItem.ingredient_id ? summaryById.get(shoppingItem.ingredient_id) ?? null : null) ??
        (shoppingItem.target_type === 'food' || shoppingItem.food_id ? null : summaryByName.get(normalizedTitle)) ??
        null;
      const linkedFood = shoppingItem.food_id ? foodById.get(shoppingItem.food_id) ?? null : null;
      const hasAttention = Boolean(linkedSummary && linkedSummary.alerts.length > 0);
      const status = linkedSummary ? buildInventoryCardStatus(linkedSummary) : null;
      const reasonLabel = shoppingItem.reason.trim() || (linkedSummary ? '加入近期采购清单' : '需要补货');
      const inventoryLabel = linkedFood
        ? linkedFood.stock_quantity && linkedFood.stock_quantity > 0
          ? `${formatQuantityValue(linkedFood.stock_quantity)} ${linkedFood.stock_unit || shoppingItem.unit || '份'}`
          : '还没有库存'
        : linkedSummary ? buildSummaryQuantityLabel(linkedSummary) : '还没有选择食材';
      const inventoryNote = linkedSummary
        ? linkedSummary.alerts.length > 0
          ? linkedSummary.alerts[0]!.title
          : linkedSummary.latestPurchaseDate
            ? `最近补货 ${formatDate(linkedSummary.latestPurchaseDate)}`
            : `常放 ${linkedSummary.primaryStorage || linkedSummary.ingredient.default_storage || '常温'}`
        : linkedFood
          ? `成品存放位置 ${linkedFood.storage_location || '常温'}，买回后补充库存。`
          : '还没有选择食材，买回后可选择食材并加入库存。';
      const footerNote = linkedSummary
        ? linkedSummary.alerts.length > 0
          ? linkedSummary.alerts[0]!.detail
          : linkedSummary.latestPurchaseDate
            ? `最近补货 ${formatDate(linkedSummary.latestPurchaseDate)}，当前库存 ${inventoryLabel}。`
            : `当前库存 ${inventoryLabel}，默认放在 ${linkedSummary.primaryStorage || linkedSummary.ingredient.default_storage || '常温'}。`
        : linkedFood
          ? `买回后为 ${linkedFood.name} 补充库存，默认单位 ${linkedFood.stock_unit || shoppingItem.unit || '份'}。`
          : shoppingItem.reason.trim()
          ? `采购备注：${shoppingItem.reason.trim()}`
        : '还没有选择食材，买回后可选择食材并加入库存。';
      const contextTags = linkedFood
        ? [
            linkedFood.category || '成品速食',
            linkedFood.storage_location || '常温',
            `库存 ${inventoryLabel}`,
          ]
        : linkedSummary
        ? [
            linkedSummary.ingredient.category || '未分类',
            linkedSummary.primaryStorage || linkedSummary.ingredient.default_storage || '常温',
            `库存 ${inventoryLabel}`,
          ]
        : ['其他采购', '还没有选择食材', '买回后可补充库存'];
      const contextLine = linkedFood
        ? [
            linkedFood.category || '成品速食',
            linkedFood.storage_location || '常温',
          ].join(' · ')
        : linkedSummary
        ? [
            linkedSummary.ingredient.category || '未分类',
            linkedSummary.primaryStorage || linkedSummary.ingredient.default_storage || '常温',
          ].join(' · ')
        : '其他采购 · 还没有选择食材';
      const statusLabel = linkedFood
        ? linkedFood.stock_quantity && linkedFood.stock_quantity > 0
          ? '有库存'
          : '需要补充库存'
        : linkedSummary
        ? linkedSummary.quantitySummaries.length === 0
          ? status!.label
          : linkedSummary.alerts[0]?.title ?? '库存正常'
        : '还没有加入库存';
      const statusTone: ShoppingCardStatusTone = linkedFood
        ? linkedFood.stock_quantity && linkedFood.stock_quantity > 0 ? 'stable' : 'muted'
        : linkedSummary
        ? status!.tone === 'empty'
          ? 'muted'
          : status!.tone
        : 'muted';
      const tone: ShoppingCardTone = hasAttention ? 'attention' : (linkedSummary || linkedFood) ? 'linked' : 'freeform';
      const sourceLabel: ShoppingCardViewModel['sourceLabel'] = linkedFood ? '成品速食' : linkedSummary ? '关联食材' : '其他采购';
      const searchText = [
        shoppingItem.title,
        shoppingItem.reason,
        linkedSummary?.ingredient.name,
        linkedSummary?.ingredient.category,
        linkedFood?.name,
        linkedFood?.category,
        linkedFood?.storage_location,
      ]
        .filter(Boolean)
        .join(' ');
      const subline = reasonLabel;

      const usesPresenceQuantity =
        shoppingItem.quantity_mode === 'not_track_quantity' ||
        Boolean(linkedSummary && !tracksIngredientQuantity(linkedSummary.ingredient));
      const shoppingQuantityLabel = shoppingItem.display_label?.trim() || '需要补充';

      return {
        shoppingItem,
        linkedSummary,
        linkedFood,
        title: normalizedTitle || shoppingItem.title,
        headline: usesPresenceQuantity
          ? shoppingQuantityLabel
          : `${formatQuantityValue(shoppingItem.quantity)} ${shoppingItem.unit}`,
        quantityLabel: usesPresenceQuantity
          ? shoppingQuantityLabel
          : `${formatQuantityValue(shoppingItem.quantity)} ${shoppingItem.unit}`,
        subline,
        contextTags,
        reasonLabel,
        contextLine,
        inventoryLabel,
        inventoryNote,
        footerNote,
        statusLabel,
        statusTone,
        sourceLabel,
        tone,
        isLinked: Boolean(linkedSummary || linkedFood),
        hasAttention,
        updatedAt: shoppingItem.updated_at,
        searchText,
      };
    })
    .sort((left, right) => {
      if (options?.completed) {
        return (
          right.updatedAt.localeCompare(left.updatedAt) ||
          left.title.localeCompare(right.title, 'zh-CN')
        );
      }

      const leftPriority = left.hasAttention ? 2 : left.isLinked ? 1 : 0;
      const rightPriority = right.hasAttention ? 2 : right.isLinked ? 1 : 0;
      return (
        rightPriority - leftPriority ||
        right.updatedAt.localeCompare(left.updatedAt) ||
        left.title.localeCompare(right.title, 'zh-CN')
      );
    });
}

export function buildSeasoningSummaries(summaries: IngredientSummaryViewModel[]): SeasoningSummaryViewModel[] {
  return summaries
    .filter((summary) => isSeasoningIngredient(summary.ingredient))
    .map((summary) => {
      const hasAvailable = summary.quantitySummaries.length > 0;
      const status: SeasoningStatus = hasAvailable
        ? 'stocked'
        : summary.inventoryState?.availability_level === 'absent'
          ? 'needsRestock'
          : summary.inventoryItems.length > 0
            ? 'needsRestock'
            : 'unconfigured';
      const statusLabel: SeasoningSummaryViewModel['statusLabel'] =
        status === 'stocked' ? '有库存' : status === 'needsRestock' ? '需要补充库存' : '还没有库存记录';
      const detail =
        status === 'stocked'
          ? `常放 ${summary.primaryStorage || summary.ingredient.default_storage || '常温'}`
          : status === 'needsRestock'
            ? '这类常备品需要补充'
            : '还没有库存记录';
      return { summary, status, statusLabel, detail };
    })
    .sort((left, right) => {
      const statusWeight = { needsRestock: 0, unconfigured: 1, stocked: 2 } satisfies Record<SeasoningStatus, number>;
      return (
        statusWeight[left.status] - statusWeight[right.status] ||
        right.summary.latestUpdatedAt.localeCompare(left.summary.latestUpdatedAt) ||
        left.summary.ingredient.name.localeCompare(right.summary.ingredient.name, 'zh-CN')
      );
    });
}

export function buildShoppingCardGroups(cards: ShoppingCardViewModel[]): ShoppingCardGroupViewModel[] {
  const regularCards = cards.filter((card) => !card.linkedSummary || !isSeasoningIngredient(card.linkedSummary.ingredient));
  const seasoningCards = cards.filter((card) => card.linkedSummary && isSeasoningIngredient(card.linkedSummary.ingredient));
  return [
    {
      key: 'regular' as const,
      title: '普通食材',
      detail: '按数量补充的食材',
      cards: regularCards,
    },
    {
      key: 'seasoning' as const,
      title: '调料常备',
      detail: '只记录有无库存，不用填写具体数量',
      cards: seasoningCards,
    },
  ].filter((group) => group.cards.length > 0);
}
