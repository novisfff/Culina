import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Food, Ingredient, InventoryItem, MealLog, Recipe, RecipeFavorite, RecipePlanItem } from '../../api/types';
import { buildRecipeCards, buildRecipeHomeViewModel, filterRecipeCards } from './workspaceModel';

const tomato: Ingredient = {
  id: 'ingredient-tomato',
  family_id: 'family-1',
  name: '番茄',
  category: '蔬菜',
  default_unit: '个',
  unit_conversions: [],
  default_storage: '冷藏',
  default_expiry_mode: 'days',
  default_expiry_days: 3,
  default_low_stock_threshold: 1,
  notes: '',
  image: null,
  created_at: '2026-05-01T10:00:00Z',
  updated_at: '2026-05-01T10:00:00Z',
};

const flour: Ingredient = {
  id: 'ingredient-flour',
  family_id: 'family-1',
  name: '面粉',
  category: '干货',
  default_unit: 'g',
  unit_conversions: [{ unit: 'kg', ratio_to_default: 1000 }],
  default_storage: '常温',
  default_expiry_mode: 'none',
  default_expiry_days: null,
  default_low_stock_threshold: null,
  notes: '',
  image: null,
  created_at: '2026-05-01T10:00:00Z',
  updated_at: '2026-05-01T10:00:00Z',
};

const recipes: Recipe[] = [
  {
    id: 'recipe-ready',
    family_id: 'family-1',
    title: '番茄炒蛋',
    servings: 2,
    prep_minutes: 12,
    difficulty: 'easy',
    ingredient_items: [{ id: 'ri-1', ingredient_id: tomato.id, ingredient_name: '番茄', quantity: 2, unit: '个', note: '' }],
    steps: [{ id: 's-1', title: '炒制', text: '炒熟' }],
    tips: '快手晚餐',
    scene_tags: ['晚餐'],
    images: [],
    cook_logs: [],
    created_at: '2026-05-01T10:00:00Z',
    updated_at: '2026-05-04T10:00:00Z',
  },
  {
    id: 'recipe-missing',
    family_id: 'family-1',
    title: '烙饼',
    servings: 2,
    prep_minutes: 35,
    difficulty: 'medium',
    ingredient_items: [{ id: 'ri-2', ingredient_id: flour.id, ingredient_name: '面粉', quantity: 1, unit: 'kg', note: '' }],
    steps: [{ id: 's-2', title: '和面', text: '和面' }],
    tips: '',
    scene_tags: ['早餐'],
    images: [],
    cook_logs: [],
    created_at: '2026-05-01T10:00:00Z',
    updated_at: '2026-05-03T10:00:00Z',
  },
];

const inventoryItems: InventoryItem[] = [
  {
    id: 'inventory-tomato',
    family_id: 'family-1',
    ingredient_id: tomato.id,
    ingredient_name: '番茄',
    quantity: 2,
    consumed_quantity: 0,
    remaining_quantity: 2,
    unit: '个',
    status: 'fresh',
    purchase_date: '2026-05-01',
    expiry_date: '2026-05-20',
    storage_location: '冷藏',
    notes: '',
    low_stock_threshold: 1,
    created_at: '2026-05-01T10:00:00Z',
    updated_at: '2026-05-01T10:00:00Z',
  },
  {
    id: 'inventory-expired-flour',
    family_id: 'family-1',
    ingredient_id: flour.id,
    ingredient_name: '面粉',
    quantity: 2,
    consumed_quantity: 0,
    remaining_quantity: 2,
    unit: 'kg',
    status: 'opened',
    purchase_date: '2026-04-01',
    expiry_date: '2026-05-01',
    storage_location: '常温',
    notes: '',
    low_stock_threshold: 0,
    created_at: '2026-04-01T10:00:00Z',
    updated_at: '2026-04-01T10:00:00Z',
  },
];

const foods: Food[] = [
  {
    id: 'food-ready',
    family_id: 'family-1',
    name: '番茄炒蛋',
    type: 'selfMade',
    category: '家常菜',
    flavor_tags: [],
    suitable_meal_types: ['dinner'],
    source_name: '',
    purchase_source: '',
    scene: '晚餐',
    images: [],
    notes: '',
    routine_note: '',
    stock_unit: '',
    favorite: true,
    recipe_id: 'recipe-ready',
    created_at: '2026-05-01T10:00:00Z',
    updated_at: '2026-05-01T10:00:00Z',
  },
];

const mealLogs: MealLog[] = [
  {
    id: 'meal-1',
    family_id: 'family-1',
    date: '2026-05-02',
    meal_type: 'dinner',
    food_entries: [{ id: 'entry-1', food_id: 'food-ready', food_name: '番茄炒蛋', servings: 1, note: '' }],
    participant_user_ids: [],
    notes: '',
    mood: '',
    photos: [],
    deduction_suggestions: [],
    created_at: '2026-05-02T10:00:00Z',
    updated_at: '2026-05-02T10:00:00Z',
  },
];

const weeklyMealLog: MealLog = {
  id: 'meal-weekly',
  family_id: 'family-1',
  date: '2026-05-12',
  meal_type: 'dinner',
  food_entries: [{ id: 'entry-weekly', food_id: 'food-ready', food_name: '番茄炒蛋', servings: 1, note: '' }],
  participant_user_ids: [],
  notes: '',
  mood: '',
  photos: [],
  deduction_suggestions: [],
  created_at: '2026-05-12T10:00:00Z',
  updated_at: '2026-05-12T10:00:00Z',
};

const recipeFavorite: RecipeFavorite = {
  id: 'favorite-1',
  family_id: 'family-1',
  user_id: 'user-1',
  recipe_id: 'recipe-missing',
  created_at: '2026-05-12T12:00:00Z',
};

const planItem: RecipePlanItem = {
  id: 'plan-1',
  family_id: 'family-1',
  user_id: 'user-1',
  food_id: 'food-ready',
  food_name: '番茄炒蛋',
  food_type: 'selfMade',
  recipe_id: 'recipe-ready',
  recipe_title: '番茄炒蛋',
  plan_date: '2026-05-13',
  meal_type: 'dinner',
  note: '',
  status: 'planned',
  completed_at: null,
  meal_log_id: null,
  created_at: '2026-05-12T12:00:00Z',
  updated_at: '2026-05-12T12:00:00Z',
  created_by: 'user-1',
  updated_by: 'user-1',
};

afterEach(() => {
  vi.useRealTimers();
});

describe('recipe workspace model', () => {
  it('marks recipes as ready or missing and ignores expired inventory', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 4, 13, 8, 0, 0));

    const cards = buildRecipeCards(recipes, [tomato, flour], inventoryItems, mealLogs, foods);

    expect(cards.find((card) => card.recipe.id === 'recipe-ready')?.availability).toBe('ready');
    const missing = cards.find((card) => card.recipe.id === 'recipe-missing');
    expect(missing?.availability).toBe('missing');
    expect(missing?.shortages[0]?.missingQuantity).toBe(1000);
    expect(missing?.shortages[0]?.unit).toBe('g');
  });

  it('filters by search, common recipes, quick recipes, and availability sorting', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 4, 13, 8, 0, 0));
    const cards = buildRecipeCards(recipes, [tomato, flour], inventoryItems, mealLogs, foods);

    expect(filterRecipeCards(cards, { search: '番茄', quickFilter: 'all', sceneFilter: 'all', difficultyFilter: 'all', sortMode: 'updated' })).toHaveLength(1);
    expect(filterRecipeCards(cards, { search: '', quickFilter: 'recommend', sceneFilter: 'all', difficultyFilter: 'all', sortMode: 'recommend' }).map((card) => card.recipe.id)).toEqual(['recipe-ready', 'recipe-missing']);
    expect(filterRecipeCards(cards, { search: '', quickFilter: 'common', sceneFilter: 'all', difficultyFilter: 'all', sortMode: 'updated' }).map((card) => card.recipe.id)).toEqual(['recipe-ready']);
    expect(filterRecipeCards(cards, { search: '', quickFilter: 'quick', sceneFilter: 'all', difficultyFilter: 'all', sortMode: 'updated' }).map((card) => card.recipe.id)).toEqual(['recipe-ready']);
    expect(filterRecipeCards(cards, { search: '', quickFilter: 'all', sceneFilter: 'all', difficultyFilter: 'all', sortMode: 'availability' })[0]?.recipe.id).toBe('recipe-ready');
  });

  it('builds discovery sections from favorites, weekly usage, quick recipes, and plan items', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 4, 13, 8, 0, 0));
    const cards = buildRecipeCards(recipes, [tomato, flour], inventoryItems, [...mealLogs, weeklyMealLog], foods);

    const home = buildRecipeHomeViewModel(cards, [recipeFavorite], [planItem], [...mealLogs, weeklyMealLog], foods, '2026-05-13');

    expect(home.favoriteCards.map((card) => card.recipe.id)).toEqual(['recipe-missing']);
    expect(home.recommendedCards[0]?.recipe.id).toBe('recipe-missing');
    expect(home.recommendedCards[1]?.recipe.id).toBe('recipe-ready');
    expect(home.weeklyTop[0]?.card.recipe.id).toBe('recipe-ready');
    expect(home.weeklyTop[0]?.count).toBe(1);
    expect(home.quickRecipes.map((card) => card.recipe.id)).toEqual(['recipe-ready']);
    expect(home.planDays.find((day) => day.date === '2026-05-13')?.items).toEqual([planItem]);
    expect(home.popularCategories.map((item) => item.name)).toContain('晚餐');
  });

  it('keeps quick and available recipes ahead in fallback recommendations without favorites', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 4, 13, 8, 0, 0));
    const cards = buildRecipeCards(recipes, [tomato, flour], inventoryItems, mealLogs, foods);

    const home = buildRecipeHomeViewModel(cards, [], [], mealLogs, foods, '2026-05-13');

    expect(home.recommendedCards.map((card) => card.recipe.id)).toEqual(['recipe-ready', 'recipe-missing']);
  });
});
