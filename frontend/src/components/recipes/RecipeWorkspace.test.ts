import { describe, expect, it } from 'vitest';
import type { Ingredient } from '../../api/types';
import {
  buildCookPayload,
  buildCustomShoppingDraft,
  buildRecipePayload,
  buildRecipeShortageShoppingPayloads,
  buildShoppingDraftFromRecipeIngredient,
  buildShoppingDraftsFromShortages,
  buildShoppingPayloadsFromDrafts,
  getRecipeShoppingRequirement,
  sanitizeCookSession,
  type RecipeDraftIngredient,
  type RecipeFormState,
} from './RecipeWorkspace';
import type { RecipeCardViewModel } from './workspaceModel';

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

const egg: Ingredient = {
  id: 'ingredient-egg',
  family_id: 'family-1',
  name: '鸡蛋',
  category: '蛋奶',
  default_unit: '枚',
  unit_conversions: [],
  default_storage: '冷藏',
  default_expiry_mode: 'days',
  default_expiry_days: 10,
  default_low_stock_threshold: 2,
  notes: '',
  image: null,
  created_at: '2026-05-01T10:00:00Z',
  updated_at: '2026-05-01T10:00:00Z',
};

function recipeForm(overrides: Partial<RecipeFormState> = {}): RecipeFormState {
  return {
    title: ' 番茄炒蛋 ',
    servings: '2',
    prepMinutes: '12',
    difficulty: 'easy',
    steps: [
      {
        id: 'step-1',
        title: '备菜',
        text: ' 备菜 ',
        icon: 'timer',
        summary: ' 先处理食材 ',
        estimatedMinutes: '5',
        tip: ' 保持案台干净 ',
        keyPoints: '洗净番茄\n打散鸡蛋',
      },
      { id: 'step-2', title: '', text: '', icon: 'pan', summary: '', estimatedMinutes: '', tip: '', keyPoints: '' },
      {
        id: 'step-3',
        title: '炒制',
        text: ' 炒熟 ',
        icon: 'pan',
        summary: '',
        estimatedMinutes: '',
        tip: '',
        keyPoints: '',
      },
    ],
    tips: ' 少油 ',
    sceneTags: '晚餐， 快手, 家常 ',
    images: {
      generatedAsset: {
        id: 'media-cover',
        name: 'recipe-cover.webp',
        url: '/uploads/recipe-cover.webp',
        source: 'ai',
        alt: '番茄炒蛋封面',
        created_at: '2026-05-01T10:00:00Z',
      },
    },
    autoCreateFood: true,
    ...overrides,
  };
}

describe('recipe workspace payload helpers', () => {
  it('builds trimmed recipe payloads with linked ingredient names, default units, tags, and media ids', () => {
    const rows: RecipeDraftIngredient[] = [
      { id: 'row-1', ingredient_id: tomato.id, ingredient_name: '旧番茄名', quantity: 2, unit: '', note: ' 去皮 ' },
      { id: 'row-2', ingredient_id: null, ingredient_name: '  盐  ', quantity: 1, unit: '小勺', note: '' },
      { id: 'row-empty', ingredient_id: '', ingredient_name: '   ', quantity: 1, unit: '个', note: '' },
    ];

    expect(buildRecipePayload(recipeForm(), rows, [tomato, egg])).toEqual({
      title: '番茄炒蛋',
      servings: 2,
      prep_minutes: 12,
      difficulty: 'easy',
      ingredient_items: [
        { ingredient_id: tomato.id, ingredient_name: '番茄', quantity: 2, unit: '个', note: '去皮' },
        { ingredient_id: null, ingredient_name: '盐', quantity: 1, unit: '小勺', note: '' },
      ],
      steps: [
        {
          title: '备菜',
          text: '备菜',
          icon: 'timer',
          summary: '先处理食材',
          estimated_minutes: 5,
          tip: '保持案台干净',
          key_points: ['洗净番茄', '打散鸡蛋'],
        },
        { title: '炒制', text: '炒熟', icon: 'pan', summary: '', estimated_minutes: null, tip: '', key_points: [] },
      ],
      tips: '少油',
      scene_tags: ['晚餐', '快手', '家常'],
      media_ids: ['media-cover'],
    });
  });

  it('uses fallback unit for unlinked ingredients without an explicit unit', () => {
    const payload = buildRecipePayload(
      recipeForm({ images: {} }),
      [{ id: 'row-1', ingredient_id: '', ingredient_name: '  葱花 ', quantity: 0.5, unit: ' ', note: ' 可选 ' }],
      []
    );

    expect(payload.ingredient_items).toEqual([{ ingredient_id: null, ingredient_name: '葱花', quantity: 0.5, unit: '个', note: '可选' }]);
    expect(payload.media_ids).toEqual([]);
  });

  it('builds cook payloads for plan-linked cook logs and empty optional rating', () => {
    expect(
      buildCookPayload({
        servings: '3',
        date: '2026-05-14',
        mealType: 'dinner',
        createMealLog: true,
        planItemId: 'plan-1',
        resultNote: ' 很成功 ',
        adjustments: ' 少放盐 ',
        rating: '5',
      })
    ).toEqual({
      servings: 3,
      date: '2026-05-14',
      meal_type: 'dinner',
      create_meal_log: true,
      recipe_plan_item_id: 'plan-1',
      result_note: '很成功',
      adjustments: '少放盐',
      rating: 5,
    });

    expect(
      buildCookPayload({
        servings: '1',
        date: '2026-05-15',
        mealType: 'lunch',
        createMealLog: false,
        planItemId: null,
        resultNote: '',
        adjustments: '',
        rating: '',
      })
    ).toMatchObject({
      servings: 1,
      create_meal_log: false,
      recipe_plan_item_id: undefined,
      rating: null,
    });
  });

  it('sanitizes persisted cook sessions with safe defaults and clamped step index', () => {
    const recipe = {
      servings: 2,
      steps: [
        { id: 'step-1', title: '备菜', text: '备菜', icon: 'pan', summary: '', estimated_minutes: null, tip: '', key_points: [] },
        { id: 'step-2', title: '炒制', text: '炒熟', icon: 'pan', summary: '', estimated_minutes: null, tip: '', key_points: [] },
      ],
    };

    expect(
      sanitizeCookSession(
        {
          currentStepIndex: 99,
          checkedIngredientIds: ['ri-1', 1],
          completedStepIds: ['step-1', null],
          timerSeconds: -5,
          timerRunning: true,
          timerMode: 'countdown',
          timerDurationSeconds: 120,
          servings: '',
          date: '',
          mealType: 'bad',
          createMealLog: false,
          planItemId: 'plan-1',
          adjustments: '少油',
          resultNote: '成功',
          rating: '5',
        },
        recipe,
        null
      )
    ).toEqual({
      currentStepIndex: 1,
      checkedIngredientIds: ['ri-1'],
      completedStepIds: ['step-1'],
      timerSeconds: 0,
      timerRunning: true,
      timerMode: 'countdown',
      timerDurationSeconds: 120,
      servings: '2',
      date: expect.any(String),
      mealType: 'dinner',
      createMealLog: false,
      planItemId: 'plan-1',
      adjustments: '少油',
      resultNote: '成功',
      rating: '5',
    });
  });

  it('builds editable shopping drafts from recipe shortages with requirement labels', () => {
    const card = {
      recipe: {
        id: 'recipe-1',
        family_id: 'family-1',
        title: '番茄炒蛋',
        servings: 2,
        prep_minutes: 12,
        difficulty: 'easy',
        ingredient_items: [
          { id: 'ri-tomato', ingredient_id: tomato.id, ingredient_name: '番茄', quantity: 2, unit: '个', note: '' },
          { id: 'ri-egg', ingredient_id: egg.id, ingredient_name: '鸡蛋', quantity: 1, unit: '枚', note: '可选：加一个更香' },
        ],
        steps: [],
        tips: '',
        scene_tags: [],
        images: [],
        cook_logs: [],
        created_at: '2026-05-01T10:00:00Z',
        updated_at: '2026-05-01T10:00:00Z',
      },
      shortages: [
        { ingredientId: tomato.id, ingredientName: '番茄', requiredQuantity: 2, availableQuantity: 0.5, missingQuantity: 1.5, unit: '个' },
        { ingredientId: egg.id, ingredientName: '鸡蛋', requiredQuantity: 1, availableQuantity: 1, missingQuantity: 0, unit: '枚' },
      ],
    } satisfies Pick<RecipeCardViewModel, 'recipe' | 'shortages'>;

    expect(buildShoppingDraftsFromShortages(card)).toEqual([
      {
        id: 'shortage-ingredient-tomato',
        title: '番茄',
        quantity: '1.5',
        unit: '个',
        reason: '来自菜谱：番茄炒蛋',
        source: 'shortage',
        requirement: 'required',
        recipeIngredientId: 'ri-tomato',
      },
      {
        id: 'shortage-ingredient-egg',
        title: '鸡蛋',
        quantity: '1',
        unit: '枚',
        reason: '来自菜谱：番茄炒蛋',
        source: 'shortage',
        requirement: 'optional',
        recipeIngredientId: 'ri-egg',
      },
    ]);
    expect(buildRecipeShortageShoppingPayloads(card)).toEqual([
      { title: '番茄', quantity: 1.5, unit: '个', reason: '来自菜谱：番茄炒蛋' },
      { title: '鸡蛋', quantity: 1, unit: '枚', reason: '来自菜谱：番茄炒蛋' },
    ]);
  });

  it('detects optional recipe ingredients from notes and builds existing ingredient drafts', () => {
    expect(getRecipeShoppingRequirement({ note: '装饰用，可选' })).toBe('optional');
    expect(getRecipeShoppingRequirement({ note: '切块备用' })).toBe('required');

    expect(
      buildShoppingDraftFromRecipeIngredient('番茄炒蛋', {
        id: 'ri-egg',
        ingredient_id: egg.id,
        ingredient_name: '鸡蛋',
        quantity: 2,
        unit: '枚',
        note: '选用',
      })
    ).toMatchObject({
      id: 'existing-ri-egg',
      title: '鸡蛋',
      quantity: '2',
      unit: '枚',
      reason: '来自菜谱：番茄炒蛋',
      source: 'existing',
      requirement: 'optional',
      recipeIngredientId: 'ri-egg',
    });
  });

  it('builds custom shopping drafts and filters invalid payloads before submit', () => {
    const custom = buildCustomShoppingDraft('番茄炒蛋', { title: '  厨房纸 ', quantity: '2', unit: '包' });
    expect(custom).toMatchObject({
      title: '厨房纸',
      quantity: '2',
      unit: '包',
      source: 'custom',
      requirement: 'required',
    });
    expect(buildCustomShoppingDraft('番茄炒蛋', { title: '', quantity: '2', unit: '包' })).toBeNull();
    expect(buildCustomShoppingDraft('番茄炒蛋', { title: '盐', quantity: '0', unit: '包' })).toBeNull();

    expect(
      buildShoppingPayloadsFromDrafts([
        custom!,
        { id: 'bad-title', title: ' ', quantity: '1', unit: '个', reason: 'x', source: 'custom', requirement: 'required' },
        { id: 'bad-quantity', title: '盐', quantity: '-1', unit: '包', reason: 'x', source: 'custom', requirement: 'required' },
      ])
    ).toEqual([{ title: '厨房纸', quantity: 2, unit: '包', reason: '来自菜谱：番茄炒蛋' }]);
  });
});
