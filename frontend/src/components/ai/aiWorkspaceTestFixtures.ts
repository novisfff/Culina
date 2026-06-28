import type { AiApprovalRequest, AiConversation, AiGeneratedRecipeDraft, AiQualityMetrics } from '../../api/types';

export function recipeDraft(title = '番茄鸡蛋面'): AiGeneratedRecipeDraft {
  return {
    title,
    servings: 2,
    prep_minutes: 20,
    difficulty: 'easy',
    ingredient_items: [{ ingredient_id: 'ingredient-tomato', ingredient_name: '番茄', quantity: 2, unit: '个', note: '切块' }],
    steps: [
      { title: '备菜', text: '番茄切块。', icon: 'bowl', summary: '备菜', estimated_minutes: 5, tip: '', key_points: [] },
      { title: '烹调', text: '中火煮熟。', icon: 'pan', summary: '烹调', estimated_minutes: 10, tip: '', key_points: [] },
    ],
    tips: '少油少盐',
    scene_tags: ['家常菜'],
    media_ids: [],
  };
}

export function approval(overrides: Partial<AiApprovalRequest> = {}): AiApprovalRequest {
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

export function shoppingApproval(overrides: Partial<AiApprovalRequest> = {}): AiApprovalRequest {
  const draft = {
    draftType: 'shopping_list',
    schemaVersion: 'shopping_list.v1',
    items: [{ title: '鸡蛋', ingredient_id: 'ingredient-egg', quantityMode: 'track_quantity', quantity: 1, unit: '盒', reason: '补充常用食材' }],
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

export function mealPlanApproval(overrides: Partial<AiApprovalRequest> = {}, draftOverrides: Record<string, unknown> = {}): AiApprovalRequest {
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
    ...draftOverrides,
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
    ...overrides,
  });
}

export function conversation(): AiConversation {
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

export function qualityMetrics(overrides: Partial<AiQualityMetrics> = {}): AiQualityMetrics {
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
    trace_metrics: {
      traceSpanCount: 4,
      llmExchangeCount: 2,
      failedSpanCount: 1,
      failedExchangeCount: 1,
      averageProviderDurationMs: 610,
      averageToolDurationMs: 120,
      averageScriptDurationMs: 40,
      averageProviderRounds: 1,
      errorCodes: { provider_stream_failed: 1, tool_input_validation_failed: 1 },
      spanTypeCounts: { tool_call: 2, script_call: 1, provider_round: 1 },
      spanStatusCounts: { completed: 3, failed: 1 },
      exchangeStatusCounts: { completed: 1, failed: 1 },
    },
    recent_runs: [],
    ...overrides,
  };
}
