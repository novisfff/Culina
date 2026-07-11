import type {
  Food,
  Ingredient,
  IngredientInventoryState,
  InventoryAvailabilityLevel,
  InventoryStatus,
  ShoppingIntakeItemRequest,
  ShoppingIntakeRequest,
  ShoppingListItem,
} from '../../api/types';
import { addCalendarDaysToDateKey } from '../../lib/date';
import { tracksIngredientQuantity } from '../../lib/ingredientTracking';

export type ShoppingIntakeStep = 'select' | 'review' | 'result';

export interface ShoppingIntakeDraftBase {
  shoppingItemId: string;
  expectedShoppingItemRowVersion: number;
  title: string;
  selected: boolean;
}

export interface ExactIngredientDraft extends ShoppingIntakeDraftBase {
  kind: 'exact_ingredient';
  targetId: string;
  expectedIngredientRowVersion: number;
  actualQuantity: string;
  unit: string;
  inventoryStatus: InventoryStatus;
  expiryDate: string | null;
  storageLocation: string;
  notes: string;
  /** Planned shopping quantity preserved for difference summaries. */
  plannedQuantity: number;
  plannedUnit: string;
  /** Ingredient default expiry mode used for validation. */
  requiresManualExpiry: boolean;
}

export interface PresenceIngredientDraft extends ShoppingIntakeDraftBase {
  kind: 'presence_ingredient';
  targetId: string;
  expectedIngredientRowVersion: number;
  stateId: string | null;
  expectedStateRowVersion: number | null;
  resultingAvailabilityLevel: Exclude<InventoryAvailabilityLevel, 'absent'>;
  inventoryStatus: InventoryStatus;
  expiryDate: string | null;
  storageLocation: string;
  notes: string;
  requiresManualExpiry: boolean;
}

export interface FoodDraft extends ShoppingIntakeDraftBase {
  kind: 'food';
  targetId: string;
  expectedFoodRowVersion: number;
  actualQuantity: string;
  unit: string;
  expiryDate: string | null;
  storageLocation: string;
  plannedQuantity: number;
  plannedUnit: string;
}

export interface FreeTextDraft extends ShoppingIntakeDraftBase {
  kind: 'free_text';
  resolution: 'unresolved' | 'complete_without_inventory';
}

export type ShoppingIntakeDraftItem =
  | ExactIngredientDraft
  | PresenceIngredientDraft
  | FoodDraft
  | FreeTextDraft;

export interface ShoppingIntakeDraft {
  clientRequestId: string;
  purchaseDate: string;
  createdAt: string;
  items: ShoppingIntakeDraftItem[];
}

export type ShoppingIntakeFieldError = {
  shoppingItemId: string;
  field: string;
  code: string;
  message: string;
};

export type PurchaseQuantitySummary =
  | { kind: 'full'; actual: number; planned: number; unit: string }
  | { kind: 'partial'; actual: number; planned: number; remaining: number; unit: string }
  | { kind: 'over'; actual: number; planned: number; unit: string }
  | { kind: 'zero'; planned: number; unit: string }
  | { kind: 'invalid'; raw: string };

export type FreeTextLinkTarget =
  | { kind: 'exact_ingredient' | 'presence_ingredient'; ingredient: Ingredient; state?: IngredientInventoryState | null }
  | { kind: 'food'; food: Food };

export type FreeTextLinkCandidate =
  | { kind: 'ingredient'; id: string; name: string; quantityTrackingMode: Ingredient['quantity_tracking_mode'] }
  | { kind: 'food'; id: string; name: string };

function normalizeName(value: string) {
  return value.trim().toLowerCase();
}

function formatQuantityString(value: number) {
  if (!Number.isFinite(value)) {
    return '0';
  }
  return String(Number(value.toFixed(4))).replace(/\.0+$/, '').replace(/(\.\d*?)0+$/, '$1');
}

function resolveInventoryStatusForStorage(storageLocation: string): InventoryStatus {
  return storageLocation.trim() === '冷冻' ? 'frozen' : 'fresh';
}

function createClientRequestId() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `intake-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function resolveDefaultExpiryDate(args: {
  ingredient: Ingredient;
  purchaseDate: string;
}): { expiryDate: string | null; requiresManualExpiry: boolean } {
  if (args.ingredient.default_expiry_mode === 'days') {
    const days = args.ingredient.default_expiry_days;
    if (days !== null && days !== undefined && days > 0) {
      return {
        expiryDate: addCalendarDaysToDateKey(args.purchaseDate, days),
        requiresManualExpiry: false,
      };
    }
    return { expiryDate: null, requiresManualExpiry: true };
  }
  if (args.ingredient.default_expiry_mode === 'manual_date') {
    return { expiryDate: null, requiresManualExpiry: true };
  }
  return { expiryDate: null, requiresManualExpiry: false };
}

function findIngredientById(ingredients: Ingredient[], id: string | null | undefined) {
  if (!id) return null;
  return ingredients.find((ingredient) => ingredient.id === id) ?? null;
}

function findFoodById(foods: Food[], id: string | null | undefined) {
  if (!id) return null;
  return foods.find((food) => food.id === id) ?? null;
}

/**
 * Exact normalized title equality only. Never substring matching
 * (牛奶 ≠ 牛奶麦片, 油 ≠ 酱油).
 */
export function findExactTitleIngredient(ingredients: Ingredient[], title: string): Ingredient | null {
  const normalized = normalizeName(title);
  if (!normalized) return null;
  const matches = ingredients.filter((ingredient) => normalizeName(ingredient.name) === normalized);
  return matches.length === 1 ? matches[0] : null;
}

export function findExactTitleFood(foods: Food[], title: string): Food | null {
  const normalized = normalizeName(title);
  if (!normalized) return null;
  const matches = foods.filter((food) => normalizeName(food.name) === normalized);
  return matches.length === 1 ? matches[0] : null;
}

/**
 * Title matching may suggest exact-name candidates but never auto-binds free text.
 */
export function suggestFreeTextLinkCandidates(args: {
  title: string;
  ingredients: Ingredient[];
  foods: Food[];
}): FreeTextLinkCandidate[] {
  const normalized = normalizeName(args.title);
  if (!normalized) return [];
  const candidates: FreeTextLinkCandidate[] = [];
  for (const ingredient of args.ingredients) {
    if (normalizeName(ingredient.name) === normalized) {
      candidates.push({
        kind: 'ingredient',
        id: ingredient.id,
        name: ingredient.name,
        quantityTrackingMode: ingredient.quantity_tracking_mode,
      });
    }
  }
  for (const food of args.foods) {
    if (normalizeName(food.name) === normalized) {
      candidates.push({
        kind: 'food',
        id: food.id,
        name: food.name,
      });
    }
  }
  return candidates;
}

function buildExactIngredientDraft(args: {
  shoppingItem: ShoppingListItem;
  ingredient: Ingredient;
  selected: boolean;
  purchaseDate: string;
}): ExactIngredientDraft {
  const storageLocation = args.ingredient.default_storage?.trim() || '常温';
  const { expiryDate, requiresManualExpiry } = resolveDefaultExpiryDate({
    ingredient: args.ingredient,
    purchaseDate: args.purchaseDate,
  });
  const unit = args.shoppingItem.unit?.trim() || args.ingredient.default_unit || '个';
  return {
    kind: 'exact_ingredient',
    shoppingItemId: args.shoppingItem.id,
    expectedShoppingItemRowVersion: args.shoppingItem.row_version,
    title: args.shoppingItem.title,
    selected: args.selected,
    targetId: args.ingredient.id,
    expectedIngredientRowVersion: args.ingredient.row_version ?? 1,
    actualQuantity: formatQuantityString(args.shoppingItem.quantity),
    unit,
    inventoryStatus: resolveInventoryStatusForStorage(storageLocation),
    expiryDate,
    storageLocation,
    notes: '',
    plannedQuantity: args.shoppingItem.quantity,
    plannedUnit: unit,
    requiresManualExpiry,
  };
}

function buildPresenceIngredientDraft(args: {
  shoppingItem: ShoppingListItem;
  ingredient: Ingredient;
  state: IngredientInventoryState | null;
  selected: boolean;
  purchaseDate: string;
}): PresenceIngredientDraft {
  const storageLocation =
    args.state?.storage_location?.trim() ||
    args.ingredient.default_storage?.trim() ||
    '常温';
  const { expiryDate, requiresManualExpiry } = resolveDefaultExpiryDate({
    ingredient: args.ingredient,
    purchaseDate: args.purchaseDate,
  });
  return {
    kind: 'presence_ingredient',
    shoppingItemId: args.shoppingItem.id,
    expectedShoppingItemRowVersion: args.shoppingItem.row_version,
    title: args.shoppingItem.title,
    selected: args.selected,
    targetId: args.ingredient.id,
    expectedIngredientRowVersion: args.ingredient.row_version ?? 1,
    stateId: args.state?.id ?? null,
    expectedStateRowVersion: args.state?.row_version ?? null,
    resultingAvailabilityLevel: 'sufficient',
    inventoryStatus: resolveInventoryStatusForStorage(storageLocation),
    expiryDate,
    storageLocation,
    notes: '',
    requiresManualExpiry,
  };
}

function buildFoodDraft(args: {
  shoppingItem: ShoppingListItem;
  food: Food;
  selected: boolean;
}): FoodDraft {
  const unit = args.food.stock_unit?.trim() || args.shoppingItem.unit?.trim() || '份';
  return {
    kind: 'food',
    shoppingItemId: args.shoppingItem.id,
    expectedShoppingItemRowVersion: args.shoppingItem.row_version,
    title: args.shoppingItem.title,
    selected: args.selected,
    targetId: args.food.id,
    expectedFoodRowVersion: args.food.row_version,
    actualQuantity: formatQuantityString(args.shoppingItem.quantity),
    unit,
    // Food has no reliable default expiry rule; leave empty rather than guessing.
    expiryDate: null,
    storageLocation: args.food.storage_location?.trim() || '常温',
    plannedQuantity: args.shoppingItem.quantity,
    plannedUnit: unit,
  };
}

function buildFreeTextDraft(args: {
  shoppingItem: ShoppingListItem;
  selected: boolean;
}): FreeTextDraft {
  return {
    kind: 'free_text',
    shoppingItemId: args.shoppingItem.id,
    expectedShoppingItemRowVersion: args.shoppingItem.row_version,
    title: args.shoppingItem.title,
    selected: args.selected,
    resolution: 'unresolved',
  };
}

function resolveDraftItem(args: {
  shoppingItem: ShoppingListItem;
  ingredients: Ingredient[];
  foods: Food[];
  inventoryStates: IngredientInventoryState[];
  selected: boolean;
  purchaseDate: string;
}): ShoppingIntakeDraftItem {
  const { shoppingItem } = args;
  const stateByIngredientId = new Map(args.inventoryStates.map((state) => [state.ingredient_id, state]));

  // Prefer stable ID binding.
  if (shoppingItem.ingredient_id) {
    const ingredient = findIngredientById(args.ingredients, shoppingItem.ingredient_id);
    if (ingredient) {
      if (tracksIngredientQuantity(ingredient)) {
        return buildExactIngredientDraft({
          shoppingItem,
          ingredient,
          selected: args.selected,
          purchaseDate: args.purchaseDate,
        });
      }
      return buildPresenceIngredientDraft({
        shoppingItem,
        ingredient,
        state: stateByIngredientId.get(ingredient.id) ?? null,
        selected: args.selected,
        purchaseDate: args.purchaseDate,
      });
    }
  }

  if (shoppingItem.food_id) {
    const food = findFoodById(args.foods, shoppingItem.food_id);
    if (food) {
      return buildFoodDraft({
        shoppingItem,
        food,
        selected: args.selected,
      });
    }
  }

  if (shoppingItem.target_type === 'free_text') {
    return buildFreeTextDraft({ shoppingItem, selected: args.selected });
  }

  // Legacy rows without a stable target may bind by normalized exact title only.
  const hasStableTarget = Boolean(shoppingItem.ingredient_id || shoppingItem.food_id);
  if (!hasStableTarget) {
    if (shoppingItem.target_type === 'food') {
      const food = findExactTitleFood(args.foods, shoppingItem.title);
      if (food) {
        return buildFoodDraft({ shoppingItem, food, selected: args.selected });
      }
    } else if (shoppingItem.target_type === 'ingredient' || !shoppingItem.target_type) {
      const ingredient = findExactTitleIngredient(args.ingredients, shoppingItem.title);
      if (ingredient) {
        if (tracksIngredientQuantity(ingredient)) {
          return buildExactIngredientDraft({
            shoppingItem,
            ingredient,
            selected: args.selected,
            purchaseDate: args.purchaseDate,
          });
        }
        return buildPresenceIngredientDraft({
          shoppingItem,
          ingredient,
          state: stateByIngredientId.get(ingredient.id) ?? null,
          selected: args.selected,
          purchaseDate: args.purchaseDate,
        });
      }
    }
  }

  return buildFreeTextDraft({ shoppingItem, selected: args.selected });
}

export function buildShoppingIntakeDraft(args: {
  shoppingItems: ShoppingListItem[];
  ingredients: Ingredient[];
  foods: Food[];
  inventoryStates?: IngredientInventoryState[];
  selectedItemId?: string;
  referenceDate: string;
  now?: string;
  clientRequestId?: string;
}): ShoppingIntakeDraft {
  const purchaseDate = args.referenceDate.slice(0, 10);
  const pendingItems = args.shoppingItems.filter((item) => !item.done);
  const selectedItemId = args.selectedItemId;
  const items = pendingItems.map((shoppingItem) =>
    resolveDraftItem({
      shoppingItem,
      ingredients: args.ingredients,
      foods: args.foods,
      inventoryStates: args.inventoryStates ?? [],
      selected: selectedItemId ? shoppingItem.id === selectedItemId : false,
      purchaseDate,
    }),
  );

  return {
    clientRequestId: args.clientRequestId ?? createClientRequestId(),
    purchaseDate,
    createdAt: args.now ?? new Date().toISOString(),
    items,
  };
}

export function getSelectedDraftItems(draft: ShoppingIntakeDraft): ShoppingIntakeDraftItem[] {
  return draft.items.filter((item) => item.selected);
}

export function setDraftItemSelected(
  draft: ShoppingIntakeDraft,
  shoppingItemId: string,
  selected: boolean,
): ShoppingIntakeDraft {
  return {
    ...draft,
    items: draft.items.map((item) =>
      item.shoppingItemId === shoppingItemId ? { ...item, selected } : item,
    ),
  };
}

export function updateDraftItem(
  draft: ShoppingIntakeDraft,
  shoppingItemId: string,
  patch: Partial<ShoppingIntakeDraftItem>,
): ShoppingIntakeDraft {
  return {
    ...draft,
    items: draft.items.map((item) => {
      if (item.shoppingItemId !== shoppingItemId) {
        return item;
      }
      return { ...item, ...patch } as ShoppingIntakeDraftItem;
    }),
  };
}

/**
 * Explicit free-text complete action. Never auto-triggered by title matching.
 */
export function completeFreeTextWithoutInventory(
  draft: ShoppingIntakeDraft,
  shoppingItemId: string,
): ShoppingIntakeDraft {
  return {
    ...draft,
    items: draft.items.map((item) => {
      if (item.shoppingItemId !== shoppingItemId || item.kind !== 'free_text') {
        return item;
      }
      return {
        ...item,
        selected: true,
        resolution: 'complete_without_inventory',
      };
    }),
  };
}

/**
 * Explicit free-text link action. Replaces FreeTextDraft with a bound draft
 * populated from the selected family target. Title matching never does this.
 */
export function linkFreeTextDraft(
  draft: ShoppingIntakeDraft,
  shoppingItemId: string,
  target: FreeTextLinkTarget,
  purchaseDate: string,
): ShoppingIntakeDraft {
  return {
    ...draft,
    items: draft.items.map((item) => {
      if (item.shoppingItemId !== shoppingItemId || item.kind !== 'free_text') {
        return item;
      }
      const syntheticShoppingItem: ShoppingListItem = {
        id: item.shoppingItemId,
        family_id: '',
        title: item.title,
        quantity: 1,
        unit: '',
        reason: '',
        done: false,
        created_at: '',
        updated_at: '',
        row_version: item.expectedShoppingItemRowVersion,
        target_type: 'free_text',
      };

      if (target.kind === 'food') {
        return {
          ...buildFoodDraft({
            shoppingItem: {
              ...syntheticShoppingItem,
              quantity: 1,
              unit: target.food.stock_unit || '份',
              food_id: target.food.id,
              target_type: 'food',
            },
            food: target.food,
            selected: true,
          }),
        };
      }

      if (tracksIngredientQuantity(target.ingredient) || target.kind === 'exact_ingredient') {
        if (!tracksIngredientQuantity(target.ingredient)) {
          return buildPresenceIngredientDraft({
            shoppingItem: {
              ...syntheticShoppingItem,
              ingredient_id: target.ingredient.id,
              target_type: 'ingredient',
              quantity_mode: 'not_track_quantity',
            },
            ingredient: target.ingredient,
            state: target.state ?? null,
            selected: true,
            purchaseDate,
          });
        }
        return buildExactIngredientDraft({
          shoppingItem: {
            ...syntheticShoppingItem,
            ingredient_id: target.ingredient.id,
            target_type: 'ingredient',
            unit: target.ingredient.default_unit || '个',
            quantity: 1,
            quantity_mode: 'track_quantity',
          },
          ingredient: target.ingredient,
          selected: true,
          purchaseDate,
        });
      }

      return buildPresenceIngredientDraft({
        shoppingItem: {
          ...syntheticShoppingItem,
          ingredient_id: target.ingredient.id,
          target_type: 'ingredient',
          quantity_mode: 'not_track_quantity',
        },
        ingredient: target.ingredient,
        state: target.state ?? null,
        selected: true,
        purchaseDate,
      });
    }),
  };
}

export function summarizePurchaseQuantity(args: {
  actualQuantity: string;
  plannedQuantity: number;
  unit: string;
}): PurchaseQuantitySummary {
  const trimmed = args.actualQuantity.trim();
  if (!trimmed) {
    return { kind: 'invalid', raw: args.actualQuantity };
  }
  const actual = Number(trimmed);
  if (!Number.isFinite(actual) || actual < 0) {
    return { kind: 'invalid', raw: args.actualQuantity };
  }
  if (actual === 0) {
    return { kind: 'zero', planned: args.plannedQuantity, unit: args.unit };
  }
  if (actual < args.plannedQuantity) {
    return {
      kind: 'partial',
      actual,
      planned: args.plannedQuantity,
      remaining: Number((args.plannedQuantity - actual).toFixed(4)),
      unit: args.unit,
    };
  }
  if (actual > args.plannedQuantity) {
    return {
      kind: 'over',
      actual,
      planned: args.plannedQuantity,
      unit: args.unit,
    };
  }
  return {
    kind: 'full',
    actual,
    planned: args.plannedQuantity,
    unit: args.unit,
  };
}

export function formatPurchaseQuantitySummary(summary: PurchaseQuantitySummary): string | null {
  if (summary.kind === 'partial') {
    return `入库 ${formatQuantityString(summary.actual)} ${summary.unit}，还差 ${formatQuantityString(summary.remaining)} ${summary.unit}`;
  }
  if (summary.kind === 'over') {
    return `按实际 ${formatQuantityString(summary.actual)} ${summary.unit} 全部入库（计划 ${formatQuantityString(summary.planned)} ${summary.unit}）`;
  }
  if (summary.kind === 'zero') {
    return '数量为 0，将视为本次未买到';
  }
  if (summary.kind === 'invalid') {
    return '请填写有效的实际数量';
  }
  return null;
}

export function validateShoppingIntakeDraft(draft: ShoppingIntakeDraft): ShoppingIntakeFieldError[] {
  const errors: ShoppingIntakeFieldError[] = [];
  const selected = getSelectedDraftItems(draft);

  if (selected.length === 0) {
    errors.push({
      shoppingItemId: '',
      field: 'items',
      code: 'empty_operation',
      message: '请先勾选本次买到的项目。',
    });
    return errors;
  }

  for (const item of selected) {
    if (item.kind === 'free_text') {
      if (item.resolution === 'unresolved') {
        errors.push({
          shoppingItemId: item.shoppingItemId,
          field: 'resolution',
          code: 'invalid_target',
          message: `「${item.title}」是自由文本，请先关联库存或标记为仅完成。`,
        });
      }
      continue;
    }

    if (item.kind === 'exact_ingredient' || item.kind === 'food') {
      const summary = summarizePurchaseQuantity({
        actualQuantity: item.actualQuantity,
        plannedQuantity: item.plannedQuantity,
        unit: item.unit,
      });
      if (summary.kind === 'invalid') {
        errors.push({
          shoppingItemId: item.shoppingItemId,
          field: 'actualQuantity',
          code: 'invalid_quantity',
          message: `请填写「${item.title}」的有效数量。`,
        });
      } else if (summary.kind === 'zero') {
        errors.push({
          shoppingItemId: item.shoppingItemId,
          field: 'actualQuantity',
          code: 'invalid_quantity',
          message: `「${item.title}」数量为 0，请取消勾选或填写实际买到的数量。`,
        });
      }
      if (!item.unit.trim()) {
        errors.push({
          shoppingItemId: item.shoppingItemId,
          field: 'unit',
          code: 'incompatible_unit',
          message: `请填写「${item.title}」的单位。`,
        });
      }
    }

    if (item.kind === 'exact_ingredient' || item.kind === 'presence_ingredient') {
      if (item.requiresManualExpiry && !item.expiryDate) {
        errors.push({
          shoppingItemId: item.shoppingItemId,
          field: 'expiryDate',
          code: 'manual_expiry_required',
          message: `「${item.title}」需要确认到期日。`,
        });
      }
      if (!item.storageLocation.trim()) {
        errors.push({
          shoppingItemId: item.shoppingItemId,
          field: 'storageLocation',
          code: 'invalid_date_range',
          message: `请填写「${item.title}」的存放位置。`,
        });
      }
    }

    if (item.kind === 'presence_ingredient') {
      if (item.resultingAvailabilityLevel === ('absent' as never)) {
        errors.push({
          shoppingItemId: item.shoppingItemId,
          field: 'resultingAvailabilityLevel',
          code: 'invalid_availability_level',
          message: `买到后不能把「${item.title}」记为没有。`,
        });
      }
    }

    if (item.kind === 'food' && !item.storageLocation.trim()) {
      errors.push({
        shoppingItemId: item.shoppingItemId,
        field: 'storageLocation',
        code: 'invalid_date_range',
        message: `请填写「${item.title}」的存放位置。`,
      });
    }
  }

  return errors;
}

export function canAdvanceToReview(draft: ShoppingIntakeDraft): boolean {
  return getSelectedDraftItems(draft).length > 0;
}

export function canSubmitIntake(draft: ShoppingIntakeDraft): boolean {
  return validateShoppingIntakeDraft(draft).length === 0;
}

function parsePositiveQuantity(value: string): number {
  const numeric = Number(value.trim());
  if (!Number.isFinite(numeric) || numeric <= 0) {
    throw new Error(`invalid quantity: ${value}`);
  }
  return numeric;
}

export function buildShoppingIntakePayload(draft: ShoppingIntakeDraft): ShoppingIntakeRequest {
  const selected = getSelectedDraftItems(draft);
  if (selected.length === 0) {
    throw new Error('empty_operation');
  }

  const items: ShoppingIntakeItemRequest[] = selected.map((item) => {
    if (item.kind === 'free_text') {
      if (item.resolution !== 'complete_without_inventory') {
        throw new Error(`free text ${item.shoppingItemId} is unresolved`);
      }
      return {
        shopping_item_id: item.shoppingItemId,
        expected_shopping_item_row_version: item.expectedShoppingItemRowVersion,
        action: 'complete_without_inventory',
        target_kind: 'none',
        target_id: null,
      };
    }

    if (item.kind === 'exact_ingredient') {
      return {
        shopping_item_id: item.shoppingItemId,
        expected_shopping_item_row_version: item.expectedShoppingItemRowVersion,
        action: 'stock_and_fulfill',
        target_kind: 'exact_ingredient',
        target_id: item.targetId,
        expected_ingredient_row_version: item.expectedIngredientRowVersion,
        actual_quantity: parsePositiveQuantity(item.actualQuantity),
        unit: item.unit,
        inventory_status: item.inventoryStatus,
        expiry_date: item.expiryDate,
        storage_location: item.storageLocation,
        notes: item.notes,
      };
    }

    if (item.kind === 'presence_ingredient') {
      return {
        shopping_item_id: item.shoppingItemId,
        expected_shopping_item_row_version: item.expectedShoppingItemRowVersion,
        action: 'stock_and_fulfill',
        target_kind: 'presence_ingredient',
        target_id: item.targetId,
        expected_ingredient_row_version: item.expectedIngredientRowVersion,
        state_id: item.stateId,
        expected_state_row_version: item.expectedStateRowVersion,
        resulting_availability_level: item.resultingAvailabilityLevel,
        inventory_status: item.inventoryStatus,
        expiry_date: item.expiryDate,
        storage_location: item.storageLocation,
        notes: item.notes,
      };
    }

    return {
      shopping_item_id: item.shoppingItemId,
      expected_shopping_item_row_version: item.expectedShoppingItemRowVersion,
      action: 'stock_and_fulfill',
      target_kind: 'food',
      target_id: item.targetId,
      expected_food_row_version: item.expectedFoodRowVersion,
      actual_quantity: parsePositiveQuantity(item.actualQuantity),
      unit: item.unit,
      expiry_date: item.expiryDate,
      storage_location: item.storageLocation,
    };
  });

  return {
    client_request_id: draft.clientRequestId,
    purchase_date: draft.purchaseDate,
    items,
  };
}

export function collectReviewExceptions(draft: ShoppingIntakeDraft): ShoppingIntakeDraftItem[] {
  return getSelectedDraftItems(draft).filter((item) => {
    if (item.kind === 'free_text') {
      return true;
    }
    if (item.kind === 'exact_ingredient' || item.kind === 'food') {
      const summary = summarizePurchaseQuantity({
        actualQuantity: item.actualQuantity,
        plannedQuantity: item.plannedQuantity,
        unit: item.unit,
      });
      if (summary.kind !== 'full') {
        return true;
      }
    }
    if (item.kind === 'exact_ingredient' || item.kind === 'presence_ingredient') {
      if (item.requiresManualExpiry) {
        return true;
      }
    }
    if (item.kind === 'presence_ingredient' && item.resultingAvailabilityLevel !== 'sufficient') {
      return true;
    }
    return false;
  });
}
