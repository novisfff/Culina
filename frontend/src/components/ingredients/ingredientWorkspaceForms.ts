import type {
  ImageInputValue,
  Food,
  Ingredient,
  IngredientExpiryMode,
  IngredientQuantityTrackingMode,
  IngredientUnitConversion,
  InventoryItem,
  InventoryStatus,
  ShoppingListItem,
} from '../../api/types';
import { addDateKeyDays } from '../../lib/date';
import { emptyImages, todayKey } from '../../lib/ui';
import {
  convertQuantityFromDefaultUnit,
  getIngredientAvailableQuantityInDefault,
  getIngredientUnitOptions,
  normalizeIngredientUnit,
  resolvePreferredIngredientUnit,
} from '../../lib/ingredientUnits';

export type IngredientUnitConversionDraft = {
  id: string;
  unit: string;
  ratioToDefault: string;
};

export type IngredientCreateFormState = {
  name: string;
  category: string;
  defaultUnit: string;
  quantityTrackingMode: IngredientQuantityTrackingMode;
  unitConversions: IngredientUnitConversionDraft[];
  defaultStorage: string;
  defaultExpiryMode: IngredientExpiryMode;
  defaultExpiryDays: string;
  defaultLowStockThreshold: string;
  notes: string;
  images: ImageInputValue;
};

export type InventoryPurchasePreset = 'today' | 'yesterday' | 'custom';
export type InventoryStorageFocus = 'all' | '冷藏' | '冷冻' | '常温';
export type InventorySortMode = 'default' | 'expiry';

export type InventoryDrawerFormState = {
  ingredientId: string;
  ingredientQuery: string;
  ingredientLocked: boolean;
  quantity: string;
  unit: string;
  status: InventoryStatus;
  statusDirty: boolean;
  purchaseDate: string;
  purchaseDatePreset: InventoryPurchasePreset;
  expiryInputMode: IngredientExpiryMode;
  expiryDays: string;
  expiryDate: string;
  storageLocation: string;
  notes: string;
};

export type ShoppingTargetType = 'ingredient' | 'food' | 'free_text';

export type ShoppingDialogFormState = {
  targetType: ShoppingTargetType;
  ingredientId: string;
  foodId: string;
  title: string;
  quantity: string;
  unit: string;
  reason: string;
};

export type ConsumeDialogFormState = {
  ingredientId: string;
  unit: string;
  quantity: string;
};

export type ConsumeUnitOption = {
  unit: string;
  available: number;
  ratioToDefault: number;
};

export const INVENTORY_STORAGE_PRESETS = ['冷藏', '冷冻', '常温'] as const;

const COMMON_UNIT_PRESETS = ['个', '份', '盒', '袋', '瓶', '包', '块', '罐', '根', '条', '颗', '枚', '把', 'ml', 'g', 'kg'] as const;
const INTEGER_STEP_UNITS = new Set(['个', '份', '盒', '袋', '瓶', '包', '块', '罐', '根', '条', '颗', '枚', '把']);

let ingredientUnitConversionDraftCounter = 0;

export function defaultIngredientForm(): IngredientCreateFormState {
  return {
    name: '',
    category: '',
    defaultUnit: '个',
    quantityTrackingMode: 'track_quantity',
    unitConversions: [],
    defaultStorage: '冷藏',
    defaultExpiryMode: 'none',
    defaultExpiryDays: '',
    defaultLowStockThreshold: '',
    notes: '',
    images: emptyImages(),
  };
}

export function buildIngredientForm(ingredient?: Ingredient | null): IngredientCreateFormState {
  if (!ingredient) {
    return defaultIngredientForm();
  }
  const defaultExpiryMode =
    ingredient.default_expiry_mode === 'days' ||
    ingredient.default_expiry_mode === 'manual_date' ||
    ingredient.default_expiry_mode === 'none'
      ? ingredient.default_expiry_mode
      : 'none';
  return {
    name: ingredient.name,
    category: ingredient.category,
    defaultUnit: ingredient.default_unit,
    quantityTrackingMode: ingredient.quantity_tracking_mode ?? 'track_quantity',
    unitConversions: buildIngredientUnitConversionDrafts(ingredient.unit_conversions),
    defaultStorage: ingredient.default_storage,
    defaultExpiryMode,
    defaultExpiryDays:
      ingredient.default_expiry_days === null || ingredient.default_expiry_days === undefined
        ? ''
        : String(clampNumber(ingredient.default_expiry_days, 1, 30)),
    defaultLowStockThreshold:
      ingredient.default_low_stock_threshold === null || ingredient.default_low_stock_threshold === undefined
        ? ''
        : String(ingredient.default_low_stock_threshold),
    notes: ingredient.notes,
    images: ingredient.image ? { generatedAsset: ingredient.image } : emptyImages(),
  };
}

export function buildInventoryForm(
  ingredients: Ingredient[],
  ingredientId?: string,
  overrides: Partial<InventoryDrawerFormState> = {}
): InventoryDrawerFormState {
  const selectedIngredient = ingredientId ? ingredients.find((item) => item.id === ingredientId) : undefined;
  const purchaseDate = overrides.purchaseDate ?? todayKey();
  const storageLocation = selectedIngredient?.default_storage ?? '冷藏';
  const expiryInputMode = overrides.expiryInputMode ?? selectedIngredient?.default_expiry_mode ?? 'none';
  const expiryDays =
    overrides.expiryDays ??
    (expiryInputMode === 'days' &&
    selectedIngredient?.default_expiry_days !== null &&
    selectedIngredient?.default_expiry_days !== undefined
      ? String(clampNumber(selectedIngredient.default_expiry_days, 1, 30))
      : '');
  const expiryDate =
    overrides.expiryDate ??
    (expiryInputMode === 'days' ? resolveExpiryDateFromDays(purchaseDate, expiryDays) : '');

  return {
    ingredientId: selectedIngredient?.id ?? '',
    ingredientQuery: selectedIngredient?.name ?? '',
    ingredientLocked: false,
    quantity: '1',
    unit: resolvePreferredIngredientUnit(selectedIngredient, overrides.unit) || selectedIngredient?.default_unit || '个',
    status: resolveInventoryStatusForStorage(storageLocation),
    statusDirty: false,
    purchaseDate,
    purchaseDatePreset: resolveInventoryPurchasePreset(purchaseDate),
    expiryInputMode,
    expiryDays,
    expiryDate,
    storageLocation,
    notes: '',
    ...overrides,
  };
}

export function buildShoppingForm(ingredient?: Ingredient, reason = '', food?: Food): ShoppingDialogFormState {
  return {
    targetType: food ? 'food' : ingredient ? 'ingredient' : 'free_text',
    ingredientId: ingredient?.id ?? '',
    foodId: food?.id ?? '',
    title: food?.name ?? ingredient?.name ?? '',
    quantity: '1',
    unit: food
      ? food.stock_unit || '份'
      : ingredient
        ? resolvePreferredIngredientUnit(ingredient, ingredient?.default_unit) || '个'
        : '份',
    reason: reason || (food ? '补充成品库存' : ''),
  };
}

export function resolveShoppingTargetType(item: Pick<ShoppingListItem, 'target_type' | 'ingredient_id' | 'food_id'>): ShoppingTargetType {
  if (item.target_type === 'food' || item.food_id) {
    return 'food';
  }
  if (item.target_type === 'ingredient' || item.ingredient_id) {
    return 'ingredient';
  }
  if (item.target_type === 'free_text') {
    return 'free_text';
  }
  // Never infer Ingredient merely because food_id is null.
  return item.ingredient_id ? 'ingredient' : 'free_text';
}

export function buildShoppingFormFromItem(
  item: ShoppingListItem,
  ingredient?: Ingredient | null,
  food?: Food | null
): ShoppingDialogFormState {
  const targetType = resolveShoppingTargetType(item);
  return {
    targetType,
    ingredientId: item.ingredient_id ?? ingredient?.id ?? '',
    foodId: item.food_id ?? food?.id ?? '',
    title: item.title,
    quantity: formatNumericString(item.quantity),
    unit:
      targetType === 'food'
        ? item.unit || food?.stock_unit || '份'
        : targetType === 'ingredient'
          ? resolvePreferredIngredientUnit(ingredient ?? undefined, item.unit) || item.unit || ingredient?.default_unit || '个'
          : item.unit || '份',
    reason: item.reason,
  };
}

export function defaultConsumeForm(): ConsumeDialogFormState {
  return {
    ingredientId: '',
    unit: '',
    quantity: '',
  };
}

export function createIngredientUnitConversionDraft(
  entry?: Partial<Pick<IngredientUnitConversion, 'unit' | 'ratio_to_default'>>
): IngredientUnitConversionDraft {
  ingredientUnitConversionDraftCounter += 1;
  return {
    id: `ingredient-unit-conversion-${ingredientUnitConversionDraftCounter}`,
    unit: entry?.unit ?? '',
    ratioToDefault:
      entry?.ratio_to_default === null || entry?.ratio_to_default === undefined ? '' : String(entry.ratio_to_default),
  };
}

export function buildIngredientUnitConversionDrafts(entries: IngredientUnitConversion[] = []) {
  return entries.map((entry) => createIngredientUnitConversionDraft(entry));
}

export function resolveInventoryStatusForStorage(storageLocation: string): InventoryStatus {
  return storageLocation.trim() === '冷冻' ? 'frozen' : 'fresh';
}

export function resolveExpiryDateFromDays(purchaseDate: string, expiryDays: string) {
  const safeDays = Number(expiryDays);
  if (!purchaseDate || !Number.isFinite(safeDays) || safeDays <= 0) {
    return '';
  }
  return addDateKeyDays(purchaseDate, safeDays);
}

export function parseOptionalNumber(value: string) {
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }
  const numeric = Number(trimmed);
  return Number.isFinite(numeric) ? numeric : null;
}

export function parsePositiveNumber(value: string) {
  const numeric = parseOptionalNumber(value);
  return numeric !== null && numeric > 0 ? numeric : null;
}

export function clampNumber(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

export function formatNumericString(value: number) {
  return String(Number(value.toFixed(2)));
}

export function buildUnitPresetOptions(preferred?: string) {
  const normalizedPreferred = normalizeIngredientUnit(preferred);
  return [...new Set([normalizedPreferred, ...COMMON_UNIT_PRESETS].map((item) => item?.trim() ?? '').filter(Boolean))];
}

export function isCustomChoiceValue(value: string, presets: readonly string[]) {
  const normalized = value.trim();
  return !normalized || !presets.includes(normalized);
}

export function resolveTouchStep(unit: string) {
  return INTEGER_STEP_UNITS.has(unit.trim()) ? 1 : 0.5;
}

export function resolveTouchQuickValues(unit: string, mode: 'quantity' | 'threshold') {
  const usesIntegerStep = INTEGER_STEP_UNITS.has(unit.trim());
  if (mode === 'quantity') {
    return usesIntegerStep ? [1, 2, 3, 5, 8] : [0.5, 1, 1.5, 2, 3];
  }
  return usesIntegerStep ? [1, 2, 3, 5] : [0.5, 1, 1.5, 2];
}

export function resolveTouchDefaultValue(unit: string, mode: 'quantity' | 'threshold') {
  return resolveTouchQuickValues(unit, mode)[0] ?? resolveTouchStep(unit);
}

export function buildConsumeUnitOptions(
  ingredient: Pick<Ingredient, 'default_unit' | 'unit_conversions'> | null | undefined,
  inventoryItems: InventoryItem[],
  preferredUnit?: string
): ConsumeUnitOption[] {
  const totalAvailableInDefault = getIngredientAvailableQuantityInDefault(ingredient, inventoryItems);
  const options = getIngredientUnitOptions(ingredient).map((entry) => ({
    unit: entry.unit,
    ratioToDefault: entry.ratio_to_default,
    available:
      convertQuantityFromDefaultUnit(ingredient, totalAvailableInDefault, entry.unit) ?? totalAvailableInDefault,
  }));

  return options
    .filter((entry) => entry.available > 0)
    .sort((left, right) => {
      if (preferredUnit && left.unit === preferredUnit && right.unit !== preferredUnit) {
        return -1;
      }
      if (preferredUnit && right.unit === preferredUnit && left.unit !== preferredUnit) {
        return 1;
      }
      return left.ratioToDefault - right.ratioToDefault || left.unit.localeCompare(right.unit, 'zh-CN');
    });
}

export function resolveClampedDaysValue(value: string, fallback = 3) {
  const parsed = parsePositiveNumber(value);
  return clampNumber(parsed ?? fallback, 1, 30);
}

export function resolveInventoryPurchasePreset(purchaseDate: string): InventoryPurchasePreset {
  if (purchaseDate === todayKey()) {
    return 'today';
  }
  if (purchaseDate === addDateKeyDays(todayKey(), -1)) {
    return 'yesterday';
  }
  return 'custom';
}

function isMediaAssetLike(
  value: unknown
): value is NonNullable<ImageInputValue['referenceAsset']> | NonNullable<ImageInputValue['generatedAsset']> {
  return Boolean(
    value &&
      typeof value === 'object' &&
      'id' in value &&
      typeof (value as { id?: unknown }).id === 'string' &&
      'url' in value &&
      typeof (value as { url?: unknown }).url === 'string'
  );
}

export function restoreIngredientForm(raw: unknown): IngredientCreateFormState {
  const fallback = defaultIngredientForm();
  if (!raw || typeof raw !== 'object') {
    return fallback;
  }
  const candidate = raw as Partial<IngredientCreateFormState>;
  const candidateImages =
    candidate.images && typeof candidate.images === 'object'
      ? {
          referenceAsset: isMediaAssetLike(candidate.images.referenceAsset) ? candidate.images.referenceAsset : undefined,
          generatedAsset: isMediaAssetLike(candidate.images.generatedAsset) ? candidate.images.generatedAsset : undefined,
        }
      : fallback.images;
  const candidateUnitConversions = Array.isArray(candidate.unitConversions)
    ? candidate.unitConversions.flatMap((entry) => {
        if (!entry || typeof entry !== 'object') {
          return [];
        }
        const unit = typeof entry.unit === 'string' ? entry.unit : '';
        const ratioToDefault =
          typeof entry.ratioToDefault === 'string'
            ? entry.ratioToDefault
            : typeof entry.ratioToDefault === 'number'
              ? String(entry.ratioToDefault)
              : '';
        return [createIngredientUnitConversionDraft({ unit, ratio_to_default: parseOptionalNumber(ratioToDefault) ?? undefined })];
      })
    : fallback.unitConversions;

  return {
    name: typeof candidate.name === 'string' ? candidate.name : fallback.name,
    category: typeof candidate.category === 'string' ? candidate.category : fallback.category,
    defaultUnit: typeof candidate.defaultUnit === 'string' ? candidate.defaultUnit : fallback.defaultUnit,
    quantityTrackingMode:
      candidate.quantityTrackingMode === 'track_quantity' || candidate.quantityTrackingMode === 'not_track_quantity'
        ? candidate.quantityTrackingMode
        : fallback.quantityTrackingMode,
    unitConversions: candidateUnitConversions,
    defaultStorage: typeof candidate.defaultStorage === 'string' ? candidate.defaultStorage : fallback.defaultStorage,
    defaultExpiryMode:
      candidate.defaultExpiryMode === 'days' ||
      candidate.defaultExpiryMode === 'manual_date' ||
      candidate.defaultExpiryMode === 'none'
        ? candidate.defaultExpiryMode
        : fallback.defaultExpiryMode,
    defaultExpiryDays:
      typeof candidate.defaultExpiryDays === 'string' ? candidate.defaultExpiryDays : fallback.defaultExpiryDays,
    defaultLowStockThreshold:
      typeof candidate.defaultLowStockThreshold === 'string'
        ? candidate.defaultLowStockThreshold
        : fallback.defaultLowStockThreshold,
    notes: typeof candidate.notes === 'string' ? candidate.notes : fallback.notes,
    images: candidateImages,
  };
}

export function sanitizeIngredientUnitConversions(
  defaultUnit: string,
  unitConversions: IngredientUnitConversionDraft[]
): IngredientUnitConversion[] {
  const normalizedDefaultUnit = normalizeIngredientUnit(defaultUnit);
  const seenUnits = new Set(normalizedDefaultUnit ? [normalizedDefaultUnit] : []);
  const normalizedEntries: IngredientUnitConversion[] = [];

  for (const entry of unitConversions) {
    const unit = normalizeIngredientUnit(entry.unit);
    const ratio = parsePositiveNumber(entry.ratioToDefault);
    const isEmptyEntry = !unit && !entry.ratioToDefault.trim();
    if (isEmptyEntry) {
      continue;
    }
    if (!unit) {
      throw new Error('请先填写副单位名称。');
    }
    if (ratio === null) {
      throw new Error(`请确认 ${unit} 对主单位的换算值。`);
    }
    if (seenUnits.has(unit)) {
      throw new Error(`单位 ${unit} 已重复，副单位不能与主单位或其他单位重复。`);
    }
    seenUnits.add(unit);
    normalizedEntries.push({
      unit,
      ratio_to_default: ratio,
    });
  }

  return normalizedEntries;
}
