import type {
  AiInventoryBatchOption,
  AiInventoryOperationAction,
  AiInventoryOperationDraft,
  AiInventoryOperationDraftItem,
  InventoryStatus,
  MediaAsset,
} from '../../api/types';
import { asDraftArray, asNumber, asText, isDraftRecord } from './aiDraftValueUtils';

const INVENTORY_ACTIONS: AiInventoryOperationAction[] = ['restock', 'consume', 'dispose'];
const INVENTORY_STATUSES: InventoryStatus[] = ['fresh', 'opened', 'frozen', 'expiring'];

export type InventoryOperationDraftItemViewModel = Omit<AiInventoryOperationDraftItem, 'action' | 'batchOptions' | 'quantity' | 'status'> & {
  action: AiInventoryOperationAction | '';
  batchOptions: AiInventoryBatchOption[];
  quantity: number | '';
  status?: InventoryStatus | '';
  defaultUnit?: string;
  defaultStorage?: string;
  storageLocationOptions: string[];
  ingredientStorageLocations: string[];
};

export type InventoryOperationDraftViewModel = Omit<AiInventoryOperationDraft, 'operations'> & {
  operations: InventoryOperationDraftItemViewModel[];
};

export type InventoryOperationDraftItemPatch = Partial<InventoryOperationDraftItemViewModel>;

function isInventoryAction(value: string): value is AiInventoryOperationAction {
  return INVENTORY_ACTIONS.includes(value as AiInventoryOperationAction);
}

function isInventoryStatus(value: string): value is InventoryStatus {
  return INVENTORY_STATUSES.includes(value as InventoryStatus);
}

function optionalText(value: unknown) {
  const text = asText(value).trim();
  return text || undefined;
}

function nullableText(value: unknown) {
  const text = asText(value).trim();
  return text || null;
}

function optionalNumber(value: unknown) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function textList(value: unknown) {
  return Array.isArray(value) ? value.map((item) => asText(item).trim()).filter(Boolean) : [];
}

function batchOptionsFromUnknown(value: unknown): AiInventoryBatchOption[] {
  return asDraftArray(value)
    .map((item) => ({
      id: asText(item.id),
      label: asText(item.label),
      remainingQuantity: asNumber(item.remainingQuantity, 0),
      unit: asText(item.unit),
      expiryDate: nullableText(item.expiryDate),
    }))
    .filter((item) => item.id);
}

function mediaFromUnknown(value: unknown) {
  return isDraftRecord(value) ? value as unknown as MediaAsset : null;
}

export function inventoryOperationDraftFromRecord(draft: Record<string, unknown>): InventoryOperationDraftViewModel {
  return {
    draftType: 'inventory_operation',
    schemaVersion: 'inventory_operation.v1',
    source: isDraftRecord(draft.source) ? draft.source : undefined,
    operations: asDraftArray(draft.operations).map((item) => {
      const actionText = asText(item.action);
      const statusText = asText(item.status);
      return {
        action: isInventoryAction(actionText) ? actionText : '',
        ingredientId: asText(item.ingredientId) || asText(item.ingredient_id),
        ingredientName: asText(item.ingredientName, '食材') || asText(item.ingredient_name, '食材'),
        inventoryItemId: nullableText(item.inventoryItemId ?? item.inventory_item_id),
        quantity: asNumber(item.quantity, 0),
        unit: asText(item.unit),
        purchaseDate: nullableText(item.purchaseDate ?? item.purchase_date),
        expiryDate: nullableText(item.expiryDate ?? item.expiry_date),
        storageLocation: nullableText(item.storageLocation ?? item.storage_location),
        status: isInventoryStatus(statusText) ? statusText : '',
        notes: asText(item.notes),
        lowStockThreshold: optionalNumber(item.lowStockThreshold ?? item.low_stock_threshold),
        reason: asText(item.reason),
        sourceQuantity: optionalNumber(item.sourceQuantity ?? item.source_quantity),
        sourceUnit: nullableText(item.sourceUnit ?? item.source_unit),
        conversionRatioToDefault: optionalNumber(item.conversionRatioToDefault ?? item.conversion_ratio_to_default),
        conversionNote: nullableText(item.conversionNote ?? item.conversion_note),
        image: mediaFromUnknown(item.image),
        remainingQuantity: optionalNumber(item.remainingQuantity ?? item.remaining_quantity),
        batchOptions: batchOptionsFromUnknown(item.batchOptions ?? item.batch_options),
        defaultUnit: optionalText(item.defaultUnit ?? item.default_unit),
        defaultStorage: optionalText(item.defaultStorage ?? item.default_storage),
        storageLocationOptions: textList(item.storageLocationOptions ?? item.storage_locations),
        ingredientStorageLocations: textList(item.ingredientStorageLocations ?? item.ingredient_storage_locations),
      };
    }),
  };
}

function isIsoDateText(value: string) {
  return /^\d{4}-\d{2}-\d{2}$/.test(value);
}

export function validateInventoryOperationDraftForSubmit(draft: InventoryOperationDraftViewModel) {
  if (draft.operations.length === 0) return '库存处理草稿至少需要 1 项处理';
  for (const item of draft.operations) {
    const ingredientName = item.ingredientName || '食材';
    if (!item.action) {
      return `${ingredientName} 的库存处理方式无效`;
    }
    if (typeof item.quantity !== 'number' || !Number.isFinite(item.quantity) || item.quantity <= 0) {
      return `${ingredientName} 的处理数量需要大于 0`;
    }
    if (!item.unit.trim()) {
      return `${ingredientName} 的单位不能为空`;
    }
    if (item.action === 'dispose' && !item.reason.trim()) {
      return '销毁库存必须填写原因';
    }
    if (item.action === 'restock') {
      const purchaseDate = item.purchaseDate ?? '';
      const expiryDate = item.expiryDate ?? '';
      if (purchaseDate && expiryDate && isIsoDateText(purchaseDate) && isIsoDateText(expiryDate) && expiryDate < purchaseDate) {
        return `${ingredientName} 的到期日期不能早于采购日期`;
      }
    }
    if (item.action === 'consume' && item.inventoryItemId) {
      const hasBatch = item.batchOptions.some((option) => option.id === item.inventoryItemId);
      if (!hasBatch) {
        return `${ingredientName} 指定的库存批次必须从批次下拉中选择`;
      }
    }
  }
  return '';
}
