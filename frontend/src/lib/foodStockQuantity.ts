const FOOD_STOCK_QUANTITY_PATTERN = /^\d+(?:\.\d)?$/;

export function normalizeFoodStockQuantity(value: number) {
  return Math.floor((value + Number.EPSILON) * 10) / 10;
}

export function formatFoodStockNumber(value: number) {
  return String(Number(normalizeFoodStockQuantity(value).toFixed(1)));
}

export function formatFoodStockAmount(value: number | null | undefined, unit: string, fallback = '未记录') {
  if (value === null || value === undefined) return fallback;
  if (!Number.isFinite(value)) return fallback;
  return `${formatFoodStockNumber(value)}${unit || '份'}`;
}

export function parseFoodStockQuantity(
  value: string,
  fieldLabel = '数量'
): { quantity: number | null; error: string | null } {
  const trimmed = value.trim();
  if (!trimmed) {
    return { quantity: null, error: `请输入大于 0 的${fieldLabel}。` };
  }
  const quantity = Number(trimmed);
  if (!Number.isFinite(quantity) || quantity <= 0) {
    return { quantity: null, error: `请输入大于 0 的${fieldLabel}。` };
  }
  if (!FOOD_STOCK_QUANTITY_PATTERN.test(trimmed)) {
    return { quantity: null, error: `${fieldLabel}最多保留 1 位小数。` };
  }
  return { quantity, error: null };
}

export function parseOptionalFoodStockQuantity(
  value: string,
  fieldLabel = '数量'
): { quantity: number | null; error: string | null } {
  const trimmed = value.trim();
  if (!trimmed) {
    return { quantity: null, error: null };
  }
  const quantity = Number(trimmed);
  if (!Number.isFinite(quantity) || quantity < 0) {
    return { quantity: null, error: `${fieldLabel}不能为负数。` };
  }
  if (!FOOD_STOCK_QUANTITY_PATTERN.test(trimmed)) {
    return { quantity: null, error: `${fieldLabel}最多保留 1 位小数。` };
  }
  return { quantity, error: null };
}

export function resolveFoodStockDeductQuantity(
  requestedQuantity: number,
  availableQuantity: number | null | undefined,
  unit: string
): { quantity: number | null; error: string | null } {
  if (availableQuantity === null || availableQuantity === undefined || availableQuantity <= 0) {
    return { quantity: null, error: '当前没有可减扣的库存。' };
  }
  const displayAvailable = normalizeFoodStockQuantity(availableQuantity);
  if (displayAvailable <= 0) {
    return { quantity: null, error: '当前没有可减扣的库存。' };
  }
  if (requestedQuantity <= displayAvailable) {
    return { quantity: requestedQuantity, error: null };
  }
  return {
    quantity: null,
    error: `当前最多只能减扣 ${formatFoodStockAmount(displayAvailable, unit)}。`,
  };
}
