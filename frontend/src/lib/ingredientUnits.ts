import type { Ingredient, IngredientUnitConversion, InventoryItem } from '../api/types';

export function normalizeIngredientUnit(value?: string | null) {
  return (value ?? '').trim();
}

export function getIngredientUnitConversions(
  ingredient?: Pick<Ingredient, 'default_unit' | 'unit_conversions'> | null
): IngredientUnitConversion[] {
  const defaultUnit = normalizeIngredientUnit(ingredient?.default_unit);
  const seen = new Set(defaultUnit ? [defaultUnit] : []);
  const normalized: IngredientUnitConversion[] = [];

  for (const entry of ingredient?.unit_conversions ?? []) {
    const unit = normalizeIngredientUnit(entry.unit);
    const ratio = Number(entry.ratio_to_default);
    if (!unit || seen.has(unit) || !Number.isFinite(ratio) || ratio <= 0) {
      continue;
    }
    seen.add(unit);
    normalized.push({ unit, ratio_to_default: ratio });
  }

  return normalized;
}

export function getIngredientUnitOptions(
  ingredient?: Pick<Ingredient, 'default_unit' | 'unit_conversions'> | null
) {
  const defaultUnit = normalizeIngredientUnit(ingredient?.default_unit);
  const options: IngredientUnitConversion[] = defaultUnit
    ? [{ unit: defaultUnit, ratio_to_default: 1 }]
    : [];
  return options.concat(getIngredientUnitConversions(ingredient));
}

export function resolveIngredientUnitRatio(
  ingredient: Pick<Ingredient, 'default_unit' | 'unit_conversions'> | null | undefined,
  unit: string
) {
  const normalizedUnit = normalizeIngredientUnit(unit);
  const defaultUnit = normalizeIngredientUnit(ingredient?.default_unit);
  if (!normalizedUnit || !defaultUnit) {
    return null;
  }
  if (normalizedUnit === defaultUnit) {
    return 1;
  }
  return getIngredientUnitConversions(ingredient).find((entry) => entry.unit === normalizedUnit)?.ratio_to_default ?? null;
}

export function resolvePreferredIngredientUnit(
  ingredient: Pick<Ingredient, 'default_unit' | 'unit_conversions'> | null | undefined,
  preferredUnit?: string | null
) {
  const requested = normalizeIngredientUnit(preferredUnit);
  if (!ingredient) {
    return requested;
  }
  if (requested && resolveIngredientUnitRatio(ingredient, requested) !== null) {
    return requested;
  }
  return normalizeIngredientUnit(ingredient.default_unit) || requested;
}

export function convertQuantityToDefaultUnit(
  ingredient: Pick<Ingredient, 'default_unit' | 'unit_conversions'> | null | undefined,
  quantity: number,
  unit: string
) {
  const ratio = resolveIngredientUnitRatio(ingredient, unit);
  if (ratio === null || !Number.isFinite(quantity)) {
    return null;
  }
  return Number((quantity * ratio).toFixed(2));
}

export function convertQuantityFromDefaultUnit(
  ingredient: Pick<Ingredient, 'default_unit' | 'unit_conversions'> | null | undefined,
  quantity: number,
  unit: string
) {
  const ratio = resolveIngredientUnitRatio(ingredient, unit);
  if (ratio === null || !Number.isFinite(quantity) || ratio === 0) {
    return null;
  }
  return Number((quantity / ratio).toFixed(2));
}

export function getInventoryRemainingQuantity(item: Pick<InventoryItem, 'quantity' | 'remaining_quantity'>) {
  return Math.max(item.remaining_quantity ?? item.quantity, 0);
}

export function getInventoryConsumedQuantity(
  item: Pick<InventoryItem, 'quantity' | 'consumed_quantity' | 'remaining_quantity'>
) {
  if (item.consumed_quantity !== null && item.consumed_quantity !== undefined) {
    return Math.max(item.consumed_quantity, 0);
  }
  return Math.max(item.quantity - getInventoryRemainingQuantity(item), 0);
}

export function convertInventoryQuantityToDefault(
  ingredient: Pick<Ingredient, 'default_unit' | 'unit_conversions'> | null | undefined,
  item: Pick<InventoryItem, 'quantity' | 'unit'>
) {
  return convertQuantityToDefaultUnit(ingredient, item.quantity, item.unit);
}

export function convertInventoryRemainingToDefault(
  ingredient: Pick<Ingredient, 'default_unit' | 'unit_conversions'> | null | undefined,
  item: Pick<InventoryItem, 'quantity' | 'remaining_quantity' | 'unit'>
) {
  return convertQuantityToDefaultUnit(ingredient, getInventoryRemainingQuantity(item), item.unit);
}

export function getIngredientAvailableQuantityInDefault(
  ingredient: Pick<Ingredient, 'default_unit' | 'unit_conversions'> | null | undefined,
  inventoryItems: Array<Pick<InventoryItem, 'quantity' | 'remaining_quantity' | 'unit' | 'expiry_date'>>,
  options?: { excludeExpiredAt?: string }
) {
  const thresholdTime = options?.excludeExpiredAt ? new Date(options.excludeExpiredAt).getTime() : null;
  return Number(
    inventoryItems
      .filter((item) => {
        if (thresholdTime === null || !item.expiry_date) {
          return true;
        }
        return new Date(item.expiry_date).getTime() >= thresholdTime;
      })
      .reduce((total, item) => {
        const nextValue = convertInventoryRemainingToDefault(ingredient, item);
        return total + (nextValue ?? 0);
      }, 0)
      .toFixed(2)
  );
}
