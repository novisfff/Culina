import type { Ingredient, InventoryItem, Recipe, ShoppingListItem } from '../../api/types';
import { formatDate, todayKey } from '../../lib/ui';
import {
  getIngredientAvailableQuantityInDefault,
  getIngredientUnitConversions,
  getInventoryRemainingQuantity,
} from '../../lib/ingredientUnits';
import { tracksIngredientQuantity } from '../../lib/ingredientTracking';

export type IngredientWorkspaceView = 'hub' | 'catalog' | 'detail' | 'create';
export type IngredientOverlayMode = 'inventory' | 'shopping' | 'consume' | 'destroyExpired' | null;
export type IngredientWorkspacePanel = 'catalog' | 'inventory' | 'shopping';

export type IngredientAlertViewModel = {
  id: string;
  ingredientId: string;
  ingredientName: string;
  title: string;
  detail: string;
  tone: 'warning' | 'danger';
  kind: 'lowStock' | 'expiry';
  storageLocation: string;
};

export type QuantitySummaryViewModel = {
  unit: string;
  total: number;
  label: string;
};

export type IngredientSummaryViewModel = {
  ingredient: Ingredient;
  inventoryItems: InventoryItem[];
  availableInventoryItems: InventoryItem[];
  alerts: IngredientAlertViewModel[];
  quantitySummaries: QuantitySummaryViewModel[];
  hasMultipleUnits: boolean;
  primaryStorage: string;
  storageLocations: string[];
  recipeReferences: Array<{ id: string; title: string }>;
  latestPurchaseDate: string | null;
  latestUpdatedAt: string;
};

export type StorageGroupViewModel = {
  key: string;
  label: string;
  items: IngredientSummaryViewModel[];
  totalBatches: number;
  alertCount: number;
};

export type InventoryCardTone = 'stable' | 'warning' | 'danger' | 'empty';

export type InventoryCardStatusViewModel = {
  label: '平稳' | '库存偏低' | '临期或过期' | '已空或未登记';
  tone: InventoryCardTone;
  detail: string;
  priority: number;
};

export type InventoryCardExpiryTone = 'neutral' | 'warning' | 'danger';

export type InventoryCardPresentationViewModel = {
  headline: string;
  secondary: string;
  footerNote: string;
  hasExpiryInfo: boolean;
  expiryLabel: string | null;
  expiryDateLabel: string | null;
  expiryTone: InventoryCardExpiryTone | null;
};

export type DisposableExpiredInventoryItemViewModel = {
  id: string;
  ingredientId: string;
  ingredientName: string;
  remainingQuantity: number;
  remainingLabel: string;
  unit: string;
  purchaseDate: string;
  expiryDate: string;
  storageLocation: string;
  notes: string;
  status: InventoryItem['status'];
  createdAt: string;
};

export type InventoryStorageOverviewTone = 'stable' | 'warning' | 'danger' | 'muted';

export type InventoryStorageOverviewViewModel = {
  key: string;
  label: string;
  ingredientCount: number;
  totalBatches: number;
  alertCount: number;
  tone: InventoryStorageOverviewTone;
  statusLabel: string;
};

export type InventoryBatchItemViewModel = {
  id: string;
  ingredientId: string;
  ingredientName: string;
  ingredientImageUrl?: string;
  quantityLabel: string;
  status: InventoryItem['status'];
  purchaseDate: string;
  expiryDate?: string | null;
  storageLocation: string;
  notes: string;
  alerts: IngredientAlertViewModel[];
};

export type InventoryBatchGroupViewModel = {
  key: string;
  label: string;
  items: InventoryBatchItemViewModel[];
};

export type IngredientCategoryPreset = {
  label: string;
  defaultUnit: string;
  defaultStorage: string;
  quantityTrackingMode?: Ingredient['quantity_tracking_mode'];
  icon: string;
};

export type ShoppingCardFocus = 'all' | 'attention' | 'linked' | 'freeform';
export type ShoppingCardTone = 'attention' | 'linked' | 'freeform';
export type ShoppingCardStatusTone = 'stable' | 'warning' | 'danger' | 'muted';
export type ShoppingOverviewTone = 'stable' | 'warning' | 'linked' | 'freeform' | 'muted';

export type ShoppingCardViewModel = {
  shoppingItem: ShoppingListItem;
  linkedSummary: IngredientSummaryViewModel | null;
  title: string;
  headline: string;
  quantityLabel: string;
  subline: string;
  contextTags: string[];
  reasonLabel: string;
  contextLine: string;
  inventoryLabel: string;
  inventoryNote: string;
  footerNote: string;
  statusLabel: string;
  statusTone: ShoppingCardStatusTone;
  sourceLabel: '档案关联' | '自由项';
  tone: ShoppingCardTone;
  isLinked: boolean;
  hasAttention: boolean;
  updatedAt: string;
  searchText: string;
};

export type ShoppingOverviewViewModel = {
  key: ShoppingCardFocus;
  label: string;
  count: number;
  tone: ShoppingOverviewTone;
  detail: string;
};

export type SeasoningStatus = 'stocked' | 'needsRestock' | 'unconfigured';

export type SeasoningSummaryViewModel = {
  summary: IngredientSummaryViewModel;
  status: SeasoningStatus;
  statusLabel: '已有' | '需补充' | '未配置';
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
const SEASONING_CATEGORY_LABELS = new Set(['调料', '调味料', '酱料']);

export const INGREDIENT_CATEGORY_PRESETS: IngredientCategoryPreset[] = [
  { label: '蔬菜', defaultUnit: '个', defaultStorage: '冷藏', icon: 'vegetable' },
  { label: '水果', defaultUnit: '个', defaultStorage: '常温', icon: 'fruit' },
  { label: '肉类', defaultUnit: '份', defaultStorage: '冷冻', icon: 'meat' },
  { label: '水产', defaultUnit: '块', defaultStorage: '冷冻', icon: 'fish' },
  { label: '蛋奶', defaultUnit: '个', defaultStorage: '冷藏', icon: 'egg' },
  { label: '豆制品', defaultUnit: '盒', defaultStorage: '冷藏', icon: 'tofu' },
  { label: '菌菇', defaultUnit: '盒', defaultStorage: '冷藏', icon: 'mushroom' },
  { label: '主食', defaultUnit: '份', defaultStorage: '常温', icon: 'staple' },
  { label: '干货', defaultUnit: '袋', defaultStorage: '常温', icon: 'dryGoods' },
  { label: '坚果果干', defaultUnit: '袋', defaultStorage: '常温', icon: 'nuts' },
  { label: '烘焙原料', defaultUnit: '袋', defaultStorage: '常温', icon: 'baking' },
  { label: '调料', defaultUnit: '瓶', defaultStorage: '常温', quantityTrackingMode: 'not_track_quantity', icon: 'seasoning' },
  { label: '调味料', defaultUnit: '瓶', defaultStorage: '常温', icon: 'seasoning' },
  { label: '酱料', defaultUnit: '瓶', defaultStorage: '常温', icon: 'seasoning' },
  { label: '罐头腌菜', defaultUnit: '罐', defaultStorage: '常温', icon: 'canned' },
  { label: '熟食', defaultUnit: '份', defaultStorage: '冷藏', icon: 'prepared' },
  { label: '速冻食品', defaultUnit: '袋', defaultStorage: '冷冻', icon: 'frozen' },
  { label: '零食饮品', defaultUnit: '包', defaultStorage: '常温', icon: 'snack' },
  { label: '其他', defaultUnit: '份', defaultStorage: '常温', icon: 'more' },
];

const INGREDIENT_EDITOR_CATEGORY_PRESET_LABELS = [
  '蔬菜',
  '水果',
  '肉类',
  '水产',
  '蛋奶',
  '豆制品',
  '主食',
  '干货',
  '调料',
  '其他',
];

const INGREDIENT_CATEGORY_PRESET_MAP = new Map(
  INGREDIENT_CATEGORY_PRESETS.map((item) => [item.label, item] satisfies [string, IngredientCategoryPreset])
);

function normalizeCategoryLabel(value: string) {
  return value.trim() || '未分类';
}

export function isSeasoningIngredient(ingredient: Pick<Ingredient, 'category' | 'quantity_tracking_mode'>) {
  return !tracksIngredientQuantity(ingredient) || SEASONING_CATEGORY_LABELS.has(normalizeCategoryLabel(ingredient.category));
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

function buildSummaryQuantityLabel(summary: IngredientSummaryViewModel) {
  if (!tracksIngredientQuantity(summary.ingredient)) {
    return summary.availableInventoryItems.length > 0 ? '已有' : summary.inventoryItems.length > 0 ? '需补充' : '未配置';
  }
  if (summary.quantitySummaries.length > 0) {
    return summary.quantitySummaries
      .slice(0, 2)
      .map((item) => item.label)
      .join(' · ');
  }
  if (summary.inventoryItems.length > 0) {
    return '当前已空';
  }
  return '未登记库存';
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

function isPresenceInventory(item: InventoryItem) {
  return item.quantity - (item.disposed_quantity ?? 0) > 0;
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
  today = todayKey()
) {
  const alerts: IngredientAlertViewModel[] = [];
  const todayTime = new Date(today).getTime();

  for (const ingredient of ingredients) {
    if (!tracksIngredientQuantity(ingredient)) {
      continue;
    }
    if (ingredient.default_low_stock_threshold === null || ingredient.default_low_stock_threshold === undefined) {
      continue;
    }
    const availableQuantity = getIngredientAvailableQuantityInDefault(
      ingredient,
      inventoryItems.filter((item) => item.ingredient_id === ingredient.id && isRemainingInventory(item)),
      { excludeExpiredAt: today }
    );

    if (availableQuantity <= ingredient.default_low_stock_threshold) {
      alerts.push({
        id: `${ingredient.id}-low`,
        ingredientId: ingredient.id,
        ingredientName: ingredient.name,
        title: `${ingredient.name} 快不够用了`,
        detail: `当前可用 ${formatQuantityValue(availableQuantity)}${ingredient.default_unit}，已经低于默认提醒值 ${ingredient.default_low_stock_threshold}${ingredient.default_unit}。`,
        tone: 'warning',
        kind: 'lowStock',
        storageLocation: ingredient.default_storage,
      });
    }
  }

  for (const item of inventoryItems) {
    if (!isRemainingInventory(item)) {
      continue;
    }
    const ingredient = ingredients.find((entry) => entry.id === item.ingredient_id);
    if (!ingredient) {
      continue;
    }
    if (item.expiry_date) {
      const diffDays = Math.round(
        (new Date(item.expiry_date).getTime() - todayTime) / (1000 * 60 * 60 * 24)
      );
      if (diffDays <= 2) {
        alerts.push({
          id: `${item.id}-expiry`,
          ingredientId: ingredient.id,
          ingredientName: ingredient.name,
          title: `${ingredient.name} ${diffDays < 0 ? '已经过期' : '快到期了'}`,
          detail: `${item.storage_location || ingredient.default_storage} 这批食材${diffDays < 0 ? '已经超过' : '将在'} ${formatDate(item.expiry_date)} ${
            diffDays < 0 ? '到期' : '到期'
          }，建议优先安排。`,
          tone: 'danger',
          kind: 'expiry',
          storageLocation: item.storage_location,
        });
      }
    }
  }

  return alerts;
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
      label: `${Number(total.toFixed(2)).toString().replace(/\.0+$/, '')}${unit}`,
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
  today?: string;
}) {
  const { ingredients, inventoryItems, recipes, today = todayKey() } = args;
  const todayTime = new Date(today).getTime();
  const alerts = buildIngredientAlerts(inventoryItems, ingredients, today);

  return ingredients
    .map<IngredientSummaryViewModel>((ingredient) => {
      const ingredientInventory = inventoryItems
        .filter((item) => item.ingredient_id === ingredient.id)
        .sort((left, right) => right.updated_at.localeCompare(left.updated_at));
      const tracksQuantity = tracksIngredientQuantity(ingredient);
      const availableInventory = tracksQuantity
        ? ingredientInventory.filter((item) => isAvailableInventory(item, todayTime))
        : ingredientInventory.filter((item) => isPresenceInventory(item) && (!item.expiry_date || new Date(item.expiry_date).getTime() >= todayTime));
      const remainingInventory = tracksQuantity
        ? ingredientInventory.filter(isRemainingInventory)
        : ingredientInventory.filter(isPresenceInventory);
      const totalAvailableInDefault = getIngredientAvailableQuantityInDefault(ingredient, availableInventory);
      const quantitySummaries =
        !tracksQuantity && availableInventory.length > 0
          ? [
              {
                unit: '',
                total: availableInventory.length,
                label: '已有',
              },
            ]
          : totalAvailableInDefault > 0
          ? [
              {
                unit: ingredient.default_unit,
                total: totalAvailableInDefault,
                label: `${Number(totalAvailableInDefault.toFixed(2)).toString().replace(/\.0+$/, '')}${ingredient.default_unit}`,
              },
            ]
          : [];
      const storageLocations = uniqueLabels(
        remainingInventory.map((item) => item.storage_location).concat(ingredient.default_storage)
      ).sort(sortByStorage);
      const recipeReferences = recipes
        .filter((recipe) =>
          recipe.ingredient_items.some((item) => item.ingredient_id === ingredient.id)
        )
        .map((recipe) => ({ id: recipe.id, title: recipe.title }));
      const ingredientAlerts = alerts.filter((item) => item.ingredientId === ingredient.id);
      const latestUpdatedAt = maxTimestamp(
        ingredient.updated_at,
        ...ingredientInventory.map((item) => item.updated_at)
      );

      return {
        ingredient,
        inventoryItems: remainingInventory,
        availableInventoryItems: availableInventory,
        alerts: ingredientAlerts.sort(
          (left, right) =>
            Number(right.tone === 'danger') - Number(left.tone === 'danger') ||
            left.title.localeCompare(right.title)
        ),
        quantitySummaries,
        hasMultipleUnits: getIngredientUnitConversions(ingredient).length > 0,
        primaryStorage: pickPrimaryStorage(ingredient, availableInventory.length > 0 ? availableInventory : remainingInventory),
        storageLocations,
        recipeReferences,
        latestPurchaseDate:
          ingredientInventory
            .map((item) => item.purchase_date)
            .sort((left, right) => right.localeCompare(left))[0] ?? null,
        latestUpdatedAt,
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
      detail: summary.alerts[0]?.detail ?? '有临期或过期的批次需要优先处理。',
      priority: 3,
    };
  }

  if (summary.quantitySummaries.length === 0) {
    return {
      label: '已空或未登记',
      tone: 'empty',
      detail:
        summary.inventoryItems.length > 0
          ? '当前可用库存已空，先处理到期批次或补一批新的。'
          : '还没有登记库存，适合先补一批常用量。',
      priority: hasWarningAlert ? 2 : 1,
    };
  }

  if (hasWarningAlert) {
    return {
      label: '库存偏低',
      tone: 'warning',
      detail: summary.alerts[0]?.detail ?? '当前库存偏低，建议尽快补货。',
      priority: 2,
    };
  }

  return {
    label: '平稳',
    tone: 'stable',
    detail: summary.latestPurchaseDate
      ? `最近补货于 ${formatDate(summary.latestPurchaseDate)}，当前库存状态平稳。`
      : '当前库存状态平稳，可以继续按正常节奏使用。',
    priority: 0,
  };
}

function buildInventoryCardSummaryLine(summary: IngredientSummaryViewModel) {
  if (summary.quantitySummaries.length === 0) {
    return '未登记库存';
  }

  return summary.quantitySummaries
    .slice(0, 2)
    .map((item) => item.label)
    .join(' · ');
}

function buildInventoryCardExpiry(summary: IngredientSummaryViewModel, referenceDate: string) {
  const earliestExpiryDate =
    summary.inventoryItems
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
  referenceDate = todayKey()
): DisposableExpiredInventoryItemViewModel[] {
  const referenceTime = new Date(referenceDate).getTime();

  return summary.inventoryItems
    .filter((item) => {
      if (!item.expiry_date) {
        return false;
      }
      if (new Date(item.expiry_date).getTime() >= referenceTime) {
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
        remainingLabel: `${formatQuantityValue(remainingQuantity)}${item.unit}`,
        unit: item.unit,
        purchaseDate: item.purchase_date,
        expiryDate: item.expiry_date!,
        storageLocation: item.storage_location || summary.primaryStorage || summary.ingredient.default_storage || '常温',
        notes: item.notes,
        status: item.status,
        createdAt: item.created_at,
      };
    });
}

export function buildInventoryCardPresentation(
  summary: IngredientSummaryViewModel,
  referenceDate = todayKey()
): InventoryCardPresentationViewModel {
  const status = buildInventoryCardStatus(summary);
  const expiry = buildInventoryCardExpiry(summary, referenceDate);
  const latestRestockLabel = summary.latestPurchaseDate ? formatDate(summary.latestPurchaseDate) : null;
  const hasExpiredInventory = summary.alerts.some((item) => item.kind === 'expiry' && item.tone === 'danger');
  const footerNote =
    hasExpiredInventory
      ? `当前有 ${summary.alerts.length} 条提醒，请先处理过期库存。`
      : summary.alerts.length > 0
        ? `当前有 ${summary.alerts.length} 条提醒，建议优先处理。`
        : status.detail;

  if (summary.quantitySummaries.length > 0) {
    const secondaryParts = latestRestockLabel ? [`最近补货 ${latestRestockLabel}`] : [];
    secondaryParts.push(expiry.hasExpiryInfo ? `最早 ${expiry.expiryDateLabel} 到期` : '未设保质期');

    return {
      headline: buildInventoryCardSummaryLine(summary),
      secondary: secondaryParts.join(' · '),
      footerNote,
      ...expiry,
    };
  }

  if (summary.inventoryItems.length > 0) {
    return {
      headline: '当前已空',
      secondary: latestRestockLabel ? `最近补货 ${latestRestockLabel} · 当前已空` : '当前已空',
      footerNote,
      ...expiry,
    };
  }

  return {
    headline: '未登记',
    secondary: '还没有库存记录，适合先登记首批',
    footerNote,
    ...expiry,
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
          ? '当前位置暂无食材'
          : alertCount > 0
            ? `${alertCount} 条提醒待处理`
            : totalBatches > 0
              ? '库存状态平稳'
              : '优先登记首批',
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
  today?: string;
}) {
  const { ingredients, inventoryItems, today = todayKey() } = args;
  const alerts = buildIngredientAlerts(inventoryItems, ingredients, today);
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
      quantityLabel: `${Number(normalizedBatchQuantity.toFixed(2)).toString().replace(/\.0+$/, '')}${ingredient?.default_unit ?? item.unit}`,
      status: item.status,
      purchaseDate: item.purchase_date,
      expiryDate: item.expiry_date,
      storageLocation: key,
      notes: item.notes,
      alerts: alerts.filter((alert) => alert.id.startsWith(item.id)),
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

export function getIngredientCategoryPreset(category: string) {
  return INGREDIENT_CATEGORY_PRESET_MAP.get(category.trim());
}

export function getIngredientEditorCategoryPresets() {
  return INGREDIENT_EDITOR_CATEGORY_PRESET_LABELS
    .map((label) => INGREDIENT_CATEGORY_PRESET_MAP.get(label))
    .filter((item): item is IngredientCategoryPreset => Boolean(item));
}

export function buildIngredientCategoryFilters(ingredients: Ingredient[]) {
  const existingCategories = uniqueLabels(ingredients.map((item) => normalizeCategoryLabel(item.category)));
  const presetLabels = INGREDIENT_CATEGORY_PRESETS.map((item) => item.label).filter((label) =>
    existingCategories.includes(label)
  );
  const customLabels = existingCategories
    .filter((label) => !INGREDIENT_CATEGORY_PRESET_MAP.has(label))
    .sort((left, right) => left.localeCompare(right, 'zh-CN'));

  return [...presetLabels, ...customLabels];
}

export function filterIngredientSummaries(
  summaries: IngredientSummaryViewModel[],
  term: string,
  categoryFilter = ALL_CATEGORY_FILTER
) {
  const normalized = term.trim();
  return summaries.filter((summary) => {
    const matchesCategory =
      categoryFilter === ALL_CATEGORY_FILTER || normalizeCategoryLabel(summary.ingredient.category) === categoryFilter;
    if (!matchesCategory) {
      return false;
    }
    if (!normalized) {
      return true;
    }
    return (
      summary.ingredient.name.includes(normalized) ||
      summary.ingredient.category.includes(normalized) ||
      summary.ingredient.notes.includes(normalized) ||
      summary.recipeReferences.some((item) => item.title.includes(normalized))
    );
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
  term: string
) {
  const normalized = term.trim();
  if (!normalized) {
    return summaries;
  }

  return summaries.filter((summary) => {
    return (
      summary.ingredient.name.includes(normalized) ||
      summary.ingredient.category.includes(normalized) ||
      summary.ingredient.notes.includes(normalized) ||
      summary.primaryStorage.includes(normalized) ||
      summary.storageLocations.some((location) => location.includes(normalized)) ||
      summary.alerts.some((alert) => alert.title.includes(normalized) || alert.detail.includes(normalized))
    );
  });
}

export function buildShoppingCards(
  shoppingItems: ShoppingListItem[],
  summaries: IngredientSummaryViewModel[],
  options?: { completed?: boolean }
): ShoppingCardViewModel[] {
  const summaryByName = new Map(
    summaries.map((summary) => [summary.ingredient.name.trim(), summary] satisfies [string, IngredientSummaryViewModel])
  );
  const summaryById = new Map(
    summaries.map((summary) => [summary.ingredient.id, summary] satisfies [string, IngredientSummaryViewModel])
  );

  return [...shoppingItems]
    .map((shoppingItem) => {
      const normalizedTitle = shoppingItem.title.trim();
      const linkedSummary =
        (shoppingItem.ingredient_id ? summaryById.get(shoppingItem.ingredient_id) ?? null : null) ??
        summaryByName.get(normalizedTitle) ??
        null;
      const hasAttention = Boolean(linkedSummary && linkedSummary.alerts.length > 0);
      const status = linkedSummary ? buildInventoryCardStatus(linkedSummary) : null;
      const reasonLabel = shoppingItem.reason.trim() || (linkedSummary ? '纳入近期采购计划' : '待补货');
      const inventoryLabel = linkedSummary ? buildSummaryQuantityLabel(linkedSummary) : '未关联档案';
      const inventoryNote = linkedSummary
        ? linkedSummary.alerts.length > 0
          ? linkedSummary.alerts[0]!.title
          : linkedSummary.latestPurchaseDate
            ? `最近补货 ${formatDate(linkedSummary.latestPurchaseDate)}`
            : `常放 ${linkedSummary.primaryStorage || linkedSummary.ingredient.default_storage || '常温'}`
        : '自由采购项，买完后可直接补录入库。';
      const footerNote = linkedSummary
        ? linkedSummary.alerts.length > 0
          ? linkedSummary.alerts[0]!.detail
          : linkedSummary.latestPurchaseDate
            ? `最近补货 ${formatDate(linkedSummary.latestPurchaseDate)}，当前库存 ${inventoryLabel}。`
            : `当前库存 ${inventoryLabel}，默认放在 ${linkedSummary.primaryStorage || linkedSummary.ingredient.default_storage || '常温'}。`
        : shoppingItem.reason.trim()
          ? `采购备注：${shoppingItem.reason.trim()}`
          : '这是一个未关联档案的自由采购项，买完后可以直接补录入库。';
      const contextTags = linkedSummary
        ? [
            linkedSummary.ingredient.category || '未分类',
            linkedSummary.primaryStorage || linkedSummary.ingredient.default_storage || '常温',
            `库存 ${inventoryLabel}`,
          ]
        : ['自由项', '未关联档案', '买完后可补录'];
      const contextLine = linkedSummary
        ? [
            linkedSummary.ingredient.category || '未分类',
            linkedSummary.primaryStorage || linkedSummary.ingredient.default_storage || '常温',
          ].join(' · ')
        : '自由项 · 未关联档案';
      const statusLabel = linkedSummary
        ? linkedSummary.alerts[0]?.title ?? '库存平稳'
        : '暂不读取库存';
      const statusTone: ShoppingCardStatusTone = linkedSummary
        ? linkedSummary.alerts.length > 0
          ? linkedSummary.alerts[0]!.tone
          : 'stable'
        : 'muted';
      const tone: ShoppingCardTone = hasAttention ? 'attention' : linkedSummary ? 'linked' : 'freeform';
      const sourceLabel: ShoppingCardViewModel['sourceLabel'] = linkedSummary ? '档案关联' : '自由项';
      const searchText = [
        shoppingItem.title,
        shoppingItem.reason,
        linkedSummary?.ingredient.name,
        linkedSummary?.ingredient.category,
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
        title: normalizedTitle || shoppingItem.title,
        headline: usesPresenceQuantity
          ? shoppingQuantityLabel
          : `${formatQuantityValue(shoppingItem.quantity)}${shoppingItem.unit}`,
        quantityLabel: usesPresenceQuantity
          ? shoppingQuantityLabel
          : `${formatQuantityValue(shoppingItem.quantity)}${shoppingItem.unit}`,
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
        isLinked: Boolean(linkedSummary),
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

export function buildShoppingOverview(cards: ShoppingCardViewModel[]): ShoppingOverviewViewModel[] {
  const attentionCount = cards.filter((card) => card.hasAttention).length;
  const linkedCount = cards.filter((card) => card.isLinked).length;
  const freeformCount = cards.filter((card) => !card.isLinked).length;

  return [
    {
      key: 'all',
      label: '全部待买',
      count: cards.length,
      tone:
        cards.length === 0 ? 'muted' : attentionCount > 0 ? 'warning' : linkedCount > 0 ? 'linked' : 'freeform',
      detail:
        cards.length === 0
          ? '当前采购清单为空'
          : attentionCount > 0
            ? `${attentionCount} 项需要优先处理`
            : '当前待买项节奏平稳',
    },
    {
      key: 'attention',
      label: '需优先处理',
      count: attentionCount,
      tone: attentionCount > 0 ? 'warning' : 'muted',
      detail: attentionCount > 0 ? '关联食材已有提醒' : '当前没有紧急采购项',
    },
    {
      key: 'linked',
      label: '档案关联',
      count: linkedCount,
      tone: linkedCount > 0 ? 'linked' : 'muted',
      detail: linkedCount > 0 ? '可直接看到库存与提醒' : '当前没有关联档案的待买项',
    },
    {
      key: 'freeform',
      label: '自由项',
      count: freeformCount,
      tone: freeformCount > 0 ? 'freeform' : 'muted',
      detail: freeformCount > 0 ? '临时采购或未建档项目' : '当前没有自由采购项',
    },
  ];
}

export function buildSeasoningSummaries(summaries: IngredientSummaryViewModel[]): SeasoningSummaryViewModel[] {
  return summaries
    .filter((summary) => isSeasoningIngredient(summary.ingredient))
    .map((summary) => {
      const hasAvailable = summary.availableInventoryItems.length > 0 || summary.quantitySummaries.length > 0;
      const status: SeasoningStatus = hasAvailable
        ? 'stocked'
        : summary.inventoryItems.length > 0
          ? 'needsRestock'
          : 'unconfigured';
      const statusLabel: SeasoningSummaryViewModel['statusLabel'] =
        status === 'stocked' ? '已有' : status === 'needsRestock' ? '需补充' : '未配置';
      const detail =
        status === 'stocked'
          ? `常放 ${summary.primaryStorage || summary.ingredient.default_storage || '常温'}`
          : status === 'needsRestock'
            ? '这类常备品需要补充'
            : '还没有登记库存';
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
      detail: '按数量补齐的食材采购项',
      cards: regularCards,
    },
    {
      key: 'seasoning' as const,
      title: '调料常备',
      detail: '只看是否需要补充，不强制精确数量',
      cards: seasoningCards,
    },
  ].filter((group) => group.cards.length > 0);
}

export function filterShoppingCards(
  cards: ShoppingCardViewModel[],
  term: string,
  focus: ShoppingCardFocus = 'all'
) {
  const normalized = term.trim();

  return cards.filter((card) => {
    const matchesFocus =
      focus === 'all' ||
      (focus === 'attention' && card.hasAttention) ||
      (focus === 'linked' && card.isLinked) ||
      (focus === 'freeform' && !card.isLinked);
    if (!matchesFocus) {
      return false;
    }
    if (!normalized) {
      return true;
    }
    return card.searchText.includes(normalized);
  });
}
