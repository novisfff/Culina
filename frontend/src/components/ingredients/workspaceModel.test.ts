import { describe, expect, it } from 'vitest';
import type { Ingredient, InventoryItem, Recipe, ShoppingListItem } from '../../api/types';
import { formatDate } from '../../lib/ui';
import {
  buildShoppingCards,
  buildShoppingOverview,
  buildDisposableExpiredInventoryItems,
  buildIngredientAlerts,
  buildIngredientCategoryFilters,
  buildIngredientSummaries,
  getIngredientEditorCategoryPresets,
  buildInventoryCardPresentation,
  buildInventoryCardStatus,
  buildInventoryStorageOverview,
  buildSeasoningSummaries,
  buildShoppingCardGroups,
  buildStorageGroups,
  filterShoppingCards,
  filterIngredientSummariesForInventory,
  filterIngredientSummaries,
  getIngredientCategoryPreset,
  sortInventorySummariesByExpiry,
} from './workspaceModel';
import { filterMobileCatalogSummaries } from './useIngredientWorkspaceData';

const ingredients: Ingredient[] = [
  {
    id: 'ingredient-tomato',
    family_id: 'family-1',
    name: '番茄',
    category: '蔬菜',
    default_unit: '个',
    unit_conversions: [],
    default_storage: '冷藏',
    default_expiry_mode: 'days',
    default_expiry_days: 3,
    default_low_stock_threshold: 3,
    notes: '适合番茄炒蛋',
    image: null,
    created_at: '2026-03-20T10:00:00Z',
    updated_at: '2026-03-20T10:00:00Z',
  },
  {
    id: 'ingredient-flour',
    family_id: 'family-1',
    name: '面粉',
    category: '干货',
    default_unit: 'g',
    unit_conversions: [
      { unit: '袋', ratio_to_default: 500 },
      { unit: 'kg', ratio_to_default: 1000 },
    ],
    default_storage: '常温',
    default_expiry_mode: 'none',
    default_expiry_days: null,
    default_low_stock_threshold: null,
    notes: '做面食会用到',
    image: null,
    created_at: '2026-03-20T10:00:00Z',
    updated_at: '2026-03-20T10:00:00Z',
  },
];

const inventoryItems: InventoryItem[] = [
  {
    id: 'inventory-1',
    family_id: 'family-1',
    ingredient_id: 'ingredient-tomato',
    ingredient_name: '番茄',
    quantity: 2,
    unit: '个',
    status: 'fresh',
    purchase_date: '2026-03-20',
    expiry_date: '2026-03-21',
    storage_location: '冷藏',
    notes: '需要优先吃掉',
    low_stock_threshold: 3,
    created_at: '2026-03-20T10:00:00Z',
    updated_at: '2026-03-20T11:00:00Z',
  },
  {
    id: 'inventory-2',
    family_id: 'family-1',
    ingredient_id: 'ingredient-flour',
    ingredient_name: '面粉',
    quantity: 1,
    unit: '袋',
    status: 'fresh',
    purchase_date: '2026-03-20',
    expiry_date: null,
    storage_location: '常温',
    notes: '',
    low_stock_threshold: 0,
    created_at: '2026-03-20T10:00:00Z',
    updated_at: '2026-03-20T11:00:00Z',
  },
  {
    id: 'inventory-3',
    family_id: 'family-1',
    ingredient_id: 'ingredient-flour',
    ingredient_name: '面粉',
    quantity: 2,
    unit: 'kg',
    status: 'opened',
    purchase_date: '2026-03-19',
    expiry_date: null,
    storage_location: '常温',
    notes: '散装分装',
    low_stock_threshold: 0,
    created_at: '2026-03-19T10:00:00Z',
    updated_at: '2026-03-20T09:00:00Z',
  },
];

const recipes: Recipe[] = [
  {
    id: 'recipe-1',
    family_id: 'family-1',
    title: '番茄炒蛋',
    servings: 2,
    prep_minutes: 12,
    difficulty: 'easy',
    ingredient_items: [
      {
        id: 'recipe-ingredient-1',
        ingredient_id: 'ingredient-tomato',
        ingredient_name: '番茄',
        quantity: 2,
        unit: '个',
        note: '',
      },
    ],
    steps: [{ id: 'step-1', title: '翻炒', text: '翻炒即可' }],
    tips: '',
    scene_tags: ['家常菜'],
    images: [],
    cook_logs: [],
    created_at: '2026-03-20T10:00:00Z',
    updated_at: '2026-03-20T10:00:00Z',
  },
];

const shoppingItems: ShoppingListItem[] = [
  {
    id: 'shopping-tomato',
    family_id: 'family-1',
    title: '番茄 ',
    quantity: 4,
    unit: '个',
    reason: '补充本周家常菜库存',
    done: false,
    created_at: '2026-03-20T10:00:00Z',
    updated_at: '2026-03-21T09:00:00Z',
  },
  {
    id: 'shopping-flour',
    family_id: 'family-1',
    title: '面粉',
    quantity: 1,
    unit: '袋',
    reason: '',
    done: false,
    created_at: '2026-03-20T10:00:00Z',
    updated_at: '2026-03-20T09:00:00Z',
  },
  {
    id: 'shopping-cola',
    family_id: 'family-1',
    title: '可乐',
    quantity: 2,
    unit: '瓶',
    reason: '周末聚餐备用',
    done: false,
    created_at: '2026-03-20T10:00:00Z',
    updated_at: '2026-03-22T09:00:00Z',
  },
  {
    id: 'shopping-sauce',
    family_id: 'family-1',
    title: '番茄酱',
    quantity: 1,
    unit: '瓶',
    reason: '给薯条蘸着吃',
    done: true,
    created_at: '2026-03-20T10:00:00Z',
    updated_at: '2026-03-23T09:00:00Z',
  },
];

describe('ingredient workspace model', () => {
  it('keeps all matching mobile catalog summaries for paged mobile loading', () => {
    const manyIngredients = Array.from({ length: 9 }, (_, index): Ingredient => ({
      ...ingredients[0],
      id: `ingredient-mobile-${index + 1}`,
      name: `移动食材 ${index + 1}`,
      default_storage: index % 2 === 0 ? '冷藏' : '常温',
      created_at: `2026-03-20T10:0${index % 10}:00Z`,
      updated_at: `2026-03-20T10:0${index % 10}:00Z`,
    }));
    const summaries = buildIngredientSummaries({
      ingredients: manyIngredients,
      inventoryItems: [],
      recipes: [],
      today: '2026-03-20',
    });

    const mobileCatalogSummaries = filterMobileCatalogSummaries({
      summaries,
      catalogSearch: '',
      mobileIngredientFilter: 'all',
      mobileStorageFocus: 'all',
    });

    expect(mobileCatalogSummaries).toHaveLength(9);
  });

  it('filters mobile catalog summaries to seasoning ingredients', () => {
    const saltIngredient: Ingredient = {
      ...ingredients[1],
      id: 'ingredient-salt',
      name: '盐',
      category: '调料',
      quantity_tracking_mode: 'not_track_quantity',
    };
    const oysterSauceIngredient: Ingredient = {
      ...ingredients[1],
      id: 'ingredient-oyster-sauce',
      name: '蚝油',
      category: '酱料',
      quantity_tracking_mode: 'track_quantity',
    };
    const summaries = buildIngredientSummaries({
      ingredients: [ingredients[0], saltIngredient, oysterSauceIngredient],
      inventoryItems: [],
      recipes: [],
      today: '2026-03-20',
    });

    expect(
      filterMobileCatalogSummaries({
        summaries,
        catalogSearch: '',
        mobileIngredientFilter: 'seasoning',
        mobileStorageFocus: 'all',
      }).map((item) => item.ingredient.name)
    ).toEqual(['蚝油', '盐']);
  });

  it('builds low-stock alerts by ingredient total and keeps expiry per batch', () => {
    const alerts = buildIngredientAlerts(inventoryItems, ingredients, '2026-03-20');

    expect(alerts).toHaveLength(2);
    expect(alerts.some((item) => item.kind === 'lowStock' && item.ingredientName === '番茄')).toBe(true);
    expect(alerts.some((item) => item.kind === 'expiry' && item.ingredientName === '番茄')).toBe(true);
  });

  it('shows presence status instead of fake quantities for not-tracked ingredients', () => {
    const saltIngredient: Ingredient = {
      id: 'ingredient-salt',
      family_id: 'family-1',
      name: '盐',
      category: '调料',
      default_unit: 'g',
      unit_conversions: [],
      quantity_tracking_mode: 'not_track_quantity',
      default_storage: '常温',
      default_expiry_mode: 'none',
      default_expiry_days: null,
      default_low_stock_threshold: 1,
      notes: '常备调料',
      image: null,
      created_at: '2026-03-20T10:00:00Z',
      updated_at: '2026-03-20T10:00:00Z',
    };
    const saltInventory: InventoryItem = {
      id: 'inventory-salt',
      family_id: 'family-1',
      ingredient_id: 'ingredient-salt',
      ingredient_name: '盐',
      quantity: 1,
      consumed_quantity: 1,
      disposed_quantity: 0,
      remaining_quantity: 0,
      unit: 'g',
      status: 'fresh',
      purchase_date: '2026-03-18',
      expiry_date: null,
      storage_location: '常温',
      notes: '',
      low_stock_threshold: 0,
      created_at: '2026-03-18T10:00:00Z',
      updated_at: '2026-03-20T09:00:00Z',
    };
    const saltShopping: ShoppingListItem = {
      id: 'shopping-salt',
      family_id: 'family-1',
      ingredient_id: 'ingredient-salt',
      title: '家里的盐',
      quantity: 1,
      unit: '份',
      quantity_mode: 'not_track_quantity',
      display_label: '需要补充',
      reason: '需要补充',
      done: false,
      created_at: '2026-03-20T10:00:00Z',
      updated_at: '2026-03-22T10:00:00Z',
    };
    const summaries = buildIngredientSummaries({
      ingredients: [saltIngredient],
      inventoryItems: [saltInventory],
      recipes,
      today: '2026-03-20',
    });
    const salt = summaries.find((item) => item.ingredient.id === 'ingredient-salt');
    expect(salt?.quantitySummaries.map((item) => item.label)).toEqual(['已有']);

    const cards = buildShoppingCards([saltShopping], summaries);
    const saltCard = cards.find((item) => item.shoppingItem.id === 'shopping-salt');
    expect(saltCard?.linkedSummary?.ingredient.id).toBe('ingredient-salt');
    expect(saltCard?.headline).toBe('需要补充');
    expect(saltCard?.quantityLabel).toBe('需要补充');
    expect(saltCard?.inventoryLabel).toBe('已有');
  });

  it('builds seasoning summaries from seasoning categories and not-tracked ingredients', () => {
    const saltIngredient: Ingredient = {
      ...ingredients[1],
      id: 'ingredient-salt',
      name: '盐',
      category: '调料',
      default_unit: 'g',
      quantity_tracking_mode: 'not_track_quantity',
      default_low_stock_threshold: null,
    };
    const oysterSauceIngredient: Ingredient = {
      ...ingredients[1],
      id: 'ingredient-oyster-sauce',
      name: '蚝油',
      category: '酱料',
      default_unit: '瓶',
      quantity_tracking_mode: 'track_quantity',
    };
    const saltInventory: InventoryItem = {
      ...inventoryItems[1],
      id: 'inventory-salt',
      ingredient_id: 'ingredient-salt',
      ingredient_name: '盐',
      quantity: 1,
      consumed_quantity: 1,
      remaining_quantity: 0,
      unit: 'g',
      storage_location: '常温',
    };
    const summaries = buildIngredientSummaries({
      ingredients: [ingredients[0], saltIngredient, oysterSauceIngredient],
      inventoryItems: [inventoryItems[0], saltInventory],
      recipes: [],
      today: '2026-03-20',
    });
    const seasoningSummaries = buildSeasoningSummaries(summaries);

    expect(seasoningSummaries.map((item) => [item.summary.ingredient.name, item.statusLabel])).toEqual([
      ['蚝油', '未配置'],
      ['盐', '已有'],
    ]);
  });

  it('groups shopping cards into regular food and seasoning sections', () => {
    const soySauceIngredient: Ingredient = {
      ...ingredients[1],
      id: 'ingredient-soy-sauce',
      name: '酱油',
      category: '调料',
      default_unit: '瓶',
      quantity_tracking_mode: 'not_track_quantity',
    };
    const summaries = buildIngredientSummaries({
      ingredients: [ingredients[0], soySauceIngredient],
      inventoryItems: [inventoryItems[0]],
      recipes: [],
      today: '2026-03-20',
    });
    const cards = buildShoppingCards(
      [
        shoppingItems[0],
        {
          ...shoppingItems[1],
          id: 'shopping-soy-sauce',
          ingredient_id: 'ingredient-soy-sauce',
          title: '酱油',
          unit: '瓶',
          quantity_mode: 'not_track_quantity',
          display_label: '需要补充',
          reason: '需要补充',
        },
      ],
      summaries
    );
    const groups = buildShoppingCardGroups(cards);

    expect(groups.map((group) => [group.key, group.cards.map((card) => card.title)])).toEqual([
      ['regular', ['番茄']],
      ['seasoning', ['酱油']],
    ]);
  });

  it('excludes expired batches when checking aggregated low-stock alerts', () => {
    const alerts = buildIngredientAlerts(
      [
        ...inventoryItems,
        {
          id: 'inventory-4',
          family_id: 'family-1',
          ingredient_id: 'ingredient-tomato',
          ingredient_name: '番茄',
          quantity: 8,
          unit: '个',
          status: 'fresh',
          purchase_date: '2026-03-15',
          expiry_date: '2026-03-18',
          storage_location: '冷藏',
          notes: '旧的一批',
          low_stock_threshold: 3,
          created_at: '2026-03-15T10:00:00Z',
          updated_at: '2026-03-15T10:00:00Z',
        },
      ],
      ingredients,
      '2026-03-20'
    );

    expect(alerts.some((item) => item.kind === 'lowStock' && item.ingredientName === '番茄')).toBe(true);
  });

  it('aggregates multiple entered units into the default unit summary', () => {
    const summaries = buildIngredientSummaries({
      ingredients,
      inventoryItems,
      recipes,
      today: '2026-03-20',
    });
    const flour = summaries.find((item) => item.ingredient.id === 'ingredient-flour');

    expect(flour?.hasMultipleUnits).toBe(true);
    expect(flour?.quantitySummaries.map((item) => item.label)).toEqual(['2500g']);
  });

  it('uses remaining quantity and hides exhausted batches from current summaries', () => {
    const summaries = buildIngredientSummaries({
      ingredients,
      inventoryItems: [
        {
          ...inventoryItems[0],
          quantity: 5,
          consumed_quantity: 4,
          remaining_quantity: 1,
        },
        {
          ...inventoryItems[1],
          quantity: 1,
          consumed_quantity: 1,
          remaining_quantity: 0,
        },
        inventoryItems[2],
      ],
      recipes,
      today: '2026-03-20',
    });

    const tomato = summaries.find((item) => item.ingredient.id === 'ingredient-tomato');
    const flour = summaries.find((item) => item.ingredient.id === 'ingredient-flour');

    expect(tomato?.quantitySummaries.map((item) => item.label)).toEqual(['1个']);
    expect(flour?.inventoryItems.some((item) => item.id === 'inventory-2')).toBe(false);
  });

  it('keeps expired remaining batches visible but excludes them from consumable inventory', () => {
    const summaries = buildIngredientSummaries({
      ingredients: [ingredients[0]!],
      inventoryItems: [
        {
          ...inventoryItems[0]!,
          id: 'inventory-expired',
          expiry_date: '2026-03-18',
          quantity: 5,
          consumed_quantity: 1,
          remaining_quantity: 4,
        },
        {
          ...inventoryItems[0]!,
          id: 'inventory-available',
          expiry_date: '2026-03-21',
          quantity: 2,
          consumed_quantity: 0,
          remaining_quantity: 2,
        },
      ],
      recipes,
      today: '2026-03-20',
    });

    expect(summaries[0]?.inventoryItems.map((item) => item.id)).toEqual([
      'inventory-expired',
      'inventory-available',
    ]);
    expect(summaries[0]?.availableInventoryItems.map((item) => item.id)).toEqual(['inventory-available']);
    expect(summaries[0]?.quantitySummaries.map((item) => item.label)).toEqual(['2个']);
  });

  it('groups ingredients by their primary storage location', () => {
    const summaries = buildIngredientSummaries({
      ingredients,
      inventoryItems,
      recipes,
      today: '2026-03-20',
    });
    const groups = buildStorageGroups(summaries);

    expect(groups.map((group) => group.label)).toEqual(['冷藏', '常温']);
    expect(groups[0]?.items[0]?.ingredient.name).toBe('番茄');
    expect(groups[1]?.items[0]?.ingredient.name).toBe('面粉');
  });

  it('builds inventory storage overview cards with aggregated counts and tone', () => {
    const summaries = buildIngredientSummaries({
      ingredients,
      inventoryItems,
      recipes,
      today: '2026-03-20',
    });
    const overview = buildInventoryStorageOverview(summaries);

    expect(overview.map((item) => item.label)).toEqual(['冷藏', '冷冻', '常温']);
    expect(overview[0]).toMatchObject({
      ingredientCount: 1,
      totalBatches: 1,
      alertCount: 2,
      tone: 'danger',
    });
    expect(overview[1]).toMatchObject({
      ingredientCount: 0,
      totalBatches: 0,
      alertCount: 0,
      tone: 'muted',
    });
    expect(overview[2]).toMatchObject({
      ingredientCount: 1,
      totalBatches: 2,
      alertCount: 0,
      tone: 'stable',
    });
  });

  it('classifies inventory card states for danger, warning, empty and stable inventory', () => {
    const baseSummaries = buildIngredientSummaries({
      ingredients,
      inventoryItems,
      recipes,
      today: '2026-03-20',
    });
    const tomato = baseSummaries.find((item) => item.ingredient.id === 'ingredient-tomato');
    const flour = baseSummaries.find((item) => item.ingredient.id === 'ingredient-flour');

    expect(buildInventoryCardStatus(tomato!)).toMatchObject({
      label: '临期或过期',
      tone: 'danger',
      priority: 3,
    });
    expect(buildInventoryCardStatus(flour!)).toMatchObject({
      label: '平稳',
      tone: 'stable',
      priority: 0,
    });

    const lowStockSummaries = buildIngredientSummaries({
      ingredients: [
        {
          ...ingredients[1],
          id: 'ingredient-yogurt',
          name: '酸奶',
          category: '蛋奶',
          default_unit: '瓶',
          unit_conversions: [],
          default_storage: '冷藏',
          default_low_stock_threshold: 2,
        },
      ],
      inventoryItems: [
        {
          id: 'inventory-yogurt-1',
          family_id: 'family-1',
          ingredient_id: 'ingredient-yogurt',
          ingredient_name: '酸奶',
          quantity: 1,
          unit: '瓶',
          status: 'fresh',
          purchase_date: '2026-03-20',
          expiry_date: null,
          storage_location: '冷藏',
          notes: '',
          low_stock_threshold: 2,
          created_at: '2026-03-20T10:00:00Z',
          updated_at: '2026-03-20T10:00:00Z',
        },
      ],
      recipes: [],
      today: '2026-03-20',
    });

    expect(buildInventoryCardStatus(lowStockSummaries[0]!)).toMatchObject({
      label: '库存偏低',
      tone: 'warning',
      priority: 2,
    });

    const emptySummaries = buildIngredientSummaries({
      ingredients,
      inventoryItems: [],
      recipes,
      today: '2026-03-20',
    });

    expect(buildInventoryCardStatus(emptySummaries[0]!)).toMatchObject({
      label: '已空或未登记',
      tone: 'empty',
    });
  });

  it('builds inventory card presentation copy for stable, warning and empty inventory', () => {
    const baseSummaries = buildIngredientSummaries({
      ingredients,
      inventoryItems,
      recipes,
      today: '2026-03-20',
    });
    const tomato = baseSummaries.find((item) => item.ingredient.id === 'ingredient-tomato');
    const flour = baseSummaries.find((item) => item.ingredient.id === 'ingredient-flour');
    const restockDate = formatDate('2026-03-20');
    const tomatoExpiryDate = formatDate('2026-03-21');

    expect(buildInventoryCardPresentation(flour!, '2026-03-20')).toMatchObject({
      headline: '2500g',
      secondary: `最近补货 ${restockDate} · 未设保质期`,
      footerNote: `最近补货于 ${restockDate}，当前库存状态平稳。`,
      hasExpiryInfo: false,
      expiryLabel: null,
      expiryDateLabel: null,
      expiryTone: null,
    });
    expect(buildInventoryCardPresentation(tomato!, '2026-03-20')).toMatchObject({
      headline: '2个',
      secondary: `最近补货 ${restockDate} · 最早 ${tomatoExpiryDate} 到期`,
      footerNote: expect.stringContaining('当前有 2 条提醒'),
      hasExpiryInfo: true,
      expiryLabel: '距到期 1 天',
      expiryDateLabel: tomatoExpiryDate,
      expiryTone: 'danger',
    });

    const emptySummaries = buildIngredientSummaries({
      ingredients,
      inventoryItems: [],
      recipes,
      today: '2026-03-20',
    });

    expect(buildInventoryCardPresentation(emptySummaries[0]!, '2026-03-20')).toMatchObject({
      headline: '未登记',
      secondary: '还没有库存记录，适合先登记首批',
      footerNote: expect.stringContaining('当前有 1 条提醒'),
      hasExpiryInfo: false,
      expiryLabel: null,
      expiryDateLabel: null,
      expiryTone: null,
    });
  });

  it('sorts inventory summaries by expiry with undated inventory last', () => {
    const summaries = buildIngredientSummaries({
      ingredients,
      inventoryItems,
      recipes,
      today: '2026-03-20',
    });

    expect(sortInventorySummariesByExpiry(summaries).map((item) => item.ingredient.id)).toEqual([
      'ingredient-tomato',
      'ingredient-flour',
    ]);
  });

  it('keeps storage overview counts aligned with alerted inventory groups', () => {
    const summaries = buildIngredientSummaries({
      ingredients,
      inventoryItems,
      recipes,
      today: '2026-03-20',
    });
    const alertedSummaries = summaries.filter((item) => item.alerts.length > 0);
    const overview = buildInventoryStorageOverview(alertedSummaries);
    const groups = buildStorageGroups(alertedSummaries);
    const refrigeratedOverview = overview.find((item) => item.key === '冷藏');
    const refrigeratedGroup = groups.find((item) => item.key === '冷藏');

    expect(refrigeratedOverview).toMatchObject({
      ingredientCount: refrigeratedGroup?.items.length,
      totalBatches: refrigeratedGroup?.totalBatches,
      alertCount: refrigeratedGroup?.alertCount,
    });
  });

  it('builds expiry badge copy for overdue, today and upcoming inventory', () => {
    const expiryIngredient: Ingredient = {
      ...ingredients[0],
      id: 'ingredient-expiry',
      name: '牛奶',
      default_unit: '盒',
      default_storage: '冷藏',
      default_low_stock_threshold: null,
    };

    const overdueSummaries = buildIngredientSummaries({
      ingredients: [expiryIngredient],
      inventoryItems: [
        {
          id: 'inventory-expiry-overdue',
          family_id: 'family-1',
          ingredient_id: 'ingredient-expiry',
          ingredient_name: '牛奶',
          quantity: 1,
          unit: '盒',
          status: 'fresh',
          purchase_date: '2026-03-18',
          expiry_date: '2026-03-18',
          storage_location: '冷藏',
          notes: '',
          low_stock_threshold: 0,
          created_at: '2026-03-18T10:00:00Z',
          updated_at: '2026-03-20T10:00:00Z',
        },
      ],
      recipes: [],
      today: '2026-03-20',
    });

    expect(buildInventoryCardPresentation(overdueSummaries[0]!, '2026-03-20')).toMatchObject({
      headline: '当前已空',
      secondary: `最近补货 ${formatDate('2026-03-18')} · 当前已空`,
      hasExpiryInfo: true,
      expiryLabel: '已过期 2 天',
      expiryDateLabel: formatDate('2026-03-18'),
      expiryTone: 'danger',
    });

    const todaySummaries = buildIngredientSummaries({
      ingredients: [expiryIngredient],
      inventoryItems: [
        {
          id: 'inventory-expiry-today',
          family_id: 'family-1',
          ingredient_id: 'ingredient-expiry',
          ingredient_name: '牛奶',
          quantity: 1,
          unit: '盒',
          status: 'fresh',
          purchase_date: '2026-03-20',
          expiry_date: '2026-03-20',
          storage_location: '冷藏',
          notes: '',
          low_stock_threshold: 0,
          created_at: '2026-03-20T10:00:00Z',
          updated_at: '2026-03-20T10:00:00Z',
        },
      ],
      recipes: [],
      today: '2026-03-20',
    });

    expect(buildInventoryCardPresentation(todaySummaries[0]!, '2026-03-20')).toMatchObject({
      headline: '1盒',
      secondary: `最近补货 ${formatDate('2026-03-20')} · 最早 ${formatDate('2026-03-20')} 到期`,
      hasExpiryInfo: true,
      expiryLabel: '今天到期',
      expiryDateLabel: formatDate('2026-03-20'),
      expiryTone: 'danger',
    });

    const upcomingSummaries = buildIngredientSummaries({
      ingredients: [expiryIngredient],
      inventoryItems: [
        {
          id: 'inventory-expiry-upcoming',
          family_id: 'family-1',
          ingredient_id: 'ingredient-expiry',
          ingredient_name: '牛奶',
          quantity: 1,
          unit: '盒',
          status: 'fresh',
          purchase_date: '2026-03-20',
          expiry_date: '2026-03-23',
          storage_location: '冷藏',
          notes: '',
          low_stock_threshold: 0,
          created_at: '2026-03-20T10:00:00Z',
          updated_at: '2026-03-20T10:00:00Z',
        },
      ],
      recipes: [],
      today: '2026-03-20',
    });

    expect(buildInventoryCardPresentation(upcomingSummaries[0]!, '2026-03-20')).toMatchObject({
      headline: '1盒',
      secondary: `最近补货 ${formatDate('2026-03-20')} · 最早 ${formatDate('2026-03-23')} 到期`,
      hasExpiryInfo: true,
      expiryLabel: '距到期 3 天',
      expiryDateLabel: formatDate('2026-03-23'),
      expiryTone: 'warning',
    });
  });

  it('builds disposable expired inventory items from overdue batches with remaining quantity only', () => {
    const summaries = buildIngredientSummaries({
      ingredients: [ingredients[0]!],
      inventoryItems: [
        {
          ...inventoryItems[0]!,
          id: 'inventory-expired-remaining',
          ingredient_id: 'ingredient-tomato',
          ingredient_name: '番茄',
          expiry_date: '2026-03-18',
          quantity: 5,
          consumed_quantity: 2,
          remaining_quantity: 3,
        },
        {
          ...inventoryItems[0]!,
          id: 'inventory-expired-empty',
          ingredient_id: 'ingredient-tomato',
          ingredient_name: '番茄',
          expiry_date: '2026-03-17',
          quantity: 2,
          consumed_quantity: 2,
          remaining_quantity: 0,
        },
        {
          ...inventoryItems[0]!,
          id: 'inventory-expiring-today',
          ingredient_id: 'ingredient-tomato',
          ingredient_name: '番茄',
          expiry_date: '2026-03-20',
          quantity: 1,
          consumed_quantity: 0,
          remaining_quantity: 1,
        },
        {
          ...inventoryItems[0]!,
          id: 'inventory-future',
          ingredient_id: 'ingredient-tomato',
          ingredient_name: '番茄',
          expiry_date: '2026-03-22',
          quantity: 1,
          consumed_quantity: 0,
          remaining_quantity: 1,
        },
        {
          ...inventoryItems[0]!,
          id: 'inventory-no-expiry',
          ingredient_id: 'ingredient-tomato',
          ingredient_name: '番茄',
          expiry_date: null,
          quantity: 1,
          consumed_quantity: 0,
          remaining_quantity: 1,
        },
      ],
      recipes: [],
      today: '2026-03-20',
    });

    expect(buildDisposableExpiredInventoryItems(summaries[0]!, '2026-03-20')).toEqual([
      expect.objectContaining({
        id: 'inventory-expired-remaining',
        remainingQuantity: 3,
        remainingLabel: '3个',
        expiryDate: '2026-03-18',
      }),
    ]);
  });

  it('shows core preset categories first and appends custom categories for filter chips', () => {
    const categoryFilters = buildIngredientCategoryFilters([
      ...ingredients,
      {
        ...ingredients[0],
        id: 'ingredient-sesame',
        name: '芝麻酱',
        category: '酱料',
      },
      {
        ...ingredients[0],
        id: 'ingredient-seaweed',
        name: '海苔',
        category: '海味',
      },
    ]);

    expect(categoryFilters).toEqual([
      '蔬菜',
      '肉类',
      '水产',
      '蛋奶',
      '调料',
      '水果',
      '主食',
      '豆制品',
      '干货',
      '其他',
      '酱料',
      '海味',
    ]);
    expect(getIngredientCategoryPreset('水产')).toMatchObject({
      label: '水产',
      defaultUnit: '块',
      defaultStorage: '冷冻',
    });
    expect(getIngredientCategoryPreset('其他')).toMatchObject({
      label: '其他',
      defaultUnit: '份',
      defaultStorage: '常温',
    });
  });

  it('shows seasoning in the editor category presets', () => {
    expect(getIngredientEditorCategoryPresets().map((item) => item.label)).toEqual([
      '蔬菜',
      '肉类',
      '水产',
      '蛋奶',
      '调料',
      '水果',
      '主食',
      '豆制品',
      '干货',
      '其他',
    ]);
    expect(getIngredientCategoryPreset('调料')).toMatchObject({
      label: '调料',
      defaultStorage: '常温',
      quantityTrackingMode: 'not_track_quantity',
      icon: 'seasoning',
    });
  });

  it('combines search and category filter for ingredient archives', () => {
    const summaries = buildIngredientSummaries({
      ingredients,
      inventoryItems,
      recipes,
      today: '2026-03-20',
    });

    expect(filterIngredientSummaries(summaries, '', '蔬菜').map((item) => item.ingredient.name)).toEqual(['番茄']);
    expect(filterIngredientSummaries(summaries, '面', '蔬菜')).toEqual([]);
    expect(filterIngredientSummaries(summaries, '面', '干货').map((item) => item.ingredient.name)).toEqual(['面粉']);
  });

  it('keeps semantic catalog matches that do not match local text', () => {
    const summaries = buildIngredientSummaries({
      ingredients,
      inventoryItems,
      recipes,
      today: '2026-03-20',
    });

    expect(filterIngredientSummaries(summaries, '西红柿', 'all')).toEqual([]);
    expect(filterIngredientSummaries(summaries, '西红柿', 'all', ['ingredient-tomato']).map((item) => item.ingredient.name)).toEqual(['番茄']);
  });

  it('keeps semantic inventory matches that do not match local text', () => {
    const summaries = buildIngredientSummaries({
      ingredients,
      inventoryItems,
      recipes,
      today: '2026-03-20',
    });

    expect(filterIngredientSummariesForInventory(summaries, '西红柿')).toEqual([]);
    expect(
      filterIngredientSummariesForInventory(summaries, '西红柿', ['ingredient-tomato']).map(
        (item) => item.ingredient.name
      )
    ).toEqual(['番茄']);
  });

  it('builds shopping cards with exact archive matching and pending priority order', () => {
    const summaries = buildIngredientSummaries({
      ingredients,
      inventoryItems,
      recipes,
      today: '2026-03-20',
    });
    const cards = buildShoppingCards(shoppingItems.filter((item) => !item.done), summaries);

    expect(cards.map((card) => card.shoppingItem.id)).toEqual([
      'shopping-tomato',
      'shopping-flour',
      'shopping-cola',
    ]);
    expect(cards[0]).toMatchObject({
      title: '番茄',
      isLinked: true,
      hasAttention: true,
      sourceLabel: '档案关联',
      statusTone: 'danger',
      subline: '补充本周家常菜库存',
      contextTags: ['蔬菜', '冷藏', '库存 2个'],
    });
    expect(cards[1]).toMatchObject({
      title: '面粉',
      isLinked: true,
      hasAttention: false,
      inventoryLabel: '2500g',
    });
    expect(cards[2]).toMatchObject({
      title: '可乐',
      isLinked: false,
      sourceLabel: '自由项',
      inventoryLabel: '未关联档案',
      contextTags: ['自由项', '未关联档案', '买完后可补录'],
    });
  });

  it('builds shopping overview counts and combines focus with search filtering', () => {
    const summaries = buildIngredientSummaries({
      ingredients,
      inventoryItems,
      recipes,
      today: '2026-03-20',
    });
    const cards = buildShoppingCards(shoppingItems.filter((item) => !item.done), summaries);
    const overview = buildShoppingOverview(cards);

    expect(overview).toEqual([
      expect.objectContaining({ key: 'all', count: 3 }),
      expect.objectContaining({ key: 'attention', count: 1 }),
      expect.objectContaining({ key: 'linked', count: 2 }),
      expect.objectContaining({ key: 'freeform', count: 1 }),
    ]);
    expect(filterShoppingCards(cards, '干货', 'linked').map((card) => card.shoppingItem.id)).toEqual([
      'shopping-flour',
    ]);
    expect(filterShoppingCards(cards, '周末', 'freeform').map((card) => card.shoppingItem.id)).toEqual([
      'shopping-cola',
    ]);
    expect(filterShoppingCards(cards, '番茄', 'attention').map((card) => card.shoppingItem.id)).toEqual([
      'shopping-tomato',
    ]);
  });
});
