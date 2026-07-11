import { describe, expect, it } from 'vitest';
import type { Food, Ingredient, IngredientInventoryState, ShoppingListItem } from '../../api/types';
import {
  buildShoppingIntakeDraft,
  buildShoppingIntakePayload,
  canAdvanceToReview,
  canSubmitIntake,
  collectReviewExceptions,
  completeFreeTextWithoutInventory,
  findExactTitleFood,
  findExactTitleIngredient,
  formatPurchaseQuantitySummary,
  linkFreeTextDraft,
  setDraftItemSelected,
  suggestFreeTextLinkCandidates,
  summarizePurchaseQuantity,
  updateDraftItem,
  validateShoppingIntakeDraft,
  type ExactIngredientDraft,
  type FoodDraft,
  type FreeTextDraft,
  type PresenceIngredientDraft,
} from './shoppingIntakeModel';

const REFERENCE_DATE = '2026-07-11';
const NOW = '2026-07-11T08:00:00.000Z';

function makeIngredient(overrides: Partial<Ingredient> & Pick<Ingredient, 'id' | 'name'>): Ingredient {
  return {
    family_id: 'family-1',
    category: '食材',
    default_unit: '个',
    unit_conversions: [],
    quantity_tracking_mode: 'track_quantity',
    default_storage: '冷藏',
    default_expiry_mode: 'days',
    default_expiry_days: 7,
    default_low_stock_threshold: null,
    notes: '',
    image: null,
    row_version: 3,
    created_at: '2026-07-01T00:00:00.000Z',
    updated_at: '2026-07-01T00:00:00.000Z',
    ...overrides,
  };
}

function makeFood(overrides: Partial<Food> & Pick<Food, 'id' | 'name'>): Food {
  return {
    family_id: 'family-1',
    type: 'readyMade',
    category: '熟食',
    flavor_tags: [],
    suitable_meal_types: ['dinner'],
    source_name: '',
    purchase_source: '',
    scene: '',
    images: [],
    notes: '',
    routine_note: '',
    stock_quantity: 2,
    stock_unit: '份',
    storage_location: '冷藏',
    favorite: false,
    row_version: 5,
    created_at: '2026-07-01T00:00:00.000Z',
    updated_at: '2026-07-01T00:00:00.000Z',
    ...overrides,
  };
}

function makeShoppingItem(
  overrides: Partial<ShoppingListItem> & Pick<ShoppingListItem, 'id' | 'title'>,
): ShoppingListItem {
  return {
    family_id: 'family-1',
    quantity: 1,
    unit: '个',
    reason: '',
    done: false,
    created_at: '2026-07-01T00:00:00.000Z',
    updated_at: '2026-07-01T00:00:00.000Z',
    target_type: 'ingredient',
    ingredient_id: null,
    food_id: null,
    row_version: 2,
    ...overrides,
  };
}

function makeState(
  overrides: Partial<IngredientInventoryState> & Pick<IngredientInventoryState, 'id' | 'ingredient_id'>,
): IngredientInventoryState {
  return {
    family_id: 'family-1',
    availability_level: 'low',
    inventory_status: 'fresh',
    purchase_date: '2026-07-01',
    expiry_date: null,
    storage_location: '常温',
    notes: '',
    expiry_alert_snoozed_until: null,
    expiry_reviewed_at: null,
    expiry_reviewed_by: null,
    last_confirmed_at: null,
    last_confirmed_by: null,
    last_confirmation_source: null,
    row_version: 4,
    created_at: '2026-07-01T00:00:00.000Z',
    updated_at: '2026-07-01T00:00:00.000Z',
    ...overrides,
  };
}

const milk = makeIngredient({ id: 'ing-milk', name: '牛奶', default_unit: '盒', default_expiry_days: 5 });
const milkCereal = makeIngredient({ id: 'ing-milk-cereal', name: '牛奶麦片', default_unit: '袋' });
const oil = makeIngredient({ id: 'ing-oil', name: '油', default_unit: '瓶', default_storage: '常温' });
const soySauce = makeIngredient({ id: 'ing-soy', name: '酱油', default_unit: '瓶', default_storage: '常温' });
const salt = makeIngredient({
  id: 'ing-salt',
  name: '盐',
  quantity_tracking_mode: 'not_track_quantity',
  default_unit: '',
  default_storage: '常温',
  default_expiry_mode: 'none',
  default_expiry_days: null,
});
const noodles = makeIngredient({
  id: 'ing-noodles',
  name: '面条',
  default_unit: '袋',
  default_expiry_mode: 'manual_date',
  default_expiry_days: null,
  default_storage: '常温',
});
const braisedBeef = makeFood({
  id: 'food-beef',
  name: '卤牛肉',
  stock_unit: '份',
  storage_location: '冷藏',
  stock_quantity: 2,
  expiry_date: '2026-07-09',
});

describe('shoppingIntakeModel', () => {
  it('batch entry starts with nothing selected', () => {
    const draft = buildShoppingIntakeDraft({
      shoppingItems: [
        makeShoppingItem({ id: 's1', title: '牛奶', ingredient_id: milk.id, quantity: 6, unit: '盒' }),
        makeShoppingItem({ id: 's2', title: '盐', ingredient_id: salt.id, target_type: 'ingredient' }),
      ],
      ingredients: [milk, salt],
      foods: [],
      referenceDate: REFERENCE_DATE,
      now: NOW,
      clientRequestId: 'client-1',
    });

    expect(draft.clientRequestId).toBe('client-1');
    expect(draft.purchaseDate).toBe(REFERENCE_DATE);
    expect(draft.items).toHaveLength(2);
    expect(draft.items.every((item) => item.selected === false)).toBe(true);
    expect(canAdvanceToReview(draft)).toBe(false);
  });

  it('single-row entry selects only that row', () => {
    const draft = buildShoppingIntakeDraft({
      shoppingItems: [
        makeShoppingItem({ id: 's1', title: '牛奶', ingredient_id: milk.id, quantity: 6, unit: '盒' }),
        makeShoppingItem({ id: 's2', title: '盐', ingredient_id: salt.id }),
      ],
      ingredients: [milk, salt],
      foods: [],
      selectedItemId: 's2',
      referenceDate: REFERENCE_DATE,
      now: NOW,
      clientRequestId: 'client-2',
    });

    expect(draft.items.find((item) => item.shoppingItemId === 's1')?.selected).toBe(false);
    expect(draft.items.find((item) => item.shoppingItemId === 's2')?.selected).toBe(true);
  });

  it('exact quantities default to planned and presence defaults to sufficient', () => {
    const draft = buildShoppingIntakeDraft({
      shoppingItems: [
        makeShoppingItem({ id: 's1', title: '牛奶', ingredient_id: milk.id, quantity: 6, unit: '盒' }),
        makeShoppingItem({ id: 's2', title: '盐', ingredient_id: salt.id }),
      ],
      ingredients: [milk, salt],
      foods: [],
      inventoryStates: [makeState({ id: 'state-salt', ingredient_id: salt.id })],
      selectedItemId: 's1',
      referenceDate: REFERENCE_DATE,
      now: NOW,
      clientRequestId: 'client-3',
    });

    const exact = draft.items.find((item) => item.shoppingItemId === 's1') as ExactIngredientDraft;
    expect(exact.kind).toBe('exact_ingredient');
    expect(exact.actualQuantity).toBe('6');
    expect(exact.unit).toBe('盒');
    expect(exact.storageLocation).toBe('冷藏');
    expect(exact.expiryDate).toBe('2026-07-16');
    expect(exact.inventoryStatus).toBe('fresh');
    expect(exact.expectedIngredientRowVersion).toBe(3);

    const presence = draft.items.find((item) => item.shoppingItemId === 's2') as PresenceIngredientDraft;
    expect(presence.kind).toBe('presence_ingredient');
    expect(presence.resultingAvailabilityLevel).toBe('sufficient');
    expect(presence.stateId).toBe('state-salt');
    expect(presence.expectedStateRowVersion).toBe(4);
    expect(presence.storageLocation).toBe('常温');
  });

  it('Food uses current stock unit and location', () => {
    const draft = buildShoppingIntakeDraft({
      shoppingItems: [
        makeShoppingItem({
          id: 's-food',
          title: '卤牛肉',
          food_id: braisedBeef.id,
          target_type: 'food',
          quantity: 1,
          unit: '盒',
        }),
      ],
      ingredients: [],
      foods: [braisedBeef],
      selectedItemId: 's-food',
      referenceDate: REFERENCE_DATE,
      now: NOW,
      clientRequestId: 'client-food',
    });

    const food = draft.items[0] as FoodDraft;
    expect(food.kind).toBe('food');
    expect(food.unit).toBe('份');
    expect(food.storageLocation).toBe('冷藏');
    expect(food.actualQuantity).toBe('1');
    expect(food.expectedFoodRowVersion).toBe(5);
    expect(food.expiryDate).toBeNull();
  });

  it('manual expiry blocks review/submit until confirmed', () => {
    const draft = buildShoppingIntakeDraft({
      shoppingItems: [
        makeShoppingItem({ id: 's-noodles', title: '面条', ingredient_id: noodles.id, quantity: 2, unit: '袋' }),
      ],
      ingredients: [noodles],
      foods: [],
      selectedItemId: 's-noodles',
      referenceDate: REFERENCE_DATE,
      now: NOW,
      clientRequestId: 'client-noodles',
    });

    const item = draft.items[0] as ExactIngredientDraft;
    expect(item.requiresManualExpiry).toBe(true);
    expect(item.expiryDate).toBeNull();
    expect(canAdvanceToReview(draft)).toBe(true);
    expect(canSubmitIntake(draft)).toBe(false);

    const errors = validateShoppingIntakeDraft(draft);
    expect(errors.some((error) => error.code === 'manual_expiry_required')).toBe(true);

    const withExpiry = updateDraftItem(draft, 's-noodles', { expiryDate: '2026-08-01' });
    expect(canSubmitIntake(withExpiry)).toBe(true);
  });

  it('partial and over-purchase summaries are exact', () => {
    const partial = summarizePurchaseQuantity({ actualQuantity: '2', plannedQuantity: 6, unit: '盒' });
    expect(partial).toEqual({ kind: 'partial', actual: 2, planned: 6, remaining: 4, unit: '盒' });
    expect(formatPurchaseQuantitySummary(partial)).toBe('入库 2 盒，还差 4 盒');

    const over = summarizePurchaseQuantity({ actualQuantity: '8', plannedQuantity: 6, unit: '盒' });
    expect(over).toEqual({ kind: 'over', actual: 8, planned: 6, unit: '盒' });
    expect(formatPurchaseQuantitySummary(over)).toContain('按实际 8 盒');

    const full = summarizePurchaseQuantity({ actualQuantity: '6', plannedQuantity: 6, unit: '盒' });
    expect(full.kind).toBe('full');
    expect(formatPurchaseQuantitySummary(full)).toBeNull();
  });

  it('free text has only explicit complete/link actions and never auto-binds by substring', () => {
    const draft = buildShoppingIntakeDraft({
      shoppingItems: [
        makeShoppingItem({ id: 's-paper', title: '厨房纸', target_type: 'free_text' }),
        makeShoppingItem({ id: 's-milk-text', title: '牛奶', target_type: 'free_text' }),
      ],
      ingredients: [milk, milkCereal, oil, soySauce],
      foods: [],
      selectedItemId: 's-paper',
      referenceDate: REFERENCE_DATE,
      now: NOW,
      clientRequestId: 'client-free',
    });

    const freeText = draft.items.find((item) => item.shoppingItemId === 's-paper') as FreeTextDraft;
    expect(freeText.kind).toBe('free_text');
    expect(freeText.resolution).toBe('unresolved');

    // Suggestions use exact title only — 牛奶 never matches 牛奶麦片.
    expect(suggestFreeTextLinkCandidates({ title: '牛奶', ingredients: [milk, milkCereal], foods: [] })).toEqual([
      {
        kind: 'ingredient',
        id: milk.id,
        name: '牛奶',
        quantityTrackingMode: 'track_quantity',
      },
    ]);
    expect(findExactTitleIngredient([milk, milkCereal], '牛奶')?.id).toBe(milk.id);
    expect(findExactTitleIngredient([milk, milkCereal], '牛奶麦片')?.id).toBe(milkCereal.id);
    expect(findExactTitleIngredient([oil, soySauce], '油')?.id).toBe(oil.id);
    expect(findExactTitleIngredient([oil, soySauce], '酱油')?.id).toBe(soySauce.id);
    // Substring must not match.
    expect(findExactTitleIngredient([milkCereal], '牛奶')).toBeNull();
    expect(findExactTitleIngredient([soySauce], '油')).toBeNull();
    expect(findExactTitleFood([braisedBeef], '牛肉')).toBeNull();

    // Free text rows stay free_text even when title exactly matches — no auto-bind.
    const milkText = draft.items.find((item) => item.shoppingItemId === 's-milk-text') as FreeTextDraft;
    expect(milkText.kind).toBe('free_text');

    const completed = completeFreeTextWithoutInventory(draft, 's-paper');
    const completedItem = completed.items.find((item) => item.shoppingItemId === 's-paper') as FreeTextDraft;
    expect(completedItem.resolution).toBe('complete_without_inventory');
    expect(completedItem.selected).toBe(true);

    const linked = linkFreeTextDraft(
      draft,
      's-milk-text',
      { kind: 'exact_ingredient', ingredient: milk },
      REFERENCE_DATE,
    );
    const linkedItem = linked.items.find((item) => item.shoppingItemId === 's-milk-text') as ExactIngredientDraft;
    expect(linkedItem.kind).toBe('exact_ingredient');
    expect(linkedItem.targetId).toBe(milk.id);
    expect(linkedItem.selected).toBe(true);
  });

  it('legacy rows without stable target bind by exact title only', () => {
    const draft = buildShoppingIntakeDraft({
      shoppingItems: [
        makeShoppingItem({ id: 'legacy-milk', title: '牛奶', target_type: 'ingredient', quantity: 2, unit: '盒' }),
        makeShoppingItem({ id: 'legacy-sub', title: '油', target_type: 'ingredient' }),
      ],
      ingredients: [milk, soySauce],
      foods: [],
      selectedItemId: 'legacy-milk',
      referenceDate: REFERENCE_DATE,
      now: NOW,
      clientRequestId: 'client-legacy',
    });

    const bound = draft.items.find((item) => item.shoppingItemId === 'legacy-milk');
    expect(bound?.kind).toBe('exact_ingredient');
    if (bound?.kind === 'exact_ingredient') {
      expect(bound.targetId).toBe(milk.id);
    }

    // 油 does not match 酱油 by substring.
    const unbound = draft.items.find((item) => item.shoppingItemId === 'legacy-sub');
    expect(unbound?.kind).toBe('free_text');
  });

  it('preserves decimal strings in form state and converts only in payload', () => {
    let draft = buildShoppingIntakeDraft({
      shoppingItems: [
        makeShoppingItem({ id: 's1', title: '牛奶', ingredient_id: milk.id, quantity: 1.5, unit: '盒' }),
      ],
      ingredients: [milk],
      foods: [],
      selectedItemId: 's1',
      referenceDate: REFERENCE_DATE,
      now: NOW,
      clientRequestId: 'client-decimal',
    });

    draft = updateDraftItem(draft, 's1', { actualQuantity: '2.50' });
    const item = draft.items[0] as ExactIngredientDraft;
    expect(item.actualQuantity).toBe('2.50');

    const payload = buildShoppingIntakePayload(draft);
    expect(payload.client_request_id).toBe('client-decimal');
    expect(payload.purchase_date).toBe(REFERENCE_DATE);
    expect(payload.items).toHaveLength(1);
    const first = payload.items[0];
    expect(first.action).toBe('stock_and_fulfill');
    if (first.action === 'stock_and_fulfill' && first.target_kind === 'exact_ingredient') {
      expect(first.actual_quantity).toBe(2.5);
      expect(first.unit).toBe('盒');
      expect(first.expected_ingredient_row_version).toBe(3);
    }
  });

  it('builds complete payload for presence, food, and free-text complete', () => {
    let draft = buildShoppingIntakeDraft({
      shoppingItems: [
        makeShoppingItem({ id: 's-salt', title: '盐', ingredient_id: salt.id }),
        makeShoppingItem({
          id: 's-food',
          title: '卤牛肉',
          food_id: braisedBeef.id,
          target_type: 'food',
          quantity: 1,
          unit: '份',
        }),
        makeShoppingItem({ id: 's-paper', title: '厨房纸', target_type: 'free_text' }),
      ],
      ingredients: [salt],
      foods: [braisedBeef],
      inventoryStates: [],
      referenceDate: REFERENCE_DATE,
      now: NOW,
      clientRequestId: 'client-mixed',
    });

    draft = setDraftItemSelected(draft, 's-salt', true);
    draft = setDraftItemSelected(draft, 's-food', true);
    draft = completeFreeTextWithoutInventory(draft, 's-paper');

    const payload = buildShoppingIntakePayload(draft);
    expect(payload.items).toHaveLength(3);
    expect(payload.items.map((item) => item.shopping_item_id).sort()).toEqual(['s-food', 's-paper', 's-salt']);

    const presence = payload.items.find((item) => item.shopping_item_id === 's-salt');
    expect(presence).toMatchObject({
      action: 'stock_and_fulfill',
      target_kind: 'presence_ingredient',
      resulting_availability_level: 'sufficient',
      state_id: null,
      expected_state_row_version: null,
    });

    const free = payload.items.find((item) => item.shopping_item_id === 's-paper');
    expect(free).toMatchObject({
      action: 'complete_without_inventory',
      target_kind: 'none',
      target_id: null,
    });
  });

  it('reuses provided clientRequestId and generates one when omitted', () => {
    const a = buildShoppingIntakeDraft({
      shoppingItems: [makeShoppingItem({ id: 's1', title: '牛奶', ingredient_id: milk.id })],
      ingredients: [milk],
      foods: [],
      referenceDate: REFERENCE_DATE,
      now: NOW,
      clientRequestId: 'fixed-id',
    });
    const b = buildShoppingIntakeDraft({
      shoppingItems: [makeShoppingItem({ id: 's1', title: '牛奶', ingredient_id: milk.id })],
      ingredients: [milk],
      foods: [],
      referenceDate: REFERENCE_DATE,
      now: NOW,
    });
    expect(a.clientRequestId).toBe('fixed-id');
    expect(b.clientRequestId).toBeTruthy();
    expect(b.clientRequestId).not.toBe(a.clientRequestId);
  });

  it('skips done shopping items', () => {
    const draft = buildShoppingIntakeDraft({
      shoppingItems: [
        makeShoppingItem({ id: 'done', title: '牛奶', ingredient_id: milk.id, done: true }),
        makeShoppingItem({ id: 'open', title: '盐', ingredient_id: salt.id }),
      ],
      ingredients: [milk, salt],
      foods: [],
      referenceDate: REFERENCE_DATE,
      now: NOW,
      clientRequestId: 'client-done',
    });
    expect(draft.items).toHaveLength(1);
    expect(draft.items[0].shoppingItemId).toBe('open');
  });

  it('always includes presence and free-text selected rows as review exceptions', () => {
    let draft = buildShoppingIntakeDraft({
      shoppingItems: [
        makeShoppingItem({ id: 's1', title: '牛奶', ingredient_id: milk.id, quantity: 6, unit: '盒' }),
        makeShoppingItem({ id: 's2', title: '盐', ingredient_id: salt.id }),
        makeShoppingItem({ id: 's3', title: '厨房纸', target_type: 'free_text' }),
      ],
      ingredients: [milk, salt],
      foods: [],
      inventoryStates: [makeState({ id: 'state-salt', ingredient_id: salt.id })],
      referenceDate: REFERENCE_DATE,
      now: NOW,
      clientRequestId: 'client-exceptions',
    });
    draft = setDraftItemSelected(draft, 's1', true);
    draft = setDraftItemSelected(draft, 's2', true);
    draft = setDraftItemSelected(draft, 's3', true);

    const exceptions = collectReviewExceptions(draft);
    const exceptionIds = exceptions.map((item) => item.shoppingItemId);
    // Clean exact quantity stays out of exceptions.
    expect(exceptionIds).not.toContain('s1');
    // Default-sufficient presence and free-text stay reviewable/expandable.
    expect(exceptionIds).toContain('s2');
    expect(exceptionIds).toContain('s3');
  });
});
