import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Ingredient, IngredientInventoryState, InventoryItem, ShoppingListItem } from '../../api/types';
import {
  buildInventoryActionGroups,
  countUniqueAvailableIngredients,
  selectHomeEligibleInventoryActionGroups,
  selectHomeInventoryActionGroups,
  type InventoryActionGroup,
} from './inventoryActionModel';

const REFERENCE_DATE = '2026-07-11';

function makeIngredient(overrides: Partial<Ingredient> & Pick<Ingredient, 'id' | 'name'>): Ingredient {
  return {
    family_id: 'family-1',
    category: '蔬菜',
    default_unit: '个',
    unit_conversions: [],
    default_storage: '冷藏',
    default_expiry_mode: 'days',
    default_expiry_days: 7,
    default_low_stock_threshold: null,
    notes: '',
    image: null,
    created_at: '2026-07-01T00:00:00.000Z',
    updated_at: '2026-07-01T00:00:00.000Z',
    ...overrides,
  };
}

function makeInventoryItem(
  overrides: Partial<InventoryItem> & Pick<InventoryItem, 'id' | 'ingredient_id' | 'ingredient_name'>
): InventoryItem {
  return {
    family_id: 'family-1',
    quantity: 1,
    remaining_quantity: 1,
    unit: '个',
    status: 'fresh',
    purchase_date: '2026-07-01',
    expiry_date: '2026-07-12',
    storage_location: '冷藏',
    notes: '',
    low_stock_threshold: 99,
    created_at: '2026-07-01T00:00:00.000Z',
    updated_at: '2026-07-01T00:00:00.000Z',
    row_version: 1,
    expiry_alert_snoozed_until: null,
    expiry_reviewed_at: null,
    expiry_reviewed_by: null,
    ...overrides,
  };
}

function makeShoppingItem(overrides: Partial<ShoppingListItem> & Pick<ShoppingListItem, 'id' | 'title'>): ShoppingListItem {
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
    ...overrides,
  };
}


function makeInventoryState(
  overrides: Partial<IngredientInventoryState> & Pick<IngredientInventoryState, 'id' | 'ingredient_id'>
): IngredientInventoryState {
  return {
    family_id: 'family-1',
    availability_level: 'present_unknown',
    inventory_status: 'fresh',
    purchase_date: '2026-06-01',
    expiry_date: '2026-07-08',
    storage_location: '常温',
    notes: '',
    expiry_alert_snoozed_until: null,
    expiry_reviewed_at: null,
    expiry_reviewed_by: null,
    last_confirmed_at: null,
    last_confirmed_by: null,
    last_confirmation_source: null,
    row_version: 1,
    created_at: '2026-07-01T00:00:00.000Z',
    updated_at: '2026-07-01T00:00:00.000Z',
    ...overrides,
  };
}

function groupsOf(kind: InventoryActionGroup['kind'], groups: InventoryActionGroup[]) {
  return groups.filter((group) => group.kind === kind);
}

describe('buildInventoryActionGroups', () => {
  it('groups multiple batches of one ingredient into a single expiry group with mixed counts', () => {
    const tomato = makeIngredient({ id: 'ing-tomato', name: '番茄', default_unit: '个' });
    const inventoryItems = [
      makeInventoryItem({
        id: 'batch-expired-1',
        ingredient_id: tomato.id,
        ingredient_name: tomato.name,
        remaining_quantity: 2,
        unit: '个',
        expiry_date: '2026-07-08',
      }),
      makeInventoryItem({
        id: 'batch-expired-2',
        ingredient_id: tomato.id,
        ingredient_name: tomato.name,
        remaining_quantity: 3,
        unit: '个',
        expiry_date: '2026-07-09',
      }),
      makeInventoryItem({
        id: 'batch-expired-3',
        ingredient_id: tomato.id,
        ingredient_name: tomato.name,
        remaining_quantity: 1,
        unit: '个',
        expiry_date: '2026-07-10',
      }),
      makeInventoryItem({
        id: 'batch-soon-1',
        ingredient_id: tomato.id,
        ingredient_name: tomato.name,
        remaining_quantity: 4,
        unit: '个',
        expiry_date: '2026-07-13',
      }),
      makeInventoryItem({
        id: 'batch-soon-2',
        ingredient_id: tomato.id,
        ingredient_name: tomato.name,
        remaining_quantity: 2,
        unit: '个',
        expiry_date: '2026-07-14',
      }),
    ];

    const groups = buildInventoryActionGroups({
      inventoryItems,
      ingredients: [tomato],
      shoppingItems: [],
      referenceDate: REFERENCE_DATE,
    });

    expect(groups).toHaveLength(1);
    const group = groups[0];
    expect(group).toMatchObject({
      kind: 'expiry',
      ingredientId: tomato.id,
      ingredientName: '番茄',
      severity: 'expired',
      expiredBatchCount: 3,
      todayBatchCount: 0,
      soonBatchCount: 2,
      laterBatchCount: 0,
      totalBatchCount: 5,
      title: '番茄需要处理',
      detail: '3 批已过期，2 批 3 天内到期',
      primaryAction: 'manage_expiry',
    });
    if (group?.kind === 'expiry') {
      expect(group.quantityLabels).toEqual(['12 个']);
      expect(group.batches).toHaveLength(5);
      expect(group.batches.every((batch) => batch.rowVersion === 1)).toBe(true);
    }
  });

  it('maps exact day boundaries and excludes rows outside the seven-day window', () => {
    const milk = makeIngredient({ id: 'ing-milk', name: '牛奶', default_unit: '盒' });
    const inventoryItems = [
      makeInventoryItem({
        id: 'expired',
        ingredient_id: milk.id,
        ingredient_name: milk.name,
        unit: '盒',
        expiry_date: '2026-07-10',
      }),
      makeInventoryItem({
        id: 'today',
        ingredient_id: milk.id,
        ingredient_name: milk.name,
        unit: '盒',
        expiry_date: '2026-07-11',
      }),
      makeInventoryItem({
        id: 'soon-1',
        ingredient_id: milk.id,
        ingredient_name: milk.name,
        unit: '盒',
        expiry_date: '2026-07-12',
      }),
      makeInventoryItem({
        id: 'soon-3',
        ingredient_id: milk.id,
        ingredient_name: milk.name,
        unit: '盒',
        expiry_date: '2026-07-14',
      }),
      makeInventoryItem({
        id: 'later-4',
        ingredient_id: milk.id,
        ingredient_name: milk.name,
        unit: '盒',
        expiry_date: '2026-07-15',
      }),
      makeInventoryItem({
        id: 'later-7',
        ingredient_id: milk.id,
        ingredient_name: milk.name,
        unit: '盒',
        expiry_date: '2026-07-18',
      }),
      makeInventoryItem({
        id: 'outside',
        ingredient_id: milk.id,
        ingredient_name: milk.name,
        unit: '盒',
        expiry_date: '2026-07-19',
      }),
      makeInventoryItem({
        id: 'no-expiry',
        ingredient_id: milk.id,
        ingredient_name: milk.name,
        unit: '盒',
        expiry_date: null,
      }),
      makeInventoryItem({
        id: 'exhausted',
        ingredient_id: milk.id,
        ingredient_name: milk.name,
        unit: '盒',
        remaining_quantity: 0,
        expiry_date: '2026-07-11',
      }),
    ];

    const groups = buildInventoryActionGroups({
      inventoryItems,
      ingredients: [milk],
      shoppingItems: [],
      referenceDate: REFERENCE_DATE,
    });

    expect(groups).toHaveLength(1);
    const group = groups[0];
    expect(group).toMatchObject({
      kind: 'expiry',
      expiredBatchCount: 1,
      todayBatchCount: 1,
      soonBatchCount: 2,
      laterBatchCount: 2,
      totalBatchCount: 6,
    });
    if (group?.kind === 'expiry') {
      expect(group.batches.map((batch) => batch.inventoryItemId).sort()).toEqual(
        ['expired', 'later-4', 'later-7', 'soon-1', 'soon-3', 'today'].sort()
      );
      expect(group.batches.find((batch) => batch.inventoryItemId === 'expired')?.daysLeft).toBe(-1);
      expect(group.batches.find((batch) => batch.inventoryItemId === 'today')?.daysLeft).toBe(0);
      expect(group.batches.find((batch) => batch.inventoryItemId === 'soon-3')?.daysLeft).toBe(3);
      expect(group.batches.find((batch) => batch.inventoryItemId === 'later-4')?.daysLeft).toBe(4);
      expect(group.batches.find((batch) => batch.inventoryItemId === 'later-7')?.daysLeft).toBe(7);
    }
  });

  it('excludes snoozed rows before the snooze date and returns them on that date', () => {
    const tomato = makeIngredient({ id: 'ing-tomato', name: '番茄' });
    const inventoryItems = [
      makeInventoryItem({
        id: 'snoozed',
        ingredient_id: tomato.id,
        ingredient_name: tomato.name,
        expiry_date: '2026-07-08',
        expiry_alert_snoozed_until: '2026-07-14',
      }),
      makeInventoryItem({
        id: 'active',
        ingredient_id: tomato.id,
        ingredient_name: tomato.name,
        expiry_date: '2026-07-12',
      }),
    ];

    const before = buildInventoryActionGroups({
      inventoryItems,
      ingredients: [tomato],
      shoppingItems: [],
      referenceDate: '2026-07-13',
    });
    expect(before).toHaveLength(1);
    if (before[0]?.kind === 'expiry') {
      expect(before[0].batches.map((batch) => batch.inventoryItemId)).toEqual(['active']);
    }

    const onDate = buildInventoryActionGroups({
      inventoryItems,
      ingredients: [tomato],
      shoppingItems: [],
      referenceDate: '2026-07-14',
    });
    expect(onDate).toHaveLength(1);
    if (onDate[0]?.kind === 'expiry') {
      expect(onDate[0].batches.map((batch) => batch.inventoryItemId).sort()).toEqual(['active', 'snoozed']);
    }
  });

  it('emits low stock only for quantity-tracked ingredients using ingredient thresholds and non-expired available qty', () => {
    const eggs = makeIngredient({
      id: 'ing-eggs',
      name: '鸡蛋',
      default_unit: '个',
      default_low_stock_threshold: 6,
    });
    const oil = makeIngredient({
      id: 'ing-oil',
      name: '油',
      default_unit: '瓶',
      quantity_tracking_mode: 'not_track_quantity',
      default_low_stock_threshold: 1,
    });
    const milk = makeIngredient({
      id: 'ing-milk',
      name: '牛奶',
      default_unit: '盒',
      default_low_stock_threshold: 2,
    });
    const yogurt = makeIngredient({
      id: 'ing-yogurt',
      name: '酸奶',
      default_unit: '瓶',
      default_low_stock_threshold: 3,
    });

    const inventoryItems = [
      makeInventoryItem({
        id: 'eggs-available',
        ingredient_id: eggs.id,
        ingredient_name: eggs.name,
        remaining_quantity: 4,
        unit: '个',
        expiry_date: '2026-07-20',
        low_stock_threshold: 1,
      }),
      makeInventoryItem({
        id: 'eggs-expired-remaining-excluded-from-available',
        ingredient_id: eggs.id,
        ingredient_name: eggs.name,
        remaining_quantity: 10,
        unit: '个',
        // Expired remaining stays excluded from low-stock available quantity. Future snooze
        // keeps it out of the expiry action queue so this case can assert low-stock emission.
        expiry_date: '2026-07-01',
        expiry_alert_snoozed_until: '2026-07-20',
        low_stock_threshold: 1,
      }),
      makeInventoryItem({
        id: 'oil-available',
        ingredient_id: oil.id,
        ingredient_name: oil.name,
        remaining_quantity: 1,
        unit: '瓶',
        expiry_date: null,
      }),
      makeInventoryItem({
        id: 'milk-available',
        ingredient_id: milk.id,
        ingredient_name: milk.name,
        remaining_quantity: 5,
        unit: '盒',
        expiry_date: '2026-07-20',
        low_stock_threshold: 100,
      }),
      makeInventoryItem({
        id: 'yogurt-available',
        ingredient_id: yogurt.id,
        ingredient_name: yogurt.name,
        remaining_quantity: 5,
        unit: '瓶',
        expiry_date: null,
        low_stock_threshold: 1,
      }),
    ];

    const groups = buildInventoryActionGroups({
      inventoryItems,
      ingredients: [eggs, oil, milk, yogurt],
      shoppingItems: [],
      referenceDate: REFERENCE_DATE,
    });

    expect(groupsOf('low_stock', groups)).toHaveLength(1);
    expect(groups[0]).toMatchObject({
      kind: 'low_stock',
      ingredientId: eggs.id,
      ingredientName: '鸡蛋',
      availableQuantity: 4,
      unit: '个',
      threshold: 6,
      title: '鸡蛋库存不足',
      detail: '现有 4 个，补货线 6 个',
      primaryAction: 'add_shopping',
    });
  });

  it('dedupes pending shopping by ingredient id first and rejects substring collisions', () => {
    const milk = makeIngredient({
      id: 'ing-milk',
      name: '牛奶',
      default_unit: '盒',
      default_low_stock_threshold: 2,
    });
    const cereal = makeIngredient({
      id: 'ing-cereal',
      name: '牛奶麦片',
      default_unit: '袋',
      default_low_stock_threshold: 1,
    });
    const inventoryItems = [
      makeInventoryItem({
        id: 'milk-1',
        ingredient_id: milk.id,
        ingredient_name: milk.name,
        remaining_quantity: 1,
        unit: '盒',
        expiry_date: null,
      }),
      makeInventoryItem({
        id: 'cereal-1',
        ingredient_id: cereal.id,
        ingredient_name: cereal.name,
        remaining_quantity: 1,
        unit: '袋',
        expiry_date: null,
      }),
    ];

    const withBoundShopping = buildInventoryActionGroups({
      inventoryItems,
      ingredients: [milk, cereal],
      shoppingItems: [
        makeShoppingItem({
          id: 'shop-milk',
          title: '随便改过的标题',
          ingredient_id: milk.id,
          target_type: 'ingredient',
        }),
      ],
      referenceDate: REFERENCE_DATE,
    });
    expect(withBoundShopping.map((group) => group.ingredientId)).toEqual([cereal.id]);

    const withExactLegacyCereal = buildInventoryActionGroups({
      inventoryItems,
      ingredients: [milk, cereal],
      shoppingItems: [
        makeShoppingItem({
          id: 'shop-cereal-title',
          title: '牛奶麦片',
          ingredient_id: null,
          target_type: 'ingredient',
        }),
      ],
      referenceDate: REFERENCE_DATE,
    });
    // Exact legacy name suppresses only cereal; milk is not substring-matched.
    expect(withExactLegacyCereal.map((group) => group.ingredientId)).toEqual([milk.id]);

    const withSubstringOilTitle = buildInventoryActionGroups({
      inventoryItems: [
        makeInventoryItem({
          id: 'oil-1',
          ingredient_id: 'ing-oil',
          ingredient_name: '油',
          remaining_quantity: 1,
          unit: '瓶',
          expiry_date: null,
        }),
      ],
      ingredients: [
        makeIngredient({
          id: 'ing-oil',
          name: '油',
          default_unit: '瓶',
          default_low_stock_threshold: 1,
        }),
      ],
      shoppingItems: [
        makeShoppingItem({
          id: 'shop-soy',
          title: '酱油',
          ingredient_id: null,
          target_type: 'ingredient',
        }),
      ],
      referenceDate: REFERENCE_DATE,
    });
    expect(withSubstringOilTitle.map((group) => group.ingredientId)).toEqual(['ing-oil']);
  });

  it('uses normalized exact-name fallback only for legacy rows without ingredient id', () => {
    const oil = makeIngredient({
      id: 'ing-oil',
      name: '油',
      default_unit: '瓶',
      default_low_stock_threshold: 1,
    });
    const soy = makeIngredient({
      id: 'ing-soy',
      name: '酱油',
      default_unit: '瓶',
      default_low_stock_threshold: 1,
    });
    const inventoryItems = [
      makeInventoryItem({
        id: 'oil-1',
        ingredient_id: oil.id,
        ingredient_name: oil.name,
        remaining_quantity: 1,
        unit: '瓶',
        expiry_date: null,
      }),
      makeInventoryItem({
        id: 'soy-1',
        ingredient_id: soy.id,
        ingredient_name: soy.name,
        remaining_quantity: 1,
        unit: '瓶',
        expiry_date: null,
      }),
    ];

    const groups = buildInventoryActionGroups({
      inventoryItems,
      ingredients: [oil, soy],
      shoppingItems: [
        makeShoppingItem({
          id: 'shop-oil',
          title: ' 油 ',
          ingredient_id: null,
          target_type: 'ingredient',
        }),
      ],
      referenceDate: REFERENCE_DATE,
    });

    expect(groups.map((group) => group.ingredientId)).toEqual([soy.id]);
  });

  it('lets expiry win over low stock for the same ingredient', () => {
    const eggs = makeIngredient({
      id: 'ing-eggs',
      name: '鸡蛋',
      default_unit: '个',
      default_low_stock_threshold: 10,
    });
    const groups = buildInventoryActionGroups({
      inventoryItems: [
        makeInventoryItem({
          id: 'eggs-soon',
          ingredient_id: eggs.id,
          ingredient_name: eggs.name,
          remaining_quantity: 2,
          unit: '个',
          expiry_date: '2026-07-12',
        }),
      ],
      ingredients: [eggs],
      shoppingItems: [],
      referenceDate: REFERENCE_DATE,
    });

    expect(groups).toHaveLength(1);
    expect(groups[0]?.kind).toBe('expiry');
    expect(groups[0]?.ingredientId).toBe(eggs.id);
  });

  it('orders groups by severity then earliest date then name then id', () => {
    const ingredients = [
      makeIngredient({ id: 'ing-b', name: '香蕉', default_low_stock_threshold: 5 }),
      makeIngredient({ id: 'ing-a', name: '苹果' }),
      makeIngredient({ id: 'ing-c', name: '橙子' }),
      makeIngredient({ id: 'ing-d', name: '豆腐' }),
      makeIngredient({ id: 'ing-e', name: '菠菜' }),
    ];
    const inventoryItems = [
      makeInventoryItem({
        id: 'later',
        ingredient_id: 'ing-e',
        ingredient_name: '菠菜',
        expiry_date: '2026-07-16',
      }),
      makeInventoryItem({
        id: 'soon',
        ingredient_id: 'ing-d',
        ingredient_name: '豆腐',
        expiry_date: '2026-07-13',
      }),
      makeInventoryItem({
        id: 'today',
        ingredient_id: 'ing-c',
        ingredient_name: '橙子',
        expiry_date: '2026-07-11',
      }),
      makeInventoryItem({
        id: 'expired',
        ingredient_id: 'ing-a',
        ingredient_name: '苹果',
        expiry_date: '2026-07-09',
      }),
      makeInventoryItem({
        id: 'low',
        ingredient_id: 'ing-b',
        ingredient_name: '香蕉',
        remaining_quantity: 1,
        expiry_date: null,
      }),
    ];

    const groups = buildInventoryActionGroups({
      inventoryItems,
      ingredients,
      shoppingItems: [],
      referenceDate: REFERENCE_DATE,
    });

    expect(groups.map((group) => group.ingredientName)).toEqual(['苹果', '橙子', '豆腐', '香蕉', '菠菜']);
  });

  it('builds gold Chinese title and detail strings for today-only and low-stock groups', () => {
    const milk = makeIngredient({ id: 'ing-milk', name: '牛奶', default_unit: '盒' });
    const eggs = makeIngredient({
      id: 'ing-eggs',
      name: '鸡蛋',
      default_unit: '个',
      default_low_stock_threshold: 6,
    });

    const groups = buildInventoryActionGroups({
      inventoryItems: [
        makeInventoryItem({
          id: 'milk-1',
          ingredient_id: milk.id,
          ingredient_name: milk.name,
          remaining_quantity: 1,
          unit: '盒',
          storage_location: '冷藏',
          expiry_date: '2026-07-11',
        }),
        makeInventoryItem({
          id: 'milk-2',
          ingredient_id: milk.id,
          ingredient_name: milk.name,
          remaining_quantity: 1,
          unit: '盒',
          storage_location: '冷藏',
          expiry_date: '2026-07-11',
        }),
        makeInventoryItem({
          id: 'eggs-1',
          ingredient_id: eggs.id,
          ingredient_name: eggs.name,
          remaining_quantity: 4,
          unit: '个',
          expiry_date: null,
        }),
      ],
      ingredients: [milk, eggs],
      shoppingItems: [],
      referenceDate: REFERENCE_DATE,
    });

    const milkGroup = groups.find((group) => group.ingredientId === milk.id);
    const eggsGroup = groups.find((group) => group.ingredientId === eggs.id);
    expect(milkGroup).toMatchObject({
      title: '牛奶今天到期',
      detail: '2 盒 · 冷藏',
    });
    expect(eggsGroup).toMatchObject({
      title: '鸡蛋库存不足',
      detail: '现有 4 个，补货线 6 个',
    });
  });

  it('combines identical quantity units and leaves unlike units separate', () => {
    const tomato = makeIngredient({ id: 'ing-tomato', name: '番茄' });
    const groups = buildInventoryActionGroups({
      inventoryItems: [
        makeInventoryItem({
          id: 'a',
          ingredient_id: tomato.id,
          ingredient_name: tomato.name,
          remaining_quantity: 2,
          unit: '盒',
          expiry_date: '2026-07-10',
        }),
        makeInventoryItem({
          id: 'b',
          ingredient_id: tomato.id,
          ingredient_name: tomato.name,
          remaining_quantity: 1,
          unit: '盒',
          expiry_date: '2026-07-10',
        }),
        makeInventoryItem({
          id: 'c',
          ingredient_id: tomato.id,
          ingredient_name: tomato.name,
          remaining_quantity: 500,
          unit: '克',
          expiry_date: '2026-07-10',
        }),
      ],
      ingredients: [tomato],
      shoppingItems: [],
      referenceDate: REFERENCE_DATE,
    });

    expect(groups[0]?.kind).toBe('expiry');
    if (groups[0]?.kind === 'expiry') {
      expect(groups[0].quantityLabels).toEqual(['3 盒', '500 克']);
    }
  });


  it('creates one State-target expiry group without inventing InventoryItem IDs', () => {
    const salt = makeIngredient({
      id: 'ingredient-salt',
      name: '盐',
      quantity_tracking_mode: 'not_track_quantity',
      default_storage: '常温',
    });
    const state = makeInventoryState({
      id: 'inventory-state-salt',
      ingredient_id: salt.id,
      expiry_date: '2026-07-08',
      storage_location: '常温',
    });
    const groups = buildInventoryActionGroups({
      inventoryItems: [
        makeInventoryItem({
          id: 'legacy-placeholder',
          ingredient_id: salt.id,
          ingredient_name: salt.name,
          remaining_quantity: 1,
          expiry_date: '2026-07-08',
        }),
      ],
      inventoryStates: [state],
      ingredients: [salt],
      shoppingItems: [],
      referenceDate: REFERENCE_DATE,
    });
    expect(groups).toHaveLength(1);
    const group = groups[0];
    expect(group).toMatchObject({
      kind: 'expiry',
      ingredientId: salt.id,
      targetKind: 'ingredient_inventory_state',
      severity: 'expired',
      totalBatchCount: 1,
    });
    if (group?.kind === 'expiry') {
      expect(group.detail).toContain('只记录整体有无');
      expect(group.batches).toHaveLength(1);
      expect(group.batches[0]?.target).toEqual({
        targetKind: 'ingredient_inventory_state',
        ingredientId: salt.id,
        stateId: state.id,
        expectedRowVersion: 1,
      });
      expect(group.batches[0]?.inventoryItemId.startsWith('state:')).toBe(true);
      expect(group.batches[0]?.inventoryItemId).not.toBe('legacy-placeholder');
    }
  });

  it('excludes absent and future-snoozed State by the same reference-date rules as batches', () => {
    const salt = makeIngredient({
      id: 'ingredient-salt',
      name: '盐',
      quantity_tracking_mode: 'not_track_quantity',
    });
    const pepper = makeIngredient({
      id: 'ingredient-pepper',
      name: '胡椒',
      quantity_tracking_mode: 'not_track_quantity',
    });
    const groups = buildInventoryActionGroups({
      inventoryItems: [],
      inventoryStates: [
        makeInventoryState({
          id: 'state-absent',
          ingredient_id: salt.id,
          availability_level: 'absent',
          expiry_date: '2026-07-08',
        }),
        makeInventoryState({
          id: 'state-snoozed',
          ingredient_id: pepper.id,
          expiry_date: '2026-07-08',
          expiry_alert_snoozed_until: '2026-07-15',
        }),
      ],
      ingredients: [salt, pepper],
      shoppingItems: [],
      referenceDate: REFERENCE_DATE,
    });
    expect(groups).toEqual([]);
  });

  it('uses injected referenceDate and never device-local todayKey', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2030-01-01T12:00:00.000Z'));

    const tomato = makeIngredient({ id: 'ing-tomato', name: '番茄' });
    const groups = buildInventoryActionGroups({
      inventoryItems: [
        makeInventoryItem({
          id: 'batch',
          ingredient_id: tomato.id,
          ingredient_name: tomato.name,
          expiry_date: '2026-07-12',
        }),
      ],
      ingredients: [tomato],
      shoppingItems: [],
      referenceDate: REFERENCE_DATE,
    });

    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({
      kind: 'expiry',
      severity: 'expires_soon',
    });
    if (groups[0]?.kind === 'expiry') {
      expect(groups[0].earliestDaysLeft).toBe(1);
    }
  });

  it('keeps UTC calendar-key arithmetic correct across a daylight-saving transition', () => {
    const milk = makeIngredient({ id: 'ing-milk', name: '牛奶', default_unit: '盒' });
    // 2026-03-08 is the US spring-forward date; local midnight math can drift.
    const groups = buildInventoryActionGroups({
      inventoryItems: [
        makeInventoryItem({
          id: 'dst-batch',
          ingredient_id: milk.id,
          ingredient_name: milk.name,
          unit: '盒',
          expiry_date: '2026-03-10',
        }),
      ],
      ingredients: [milk],
      shoppingItems: [],
      referenceDate: '2026-03-07',
    });

    expect(groups).toHaveLength(1);
    if (groups[0]?.kind === 'expiry') {
      expect(groups[0].earliestDaysLeft).toBe(3);
      expect(groups[0].batches[0]?.daysLeft).toBe(3);
      expect(groups[0].severity).toBe('expires_soon');
    }
  });
});

describe('home inventory action selectors', () => {
  it('excludes expires_later from home eligibility and limits rendered rows to three', () => {
    const ingredients = Array.from({ length: 6 }, (_, index) =>
      makeIngredient({
        id: `ing-${index}`,
        name: `食材${index}`,
        default_low_stock_threshold: index === 5 ? 10 : null,
      })
    );
    const inventoryItems = [
      makeInventoryItem({
        id: 'expired',
        ingredient_id: 'ing-0',
        ingredient_name: '食材0',
        expiry_date: '2026-07-09',
      }),
      makeInventoryItem({
        id: 'today',
        ingredient_id: 'ing-1',
        ingredient_name: '食材1',
        expiry_date: '2026-07-11',
      }),
      makeInventoryItem({
        id: 'soon-a',
        ingredient_id: 'ing-2',
        ingredient_name: '食材2',
        expiry_date: '2026-07-12',
      }),
      makeInventoryItem({
        id: 'soon-b',
        ingredient_id: 'ing-3',
        ingredient_name: '食材3',
        expiry_date: '2026-07-13',
      }),
      makeInventoryItem({
        id: 'later',
        ingredient_id: 'ing-4',
        ingredient_name: '食材4',
        expiry_date: '2026-07-16',
      }),
      makeInventoryItem({
        id: 'low',
        ingredient_id: 'ing-5',
        ingredient_name: '食材5',
        remaining_quantity: 1,
        expiry_date: null,
      }),
    ];

    const groups = buildInventoryActionGroups({
      inventoryItems,
      ingredients,
      shoppingItems: [],
      referenceDate: REFERENCE_DATE,
    });
    const eligible = selectHomeEligibleInventoryActionGroups(groups);
    const visible = selectHomeInventoryActionGroups(groups, 3);

    expect(eligible.map((group) => group.ingredientId)).toEqual(['ing-0', 'ing-1', 'ing-2', 'ing-3', 'ing-5']);
    expect(eligible.some((group) => group.kind === 'expiry' && group.severity === 'expires_later')).toBe(false);
    expect(visible).toHaveLength(3);
    expect(visible.map((group) => group.ingredientId)).toEqual(['ing-0', 'ing-1', 'ing-2']);
    expect(new Set(eligible.map((group) => group.ingredientId)).size).toBe(eligible.length);
  });
});

describe('countUniqueAvailableIngredients', () => {
  it('counts unique non-expired available ingredients once', () => {
    const tomato = makeIngredient({ id: 'ing-tomato', name: '番茄' });
    const milk = makeIngredient({ id: 'ing-milk', name: '牛奶' });
    const count = countUniqueAvailableIngredients({
      inventoryItems: [
        makeInventoryItem({
          id: 't1',
          ingredient_id: tomato.id,
          ingredient_name: tomato.name,
          remaining_quantity: 2,
          expiry_date: '2026-07-20',
        }),
        makeInventoryItem({
          id: 't2',
          ingredient_id: tomato.id,
          ingredient_name: tomato.name,
          remaining_quantity: 1,
          expiry_date: '2026-07-21',
        }),
        makeInventoryItem({
          id: 'm-expired',
          ingredient_id: milk.id,
          ingredient_name: milk.name,
          remaining_quantity: 1,
          expiry_date: '2026-07-01',
        }),
        makeInventoryItem({
          id: 'm-empty',
          ingredient_id: milk.id,
          ingredient_name: milk.name,
          remaining_quantity: 0,
          expiry_date: '2026-07-20',
        }),
      ],
      referenceDate: REFERENCE_DATE,
    });

    expect(count).toBe(1);
  });
});

afterEach(() => {
  vi.useRealTimers();
});
