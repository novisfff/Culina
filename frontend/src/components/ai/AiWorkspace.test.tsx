import React, { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { api } from '../../api/client';
import type { AiApprovalRequest, AiChatResponse, AiConversation, AiGeneratedRecipeDraft, AiQualityMetrics, AiResultCard, Food, Ingredient } from '../../api/types';
import { ResultCard } from './AiResultCards';
import { MessageBubble } from './AiConversationThread';
import { AiWorkspace, ApprovalPanel } from './AiWorkspace';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function recipeDraft(title = '番茄鸡蛋面'): AiGeneratedRecipeDraft {
  return {
    title,
    servings: 2,
    prep_minutes: 20,
    difficulty: 'easy',
    ingredient_items: [{ ingredient_id: null, ingredient_name: '番茄', quantity: 2, unit: '个', note: '切块' }],
    steps: [
      { title: '备菜', text: '番茄切块。', icon: 'bowl', summary: '备菜', estimated_minutes: 5, tip: '', key_points: [] },
      { title: '烹调', text: '中火煮熟。', icon: 'pan', summary: '烹调', estimated_minutes: 10, tip: '', key_points: [] },
    ],
    tips: '少油少盐',
    scene_tags: ['家常菜'],
    media_ids: [],
  };
}

function approval(overrides: Partial<AiApprovalRequest> = {}): AiApprovalRequest {
  const initial = recipeDraft('原始草稿');
  return {
    id: 'approval-1',
    conversation_id: 'conversation-1',
    message_id: 'message-1',
    run_id: 'run-1',
    draft_id: 'draft-1',
    draft_version: 1,
    draft_schema_version: 'recipe.v1',
    approval_type: 'recipe.create',
    status: 'pending',
    title: '确认创建菜谱',
    instruction: '确认后会创建菜谱。',
    approve_label: '创建菜谱',
    reject_label: '暂不创建',
    require_reject_comment: false,
    field_schema: [{ name: 'recipe', label: '菜谱草稿', type: 'string', widget: 'textarea', required: true }],
    initial_values: { recipe: initial },
    submitted_values: {},
    decision: null,
    comment: null,
    resolved_at: null,
    expires_at: null,
    created_at: '2026-05-30T00:00:00Z',
    ...overrides,
  };
}

function shoppingApproval(overrides: Partial<AiApprovalRequest> = {}): AiApprovalRequest {
  const draft = {
    draftType: 'shopping_list',
    schemaVersion: 'shopping_list.v1',
    items: [{ title: '鸡蛋', quantity: 1, unit: '盒', reason: '补充常用食材' }],
  };
  return approval({
    approval_type: 'shopping_list.create',
    title: '确认创建购物清单',
    approve_label: '加入购物清单',
    reject_label: '暂不加入',
    draft_schema_version: 'shopping_list.v1',
    field_schema: [{ name: 'draft', label: '草稿内容', type: 'object', widget: 'textarea', required: true }],
    initial_values: { draft },
    submitted_values: {},
    ...overrides,
  });
}

function mealPlanApproval(): AiApprovalRequest {
  const draft = {
    draftType: 'meal_plan',
    schemaVersion: 'meal_plan.v1',
    items: [
      {
        date: '2026-06-10',
        mealType: 'dinner',
        title: '番茄炒蛋',
        foodId: 'food-tomato-egg',
        reason: '快手晚餐',
        missingIngredients: [{ name: '牛肉' }, { ingredient_name: '土豆' }],
      },
    ],
  };
  return approval({
    approval_type: 'meal_plan.create',
    title: '确认创建餐食计划',
    approve_label: '加入计划',
    reject_label: '暂不加入',
    draft_schema_version: 'meal_plan.v1',
    field_schema: [{ name: 'draft', label: '草稿内容', type: 'object', widget: 'textarea', required: true }],
    initial_values: { draft },
    submitted_values: {},
  });
}

function mealLogApproval(): AiApprovalRequest {
  const draft = {
    draftType: 'meal_log',
    schemaVersion: 'meal_log.v1',
    date: '2026-06-10',
    mealType: 'dinner',
    foods: [{ foodId: 'food-tomato-egg', name: '番茄炒蛋', servings: 1, note: '少油' }],
    notes: '晚餐记录',
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
      foodEntryRatings: [{ id: 'entry-tomato-egg', rating: 4 }],
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

function compositeOperationApproval(): AiApprovalRequest {
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
  });
}

function unitMismatchInventoryApproval(): AiApprovalRequest {
  const draft = {
    draftType: 'inventory_operation',
    schemaVersion: 'inventory_operation.v1',
    operations: [
      {
        action: 'restock',
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

function conversation(): AiConversation {
  return {
    id: 'conversation-1',
    family_id: 'family-1',
    mode: 'recommendation',
    prompt: '帮我生成菜谱',
    response: '',
    created_at: '2026-05-30T00:00:00Z',
    created_by: 'user-1',
    context: {},
    title: '帮我生成菜谱',
    summary: '',
    status: 'active',
    last_message_at: '2026-05-30T00:00:00Z',
    last_run_status: 'completed',
  };
}

function qualityMetrics(overrides: Partial<AiQualityMetrics> = {}): AiQualityMetrics {
  return {
    family_id: 'family-1',
    window: { limit: 50, days: null },
    run_count: 3,
    status_counts: { completed: 2, failed: 1 },
    intent_counts: { meal_plan: 2, recipe_draft: 1 },
    routing_skill_counts: { meal_plan: 2, shopping_list: 1 },
    clarification_reasons: { missing_date: 1 },
    clarification_by_skill: { meal_plan: 1 },
    approval_by_draft_type: { meal_plan: { approved: 1 }, shopping_list: { pending: 1 } },
    skill_diagnostics: { 'shopping_list:missing ingredient ids': 1 },
    skill_status_counts: { 'meal_plan:completed': 2, 'shopping_list:failed': 1 },
    totals: {
      skillExecutionCount: 3,
      completedSkillExecutionCount: 2,
      toolCallCount: 6,
      draftCount: 2,
      approvalRequestCount: 2,
      clarificationCount: 1,
      approvalApprovedCount: 1,
      approvalRejectedCount: 0,
      totalDurationMs: 2400,
      averageDurationMs: 800,
    },
    recent_runs: [],
    ...overrides,
  };
}

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  });
}

async function waitForResourceLoad(delay = 0) {
  await act(async () => {
    await new Promise((resolve) => window.setTimeout(resolve, delay));
  });
}

async function renderWithQuery(element: React.ReactElement) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  let root: Root;
  await act(async () => {
    root = createRoot(container);
    root.render(<QueryClientProvider client={queryClient}>{element}</QueryClientProvider>);
  });
  return {
    container,
    queryClient,
    unmount: () => {
      act(() => {
        root.unmount();
        container.remove();
      });
    },
  };
}

function changeInput(input: HTMLInputElement | HTMLTextAreaElement, value: string) {
  act(() => {
    const prototype = input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const valueSetter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set;
    valueSetter?.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

function changeSelect(select: HTMLSelectElement, value: string) {
  act(() => {
    const valueSetter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set;
    valueSetter?.call(select, value);
    select.dispatchEvent(new Event('change', { bubbles: true }));
  });
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  document.body.innerHTML = '';
});

beforeEach(() => {
  vi.spyOn(api, 'getAiStatus').mockResolvedValue({
    enabled: true,
    provider: 'openai-compatible',
    model: 'fake-model',
    status: 'ready',
    detail: 'AI 已就绪。',
  });
  vi.spyOn(api, 'getAiQualityMetrics').mockResolvedValue(qualityMetrics());
  vi.spyOn(api, 'getFoods').mockResolvedValue([]);
  vi.spyOn(api, 'getIngredients').mockResolvedValue([]);
});

async function advanceTimers(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

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
              },
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
            internal_code: 'intent.request_clarification',
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

    const progressBar = rendered.container.querySelector('.ai-run-progress-bar') as HTMLElement;
    expect(progressBar.textContent).toContain('待补充');
    expect(progressBar.textContent).toContain('购物清单');
    expect(progressBar.textContent).toContain('等待用户补充信息');
    expect(progressBar.textContent).not.toContain('已完成');
    expect(rendered.container.querySelector('.ai-run-current-skill')?.className).toContain('status-waiting');
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
    };
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
    const titleInput = rendered.container.querySelector<HTMLInputElement>('input.text-input');
    expect(titleInput?.value).toBe('最终提交菜谱');
    expect(titleInput?.disabled).toBe(true);
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
    expect(rendered.container.textContent).toContain('当前：三文鱼 · 1块');
    expect(rendered.container.textContent).not.toContain('删除原因');
    expect(rendered.container.textContent).not.toContain('为什么需要采购');
    expect(rendered.container.querySelector('textarea.text-input')).toBeNull();
    rendered.unmount();
  });

  it('renders composite operation step previews as read-only impact cards', async () => {
    const rendered = await renderWithQuery(
      <ApprovalPanel approval={compositeOperationApproval()} onDecision={() => undefined} />,
    );

    expect(rendered.container.textContent).toContain('复合步骤预览');
    expect(rendered.container.textContent).toContain('确认后会按顺序执行已接入的基础业务步骤');
    expect(rendered.container.textContent).toContain('新增食材档案 · 鸡胸肉');
    expect(rendered.container.textContent).toContain('入库库存 · 鸡胸肉 500 克');
    expect(rendered.container.textContent).toContain('依赖 · create-ingredient');
    expect(rendered.container.textContent).toContain('create-ingredient · entityId');
    expect(rendered.container.textContent).toContain('引用前置步骤结果');
    rendered.unmount();
  });

  it('renders temporary unit conversion inventory approval with converted and source quantities', async () => {
    const rendered = await renderWithQuery(
      <ApprovalPanel approval={unitMismatchInventoryApproval()} onDecision={() => undefined} />,
    );

    expect(rendered.container.textContent).toContain('库存处理项');
    expect(rendered.container.textContent).toContain('鸡蛋');
    expect((rendered.container.querySelector('.quantity-input') as HTMLInputElement | null)?.value).toBe('20');
    expect((rendered.container.querySelector('.unit-input') as HTMLInputElement | null)?.value).toBe('个');
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
    await flush();
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
    await flush();
    const titleInput = rendered.container.querySelector<HTMLInputElement>('input.text-input');
    expect(rendered.container.textContent).toContain('sync failed');
    expect(titleInput?.disabled).toBe(false);
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
    await waitForResourceLoad();
    const milkOption = Array.from(rendered.container.querySelectorAll<HTMLButtonElement>('.ai-resource-menu button')).find((button) => button.textContent?.includes('牛奶'));
    expect(milkOption).toBeTruthy();
    await act(async () => {
      milkOption?.click();
    });
    await act(async () => {
      rendered.container.querySelector<HTMLButtonElement>('button.solid-button')?.click();
    });
    await flush();
    expect(decideSpy).toHaveBeenCalledWith(
      pending,
      'approved',
      { draft: expect.objectContaining({ items: [expect.objectContaining({ title: '牛奶', unit: '瓶' })] }) },
      '',
    );
    rendered.unmount();
  });

  it('uses the shared card layout and dropdowns for recipe confirmations', async () => {
    const pending = approval();
    const decideSpy = vi.fn().mockResolvedValue(undefined);
    const ingredients = [
      { id: 'ingredient-tomato', name: '番茄', category: '蔬菜', default_unit: '个', image: { url: '/ingredient-tomato.jpg' } },
    ] as Ingredient[];
    const rendered = await renderWithQuery(<ApprovalPanel approval={pending} ingredients={ingredients} onDecision={decideSpy} />);
    expect(rendered.container.querySelectorAll('.ai-recipe-draft-editor .ai-confirmation-item').length).toBeGreaterThan(2);

    const difficultySelect = Array.from(rendered.container.querySelectorAll<HTMLSelectElement>('select')).find((select) => Array.from(select.options).some((option) => option.value === 'medium'));
    const stepIconSelect = Array.from(rendered.container.querySelectorAll<HTMLSelectElement>('select')).find((select) => Array.from(select.options).some((option) => option.value === 'timer'));
    expect(difficultySelect?.textContent).toContain('适中');
    expect(stepIconSelect?.textContent).toContain('计时');
    changeSelect(difficultySelect as HTMLSelectElement, 'medium');
    changeSelect(stepIconSelect as HTMLSelectElement, 'timer');

    const ingredientInput = rendered.container.querySelector<HTMLInputElement>('.ai-recipe-draft-editor .ai-resource-field-ingredient input');
    await act(async () => {
      ingredientInput?.focus();
    });
    await waitForResourceLoad();
    const tomatoOption = Array.from(rendered.container.querySelectorAll<HTMLButtonElement>('.ai-resource-menu button')).find((button) => button.textContent?.includes('番茄'));
    expect(tomatoOption).toBeTruthy();
    await act(async () => {
      tomatoOption?.click();
    });
    await flush();
    await act(async () => {
      rendered.container.querySelector<HTMLButtonElement>('.ai-approval-actions .solid-button')?.click();
    });
    await flush();
    expect(decideSpy).toHaveBeenCalledWith(
      pending,
      'approved',
      {
        recipe: expect.objectContaining({
          difficulty: 'medium',
          ingredient_items: [expect.objectContaining({ ingredient_id: 'ingredient-tomato', ingredient_name: '番茄' })],
          steps: expect.arrayContaining([expect.objectContaining({ icon: 'timer' })]),
        }),
      },
      '',
    );
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

    const foodInput = rendered.container.querySelector<HTMLInputElement>('.ai-resource-field-food input');
    expect(foodInput).not.toBeNull();
    await act(async () => {
      foodInput?.focus();
    });
    await waitForResourceLoad();
    expect(rendered.container.textContent).toContain('家常菜 · 自制食物');
    changeInput(foodInput as HTMLInputElement, '牛肉');
    await waitForResourceLoad(240);
    expect(rendered.container.textContent).toContain('牛肉面');

    const ingredientInput = Array.from(rendered.container.querySelectorAll<HTMLInputElement>('.ai-resource-field-ingredient input')).find((input) => input.placeholder.includes('继续') || input.placeholder.includes('搜索'));
    expect(ingredientInput).not.toBeNull();
    await act(async () => {
      ingredientInput?.focus();
    });
    await waitForResourceLoad();
    changeInput(ingredientInput as HTMLInputElement, '番茄');
    await waitForResourceLoad(240);
    expect(rendered.container.textContent).toContain('番茄');
    await act(async () => {
      rendered.container.querySelector<HTMLButtonElement>('.ai-approval-actions .solid-button')?.click();
    });
    await flush();
    expect(decideSpy).toHaveBeenCalledWith(
      pending,
      'approved',
      {
        draft: expect.objectContaining({
          items: [
            expect.objectContaining({
              missingIngredients: ['牛肉', '土豆'],
              missingIngredientItems: [
                { ingredientId: 'ingredient-beef', name: '牛肉', quantity: 250, unit: 'g' },
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
    await waitForResourceLoad();
    expect(loader).toHaveBeenCalledWith('food', { query: '', offset: 0, limit: 6 });
    expect(rendered.container.querySelectorAll('.ai-resource-field-food .ai-resource-menu button')).toHaveLength(6);

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
    await waitForResourceLoad();
    expect(loader).toHaveBeenCalledWith('food', { query: '', offset: 6, limit: 6 });
    expect(rendered.container.querySelectorAll('.ai-resource-field-food .ai-resource-menu button')).toHaveLength(12);

    changeInput(foodInput as HTMLInputElement, '番茄');
    await waitForResourceLoad(240);
    expect(loader).toHaveBeenLastCalledWith('food', { query: '番茄', offset: 0, limit: 6 });
    expect(rendered.container.querySelectorAll('.ai-resource-field-food .ai-resource-menu button')).toHaveLength(1);
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
    expect(rendered.container.querySelectorAll('.ai-meal-log-draft-editor .ai-confirmation-item')).toHaveLength(2);
    expect(rendered.container.textContent).toContain('2026-06-10');
    expect(rendered.container.textContent).toContain('晚餐');
    expect(rendered.container.textContent).toContain('食物1 项');
    expect(rendered.container.textContent).toContain('总份数1 份');
    expect(rendered.container.textContent).toContain('参与人无');
    expect(rendered.container.textContent).toContain('照片无');
    expect(rendered.container.textContent).toContain('关联计划未关联');
    expect(rendered.container.textContent).toContain('晚餐记录');
    expect(rendered.container.textContent).toContain('食物 1');
    expect(rendered.container.textContent).toContain('家常菜 · 自制食物');
    expect(rendered.container.textContent).toContain('1 份');
    const mealSelect = rendered.container.querySelector<HTMLSelectElement>('.ai-meal-log-draft-editor .ai-resource-field-choice select');
    changeSelect(mealSelect as HTMLSelectElement, 'lunch');
    const foodInput = rendered.container.querySelector<HTMLInputElement>('.ai-meal-log-draft-editor .ai-resource-field-food input');
    await act(async () => {
      foodInput?.focus();
    });
    await waitForResourceLoad();
    const noodleOption = Array.from(rendered.container.querySelectorAll<HTMLButtonElement>('.ai-resource-menu button')).find((button) => button.textContent?.includes('牛肉面'));
    expect(noodleOption).toBeTruthy();
    await act(async () => {
      noodleOption?.click();
    });
    await flush();
    await act(async () => {
      rendered.container.querySelector<HTMLButtonElement>('.ai-approval-actions .solid-button')?.click();
    });
    await flush();
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

  it('uses the shared star rating input for meal log rating confirmations', async () => {
    const pending = mealLogRatingApproval();
    const decideSpy = vi.fn().mockResolvedValue(undefined);
    const rendered = await renderWithQuery(<ApprovalPanel approval={pending} onDecision={decideSpy} />);
    expect(rendered.container.textContent).toContain('2026-06-10 · 晚餐');
    expect(rendered.container.textContent).not.toContain('2026-06-10 · dinner');
    expect(rendered.container.textContent).toContain('番茄炒蛋 · 当前评分 4');
    expect(rendered.container.querySelector<HTMLInputElement>('.ai-rating-field input[type="number"]')).toBeNull();
    const ratingSlider = rendered.container.querySelector<HTMLDivElement>('.ai-rating-field .food-rating-stars');
    expect(ratingSlider).not.toBeNull();
    expect(ratingSlider?.getAttribute('aria-valuenow')).toBe('4');

    await act(async () => {
      ratingSlider?.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }));
    });
    await flush();
    expect(rendered.container.textContent).toContain('4.5 分');

    await act(async () => {
      rendered.container.querySelector<HTMLButtonElement>('.ai-approval-actions .solid-button')?.click();
    });
    await flush();
    expect(decideSpy).toHaveBeenCalledWith(
      pending,
      'approved',
      {
        draft: expect.objectContaining({
          payload: {
            foodEntryRatings: [{ id: 'entry-tomato-egg', rating: 4.5 }],
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
    const typeSelect = rendered.container.querySelector<HTMLSelectElement>('.ai-food-profile-draft-editor .ai-resource-field-choice select');
    expect(typeSelect?.textContent).toContain('外卖');
    changeSelect(typeSelect as HTMLSelectElement, 'takeout');
    const mealTrigger = rendered.container.querySelector<HTMLButtonElement>('.ai-food-profile-draft-editor .ai-multi-select-trigger');
    await act(async () => {
      mealTrigger?.click();
    });
    const dinnerOption = Array.from(rendered.container.querySelectorAll<HTMLButtonElement>('.ai-choice-menu button')).find((button) => button.textContent?.includes('晚餐'));
    expect(dinnerOption).toBeTruthy();
    await act(async () => {
      dinnerOption?.click();
    });
    await flush();
    await act(async () => {
      rendered.container.querySelector<HTMLButtonElement>('.ai-approval-actions .solid-button')?.click();
    });
    await flush();
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
    await flush();
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
    expect(rendered.container.textContent).toContain('默认单位');
    expect(rendered.container.textContent).toContain('默认保存');
    expect(rendered.container.textContent).toContain('保质期模式');
    expect(rendered.container.textContent).toContain('单位换算');
    expect(rendered.container.querySelector<HTMLTextAreaElement>('.ai-ingredient-profile-draft-editor textarea.text-input')?.value).toContain('优先买土鸡蛋');
    rendered.unmount();
  });
});

describe('AiWorkspace quality diagnostics', () => {
  it('opens recent run quality metrics from the AI status pill', async () => {
    vi.spyOn(api, 'getAiMessages').mockResolvedValue([]);
    vi.spyOn(api, 'getPendingAiApprovals').mockResolvedValue([]);
    const qualitySpy = vi.spyOn(api, 'getAiQualityMetrics').mockResolvedValue(qualityMetrics());

    const rendered = await renderWithQuery(<AiWorkspace conversations={[conversation()]} isLoading={false} />);
    await flush();

    expect(rendered.container.textContent).not.toContain('质量诊断');
    expect(qualitySpy).not.toHaveBeenCalled();

    await act(async () => {
      rendered.container.querySelector<HTMLButtonElement>('.ai-quality-trigger')?.click();
    });
    await flush();

    expect(rendered.container.textContent).toContain('质量诊断');
    expect(rendered.container.textContent).toContain('最近 3 次运行');
    expect(rendered.container.textContent).toContain('完成率');
    expect(rendered.container.textContent).toContain('67%');
    expect(rendered.container.textContent).toContain('常用 Skill');
    expect(rendered.container.textContent).toContain('餐食计划 · 2');
    expect(rendered.container.textContent).toContain('待关注');
    expect(rendered.container.textContent).toContain('missing date · 1');
    expect(qualitySpy).toHaveBeenCalledTimes(1);
    rendered.unmount();
  });
});

describe('AiWorkspace pending approval restore', () => {
  it('restores pending approvals as an assistant message when history is missing', async () => {
    vi.spyOn(api, 'getAiMessages').mockResolvedValue([]);
    vi.spyOn(api, 'getPendingAiApprovals').mockResolvedValue([approval()]);
    const rendered = await renderWithQuery(<AiWorkspace conversations={[conversation()]} isLoading={false} />);
    await flush();
    expect(rendered.container.textContent).not.toContain('待处理确认');
    expect(rendered.container.textContent).toContain('AI 厨房助手');
    expect(rendered.container.textContent).toContain('确认创建菜谱');
    expect(rendered.container.querySelector<HTMLInputElement>('input.text-input')?.value).toBe('原始草稿');
    rendered.unmount();
  });

  it('pauses both composers but keeps the pending approval run cancellable', async () => {
    vi.spyOn(api, 'getAiMessages').mockResolvedValue([]);
    vi.spyOn(api, 'getPendingAiApprovals').mockResolvedValue([approval()]);
    const streamSpy = vi.spyOn(api, 'streamChatAi').mockResolvedValue({
      conversation_id: 'conversation-1',
      message: {
        id: 'message-final',
        conversation_id: 'conversation-1',
        role: 'assistant',
        content: '不应该发送',
        content_type: 'parts',
        parts: [{ id: 'part-final', type: 'text', text: '不应该发送' }],
        run_id: 'run-blocked',
        status: 'completed',
        metadata: {},
        created_at: '2026-05-30T00:00:00Z',
      },
      run: {
        id: 'run-blocked',
        agent_key: 'general_chat_agent',
        intent: 'general_chat',
        status: 'completed',
        model: 'rules',
        created_at: '2026-05-30T00:00:00Z',
      },
      events: [],
      included: { result_cards: [], drafts: [], approvals: [] },
    });
    const cancelSpy = vi.spyOn(api, 'cancelAiRun').mockResolvedValue({
      run: { id: 'run-1', status: 'cancelled' },
      events: [
        {
          id: 'cancel-event',
          run_id: 'run-1',
          type: 'cancel',
          internal_code: 'user_cancel',
          user_message: '已取消这次任务',
          status: 'failed',
          created_at: '2026-05-30T00:00:00Z',
        },
      ],
    });
    const rendered = await renderWithQuery(<AiWorkspace conversations={[conversation()]} isLoading={false} />);
    await flush();
    expect(rendered.container.textContent).toContain('请先确认上面的草稿，确认后可以继续对话。');
    expect(Array.from(rendered.container.querySelectorAll<HTMLTextAreaElement>('.ai-composer textarea')).every((textarea) => textarea.disabled)).toBe(true);
    expect(Array.from(rendered.container.querySelectorAll<HTMLButtonElement>('.ai-send-button')).every((button) => !button.disabled)).toBe(true);
    expect(Array.from(rendered.container.querySelectorAll<HTMLButtonElement>('.ai-send-button')).every((button) => button.getAttribute('aria-label') === '中止生成')).toBe(true);
    await act(async () => {
      rendered.container.querySelector<HTMLFormElement>('form.ai-composer')?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });
    await flush();
    expect(streamSpy).not.toHaveBeenCalled();
    await act(async () => {
      rendered.container.querySelector<HTMLButtonElement>('.ai-send-button')?.click();
    });
    await flush();
    expect(cancelSpy).toHaveBeenCalledWith('run-1');
    rendered.unmount();
  });

  it('pauses both composers and blocks sending when AI is not configured', async () => {
    vi.spyOn(api, 'getAiStatus').mockResolvedValue({
      enabled: false,
      provider: 'disabled',
      model: 'gpt-4o-mini',
      status: 'disabled',
      detail: 'AI 模型未配置。',
    });
    vi.spyOn(api, 'getAiMessages').mockResolvedValue([]);
    vi.spyOn(api, 'getPendingAiApprovals').mockResolvedValue([]);
    const streamSpy = vi.spyOn(api, 'streamChatAi').mockResolvedValue({} as AiChatResponse);
    const rendered = await renderWithQuery(<AiWorkspace conversations={[conversation()]} isLoading={false} />);
    await flush();

    expect(rendered.container.textContent).toContain('AI 未配置');
    expect(rendered.container.textContent).toContain('AI 模型未配置。');
    expect(Array.from(rendered.container.querySelectorAll<HTMLTextAreaElement>('.ai-composer textarea')).every((textarea) => textarea.disabled)).toBe(true);
    await act(async () => {
      rendered.container.querySelector<HTMLFormElement>('form.ai-composer')?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });
    await flush();
    expect(streamSpy).not.toHaveBeenCalled();
    rendered.unmount();
  });

  it('resumes the composers after the pending approval is settled and refetched', async () => {
    const pending = approval();
    vi.spyOn(api, 'getAiMessages').mockResolvedValue([]);
    let pendingRequestCount = 0;
    vi.spyOn(api, 'getPendingAiApprovals').mockImplementation(async () => {
      pendingRequestCount += 1;
      return pendingRequestCount === 1 ? [pending] : [];
    });
    const streamDecisionSpy = vi.spyOn(api, 'streamAiApprovalDecision').mockResolvedValue({
      conversation_id: 'conversation-1',
      message: {
        id: 'message-1',
        conversation_id: 'conversation-1',
        role: 'assistant',
        content: '确认完成，已继续处理。',
        content_type: 'parts',
        parts: [{ id: 'part-1', type: 'text', text: '确认完成，已继续处理。' }],
        run_id: 'run-1',
        status: 'completed',
        metadata: {},
        created_at: '2026-05-30T00:00:00Z',
      },
      run: {
        id: 'run-1',
        agent_key: 'recipe_draft_agent',
        intent: 'recipe_draft',
        status: 'completed',
        model: 'rules',
        created_at: '2026-05-30T00:00:00Z',
      },
      events: [],
      included: { result_cards: [], drafts: [], approvals: [] },
    });
    const rendered = await renderWithQuery(<AiWorkspace conversations={[conversation()]} isLoading={false} />);
    await flush();
    expect(Array.from(rendered.container.querySelectorAll<HTMLTextAreaElement>('.ai-composer textarea')).every((textarea) => textarea.disabled)).toBe(true);
    await act(async () => {
      rendered.container.querySelector<HTMLButtonElement>('.ai-approval-actions .solid-button')?.click();
    });
    await flush();
    expect(streamDecisionSpy).toHaveBeenCalledWith(
      'conversation-1',
      'approval-1',
      expect.objectContaining({
        decision: 'approved',
        draft_version: 1,
        values: expect.objectContaining({ recipe: expect.any(Object) }),
      }),
      expect.any(Object),
    );
    expect(Array.from(rendered.container.querySelectorAll<HTMLTextAreaElement>('.ai-composer textarea')).every((textarea) => !textarea.disabled)).toBe(true);
    rendered.unmount();
  });

  it('continues approval resume output inside the original assistant message', async () => {
    const pending = approval();
    vi.spyOn(api, 'getAiMessages').mockResolvedValue([
      {
        id: 'message-1',
        conversation_id: 'conversation-1',
        role: 'assistant',
        content: '菜谱草稿已经生成，请确认。',
        content_type: 'parts',
        parts: [
          { id: 'text-1', type: 'text', text: '菜谱草稿已经生成，请确认。' },
          { id: 'approval-part-1', type: 'approval_request', approval: pending },
        ],
        run_id: 'run-1',
        status: 'waiting_approval',
        metadata: {},
        created_at: '2026-05-30T00:00:00Z',
      },
    ]);
    vi.spyOn(api, 'getPendingAiApprovals').mockResolvedValueOnce([pending]).mockResolvedValue([]);
    vi.spyOn(api, 'streamAiApprovalDecision').mockImplementation(async (_conversationId, _approvalId, _payload, handlers) => {
      handlers?.onMessageDelta?.({
        message_id: 'new-message-should-not-render',
        conversation_id: 'conversation-1',
        run_id: 'run-1',
        part_id: 'resume-text-1',
        delta: '确认完成，我继续整理下一步。',
      });
      return {
        conversation_id: 'conversation-1',
        message: {
          id: 'message-1',
          conversation_id: 'conversation-1',
          role: 'assistant',
          content: '菜谱草稿已经生成，请确认。\n\n确认完成，我继续整理下一步。',
          content_type: 'parts',
          parts: [
            { id: 'text-1', type: 'text', text: '菜谱草稿已经生成，请确认。' },
            { id: 'approval-part-1', type: 'approval_request', approval: { ...pending, status: 'approved', decision: 'approved', submitted_values: pending.initial_values } },
            { id: 'resume-text-1', type: 'text', text: '确认完成，我继续整理下一步。' },
          ],
          run_id: 'run-1',
          status: 'completed',
          metadata: {},
          created_at: '2026-05-30T00:00:00Z',
        },
        run: {
          id: 'run-1',
          agent_key: 'workspace_planner',
          intent: 'multi_skill',
          status: 'completed',
          model: 'rules',
          created_at: '2026-05-30T00:00:00Z',
        },
        events: [],
        included: { result_cards: [], drafts: [], approvals: [] },
      };
    });
    const rendered = await renderWithQuery(<AiWorkspace conversations={[conversation()]} isLoading={false} />);
    await flush();
    expect(rendered.container.querySelectorAll('.ai-desktop-view .ai-message-assistant')).toHaveLength(1);
    await act(async () => {
      rendered.container.querySelector<HTMLButtonElement>('.ai-desktop-view .ai-approval-actions .solid-button')?.click();
    });
    await flush();
    const assistantMessages = rendered.container.querySelectorAll('.ai-desktop-view .ai-message-assistant');
    expect(assistantMessages).toHaveLength(1);
    expect(assistantMessages[0]?.textContent).toContain('确认创建菜谱');
    expect(assistantMessages[0]?.textContent).toContain('确认完成，我继续整理下一步。');
    rendered.unmount();
  });

  it('merges a restored approval into its original assistant message', async () => {
    vi.spyOn(api, 'getAiMessages').mockResolvedValue([
      {
        id: 'message-1',
        conversation_id: 'conversation-1',
        role: 'assistant',
        content: '菜谱草稿已经生成，请确认。',
        content_type: 'parts',
        parts: [{ id: 'text-1', type: 'text', text: '菜谱草稿已经生成，请确认。' }],
        run_id: 'run-1',
        status: 'completed',
        metadata: {},
        created_at: '2026-05-30T00:00:00Z',
      },
    ]);
    vi.spyOn(api, 'getAiRunEvents').mockResolvedValue([]);
    vi.spyOn(api, 'getPendingAiApprovals').mockResolvedValue([approval()]);
    const rendered = await renderWithQuery(<AiWorkspace conversations={[conversation()]} isLoading={false} />);
    await flush();
    expect(rendered.container.querySelectorAll('.ai-desktop-view .ai-message-assistant')).toHaveLength(1);
    expect(rendered.container.querySelectorAll('.ai-mobile-page .ai-message-assistant')).toHaveLength(1);
    expect(rendered.container.textContent).toContain('菜谱草稿已经生成，请确认。');
    expect(rendered.container.textContent).toContain('确认创建菜谱');
    expect(rendered.container.textContent).not.toContain('待处理确认');
    rendered.unmount();
  });

  it('renders assistant text parts as markdown', async () => {
    await act(async () => {
      await import('./MarkdownMessage');
    });
    vi.spyOn(api, 'getAiMessages').mockResolvedValue([
      {
        id: 'message-1',
        conversation_id: 'conversation-1',
        role: 'assistant',
        content: '**晚餐建议**\n\n- 番茄鸡蛋面\n\n记得用 `小火`。',
        content_type: 'parts',
        parts: [{ id: 'text-1', type: 'text', text: '**晚餐建议**\n\n- 番茄鸡蛋面\n\n记得用 `小火`。' }],
        run_id: null,
        status: 'completed',
        metadata: {},
        created_at: '2026-05-30T00:00:00Z',
      },
    ]);
    vi.spyOn(api, 'getPendingAiApprovals').mockResolvedValue([]);
    const rendered = await renderWithQuery(<AiWorkspace conversations={[conversation()]} isLoading={false} />);
    await flush();
    await flush();
    const desktopView = rendered.container.querySelector('.ai-desktop-view') as HTMLElement;
    expect(desktopView.querySelector('.ai-message-markdown strong')?.textContent).toBe('晚餐建议');
    expect(desktopView.querySelector('.ai-message-markdown li')?.textContent).toBe('番茄鸡蛋面');
    expect(desktopView.querySelector('.ai-message-markdown code')?.textContent).toBe('小火');
    rendered.unmount();
  });

  it('restores collapsed run progress when reopening a conversation', async () => {
    vi.spyOn(api, 'getAiMessages').mockResolvedValue([
      {
        id: 'message-1',
        conversation_id: 'conversation-1',
        role: 'assistant',
        content: '已安排好晚餐。',
        content_type: 'parts',
        parts: [{ id: 'text-1', type: 'text', text: '已安排好晚餐。' }],
        run_id: 'run-1',
        status: 'completed',
        metadata: {},
        created_at: '2026-05-30T00:00:00Z',
      },
    ]);
    vi.spyOn(api, 'getAiRunEvents').mockResolvedValue([
      {
        id: 'progress-skill',
        run_id: 'run-1',
        type: 'skill',
        internal_code: 'meal_plan.start',
        user_message: '调用「餐食计划」技能',
        status: 'completed',
        created_at: '2026-05-30T00:00:00Z',
      },
      {
        id: 'progress-tool',
        run_id: 'run-1',
        type: 'tool',
        internal_code: 'inventory.read_available_items',
        user_message: '调用「可用库存」',
        status: 'completed',
        created_at: '2026-05-30T00:00:01Z',
      },
    ]);
    vi.spyOn(api, 'getPendingAiApprovals').mockResolvedValue([]);
    const rendered = await renderWithQuery(<AiWorkspace conversations={[conversation()]} isLoading={false} />);
    await flush();
    await flush();
    const desktopView = rendered.container.querySelector('.ai-desktop-view') as HTMLElement;
    expect(desktopView.querySelector('.ai-run-progress-bar')?.textContent).toContain('餐食计划');
    expect(desktopView.querySelector('.ai-run-progress-bar')?.textContent).toContain('调用「可用库存」');
    expect(desktopView.querySelector('.ai-run-progress-step.status-completed')).toBeNull();
    rendered.unmount();
  });

  it('shows a confirmation modal before deleting a conversation from history', async () => {
    vi.spyOn(api, 'getAiMessages').mockResolvedValue([]);
    vi.spyOn(api, 'getPendingAiApprovals').mockResolvedValue([]);
    const deleteSpy = vi.spyOn(api, 'deleteAiConversation').mockResolvedValue(undefined);
    const rendered = await renderWithQuery(<AiWorkspace conversations={[conversation()]} isLoading={false} />);
    await act(async () => {
      rendered.container.querySelector<HTMLButtonElement>('.ai-conversation-delete')?.click();
    });
    await flush();
    expect(rendered.container.textContent).toContain('删除这条历史？');
    expect(rendered.container.textContent).toContain('帮我生成菜谱');
    await act(async () => {
      rendered.container.querySelector<HTMLButtonElement>('.ai-delete-confirm-actions .solid-button')?.click();
    });
    await flush();
    expect(deleteSpy.mock.calls[0]?.[0]).toBe('conversation-1');
    rendered.unmount();
  });

  it('cancels the server run for an in-flight streamed message', async () => {
    vi.spyOn(api, 'getAiMessages').mockResolvedValue([]);
    vi.spyOn(api, 'getPendingAiApprovals').mockResolvedValue([]);
    let streamAborted = false;
    vi.spyOn(api, 'streamChatAi').mockImplementation(async (_payload, handlers) => {
      handlers?.onProgress?.({
        id: 'progress-1',
        run_id: 'pending',
        type: 'skill',
        internal_code: 'meal_plan.start',
        user_message: '调用「餐食计划」技能',
        status: 'running',
        created_at: '2026-05-30T00:00:00Z',
      });
      await new Promise<void>((_resolve, reject) => {
        handlers?.signal?.addEventListener('abort', () => {
          streamAborted = true;
          reject(new Error('aborted'));
        });
      });
      throw new Error('stream unexpectedly resolved');
    });
    const cancelSpy = vi.spyOn(api, 'cancelAiRun').mockResolvedValue({
      run: { id: 'agent_run-client', status: 'cancelled' },
      events: [
        {
          id: 'cancel-event',
          run_id: 'agent_run-client',
          type: 'cancel',
          internal_code: 'user_cancel',
          user_message: '已取消这次任务',
          status: 'failed',
          created_at: '2026-05-30T00:00:00Z',
        },
      ],
    });
    const rendered = await renderWithQuery(<AiWorkspace conversations={[conversation()]} isLoading={false} />);
    await flush();
    changeInput(rendered.container.querySelector<HTMLTextAreaElement>('textarea.text-input') as HTMLTextAreaElement, '安排三天晚餐');
    await act(async () => {
      rendered.container.querySelector<HTMLFormElement>('form.ai-composer')?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });
    await flush();
    await flush();
    expect(rendered.container.textContent).toContain('餐食计划');
    expect(rendered.container.textContent).not.toContain('等待工具调用');
    expect(rendered.container.querySelector('.ai-run-tool-marquee')).toBeNull();
    expect(rendered.container.querySelector('.ai-stream-progress-strip')).toBeNull();
    expect(rendered.container.querySelector<HTMLButtonElement>('.ai-send-button')?.getAttribute('aria-label')).toBe('中止生成');
    await act(async () => {
      rendered.container.querySelector<HTMLButtonElement>('.ai-send-button')?.click();
    });
    await flush();
    expect(cancelSpy.mock.calls[0]?.[0]).toMatch(/^agent_run-/);
    expect(streamAborted).toBe(true);
    expect(rendered.container.textContent).toContain('已取消这次任务');
    rendered.unmount();
  });

  it('renders streamed progress in an assistant message before any text delta arrives', async () => {
    vi.useFakeTimers();
    vi.spyOn(api, 'getAiMessages').mockResolvedValue([]);
    vi.spyOn(api, 'getPendingAiApprovals').mockResolvedValue([]);
    let resolveStream: ((response: AiChatResponse) => void) | null = null;
    let streamedRunId = 'agent_run-client';
    vi.spyOn(api, 'streamChatAi').mockImplementation(async (payload, handlers) => {
      streamedRunId = payload.client_run_id ?? streamedRunId;
      handlers?.onProgress?.({
        id: 'progress-skill',
        run_id: 'pending',
        type: 'skill',
        internal_code: 'meal_plan.start',
        user_message: '调用「餐食计划」技能',
        status: 'running',
        created_at: '2026-05-30T00:00:00Z',
      });
      handlers?.onProgress?.({
        id: 'progress-1',
        run_id: 'pending',
        type: 'tool',
        internal_code: 'inventory.read_available_items',
        user_message: '调用「可用库存」',
        status: 'completed',
        created_at: '2026-05-30T00:00:00Z',
      });
      handlers?.onMessageDelta?.({
        message_id: 'message-streaming-draft',
        conversation_id: payload.conversation_id ?? 'conversation-1',
        run_id: streamedRunId,
        part_id: 'part-streaming-draft',
        delta: '我会先整理计划。',
      });
      handlers?.onProgress?.({
        id: 'progress-2',
        run_id: 'pending',
        type: 'tool',
        internal_code: 'meal_plan.create_draft',
        user_message: '生成「餐食计划确认表单」',
        status: 'completed',
        created_at: '2026-05-30T00:00:00Z',
      });
      handlers?.onProgress?.({
        id: 'progress-skill-completed',
        run_id: 'pending',
        type: 'skill',
        internal_code: 'meal_plan.completed',
        user_message: '餐食计划执行完成',
        status: 'completed',
        created_at: '2026-05-30T00:00:01Z',
      });
      return new Promise<AiChatResponse>((resolve) => {
        resolveStream = resolve;
      });
    });
    const rendered = await renderWithQuery(<AiWorkspace conversations={[conversation()]} isLoading={false} />);
    await advanceTimers(0);
    changeInput(rendered.container.querySelector<HTMLTextAreaElement>('textarea.text-input') as HTMLTextAreaElement, '安排三天晚餐');
    await act(async () => {
      rendered.container.querySelector<HTMLFormElement>('form.ai-composer')?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });
    await advanceTimers(0);
    await advanceTimers(0);
    const desktopView = rendered.container.querySelector('.ai-desktop-view') as HTMLElement;
    const progressBar = desktopView.querySelector('.ai-run-progress-bar') as HTMLElement;
    expect(rendered.container.querySelectorAll('.ai-desktop-view .ai-message-assistant')).toHaveLength(1);
    expect(progressBar.textContent).toContain('正在执行');
    expect(progressBar.textContent).toContain('餐食计划');
    expect(progressBar.textContent).not.toContain('调用「餐食计划」技能');
    expect(desktopView.textContent).toContain('正在准备可确认草稿');
    const messageBody = desktopView.querySelector('.ai-message-assistant .ai-message-body') as HTMLElement;
    const markdown = messageBody.querySelector('.ai-message-markdown') as HTMLElement;
    const draftCue = messageBody.querySelector('.ai-draft-generating-cue') as HTMLElement;
    expect(markdown.textContent).toContain('我会先整理计划。');
    expect(markdown.compareDocumentPosition(draftCue) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(desktopView.querySelector('.ai-run-tool-marquee.is-scrollable')).toBeNull();
    let toolChips = Array.from(desktopView.querySelectorAll<HTMLElement>('.ai-run-tool-chip'));
    expect(toolChips.map((chip) => chip.textContent)).toEqual(['调用「可用库存」']);
    expect(toolChips[0]?.className).toContain('is-newest');
    await advanceTimers(1999);
    toolChips = Array.from(desktopView.querySelectorAll<HTMLElement>('.ai-run-tool-chip'));
    expect(toolChips.map((chip) => chip.textContent)).toEqual(['调用「可用库存」']);
    await advanceTimers(1);
    toolChips = Array.from(desktopView.querySelectorAll<HTMLElement>('.ai-run-tool-chip'));
    expect(toolChips.map((chip) => chip.textContent)).toEqual(['生成「餐食计划确认表单」', '调用「可用库存」']);
    expect(toolChips[0]?.className).toContain('is-newest');
    expect(toolChips[0]?.className).toContain('kind-form');
    expect(toolChips[0]?.querySelector('.ai-run-tool-icon.icon-form')).not.toBeNull();
    expect(toolChips[1]?.className).toContain('is-shifted');
    expect(toolChips[1]?.className).toContain('kind-tool');
    expect(toolChips[1]?.querySelector('.ai-run-tool-icon.icon-tool')).not.toBeNull();
    expect(desktopView.textContent).not.toContain('meal_plan.create_draft');
    expect(desktopView.querySelector('.ai-run-progress-step.status-completed')).toBeNull();
    expect(desktopView.querySelector('.ai-run-progress-step.status-running')).toBeNull();
    expect(rendered.container.querySelector('.ai-stream-progress-strip')).toBeNull();
    await act(async () => {
      desktopView.querySelector<HTMLButtonElement>('.ai-run-progress-toggle')?.click();
    });
    await advanceTimers(0);
    expect(desktopView.querySelector('.ai-run-progress-step.status-running')?.textContent).toContain('开始执行');
    expect(desktopView.querySelector('.ai-run-progress-step.status-running')?.textContent).toContain('调用「餐食计划」技能');
    expect(desktopView.querySelectorAll('.ai-run-progress-step.status-completed')).toHaveLength(3);
    expect(desktopView.querySelectorAll('.ai-run-progress-step .ai-run-tool-icon.icon-tool')).toHaveLength(1);
    expect(desktopView.querySelectorAll('.ai-run-progress-step .ai-run-tool-icon.icon-form')).toHaveLength(1);
    expect(desktopView.querySelectorAll('.ai-run-progress-step .ai-run-detail-status-dot')).toHaveLength(2);
    expect(desktopView.querySelector('.ai-run-step-status')).toBeNull();
    expect(desktopView.querySelector('.ai-run-step-type')).toBeNull();
    expect(desktopView.textContent).not.toContain('复制执行日志');
    await act(async () => {
      desktopView.querySelector<HTMLButtonElement>('.ai-run-progress-toggle')?.click();
    });
    await advanceTimers(0);
    expect(desktopView.querySelector('.ai-run-progress-step.status-running')).toBeNull();
    await act(async () => {
      resolveStream?.({
        conversation_id: 'conversation-1',
        message: {
          id: 'message-final',
          conversation_id: 'conversation-1',
          role: 'assistant',
          content: '已安排好晚餐。',
          content_type: 'parts',
          parts: [{ id: 'part-final', type: 'text', text: '已安排好晚餐。' }],
          run_id: streamedRunId,
          status: 'completed',
          metadata: {},
          created_at: '2026-05-30T00:00:00Z',
        },
        run: {
          id: streamedRunId,
          agent_key: 'meal_plan_agent',
          intent: 'meal_plan',
          status: 'completed',
          model: 'rules',
          created_at: '2026-05-30T00:00:00Z',
        },
        events: [],
        included: { result_cards: [], drafts: [], approvals: [] },
      });
    });
    await advanceTimers(0);
    expect(rendered.container.textContent).toContain('已安排好晚餐。');
    const settledProgressBar = desktopView.querySelector('.ai-run-progress-bar');
    expect(settledProgressBar?.textContent).toContain('已完成');
    expect(settledProgressBar?.textContent).toContain('餐食计划');
    expect(settledProgressBar?.textContent).toContain('调用「可用库存」');
    expect(settledProgressBar?.textContent).toContain('生成「餐食计划确认表单」');
    expect(desktopView.textContent).not.toContain('正在准备可确认草稿');
    expect(desktopView.querySelector('.ai-run-progress-step.status-completed')).toBeNull();
    rendered.unmount();
  });

  it('keeps streamed local messages visible while the new conversation history query loads', async () => {
    vi.spyOn(api, 'getAiMessages').mockImplementation(() => new Promise(() => undefined));
    vi.spyOn(api, 'getPendingAiApprovals').mockResolvedValue([]);
    let streamedRunId = 'agent_run-client';
    vi.spyOn(api, 'streamChatAi').mockImplementation(async (payload) => {
      streamedRunId = payload.client_run_id ?? streamedRunId;
      return {
        conversation_id: 'conversation-new',
        message: {
          id: 'message-final-new',
          conversation_id: 'conversation-new',
          role: 'assistant',
          content: '已生成确认表单。',
          content_type: 'parts',
          parts: [{ id: 'part-final-new', type: 'text', text: '已生成确认表单。' }],
          run_id: streamedRunId,
          status: 'completed',
          metadata: {},
          created_at: '2026-05-30T00:00:00Z',
        },
        run: {
          id: streamedRunId,
          agent_key: 'meal_plan_agent',
          intent: 'meal_plan',
          status: 'completed',
          model: 'rules',
          created_at: '2026-05-30T00:00:00Z',
        },
        events: [],
        included: { result_cards: [], drafts: [], approvals: [] },
      };
    });
    const rendered = await renderWithQuery(<AiWorkspace conversations={[]} isLoading={false} />);
    await flush();
    changeInput(rendered.container.querySelector<HTMLTextAreaElement>('textarea.text-input') as HTMLTextAreaElement, '安排三天晚餐');
    await act(async () => {
      rendered.container.querySelector<HTMLFormElement>('form.ai-composer')?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });
    await flush();
    const desktopView = rendered.container.querySelector('.ai-desktop-view') as HTMLElement;
    expect(desktopView.textContent).toContain('已生成确认表单。');
    expect(desktopView.textContent).not.toContain('正在加载消息...');
    rendered.unmount();
  });

  it('shows included approvals immediately when the streamed response settles', async () => {
    vi.spyOn(api, 'getAiMessages').mockResolvedValue([]);
    const pendingApprovalsSpy = vi
      .spyOn(api, 'getPendingAiApprovals')
      .mockResolvedValueOnce([])
      .mockImplementation(() => new Promise<AiApprovalRequest[]>(() => undefined));
    let resolveStream: ((response: AiChatResponse) => void) | null = null;
    let streamedRunId = 'agent_run-client';
    vi.spyOn(api, 'streamChatAi').mockImplementation(async (payload, handlers) => {
      streamedRunId = payload.client_run_id ?? streamedRunId;
      handlers?.onProgress?.({
        id: 'progress-skill',
        run_id: streamedRunId,
        type: 'skill',
        internal_code: 'meal_plan.start',
        user_message: '调用「餐食计划」技能',
        status: 'running',
        created_at: '2026-05-30T00:00:00Z',
      });
      return new Promise<AiChatResponse>((resolve) => {
        resolveStream = resolve;
      });
    });
    const rendered = await renderWithQuery(<AiWorkspace conversations={[conversation()]} isLoading={false} />);
    await flush();
    changeInput(rendered.container.querySelector<HTMLTextAreaElement>('textarea.text-input') as HTMLTextAreaElement, '安排三天晚餐');
    await act(async () => {
      rendered.container.querySelector<HTMLFormElement>('form.ai-composer')?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });
    await flush();
    expect(rendered.container.textContent).not.toContain('确认创建菜谱');
    await act(async () => {
      resolveStream?.({
        conversation_id: 'conversation-1',
        message: {
          id: 'message-final',
          conversation_id: 'conversation-1',
          role: 'assistant',
          content: '已生成确认表单。',
          content_type: 'parts',
          parts: [{ id: 'part-final', type: 'text', text: '已生成确认表单。' }],
          run_id: streamedRunId,
          status: 'completed',
          metadata: {},
          created_at: '2026-05-30T00:00:00Z',
        },
        run: {
          id: streamedRunId,
          agent_key: 'meal_plan_agent',
          intent: 'meal_plan',
          status: 'completed',
          model: 'rules',
          created_at: '2026-05-30T00:00:00Z',
        },
        events: [],
        included: {
          result_cards: [],
          drafts: [],
          approvals: [
            approval({
              id: 'approval-streamed',
              message_id: 'message-final',
              run_id: streamedRunId,
              title: '确认创建菜谱',
            }),
          ],
        },
      });
    });
    await flush();
    expect(rendered.container.textContent).toContain('已生成确认表单。');
    expect(rendered.container.textContent).toContain('确认创建菜谱');
    expect(pendingApprovalsSpy).toHaveBeenCalled();
    rendered.unmount();
  });

  it('shows feedback when inventory operation draft creation fails', async () => {
    vi.spyOn(api, 'getAiMessages').mockResolvedValue([
      {
        id: 'message-inventory',
        conversation_id: 'conversation-1',
        role: 'assistant',
        content: '',
        content_type: 'parts',
        parts: [
          {
            id: 'part-inventory',
            type: 'result_card',
            card: {
              id: 'card-inventory',
              type: 'inventory_summary',
              title: '临期库存',
              data: {
                queryFocus: 'expiring',
                availableCount: 1,
                expiringCount: 1,
                lowStockCount: 0,
                items: [
                  {
                    id: 'inventory-tomato',
                    ingredientId: 'ingredient-tomato',
                    name: '番茄',
                    quantity: '2',
                    unit: '个',
                    status: 'fresh',
                    displayStatus: 'expiring',
                    expiryDate: '2026-06-16',
                    suggestedAction: 'dispose',
                  },
                ],
              },
            },
          },
        ],
        run_id: 'run-inventory',
        status: 'completed',
        metadata: {},
        created_at: '2026-05-30T00:00:00Z',
      },
    ]);
    vi.spyOn(api, 'getPendingAiApprovals').mockResolvedValue([]);
    vi.spyOn(api, 'createAiInventoryOperationDraft').mockRejectedValue(new Error('库存批次已变化'));

    const rendered = await renderWithQuery(<AiWorkspace conversations={[conversation()]} isLoading={false} />);
    await flush();
    const disposeButton = Array.from(rendered.container.querySelectorAll<HTMLButtonElement>('button')).find((button) => button.textContent === '销毁');
    await act(async () => disposeButton?.click());
    await flush();

    expect(rendered.container.textContent).toContain('番茄的销毁草稿生成失败：库存批次已变化');
    rendered.unmount();
  });

  it('renders streamed assistant text before the final response arrives', async () => {
    vi.spyOn(api, 'getAiMessages').mockResolvedValue([]);
    vi.spyOn(api, 'getPendingAiApprovals').mockResolvedValue([]);
    let resolveStream: ((response: AiChatResponse) => void) | null = null;
    let streamedRunId = 'agent_run-client';
    vi.spyOn(api, 'streamChatAi').mockImplementation(async (payload, handlers) => {
      streamedRunId = payload.client_run_id ?? streamedRunId;
      handlers?.onMessageDelta?.({
        message_id: 'message-streaming',
        conversation_id: payload.conversation_id ?? 'conversation-1',
        run_id: payload.client_run_id,
        part_id: 'part-streaming',
        delta: '先推荐番茄鸡蛋面',
      });
      return new Promise<AiChatResponse>((resolve) => {
        resolveStream = resolve;
      });
    });
    const rendered = await renderWithQuery(<AiWorkspace conversations={[conversation()]} isLoading={false} />);
    await flush();
    changeInput(rendered.container.querySelector<HTMLTextAreaElement>('textarea.text-input') as HTMLTextAreaElement, '今日吃什么？');
    await act(async () => {
      rendered.container.querySelector<HTMLFormElement>('form.ai-composer')?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });
    await flush();
    expect(rendered.container.textContent).toContain('先推荐番茄鸡蛋面');
    await act(async () => {
      resolveStream?.({
        conversation_id: 'conversation-1',
        message: {
          id: 'message-final',
          conversation_id: 'conversation-1',
          role: 'assistant',
          content: '先推荐番茄鸡蛋面',
          content_type: 'parts',
          parts: [{ id: 'part-final', type: 'text', text: '先推荐番茄鸡蛋面' }],
          run_id: streamedRunId,
          status: 'completed',
          metadata: {},
          created_at: '2026-05-30T00:00:00Z',
        },
        run: {
          id: streamedRunId,
          agent_key: 'meal_plan_agent',
          intent: 'meal_plan',
          status: 'completed',
          model: 'rules',
          created_at: '2026-05-30T00:00:00Z',
        },
        events: [],
        included: { result_cards: [], drafts: [], approvals: [] },
      });
    });
    await flush();
    rendered.unmount();
  });

  it('starts streamed assistant text on a new paragraph after progress events', async () => {
    vi.spyOn(api, 'getAiMessages').mockResolvedValue([]);
    vi.spyOn(api, 'getPendingAiApprovals').mockResolvedValue([]);
    let resolveStream: ((response: AiChatResponse) => void) | null = null;
    let streamedRunId = 'agent_run-client';
    vi.spyOn(api, 'streamChatAi').mockImplementation(async (payload, handlers) => {
      streamedRunId = payload.client_run_id ?? streamedRunId;
      handlers?.onMessageDelta?.({
        message_id: 'message-streaming',
        conversation_id: payload.conversation_id ?? 'conversation-1',
        run_id: streamedRunId,
        part_id: 'part-streaming',
        delta: '我先查一下库存。',
      });
      handlers?.onProgress?.({
        id: 'progress-tool',
        run_id: streamedRunId,
        type: 'tool',
        internal_code: 'inventory.read_available_items',
        user_message: '调用「可用库存」',
        status: 'completed',
        created_at: '2026-05-30T00:00:00Z',
      });
      handlers?.onMessageDelta?.({
        message_id: 'message-streaming',
        conversation_id: payload.conversation_id ?? 'conversation-1',
        run_id: streamedRunId,
        part_id: 'part-streaming',
        delta: '库存看完了，',
      });
      handlers?.onMessageDelta?.({
        message_id: 'message-streaming',
        conversation_id: payload.conversation_id ?? 'conversation-1',
        run_id: streamedRunId,
        part_id: 'part-streaming',
        delta: '推荐番茄鸡蛋面。',
      });
      return new Promise<AiChatResponse>((resolve) => {
        resolveStream = resolve;
      });
    });
    const rendered = await renderWithQuery(<AiWorkspace conversations={[conversation()]} isLoading={false} />);
    await flush();
    changeInput(rendered.container.querySelector<HTMLTextAreaElement>('textarea.text-input') as HTMLTextAreaElement, '今日吃什么？');
    await act(async () => {
      rendered.container.querySelector<HTMLFormElement>('form.ai-composer')?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });
    await flush();
    const desktopMarkdown = rendered.container.querySelector('.ai-desktop-view .ai-message-assistant .ai-message-markdown') as HTMLElement;
    const paragraphs = Array.from(desktopMarkdown.querySelectorAll('p')).map((item) => item.textContent);
    expect(paragraphs).toEqual(['我先查一下库存。', '库存看完了，推荐番茄鸡蛋面。']);
    await act(async () => {
      resolveStream?.({
        conversation_id: 'conversation-1',
        message: {
          id: 'message-final',
          conversation_id: 'conversation-1',
          role: 'assistant',
          content: '我先查一下库存。\n\n库存看完了，推荐番茄鸡蛋面。',
          content_type: 'parts',
          parts: [{ id: 'part-final', type: 'text', text: '我先查一下库存。\n\n库存看完了，推荐番茄鸡蛋面。' }],
          run_id: streamedRunId,
          status: 'completed',
          metadata: {},
          created_at: '2026-05-30T00:00:00Z',
        },
        run: {
          id: streamedRunId,
          agent_key: 'meal_plan_agent',
          intent: 'meal_plan',
          status: 'completed',
          model: 'rules',
          created_at: '2026-05-30T00:00:00Z',
        },
        events: [],
        included: { result_cards: [], drafts: [], approvals: [] },
      });
    });
    await flush();
    rendered.unmount();
  });

  it('keeps unfinished streamed text on the same line after progress events', async () => {
    vi.spyOn(api, 'getAiMessages').mockResolvedValue([]);
    vi.spyOn(api, 'getPendingAiApprovals').mockResolvedValue([]);
    let resolveStream: ((response: AiChatResponse) => void) | null = null;
    let streamedRunId = 'agent_run-client';
    vi.spyOn(api, 'streamChatAi').mockImplementation(async (payload, handlers) => {
      streamedRunId = payload.client_run_id ?? streamedRunId;
      handlers?.onMessageDelta?.({
        message_id: 'message-streaming-fragment',
        conversation_id: payload.conversation_id ?? 'conversation-1',
        run_id: streamedRunId,
        part_id: 'part-streaming-fragment',
        delta: '我查',
      });
      handlers?.onProgress?.({
        id: 'progress-tool-fragment',
        run_id: streamedRunId,
        type: 'tool',
        internal_code: 'inventory.read_available_items',
        user_message: '调用「可用库存」',
        status: 'completed',
        created_at: '2026-05-30T00:00:00Z',
      });
      handlers?.onMessageDelta?.({
        message_id: 'message-streaming-fragment',
        conversation_id: payload.conversation_id ?? 'conversation-1',
        run_id: streamedRunId,
        part_id: 'part-streaming-fragment',
        delta: '到当前显示已过期的有 3 项。',
      });
      return new Promise<AiChatResponse>((resolve) => {
        resolveStream = resolve;
      });
    });
    const rendered = await renderWithQuery(<AiWorkspace conversations={[conversation()]} isLoading={false} />);
    await flush();
    changeInput(rendered.container.querySelector<HTMLTextAreaElement>('textarea.text-input') as HTMLTextAreaElement, '检查过期库存');
    await act(async () => {
      rendered.container.querySelector<HTMLFormElement>('form.ai-composer')?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });
    await flush();
    const desktopMarkdown = rendered.container.querySelector('.ai-desktop-view .ai-message-assistant .ai-message-markdown') as HTMLElement;
    const paragraphs = Array.from(desktopMarkdown.querySelectorAll('p')).map((item) => item.textContent);
    expect(paragraphs).toEqual(['我查到当前显示已过期的有 3 项。']);
    await act(async () => {
      resolveStream?.({
        conversation_id: 'conversation-1',
        message: {
          id: 'message-final-fragment',
          conversation_id: 'conversation-1',
          role: 'assistant',
          content: '我查到当前显示已过期的有 3 项。',
          content_type: 'parts',
          parts: [{ id: 'part-final-fragment', type: 'text', text: '我查到当前显示已过期的有 3 项。' }],
          run_id: streamedRunId,
          status: 'completed',
          metadata: {},
          created_at: '2026-05-30T00:00:00Z',
        },
        run: {
          id: streamedRunId,
          agent_key: 'inventory_analysis_agent',
          intent: 'inventory_analysis',
          status: 'completed',
          model: 'rules',
          created_at: '2026-05-30T00:00:00Z',
        },
        events: [],
        included: { result_cards: [], drafts: [], approvals: [] },
      });
    });
    await flush();
    rendered.unmount();
  });
});
