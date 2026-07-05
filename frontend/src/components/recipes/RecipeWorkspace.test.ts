import { beforeEach, describe, expect, it } from 'vitest';
import type { Ingredient } from '../../api/types';
import {
  buildCookPayload,
  buildCustomShoppingDraft,
  buildRecipeFormFromGeneratedDraft,
  buildRecipeIngredientCreatePayload,
  buildRecipePayload,
  buildRecipeShortageShoppingPayloads,
  buildRecipeUnresolvedIngredientTargets,
  buildShoppingDraftFromRecipeIngredient,
  buildShoppingDraftsFromShortages,
  buildShoppingPayloadsFromDrafts,
  formatCookPreviewRequestLabel,
  formatCookShortageDetail,
  formatCookShortageSummary,
  getCookCompletionMessage,
  getCookFinishStepStatus,
  getCookFinishStepStatusLabel,
  getCookPreviewActionLabel,
  getRecipeDraftGenerationButtonLabel,
  getRecipeDraftGenerationStepState,
  getRecipeShoppingRequirement,
  hasRecipeDraftMinimumInput,
  isAiGeneratedRecipeDraft,
  loadCookSession,
  parseRecipeUnresolvedIngredientError,
  recipeCookSessionKey,
  sanitizeCookSession,
  saveCookSession,
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
  beforeEach(() => {
    window.localStorage.clear();
  });

  it('builds trimmed recipe payloads with linked ingredient names, default units, and media ids', () => {
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

  it('parses unresolved ingredient API errors and maps them back to editable rows', () => {
    const rows: RecipeDraftIngredient[] = [
      { id: 'row-empty', ingredient_id: '', ingredient_name: '   ', quantity: 1, unit: '个', note: '' },
      { id: 'row-tomato', ingredient_id: tomato.id, ingredient_name: '番茄', quantity: 2, unit: '个', note: '' },
      { id: 'row-tofu', ingredient_id: '', ingredient_name: ' 嫩豆腐 ', quantity: 200, unit: '克', note: '切块' },
    ];
    const unresolvedItems = parseRecipeUnresolvedIngredientError({
      payload: {
        detail: {
          code: 'recipe_unresolved_ingredients',
          items: [
            {
              index: 1,
              ingredient_id: null,
              ingredient_name: '嫩豆腐',
              quantity: 200,
              unit: '克',
              note: '切块',
              reason: 'missing_ingredient_id',
            },
          ],
        },
      },
    });

    expect(unresolvedItems).toEqual([
      {
        index: 1,
        ingredient_id: null,
        ingredient_name: '嫩豆腐',
        quantity: 200,
        unit: '克',
        note: '切块',
        reason: 'missing_ingredient_id',
      },
    ]);
    expect(buildRecipeUnresolvedIngredientTargets(unresolvedItems!, rows)).toEqual([
      {
        index: 1,
        ingredient_id: null,
        ingredient_name: '嫩豆腐',
        quantity: 200,
        unit: '克',
        note: '切块',
        reason: 'missing_ingredient_id',
        rowId: 'row-tofu',
      },
    ]);
  });

  it('builds a conservative ingredient payload from an unresolved recipe row', () => {
    expect(
      buildRecipeIngredientCreatePayload({
        index: 0,
        rowId: 'row-tofu',
        ingredient_id: null,
        ingredient_name: ' 嫩豆腐 ',
        quantity: 200,
        unit: '克',
        note: '',
        reason: 'missing_ingredient_id',
      })
    ).toEqual({
      name: '嫩豆腐',
      category: '未分类',
      default_unit: '克',
      unit_conversions: [],
      quantity_tracking_mode: 'track_quantity',
      default_storage: '冷藏',
      default_expiry_mode: 'none',
      default_expiry_days: null,
      default_low_stock_threshold: null,
      notes: '从菜谱缺失食材创建',
      media_ids: [],
      pending_image_job_id: null,
    });
  });

  it('maps generated AI recipe drafts into editable form state', () => {
    const result = buildRecipeFormFromGeneratedDraft(
      {
        title: '番茄炖蛋',
        servings: 3,
        prep_minutes: 18,
        difficulty: 'medium',
        ingredient_items: [
          { ingredient_id: tomato.id, ingredient_name: '番茄', quantity: 2, unit: '个', note: '切块' },
          { ingredient_id: null, ingredient_name: '葱花', quantity: 1, unit: '撮', note: '可选：出锅点缀' },
        ],
        steps: [
          {
            title: '备菜',
            text: '番茄洗净切块，鸡蛋打散。',
            icon: 'tomato',
            summary: '处理食材',
            estimated_minutes: 5,
            tip: '番茄切均匀。',
            key_points: ['切块一致', '蛋液打散'],
          },
        ],
        tips: '少油少盐，适合晚餐。',
        scene_tags: ['晚餐', '清淡'],
        media_ids: [],
      },
      recipeForm({ images: {} })
    );

    expect(result.form).toMatchObject({
      title: '番茄炖蛋',
      servings: '3',
      prepMinutes: '18',
      difficulty: 'medium',
      tips: '少油少盐，适合晚餐。',
      sceneTags: '晚餐、清淡',
    });
    expect(result.form.steps[0]).toMatchObject({
      title: '备菜',
      icon: 'tomato',
      estimatedMinutes: '5',
      keyPoints: '切块一致\n蛋液打散',
    });
    expect(result.ingredients).toMatchObject([
      { ingredient_id: tomato.id, ingredient_name: '番茄', quantity: 2, unit: '个', note: '切块' },
      { ingredient_id: '', ingredient_name: '葱花', quantity: 1, unit: '撮', note: '可选：出锅点缀' },
    ]);
  });

  it('validates AI recipe draft shape before filling the editor', () => {
    expect(
      isAiGeneratedRecipeDraft({
        title: '番茄炖蛋',
        servings: 2,
        prep_minutes: 18,
        difficulty: 'easy',
        ingredient_items: [{ ingredient_id: tomato.id, ingredient_name: '番茄', quantity: 2, unit: '个', note: '切块' }],
        steps: [{ title: '备菜', text: '洗净切块', icon: 'tomato', summary: '处理', estimated_minutes: 5, tip: '切均匀', key_points: ['切块'] }],
        tips: '少油',
        scene_tags: ['晚餐'],
        media_ids: [],
      })
    ).toBe(true);
    expect(isAiGeneratedRecipeDraft({ title: '旧结构', ingredient_items: [], steps: ['洗净切块'] })).toBe(false);
    expect(
      isAiGeneratedRecipeDraft({
        title: '缺字段',
        servings: 2,
        prep_minutes: 18,
        difficulty: 'easy',
        ingredient_items: [],
        steps: [],
      })
    ).toBe(false);
  });

  it('requires a title, ingredient, or prompt before requesting an AI recipe draft', () => {
    expect(hasRecipeDraftMinimumInput(recipeForm({ title: '番茄炒蛋' }), [], '')).toBe(true);
    expect(hasRecipeDraftMinimumInput(recipeForm(), [{ id: 'row-1', ingredient_id: tomato.id, ingredient_name: '', quantity: 1, unit: '个', note: '' }], '')).toBe(true);
    expect(hasRecipeDraftMinimumInput(recipeForm(), [], ' 清淡少油 ')).toBe(true);
    expect(
      hasRecipeDraftMinimumInput(
        recipeForm({ title: '', tips: '' }),
        [{ id: 'row-1', ingredient_id: '', ingredient_name: ' ', quantity: 1, unit: '个', note: '' }],
        ''
      )
    ).toBe(false);
  });

  it('returns clear AI recipe generation button labels for each stage', () => {
    expect(getRecipeDraftGenerationButtonLabel('idle')).toBe('AI 补全菜谱');
    expect(getRecipeDraftGenerationButtonLabel('drafting')).toBe('正在生成菜谱');
    expect(getRecipeDraftGenerationButtonLabel('imaging')).toBe('正在生成封面');
    expect(getRecipeDraftGenerationButtonLabel('done')).toBe('已填入表单');
    expect(getRecipeDraftGenerationButtonLabel('error')).toBe('重新生成');
  });

  it('keeps recipe generation progress on the failed drafting step', () => {
    expect(getRecipeDraftGenerationStepState('error', 0)).toBe('completed');
    expect(getRecipeDraftGenerationStepState('error', 1)).toBe('error');
    expect(getRecipeDraftGenerationStepState('error', 2)).toBe('pending');
    expect(getRecipeDraftGenerationStepState('done', 3)).toBe('completed');
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
      food_plan_item_id: 'plan-1',
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

    expect(
      buildCookPayload({
        servings: '2',
        date: '2026-05-16',
        mealType: 'dinner',
        createMealLog: true,
        planItemId: null,
        resultNote: '',
        adjustments: '',
        rating: '',
        allowPartialInventoryDeduction: true,
      })
    ).toMatchObject({
      servings: 2,
      allow_partial_inventory_deduction: true,
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
      timers: [
        {
          id: 'default-timer',
          name: '炒制',
          seconds: 0,
          running: true,
          lastTickedAt: expect.any(Number),
          mode: 'countdown',
          durationSeconds: 120,
          source: 'step',
          stepId: 'step-2',
        }
      ],
      activeTimerId: 'default-timer',
      servings: '2',
      date: expect.any(String),
      mealType: 'dinner',
      createMealLog: false,
      planItemId: 'plan-1',
      adjustments: '少油',
      resultNote: '成功',
      rating: '5',
      aiAssistantMessages: [],
    });
  });

  it('restores direct cook sessions saved within 24 hours', () => {
    const recipe = {
      id: 'recipe-1',
      servings: 2,
      steps: [{ id: 'step-1', title: '备菜', text: '备菜', icon: 'pan', summary: '', estimated_minutes: null, tip: '', key_points: [] }],
    };
    const now = Date.parse('2026-05-21T10:00:00Z');
    window.localStorage.setItem(
      recipeCookSessionKey(recipe.id),
      JSON.stringify({
        version: 2,
        savedAt: '2026-05-20T11:00:00Z',
        source: 'direct',
        planItemId: null,
        session: {
          currentStepIndex: 0,
          checkedIngredientIds: ['ri-1'],
          completedStepIds: [],
          timerSeconds: 8,
          timerRunning: false,
          timerMode: 'countup',
          timerDurationSeconds: null,
          servings: '2',
          date: '2026-05-21',
          mealType: 'dinner',
          createMealLog: true,
          planItemId: null,
          adjustments: '少油',
          resultNote: '',
          rating: '',
        },
      })
    );

    const loaded = loadCookSession(recipe, null, now);

    expect(loaded.restored).toBe(true);
    expect(loaded.session.checkedIngredientIds).toEqual(['ri-1']);
    expect(loaded.session.adjustments).toBe('少油');
  });

  it('saves and restores cooking assistant messages with the cook session', () => {
    const recipe = {
      id: 'recipe-ai-assistant',
      servings: 2,
      steps: [{ id: 'step-1', title: '备菜', text: '备菜', icon: 'pan', summary: '', estimated_minutes: null, tip: '', key_points: [] }],
    };
    const session = {
      ...sanitizeCookSession({}, recipe),
      aiAssistantMessages: [
        { id: 'assistant-welcome', role: 'assistant' as const, text: '我在这儿。' },
        { id: 'cook-user-1', role: 'user' as const, text: '帮我计时三分钟' },
        { id: 'cook-assistant-1', role: 'assistant' as const, text: '我帮你设一个三分钟倒计时。' },
      ],
    };

    saveCookSession(recipe.id, session);
    const loaded = loadCookSession(recipe, null, Date.now());

    expect(loaded.restored).toBe(true);
    expect(loaded.session.aiAssistantMessages).toEqual(session.aiAssistantMessages);
  });

  it('migrates legacy timer metadata and repairs an invalid active timer id', () => {
    const recipe = {
      servings: 2,
      steps: [
        { id: 'step-1', title: '备菜', text: '备菜', icon: 'pan', summary: '', estimated_minutes: 3, tip: '', key_points: [] },
        { id: 'step-2', title: '焖煮', text: '焖煮', icon: 'timer', summary: '', estimated_minutes: 8, tip: '', key_points: [] },
      ],
    };

    const session = sanitizeCookSession({
      currentStepIndex: 1,
      timers: [
        {
          id: 'legacy-step-timer',
          name: '焖煮 计时',
          seconds: 15,
          running: false,
          mode: 'countdown',
          durationSeconds: 480,
        },
        {
          id: 'legacy-manual-timer',
          name: '计时器 2',
          seconds: 0,
          running: false,
          mode: 'countup',
          durationSeconds: null,
        },
      ],
      activeTimerId: 'missing-timer',
    }, recipe);

    expect(session.activeTimerId).toBe('legacy-step-timer');
    expect(session.timers).toEqual([
      expect.objectContaining({
        id: 'legacy-step-timer',
        name: '焖煮',
        source: 'step',
        stepId: 'step-2',
      }),
      expect.objectContaining({
        id: 'legacy-manual-timer',
        name: '计时器 2',
        source: 'manual',
        stepId: null,
      }),
    ]);
  });

  it('does not restore direct cook sessions older than 24 hours', () => {
    const recipe = {
      id: 'recipe-2',
      servings: 2,
      steps: [],
    };
    const now = Date.parse('2026-05-21T10:00:00Z');
    const key = recipeCookSessionKey(recipe.id);
    window.localStorage.setItem(
      key,
      JSON.stringify({
        version: 2,
        savedAt: '2026-05-20T09:59:00Z',
        source: 'direct',
        planItemId: null,
        session: { currentStepIndex: 0 },
      })
    );

    const loaded = loadCookSession(recipe, null, now);

    expect(loaded.restored).toBe(false);
    expect(loaded.session.currentStepIndex).toBe(0);
    expect(window.localStorage.getItem(key)).toBeNull();
  });

  it('restores plan-linked cook sessions saved within 7 days for the same plan item', () => {
    const recipe = {
      id: 'recipe-3',
      servings: 4,
      steps: [
        { id: 'step-1', title: '备菜', text: '备菜', icon: 'pan', summary: '', estimated_minutes: null, tip: '', key_points: [] },
        { id: 'step-2', title: '炒制', text: '炒制', icon: 'pan', summary: '', estimated_minutes: null, tip: '', key_points: [] },
      ],
    };
    const now = Date.parse('2026-05-21T10:00:00Z');
    window.localStorage.setItem(
      recipeCookSessionKey(recipe.id, 'plan-1'),
      JSON.stringify({
        version: 2,
        savedAt: '2026-05-15T10:00:00Z',
        source: 'plan',
        planItemId: 'plan-1',
        session: {
          currentStepIndex: 1,
          checkedIngredientIds: [],
          completedStepIds: ['step-1'],
          timerSeconds: 0,
          timerRunning: false,
          timerMode: 'countup',
          timerDurationSeconds: null,
          servings: '4',
          date: '2026-05-21',
          mealType: 'dinner',
          createMealLog: true,
          planItemId: 'plan-1',
          adjustments: '',
          resultNote: '计划内继续做',
          rating: '',
        },
      })
    );

    const loaded = loadCookSession(recipe, 'plan-1', now);

    expect(loaded.restored).toBe(true);
    expect(loaded.session.currentStepIndex).toBe(1);
    expect(loaded.session.planItemId).toBe('plan-1');
    expect(loaded.session.resultNote).toBe('计划内继续做');
  });

  it('does not restore expired plan sessions or sessions for another plan item', () => {
    const recipe = {
      id: 'recipe-4',
      servings: 2,
      steps: [],
    };
    const now = Date.parse('2026-05-21T10:00:00Z');
    const expiredKey = recipeCookSessionKey(recipe.id, 'plan-old');
    const otherPlanKey = recipeCookSessionKey(recipe.id, 'plan-2');
    window.localStorage.setItem(
      expiredKey,
      JSON.stringify({
        version: 2,
        savedAt: '2026-05-14T09:59:00Z',
        source: 'plan',
        planItemId: 'plan-old',
        session: { currentStepIndex: 0 },
      })
    );
    window.localStorage.setItem(
      otherPlanKey,
      JSON.stringify({
        version: 2,
        savedAt: '2026-05-21T09:00:00Z',
        source: 'plan',
        planItemId: 'plan-2',
        session: { currentStepIndex: 0 },
      })
    );

    expect(loadCookSession(recipe, 'plan-old', now).restored).toBe(false);
    expect(window.localStorage.getItem(expiredKey)).toBeNull();
    expect(loadCookSession(recipe, 'plan-1', now).restored).toBe(false);
    expect(window.localStorage.getItem(otherPlanKey)).not.toBeNull();
  });

  it('does not restore legacy cook session data without savedAt metadata', () => {
    const recipe = {
      id: 'recipe-5',
      servings: 2,
      steps: [],
    };
    const legacyKey = `culina-recipe-cook-session:${recipe.id}`;
    window.localStorage.setItem(
      legacyKey,
      JSON.stringify({
        currentStepIndex: 1,
        checkedIngredientIds: ['ri-1'],
        planItemId: null,
      })
    );

    const loaded = loadCookSession(recipe, null, Date.parse('2026-05-21T10:00:00Z'));

    expect(loaded.restored).toBe(false);
    expect(loaded.session.checkedIngredientIds).toEqual([]);
    expect(window.localStorage.getItem(legacyKey)).toBeNull();
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
        ingredientId: tomato.id,
        title: '番茄',
        quantity: '1.5',
        unit: '个',
        quantityMode: 'track_quantity',
        displayLabel: null,
        reason: '来自菜谱：番茄炒蛋',
        source: 'shortage',
        requirement: 'required',
        recipeIngredientId: 'ri-tomato',
      },
      {
        id: 'shortage-ingredient-egg',
        ingredientId: egg.id,
        title: '鸡蛋',
        quantity: '1',
        unit: '枚',
        quantityMode: 'track_quantity',
        displayLabel: null,
        reason: '来自菜谱：番茄炒蛋',
        source: 'shortage',
        requirement: 'optional',
        recipeIngredientId: 'ri-egg',
      },
    ]);
    expect(buildRecipeShortageShoppingPayloads(card)).toEqual([
      {
        title: '番茄',
        quantity: 1.5,
        unit: '个',
        ingredient_id: tomato.id,
        quantity_mode: 'track_quantity',
        display_label: null,
        reason: '来自菜谱：番茄炒蛋',
      },
      {
        title: '鸡蛋',
        quantity: 1,
        unit: '枚',
        ingredient_id: egg.id,
        quantity_mode: 'track_quantity',
        display_label: null,
        reason: '来自菜谱：番茄炒蛋',
      },
    ]);
  });

  it('builds presence-only shopping drafts for not-tracked shortages', () => {
    const card = {
      recipe: {
        id: 'recipe-1',
        family_id: 'family-1',
        title: '番茄炒蛋',
        servings: 2,
        prep_minutes: 12,
        difficulty: 'easy',
        ingredient_items: [
          { id: 'ri-salt', ingredient_id: 'ingredient-salt', ingredient_name: '盐', quantity: 5, unit: 'g', note: '' },
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
        {
          ingredientId: 'ingredient-salt',
          ingredientName: '盐',
          requiredQuantity: 5,
          availableQuantity: 0,
          missingQuantity: 5,
          unit: 'g',
          shortageType: 'presence',
        },
      ],
    } satisfies Pick<RecipeCardViewModel, 'recipe' | 'shortages'>;

    expect(buildShoppingDraftsFromShortages(card)).toEqual([
      {
        id: 'shortage-ingredient-salt',
        ingredientId: 'ingredient-salt',
        title: '盐',
        quantity: '',
        unit: '',
        quantityMode: 'not_track_quantity',
        displayLabel: '需要补充',
        reason: '来自菜谱：番茄炒蛋',
        source: 'shortage',
        requirement: 'required',
        recipeIngredientId: 'ri-salt',
      },
    ]);
    expect(buildRecipeShortageShoppingPayloads(card)).toEqual([
      {
        title: '盐',
        quantity: null,
        unit: null,
        ingredient_id: 'ingredient-salt',
        quantity_mode: 'not_track_quantity',
        display_label: '需要补充',
        reason: '来自菜谱：番茄炒蛋',
      },
    ]);
  });

  it('formats presence shortages and not-tracked cook previews without fake quantities', () => {
    const presenceShortage = {
      ingredient_id: 'ingredient-salt',
      ingredient_name: '盐',
      required_quantity: 5,
      available_quantity: 0,
      missing_quantity: 5,
      unit: 'g',
      shortage_type: 'presence',
    };
    const quantityShortage = {
      ingredient_id: 'ingredient-tomato',
      ingredient_name: '番茄',
      required_quantity: 2,
      available_quantity: 0.5,
      missing_quantity: 1.5,
      unit: '个',
      shortage_type: 'quantity',
    };

    expect(formatCookShortageSummary(presenceShortage)).toBe('盐 需补充');
    expect(formatCookShortageDetail(presenceShortage)).toBe('还没有可用库存记录，本次会先记录缺料提醒，不会扣减这项库存。');
    expect(formatCookShortageSummary(quantityShortage)).toBe('番茄 1.5个');
    expect(formatCookShortageDetail(quantityShortage)).toBe('还缺 1.5个，本次会先扣减现有库存，缺少部分仅记录提醒。');
    expect(
      formatCookPreviewRequestLabel({
        requested_quantity: 5,
        unit: 'g',
        quantity_tracking_mode: 'not_track_quantity',
      })
    ).toBe('5g · 只判断有无');
    expect(getCookPreviewActionLabel([{ batches: [] }])).toBe('确认完成');
    expect(getCookPreviewActionLabel([{ batches: [{ inventory_item_id: 'inventory-1' }] }])).toBe('确认扣库存');
    expect(
      getCookCompletionMessage(
        {
          consumed_items: [
            {
              ingredient_id: 'ingredient-salt',
              ingredient_name: '盐',
              requested_quantity: 5,
              unit: 'g',
              quantity_tracking_mode: 'not_track_quantity',
              deduction_note: '仅确认有库存，未扣减数量',
              affected_item_ids: [],
            },
          ],
          shortages: [],
        },
        true
      )
    ).toBe('已记录完成并生成餐食记录，本次没有需要扣减的数量库存。');
    expect(
      getCookCompletionMessage(
        {
          consumed_items: [
            {
              ingredient_id: 'ingredient-tomato',
              ingredient_name: '番茄',
              requested_quantity: 2,
              unit: '个',
              quantity_tracking_mode: 'track_quantity',
              affected_item_ids: ['inventory-1'],
            },
            {
              ingredient_id: 'ingredient-salt',
              ingredient_name: '盐',
              requested_quantity: 5,
              unit: 'g',
              quantity_tracking_mode: 'not_track_quantity',
              affected_item_ids: [],
            },
          ],
          shortages: [],
        },
        false
      )
    ).toBe('已扣减数量库存；只记录有无的食材未扣减数量。');
    expect(
      getCookCompletionMessage(
        {
          consumed_items: [
            {
              ingredient_id: 'ingredient-tomato',
              ingredient_name: '番茄',
              requested_quantity: 2,
              unit: '个',
              quantity_tracking_mode: 'track_quantity',
              affected_item_ids: ['inventory-1'],
            },
          ],
          shortages: [quantityShortage],
        },
        true
      )
    ).toBe('已扣减库存并生成餐食记录，还有 1 项缺料已保留提醒。');
  });

  it('tracks finish cooking step statuses', () => {
    expect(
      getCookFinishStepStatus({
        stepId: 'inventory',
        completedStepIds: [],
        skippedStepIds: [],
      })
    ).toBe('pending');
    expect(
      getCookFinishStepStatus({
        stepId: 'meal',
        completedStepIds: ['meal'],
        skippedStepIds: [],
      })
    ).toBe('completed');
    expect(
      getCookFinishStepStatus({
        stepId: 'feedback',
        completedStepIds: [],
        skippedStepIds: ['feedback'],
      })
    ).toBe('skipped');
    expect(
      getCookFinishStepStatus({
        stepId: 'inventory',
        completedStepIds: ['inventory'],
        skippedStepIds: [],
        hasInventoryAttention: true,
      })
    ).toBe('attention');
    expect(getCookFinishStepStatusLabel('attention')).toBe('需留意');
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
      ingredientId: egg.id,
    });
  });

  it('builds custom shopping drafts only from selected ingredients and filters invalid payloads before submit', () => {
    expect(buildCustomShoppingDraft('番茄炒蛋', { ingredientId: null, title: '  厨房纸 ', quantity: '2', unit: '包' })).toBeNull();

    const custom = buildCustomShoppingDraft('番茄炒蛋', {
      ingredientId: egg.id,
      title: '  鸡蛋 ',
      quantity: '2',
      unit: '枚',
    });
    expect(custom).toMatchObject({
      ingredientId: egg.id,
      title: '鸡蛋',
      quantity: '2',
      unit: '枚',
      source: 'custom',
      requirement: 'required',
    });
    expect(buildCustomShoppingDraft('番茄炒蛋', { ingredientId: egg.id, title: '', quantity: '2', unit: '包' })).toBeNull();
    expect(buildCustomShoppingDraft('番茄炒蛋', { ingredientId: egg.id, title: '盐', quantity: '0', unit: '包' })).toBeNull();

    expect(
      buildShoppingPayloadsFromDrafts([
        custom!,
        { id: 'bad-title', title: ' ', quantity: '1', unit: '个', reason: 'x', source: 'custom', requirement: 'required' },
        { id: 'bad-quantity', title: '盐', quantity: '-1', unit: '包', reason: 'x', source: 'custom', requirement: 'required' },
        { id: 'bad-ingredient', title: '盐', quantity: '1', unit: '包', reason: 'x', source: 'custom', requirement: 'required' },
      ])
    ).toEqual([
      {
        title: '鸡蛋',
        quantity: 2,
        unit: '枚',
        ingredient_id: egg.id,
        quantity_mode: 'track_quantity',
        display_label: null,
        reason: '来自菜谱：番茄炒蛋',
      },
    ]);
  });
});
