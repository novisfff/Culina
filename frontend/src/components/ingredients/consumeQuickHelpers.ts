export type ConsumeQuickPreset = {
  key: string;
  value: number;
  label: string;
  isAll?: boolean;
};

const INTEGER_FRACTION_UNITS = new Set(['个', '份', '盒', '袋', '瓶', '包', '块', '罐', '根', '条', '颗', '枚', '把']);

function roundConsumeValue(value: number) {
  return Number(value.toFixed(2));
}

export function clampConsumeQuantity(value: number, availableQuantity: number) {
  const safeAvailable = Number.isFinite(availableQuantity) ? Math.max(availableQuantity, 0) : Number.POSITIVE_INFINITY;
  const safeValue = Number.isFinite(value) ? value : 0;
  return roundConsumeValue(Math.min(safeAvailable, Math.max(safeValue, 0)));
}

export function resolveConsumeStep(availableQuantity: number) {
  if (availableQuantity >= 1) {
    return 0.25;
  }
  if (availableQuantity >= 0.5) {
    return 0.1;
  }
  if (availableQuantity >= 0.25) {
    return 0.05;
  }
  return 0.01;
}

export function resolveInitialConsumeQuantity(availableQuantity: number) {
  if (availableQuantity <= 0) {
    return 0;
  }
  if (availableQuantity >= 1) {
    return 1;
  }
  if (availableQuantity >= 0.5) {
    return 0.5;
  }
  if (availableQuantity >= 0.25) {
    return 0.25;
  }
  return roundConsumeValue(availableQuantity);
}

export function buildConsumeQuickValues(unit: string, availableQuantity: number): ConsumeQuickPreset[] {
  const usesFractionLabel = INTEGER_FRACTION_UNITS.has(unit.trim());
  const baseValues = usesFractionLabel
    ? [
        { value: 0.25, label: '1/4' },
        { value: 0.5, label: '1/2' },
        { value: 1, label: '1' },
        { value: 2, label: '2' },
      ]
    : [
        { value: 0.25, label: '0.25' },
        { value: 0.5, label: '0.5' },
        { value: 1, label: '1' },
        { value: 2, label: '2' },
      ];

  const presets: ConsumeQuickPreset[] = baseValues
    .filter((item) => item.value <= availableQuantity + 0.0001)
    .map((item) => ({
      key: `preset-${item.label}`,
      value: item.value,
      label: item.label,
    }));

  if (availableQuantity > 0) {
    presets.push({
      key: 'preset-all',
      value: roundConsumeValue(availableQuantity),
      label: '全部',
      isAll: true,
    });
  }

  return presets;
}

export function getConsumeRemainingQuantity(availableQuantity: number, consumedQuantity: number) {
  const safeAvailable = Math.max(availableQuantity, 0);
  return roundConsumeValue(Math.max(safeAvailable - clampConsumeQuantity(consumedQuantity, safeAvailable), 0));
}

export function isConsumeAllSelected(consumedQuantity: number, availableQuantity: number) {
  if (availableQuantity <= 0) {
    return false;
  }
  const clampedConsumed = clampConsumeQuantity(consumedQuantity, availableQuantity);
  return clampedConsumed >= roundConsumeValue(Math.max(availableQuantity - resolveConsumeStep(availableQuantity), 0));
}
