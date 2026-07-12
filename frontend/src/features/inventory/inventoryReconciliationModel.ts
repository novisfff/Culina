import type {
  InventoryAvailabilityLevel,
  InventoryConfirmationStatus,
  InventoryOperationResult,
  InventoryReconciliationGroup,
  InventoryReconciliationGroupRequest,
  InventoryReconciliationRequest,
  InventoryReconciliationResponse,
  InventoryStatus,
  VersionedObservedBatchRequest,
} from '../../api/types';
import { calendarDaysBetweenDateKeys, hoursBetweenInstants } from '../../lib/date';
import { parseOptionalFoodStockQuantity } from '../../lib/foodStockQuantity';

export type InventoryReconciliationScope =
  | 'suggested'
  | 'refrigerated'
  | 'frozen'
  | 'room_temperature'
  | 'all';

export type InventoryReconciliationStep = 'review' | 'summary' | 'result';

export interface ExactBatchUpdateIntent {
  inventoryItemId: string;
  expectedRowVersion: number;
  actualRemainingQuantity: string;
  inventoryStatus: InventoryStatus;
  purchaseDate: string;
  expiryDate: string | null;
  storageLocation: string;
  notes: string;
}

export interface ExactBatchCreateIntent {
  clientLineId: string;
  actualRemainingQuantity: string;
  unit: string;
  inventoryStatus: InventoryStatus;
  purchaseDate: string;
  expiryDate: string | null;
  storageLocation: string;
  notes: string;
}

export interface ExactIngredientIntent {
  kind: 'exact_ingredient';
  ingredientId: string;
  expectedIngredientRowVersion: number;
  action: 'confirm_all' | 'set_absent' | 'adjust_batches';
  observedBatches: VersionedObservedBatchRequest[];
  updates: ExactBatchUpdateIntent[];
  creates: ExactBatchCreateIntent[];
}

export interface PresenceIngredientIntent {
  kind: 'presence_ingredient';
  ingredientId: string;
  stateId: string | null;
  expectedIngredientRowVersion: number;
  expectedStateRowVersion: number | null;
  availabilityLevel: InventoryAvailabilityLevel;
  inventoryStatus: InventoryStatus;
  purchaseDate: string | null;
  expiryDate: string | null;
  storageLocation: string | null;
  notes: string;
}

export interface FoodIntent {
  kind: 'food';
  foodId: string;
  expectedRowVersion: number;
  action: 'confirm' | 'set_stock';
  stockQuantity: string | null;
  stockUnit: string | null;
  expiryDate: string | null;
  storageLocation: string | null;
}

export type ReconciliationIntent = ExactIngredientIntent | PresenceIngredientIntent | FoodIntent;

export interface InventoryReconciliationDraft {
  schemaVersion: 1;
  familyId: string;
  userId: string;
  clientRequestId: string;
  scope: InventoryReconciliationScope;
  createdAt: string;
  savedAt: string;
  intents: ReconciliationIntent[];
}

export interface DraftReplayConflict {
  targetKey: string;
  code: 'stale_version' | 'scope_changed' | 'missing_target' | 'tracking_mode_changed';
  message: string;
}

export interface DraftReplayResult {
  restoredDraft: InventoryReconciliationDraft | null;
  conflicts: DraftReplayConflict[];
  newlyDiscoveredTargetKeys: string[];
  discardedReason: 'expired' | 'family_mismatch' | 'user_mismatch' | 'schema_mismatch' | null;
}

export type ReconciliationFieldError = {
  targetKey: string;
  field: string;
  code: string;
  message: string;
};

export type ReconciliationSubmitSummary = {
  confirmCount: number;
  adjustedCount: number;
  lowCount: number;
  absentCount: number;
  createdBatchCount: number;
  totalTouched: number;
};

export type ReconciliationConflictState =
  | 'none'
  | 'stale_version'
  | 'scope_changed'
  | 'tracking_mode_changed'
  | 'idempotency_key_reused'
  | 'missing_target';

export const RECONCILIATION_DRAFT_TTL_HOURS = 24;
export const RECONCILIATION_DRAFT_SCHEMA_VERSION = 1 as const;

export const SCOPE_LABELS: Record<InventoryReconciliationScope, string> = {
  suggested: '建议确认',
  refrigerated: '冷藏',
  frozen: '冷冻',
  room_temperature: '常温',
  all: '全部',
};

export const CONFIRMATION_STATUS_LABELS: Record<InventoryConfirmationStatus, string> = {
  never_confirmed: '从未确认',
  current: '刚确认过',
  stale: '建议再确认',
};

export const AVAILABILITY_LEVEL_LABELS: Record<InventoryAvailabilityLevel, string> = {
  present_unknown: '还在',
  low: '少量',
  sufficient: '充足',
  absent: '没有了',
};

export const SCOPE_STORAGE_LOCATION: Record<
  Exclude<InventoryReconciliationScope, 'suggested' | 'all'>,
  string
> = {
  refrigerated: '冷藏',
  frozen: '冷冻',
  room_temperature: '常温',
};

function formatQuantityString(value: number) {
  if (!Number.isFinite(value)) {
    return '0';
  }
  return String(Number(value.toFixed(4))).replace(/\.0+$/, '').replace(/(\.\d*?)0+$/, '$1');
}

function createClientRequestId() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `recon-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export function renewReconciliationRequestId(
  draft: InventoryReconciliationDraft,
): InventoryReconciliationDraft {
  return {
    ...draft,
    clientRequestId: createClientRequestId(),
  };
}

function createClientLineId() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `line-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export function reconciliationGroupTargetKey(group: InventoryReconciliationGroup): string {
  if (group.kind === 'exact_ingredient') {
    return `exact_ingredient:${group.ingredient_id}`;
  }
  if (group.kind === 'presence_ingredient') {
    return `presence_ingredient:${group.ingredient_id}`;
  }
  if (group.kind === 'food') {
    return `food:${group.food_id}`;
  }
  const _exhaustive: never = group;
  return _exhaustive;
}

export function intentTargetKey(intent: ReconciliationIntent): string {
  if (intent.kind === 'exact_ingredient') {
    return `exact_ingredient:${intent.ingredientId}`;
  }
  if (intent.kind === 'presence_ingredient') {
    return `presence_ingredient:${intent.ingredientId}`;
  }
  if (intent.kind === 'food') {
    return `food:${intent.foodId}`;
  }
  const _exhaustive: never = intent;
  return _exhaustive;
}

export function scopeLabel(scope: InventoryReconciliationScope): string {
  return SCOPE_LABELS[scope];
}

export function confirmationStatusLabel(status: InventoryConfirmationStatus): string {
  return CONFIRMATION_STATUS_LABELS[status];
}

export function availabilityLevelLabel(level: InventoryAvailabilityLevel): string {
  return AVAILABILITY_LEVEL_LABELS[level];
}

export function storageLocationForScope(scope: InventoryReconciliationScope): string | null {
  if (scope === 'suggested' || scope === 'all') {
    return null;
  }
  return SCOPE_STORAGE_LOCATION[scope];
}

export function isPhysicalBatchExpired(
  batch: { expiry_date: string | null },
  referenceDate: string,
): boolean {
  if (!batch.expiry_date) {
    return false;
  }
  return calendarDaysBetweenDateKeys(batch.expiry_date.slice(0, 10), referenceDate.slice(0, 10)) < 0;
}

export function countExpiredPhysicalBatches(
  groups: InventoryReconciliationGroup[],
  referenceDate: string,
): number {
  let count = 0;
  for (const group of groups) {
    if (group.kind !== 'exact_ingredient') continue;
    for (const batch of group.batches) {
      if (batch.remaining_quantity > 0 && isPhysicalBatchExpired(batch, referenceDate)) {
        count += 1;
      }
    }
  }
  return count;
}

export function sumExactRemainingQuantity(group: Extract<InventoryReconciliationGroup, { kind: 'exact_ingredient' }>): {
  total: number;
  unit: string;
  label: string;
  batchCount: number;
} {
  const unitTotals = new Map<string, number>();
  const unitOrder: string[] = [];
  for (const batch of group.batches) {
    if (batch.remaining_quantity <= 0) continue;
    if (!unitTotals.has(batch.unit)) {
      unitOrder.push(batch.unit);
      unitTotals.set(batch.unit, 0);
    }
    unitTotals.set(batch.unit, (unitTotals.get(batch.unit) ?? 0) + batch.remaining_quantity);
  }
  const total = [...unitTotals.values()].reduce((sum, value) => sum + value, 0);
  const unit = unitOrder[0] ?? group.batches[0]?.unit ?? '';
  const label =
    unitOrder.length <= 1
      ? `${formatQuantityString(total)} ${unit}`.trim()
      : unitOrder
          .map((entry) => `${formatQuantityString(unitTotals.get(entry) ?? 0)} ${entry}`.trim())
          .join(' · ');
  return {
    total,
    unit,
    label: label || '0',
    batchCount: group.batches.filter((batch) => batch.remaining_quantity > 0).length,
  };
}

export function buildGroupHeadline(group: InventoryReconciliationGroup, referenceDate: string): {
  title: string;
  detail: string;
  confirmationLabel: string;
  hasExpiredPhysicalBatch: boolean;
} {
  const confirmationLabel = confirmationStatusLabel(group.confirmation_status);
  if (group.kind === 'exact_ingredient') {
    const remaining = sumExactRemainingQuantity(group);
    const locations = [...new Set(group.batches.map((batch) => batch.storage_location).filter(Boolean))];
    const locationLabel = locations.length === 1 ? locations[0] : locations.length > 1 ? '多位置' : '';
    const expired = group.batches.some(
      (batch) => batch.remaining_quantity > 0 && isPhysicalBatchExpired(batch, referenceDate),
    );
    const parts = [
      `当前共 ${remaining.label}`,
      locationLabel,
      remaining.batchCount > 1 ? `${remaining.batchCount} 个批次` : null,
      expired ? '含过期批次' : null,
    ].filter(Boolean);
    return {
      title: group.ingredient_name,
      detail: parts.join(' · '),
      confirmationLabel,
      hasExpiredPhysicalBatch: expired,
    };
  }
  if (group.kind === 'presence_ingredient') {
    const levelLabel = availabilityLevelLabel(group.state.availability_level);
    const location = group.state.storage_location?.trim() || '';
    return {
      title: group.ingredient_name,
      detail: [`只记录有无`, `当前${levelLabel}`, location].filter(Boolean).join(' · '),
      confirmationLabel,
      hasExpiredPhysicalBatch: Boolean(
        group.state.expiry_date &&
          calendarDaysBetweenDateKeys(group.state.expiry_date.slice(0, 10), referenceDate.slice(0, 10)) < 0,
      ),
    };
  }
  if (group.kind === 'food') {
    const qty = formatQuantityString(group.stock_quantity);
    const unit = group.stock_unit || '份';
    const location = group.storage_location?.trim() || '';
    return {
      title: group.food_name,
      detail: [`当前 ${qty} ${unit}`, location].filter(Boolean).join(' · '),
      confirmationLabel,
      hasExpiredPhysicalBatch: Boolean(
        group.expiry_date &&
          calendarDaysBetweenDateKeys(group.expiry_date.slice(0, 10), referenceDate.slice(0, 10)) < 0,
      ),
    };
  }
  const _exhaustive: never = group;
  return _exhaustive;
}

export function buildObservedBatches(
  group: Extract<InventoryReconciliationGroup, { kind: 'exact_ingredient' }>,
): VersionedObservedBatchRequest[] {
  return group.batches
    .filter((batch) => batch.remaining_quantity > 0)
    .map((batch) => ({
      inventory_item_id: batch.inventory_item_id,
      expected_row_version: batch.row_version,
    }));
}

export function createEmptyDraft(args: {
  familyId: string;
  userId: string;
  scope: InventoryReconciliationScope;
  now: string;
  clientRequestId?: string;
}): InventoryReconciliationDraft {
  return {
    schemaVersion: RECONCILIATION_DRAFT_SCHEMA_VERSION,
    familyId: args.familyId,
    userId: args.userId,
    clientRequestId: args.clientRequestId ?? createClientRequestId(),
    scope: args.scope,
    createdAt: args.now,
    savedAt: args.now,
    intents: [],
  };
}

export function findIntent(
  draft: InventoryReconciliationDraft,
  targetKey: string,
): ReconciliationIntent | null {
  return draft.intents.find((intent) => intentTargetKey(intent) === targetKey) ?? null;
}

export function upsertIntent(
  draft: InventoryReconciliationDraft,
  intent: ReconciliationIntent,
  savedAt: string,
): InventoryReconciliationDraft {
  const key = intentTargetKey(intent);
  const existingIndex = draft.intents.findIndex((entry) => intentTargetKey(entry) === key);
  const intents =
    existingIndex >= 0
      ? draft.intents.map((entry, index) => (index === existingIndex ? intent : entry))
      : [...draft.intents, intent];
  return {
    ...draft,
    savedAt,
    intents,
  };
}

export function removeIntent(
  draft: InventoryReconciliationDraft,
  targetKey: string,
  savedAt: string,
): InventoryReconciliationDraft {
  return {
    ...draft,
    savedAt,
    intents: draft.intents.filter((intent) => intentTargetKey(intent) !== targetKey),
  };
}

export function buildExactConfirmAllIntent(
  group: Extract<InventoryReconciliationGroup, { kind: 'exact_ingredient' }>,
): ExactIngredientIntent {
  return {
    kind: 'exact_ingredient',
    ingredientId: group.ingredient_id,
    expectedIngredientRowVersion: group.ingredient_row_version,
    action: 'confirm_all',
    observedBatches: buildObservedBatches(group),
    updates: [],
    creates: [],
  };
}

export function buildExactSetAbsentIntent(
  group: Extract<InventoryReconciliationGroup, { kind: 'exact_ingredient' }>,
): ExactIngredientIntent {
  const observedBatches = buildObservedBatches(group);
  return {
    kind: 'exact_ingredient',
    ingredientId: group.ingredient_id,
    expectedIngredientRowVersion: group.ingredient_row_version,
    action: 'set_absent',
    observedBatches,
    updates: group.batches
      .filter((batch) => batch.remaining_quantity > 0)
      .map((batch) => ({
        inventoryItemId: batch.inventory_item_id,
        expectedRowVersion: batch.row_version,
        actualRemainingQuantity: '0',
        inventoryStatus: batch.status,
        purchaseDate: batch.purchase_date,
        expiryDate: batch.expiry_date,
        storageLocation: batch.storage_location,
        notes: batch.notes,
      })),
    creates: [],
  };
}

export function buildExactAdjustBatchesIntent(args: {
  group: Extract<InventoryReconciliationGroup, { kind: 'exact_ingredient' }>;
  updates: ExactBatchUpdateIntent[];
  creates?: ExactBatchCreateIntent[];
}): ExactIngredientIntent {
  return {
    kind: 'exact_ingredient',
    ingredientId: args.group.ingredient_id,
    expectedIngredientRowVersion: args.group.ingredient_row_version,
    action: 'adjust_batches',
    observedBatches: buildObservedBatches(args.group),
    updates: args.updates,
    creates: args.creates ?? [],
  };
}

export function buildBatchUpdateFromGroup(
  group: Extract<InventoryReconciliationGroup, { kind: 'exact_ingredient' }>,
  inventoryItemId: string,
  patch: Partial<Omit<ExactBatchUpdateIntent, 'inventoryItemId' | 'expectedRowVersion'>> = {},
): ExactBatchUpdateIntent | null {
  const batch = group.batches.find((entry) => entry.inventory_item_id === inventoryItemId);
  if (!batch) return null;
  return {
    inventoryItemId: batch.inventory_item_id,
    expectedRowVersion: batch.row_version,
    actualRemainingQuantity:
      patch.actualRemainingQuantity ?? formatQuantityString(batch.remaining_quantity),
    inventoryStatus: patch.inventoryStatus ?? batch.status,
    purchaseDate: patch.purchaseDate ?? batch.purchase_date,
    expiryDate: patch.expiryDate === undefined ? batch.expiry_date : patch.expiryDate,
    storageLocation: patch.storageLocation ?? batch.storage_location,
    notes: patch.notes ?? batch.notes,
  };
}

export function buildBatchCreateIntent(args: {
  actualRemainingQuantity: string;
  unit: string;
  inventoryStatus: InventoryStatus;
  purchaseDate: string;
  expiryDate: string | null;
  storageLocation: string;
  notes?: string;
  clientLineId?: string;
}): ExactBatchCreateIntent {
  return {
    clientLineId: args.clientLineId ?? createClientLineId(),
    actualRemainingQuantity: args.actualRemainingQuantity,
    unit: args.unit,
    inventoryStatus: args.inventoryStatus,
    purchaseDate: args.purchaseDate,
    expiryDate: args.expiryDate,
    storageLocation: args.storageLocation,
    notes: args.notes ?? '',
  };
}

export function buildPresenceIntent(args: {
  group: Extract<InventoryReconciliationGroup, { kind: 'presence_ingredient' }>;
  availabilityLevel: InventoryAvailabilityLevel;
  inventoryStatus?: InventoryStatus;
  purchaseDate?: string | null;
  expiryDate?: string | null;
  storageLocation?: string | null;
  notes?: string;
}): PresenceIngredientIntent {
  const absent = args.availabilityLevel === 'absent';
  return {
    kind: 'presence_ingredient',
    ingredientId: args.group.ingredient_id,
    stateId: args.group.state.id,
    expectedIngredientRowVersion: args.group.ingredient_row_version,
    expectedStateRowVersion: args.group.state.row_version,
    availabilityLevel: args.availabilityLevel,
    inventoryStatus: args.inventoryStatus ?? args.group.state.inventory_status,
    purchaseDate: absent ? null : (args.purchaseDate ?? args.group.state.purchase_date),
    expiryDate: absent ? null : (args.expiryDate === undefined ? args.group.state.expiry_date : args.expiryDate),
    storageLocation: absent
      ? null
      : (args.storageLocation === undefined ? args.group.state.storage_location : args.storageLocation),
    notes: args.notes ?? args.group.state.notes,
  };
}

export function buildFoodConfirmIntent(
  group: Extract<InventoryReconciliationGroup, { kind: 'food' }>,
): FoodIntent {
  return {
    kind: 'food',
    foodId: group.food_id,
    expectedRowVersion: group.row_version,
    action: 'confirm',
    stockQuantity: null,
    stockUnit: null,
    expiryDate: null,
    storageLocation: null,
  };
}

export function buildFoodSetStockIntent(args: {
  group: Extract<InventoryReconciliationGroup, { kind: 'food' }>;
  stockQuantity: string;
  stockUnit?: string | null;
  expiryDate?: string | null;
  storageLocation?: string | null;
}): FoodIntent {
  return {
    kind: 'food',
    foodId: args.group.food_id,
    expectedRowVersion: args.group.row_version,
    action: 'set_stock',
    stockQuantity: args.stockQuantity,
    stockUnit: args.stockUnit ?? args.group.stock_unit,
    expiryDate: args.expiryDate === undefined ? args.group.expiry_date : args.expiryDate,
    storageLocation:
      args.storageLocation === undefined ? args.group.storage_location : args.storageLocation,
  };
}

export function buildFoodSetAbsentIntent(
  group: Extract<InventoryReconciliationGroup, { kind: 'food' }>,
): FoodIntent {
  return buildFoodSetStockIntent({
    group,
    stockQuantity: '0',
    stockUnit: group.stock_unit,
    expiryDate: null,
    storageLocation: null,
  });
}

function parseNonNegativeQuantity(value: string): number | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const numeric = Number(trimmed);
  if (!Number.isFinite(numeric) || numeric < 0) return null;
  return numeric;
}

function hasInvalidDateRange(purchaseDate: string | null, expiryDate: string | null): boolean {
  return Boolean(purchaseDate && expiryDate && expiryDate < purchaseDate);
}

export function validateReconciliationDraft(
  draft: InventoryReconciliationDraft,
  groups: InventoryReconciliationGroup[],
): ReconciliationFieldError[] {
  const errors: ReconciliationFieldError[] = [];
  const groupByKey = new Map(groups.map((group) => [reconciliationGroupTargetKey(group), group]));

  if (draft.intents.length === 0) {
    errors.push({
      targetKey: '',
      field: 'intents',
      code: 'empty_operation',
      message: '请先确认至少一项库存。',
    });
    return errors;
  }

  for (const intent of draft.intents) {
    const targetKey = intentTargetKey(intent);
    const group = groupByKey.get(targetKey);
    if (!group) {
      errors.push({
        targetKey,
        field: 'target',
        code: 'missing_target',
        message: '该项已不在当前盘点范围，请移除后重试。',
      });
      continue;
    }

    if (intent.kind === 'exact_ingredient') {
      if (group.kind !== 'exact_ingredient') {
        errors.push({
          targetKey,
          field: 'kind',
          code: 'tracking_mode_changed',
          message: '食材跟踪方式已变化，请重新确认。',
        });
        continue;
      }
      if (intent.action === 'adjust_batches') {
        if (intent.updates.length === 0 && intent.creates.length === 0) {
          errors.push({
            targetKey,
            field: 'updates',
            code: 'invalid_quantity',
            message: `请为「${group.ingredient_name}」填写调整内容。`,
          });
        }
        for (const update of intent.updates) {
          if (parseNonNegativeQuantity(update.actualRemainingQuantity) === null) {
            errors.push({
              targetKey,
              field: `batch:${update.inventoryItemId}:actualRemainingQuantity`,
              code: 'invalid_quantity',
              message: `请填写「${group.ingredient_name}」批次的有效剩余量。`,
            });
          }
          if (!update.storageLocation.trim()) {
            errors.push({
              targetKey,
              field: `batch:${update.inventoryItemId}:storageLocation`,
              code: 'invalid_date_range',
              message: `请填写「${group.ingredient_name}」批次的存放位置。`,
            });
          }
          if (!update.purchaseDate.trim()) {
            errors.push({
              targetKey,
              field: `batch:${update.inventoryItemId}:purchaseDate`,
              code: 'invalid_date_range',
              message: `请填写「${group.ingredient_name}」批次的购买日期。`,
            });
          }
          if (hasInvalidDateRange(update.purchaseDate, update.expiryDate)) {
            errors.push({
              targetKey,
              field: `batch:${update.inventoryItemId}:expiryDate`,
              code: 'invalid_date_range',
              message: `「${group.ingredient_name}」批次的到期日不能早于购买日期。`,
            });
          }
        }
        for (const create of intent.creates) {
          const qty = parseNonNegativeQuantity(create.actualRemainingQuantity);
          if (qty === null || qty <= 0) {
            errors.push({
              targetKey,
              field: `create:${create.clientLineId}:actualRemainingQuantity`,
              code: 'invalid_quantity',
              message: `请填写「${group.ingredient_name}」新增批次的有效数量。`,
            });
          }
          if (!create.unit.trim()) {
            errors.push({
              targetKey,
              field: `create:${create.clientLineId}:unit`,
              code: 'incompatible_unit',
              message: `请填写「${group.ingredient_name}」新增批次的单位。`,
            });
          }
          if (!create.storageLocation.trim()) {
            errors.push({
              targetKey,
              field: `create:${create.clientLineId}:storageLocation`,
              code: 'invalid_date_range',
              message: `请填写「${group.ingredient_name}」新增批次的存放位置。`,
            });
          }
          if (!create.purchaseDate.trim()) {
            errors.push({
              targetKey,
              field: `create:${create.clientLineId}:purchaseDate`,
              code: 'invalid_date_range',
              message: `请填写「${group.ingredient_name}」新增批次的购买日期。`,
            });
          }
          if (hasInvalidDateRange(create.purchaseDate, create.expiryDate)) {
            errors.push({
              targetKey,
              field: `create:${create.clientLineId}:expiryDate`,
              code: 'invalid_date_range',
              message: `「${group.ingredient_name}」新增批次的到期日不能早于购买日期。`,
            });
          }
        }
        const lineIds = intent.creates.map((create) => create.clientLineId);
        if (new Set(lineIds).size !== lineIds.length) {
          errors.push({
            targetKey,
            field: 'creates',
            code: 'duplicate_request_item',
            message: `「${group.ingredient_name}」新增批次标识重复。`,
          });
        }
      }
      continue;
    }

    if (intent.kind === 'presence_ingredient') {
      if (group.kind !== 'presence_ingredient') {
        errors.push({
          targetKey,
          field: 'kind',
          code: 'tracking_mode_changed',
          message: '食材跟踪方式已变化，请重新确认。',
        });
        continue;
      }
      if (intent.availabilityLevel !== 'absent' && !intent.storageLocation?.trim()) {
        errors.push({
          targetKey,
          field: 'storageLocation',
          code: 'invalid_date_range',
          message: `请填写「${group.ingredient_name}」的存放位置。`,
        });
      }
      if (hasInvalidDateRange(intent.purchaseDate, intent.expiryDate)) {
        errors.push({
          targetKey,
          field: 'expiryDate',
          code: 'invalid_date_range',
          message: `「${group.ingredient_name}」的到期日不能早于购买日期。`,
        });
      }
      continue;
    }

    if (intent.kind === 'food') {
      if (group.kind !== 'food') {
        errors.push({
          targetKey,
          field: 'kind',
          code: 'tracking_mode_changed',
          message: '成品库存形态已变化，请重新确认。',
        });
        continue;
      }
      if (intent.action === 'set_stock') {
        if (intent.stockQuantity === null || parseNonNegativeQuantity(intent.stockQuantity) === null) {
          errors.push({
            targetKey,
            field: 'stockQuantity',
            code: 'invalid_quantity',
            message: `请填写「${group.food_name}」的有效数量。`,
          });
        }
        if (intent.stockQuantity !== null && intent.stockQuantity.trim()) {
          const parsedFoodQuantity = parseOptionalFoodStockQuantity(intent.stockQuantity, '库存数量');
          if (parsedFoodQuantity.error) {
            errors.push({
              targetKey,
              field: 'stockQuantity',
              code: 'invalid_quantity',
              message: parsedFoodQuantity.error,
            });
          }
        }
        const qty = intent.stockQuantity === null ? null : parseNonNegativeQuantity(intent.stockQuantity);
        if (qty !== null && qty > 0 && !intent.stockUnit?.trim()) {
          errors.push({
            targetKey,
            field: 'stockUnit',
            code: 'incompatible_unit',
            message: `请填写「${group.food_name}」的单位。`,
          });
        }
        if (qty !== null && qty > 0 && !intent.storageLocation?.trim()) {
          errors.push({
            targetKey,
            field: 'storageLocation',
            code: 'invalid_target',
            message: `请填写「${group.food_name}」的存放位置。`,
          });
        }
      }
      continue;
    }

    const _exhaustive: never = intent;
    void _exhaustive;
  }

  return errors;
}

export function canSubmitReconciliation(
  draft: InventoryReconciliationDraft,
  groups: InventoryReconciliationGroup[],
): boolean {
  return validateReconciliationDraft(draft, groups).length === 0;
}

export function summarizeReconciliationDraft(draft: InventoryReconciliationDraft): ReconciliationSubmitSummary {
  let confirmCount = 0;
  let adjustedCount = 0;
  let lowCount = 0;
  let absentCount = 0;
  let createdBatchCount = 0;

  for (const intent of draft.intents) {
    if (intent.kind === 'exact_ingredient') {
      if (intent.action === 'confirm_all') {
        confirmCount += 1;
      } else if (intent.action === 'set_absent') {
        absentCount += 1;
      } else if (intent.action === 'adjust_batches') {
        adjustedCount += 1;
        createdBatchCount += intent.creates.length;
      }
      continue;
    }
    if (intent.kind === 'presence_ingredient') {
      if (intent.availabilityLevel === 'absent') {
        absentCount += 1;
      } else if (intent.availabilityLevel === 'low') {
        lowCount += 1;
      } else {
        confirmCount += 1;
      }
      continue;
    }
    if (intent.kind === 'food') {
      if (intent.action === 'confirm') {
        confirmCount += 1;
      } else if (intent.stockQuantity !== null && parseNonNegativeQuantity(intent.stockQuantity) === 0) {
        absentCount += 1;
      } else {
        adjustedCount += 1;
      }
      continue;
    }
    const _exhaustive: never = intent;
    void _exhaustive;
  }

  return {
    confirmCount,
    adjustedCount,
    lowCount,
    absentCount,
    createdBatchCount,
    totalTouched: draft.intents.length,
  };
}

export function formatSubmitSummaryLines(summary: ReconciliationSubmitSummary): Array<{ label: string; count: number }> {
  return [
    { label: '确认无误', count: summary.confirmCount },
    { label: '库存数量调整', count: summary.adjustedCount },
    { label: '标记少量', count: summary.lowCount },
    { label: '调整为没有', count: summary.absentCount },
    { label: '新增漏记批次', count: summary.createdBatchCount },
  ].filter((line) => line.count > 0);
}

export function buildReconciliationPayload(
  draft: InventoryReconciliationDraft,
): InventoryReconciliationRequest {
  if (draft.intents.length === 0) {
    throw new Error('empty_operation');
  }

  const groups: InventoryReconciliationGroupRequest[] = draft.intents.map((intent) => {
    if (intent.kind === 'exact_ingredient') {
      return {
        kind: 'exact_ingredient',
        ingredient_id: intent.ingredientId,
        expected_ingredient_row_version: intent.expectedIngredientRowVersion,
        action: intent.action,
        observed_batches: intent.observedBatches,
        updates: intent.updates.map((update) => {
          const qty = parseNonNegativeQuantity(update.actualRemainingQuantity);
          if (qty === null) {
            throw new Error(`invalid quantity for batch ${update.inventoryItemId}`);
          }
          return {
            inventory_item_id: update.inventoryItemId,
            expected_row_version: update.expectedRowVersion,
            actual_remaining_quantity: qty,
            inventory_status: update.inventoryStatus,
            purchase_date: update.purchaseDate,
            expiry_date: update.expiryDate,
            storage_location: update.storageLocation,
            notes: update.notes,
          };
        }),
        creates: intent.creates.map((create) => {
          const qty = parseNonNegativeQuantity(create.actualRemainingQuantity);
          if (qty === null || qty <= 0) {
            throw new Error(`invalid quantity for create ${create.clientLineId}`);
          }
          return {
            client_line_id: create.clientLineId,
            actual_remaining_quantity: qty,
            unit: create.unit,
            inventory_status: create.inventoryStatus,
            purchase_date: create.purchaseDate,
            expiry_date: create.expiryDate,
            storage_location: create.storageLocation,
            notes: create.notes,
          };
        }),
      };
    }
    if (intent.kind === 'presence_ingredient') {
      return {
        kind: 'presence_ingredient',
        ingredient_id: intent.ingredientId,
        state_id: intent.stateId,
        expected_ingredient_row_version: intent.expectedIngredientRowVersion,
        expected_state_row_version: intent.expectedStateRowVersion,
        availability_level: intent.availabilityLevel,
        inventory_status: intent.inventoryStatus,
        purchase_date: intent.purchaseDate,
        expiry_date: intent.expiryDate,
        storage_location: intent.storageLocation,
        notes: intent.notes,
      };
    }
    if (intent.kind === 'food') {
      const stockQuantity =
        intent.action === 'set_stock' && intent.stockQuantity !== null
          ? parseNonNegativeQuantity(intent.stockQuantity)
          : null;
      if (intent.action === 'set_stock' && stockQuantity === null) {
        throw new Error(`invalid food stock for ${intent.foodId}`);
      }
      return {
        kind: 'food',
        food_id: intent.foodId,
        expected_row_version: intent.expectedRowVersion,
        action: intent.action,
        stock_quantity: stockQuantity,
        stock_unit: intent.stockUnit,
        expiry_date: intent.expiryDate,
        storage_location: intent.storageLocation,
      };
    }
    const _exhaustive: never = intent;
    return _exhaustive;
  });

  return {
    client_request_id: draft.clientRequestId,
    scope: draft.scope,
    storage_location: storageLocationForScope(draft.scope),
    groups,
  };
}

function latestGroupByTargetKey(
  latest: InventoryReconciliationResponse,
): Map<string, InventoryReconciliationGroup> {
  return new Map(latest.groups.map((group) => [reconciliationGroupTargetKey(group), group]));
}

function exactVersionsMatch(
  intent: ExactIngredientIntent,
  group: Extract<InventoryReconciliationGroup, { kind: 'exact_ingredient' }>,
): { ok: true } | { ok: false; code: DraftReplayConflict['code']; message: string } {
  if (intent.expectedIngredientRowVersion !== group.ingredient_row_version) {
    return {
      ok: false,
      code: 'stale_version',
      message: '食材版本已变化，请重新确认。',
    };
  }
  const observedIds = new Set(intent.observedBatches.map((batch) => batch.inventory_item_id));
  const currentBatches = group.batches.filter((batch) => batch.remaining_quantity > 0);
  const currentIds = new Set(currentBatches.map((batch) => batch.inventory_item_id));
  if (observedIds.size !== currentIds.size || [...observedIds].some((id) => !currentIds.has(id))) {
    return {
      ok: false,
      code: 'scope_changed',
      message: '批次范围已变化，请重新确认。',
    };
  }
  for (const observed of intent.observedBatches) {
    const batch = currentBatches.find((entry) => entry.inventory_item_id === observed.inventory_item_id);
    if (!batch) {
      return {
        ok: false,
        code: 'scope_changed',
        message: '批次范围已变化，请重新确认。',
      };
    }
    if (batch.row_version !== observed.expected_row_version) {
      return {
        ok: false,
        code: 'stale_version',
        message: '批次版本已变化，请重新确认。',
      };
    }
  }
  for (const update of intent.updates) {
    const batch = currentBatches.find((entry) => entry.inventory_item_id === update.inventoryItemId);
    if (!batch) {
      return {
        ok: false,
        code: 'missing_target',
        message: '原批次已不存在，请重新确认。',
      };
    }
    if (batch.row_version !== update.expectedRowVersion) {
      return {
        ok: false,
        code: 'stale_version',
        message: '批次版本已变化，请重新确认。',
      };
    }
  }
  return { ok: true };
}

function rebindExactIntent(
  intent: ExactIngredientIntent,
  group: Extract<InventoryReconciliationGroup, { kind: 'exact_ingredient' }>,
): ExactIngredientIntent {
  const observedBatches = buildObservedBatches(group);
  const currentById = new Map(group.batches.map((batch) => [batch.inventory_item_id, batch]));
  return {
    ...intent,
    expectedIngredientRowVersion: group.ingredient_row_version,
    observedBatches,
    updates: intent.updates
      .map((update) => {
        const batch = currentById.get(update.inventoryItemId);
        if (!batch || batch.remaining_quantity <= 0) return null;
        return {
          ...update,
          expectedRowVersion: batch.row_version,
        };
      })
      .filter((entry): entry is ExactBatchUpdateIntent => entry !== null),
    creates: intent.creates,
  };
}

function rebindPresenceIntent(
  intent: PresenceIngredientIntent,
  group: Extract<InventoryReconciliationGroup, { kind: 'presence_ingredient' }>,
): PresenceIngredientIntent {
  return {
    ...intent,
    stateId: group.state.id,
    expectedIngredientRowVersion: group.ingredient_row_version,
    expectedStateRowVersion: group.state.row_version,
  };
}

function rebindFoodIntent(
  intent: FoodIntent,
  group: Extract<InventoryReconciliationGroup, { kind: 'food' }>,
): FoodIntent {
  return {
    ...intent,
    expectedRowVersion: group.row_version,
  };
}

/**
 * Replay a local draft against the latest reconciliation response.
 * Pure: never touches localStorage/todayKey/APIs. Caller injects `now` and `referenceDate`.
 */
export function replayReconciliationDraft(args: {
  draft: InventoryReconciliationDraft;
  latest: InventoryReconciliationResponse;
  familyId: string;
  userId: string;
  referenceDate: string;
  now: string;
}): DraftReplayResult {
  const { draft, latest, familyId, userId, now } = args;
  void args.referenceDate;

  if (draft.schemaVersion !== RECONCILIATION_DRAFT_SCHEMA_VERSION) {
    return {
      restoredDraft: null,
      conflicts: [],
      newlyDiscoveredTargetKeys: [],
      discardedReason: 'schema_mismatch',
    };
  }
  if (draft.familyId !== familyId) {
    return {
      restoredDraft: null,
      conflicts: [],
      newlyDiscoveredTargetKeys: [],
      discardedReason: 'family_mismatch',
    };
  }
  if (draft.userId !== userId) {
    return {
      restoredDraft: null,
      conflicts: [],
      newlyDiscoveredTargetKeys: [],
      discardedReason: 'user_mismatch',
    };
  }
  if (hoursBetweenInstants(now, draft.savedAt) > RECONCILIATION_DRAFT_TTL_HOURS) {
    return {
      restoredDraft: null,
      conflicts: [],
      newlyDiscoveredTargetKeys: [],
      discardedReason: 'expired',
    };
  }

  const latestByKey = latestGroupByTargetKey(latest);
  const draftKeys = new Set(draft.intents.map((intent) => intentTargetKey(intent)));
  const newlyDiscoveredTargetKeys = latest.groups
    .map((group) => reconciliationGroupTargetKey(group))
    .filter((key) => !draftKeys.has(key));

  const conflicts: DraftReplayConflict[] = [];
  const restoredIntents: ReconciliationIntent[] = [];

  for (const intent of draft.intents) {
    const targetKey = intentTargetKey(intent);
    const group = latestByKey.get(targetKey);

    if (!group) {
      // Kind mismatch via target key absence can also mean tracking mode changed
      // (exact key gone, presence key present under same ingredient id).
      const siblingKind =
        intent.kind === 'exact_ingredient'
          ? `presence_ingredient:${intent.ingredientId}`
          : intent.kind === 'presence_ingredient'
            ? `exact_ingredient:${intent.ingredientId}`
            : null;
      if (siblingKind && latestByKey.has(siblingKind)) {
        conflicts.push({
          targetKey,
          code: 'tracking_mode_changed',
          message: '食材跟踪方式已变化，原盘点动作已失效。',
        });
      } else {
        conflicts.push({
          targetKey,
          code: 'missing_target',
          message: '该项已不在当前盘点范围，已从本次提交中移除。',
        });
      }
      continue;
    }

    if (intent.kind === 'exact_ingredient') {
      if (group.kind !== 'exact_ingredient') {
        conflicts.push({
          targetKey,
          code: 'tracking_mode_changed',
          message: '食材跟踪方式已变化，原盘点动作已失效。',
        });
        continue;
      }
      const match = exactVersionsMatch(intent, group);
      if (!match.ok) {
        conflicts.push({ targetKey, code: match.code, message: match.message });
        // Keep a rebound intent so the user can reconfirm without losing form values where possible.
        restoredIntents.push(rebindExactIntent(intent, group));
        continue;
      }
      restoredIntents.push(intent);
      continue;
    }

    if (intent.kind === 'presence_ingredient') {
      if (group.kind !== 'presence_ingredient') {
        conflicts.push({
          targetKey,
          code: 'tracking_mode_changed',
          message: '食材跟踪方式已变化，原盘点动作已失效。',
        });
        continue;
      }
      if (
        intent.expectedIngredientRowVersion !== group.ingredient_row_version ||
        intent.expectedStateRowVersion !== group.state.row_version ||
        intent.stateId !== group.state.id
      ) {
        conflicts.push({
          targetKey,
          code: 'stale_version',
          message: '状态版本已变化，请重新确认。',
        });
        restoredIntents.push(rebindPresenceIntent(intent, group));
        continue;
      }
      restoredIntents.push(intent);
      continue;
    }

    if (intent.kind === 'food') {
      if (group.kind !== 'food') {
        conflicts.push({
          targetKey,
          code: 'tracking_mode_changed',
          message: '成品库存形态已变化，原盘点动作已失效。',
        });
        continue;
      }
      if (intent.expectedRowVersion !== group.row_version) {
        conflicts.push({
          targetKey,
          code: 'stale_version',
          message: '成品版本已变化，请重新确认。',
        });
        restoredIntents.push(rebindFoodIntent(intent, group));
        continue;
      }
      restoredIntents.push(intent);
      continue;
    }

    const _exhaustive: never = intent;
    void _exhaustive;
  }

  const restoredDraft: InventoryReconciliationDraft = {
    ...draft,
    savedAt: now,
    intents: restoredIntents,
  };

  return {
    restoredDraft,
    conflicts,
    newlyDiscoveredTargetKeys,
    discardedReason: null,
  };
}

export function sortGroupsForDisplay(args: {
  groups: InventoryReconciliationGroup[];
  draft: InventoryReconciliationDraft;
  conflictTargetKeys?: string[];
}): InventoryReconciliationGroup[] {
  const conflictSet = new Set(args.conflictTargetKeys ?? []);
  const intentKeys = new Set(args.draft.intents.map((intent) => intentTargetKey(intent)));
  const rank = (group: InventoryReconciliationGroup) => {
    const key = reconciliationGroupTargetKey(group);
    if (conflictSet.has(key)) return 0;
    if (intentKeys.has(key)) return 1;
    if (group.confirmation_status === 'never_confirmed') return 2;
    if (group.confirmation_status === 'stale') return 3;
    return 4;
  };
  return [...args.groups].sort((left, right) => {
    const rankDiff = rank(left) - rank(right);
    if (rankDiff !== 0) return rankDiff;
    const leftTitle =
      left.kind === 'food' ? left.food_name : left.ingredient_name;
    const rightTitle =
      right.kind === 'food' ? right.food_name : right.ingredient_name;
    return leftTitle.localeCompare(rightTitle, 'zh-CN');
  });
}

export function progressCounts(args: {
  groups: InventoryReconciliationGroup[];
  draft: InventoryReconciliationDraft;
}): { checked: number; total: number } {
  return {
    checked: args.draft.intents.length,
    total: args.groups.length,
  };
}

export type { InventoryOperationResult };
