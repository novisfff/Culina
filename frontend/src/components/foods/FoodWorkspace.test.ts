import { describe, expect, it } from 'vitest';
import type { Food, Ingredient, InventoryItem, MealLog, Recipe } from '../../api/types';
import { todayKey } from '../../lib/ui';
import {
  FOOD_CREATE_TYPE_OPTIONS,
  buildFoodPayloadFromForm,
  buildTodayFoodRecommendations,
  filterFoodWorkspaceItems,
  getSuggestedMealTypeForHour,
  type FoodFormState,
} from './FoodWorkspace';
import {
  buildFoodRelationViewModel,
  getFoodGovernanceIssues,
} from './FoodWorkspaceHelpers';

const recipe: Recipe = {
  id: 'recipe-1',
  family_id: 'family-1',
  title: '番茄炒蛋',
  servings: 2,
  prep_minutes: 12,
  difficulty: 'easy',
  ingredient_items: [],
  steps: [],
  tips: '少油',
  scene_tags: ['晚餐'],
  images: [],
  cook_logs: [],
  created_at: '2026-05-01T10:00:00Z',
  updated_at: '2026-05-01T10:00:00Z',
};

const baseFood: Food = {
  id: 'food-1',
  family_id: 'family-1',
  name: '冷冻牛肉饭',
  type: 'instant',
  category: '速食',
  flavor_tags: ['省心'],
  scene_tags: ['加班'],
  suitable_meal_types: ['lunch', 'dinner'],
  source_name: '便利店',
  purchase_source: '楼下便利店',
  scene: '加班',
  images: [],
  notes: '微波炉加热',
  routine_note: '没菜时备用',
  price: 18.9,
  rating: 4,
  repurchase: true,
  expiry_date: '2026-06-01',
  stock_quantity: 2,
  stock_unit: '盒',
  favorite: true,
  recipe_id: null,
  created_at: '2026-05-01T10:00:00Z',
  updated_at: '2026-05-01T10:00:00Z',
};

const tomato: Ingredient = {
  id: 'ingredient-tomato',
  family_id: 'family-1',
  name: '番茄',
  category: '蔬菜',
  default_unit: '个',
  unit_conversions: [],
  default_storage: '冷藏',
  default_expiry_mode: 'days',
  default_expiry_days: 5,
  default_low_stock_threshold: 1,
  notes: '',
  image: null,
  created_at: '2026-05-01T10:00:00Z',
  updated_at: '2026-05-01T10:00:00Z',
};

const egg: Ingredient = {
  ...tomato,
  id: 'ingredient-egg',
  name: '鸡蛋',
  category: '蛋奶',
  default_unit: '个',
};

const tomatoInventory: InventoryItem = {
  id: 'inventory-tomato',
  family_id: 'family-1',
  ingredient_id: tomato.id,
  ingredient_name: tomato.name,
  quantity: 2,
  remaining_quantity: 2,
  unit: '个',
  status: 'fresh',
  purchase_date: todayKey(),
  expiry_date: todayKey(),
  storage_location: '冷藏',
  notes: '',
  low_stock_threshold: 1,
  created_at: '2026-05-01T10:00:00Z',
  updated_at: '2026-05-01T10:00:00Z',
};

const form: FoodFormState = {
  name: ' 冷冻牛肉饭 ',
  type: 'instant',
  category: '',
  sceneTags: '省心、微辣',
  suitableMealTypes: ['lunch', 'dinner'],
  sourceName: ' 便利店 ',
  purchaseSource: '',
  scene: ' 加班 ',
  notes: ' 微波炉 ',
  routineNote: ' 没菜时备用 ',
  price: '18.9',
  rating: '4',
  repurchase: 'yes',
  expiryDate: '2026-06-01',
  stockQuantity: '2',
  stockUnit: '盒',
  favorite: true,
  recipeId: '',
  images: {},
};

function dateOffset(days: number) {
  const [year, month, day] = todayKey().split('-').map(Number);
  const date = new Date(year, month - 1, day + days);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function makeMealLog(food: Food, date: string, mealType: MealLog['meal_type'] = 'dinner'): MealLog {
  return {
    id: `meal-${food.id}-${date}`,
    family_id: 'family-1',
    date,
    meal_type: mealType,
    food_entries: [{ id: `entry-${food.id}`, food_id: food.id, food_name: food.name, servings: 1, note: '' }],
    participant_user_ids: [],
    notes: '',
    mood: '',
    photos: [],
    deduction_suggestions: [],
    created_at: `${date}T10:00:00Z`,
    updated_at: `${date}T10:00:00Z`,
  };
}

describe('food workspace helpers', () => {
  it('builds practical food payload fields for non-recipe foods', () => {
    expect(buildFoodPayloadFromForm(form, [recipe], ['media-1'])).toMatchObject({
      name: '冷冻牛肉饭',
      type: 'instant',
      category: '速食',
      flavor_tags: [],
      scene_tags: ['省心', '微辣'],
      suitable_meal_types: ['lunch', 'dinner'],
      source_name: '便利店',
      purchase_source: '便利店',
      price: 18.9,
      rating: 4,
      repurchase: true,
      stock_quantity: 2,
      media_ids: ['media-1'],
    });
  });

  it('does not offer home-cooked food as a manually created type', () => {
    expect(FOOD_CREATE_TYPE_OPTIONS.map((item) => item.value)).toEqual(['takeout', 'diningOut', 'readyMade', 'instant']);
  });

  it('filters by normalized type, meal type, and text fields', () => {
    const packaged: Food = { ...baseFood, id: 'food-2', name: '无糖酸奶', type: 'packaged', suitable_meal_types: ['breakfast'] };
    expect(filterFoodWorkspaceItems([baseFood, packaged], '', 'readyMade', 'all')).toEqual([packaged]);
    expect(filterFoodWorkspaceItems([baseFood, packaged], '便利店', 'all', 'dinner')).toEqual([baseFood]);
  });

  it('filters operational food lenses', () => {
    const image = { id: 'media-1', name: '食物图', url: '/food.jpg', source: 'upload' as const, alt: '食物图', created_at: '2026-05-01T10:00:00Z', created_by: null };
    const completeFood: Food = { ...baseFood, images: [image], expiry_date: dateOffset(14) };
    const missingInfo: Food = { ...completeFood, id: 'food-2', name: '待补资料', images: [], suitable_meal_types: [], routine_note: '', notes: '', scene: '', scene_tags: [], source_name: '', purchase_source: '' };
    const expiring: Food = { ...completeFood, id: 'food-3', name: '即期酸奶', type: 'readyMade', expiry_date: todayKey() };
    expect(filterFoodWorkspaceItems([completeFood, missingInfo, expiring], '', 'all', 'all', 'needsInfo')).toEqual([missingInfo]);
    expect(filterFoodWorkspaceItems([completeFood, missingInfo, expiring], '', 'all', 'all', 'expiring')).toEqual([expiring]);
  });

  it('classifies governance issues for batch maintenance', () => {
    const image = { id: 'media-1', name: '食物图', url: '/food.jpg', source: 'upload' as const, alt: '食物图', created_at: '2026-05-01T10:00:00Z', created_by: null };
    const missingAll: Food = {
      ...baseFood,
      images: [],
      suitable_meal_types: [],
      source_name: '',
      purchase_source: '',
      routine_note: '',
      notes: '',
      scene: '',
      scene_tags: [],
      stock_quantity: null,
      stock_unit: '',
      expiry_date: null,
    };
    const completeFood: Food = { ...baseFood, images: [image] };

    expect(getFoodGovernanceIssues(missingAll)).toEqual(['image', 'meal', 'note', 'source', 'stock']);
    expect(getFoodGovernanceIssues(completeFood)).toEqual([]);
  });

  it('treats missing ready-made stock or expiry as incomplete', () => {
    const image = { id: 'media-1', name: '食物图', url: '/food.jpg', source: 'upload' as const, alt: '食物图', created_at: '2026-05-01T10:00:00Z', created_by: null };
    const missingStock: Food = { ...baseFood, id: 'food-stock', images: [image], stock_quantity: null, stock_unit: '', expiry_date: null };

    expect(getFoodGovernanceIssues(missingStock)).toEqual(['stock']);
    expect(filterFoodWorkspaceItems([missingStock], '', 'all', 'all', 'needsInfo')).toEqual([missingStock]);
  });

  it('uses linked recipe images when checking self-made food completeness', () => {
    const image = { id: 'media-recipe', name: '菜谱图', url: '/recipe.jpg', source: 'upload' as const, alt: '菜谱图', created_at: '2026-05-01T10:00:00Z', created_by: null };
    const linkedRecipe: Recipe = { ...recipe, images: [image] };
    const selfMadeFood: Food = {
      ...baseFood,
      id: 'food-self-made',
      name: '番茄炒蛋',
      type: 'selfMade',
      category: '家常菜',
      images: [],
      suitable_meal_types: ['lunch', 'dinner'],
      scene: '工作日',
      notes: '',
      routine_note: '少油',
      recipe_id: linkedRecipe.id,
    };

    expect(getFoodGovernanceIssues(selfMadeFood, [linkedRecipe])).toEqual([]);
    expect(filterFoodWorkspaceItems([selfMadeFood], '', 'all', 'all', 'needsInfo', [linkedRecipe])).toEqual([]);
  });

  it('suggests a meal type from the current hour', () => {
    expect(getSuggestedMealTypeForHour(8)).toBe('breakfast');
    expect(getSuggestedMealTypeForHour(12)).toBe('lunch');
    expect(getSuggestedMealTypeForHour(18)).toBe('dinner');
    expect(getSuggestedMealTypeForHour(23)).toBe('snack');
  });

  it('downranks foods that were eaten very recently', () => {
    const yesterdayDinner: Food = { ...baseFood, id: 'food-recent', name: '昨天刚吃的盖饭', favorite: false, rating: null, repurchase: null, expiry_date: null };
    const freshDinner: Food = { ...baseFood, id: 'food-fresh', name: '今天换个炒饭', favorite: false, rating: null, repurchase: null, expiry_date: null };

    const recommendations = buildTodayFoodRecommendations([yesterdayDinner, freshDinner], [makeMealLog(yesterdayDinner, dateOffset(-1))], {
      mealType: 'dinner',
      today: todayKey(),
    });

    expect(recommendations[0].food.name).toBe('今天换个炒饭');
    expect(recommendations.find((item) => item.food.id === 'food-recent')?.reasons).toContain('最近吃过已降权');
  });

  it('keeps expiring foods high priority even when they were eaten recently', () => {
    const expiringFood: Food = { ...baseFood, id: 'food-expiring', name: '今天到期酸奶', type: 'readyMade', expiry_date: todayKey(), favorite: false, rating: null, repurchase: null };
    const highRatedFood: Food = { ...baseFood, id: 'food-rated', name: '高分便当', expiry_date: null, favorite: true, rating: 5, repurchase: true };

    const recommendations = buildTodayFoodRecommendations([highRatedFood, expiringFood], [makeMealLog(expiringFood, todayKey())], {
      mealType: 'dinner',
      today: todayKey(),
    });

    expect(recommendations[0].food.name).toBe('今天到期酸奶');
    expect(recommendations[0].reasons).toContain('今天需处理');
  });

  it('builds home-cooked recipe relation with availability and shortages', () => {
    const linkedRecipe: Recipe = {
      ...recipe,
      id: 'recipe-linked',
      title: '家常番茄炒蛋',
      ingredient_items: [
        { id: 'recipe-ingredient-tomato', ingredient_id: tomato.id, ingredient_name: tomato.name, quantity: 1, unit: '个', note: '' },
        { id: 'recipe-ingredient-egg', ingredient_id: egg.id, ingredient_name: egg.name, quantity: 2, unit: '个', note: '' },
      ],
    };
    const food: Food = { ...baseFood, id: 'food-home', name: '家常番茄炒蛋', type: 'selfMade', recipe_id: linkedRecipe.id, stock_quantity: null, stock_unit: '' };

    const relation = buildFoodRelationViewModel(food, [linkedRecipe], [tomato, egg], [tomatoInventory], [], [food]);

    expect(relation.linkedRecipeCard?.availabilityLabel).toBe('缺 1 项');
    expect(relation.relationFacts).toContainEqual({ label: '可做程度', value: '缺 1 项' });
    expect(relation.shortagePreview).toEqual(['鸡蛋 2个']);
  });

  it('builds meal record relation with count and latest meal', () => {
    const food: Food = { ...baseFood, id: 'food-records', name: '常点牛肉饭' };
    const oldLog = makeMealLog(food, dateOffset(-5), 'lunch');
    const latestLog = makeMealLog(food, dateOffset(-1), 'dinner');

    const relation = buildFoodRelationViewModel(food, [], [], [], [oldLog, latestLog], [food]);

    expect(relation.usage.count).toBe(2);
    expect(relation.lastMealLog?.id).toBe(latestLog.id);
    expect(relation.relationFacts).toContainEqual({ label: '最近一次', value: expect.any(String) });
  });

  it('builds ready-made relation from food stock fields', () => {
    const readyFood: Food = { ...baseFood, id: 'food-ready-stock', type: 'readyMade', name: '冷藏意面', stock_quantity: 3, stock_unit: '盒', expiry_date: todayKey(), purchase_source: '盒马' };

    const relation = buildFoodRelationViewModel(readyFood, [], [tomato], [], [], [readyFood]);

    expect(relation.relationFacts).toContainEqual({ label: '库存剩余', value: '3盒' });
    expect(relation.relationFacts).toContainEqual({ label: '到期', value: '今天到期' });
    expect(relation.detail).toContain('盒马');
  });

  it('builds outside food relation from rating, repurchase and recent meals', () => {
    const outsideFood: Food = { ...baseFood, id: 'food-outside', type: 'takeout', name: '咖喱外卖', rating: 4.5, repurchase: true, source_name: '楼下咖喱' };
    const mealLog = makeMealLog(outsideFood, dateOffset(-2), 'dinner');

    const relation = buildFoodRelationViewModel(outsideFood, [], [], [], [mealLog], [outsideFood]);

    expect(relation.relationFacts).toContainEqual({ label: '餐食记录', value: '1 次' });
    expect(relation.relationFacts).toContainEqual({ label: '复购评分', value: '4.5 分 · 愿意复购' });
    expect(relation.detail).toContain('楼下咖喱');
  });
});
