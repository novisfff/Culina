import React, { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from '../../api/client';
import type { AiApprovalRequest, AiResultCard, Food, Ingredient } from '../../api/types';
import { cleanupTestDomAndMocks, flushAsync, renderWithQuery, waitForAsync } from '../../test/renderWithQuery';
import { ResultCard } from './AiResultCards';
import { MessageBubble } from './AiConversationThread';
import { ApprovalPanel } from './AiWorkspace';
import { approval, mealPlanApproval, qualityMetrics, recipeDraft, shoppingApproval } from './aiWorkspaceTestFixtures';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function recipeOperationApproval(action: 'update' | 'delete', overrides: Partial<AiApprovalRequest> = {}): AiApprovalRequest {
  const beforeRecipe = recipeDraft('番茄鸡蛋面');
  const draft = {
    draftType: 'recipe',
    schemaVersion: 'recipe_operation.v1',
    action,
    targetId: 'recipe-tomato-noodle',
    before: {
      ...beforeRecipe,
      favorite: false,
      media_ids: ['media-recipe-1'],
      deleteImpact: {
        linkedFoodCount: 1,
        planItemCount: 2,
        cookLogCount: 3,
        mediaCount: 1,
      },
    },
    payload: action === 'delete'
        ? { reason: '重复菜谱' }
        : {
            ...recipeDraft('番茄鸡蛋面升级版'),
            ingredient_items: [
              { ingredient_id: 'ingredient-tomato', ingredient_name: '番茄', quantity: 2, unit: '个', note: '切块' },
            ],
            steps: [
              { title: '备菜', text: '番茄切块。', icon: 'bowl', summary: '备菜', estimated_minutes: 5, tip: '', key_points: ['切块'] },
              { title: '烹调', text: '中火煮熟。', icon: 'pan', summary: '烹调', estimated_minutes: 10, tip: '', key_points: ['中火'] },
            ],
          },
  };
  return approval({
    approval_type: `recipe.${action}`,
    title: action === 'delete' ? '确认删除菜谱' : '确认修改菜谱',
    approve_label: action === 'delete' ? '删除菜谱' : '修改菜谱',
    reject_label: '暂不处理',
    draft_schema_version: 'recipe_operation.v1',
    field_schema: [{ name: 'draft', label: '草稿内容', type: 'object', widget: 'textarea', required: true }],
    initial_values: { draft },
    submitted_values: {},
    ...overrides,
  });
}

function recipeCookApproval(
  draftOverrides: Record<string, unknown> = {},
  overrides: Partial<AiApprovalRequest> = {},
  schemaVersion: 'recipe_cook_operation.v1' | 'recipe_cook_operation.v2' = 'recipe_cook_operation.v2',
): AiApprovalRequest {
  const draft = {
    draftType: 'recipe_cook',
    schemaVersion,
    recipeId: 'recipe-tomato-egg',
    title: '番茄炒蛋',
    baseUpdatedAt: '2026-06-10T00:00:00Z',
    before: {
      recipeId: 'recipe-tomato-egg',
      title: '番茄炒蛋',
      defaultServings: 2,
      updatedAt: '2026-06-10T00:00:00Z',
      linkedPlanItem: {
        plan_date: '2026-06-12',
        meal_type: 'dinner',
        food_name: '番茄炒蛋',
        status: 'planned',
      },
    },
    servings: 2,
    date: '2026-06-12',
    mealType: 'dinner',
    participantUserIds: ['user-1'],
    notes: '少油',
    ...(schemaVersion === 'recipe_cook_operation.v1' ? { createMealLog: true } : {}),
    planItemId: 'plan-item-1',
    planItemBaseUpdatedAt: '2026-06-10T01:00:00Z',
    resultNote: '口味刚好',
    adjustments: '鸡蛋多加一个',
    rating: 5,
    previewItems: [
      {
        ingredient_id: 'ingredient-tomato',
        ingredient_name: '番茄',
        requested_quantity: 2,
        unit: '个',
        batches: [
          {
            inventory_item_id: 'inventory-tomato-1',
            quantity: 2,
            unit: '个',
            purchase_date: '2026-06-08',
            expiry_date: '2026-06-15',
            storage_location: '冷藏',
          },
        ],
      },
    ],
    shortages: [],
    ...draftOverrides,
  };
  return approval({
    approval_type: 'recipe.cook',
    title: '确认做菜执行',
    approve_label: '确认做菜',
    reject_label: '暂不执行',
    draft_schema_version: schemaVersion,
    field_schema: [{ name: 'draft', label: '草稿内容', type: 'object', widget: 'textarea', required: true }],
    initial_values: { draft },
    submitted_values: {},
    ...overrides,
  });
}

function makeRecipeCookApproval(
  schemaVersion: 'recipe_cook_operation.v1' | 'recipe_cook_operation.v2',
  draftOverrides: Record<string, unknown> = {},
) {
  return recipeCookApproval(draftOverrides, {}, schemaVersion);
}

function mealPlanOperationApproval(overrides: Partial<AiApprovalRequest> = {}): AiApprovalRequest {
  const draft = {
    draftType: 'meal_plan',
    schemaVersion: 'meal_plan_operation.v1',
    operations: [
      {
        operationId: 'ai-op-create',
        action: 'create',
        payload: {
          date: '2026-06-11',
          mealType: 'breakfast',
          title: '蓝莓酸奶',
          foodId: 'food-yogurt',
          reason: '快手早餐',
          missingIngredients: [],
        },
      },
      {
        operationId: 'ai-op-update',
        action: 'update',
        targetId: 'plan-item-1',
        baseUpdatedAt: '2026-06-10T00:00:00Z',
        before: {
          date: '2026-06-12',
          mealType: 'dinner',
          title: '番茄炒蛋',
          foodId: 'food-tomato-egg',
          status: 'planned',
        },
        payload: {
          date: '2026-06-12',
          mealType: 'lunch',
          title: '牛肉面',
          foodId: 'food-noodle',
          reason: '中午更合适',
          missingIngredientItems: [{ ingredientId: 'ingredient-beef', name: '牛肉', quantity: 200, unit: 'g' }],
        },
      },
      {
        operationId: 'ai-op-status',
        action: 'set_status',
        targetId: 'plan-item-2',
        baseUpdatedAt: '2026-06-10T00:00:00Z',
        before: {
          date: '2026-06-13',
          mealType: 'dinner',
          title: '白粥',
          status: 'planned',
        },
        payload: { status: 'cooked', reason: '已经做完' },
      },
      {
        operationId: 'ai-op-delete',
        action: 'delete',
        targetId: 'plan-item-3',
        baseUpdatedAt: '2026-06-10T00:00:00Z',
        before: {
          date: '2026-06-14',
          mealType: 'lunch',
          title: '蔬菜沙拉',
          foodId: 'food-salad',
          status: 'planned',
        },
        payload: { reason: '当天外出' },
      },
    ],
  };
  return approval({
    approval_type: 'meal_plan.apply',
    title: '确认修改餐食计划',
    approve_label: '修改计划',
    reject_label: '暂不修改',
    draft_schema_version: 'meal_plan_operation.v1',
    field_schema: [{ name: 'draft', label: '草稿内容', type: 'object', widget: 'textarea', required: true }],
    initial_values: { draft },
    submitted_values: {},
    ...overrides,
  });
}

function mealLogApproval(draftOverrides: Record<string, unknown> = {}, overrides: Partial<AiApprovalRequest> = {}): AiApprovalRequest {
  const draft = {
    draftType: 'meal_log',
    schemaVersion: 'meal_log.v1',
    date: '2026-06-10',
    mealType: 'dinner',
    foods: [{ foodId: 'food-tomato-egg', name: '番茄炒蛋', servings: 1, note: '少油' }],
    participantUserIds: ['user-1'],
    mediaIds: ['media-1'],
    mood: '满足',
    notes: '晚餐记录',
    ...draftOverrides,
  };
  return approval({
    approval_type: 'meal_log.create',
    title: '确认创建餐食记录',
    approve_label: '写入餐食记录',
    reject_label: '暂不写入',
    draft_schema_version: 'meal_log.v1',
    field_schema: [{ name: 'draft', label: '草稿内容', type: 'object', widget: 'textarea', required: true }],
    initial_values: { draft },
    submitted_values: {},
    ...overrides,
  });
}

function mealLogOperationCreateApproval(): AiApprovalRequest {
  return mealLogApproval(
    {
      schemaVersion: 'meal_log_operation.v1',
      action: 'create',
      payload: {
        date: '2026-06-11',
        mealType: 'breakfast',
        foods: [{ foodId: 'food-yogurt', name: '蓝莓酸奶', servings: 1, note: '加坚果' }],
        participantUserIds: ['user-1'],
        mediaIds: [],
        mood: '清淡',
        notes: '早餐记录',
      },
    },
    {
      approval_type: 'meal_log.create',
      draft_schema_version: 'meal_log_operation.v1',
      initial_values: {
        draft: {
          draftType: 'meal_log',
          schemaVersion: 'meal_log_operation.v1',
          action: 'create',
          payload: {
            date: '2026-06-11',
            mealType: 'breakfast',
            foods: [{ foodId: 'food-yogurt', name: '蓝莓酸奶', servings: 1, note: '加坚果' }],
            participantUserIds: ['user-1'],
            mediaIds: [],
            mood: '清淡',
            notes: '早餐记录',
          },
        },
      },
    },
  );
}

function mealLogUpdateDetailsApproval(): AiApprovalRequest {
  const draft = {
    draftType: 'meal_log',
    schemaVersion: 'meal_log_operation.v1',
    action: 'update_details',
    targetId: 'meal-log-1',
    before: {
      id: 'meal-log-1',
      date: '2026-06-10',
      mealType: 'dinner',
      foods: [{ id: 'entry-tomato-egg', foodName: '番茄炒蛋', servings: 1 }],
      participantUserIds: ['user-1'],
      mediaIds: [],
      mood: '',
      notes: '原备注',
    },
    payload: {
      participantUserIds: ['user-1', 'user-friend'],
      notes: '补充后的备注',
      mood: '聚餐',
      mediaIds: ['media-dinner-1'],
    },
  };
  return approval({
    approval_type: 'meal_log.update',
    title: '确认补充餐食记录',
    approve_label: '更新餐食记录',
    reject_label: '暂不更新',
    draft_schema_version: 'meal_log_operation.v1',
    field_schema: [{ name: 'draft', label: '草稿内容', type: 'object', widget: 'textarea', required: true }],
    initial_values: { draft },
    submitted_values: {},
  });
}

function mealLogRatingApproval(): AiApprovalRequest {
  const draft = {
    draftType: 'meal_log',
    schemaVersion: 'meal_log_operation.v1',
    action: 'rate_food',
    targetId: 'meal-log-1',
    before: {
      id: 'meal-log-1',
      date: '2026-06-10',
      mealType: 'dinner',
      foods: [{ id: 'entry-tomato-egg', foodName: '番茄炒蛋', rating: 4 }],
    },
    payload: {
      foodEntryRatings: [{ id: 'entry-tomato-egg', rating: 4, note: '口味稳定' }],
    },
  };
  return approval({
    approval_type: 'meal_log.rate_food',
    title: '确认更新餐食评分',
    approve_label: '更新评分',
    reject_label: '暂不更新',
    draft_schema_version: 'meal_log_operation.v1',
    field_schema: [{ name: 'draft', label: '草稿内容', type: 'object', widget: 'textarea', required: true }],
    initial_values: { draft },
    submitted_values: {},
  });
}

function foodProfileApproval(): AiApprovalRequest {
  const draft = {
    draftType: 'food_profile',
    schemaVersion: 'food_profile.v1',
    name: '蓝莓酸奶',
    type: 'readyMade',
    category: '饮品',
    flavor_tags: ['酸甜'],
    suitable_meal_types: ['breakfast'],
    source_name: '常买品牌',
    notes: '冷藏食用',
  };
  return approval({
    approval_type: 'food_profile.create',
    title: '确认创建食物资料',
    approve_label: '创建食物资料',
    reject_label: '暂不创建',
    draft_schema_version: 'food_profile.v1',
    field_schema: [{ name: 'draft', label: '草稿内容', type: 'object', widget: 'textarea', required: true }],
    initial_values: { draft },
    submitted_values: {},
  });
}

function foodProfileUpdateApproval(): AiApprovalRequest {
  const draft = {
    draftType: 'food_profile',
    schemaVersion: 'food_profile_operation.v1',
    action: 'update',
    targetId: 'food-yogurt',
    baseUpdatedAt: '2026-06-14T12:00:00Z',
    before: {
      id: 'food-yogurt',
      name: '蓝莓酸奶',
      type: 'readyMade',
      category: '饮品',
    },
    payload: {
      name: '蓝莓酸奶',
      type: 'readyMade',
      category: '饮品',
      flavor_tags: ['酸甜'],
      suitable_meal_types: ['breakfast'],
      source_name: '旧品牌',
      notes: '旧备注',
      favorite: false,
    },
  };
  return approval({
    approval_type: 'food.update',
    title: '确认更新食物资料',
    approve_label: '更新食物',
    reject_label: '暂不更新',
    draft_schema_version: 'food_profile_operation.v1',
    field_schema: [{ name: 'draft', label: '草稿内容', type: 'object', widget: 'textarea', required: true }],
    initial_values: { draft },
    submitted_values: {},
  });
}

function foodProfileFavoriteApproval(): AiApprovalRequest {
  const draft = {
    draftType: 'food_profile',
    schemaVersion: 'food_profile_operation.v1',
    action: 'set_favorite',
    targetId: 'food-yogurt',
    before: {
      id: 'food-yogurt',
      name: '蓝莓酸奶',
      type: 'readyMade',
      category: '饮品',
      favorite: false,
    },
    payload: {
      favorite: true,
    },
  };
  return approval({
    approval_type: 'food.favorite',
    title: '确认收藏食物',
    approve_label: '更新收藏',
    reject_label: '暂不更新',
    draft_schema_version: 'food_profile_operation.v1',
    field_schema: [{ name: 'draft', label: '草稿内容', type: 'object', widget: 'textarea', required: true }],
    initial_values: { draft },
    submitted_values: {},
  });
}

function ingredientProfileApproval(overrides: Partial<AiApprovalRequest> = {}): AiApprovalRequest {
  const draft = {
    draftType: 'ingredient_profile',
    schemaVersion: 'ingredient_profile.v1',
    action: 'create',
    payload: {
      name: '梅干菜',
      category: '干货/腌制菜',
      default_unit: '克',
      unit_conversions: [{ unit: '斤', ratio_to_default: 500 }],
      default_storage: '常温',
      default_expiry_mode: 'days',
      default_expiry_days: 180,
      default_low_stock_threshold: 50,
      notes: '用于榨菜咸肉炒丝瓜等菜谱，使用前可简单冲洗。',
    },
  };
  return approval({
    approval_type: 'ingredient.create',
    title: '确认创建食材档案',
    instruction: '确认后会创建当前家庭的食材档案。',
    approve_label: '创建食材',
    reject_label: '暂不创建',
    draft_schema_version: 'ingredient_profile.v1',
    field_schema: [{ name: 'draft', label: '草稿内容', type: 'object', widget: 'textarea', required: true }],
    initial_values: { draft },
    submitted_values: {},
    ...overrides,
  });
}

function compositeOperationApproval(draftOverrides: Record<string, unknown> = {}, overrides: Partial<AiApprovalRequest> = {}): AiApprovalRequest {
  const draft = {
    draftType: 'composite_operation',
    schemaVersion: 'composite_operation.v1',
    stepPreviews: [
      {
        stepId: 'create-ingredient',
        stepIndex: 1,
        domain: 'ingredient',
        domainLabel: '食材档案',
        action: 'create',
        actionLabel: '新增',
        title: '新增食材档案 · 鸡胸肉',
        summary: '创建默认冷冻保存的鸡胸肉',
        dependsOn: [],
        dependencyRefs: [],
        affectedEntityType: 'Ingredient',
        impact: { writesBusinessData: true, requiresApproval: true, usesDependencyResult: false, creates: 1 },
      },
      {
        stepId: 'restock',
        stepIndex: 2,
        domain: 'inventory',
        domainLabel: '库存',
        action: 'restock',
        actionLabel: '入库',
        title: '入库库存 · 鸡胸肉 500 克',
        summary: '鸡胸肉 500 克',
        dependsOn: ['create-ingredient'],
        dependencyRefs: [{ stepId: 'create-ingredient', path: 'entityId', ref: '$create-ingredient.entityId' }],
        affectedEntityType: 'InventoryItem',
        impact: { writesBusinessData: true, requiresApproval: true, usesDependencyResult: true, operationCount: 1 },
      },
    ],
    ...draftOverrides,
  };
  return approval({
    approval_type: 'composite_operation.preview',
    title: '复合操作预览',
    instruction: '先核对每一步影响。',
    approve_label: '确认',
    reject_label: '暂不执行',
    draft_schema_version: 'composite_operation.v1',
    field_schema: [{ name: 'draft', label: '草稿内容', type: 'object', widget: 'textarea', required: true }],
    initial_values: { draft },
    submitted_values: {},
    ...overrides,
  });
}

function unitMismatchInventoryApproval(): AiApprovalRequest {
  const draft = {
    draftType: 'inventory_operation',
    schemaVersion: 'inventory_operation.v1',
    operations: [
      {
        action: 'consume',
        ingredientId: 'ingredient-egg',
        ingredientName: '鸡蛋',
        quantity: 20,
        unit: '个',
        purchaseDate: '2026-06-16',
        expiryDate: null,
        storageLocation: '冷藏',
        status: 'fresh',
        notes: '',
        reason: '',
        sourceQuantity: 2,
        sourceUnit: '盒',
        conversionRatioToDefault: 10,
        conversionNote: '来自 2 盒，按 1 盒 = 10 个换算。',
      },
    ],
  };
  return approval({
    approval_type: 'inventory.operation',
    title: '确认处理库存',
    instruction: '确认后会正式修改家庭库存。',
    approve_label: '确认处理库存',
    reject_label: '暂不执行',
    draft_schema_version: 'inventory_operation.v1',
    field_schema: [{ name: 'draft', label: '草稿内容', type: 'object', widget: 'textarea', required: true }],
    initial_values: { draft },
    submitted_values: {},
  });
}

function changeInput(input: HTMLInputElement | HTMLTextAreaElement, value: string) {
  act(() => {
    const prototype = input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const valueSetter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set;
    valueSetter?.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

async function chooseSingleSelectOption(field: HTMLElement | undefined | null, optionText: string) {
  const trigger = field?.querySelector<HTMLButtonElement>('.ai-single-select-trigger');
  await act(async () => {
    trigger?.click();
  });
  const option = Array.from(field?.querySelectorAll<HTMLButtonElement>('.ai-single-select-menu button') ?? [])
    .find((button) => button.textContent?.includes(optionText));
  expect(option).toBeTruthy();
  await act(async () => {
    option?.click();
  });
}

afterEach(() => {
  cleanupTestDomAndMocks();
});

beforeEach(() => {
  vi.spyOn(api, 'getAiStatus').mockResolvedValue({
    enabled: true,
    provider: 'openai-compatible',
    model: 'fake-model',
    supports_vision: true,
    status: 'ready',
    detail: 'AI 已就绪。',
  });
  vi.spyOn(api, 'getAiQualityMetrics').mockResolvedValue(qualityMetrics());
  vi.spyOn(api, 'getFoods').mockResolvedValue([]);
  vi.spyOn(api, 'getIngredients').mockResolvedValue([]);
});

describe('ApprovalPanel', () => {
  it('renders clarification progress as waiting instead of completed', async () => {
    const rendered = await renderWithQuery(
      <MessageBubble
        message={{
          id: 'message-waiting',
          conversation_id: 'conversation-1',
          role: 'assistant',
          content: '购物清单里有 4 条“三文鱼”，请问要删除哪一条？',
          content_type: 'parts',
          parts: [
            { id: 'part-text', type: 'text', text: '购物清单里有 4 条“三文鱼”，请问要删除哪一条？' },
            {
              id: 'part-card',
              type: 'result_card',
              card: {
                id: 'card-clarification',
                type: 'clarification_request',
                title: '需要确认',
                data: {
                  question: '购物清单里有 4 条“三文鱼”，请问要删除哪一条？也可以回复“全部删除”。',
                  questionType: 'entity_disambiguation',
                  missingFields: ['目标条目'],
                  candidates: [],
                  allowFreeText: true,
                },
              } as unknown as AiResultCard,
            },
          ],
          run_id: 'run-waiting',
          status: 'completed',
          metadata: {},
          created_at: '2026-05-30T00:00:00Z',
        }}
        user={{ id: 'user-1', username: 'me', display_name: '我', avatar_seed: 'seed', avatar_image: null }}
        runEvents={[
          {
            id: 'progress-start',
            run_id: 'run-waiting',
            type: 'skill',
            internal_code: 'shopping_list.start',
            user_message: '调用「购物清单」技能',
            status: 'running',
            created_at: '2026-05-30T00:00:00Z',
          },
          {
            id: 'progress-tool-waiting',
            run_id: 'run-waiting',
            type: 'tool',
            internal_code: 'human.request_input',
            user_message: '等待用户补充信息',
            status: 'waiting',
            created_at: '2026-05-30T00:00:01Z',
          },
          {
            id: 'progress-skill-waiting',
            run_id: 'run-waiting',
            type: 'skill',
            internal_code: 'shopping_list.waiting_clarification',
            user_message: '购物清单等待补充信息',
            status: 'waiting',
            created_at: '2026-05-30T00:00:02Z',
          },
        ]}
        onApprovalDecision={() => undefined}
      />,
    );

    const activityText = Array.from(rendered.container.querySelectorAll<HTMLElement>('.ai-run-activity')).map((item) => item.textContent).join('\n');
    expect(activityText).toContain('等待补充');
    expect(activityText).toContain('购物清单');
    expect(activityText).toContain('等待用户补充信息');
    expect(activityText).not.toContain('已完成');
    const skillRows = Array.from(rendered.container.querySelectorAll<HTMLElement>('.ai-run-activity-row.kind-skill'));
    expect(skillRows.some((row) => row.textContent === '调用技能：购物清单')).toBe(true);
    expect(skillRows.some((row) => row.querySelector('.ai-run-skill-icon'))).toBe(true);
    expect(skillRows.some((row) => row.className.includes('status-waiting'))).toBe(false);
    rendered.unmount();
  });

  it('renders unit conversion clarification cards without a generic error', async () => {
    const card: AiResultCard = {
      id: 'card-unit-mismatch',
      type: 'clarification_request',
      title: '需要确认单位换算',
      data: {
        question: '鸡蛋当前主单位是 个，尚未设置 盒。请确认这次 1 盒等于多少 个；确认后只按本次换算继续入库，不会自动保存为副单位。',
        questionType: 'unit_conversion',
        missingFields: ['单位换算'],
        candidates: [],
        allowFreeText: true,
      },
    } as unknown as AiResultCard;
    const rendered = await renderWithQuery(<ResultCard card={card} />);

    expect(rendered.container.textContent).toContain('需要确认单位换算');
    expect(rendered.container.textContent).toContain('鸡蛋当前主单位是 个');
    expect(rendered.container.textContent).toContain('请确认这次 1 盒等于多少 个');
    expect(rendered.container.textContent).not.toContain('AI 规划暂时失败');
    rendered.unmount();
  });

  it('shows submitted recipe values after approval is resolved', async () => {
    const resolvedApproval = approval({
      status: 'approved',
      submitted_values: { recipe: recipeDraft('最终提交菜谱') },
      decision: 'approved',
    });
    const rendered = await renderWithQuery(<ApprovalPanel approval={resolvedApproval} onDecision={() => undefined} />);
    expect(rendered.container.querySelector('.ai-recipe-summary-card')?.textContent).toContain('最终提交菜谱');
    expect(rendered.container.querySelector('.ai-recipe-summary-card')?.textContent).toContain('2 人份');
    expect(rendered.container.querySelector('.ai-recipe-summary-card input')).toBeNull();
    expect(rendered.container.textContent).toContain('已确认');
    rendered.unmount();
  });

  it('renders rejected approval status in Chinese', async () => {
    const rendered = await renderWithQuery(
      <ApprovalPanel
        approval={approval({ status: 'rejected', decision: 'rejected' })}
        onDecision={() => undefined}
      />,
    );
    expect(rendered.container.textContent).toContain('已拒绝');
    rendered.unmount();
  });

  it('renders cancelled approval status in Chinese', async () => {
    const rendered = await renderWithQuery(
      <ApprovalPanel
        approval={ingredientProfileApproval({ status: 'cancelled', decision: 'rejected' })}
        onDecision={() => undefined}
      />,
    );

    expect(rendered.container.querySelector('.ai-approval-status')?.textContent).toBe('已取消');
    expect(rendered.container.textContent).not.toContain('cancelled');
    rendered.unmount();
  });

  it('splits collapsed ingredient approval summary into short badges', async () => {
    const rendered = await renderWithQuery(
      <ApprovalPanel
        approval={ingredientProfileApproval({
          status: 'cancelled',
          decision: 'rejected',
          initial_values: {
            draft: {
              draftType: 'ingredient_profile',
              schemaVersion: 'ingredient_profile.v1',
              action: 'create',
              payload: {
                name: '沙拉',
                category: '其他',
                default_unit: '份',
                unit_conversions: [],
                default_storage: '冷藏',
                default_expiry_mode: 'none',
                default_expiry_days: null,
                default_low_stock_threshold: null,
                notes: '',
              },
            },
          },
        })}
        onDecision={() => undefined}
      />,
    );

    const badges = Array.from(rendered.container.querySelectorAll('.ai-approval-brief-badge'));
    expect(badges.map((badge) => badge.textContent)).toEqual(['新增', '沙拉', '其他', '份']);
    expect(rendered.container.textContent).not.toContain('新增 · 沙拉 · 其他 · 份');
    rendered.unmount();
  });

  it('shows structured failure summary for retry approvals', async () => {
    const rendered = await renderWithQuery(
      <ApprovalPanel
        approval={shoppingApproval({
          approval_type: 'shopping_list.apply.retry',
          title: '重试购物清单写入',
          instruction: '上次写入失败：操作 ai_op_item_1 失败：版本冲突。',
          failure_summary: {
            errorMessage: '操作 ai_op_item_1 失败：版本冲突，当前购物项已变更。',
            failedOperationIds: ['ai_op_item_1'],
            failedOperationSummaries: [
              {
                operationId: 'ai_op_item_1',
                action: 'set_done',
                targetId: 'shopping-item-1',
                summary: '状态变更 鸡蛋',
                currentValue: {
                  id: 'shopping-item-1',
                  label: '鸡蛋',
                  summary: '1 盒 · 待购买',
                  payload: {
                    id: 'shopping-item-1',
                    title: '鸡蛋',
                    quantity: 1,
                    unit: '盒',
                    done: false,
                  },
                },
                recoveryHint: '当前业务值已经变化，建议先核对下面的最新内容；如果只是时间或状态被别人改过，请按最新值调整草稿后重试。',
              },
            ],
          },
        })}
        onDecision={() => undefined}
      />,
    );
    expect(rendered.container.textContent).toContain('以下 1 项需要重新确认');
    expect(rendered.container.textContent).toContain('状态变更 鸡蛋');
    expect(rendered.container.textContent).toContain('操作 ID · ai_op_item_1');
    expect(rendered.container.textContent).toContain('检测到版本或基线冲突');
    expect(rendered.container.textContent).toContain('当前业务值');
    expect(rendered.container.textContent).toContain('鸡蛋');
    expect(rendered.container.textContent).toContain('1 盒 · 待购买');
    expect(rendered.container.textContent).toContain('按最新值调整草稿后重试');
    expect(rendered.container.querySelector('[role="alert"]')?.textContent).toContain('上次写入失败');
    rendered.unmount();
  });

  it('does not ask for a reason when confirming shopping item deletion', async () => {
    const rendered = await renderWithQuery(
      <ApprovalPanel
        approval={shoppingApproval({
          approval_type: 'shopping_list.apply',
          title: '确认应用购物清单变更',
          approve_label: '确认删除',
          draft_schema_version: 'shopping_list_operation.v1',
          initial_values: {
            draft: {
              draftType: 'shopping_list',
              schemaVersion: 'shopping_list_operation.v1',
              operations: [
                {
                  operationId: 'ai_op_item_1',
                  action: 'delete',
                  targetId: 'shopping-salmon-4',
                  baseUpdatedAt: '2026-06-16T09:00:00Z',
                  before: {
                    id: 'shopping-salmon-4',
                    title: '三文鱼',
                    quantity: 1,
                    unit: '块',
                    done: false,
                  },
                  payload: {},
                },
              ],
            },
          },
        })}
        onDecision={() => undefined}
      />,
    );

    expect(rendered.container.textContent).toContain('删除采购项');
    expect(rendered.container.textContent).toContain('删除采购项：三文鱼 · 1 块 · 待买');
    expect(rendered.container.textContent).toContain('不会删除食材档案，也不会调整库存数量');
    expect(rendered.container.querySelector('[role="alert"]')?.textContent).toContain('删除影响');
    expect(rendered.container.textContent).not.toContain('删除原因');
    expect(rendered.container.textContent).not.toContain('为什么需要采购');
    expect(rendered.container.querySelector('textarea.text-input')).toBeNull();
    rendered.unmount();
  });

  it('renders composite operation step previews as read-only impact cards', async () => {
    const rendered = await renderWithQuery(
      <ApprovalPanel approval={compositeOperationApproval()} onDecision={() => undefined} />,
    );

    expect(rendered.container.textContent).toContain('待确认复合操作');
    expect(rendered.container.textContent).toContain('第一阶段只支持整体确认或拒绝');
    expect(rendered.container.textContent).toContain('执行顺序');
    expect(rendered.container.textContent).toContain('步骤2 步');
    expect(rendered.container.textContent).toContain('涉及领域食材档案、库存');
    expect(rendered.container.textContent).toContain('写入影响新增 1 · 更新 0 · 删除 0 · 库存 1');
    expect(rendered.container.textContent).toContain('新增食材档案 · 鸡胸肉');
    expect(rendered.container.textContent).toContain('入库库存 · 鸡胸肉 500 克');
    expect(rendered.container.textContent).toContain('使用前面步骤创建或更新的结果');
    expect(rendered.container.textContent).toContain('使用前置结果');
    expect(rendered.container.textContent).toContain('风险与回滚');
    expect(rendered.container.textContent).toContain('风险较低');
    expect(rendered.container.textContent).not.toContain('依赖 · create-ingredient');

    const details = rendered.container.querySelector('details.ai-composite-operation-technical-details') as HTMLDetailsElement | null;
    expect(details).not.toBeNull();
    expect(details?.open).toBe(false);
    rendered.unmount();
  });

  it('blocks composite approvals without executable steps', async () => {
    const onDecision = vi.fn();
    const rendered = await renderWithQuery(
      <ApprovalPanel
        approval={compositeOperationApproval({ stepPreviews: [] })}
        onDecision={onDecision}
      />,
    );

    const approve = Array.from(rendered.container.querySelectorAll('button')).find((button) => button.textContent === '确认');
    await act(async () => approve?.click());
    expect(rendered.container.querySelector('[role="alert"]')?.textContent).toContain('复合操作至少需要 1 个步骤');
    expect(onDecision).not.toHaveBeenCalled();
    rendered.unmount();
  });

  it('compresses resolved composite operations into an execution summary', async () => {
    const rendered = await renderWithQuery(
      <ApprovalPanel
        approval={compositeOperationApproval({}, { status: 'approved' })}
        onDecision={() => undefined}
      />,
    );

    expect(rendered.container.textContent).toContain('复合操作已执行');
    expect(rendered.container.textContent).toContain('保留执行结果摘要');
    expect(rendered.container.textContent).toContain('执行结果');
    expect(rendered.container.querySelector('.ai-approval-actions')).toBeNull();
    rendered.unmount();
  });

  it('renders temporary unit conversion inventory approval with converted and source quantities', async () => {
    const rendered = await renderWithQuery(
      <ApprovalPanel approval={unitMismatchInventoryApproval()} onDecision={() => undefined} />,
    );

    expect(rendered.container.textContent).toContain('主要处理项');
    expect(rendered.container.textContent).toContain('鸡蛋');
    expect((rendered.container.querySelector('.quantity-input') as HTMLInputElement | null)?.value).toBe('20');
    expect(
      Array.from(rendered.container.querySelectorAll<HTMLInputElement>('input[role="combobox"]'))
        .some((input) => input.value === '个'),
    ).toBe(true);
    expect(rendered.container.textContent).toContain('来自 2 盒，按 1 盒 = 10 个换算。');
    rendered.unmount();
  });

  it('submits edited recipe values and keeps the returned values visible', async () => {
    const pending = approval();
    const decideSpy = vi.fn().mockResolvedValue(undefined);
    const rendered = await renderWithQuery(<ApprovalPanel approval={pending} onDecision={decideSpy} />);
    const titleInput = rendered.container.querySelector<HTMLInputElement>('input.text-input');
    expect(titleInput).not.toBeNull();
    changeInput(titleInput as HTMLInputElement, '用户编辑后的菜谱');
    await act(async () => {
      rendered.container.querySelector<HTMLButtonElement>('button.solid-button')?.click();
    });
    await flushAsync();
    expect(decideSpy).toHaveBeenCalledWith(
      pending,
      'approved',
      { recipe: expect.objectContaining({ title: '用户编辑后的菜谱' }) },
      '',
    );
    expect((rendered.container.querySelector('input.text-input') as HTMLInputElement).value).toBe('用户编辑后的菜谱');
    rendered.unmount();
  });

  it('keeps the editor retryable when parent submission fails', async () => {
    const pending = approval();
    const rendered = await renderWithQuery(<ApprovalPanel approval={pending} onDecision={() => Promise.reject(new Error('sync failed'))} />);
    await act(async () => {
      rendered.container.querySelector<HTMLButtonElement>('button.solid-button')?.click();
    });
    await flushAsync();
    const titleInput = rendered.container.querySelector<HTMLInputElement>('input.text-input');
    expect(rendered.container.textContent).toContain('sync failed');
    expect(rendered.container.querySelector('[role="alert"]')?.textContent).toContain('sync failed');
    expect(titleInput?.disabled).toBe(false);
    rendered.unmount();
  });

  it('submits rejection without validating edited draft contents', async () => {
    const pending = unitMismatchInventoryApproval();
    pending.initial_values = {
      draft: {
        ...pending.initial_values.draft,
        operations: [
          {
            ...((pending.initial_values.draft as { operations: Array<Record<string, unknown>> }).operations[0]),
            action: 'dispose',
            reason: '',
          },
        ],
      },
    };
    const decideSpy = vi.fn().mockResolvedValue(undefined);
    const rendered = await renderWithQuery(<ApprovalPanel approval={pending} onDecision={decideSpy} />);
    await act(async () => {
      rendered.container.querySelector<HTMLButtonElement>('.ai-approval-actions .ghost-button')?.click();
    });
    await flushAsync();
    expect(rendered.container.querySelector('[role="alert"]')?.textContent ?? '').not.toContain('销毁库存必须填写原因');
    expect(decideSpy).toHaveBeenCalledWith(pending, 'rejected', {}, '');
    rendered.unmount();
  });

  it('submits shopping list drafts from structured fields instead of raw JSON', async () => {
    const pending = shoppingApproval();
    const decideSpy = vi.fn().mockResolvedValue(undefined);
    const ingredients = [
      { id: 'ingredient-egg', name: '鸡蛋', category: '蛋奶', default_unit: '盒', image: { url: '/ingredient-egg.jpg' } },
      { id: 'ingredient-milk', name: '牛奶', category: '蛋奶', default_unit: '瓶', image: { url: '/ingredient-milk.jpg' } },
    ] as Ingredient[];
    const rendered = await renderWithQuery(<ApprovalPanel approval={pending} ingredients={ingredients} onDecision={decideSpy} />);
    const titleInput = rendered.container.querySelector<HTMLInputElement>('.ai-shopping-list-draft-editor .ai-resource-field-ingredient input');
    expect(titleInput?.value).toBe('鸡蛋');
    await act(async () => {
      titleInput?.focus();
    });
    await waitForAsync();
    const milkOption = Array.from(rendered.container.querySelectorAll<HTMLButtonElement>('.ai-resource-menu button')).find((button) => button.textContent?.includes('牛奶'));
    expect(milkOption).toBeTruthy();
    await act(async () => {
      milkOption?.click();
    });
    const unitInput = rendered.container.querySelector<HTMLInputElement>('.ai-shopping-list-draft-editor .ai-resource-field-combobox input');
    expect(unitInput?.value).toBe('瓶');
    await act(async () => {
      unitInput?.focus();
    });
    changeInput(unitInput as HTMLInputElement, '箱');
    expect(rendered.container.textContent).toContain('使用自定义：箱');
    await act(async () => {
      rendered.container.querySelector<HTMLButtonElement>('button.solid-button')?.click();
    });
    await flushAsync();
    expect(decideSpy).toHaveBeenCalledWith(
      pending,
      'approved',
      { draft: expect.objectContaining({ items: [expect.objectContaining({ title: '牛奶', unit: '箱' })] }) },
      '',
    );
    rendered.unmount();
  });

  it('keeps numeric draft inputs empty while users replace an existing value', async () => {
    const pending = shoppingApproval();
    const decideSpy = vi.fn().mockResolvedValue(undefined);
    const ingredients = [
      { id: 'ingredient-egg', name: '鸡蛋', category: '蛋奶', default_unit: '盒' },
    ] as Ingredient[];
    const rendered = await renderWithQuery(<ApprovalPanel approval={pending} ingredients={ingredients} onDecision={decideSpy} />);
    const quantityInput = rendered.container.querySelector<HTMLInputElement>('.ai-shopping-list-draft-editor input[type="number"]');

    expect(quantityInput?.value).toBe('1');
    changeInput(quantityInput as HTMLInputElement, '');
    expect(quantityInput?.value).toBe('');
    changeInput(quantityInput as HTMLInputElement, '2');
    expect(quantityInput?.value).toBe('2');

    await act(async () => {
      rendered.container.querySelector<HTMLButtonElement>('button.solid-button')?.click();
    });
    await flushAsync();
    expect(decideSpy).toHaveBeenCalledWith(
      pending,
      'approved',
      { draft: expect.objectContaining({ items: [expect.objectContaining({ quantity: 2 })] }) },
      '',
    );
    rendered.unmount();
  });

  it('renders shopping list drafts with summary, quantity mode dropdown, and unit combobox', async () => {
    const pending = shoppingApproval({
      initial_values: {
        draft: {
          draftType: 'shopping_list',
          schemaVersion: 'shopping_list.v1',
          items: [
            { title: '鸡蛋', ingredient_id: 'ingredient-egg', quantityMode: 'track_quantity', quantity: 1, unit: '盒', reason: '补充早餐' },
            { title: '盐', ingredient_id: 'ingredient-salt', quantity_mode: 'not_track_quantity', display_label: '家里快没了', reason: '调味常用' },
          ],
        },
      },
    });
    const ingredients = [
      { id: 'ingredient-egg', name: '鸡蛋', category: '蛋奶', default_unit: '盒' },
      { id: 'ingredient-salt', name: '盐', category: '调味', default_unit: '袋' },
    ] as Ingredient[];
    const rendered = await renderWithQuery(<ApprovalPanel approval={pending} ingredients={ingredients} onDecision={() => undefined} />);

    expect(rendered.container.querySelector('.ai-shopping-list-summary-card')?.textContent).toContain('待确认购物清单');
    expect(rendered.container.querySelector('.ai-shopping-list-summary-card')?.textContent).toContain('已绑定食材2 项');
    expect(rendered.container.querySelector('.ai-shopping-list-summary-card')?.textContent).toContain('只提醒补充1 项');
    expect(rendered.container.querySelector('.ai-draft-summary-card.ai-shopping-list-summary-card')).not.toBeNull();
    expect(rendered.container.querySelector('.ai-draft-section')?.textContent).toContain('采购项');
    const quantityModeField = Array.from(rendered.container.querySelectorAll<HTMLElement>('.ai-shopping-list-draft-editor .ai-resource-field-choice'))
      .find((field) => field.textContent?.includes('数量模式'));
    expect(quantityModeField?.textContent).toContain('记录数量');
    expect(rendered.container.querySelector<HTMLInputElement>('.ai-shopping-list-draft-editor .ai-resource-field-combobox input')?.value).toBe('盒');
    await chooseSingleSelectOption(quantityModeField, '只提醒需要补充');
    expect(quantityModeField?.textContent).toContain('只提醒需要补充');
    rendered.unmount();
  });

  it('blocks shopping list approval when an item is not bound to the ingredient library', async () => {
    const pending = shoppingApproval({
      initial_values: {
        draft: {
          draftType: 'shopping_list',
          schemaVersion: 'shopping_list.v1',
          items: [{ title: '鸡蛋', quantityMode: 'track_quantity', quantity: 1, unit: '盒', reason: '补充常用食材' }],
        },
      },
    });
    const decideSpy = vi.fn().mockResolvedValue(undefined);
    const rendered = await renderWithQuery(<ApprovalPanel approval={pending} onDecision={decideSpy} />);

    await act(async () => {
      rendered.container.querySelector<HTMLButtonElement>('.ai-approval-actions .solid-button')?.click();
    });
    await flushAsync();

    expect(rendered.container.querySelector('[role="alert"]')?.textContent).toContain('采购项食材必须从食材库选择');
    expect(decideSpy).not.toHaveBeenCalled();
    rendered.unmount();
  });

  it('shows resolved shopping list approvals as compact summaries without disabled forms', async () => {
    const resolved = shoppingApproval({
      status: 'approved',
      decision: 'approved',
      submitted_values: {
        draft: {
          draftType: 'shopping_list',
          schemaVersion: 'shopping_list.v1',
          items: [{ title: '鸡蛋', ingredient_id: 'ingredient-egg', quantityMode: 'track_quantity', quantity: 1, unit: '盒', reason: '补充常用食材' }],
        },
      },
    });
    const rendered = await renderWithQuery(<ApprovalPanel approval={resolved} onDecision={() => undefined} />);

    expect(rendered.container.querySelector('.ai-shopping-list-summary-card')?.textContent).toContain('购物清单已确认');
    expect(rendered.container.querySelector('.ai-draft-resolved-summary.ai-shopping-list-summary-card')).not.toBeNull();
    expect(rendered.container.textContent).toContain('采购项预览');
    expect(rendered.container.querySelector('.ai-shopping-list-draft-editor input')).toBeNull();
    rendered.unmount();
  });

  it('uses the shared card layout and dropdowns for recipe confirmations', async () => {
    const pending = approval();
    const decideSpy = vi.fn().mockResolvedValue(undefined);
    const ingredients = [
      { id: 'ingredient-tomato', name: '番茄', category: '蔬菜', default_unit: '个', image: { url: '/ingredient-tomato.jpg' } },
    ] as Ingredient[];
    const rendered = await renderWithQuery(<ApprovalPanel approval={pending} ingredients={ingredients} onDecision={decideSpy} />);

    expect(rendered.container.textContent).toContain('确认创建菜谱');
    expect(rendered.container.querySelector('.ai-approval-actions .solid-button')?.textContent).toContain('创建菜谱');
    expect(rendered.container.querySelectorAll('button[type="submit"]')).toHaveLength(0);
    expect(rendered.container.querySelectorAll('.ai-recipe-draft-editor .ai-confirmation-item').length).toBeGreaterThan(2);
    expect(rendered.container.textContent).toContain('菜谱信息');
    expect(rendered.container.textContent).toContain('食材');
    expect(rendered.container.textContent).toContain('烹饪步骤');
    expect(rendered.container.textContent).toContain('补充信息');

    const difficultyField = Array.from(rendered.container.querySelectorAll<HTMLElement>('.ai-recipe-draft-editor .ai-resource-field-choice'))
      .find((field) => field.textContent?.includes('难度'));
    const stepIconField = Array.from(rendered.container.querySelectorAll<HTMLElement>('.ai-recipe-draft-editor .ai-resource-field-choice'))
      .find((field) => field.textContent?.includes('步骤图标'));
    expect(difficultyField?.textContent).toContain('简单');
    expect(stepIconField?.textContent).toContain('调味');
    await chooseSingleSelectOption(difficultyField, '适中');
    await chooseSingleSelectOption(stepIconField, '计时');

    const ingredientInput = rendered.container.querySelector<HTMLInputElement>('.ai-recipe-draft-editor .ai-resource-field-ingredient input');
    await act(async () => {
      ingredientInput?.focus();
    });
    await waitForAsync();
    const tomatoOption = Array.from(rendered.container.querySelectorAll<HTMLButtonElement>('.ai-resource-menu button')).find((button) => button.textContent?.includes('番茄'));
    expect(tomatoOption).toBeTruthy();
    await act(async () => {
      tomatoOption?.click();
    });
    await flushAsync();
    const ingredientQuantityInput = rendered.container.querySelector<HTMLInputElement>('.ai-recipe-ingredient-card input[type="number"]');
    const stepKeyPointsInput = rendered.container.querySelector<HTMLInputElement>('input[aria-label="关键点"]');
    changeInput(ingredientQuantityInput as HTMLInputElement, '3');
    changeInput(stepKeyPointsInput as HTMLInputElement, '中火、收汁');
    await act(async () => {
      rendered.container.querySelector<HTMLButtonElement>('.ai-approval-actions .solid-button')?.click();
    });
    await flushAsync();
    expect(decideSpy).toHaveBeenCalledWith(
      pending,
      'approved',
      {
        recipe: expect.objectContaining({
          difficulty: 'medium',
          ingredient_items: [expect.objectContaining({ ingredient_id: 'ingredient-tomato', ingredient_name: '番茄', quantity: 3 })],
          steps: expect.arrayContaining([expect.objectContaining({ icon: 'timer', key_points: ['中火', '收汁'] })]),
        }),
      },
      '',
    );
    rendered.unmount();
  });

  it('blocks recipe approval when an ingredient is not bound to the ingredient library', async () => {
    const pending = approval({
      initial_values: {
        recipe: {
          ...recipeDraft('未绑定食材菜谱'),
          ingredient_items: [{ ingredient_id: null, ingredient_name: '番茄', quantity: 2, unit: '个', note: '切块' }],
        },
      },
    });
    const decideSpy = vi.fn().mockResolvedValue(undefined);
    const rendered = await renderWithQuery(<ApprovalPanel approval={pending} onDecision={decideSpy} />);

    expect(rendered.container.textContent).toContain('未绑定到食材库');
    await act(async () => {
      rendered.container.querySelector<HTMLButtonElement>('.ai-approval-actions .solid-button')?.click();
    });
    await flushAsync();

    expect(rendered.container.querySelector('[role="alert"]')?.textContent).toContain('菜谱食材必须从食材库选择');
    expect(decideSpy).not.toHaveBeenCalled();
    rendered.unmount();
  });

  it('renders recipe update operations with full ingredient and step editors', async () => {
    const pending = recipeOperationApproval('update');
    const decideSpy = vi.fn().mockResolvedValue(undefined);
    const rendered = await renderWithQuery(<ApprovalPanel approval={pending} onDecision={decideSpy} />);

    expect(rendered.container.textContent).toContain('修改菜谱');
    expect(rendered.container.textContent).toContain('食材匹配');
    expect(rendered.container.textContent).toContain('烹饪步骤');
    expect(rendered.container.textContent).toContain('关键点');
    expect(rendered.container.textContent).toContain('当前：番茄鸡蛋面 · 2人份 · 简单');
    expect(rendered.container.textContent).toContain('调整后：番茄鸡蛋面升级版 · 2人份 · 简单');
    expect(rendered.container.textContent).not.toContain('食材和步骤变更会在摘要里计数');
    expect(rendered.container.querySelector<HTMLInputElement>('input[role="combobox"]')?.value).toBe('个');

    const stepIconField = Array.from(rendered.container.querySelectorAll<HTMLElement>('.ai-recipe-draft-editor .ai-resource-field-choice'))
      .find((field) => field.textContent?.includes('步骤图标'));
    await chooseSingleSelectOption(stepIconField, '计时');
    await act(async () => {
      rendered.container.querySelector<HTMLButtonElement>('.ai-approval-actions .solid-button')?.click();
    });
    await flushAsync();

    expect(decideSpy).toHaveBeenCalledWith(
      pending,
      'approved',
      {
        draft: expect.objectContaining({
          action: 'update',
          payload: expect.objectContaining({
            ingredient_items: [expect.objectContaining({ ingredient_id: 'ingredient-tomato', unit: '个' })],
            steps: expect.arrayContaining([expect.objectContaining({ icon: 'timer' })]),
          }),
        }),
      },
      '',
    );
    rendered.unmount();
  });

  it('blocks recipe update operations when an ingredient is not bound', async () => {
    const invalid = recipeOperationApproval('update');
    const draft = invalid.initial_values.draft as Record<string, unknown>;
    const payload = draft.payload as Record<string, unknown>;
    const pending = {
      ...invalid,
      initial_values: {
        draft: {
          ...draft,
          payload: {
            ...payload,
            ingredient_items: [{ ingredient_id: null, ingredient_name: '番茄', quantity: 2, unit: '个', note: '' }],
          },
        },
      },
    };
    const decideSpy = vi.fn().mockResolvedValue(undefined);
    const rendered = await renderWithQuery(<ApprovalPanel approval={pending} onDecision={decideSpy} />);

    expect(rendered.container.textContent).toContain('未绑定到食材库');
    await act(async () => {
      rendered.container.querySelector<HTMLButtonElement>('.ai-approval-actions .solid-button')?.click();
    });
    await flushAsync();

    expect(rendered.container.querySelector('[role="alert"]')?.textContent).toContain('菜谱食材必须从食材库选择');
    expect(decideSpy).not.toHaveBeenCalled();
    rendered.unmount();
  });

  it('renders recipe delete operations as danger impact cards', async () => {
    const pending = recipeOperationApproval('delete');
    const rendered = await renderWithQuery(<ApprovalPanel approval={pending} onDecision={() => undefined} />);

    expect(rendered.container.querySelector('.ai-recipe-danger-impact')?.textContent).toContain('被删菜谱：番茄鸡蛋面');
    expect(rendered.container.querySelector('.ai-recipe-danger-impact')?.textContent).toContain('同步食物：1 个');
    expect(rendered.container.querySelector('.ai-recipe-danger-impact')?.textContent).toContain('关联计划：2 条');
    expect(rendered.container.querySelector('.ai-recipe-danger-impact')?.textContent).toContain('历史烹饪：3 条');
    expect(rendered.container.querySelector('.ai-recipe-danger-impact')?.textContent).toContain('媒体绑定：1 个');
    expect(rendered.container.querySelector('[role="alert"]')?.textContent).toContain('删除影响');
    rendered.unmount();
  });

  it('blocks retired recipe favorite operations from being approved', async () => {
    const original = recipeOperationApproval('update');
    const legacyDraft = original.initial_values.draft as Record<string, unknown>;
    const pending = {
      ...original,
      approval_type: 'recipe.favorite',
      initial_values: {
        draft: {
          ...legacyDraft,
          action: 'set_favorite',
          payload: { favorite: true },
        },
      },
    };
    const decideSpy = vi.fn().mockResolvedValue(undefined);
    const rendered = await renderWithQuery(<ApprovalPanel approval={pending} onDecision={decideSpy} />);

    expect(rendered.container.querySelector('.ai-recipe-favorite-card')).toBeNull();
    await act(async () => {
      rendered.container.querySelector<HTMLButtonElement>('.ai-approval-actions .solid-button')?.click();
    });
    await flushAsync();

    expect(decideSpy).not.toHaveBeenCalled();
    rendered.unmount();
  });

  it('renders recipe cook approvals as summary sections with readable inventory preview', async () => {
    const rendered = await renderWithQuery(<ApprovalPanel approval={recipeCookApproval()} onDecision={() => undefined} />);

    expect(rendered.container.querySelector('.ai-recipe-cook-summary-card')?.textContent).toContain('番茄炒蛋');
    expect(rendered.container.querySelector('.ai-draft-summary-card.ai-recipe-cook-summary-card')?.textContent).toContain('日期');
    expect(rendered.container.textContent).toContain('做菜结果');
    expect(rendered.container.textContent).toContain('食材与库存');
    expect(rendered.container.textContent).toContain('执行设置');
    expect(rendered.container.textContent).toContain('库存扣减预览');
    expect(rendered.container.textContent).toContain('缺料与阻断');
    expect(rendered.container.textContent).toContain('餐食记录补充');
    expect(rendered.container.textContent).toContain('完成后会记录这餐');
    expect(rendered.container.textContent).toContain('关联计划：2026-06-12 · 晚餐 · 番茄炒蛋 · 计划中');
    expect(rendered.container.textContent).toContain('需要 2 个');
    expect(rendered.container.textContent).toContain('批次 1：扣 2 个 · 冷藏 · 购于 2026-06-08 · 到期 2026-06-15');
    expect(rendered.container.querySelector<HTMLInputElement>('.ai-recipe-cook-draft-editor input[type="number"]')?.disabled).toBe(true);
    expect(rendered.container.textContent).toContain('份数会改变库存扣减预览，如需调整请重新生成草稿');
    rendered.unmount();
  });

  it('shows v1 createMealLog as requiring regeneration', async () => {
    const rendered = await renderWithQuery(
      <ApprovalPanel approval={makeRecipeCookApproval('recipe_cook_operation.v1', { createMealLog: true })} onDecision={() => undefined} />,
    );

    expect(rendered.container.textContent).toContain('这份旧草稿需要刷新后重新确认');
    expect(rendered.container.textContent).toContain('旧草稿需要刷新后重新确认');
    expect(rendered.container.querySelector<HTMLButtonElement>('.ai-approval-actions .solid-button')?.disabled).toBe(true);
    rendered.unmount();
  });

  it('never renders or submits createMealLog for v2', async () => {
    const pending = makeRecipeCookApproval('recipe_cook_operation.v2', { createMealLog: false });
    const decideSpy = vi.fn().mockResolvedValue(undefined);
    const rendered = await renderWithQuery(<ApprovalPanel approval={pending} onDecision={decideSpy} />);

    expect(rendered.container.textContent).not.toMatch(/createMealLog|只扣库存|不同步/);
    expect(rendered.container.textContent).toContain('完成后会记录这餐');

    await act(async () => {
      rendered.container.querySelector<HTMLButtonElement>('.ai-approval-actions .solid-button')?.click();
    });
    await flushAsync();

    expect(decideSpy).toHaveBeenCalledTimes(1);
    const submittedDraft = decideSpy.mock.calls[0]?.[2]?.draft as Record<string, unknown>;
    expect(submittedDraft).not.toHaveProperty('createMealLog');
    expect(submittedDraft.schemaVersion).toBe('recipe_cook_operation.v2');
    rendered.unmount();
  });

  it('marks v1 false as requiring regeneration instead of making it editable', async () => {
    const pending = makeRecipeCookApproval('recipe_cook_operation.v1', { createMealLog: false });
    const decideSpy = vi.fn().mockResolvedValue(undefined);
    const rendered = await renderWithQuery(<ApprovalPanel approval={pending} onDecision={decideSpy} />);

    expect(rendered.container.textContent).toContain('这份旧草稿需要刷新后重新确认');
    expect(rendered.container.querySelector<HTMLButtonElement>('.ai-approval-actions .solid-button')?.disabled).toBe(true);

    await act(async () => {
      rendered.container.querySelector<HTMLButtonElement>('.ai-approval-actions .solid-button')?.click();
    });
    await flushAsync();

    expect(decideSpy).not.toHaveBeenCalled();
    rendered.unmount();
  });

  it('submits recipe cook approvals with always-record semantics for v2', async () => {
    const pending = makeRecipeCookApproval('recipe_cook_operation.v2');
    const decideSpy = vi.fn().mockResolvedValue(undefined);
    const rendered = await renderWithQuery(<ApprovalPanel approval={pending} onDecision={decideSpy} />);

    await act(async () => {
      rendered.container.querySelector<HTMLButtonElement>('.ai-approval-actions .solid-button')?.click();
    });
    await flushAsync();

    expect(decideSpy).toHaveBeenCalledWith(
      pending,
      'approved',
      {
        draft: expect.objectContaining({
          draftType: 'recipe_cook',
          schemaVersion: 'recipe_cook_operation.v2',
          mealType: 'dinner',
          previewItems: [expect.objectContaining({ ingredient_name: '番茄' })],
        }),
      },
      '',
    );
    const submittedDraft = decideSpy.mock.calls[0]?.[2]?.draft as Record<string, unknown>;
    expect(submittedDraft).not.toHaveProperty('createMealLog');
    rendered.unmount();
  });

  it('blocks recipe cook approval when shortages are present', async () => {
    const pending = recipeCookApproval({
      shortages: [
        {
          ingredient_id: 'ingredient-egg',
          ingredient_name: '鸡蛋',
          required_quantity: 3,
          available_quantity: 1,
          missing_quantity: 2,
          unit: '个',
        },
      ],
    });
    const decideSpy = vi.fn().mockResolvedValue(undefined);
    const rendered = await renderWithQuery(<ApprovalPanel approval={pending} onDecision={decideSpy} />);

    expect(rendered.container.textContent).toContain('当前草稿不能确认执行');
    expect(rendered.container.textContent).toContain('鸡蛋');
    expect(Array.from(rendered.container.querySelectorAll('[role="note"]')).some((note) => note.textContent?.includes('库存提醒'))).toBe(true);
    await act(async () => {
      rendered.container.querySelector<HTMLButtonElement>('.ai-approval-actions .solid-button')?.click();
    });
    await flushAsync();

    expect(rendered.container.querySelector('[role="alert"]')?.textContent).toContain('当前做菜草稿包含缺料项');
    expect(decideSpy).not.toHaveBeenCalled();
    rendered.unmount();
  });

  it('shows resolved recipe cook Drafts as compact summaries', async () => {
    const pending = recipeCookApproval();
    const resolved = {
      ...pending,
      status: 'approved',
      decision: 'approved' as const,
      submitted_values: pending.initial_values,
    };
    const rendered = await renderWithQuery(<ApprovalPanel approval={resolved} onDecision={() => undefined} isLatest />);
    await act(async () => {
      rendered.container.querySelector<HTMLElement>('.ai-approval-head')?.click();
    });

    expect(rendered.container.querySelector('.ai-draft-resolved-summary.ai-recipe-cook-summary-card')?.textContent).toContain('做菜执行已确认');
    expect(rendered.container.querySelector('.ai-recipe-cook-draft-editor input, .ai-recipe-cook-draft-editor textarea')).toBeNull();
    rendered.unmount();
  });

  it('shows resource images and submits meal plan ingredient quantities', async () => {
    const pending = mealPlanApproval();
    const decideSpy = vi.fn().mockResolvedValue(undefined);
    const foods = [
      { id: 'food-tomato-egg', name: '番茄炒蛋', category: '家常菜', type: 'selfMade', images: [{ url: '/food-tomato-egg.jpg' }] },
      { id: 'food-noodle', name: '牛肉面', category: '主食', type: 'selfMade', images: [{ url: '/food-noodle.jpg' }] },
    ] as Food[];
    const ingredients = [
      { id: 'ingredient-beef', name: '牛肉', category: '肉类', default_unit: 'g', image: { url: '/ingredient-beef.jpg' } },
      { id: 'ingredient-potato', name: '土豆', category: '蔬菜', default_unit: '个', image: { url: '/ingredient-potato.jpg' } },
      { id: 'ingredient-tomato', name: '番茄', category: '蔬菜', default_unit: '个', image: { url: '/ingredient-tomato.jpg' } },
    ] as Ingredient[];
    const rendered = await renderWithQuery(<ApprovalPanel approval={pending} foods={foods} ingredients={ingredients} onDecision={decideSpy} />);

    expect(Array.from(rendered.container.querySelectorAll<HTMLInputElement>('.ai-meal-plan-ingredient-row .ai-resource-field-ingredient input')).map((input) => input.value)).toEqual(['牛肉', '土豆']);
    expect(rendered.container.querySelector<HTMLImageElement>('.ai-resource-field-food .ai-resource-thumbnail')?.src).toContain('/food-tomato-egg.jpg');
    expect(Array.from(rendered.container.querySelectorAll<HTMLImageElement>('.ai-meal-plan-ingredient-row .ai-resource-thumbnail')).map((image) => image.src)).toEqual(
      expect.arrayContaining([expect.stringContaining('/ingredient-beef.jpg'), expect.stringContaining('/ingredient-potato.jpg')]),
    );

    const beefQuantityInput = rendered.container.querySelector<HTMLInputElement>('input[aria-label="牛肉数量"]');
    expect(beefQuantityInput).not.toBeNull();
    changeInput(beefQuantityInput as HTMLInputElement, '250');
    const beefUnitInput = rendered.container.querySelector<HTMLInputElement>('input[aria-label="牛肉单位"]');
    expect(beefUnitInput).not.toBeNull();
    await act(async () => {
      beefUnitInput?.focus();
    });
    const kgOption = Array.from(rendered.container.querySelectorAll<HTMLButtonElement>('.ai-ingredient-unit-menu button')).find((button) => button.textContent?.includes('kg'));
    expect(kgOption).toBeTruthy();
    await act(async () => {
      kgOption?.click();
    });
    expect(beefUnitInput?.value).toBe('kg');

    const foodInput = rendered.container.querySelector<HTMLInputElement>('.ai-resource-field-food input');
    expect(foodInput).not.toBeNull();
    await act(async () => {
      foodInput?.focus();
    });
    await waitForAsync();
    expect(rendered.container.textContent).toContain('家常菜 · 自制食物');
    changeInput(foodInput as HTMLInputElement, '牛肉');
    await waitForAsync(240);
    expect(rendered.container.textContent).toContain('牛肉面');

    const ingredientInput = Array.from(rendered.container.querySelectorAll<HTMLInputElement>('.ai-resource-field-ingredient input')).find((input) => input.placeholder.includes('继续') || input.placeholder.includes('搜索'));
    expect(ingredientInput).not.toBeNull();
    await act(async () => {
      ingredientInput?.focus();
    });
    await waitForAsync();
    changeInput(ingredientInput as HTMLInputElement, '番茄');
    await waitForAsync(240);
    expect(rendered.container.textContent).toContain('番茄');
    await act(async () => {
      rendered.container.querySelector<HTMLButtonElement>('.ai-approval-actions .solid-button')?.click();
    });
    await flushAsync();
    expect(decideSpy).toHaveBeenCalledWith(
      pending,
      'approved',
      {
        draft: expect.objectContaining({
          items: [
            expect.objectContaining({
              missingIngredients: ['牛肉', '土豆'],
              missingIngredientItems: [
                { ingredientId: 'ingredient-beef', name: '牛肉', quantity: 250, unit: 'kg' },
                { ingredientId: 'ingredient-potato', name: '土豆', quantity: 1, unit: '个' },
              ],
            }),
          ],
        }),
      },
      '',
    );
    rendered.unmount();
  });

  it('uses the local resource thumbnail fallback when selected food and ingredients have no media', async () => {
    const pending = mealPlanApproval();
    const foods = [
      { id: 'food-tomato-egg', name: '番茄炒蛋', category: '家常菜', type: 'selfMade', images: [] },
      { id: 'food-noodle', name: '牛肉面', category: '主食', type: 'selfMade', images: [] },
    ] as unknown as Food[];
    const ingredients = [
      { id: 'ingredient-beef', name: '牛肉', category: '肉类', default_unit: 'g', image: null },
      { id: 'ingredient-potato', name: '土豆', category: '蔬菜', default_unit: '个', image: null },
    ] as Ingredient[];

    const rendered = await renderWithQuery(<ApprovalPanel approval={pending} foods={foods} ingredients={ingredients} onDecision={() => undefined} />);
    const thumbnails = Array.from(rendered.container.querySelectorAll<HTMLImageElement>('.ai-resource-thumbnail'));

    expect(thumbnails.length).toBeGreaterThanOrEqual(3);
    expect(thumbnails.map((image) => image.getAttribute('src'))).toEqual(
      expect.arrayContaining([
        '/assets/ai-food-ingredient-placeholder.png',
        '/assets/ai-food-ingredient-placeholder.png',
        '/assets/ai-food-ingredient-placeholder.png',
      ]),
    );
    rendered.unmount();
  });

  it('renders meal plan operation drafts with summary, before-after, status, and delete impact', async () => {
    const pending = mealPlanOperationApproval();
    const decideSpy = vi.fn().mockResolvedValue(undefined);
    const foods = [
      { id: 'food-yogurt', name: '蓝莓酸奶', category: '早餐', type: 'readyMade', images: [{ url: '/food-yogurt.jpg' }] },
      { id: 'food-noodle', name: '牛肉面', category: '主食', type: 'selfMade', images: [{ url: '/food-noodle.jpg' }] },
    ] as Food[];
    const ingredients = [
      { id: 'ingredient-beef', name: '牛肉', category: '肉类', default_unit: 'g', image: { url: '/ingredient-beef.jpg' } },
    ] as Ingredient[];
    const rendered = await renderWithQuery(<ApprovalPanel approval={pending} foods={foods} ingredients={ingredients} onDecision={decideSpy} />);

    expect(rendered.container.querySelector('.ai-meal-plan-summary-card')?.textContent).toContain('待确认计划变更');
    expect(rendered.container.querySelector('.ai-draft-summary-card.ai-meal-plan-summary-card')?.textContent).toContain('变更');
    expect(Array.from(rendered.container.querySelectorAll('[role="note"]')).some((note) => note.textContent?.includes('缺料提醒'))).toBe(true);
    expect(Array.from(rendered.container.querySelectorAll('[role="alert"]')).some((note) => note.textContent?.includes('删除影响'))).toBe(true);
    expect(rendered.container.textContent).toContain('变更新增1、修改1、状态变更1、删除1');
    expect(rendered.container.textContent).toContain('当前：2026-06-12 · 晚餐 · 番茄炒蛋');
    expect(rendered.container.textContent).toContain('调整后：2026-06-12 · 午餐 · 牛肉面');
    expect(rendered.container.textContent).toContain('状态：计划中 → 已完成');
    expect(rendered.container.textContent).toContain('删除影响');
    expect(rendered.container.textContent).toContain('不会删除食物资料');

    const statusField = Array.from(rendered.container.querySelectorAll<HTMLElement>('.ai-meal-plan-draft-editor .ai-resource-field-choice'))
      .find((field) => field.textContent?.includes('计划状态'));
    await chooseSingleSelectOption(statusField, '已跳过');
    await act(async () => {
      rendered.container.querySelector<HTMLButtonElement>('.ai-approval-actions .solid-button')?.click();
    });
    await flushAsync();
    expect(decideSpy).toHaveBeenCalledWith(
      pending,
      'approved',
      {
        draft: expect.objectContaining({
          operations: expect.arrayContaining([
            expect.objectContaining({
              action: 'set_status',
              payload: expect.objectContaining({ status: 'skipped' }),
            }),
          ]),
        }),
      },
      '',
    );
    rendered.unmount();
  });

  it('blocks meal plan approval when a plan item is not bound to the food library', async () => {
    const pending = mealPlanApproval({}, {
      items: [
        {
          date: '2026-06-10',
          mealType: 'dinner',
          title: '新菜',
          foodId: '',
          reason: 'AI 推荐',
          missingIngredients: [],
        },
      ],
    });
    const decideSpy = vi.fn().mockResolvedValue(undefined);
    const rendered = await renderWithQuery(<ApprovalPanel approval={pending} onDecision={decideSpy} />);

    await act(async () => {
      rendered.container.querySelector<HTMLButtonElement>('.ai-approval-actions .solid-button')?.click();
    });
    await flushAsync();
    expect(rendered.container.querySelector('[role="alert"]')?.textContent).toContain('计划项食物必须从食物库选择');
    expect(decideSpy).not.toHaveBeenCalled();
    rendered.unmount();
  });

  it('shows resolved meal plan approvals as compact summaries without disabled forms', async () => {
    const resolved = mealPlanApproval({
      status: 'approved',
      decision: 'approved',
      submitted_values: {
        draft: {
          draftType: 'meal_plan',
          schemaVersion: 'meal_plan.v1',
          items: [
            {
              date: '2026-06-10',
              mealType: 'dinner',
              title: '番茄炒蛋',
              foodId: 'food-tomato-egg',
              reason: '已确认',
              missingIngredients: [],
            },
          ],
        },
      },
    });
    const rendered = await renderWithQuery(<ApprovalPanel approval={resolved} onDecision={() => undefined} />);

    expect(rendered.container.querySelector('.ai-meal-plan-summary-card')?.textContent).toContain('餐食计划已确认');
    expect(rendered.container.textContent).toContain('计划项预览');
    expect(rendered.container.querySelector('.ai-meal-plan-draft-editor input')).toBeNull();
    rendered.unmount();
  });

  it('loads resource options in pages and resets pagination for search', async () => {
    const pending = mealPlanApproval();
    const foodOptions = Array.from({ length: 14 }, (_, index) => ({
      id: `food-${index + 1}`,
      label: index === 12 ? '番茄烩饭' : `食物 ${index + 1}`,
      description: '家常菜',
      imageUrl: `/food-${index + 1}.jpg`,
    }));
    const loader = vi.fn(async (kind: 'food' | 'ingredient', params: { query: string; offset: number; limit: number }) => {
      const source = kind === 'food' ? foodOptions : [];
      return source
        .filter((option) => !params.query || option.label.includes(params.query))
        .slice(params.offset, params.offset + params.limit);
    });
    const rendered = await renderWithQuery(
      <ApprovalPanel approval={pending} resourceOptionLoader={loader} onDecision={() => undefined} />,
    );
    const foodInput = rendered.container.querySelector<HTMLInputElement>('.ai-resource-field-food input');
    expect(foodInput).not.toBeNull();

    await act(async () => {
      foodInput?.focus();
    });
    await waitForAsync();
    expect(loader).toHaveBeenCalledWith('food', { query: '', offset: 0, limit: 6 });
    expect(rendered.container.querySelectorAll('.ai-resource-field-food .ai-resource-menu [role="option"]')).toHaveLength(6);

    const menu = rendered.container.querySelector<HTMLElement>('.ai-resource-field-food .ai-resource-menu');
    expect(menu).not.toBeNull();
    Object.defineProperties(menu as HTMLElement, {
      scrollHeight: { configurable: true, value: 300 },
      clientHeight: { configurable: true, value: 100 },
      scrollTop: { configurable: true, value: 200, writable: true },
    });
    await act(async () => {
      menu?.dispatchEvent(new Event('scroll', { bubbles: true }));
    });
    await waitForAsync();
    expect(loader).toHaveBeenCalledWith('food', { query: '', offset: 6, limit: 6 });
    expect(rendered.container.querySelectorAll('.ai-resource-field-food .ai-resource-menu [role="option"]')).toHaveLength(12);

    changeInput(foodInput as HTMLInputElement, '番茄');
    await waitForAsync(240);
    expect(loader).toHaveBeenLastCalledWith('food', { query: '番茄', offset: 0, limit: 6 });
    expect(rendered.container.querySelectorAll('.ai-resource-field-food .ai-resource-menu [role="option"]')).toHaveLength(1);
    expect(rendered.container.textContent).toContain('番茄烩饭');
    rendered.unmount();
  });

  it('uses food dropdowns and meal type selection for meal log confirmations', async () => {
    const pending = mealLogApproval();
    const decideSpy = vi.fn().mockResolvedValue(undefined);
    const foods = [
      { id: 'food-tomato-egg', name: '番茄炒蛋', category: '家常菜', type: 'selfMade', images: [{ url: '/food-tomato-egg.jpg' }] },
      { id: 'food-noodle', name: '牛肉面', category: '主食', type: 'selfMade', images: [{ url: '/food-noodle.jpg' }] },
    ] as Food[];
    const rendered = await renderWithQuery(<ApprovalPanel approval={pending} foods={foods} onDecision={decideSpy} />);
    expect(rendered.container.querySelectorAll('.ai-meal-log-draft-editor .ai-confirmation-item').length).toBeGreaterThan(3);
    expect(rendered.container.querySelector('.ai-draft-summary-card.ai-meal-log-summary-card')).not.toBeNull();
    const mealLogSections = Array.from(rendered.container.querySelectorAll<HTMLElement>('.ai-draft-section h3')).map((heading) => heading.textContent);
    expect(mealLogSections).toEqual(expect.arrayContaining(['餐食信息', '食物项', '参与人和照片', '备注与心情']));
    expect(rendered.container.textContent).toContain('2026-06-10');
    expect(rendered.container.textContent).toContain('晚餐');
    expect(rendered.container.textContent).toContain('食物1 项');
    expect(rendered.container.textContent).toContain('总份数1 份');
    expect(rendered.container.textContent).toContain('参与人1 人');
    expect(rendered.container.textContent).toContain('照片1 张');
    expect(rendered.container.textContent).toContain('关联计划未关联');
    expect(rendered.container.textContent).toContain('心情满足');
    expect(rendered.container.textContent).toContain('晚餐记录');
    expect(rendered.container.textContent).toContain('食物 1');
    expect(rendered.container.textContent).toContain('家常菜 · 自制食物');
    expect(rendered.container.textContent).toContain('1 份');
    expect(rendered.container.textContent).toContain('参与人和照片');
    expect(rendered.container.textContent).toContain('media-1');
    const mealField = Array.from(rendered.container.querySelectorAll<HTMLElement>('.ai-meal-log-draft-editor .ai-resource-field-choice'))
      .find((field) => field.textContent?.includes('餐别'));
    await chooseSingleSelectOption(mealField, '午餐');
    const foodInput = rendered.container.querySelector<HTMLInputElement>('.ai-meal-log-draft-editor .ai-resource-field-food input');
    await act(async () => {
      foodInput?.focus();
    });
    await waitForAsync();
    const noodleOption = Array.from(rendered.container.querySelectorAll<HTMLButtonElement>('.ai-resource-menu button')).find((button) => button.textContent?.includes('牛肉面'));
    expect(noodleOption).toBeTruthy();
    await act(async () => {
      noodleOption?.click();
    });
    await flushAsync();
    await act(async () => {
      rendered.container.querySelector<HTMLButtonElement>('.ai-approval-actions .solid-button')?.click();
    });
    await flushAsync();
    expect(decideSpy).toHaveBeenCalledWith(
      pending,
      'approved',
      {
        draft: expect.objectContaining({
          mealType: 'lunch',
          foods: [expect.objectContaining({ foodId: 'food-noodle', name: '牛肉面' })],
        }),
      },
      '',
    );
    rendered.unmount();
  });

  it('offers opt-in stock deduction only for ready-like meal log foods', async () => {
    const pending = mealLogApproval({
      foods: [
        {
          foodId: 'food-yogurt',
          name: '蓝莓酸奶',
          foodType: 'readyMade',
          servings: 1,
          note: '',
          deductStock: false,
          stockCurrentQuantity: '3',
          stockUnit: '盒',
        },
        {
          foodId: 'food-noodle',
          name: '牛肉面',
          foodType: 'selfMade',
          servings: 1,
          note: '',
          deductStock: false,
        },
      ],
    });
    const decideSpy = vi.fn().mockResolvedValue(undefined);
    const foods = [
      { id: 'food-yogurt', name: '蓝莓酸奶', category: '早餐', type: 'readyMade', stock_quantity: 3, stock_unit: '盒', images: [] },
      { id: 'food-noodle', name: '牛肉面', category: '主食', type: 'selfMade', stock_quantity: null, stock_unit: '', images: [] },
    ] as unknown as Food[];
    const rendered = await renderWithQuery(<ApprovalPanel approval={pending} foods={foods} onDecision={decideSpy} />);

    const stockToggles = rendered.container.querySelectorAll<HTMLInputElement>('.ai-meal-log-stock-toggle input[type="checkbox"]');
    expect(stockToggles).toHaveLength(1);
    expect(rendered.container.querySelector('[role="note"][aria-label="库存扣减说明"]')).not.toBeNull();
    expect(rendered.container.textContent).toContain('当前库存 3 盒');
    expect(rendered.container.querySelector('.ai-meal-log-stock-fields')).toBeNull();

    await act(async () => {
      stockToggles[0]?.click();
    });
    const quantityInput = rendered.container.querySelector<HTMLInputElement>('.ai-meal-log-stock-fields input[type="number"]');
    expect(quantityInput?.value).toBe('1');
    expect(rendered.container.textContent).toContain('确认后预计剩余 2 盒');
    changeInput(quantityInput as HTMLInputElement, '1.5');

    await act(async () => {
      rendered.container.querySelector<HTMLButtonElement>('.ai-approval-actions .solid-button')?.click();
    });
    await flushAsync();
    expect(decideSpy).toHaveBeenCalledWith(
      pending,
      'approved',
      {
        draft: expect.objectContaining({
          foods: [
            expect.objectContaining({
              foodId: 'food-yogurt',
              deductStock: true,
              stockQuantity: '1.5',
              stockUnit: '盒',
            }),
            expect.objectContaining({ foodId: 'food-noodle', deductStock: false }),
          ],
        }),
      },
      '',
    );
    rendered.unmount();
  });

  it('edits operation-create meal log drafts with the same structured sections', async () => {
    const pending = mealLogOperationCreateApproval();
    const decideSpy = vi.fn().mockResolvedValue(undefined);
    const foods = [
      { id: 'food-yogurt', name: '蓝莓酸奶', category: '早餐', type: 'readyMade', images: [{ url: '/food-yogurt.jpg' }] },
      { id: 'food-noodle', name: '牛肉面', category: '主食', type: 'selfMade', images: [{ url: '/food-noodle.jpg' }] },
    ] as Food[];
    const rendered = await renderWithQuery(<ApprovalPanel approval={pending} foods={foods} onDecision={decideSpy} />);

    expect(rendered.container.textContent).toContain('餐食信息');
    expect(rendered.container.textContent).toContain('食物项');
    expect(rendered.container.textContent).toContain('参与人和照片');
    expect(rendered.container.textContent).toContain('备注与心情');
    expect(rendered.container.textContent).toContain('蓝莓酸奶');
    const foodInput = rendered.container.querySelector<HTMLInputElement>('.ai-meal-log-draft-editor .ai-resource-field-food input');
    await act(async () => {
      foodInput?.focus();
    });
    await waitForAsync();
    const noodleOption = Array.from(rendered.container.querySelectorAll<HTMLButtonElement>('.ai-resource-menu button')).find((button) => button.textContent?.includes('牛肉面'));
    expect(noodleOption).toBeTruthy();
    await act(async () => {
      noodleOption?.click();
    });
    await flushAsync();
    await act(async () => {
      rendered.container.querySelector<HTMLButtonElement>('.ai-approval-actions .solid-button')?.click();
    });
    await flushAsync();
    expect(decideSpy).toHaveBeenCalledWith(
      pending,
      'approved',
      {
        draft: expect.objectContaining({
          action: 'create',
          payload: expect.objectContaining({
            foods: [expect.objectContaining({ foodId: 'food-noodle', name: '牛肉面' })],
          }),
        }),
      },
      '',
    );
    rendered.unmount();
  });

  it('shows meal log update references as read-only chips and edits mood through a combobox', async () => {
    const pending = mealLogUpdateDetailsApproval();
    const decideSpy = vi.fn().mockResolvedValue(undefined);
    const rendered = await renderWithQuery(<ApprovalPanel approval={pending} onDecision={decideSpy} />);

    expect(rendered.container.textContent).toContain('补充餐食记录');
    expect(rendered.container.textContent).toContain('参与人和照片');
    expect(rendered.container.textContent).toContain('user-friend');
    expect(rendered.container.textContent).toContain('media-dinner-1');
    expect(rendered.container.textContent).not.toContain('参与人 ID');
    expect(rendered.container.textContent).not.toContain('媒体 ID');
    const moodField = Array.from(rendered.container.querySelectorAll<HTMLElement>('.ai-meal-log-draft-editor .ai-resource-field-combobox'))
      .find((field) => field.textContent?.includes('心情'));
    const moodInput = moodField?.querySelector<HTMLInputElement>('input');
    expect(moodInput?.value).toBe('聚餐');
    await act(async () => {
      moodInput?.focus();
    });
    changeInput(moodInput as HTMLInputElement, '孩子喜欢');
    await flushAsync();
    await act(async () => {
      rendered.container.querySelector<HTMLButtonElement>('.ai-approval-actions .solid-button')?.click();
    });
    await flushAsync();
    expect(decideSpy).toHaveBeenCalledWith(
      pending,
      'approved',
      {
        draft: expect.objectContaining({
          action: 'update_details',
          payload: expect.objectContaining({
            mood: '孩子喜欢',
            participantUserIds: ['user-1', 'user-friend'],
            mediaIds: ['media-dinner-1'],
          }),
        }),
      },
      '',
    );
    rendered.unmount();
  });

  it('uses the shared star rating input for meal log rating confirmations', async () => {
    const pending = mealLogRatingApproval();
    const decideSpy = vi.fn().mockResolvedValue(undefined);
    const rendered = await renderWithQuery(<ApprovalPanel approval={pending} onDecision={decideSpy} />);
    expect(rendered.container.textContent).toContain('2026-06-10 · 晚餐');
    expect(rendered.container.textContent).not.toContain('2026-06-10 · dinner');
    expect(rendered.container.textContent).toContain('番茄炒蛋 · 当前评分 4');
    expect(rendered.container.textContent).toContain('评分备注');
    expect(rendered.container.querySelector('.ai-draft-item-card.ai-meal-log-rating-card')).not.toBeNull();
    expect(rendered.container.querySelector<HTMLInputElement>('.ai-rating-field input[type="number"]')).toBeNull();
    const ratingSlider = rendered.container.querySelector<HTMLDivElement>('.ai-rating-field .ui-star-rating-stars');
    expect(ratingSlider).not.toBeNull();
    expect(ratingSlider?.getAttribute('aria-valuenow')).toBe('4');
    const noteInput = rendered.container.querySelector<HTMLTextAreaElement>('.ai-meal-log-rating-card textarea');
    expect(noteInput?.value).toBe('口味稳定');
    changeInput(noteInput as HTMLTextAreaElement, '孩子很喜欢');

    await act(async () => {
      ratingSlider?.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }));
    });
    await flushAsync();
    expect(rendered.container.textContent).toContain('4.5 分');

    await act(async () => {
      rendered.container.querySelector<HTMLButtonElement>('.ai-approval-actions .solid-button')?.click();
    });
    await flushAsync();
    expect(decideSpy).toHaveBeenCalledWith(
      pending,
      'approved',
      {
        draft: expect.objectContaining({
          payload: {
            foodEntryRatings: [{ id: 'entry-tomato-egg', rating: 4.5, note: '孩子很喜欢' }],
          },
        }),
      },
      '',
    );
    rendered.unmount();
  });

  it('uses dropdowns for food type and multi-select meal types', async () => {
    const pending = foodProfileApproval();
    const decideSpy = vi.fn().mockResolvedValue(undefined);
    const rendered = await renderWithQuery(<ApprovalPanel approval={pending} onDecision={decideSpy} />);
    const typeField = Array.from(rendered.container.querySelectorAll<HTMLElement>('.ai-food-profile-draft-editor .ai-resource-field-choice'))
      .find((field) => field.textContent?.includes('类型'));
    expect(typeField?.textContent).toContain('成品');
    await chooseSingleSelectOption(typeField, '外卖');
    const mealTrigger = rendered.container.querySelector<HTMLButtonElement>('.ai-food-profile-draft-editor .ai-multi-select-trigger');
    await act(async () => {
      mealTrigger?.click();
    });
    const dinnerOption = Array.from(rendered.container.querySelectorAll<HTMLButtonElement>('.ai-choice-menu button')).find((button) => button.textContent?.includes('晚餐'));
    expect(dinnerOption).toBeTruthy();
    await act(async () => {
      dinnerOption?.click();
    });
    await flushAsync();
    await act(async () => {
      rendered.container.querySelector<HTMLButtonElement>('.ai-approval-actions .solid-button')?.click();
    });
    await flushAsync();
    expect(decideSpy).toHaveBeenCalledWith(
      pending,
      'approved',
      {
        draft: expect.objectContaining({
          type: 'takeout',
          suitable_meal_types: ['breakfast', 'dinner'],
        }),
      },
      '',
    );
    rendered.unmount();
  });

  it('renders food profile drafts with summary sections, category combobox, and tag chips', async () => {
    const pending = foodProfileApproval();
    const decideSpy = vi.fn().mockResolvedValue(undefined);
    const foods = [
      { id: 'food-dessert', name: '布丁', category: '甜品', type: 'readyMade' },
    ] as Food[];
    const rendered = await renderWithQuery(<ApprovalPanel approval={pending} foods={foods} onDecision={decideSpy} />);

    expect(rendered.container.querySelector('.ai-draft-summary-card.ai-food-profile-summary-card')?.textContent).toContain('蓝莓酸奶');
    expect(rendered.container.querySelector('.ai-draft-summary-card.ai-food-profile-summary-card')?.textContent).toContain('来源常买品牌');
    expect(Array.from(rendered.container.querySelectorAll('.ai-draft-section h3')).map((heading) => heading.textContent)).toEqual(
      expect.arrayContaining(['核心信息', '适用场景', '来源与备注']),
    );
    expect(rendered.container.textContent).toContain('核心信息');
    expect(rendered.container.textContent).toContain('适用场景');
    expect(rendered.container.textContent).toContain('来源与备注');
    const categoryField = Array.from(rendered.container.querySelectorAll<HTMLElement>('.ai-food-profile-draft-editor .ai-resource-field-combobox'))
      .find((field) => field.textContent?.includes('分类'));
    const categoryInput = categoryField?.querySelector<HTMLInputElement>('input');
    expect(categoryInput?.value).toBe('饮品');
    await act(async () => {
      categoryInput?.focus();
    });
    expect(categoryField?.textContent).toContain('甜品');
    changeInput(categoryInput as HTMLInputElement, '甜品');
    const flavorPreset = Array.from(rendered.container.querySelectorAll<HTMLButtonElement>('.ai-food-profile-tag-presets button'))
      .find((button) => button.textContent?.includes('奶香'));
    expect(flavorPreset).toBeTruthy();
    await act(async () => {
      flavorPreset?.click();
    });
    const tagInput = rendered.container.querySelector<HTMLInputElement>('.ai-food-profile-draft-editor .ai-tag-input-field input');
    changeInput(tagInput as HTMLInputElement, '酸甜、酸甜、奶香');
    await act(async () => {
      rendered.container.querySelector<HTMLButtonElement>('.ai-approval-actions .solid-button')?.click();
    });
    await flushAsync();

    expect(decideSpy).toHaveBeenCalledWith(
      pending,
      'approved',
      {
        draft: expect.objectContaining({
          category: '甜品',
          flavor_tags: ['酸甜', '奶香'],
        }),
      },
      '',
    );
    rendered.unmount();
  });

  it('submits food profile update operations with nested payload changes', async () => {
    const pending = foodProfileUpdateApproval();
    const decideSpy = vi.fn().mockResolvedValue(undefined);
    const rendered = await renderWithQuery(<ApprovalPanel approval={pending} onDecision={decideSpy} />);
    const nameInput = rendered.container.querySelector<HTMLInputElement>('.ai-food-profile-draft-editor input.text-input');
    expect(nameInput?.value).toBe('蓝莓酸奶');
    changeInput(nameInput as HTMLInputElement, '蓝莓酸奶升级版');
    const noteField = Array.from(rendered.container.querySelectorAll<HTMLTextAreaElement>('.ai-food-profile-draft-editor textarea.text-input')).at(-1);
    changeInput(noteField as HTMLTextAreaElement, '新的备注');
    await act(async () => {
      rendered.container.querySelector<HTMLButtonElement>('.ai-approval-actions .solid-button')?.click();
    });
    await flushAsync();
    expect(decideSpy).toHaveBeenCalledWith(
      pending,
      'approved',
      {
        draft: expect.objectContaining({
          action: 'update',
          targetId: 'food-yogurt',
          payload: expect.objectContaining({
            name: '蓝莓酸奶升级版',
            notes: '新的备注',
          }),
        }),
      },
      '',
    );
    rendered.unmount();
  });

  it('renders food favorite operations as compact status cards', async () => {
    const pending = foodProfileFavoriteApproval();
    const decideSpy = vi.fn().mockResolvedValue(undefined);
    const rendered = await renderWithQuery(<ApprovalPanel approval={pending} onDecision={decideSpy} />);

    expect(rendered.container.querySelector('.ai-draft-summary-card.ai-food-profile-summary-card')?.textContent).toContain('蓝莓酸奶');
    expect(rendered.container.querySelector('.ai-draft-item-card.ai-food-profile-favorite-card')).not.toBeNull();
    expect(rendered.container.textContent).toContain('当前：未收藏');
    expect(rendered.container.textContent).toContain('调整后：已收藏');
    expect(rendered.container.textContent).not.toContain('核心信息');
    const favoriteField = Array.from(rendered.container.querySelectorAll<HTMLElement>('.ai-food-profile-draft-editor .ai-resource-field-choice'))
      .find((field) => field.textContent?.includes('收藏状态'));
    expect(favoriteField?.textContent).toContain('加入收藏');
    await chooseSingleSelectOption(favoriteField, '移出收藏');
    await act(async () => {
      rendered.container.querySelector<HTMLButtonElement>('.ai-approval-actions .solid-button')?.click();
    });
    await flushAsync();
    expect(decideSpy).toHaveBeenCalledWith(
      pending,
      'approved',
      {
        draft: expect.objectContaining({
          action: 'set_favorite',
          payload: expect.objectContaining({ favorite: false }),
        }),
      },
      '',
    );
    rendered.unmount();
  });

  it('blocks food profile approval when meal types are outside fixed options', async () => {
    const pending = foodProfileApproval();
    pending.initial_values = {
      draft: {
        draftType: 'food_profile',
        schemaVersion: 'food_profile.v1',
        name: '蓝莓酸奶',
        type: 'readyMade',
        category: '饮品',
        flavor_tags: ['酸甜'],
        suitable_meal_types: ['brunch'],
      },
    };
    const decideSpy = vi.fn().mockResolvedValue(undefined);
    const rendered = await renderWithQuery(<ApprovalPanel approval={pending} onDecision={decideSpy} />);

    await act(async () => {
      rendered.container.querySelector<HTMLButtonElement>('.ai-approval-actions .solid-button')?.click();
    });
    await flushAsync();
    expect(rendered.container.querySelector('[role="alert"]')?.textContent).toContain('适合餐别必须从固定选项中选择');
    expect(decideSpy).not.toHaveBeenCalled();
    rendered.unmount();
  });

  it('shows resolved food profile approvals as compact summaries without disabled forms', async () => {
    const resolved = foodProfileApproval();
    resolved.status = 'approved';
    resolved.decision = 'approved';
    resolved.submitted_values = {
      draft: {
        draftType: 'food_profile',
        schemaVersion: 'food_profile.v1',
        name: '蓝莓酸奶',
        type: 'readyMade',
        category: '饮品',
        flavor_tags: ['酸甜'],
        suitable_meal_types: ['breakfast'],
        source_name: '常买品牌',
      },
    };
    const rendered = await renderWithQuery(<ApprovalPanel approval={resolved} onDecision={() => undefined} />);

    expect(rendered.container.querySelector('.ai-draft-resolved-summary.ai-food-profile-summary-card')?.textContent).toContain('新增食物资料已确认');
    expect(rendered.container.querySelector('.ai-food-profile-draft-editor input')).toBeNull();
    expect(rendered.container.textContent).not.toContain('核心信息');
    rendered.unmount();
  });

  it('renders ingredient profile updates with structured before/after fields', async () => {
    const pending = approval({
      approval_type: 'ingredient.update',
      title: '确认更新食材档案',
      approve_label: '更新食材',
      reject_label: '暂不更新',
      draft_schema_version: 'ingredient_profile.v1',
      field_schema: [{ name: 'draft', label: '草稿内容', type: 'object', widget: 'textarea', required: true }],
      initial_values: {
        draft: {
          draftType: 'ingredient_profile',
          schemaVersion: 'ingredient_profile.v1',
          action: 'update',
          targetId: 'ingredient-egg',
          baseUpdatedAt: '2026-06-14T12:00:00Z',
          before: {
            id: 'ingredient-egg',
            name: '鸡蛋',
            category: '蛋奶',
            default_unit: '盒',
            default_storage: '冷藏',
          },
          payload: {
            name: '鸡蛋',
            category: '蛋奶',
            default_unit: '盒',
            unit_conversions: [{ unit: '枚', ratio_to_default: 10 }],
            default_storage: '冷藏',
            default_expiry_mode: 'days',
            default_expiry_days: 14,
            default_low_stock_threshold: 1,
            notes: '优先买土鸡蛋',
          },
        },
      },
      submitted_values: {},
    });

    const rendered = await renderWithQuery(<ApprovalPanel approval={pending} onDecision={() => undefined} />);

    expect(rendered.container.textContent).toContain('修改食材档案');
    expect(rendered.container.textContent).toContain('当前：鸡蛋 · 蛋奶 · 盒 · 冷藏');
    expect(rendered.container.textContent).toContain('调整后：鸡蛋 · 蛋奶 · 盒 · 冷藏');
    expect(rendered.container.textContent).toContain('只更新食材档案默认值，不直接修改已有库存批次。');
    expect(rendered.container.textContent).toContain('核心信息');
    expect(rendered.container.textContent).toContain('保存与提醒');
    expect(rendered.container.textContent).toContain('高级设置');
    expect(rendered.container.textContent).toContain('默认单位');
    expect(rendered.container.textContent).toContain('默认保存');
    expect(rendered.container.textContent).toContain('保质期模式');
    expect(rendered.container.textContent).toContain('副单位');
    expect(rendered.container.textContent).toContain('等于多少默认单位');
    expect(rendered.container.querySelector<HTMLTextAreaElement>('.ai-ingredient-profile-draft-editor textarea.text-input')?.value).toContain('优先买土鸡蛋');
    rendered.unmount();
  });

  it('submits ingredient profile drafts from grouped fields with unit conversion rows', async () => {
    const pending = ingredientProfileApproval();
    const decideSpy = vi.fn().mockResolvedValue(undefined);
    const rendered = await renderWithQuery(<ApprovalPanel approval={pending} onDecision={decideSpy} />);

    expect(rendered.container.textContent).toContain('确认后会创建新的家庭食材档案，不会登记库存数量。');
    expect(rendered.container.textContent).toContain('核心信息');
    expect(rendered.container.textContent).toContain('保存与提醒');
    expect(rendered.container.textContent).toContain('高级设置');
    expect(rendered.container.textContent).toContain('低库存阈值');
    expect(rendered.container.textContent).toContain('当可用库存低于这个数量时提醒');
    expect(rendered.container.querySelectorAll('.ai-ingredient-profile-draft-editor .ai-resource-field-combobox').length).toBeGreaterThanOrEqual(4);

    const conversionRows = rendered.container.querySelectorAll('.ai-ingredient-profile-conversion-row');
    expect(conversionRows).toHaveLength(1);
    const conversionUnitInput = conversionRows[0]?.querySelector<HTMLInputElement>('.ai-resource-field-combobox input[role="combobox"]');
    const conversionRatioInput = conversionRows[0]?.querySelector<HTMLInputElement>('input.text-input');
    changeInput(conversionUnitInput as HTMLInputElement, '袋');
    changeInput(conversionRatioInput as HTMLInputElement, '250');

    await act(async () => {
      rendered.container.querySelector<HTMLButtonElement>('.ai-approval-actions .solid-button')?.click();
    });
    await flushAsync();

    expect(decideSpy).toHaveBeenCalledWith(
      pending,
      'approved',
      {
        draft: expect.objectContaining({
          action: 'create',
          payload: expect.objectContaining({
            name: '梅干菜',
            default_unit: '克',
            default_low_stock_threshold: 50,
            unit_conversions: [{ unit: '袋', ratio_to_default: 250 }],
          }),
        }),
      },
      '',
    );
    rendered.unmount();
  });

  it('selects ingredient storage from the approval combobox while keeping custom choices available', async () => {
    const pending = ingredientProfileApproval();
    const decideSpy = vi.fn().mockResolvedValue(undefined);
    const rendered = await renderWithQuery(<ApprovalPanel approval={pending} onDecision={decideSpy} />);
    const storageField = Array.from(rendered.container.querySelectorAll<HTMLElement>('.ai-resource-field-combobox'))
      .find((field) => field.textContent?.includes('默认保存'));
    const storageInput = storageField?.querySelector<HTMLInputElement>('input[role="combobox"]');
    expect(storageInput?.value).toBe('常温');

    changeInput(storageInput as HTMLInputElement, '冷');
    const chilledOption = Array.from(storageField?.querySelectorAll<HTMLButtonElement>('.ai-combobox-menu button') ?? [])
      .find((button) => button.textContent?.includes('冷藏'));
    expect(chilledOption).toBeTruthy();
    await act(async () => {
      chilledOption?.click();
    });
    expect(storageInput?.value).toBe('冷藏');

    changeInput(storageInput as HTMLInputElement, '阳台储物柜');
    expect(storageField?.textContent).toContain('使用自定义：阳台储物柜');

    await act(async () => {
      rendered.container.querySelector<HTMLButtonElement>('.ai-approval-actions .solid-button')?.click();
    });
    await flushAsync();
    expect(decideSpy).toHaveBeenCalledWith(
      pending,
      'approved',
      {
        draft: expect.objectContaining({
          payload: expect.objectContaining({
            default_storage: '阳台储物柜',
          }),
        }),
      },
      '',
    );
    rendered.unmount();
  });

  it('validates ingredient low stock and unit conversion values before submit', async () => {
    const pending = ingredientProfileApproval();
    const decideSpy = vi.fn().mockResolvedValue(undefined);
    const rendered = await renderWithQuery(<ApprovalPanel approval={pending} onDecision={decideSpy} />);
    const lowStockInput = rendered.container.querySelector<HTMLInputElement>('.ai-ingredient-profile-low-stock input.text-input');
    changeInput(lowStockInput as HTMLInputElement, '0');

    await act(async () => {
      rendered.container.querySelector<HTMLButtonElement>('.ai-approval-actions .solid-button')?.click();
    });
    await flushAsync();

    expect(rendered.container.textContent).toContain('低库存阈值需要大于 0');
    expect(decideSpy).not.toHaveBeenCalled();
    rendered.unmount();
  });

  it('requires ingredient profile name, default unit and default storage before submit', async () => {
    const pending = ingredientProfileApproval({
      initial_values: {
        draft: {
          draftType: 'ingredient_profile',
          schemaVersion: 'ingredient_profile.v1',
          action: 'create',
          payload: {
            name: '',
            category: '干货',
            default_unit: '',
            unit_conversions: [],
            default_storage: '',
            default_expiry_mode: 'none',
            default_expiry_days: null,
            default_low_stock_threshold: null,
            notes: '',
          },
        },
      },
    });
    const decideSpy = vi.fn().mockResolvedValue(undefined);
    const rendered = await renderWithQuery(<ApprovalPanel approval={pending} onDecision={decideSpy} />);

    await act(async () => {
      rendered.container.querySelector<HTMLButtonElement>('.ai-approval-actions .solid-button')?.click();
    });
    await flushAsync();
    expect(rendered.container.querySelector('[role="alert"]')?.textContent).toContain('食材名称不能为空');

    const nameInput = Array.from(rendered.container.querySelectorAll<HTMLInputElement>('.ai-ingredient-profile-draft-editor input.text-input'))
      .find((input) => input.closest('label')?.textContent?.includes('食材名称'));
    changeInput(nameInput as HTMLInputElement, '梅干菜');
    await act(async () => {
      rendered.container.querySelector<HTMLButtonElement>('.ai-approval-actions .solid-button')?.click();
    });
    await flushAsync();
    expect(rendered.container.querySelector('[role="alert"]')?.textContent).toContain('默认单位不能为空');

    const unitInput = rendered.container.querySelector<HTMLInputElement>('.ai-ingredient-profile-draft-editor input[aria-label="默认单位"]');
    changeInput(unitInput as HTMLInputElement, '克');
    await act(async () => {
      rendered.container.querySelector<HTMLButtonElement>('.ai-approval-actions .solid-button')?.click();
    });
    await flushAsync();
    expect(rendered.container.querySelector('[role="alert"]')?.textContent).toContain('默认保存位置不能为空');
    expect(decideSpy).not.toHaveBeenCalled();
    rendered.unmount();
  });

  it('shows approved ingredient profile drafts as a compact summary', async () => {
    const resolved = ingredientProfileApproval({
      status: 'approved',
      decision: 'approved',
      submitted_values: {
        draft: {
          draftType: 'ingredient_profile',
          schemaVersion: 'ingredient_profile.v1',
          action: 'create',
          payload: {
            name: '梅干菜',
            category: '干货/腌制菜',
            default_unit: '克',
            unit_conversions: [{ unit: '斤', ratio_to_default: 500 }],
            default_storage: '常温',
            default_expiry_mode: 'days',
            default_expiry_days: 180,
            default_low_stock_threshold: 50,
            notes: '用于榨菜咸肉炒丝瓜等菜谱，使用前可简单冲洗。',
          },
        },
      },
      resolved_at: '2026-06-14T12:00:00Z',
    });

    const rendered = await renderWithQuery(<ApprovalPanel approval={resolved} onDecision={() => undefined} isLatest />);
    await act(async () => {
      rendered.container.querySelector<HTMLElement>('.ai-approval-head')?.click();
    });

    expect(rendered.container.textContent).toContain('已创建食材档案');
    expect(rendered.container.textContent).toContain('梅干菜');
    expect(rendered.container.textContent).toContain('180 天');
    expect(rendered.container.textContent).toContain('50 克');
    expect(rendered.container.textContent).toContain('斤 = 500 克');
    expect(rendered.container.querySelector('.ai-ingredient-profile-summary-card')).not.toBeNull();
    expect(rendered.container.querySelector('.ai-ingredient-profile-summary-card input')).toBeNull();
    rendered.unmount();
  });

  it('renders inventory intake grouped by business impact', async () => {
    const pending = approval({
      approval_type: 'inventory_intake.apply',
      title: '确认入库',
      instruction: '确认后会统一登记库存，并按草稿更新关联采购项。',
      approve_label: '确认入库',
      reject_label: '暂不处理',
      draft_schema_version: 'inventory_intake.v1',
      field_schema: [{ name: 'draft', label: '统一入库草稿', type: 'object', widget: 'inventory_intake_editor', required: true }],
      initial_values: {
        draft: {
          draftType: 'inventory_intake',
          schemaVersion: 'inventory_intake.v1',
          clientRequestId: 'ai-inventory-intake-test',
          sourceType: 'receipt_image',
          sourceReference: { mediaId: 'media-1' },
          intakeDate: '2026-07-21',
          intakeDateSource: 'receipt',
          items: [
            {
              lineId: 'egg',
              sourceLineId: 'receipt-1',
              sourceText: '鸡蛋 2个',
              sourceKind: 'shopping_item',
              action: 'stock_and_fulfill',
              shoppingItemId: 'shopping-egg',
              title: '鸡蛋',
              expectedShoppingItemRowVersion: 2,
              targetKind: 'exact_ingredient',
              targetId: 'ingredient-egg',
              expectedIngredientRowVersion: 4,
              plannedQuantity: '2',
              plannedUnit: '个',
              enteredQuantity: '2',
              enteredUnit: '个',
              packageConversion: null,
              inventoryStatus: 'fresh',
              storageLocation: '冷藏',
              notes: '',
              before: { shoppingDone: false },
            },
            {
              lineId: 'salmon',
              sourceLineId: 'receipt-2',
              sourceText: '三文鱼 1公斤',
              sourceKind: 'shopping_item',
              action: 'stock_and_fulfill',
              shoppingItemId: 'shopping-salmon',
              title: '三文鱼',
              expectedShoppingItemRowVersion: 1,
              targetKind: 'exact_ingredient',
              targetId: 'ingredient-salmon',
              expectedIngredientRowVersion: 1,
              plannedQuantity: '1',
              plannedUnit: '公斤',
              enteredQuantity: '1',
              enteredUnit: '公斤',
              packageConversion: { ratio: '2', targetUnit: '块', evidence: 'user_confirmed_once' },
              inventoryStatus: 'fresh',
              storageLocation: '冷藏',
              notes: '',
              before: {},
            },
            {
              lineId: 'milk',
              sourceLineId: 'receipt-3',
              sourceText: '牛奶 1袋',
              sourceKind: 'direct',
              action: 'stock_only',
              shoppingItemId: null,
              title: '牛奶',
              expectedShoppingItemRowVersion: null,
              targetKind: 'food',
              targetId: 'food-milk',
              expectedFoodRowVersion: 3,
              plannedQuantity: null,
              plannedUnit: null,
              enteredQuantity: null,
              enteredUnit: '袋',
              packageConversion: null,
              storageLocation: '冷藏',
              notes: '',
              before: {},
            },
          ],
          ignoredItems: [
            {
              sourceLineId: 'receipt-4',
              sourceText: '垃圾袋 1个',
              displayName: '垃圾袋',
              reasonCode: 'non_inventory_item',
              reason: '非食品库存对象，本次不会入库',
            },
          ],
          summary: {},
        },
      },
    });
    const decideSpy = vi.fn().mockResolvedValue(undefined);
    const rendered = await renderWithQuery(<ApprovalPanel approval={pending} onDecision={decideSpy} />);

    expect(rendered.container.querySelector('.ai-inventory-intake-editor')).not.toBeNull();
    expect(rendered.container.textContent).toContain('采购清单关联');
    expect(rendered.container.textContent).toContain('直接入库');
    expect(rendered.container.textContent).toContain('已忽略');
    expect(rendered.container.textContent).toContain('只增加库存，不创建或完成采购项');
    expect(rendered.container.textContent).toContain('非食品库存对象');
    expect(rendered.container.textContent).not.toContain('还需确认');
    expect(rendered.container.textContent).toContain('确认入库');
    expect(rendered.container.querySelector('.ai-approval-actions .solid-button')?.textContent).toContain('确认入库');
    expect(rendered.container.querySelectorAll('button[type="submit"]')).toHaveLength(0);
    expect(rendered.container.querySelectorAll('.ai-approval-actions .solid-button')).toHaveLength(1);

    // ignored rows have no editable controls
    const ignoredSection = rendered.container.querySelector('[aria-label="已忽略"]');
    expect(ignoredSection).not.toBeNull();
    expect(ignoredSection?.querySelector('input, select, textarea')).toBeNull();

    // source-compatible actions only
    const shoppingSelect = rendered.container.querySelector<HTMLSelectElement>('select[aria-label="鸡蛋处理方式"]')
      ?? Array.from(rendered.container.querySelectorAll('select')).find((el) => el.closest('*')?.textContent?.includes('鸡蛋'));
    // direct row explanation present; milk missing quantity should block submit
    await act(async () => {
      rendered.container.querySelector<HTMLButtonElement>('.ai-approval-actions .solid-button')?.click();
    });
    await flushAsync();
    expect(rendered.container.querySelector('[role="alert"]')?.textContent).toMatch(/牛奶/);
    expect(decideSpy).not.toHaveBeenCalled();

    const milkToggle = Array.from(rendered.container.querySelectorAll('button')).find((button) => button.textContent?.includes('牛奶'));
    if (milkToggle && !rendered.container.querySelector('input[aria-label="牛奶实际入库数量"]')) {
      await act(async () => milkToggle.click());
      await flushAsync();
    }
    const milkQty = rendered.container.querySelector<HTMLInputElement>('input[aria-label="牛奶实际入库数量"]');
    expect(milkQty).not.toBeNull();
    changeInput(milkQty as HTMLInputElement, '1');
    await act(async () => {
      rendered.container.querySelector<HTMLButtonElement>('.ai-approval-actions .solid-button')?.click();
    });
    await flushAsync();
    expect(decideSpy).toHaveBeenCalledWith(
      pending,
      'approved',
      {
        draft: expect.objectContaining({
          draftType: 'inventory_intake',
          schemaVersion: 'inventory_intake.v1',
          items: expect.arrayContaining([
            expect.objectContaining({
              lineId: 'egg',
              shoppingItemId: 'shopping-egg',
              expectedShoppingItemRowVersion: 2,
              targetId: 'ingredient-egg',
              expectedIngredientRowVersion: 4,
            }),
            expect.objectContaining({
              lineId: 'milk',
              sourceKind: 'direct',
              action: 'stock_only',
              enteredQuantity: '1',
            }),
          ]),
          ignoredItems: expect.arrayContaining([
            expect.objectContaining({ displayName: '垃圾袋', reasonCode: 'non_inventory_item' }),
          ]),
        }),
      },
      '',
    );
    rendered.unmount();
  });

  it('edits shopping and direct rows through the existing approval payload', async () => {
    const pending = approval({
      approval_type: 'inventory_intake.apply',
      title: '确认入库',
      approve_label: '确认入库',
      reject_label: '暂不处理',
      draft_schema_version: 'inventory_intake.v1',
      field_schema: [{ name: 'draft', label: '统一入库草稿', type: 'object', widget: 'inventory_intake_editor', required: true }],
      initial_values: {
        draft: {
          draftType: 'inventory_intake',
          schemaVersion: 'inventory_intake.v1',
          clientRequestId: 'ai-inventory-intake-edit',
          sourceType: 'manual_text',
          sourceReference: null,
          intakeDate: '2026-07-21',
          intakeDateSource: 'user',
          items: [
            {
              lineId: 'egg',
              sourceLineId: 'line-egg',
              sourceText: '鸡蛋',
              sourceKind: 'shopping_item',
              action: 'stock_and_fulfill',
              shoppingItemId: 'shopping-egg',
              title: '鸡蛋',
              expectedShoppingItemRowVersion: 1,
              targetKind: 'exact_ingredient',
              targetId: 'ingredient-egg',
              expectedIngredientRowVersion: 1,
              plannedQuantity: '6',
              plannedUnit: '个',
              enteredQuantity: '6',
              enteredUnit: '个',
              packageConversion: null,
              inventoryStatus: 'fresh',
              storageLocation: '冷藏',
              notes: '',
              before: {},
            },
            {
              lineId: 'milk',
              sourceLineId: 'line-milk',
              sourceText: '牛奶',
              sourceKind: 'direct',
              action: 'stock_only',
              shoppingItemId: null,
              title: '牛奶',
              expectedShoppingItemRowVersion: null,
              targetKind: 'food',
              targetId: 'food-milk',
              expectedFoodRowVersion: 1,
              plannedQuantity: null,
              plannedUnit: null,
              enteredQuantity: '1',
              enteredUnit: '袋',
              packageConversion: null,
              storageLocation: '冷藏',
              notes: '',
              before: {},
            },
          ],
          ignoredItems: [],
          summary: {},
        },
      },
    });
    const decideSpy = vi.fn().mockResolvedValue(undefined);
    const rendered = await renderWithQuery(<ApprovalPanel approval={pending} onDecision={decideSpy} />);

    // expand the egg row if collapsed
    const eggToggle = Array.from(rendered.container.querySelectorAll('button')).find((button) => button.textContent?.includes('鸡蛋'));
    if (eggToggle && !rendered.container.querySelector('input[aria-label="鸡蛋实际入库数量"]')) {
      await act(async () => eggToggle.click());
      await flushAsync();
    }
    const eggQty = rendered.container.querySelector<HTMLInputElement>('input[aria-label="鸡蛋实际入库数量"]');
    expect(eggQty).not.toBeNull();
    changeInput(eggQty as HTMLInputElement, '4');

    await act(async () => {
      rendered.container.querySelector<HTMLButtonElement>('.ai-approval-actions .solid-button')?.click();
    });
    await flushAsync();
    expect(decideSpy).toHaveBeenCalledWith(
      pending,
      'approved',
      {
        draft: expect.objectContaining({
          items: expect.arrayContaining([
            expect.objectContaining({ lineId: 'egg', enteredQuantity: '4', shoppingItemId: 'shopping-egg', expectedShoppingItemRowVersion: 1 }),
            expect.objectContaining({ lineId: 'milk', sourceKind: 'direct', targetId: 'food-milk' }),
          ]),
        }),
      },
      '',
    );
    rendered.unmount();
  });

  it('renders approved inventory intake read only', async () => {
    const approved = approval({
      approval_type: 'inventory_intake.apply',
      title: '确认入库',
      approve_label: '确认入库',
      reject_label: '暂不处理',
      status: 'approved',
      draft_schema_version: 'inventory_intake.v1',
      field_schema: [{ name: 'draft', label: '统一入库草稿', type: 'object', widget: 'inventory_intake_editor', required: true }],
      initial_values: {
        draft: {
          draftType: 'inventory_intake',
          schemaVersion: 'inventory_intake.v1',
          clientRequestId: 'ai-inventory-intake-readonly',
          sourceType: 'gift',
          sourceReference: null,
          intakeDate: '2026-07-21',
          intakeDateSource: 'user',
          items: [{
            lineId: 'milk',
            sourceLineId: 'line-milk',
            sourceText: '牛奶',
            sourceKind: 'direct',
            action: 'stock_only',
            shoppingItemId: null,
            title: '牛奶',
            expectedShoppingItemRowVersion: null,
            targetKind: 'food',
            targetId: 'food-milk',
            expectedFoodRowVersion: 1,
            plannedQuantity: null,
            plannedUnit: null,
            enteredQuantity: '1',
            enteredUnit: '袋',
            packageConversion: null,
            storageLocation: '冷藏',
            notes: '',
            before: {},
          }],
          ignoredItems: [],
          summary: {},
        },
      },
      submitted_values: {
        draft: {
          draftType: 'inventory_intake',
          schemaVersion: 'inventory_intake.v1',
          clientRequestId: 'ai-inventory-intake-readonly',
          sourceType: 'gift',
          sourceReference: null,
          intakeDate: '2026-07-21',
          intakeDateSource: 'user',
          items: [{
            lineId: 'milk',
            sourceLineId: 'line-milk',
            sourceText: '牛奶',
            sourceKind: 'direct',
            action: 'stock_only',
            shoppingItemId: null,
            title: '牛奶',
            expectedShoppingItemRowVersion: null,
            targetKind: 'food',
            targetId: 'food-milk',
            expectedFoodRowVersion: 1,
            plannedQuantity: null,
            plannedUnit: null,
            enteredQuantity: '1',
            enteredUnit: '袋',
            packageConversion: null,
            storageLocation: '冷藏',
            notes: '',
            before: {},
          }],
          ignoredItems: [],
          summary: {},
        },
      },
    });
    const rendered = await renderWithQuery(<ApprovalPanel approval={approved} onDecision={() => undefined} />);
    expect(rendered.container.textContent).toContain('直接入库');
    expect(rendered.container.textContent).toContain('牛奶');
    expect(rendered.container.querySelector('.ai-inventory-intake-editor input:not([disabled])')).toBeNull();
    rendered.unmount();
  });

  it('renders and submits the dedicated ingredient tracking transition form', async () => {
    const pending = approval({
      approval_type: 'ingredient.transition_tracking_mode',
      title: '确认切换数量追踪方式',
      approve_label: '确认切换',
      reject_label: '暂不切换',
      draft_schema_version: 'ingredient_profile_operation.v1',
      field_schema: [{ name: 'draft', label: '追踪方式切换', type: 'object', widget: 'textarea', required: true }],
      initial_values: {
        draft: {
          draftType: 'ingredient_profile',
          schemaVersion: 'ingredient_profile_operation.v1',
          action: 'transition_tracking_mode',
          targetId: 'ingredient-eggs',
          before: { name: '鸡蛋', quantity_tracking_mode: 'track_quantity' },
          payload: {
            target_mode: 'not_track_quantity',
            expected_ingredient_row_version: 3,
            expected_state_row_version: null,
            observed_batches: [{ inventory_item_id: 'inventory-eggs', expected_row_version: 2 }],
            presence_resolution: {
              availability_level: 'sufficient',
              inventory_status: 'fresh',
              purchase_date: '2026-07-20',
              expiry_date: null,
              storage_location: '冷藏',
              notes: '',
              mark_inventory_confirmed: false,
            },
            exact_resolution: null,
          },
        },
      },
    });
    const decideSpy = vi.fn().mockResolvedValue(undefined);
    const rendered = await renderWithQuery(<ApprovalPanel approval={pending} onDecision={decideSpy} />);

    expect(rendered.container.querySelector('.ai-ingredient-tracking-transition')).not.toBeNull();
    expect(rendered.container.textContent).toContain('精确数量');
    expect(rendered.container.textContent).toContain('只记有无');
    expect(rendered.container.textContent).toContain('1 个现有批次将按选择折叠');

    await act(async () => {
      rendered.container.querySelector<HTMLButtonElement>('.ai-approval-actions .solid-button')?.click();
    });
    await flushAsync();
    expect(decideSpy).toHaveBeenCalledWith(
      pending,
      'approved',
      { draft: expect.objectContaining({ action: 'transition_tracking_mode' }) },
      '',
    );
    rendered.unmount();
  });

  it('renders meal composition correction with a fixed no-inventory-adjustment warning', async () => {
    const pending = approval({
      approval_type: 'meal_log.update_composition',
      title: '确认纠正餐食内容',
      approve_label: '确认纠正',
      reject_label: '暂不修改',
      draft_schema_version: 'meal_log_operation.v1',
      field_schema: [{ name: 'draft', label: '餐食组成', type: 'object', widget: 'textarea', required: true }],
      initial_values: {
        draft: {
          draftType: 'meal_log',
          schemaVersion: 'meal_log_operation.v1',
          action: 'update_composition',
          targetId: 'meal-log-dinner',
          baseUpdatedAt: '2026-07-20T12:00:00Z',
          expectedRowVersion: 2,
          before: {
            date: '2026-07-20',
            mealType: 'dinner',
            foods: [{ entryId: 'entry-milk', foodId: 'food-milk', name: '牛奶', servings: 1, note: '' }],
          },
          payload: {
            foods: [
              { entryId: 'entry-bread', foodId: 'food-bread', name: '全麦面包', servings: 0.5, note: '实际半份' },
            ],
            inventoryAdjustment: 'none',
          },
        },
      },
    });
    const decideSpy = vi.fn().mockResolvedValue(undefined);
    const rendered = await renderWithQuery(<ApprovalPanel approval={pending} onDecision={decideSpy} />);

    expect(rendered.container.querySelector('.ai-meal-composition-correction')).not.toBeNull();
    expect(rendered.container.textContent).toContain('牛奶');
    expect(rendered.container.textContent).toContain('全麦面包');
    expect(rendered.container.textContent).toContain('不会补回、追加或重新计算历史库存');

    await act(async () => {
      rendered.container.querySelector<HTMLButtonElement>('.ai-approval-actions .solid-button')?.click();
    });
    await flushAsync();
    expect(decideSpy).toHaveBeenCalledWith(
      pending,
      'approved',
      {
        draft: expect.objectContaining({
          action: 'update_composition',
          payload: expect.objectContaining({ inventoryAdjustment: 'none' }),
        }),
      },
      '',
    );
    rendered.unmount();
  });
});
