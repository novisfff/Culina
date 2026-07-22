import { asDraftArray, asText, isDraftRecord, type DraftRecord } from './aiDraftValueUtils';

export type InventoryIntakeSourceKind = 'shopping_item' | 'direct';
export type InventoryIntakeAction = 'stock_and_fulfill' | 'fulfill_without_stock' | 'stock_only' | 'skip';
export type InventoryIntakeTargetKind = 'exact_ingredient' | 'presence_ingredient' | 'food' | 'none';
export type InventoryIntakeDateSource = 'user' | 'receipt' | 'family_business_date' | string;

export type InventoryIntakePackageConversion = {
  ratio: string | number | null;
  targetUnit: string;
  evidence: string;
  [key: string]: unknown;
};

export type InventoryIntakeDraftItem = {
  lineId: string;
  sourceLineId: string;
  sourceText: string;
  sourceKind: InventoryIntakeSourceKind | '';
  action: InventoryIntakeAction | '';
  shoppingItemId: string | null;
  expectedShoppingItemRowVersion: number | null;
  title: string;
  targetKind: InventoryIntakeTargetKind | '';
  targetId: string | null;
  expectedIngredientRowVersion: number | null;
  expectedFoodRowVersion: number | null;
  stateId: string | null;
  expectedStateRowVersion: number | null;
  plannedQuantity: string | number | null;
  plannedUnit: string | null;
  enteredQuantity: string | number | null;
  enteredUnit: string | null;
  packageConversion: InventoryIntakePackageConversion | null;
  storageLocation: string | null;
  expiryDate: string | null;
  inventoryStatus: string | null;
  resultingAvailabilityLevel: string | null;
  notes: string;
  before: Record<string, unknown>;
  [key: string]: unknown;
};

export type InventoryIntakeIgnoredItem = {
  sourceLineId: string;
  sourceText: string;
  displayName: string;
  reasonCode: string;
  reason: string;
  [key: string]: unknown;
};

export type InventoryIntakeDraft = {
  draftType: 'inventory_intake' | '';
  schemaVersion: 'inventory_intake.v1' | '';
  clientRequestId: string;
  sourceType: string;
  sourceReference: Record<string, unknown> | null;
  intakeDate: string;
  intakeDateSource: InventoryIntakeDateSource;
  items: InventoryIntakeDraftItem[];
  ignoredItems: InventoryIntakeIgnoredItem[];
  summary: Record<string, unknown>;
  [key: string]: unknown;
};

export type InventoryIntakeEditableItemPatch = Partial<Pick<
  InventoryIntakeDraftItem,
  'action' | 'enteredQuantity' | 'enteredUnit' | 'packageConversion' |
  'storageLocation' | 'expiryDate' | 'inventoryStatus' |
  'resultingAvailabilityLevel' | 'notes'
>>;

const SOURCE_KINDS: InventoryIntakeSourceKind[] = ['shopping_item', 'direct'];
const ACTIONS: InventoryIntakeAction[] = ['stock_and_fulfill', 'fulfill_without_stock', 'stock_only', 'skip'];
const TARGET_KINDS: InventoryIntakeTargetKind[] = ['exact_ingredient', 'presence_ingredient', 'food', 'none'];
const PRESENCE_LEVELS = new Set(['present_unknown', 'low', 'sufficient']);

const EDITABLE_ITEM_KEYS = [
  'action',
  'enteredQuantity',
  'enteredUnit',
  'packageConversion',
  'storageLocation',
  'expiryDate',
  'inventoryStatus',
  'resultingAvailabilityLevel',
  'notes',
] as const;

const VALID_ACTIONS_BY_SOURCE: Record<InventoryIntakeSourceKind, InventoryIntakeAction[]> = {
  shopping_item: ['stock_and_fulfill', 'fulfill_without_stock', 'skip'],
  direct: ['stock_only', 'skip'],
};

const ACTION_LABELS: Record<InventoryIntakeAction, string> = {
  stock_and_fulfill: '完成并登记库存',
  fulfill_without_stock: '仅完成采购项，不入库',
  stock_only: '直接入库',
  skip: '跳过本行',
};

function isSourceKind(value: string): value is InventoryIntakeSourceKind {
  return SOURCE_KINDS.includes(value as InventoryIntakeSourceKind);
}

function isAction(value: string): value is InventoryIntakeAction {
  return ACTIONS.includes(value as InventoryIntakeAction);
}

function isTargetKind(value: string): value is InventoryIntakeTargetKind {
  return TARGET_KINDS.includes(value as InventoryIntakeTargetKind);
}

function isIsoDateText(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [yearText, monthText, dayText] = value.split('-');
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const parsed = new Date(year, month - 1, day);
  return parsed.getFullYear() === year && parsed.getMonth() === month - 1 && parsed.getDate() === day;
}

function optionalNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim()) {
    const numeric = Number(value);
    if (Number.isFinite(numeric)) return numeric;
  }
  return null;
}

function quantityText(value: unknown): string {
  if (value === null || value === undefined) return '';
  return String(value).trim();
}

function displayQuantity(value: number) {
  return String(Number(value.toFixed(4)));
}

function itemTitle(item: InventoryIntakeDraftItem) {
  return item.title.trim() || '该项';
}

function packageConversionFromUnknown(value: unknown): InventoryIntakePackageConversion | null {
  if (!isDraftRecord(value)) return null;
  return {
    ...value,
    ratio: value.ratio === null || value.ratio === undefined ? null : value.ratio as string | number,
    targetUnit: asText(value.targetUnit),
    evidence: asText(value.evidence),
  };
}

function parseItem(raw: DraftRecord): InventoryIntakeDraftItem {
  const sourceKindText = asText(raw.sourceKind);
  const actionText = asText(raw.action);
  const targetKindText = asText(raw.targetKind);
  return {
    ...raw,
    lineId: asText(raw.lineId),
    sourceLineId: asText(raw.sourceLineId),
    sourceText: asText(raw.sourceText),
    sourceKind: isSourceKind(sourceKindText) ? sourceKindText : '',
    action: isAction(actionText) ? actionText : '',
    shoppingItemId: asText(raw.shoppingItemId) || null,
    expectedShoppingItemRowVersion: optionalNumber(raw.expectedShoppingItemRowVersion),
    title: asText(raw.title),
    targetKind: isTargetKind(targetKindText) ? targetKindText : '',
    targetId: asText(raw.targetId) || null,
    expectedIngredientRowVersion: optionalNumber(raw.expectedIngredientRowVersion),
    expectedFoodRowVersion: optionalNumber(raw.expectedFoodRowVersion),
    stateId: asText(raw.stateId) || null,
    expectedStateRowVersion: optionalNumber(raw.expectedStateRowVersion),
    plannedQuantity: raw.plannedQuantity === null || raw.plannedQuantity === undefined
      ? null
      : (raw.plannedQuantity as string | number),
    plannedUnit: asText(raw.plannedUnit) || null,
    enteredQuantity: raw.enteredQuantity === null || raw.enteredQuantity === undefined
      ? null
      : (raw.enteredQuantity as string | number),
    enteredUnit: asText(raw.enteredUnit) || null,
    packageConversion: packageConversionFromUnknown(raw.packageConversion),
    storageLocation: asText(raw.storageLocation) || null,
    expiryDate: asText(raw.expiryDate) || null,
    inventoryStatus: asText(raw.inventoryStatus) || null,
    resultingAvailabilityLevel: asText(raw.resultingAvailabilityLevel) || null,
    notes: asText(raw.notes),
    before: isDraftRecord(raw.before) ? { ...raw.before } : {},
  };
}

function parseIgnored(raw: DraftRecord): InventoryIntakeIgnoredItem {
  return {
    ...raw,
    sourceLineId: asText(raw.sourceLineId),
    sourceText: asText(raw.sourceText),
    displayName: asText(raw.displayName),
    reasonCode: asText(raw.reasonCode),
    reason: asText(raw.reason),
  };
}

export function inventoryIntakeDraftFromRecord(value: Record<string, unknown>): InventoryIntakeDraft {
  const draftTypeText = asText(value.draftType);
  const schemaVersionText = asText(value.schemaVersion);
  return {
    ...value,
    draftType: draftTypeText === 'inventory_intake' ? 'inventory_intake' : '',
    schemaVersion: schemaVersionText === 'inventory_intake.v1' ? 'inventory_intake.v1' : '',
    clientRequestId: asText(value.clientRequestId),
    sourceType: asText(value.sourceType),
    sourceReference: isDraftRecord(value.sourceReference) ? { ...value.sourceReference } : null,
    intakeDate: asText(value.intakeDate),
    intakeDateSource: asText(value.intakeDateSource),
    items: asDraftArray(value.items).map(parseItem),
    ignoredItems: asDraftArray(value.ignoredItems).map(parseIgnored),
    summary: isDraftRecord(value.summary) ? { ...value.summary } : {},
  };
}

export function groupInventoryIntakeItems(draft: InventoryIntakeDraft) {
  return {
    shopping: draft.items.filter((item) => item.sourceKind === 'shopping_item'),
    direct: draft.items.filter((item) => item.sourceKind === 'direct'),
    ignored: draft.ignoredItems,
  };
}

export function inventoryIntakeActionOptions(sourceKind: InventoryIntakeSourceKind) {
  return VALID_ACTIONS_BY_SOURCE[sourceKind].map((value) => ({
    value,
    label: ACTION_LABELS[value],
  }));
}

export function patchInventoryIntakeItem(
  draft: InventoryIntakeDraft,
  lineId: string,
  patch: InventoryIntakeEditableItemPatch,
): InventoryIntakeDraft {
  return {
    ...draft,
    items: draft.items.map((item) => {
      if (item.lineId !== lineId) return item;
      const next: InventoryIntakeDraftItem = { ...item };
      for (const key of EDITABLE_ITEM_KEYS) {
        if (Object.prototype.hasOwnProperty.call(patch, key)) {
          const value = patch[key];
          if (key === 'packageConversion') {
            next.packageConversion = packageConversionFromUnknown(value) ?? (value === null ? null : item.packageConversion);
          } else if (key === 'action') {
            const actionText = asText(value);
            next.action = isAction(actionText) ? actionText : item.action;
          } else if (key === 'notes') {
            next.notes = asText(value);
          } else if (key === 'enteredQuantity') {
            next.enteredQuantity = value === null || value === undefined || value === ''
              ? null
              : value as string | number;
          } else if (key === 'enteredUnit' || key === 'storageLocation' || key === 'expiryDate' || key === 'inventoryStatus' || key === 'resultingAvailabilityLevel') {
            const text = asText(value);
            next[key] = text || null;
          }
        }
      }
      return next;
    }),
  };
}

export function patchInventoryIntakeDate(draft: InventoryIntakeDraft, intakeDate: string): InventoryIntakeDraft {
  return {
    ...draft,
    intakeDate,
  };
}

function canonicalActual(item: InventoryIntakeDraftItem) {
  const rawEntered = quantityText(item.enteredQuantity);
  const entered = Number(rawEntered);
  if (!rawEntered || !Number.isFinite(entered) || entered <= 0) return null;

  const conversion = item.packageConversion;
  if (conversion) {
    const ratio = Number(conversion.ratio);
    const targetUnit = asText(conversion.targetUnit);
    if (Number.isFinite(ratio) && ratio > 0 && targetUnit) {
      return { quantity: entered * ratio, unit: targetUnit };
    }
  }
  return {
    quantity: entered,
    unit: asText(item.enteredUnit) || asText(item.plannedUnit),
  };
}

export function inventoryIntakeItemSummary(item: InventoryIntakeDraftItem): string {
  if (item.action === 'skip') return '已跳过，不写入库存或采购清单';
  if (item.action === 'fulfill_without_stock') return '仅完成采购项，不登记库存';
  if (item.targetKind === 'presence_ingredient') {
    if (item.sourceKind === 'direct') return '直接入库并更新为有库存';
    return '完成采购项并更新为有库存';
  }

  const canonical = canonicalActual(item);
  if (!canonical) {
    return quantityText(item.enteredQuantity) ? '实际数量无效' : '待补实际入库数量';
  }

  const actualText = displayQuantity(canonical.quantity);
  const unit = canonical.unit;
  const planned = optionalNumber(item.plannedQuantity);
  const plannedUnit = asText(item.plannedUnit);

  if (item.sourceKind === 'direct') {
    return `直接入库 ${actualText}${unit ? ` ${unit}` : ''}，只增加库存`;
  }

  if (Number.isFinite(planned ?? NaN) && plannedUnit && unit && unit !== plannedUnit) {
    if (item.targetKind === 'exact_ingredient') {
      return `实际入库 ${actualText} ${unit}；计划 ${displayQuantity(planned!)} ${plannedUnit}，提交时按食材单位换算`;
    }
    return `实际入库 ${actualText} ${unit}；计划单位为 ${plannedUnit}，提交前需确认单位`;
  }
  if (Number.isFinite(planned ?? NaN) && planned !== null && canonical.quantity < planned) {
    return `入库 ${actualText} ${unit}，保留 ${displayQuantity(planned - canonical.quantity)} ${plannedUnit || unit}待买`;
  }
  if (Number.isFinite(planned ?? NaN) && planned !== null && canonical.quantity > planned) {
    return `实际入库 ${actualText} ${unit}，超过计划 ${displayQuantity(planned)} ${plannedUnit || unit}`;
  }
  return `完成并入库 ${actualText}${unit ? ` ${unit}` : ''}`;
}

function isStockAction(action: string) {
  return action === 'stock_and_fulfill' || action === 'stock_only';
}

function requiresQuantity(item: InventoryIntakeDraftItem) {
  return isStockAction(item.action) && (item.targetKind === 'exact_ingredient' || item.targetKind === 'food');
}

export function validateInventoryIntakeDraftForSubmit(draft: Record<string, unknown>): string {
  const parsed = inventoryIntakeDraftFromRecord(draft);

  if (!isIsoDateText(parsed.intakeDate)) {
    return '请填写有效的入库日期';
  }
  if (parsed.items.length === 0) {
    return '本次没有可处理的入库项';
  }

  const activeItems = parsed.items.filter((item) => item.action && item.action !== 'skip');
  if (activeItems.length === 0) {
    return '至少选择一项可提交的入库内容，不能全部跳过';
  }

  for (const item of parsed.items) {
    const title = itemTitle(item);
    if (item.action === 'skip') continue;
    if (!item.action) {
      return `请选择「${title}」的处理方式`;
    }

    if (!item.sourceKind || !isSourceKind(item.sourceKind)) {
      return `「${title}」的来源类型不正确`;
    }
    if (!VALID_ACTIONS_BY_SOURCE[item.sourceKind].includes(item.action as InventoryIntakeAction)) {
      return `「${title}」的处理方式不正确`;
    }

    if (item.sourceKind === 'shopping_item') {
      if (!item.shoppingItemId || item.expectedShoppingItemRowVersion === null) {
        return `「${title}」缺少采购项身份信息，请重新生成草稿`;
      }
    }
    if (isStockAction(item.action)) {
      if (!item.targetKind || item.targetKind === 'none' || !item.targetId) {
        return `「${title}」缺少库存目标身份信息，请重新生成草稿`;
      }
      if (
        (item.targetKind === 'exact_ingredient' || item.targetKind === 'presence_ingredient')
        && item.expectedIngredientRowVersion === null
      ) {
        return `「${title}」缺少食材版本信息，请重新生成草稿`;
      }
      if (item.targetKind === 'food' && item.expectedFoodRowVersion === null) {
        return `「${title}」缺少食物版本信息，请重新生成草稿`;
      }
      if (
        item.targetKind === 'presence_ingredient'
        && item.stateId
        && item.expectedStateRowVersion === null
      ) {
        return `「${title}」缺少库存状态版本信息，请重新生成草稿`;
      }
    }

    if (requiresQuantity(item)) {
      const quantity = Number(quantityText(item.enteredQuantity));
      if (!Number.isFinite(quantity) || quantity <= 0) {
        return `请填写「${title}」的实际入库数量`;
      }
      if (!asText(item.enteredUnit)) {
        return `请填写「${title}」的实际入库单位`;
      }
    }

    if (item.packageConversion && isStockAction(item.action) && item.targetKind !== 'presence_ingredient') {
      const ratio = Number(item.packageConversion.ratio);
      if (!Number.isFinite(ratio) || ratio <= 0 || !asText(item.packageConversion.targetUnit) || !asText(item.packageConversion.evidence)) {
        return `请补全「${title}」的包装换算倍率、目标单位和证据`;
      }
    }

    if (isStockAction(item.action) && item.targetKind === 'presence_ingredient') {
      const level = asText(item.resultingAvailabilityLevel);
      if (!PRESENCE_LEVELS.has(level)) {
        return `请选择「${title}」入库后的库存状态`;
      }
    }

    if (
      isStockAction(item.action)
      && (item.targetKind === 'exact_ingredient' || item.targetKind === 'presence_ingredient')
      && !asText(item.storageLocation)
    ) {
      return `请填写「${title}」的存放位置`;
    }

    const expiry = asText(item.expiryDate);
    if (expiry) {
      if (!isIsoDateText(expiry)) {
        return `「${title}」的到期日格式不正确`;
      }
      if (expiry < parsed.intakeDate) {
        return `「${title}」的到期日不能早于入库日期`;
      }
    }
  }

  if (parsed.draftType !== 'inventory_intake' || parsed.schemaVersion !== 'inventory_intake.v1') {
    return '入库草稿类型或版本不正确，请重新生成草稿';
  }

  return '';
}

export function inventoryIntakeNeedsAttention(item: InventoryIntakeDraftItem, intakeDate: string): boolean {
  if (item.action === 'skip') return false;
  if (!item.action) return true;
  if (item.sourceKind && item.action && isSourceKind(item.sourceKind)
    && !VALID_ACTIONS_BY_SOURCE[item.sourceKind].includes(item.action as InventoryIntakeAction)) {
    return true;
  }
  if (requiresQuantity(item)) {
    const quantity = Number(quantityText(item.enteredQuantity));
    if (!Number.isFinite(quantity) || quantity <= 0 || !asText(item.enteredUnit)) return true;
  }
  if (item.packageConversion && isStockAction(item.action) && item.targetKind !== 'presence_ingredient') {
    const ratio = Number(item.packageConversion.ratio);
    if (!Number.isFinite(ratio) || ratio <= 0 || !asText(item.packageConversion.targetUnit) || !asText(item.packageConversion.evidence)) {
      return true;
    }
  }
  if (isStockAction(item.action) && item.targetKind === 'presence_ingredient') {
    if (!PRESENCE_LEVELS.has(asText(item.resultingAvailabilityLevel))) return true;
  }
  if (isStockAction(item.action) && (item.targetKind === 'exact_ingredient' || item.targetKind === 'presence_ingredient') && !asText(item.storageLocation)) {
    return true;
  }
  const expiry = asText(item.expiryDate);
  if (expiry && (!isIsoDateText(expiry) || (isIsoDateText(intakeDate) && expiry < intakeDate))) return true;
  return false;
}

export function inventoryIntakeSubmitSummary(draft: InventoryIntakeDraft): string {
  const stockCount = draft.items.filter((item) => isStockAction(item.action)).length;
  const fulfillOnlyCount = draft.items.filter((item) => item.action === 'fulfill_without_stock').length;
  const skipCount = draft.items.filter((item) => item.action === 'skip').length;
  const shoppingCount = draft.items.filter((item) => item.sourceKind === 'shopping_item' && item.action && item.action !== 'skip').length;
  const directCount = draft.items.filter((item) => item.sourceKind === 'direct' && item.action && item.action !== 'skip').length;
  const parts = [
    `${stockCount} 项入库`,
    shoppingCount > 0 ? `${shoppingCount} 项关联采购` : '',
    directCount > 0 ? `${directCount} 项直接入库` : '',
    fulfillOnlyCount > 0 ? `${fulfillOnlyCount} 项仅完成采购` : '',
    skipCount > 0 ? `${skipCount} 项跳过` : '',
  ].filter(Boolean);
  return parts.join(' · ');
}

export function intakeDateSourceLabel(source: string): string {
  if (source === 'receipt') return '来自小票';
  if (source === 'user' || source === 'user_explicit') return '用户指定';
  if (source === 'family_business_date' || source === 'family_today') return '家庭业务日';
  if (source === 'historical') return '历史补录';
  return source || '日期来源未知';
}
