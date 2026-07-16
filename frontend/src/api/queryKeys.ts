const inventoryOverviewRoot = ['inventory', 'overview'] as const;
const foodPlanRoot = ['food-plan'] as const;
const mealCandidatesRoot = ['meal-logs', 'candidates'] as const;

export const queryKeys = {
  authMe: ['auth', 'me'] as const,
  family: ['family'] as const,
  members: ['members'] as const,
  ingredients: ['ingredients'] as const,
  ingredientSearch: (query: string) => ['ingredients', 'search', query.trim()] as const,
  ingredientPickerSearch: (query: string) => ['ingredients', 'picker-search', query.trim()] as const,
  inventory: ['inventory'] as const,
  inventoryStates: ['inventory', 'states'] as const,
  inventoryReconciliation: (scope: string, storageLocation?: string) =>
    ['inventory', 'reconciliation', scope, storageLocation ?? ''] as const,
  inventoryOperations: ['inventory', 'operations'] as const,
  inventoryOperationList: (limit = 20) => ['inventory', 'operations', 'list', limit] as const,
  inventoryOperationDetail: (operationId: string) =>
    ['inventory', 'operations', 'detail', operationId] as const,
  inventorySearch: (query: string) => ['inventory', 'search', query.trim()] as const,
  inventoryOverviewRoot,
  inventoryOverview: (scope = 'all', query = '') => [...inventoryOverviewRoot, scope, query.trim()] as const,
  shoppingList: ['shopping-list'] as const,
  recipes: ['recipes'] as const,
  recipeSearch: (query: string) => ['recipes', 'search', query.trim()] as const,
  recipePickerSearch: (query: string) => ['recipes', 'picker-search', query.trim()] as const,
  recipeDiscovery: ['recipe-discovery'] as const,
  recipeStats: ['recipe-stats'] as const,
  recipeFavorites: ['recipe-favorites'] as const,
  foodPlanRoot,
  foodPlan: (start: string, end: string, query = '') => ['food-plan', start, end, query.trim()] as const,
  foodPlanDetail: (itemId: string) => [...foodPlanRoot, 'detail', itemId] as const,
  foodScenes: ['food-scenes'] as const,
  foods: ['foods'] as const,
  foodSearch: (query: string) => ['foods', 'search', query.trim()] as const,
  foodPickerSearch: (query: string) => ['foods', 'picker-search', query.trim()] as const,
  foodRecommendations: ['food-recommendations'] as const,
  searchRoot: ['search'] as const,
  search: (query: string, scopes: readonly string[] = [], limit = 20, offset = 0) =>
    ['search', query.trim(), [...scopes].sort().join(','), limit, offset] as const,
  mealLogs: ['meal-logs'] as const,
  mealCandidatesRoot,
  mealCandidates: (date: string, mealType: string) =>
    [...mealCandidatesRoot, date, mealType] as const,
  mealRecordOperations: (active: boolean) =>
    ['meal-logs', 'record-operations', active] as const,
  mealInsights: ['meal-logs', 'insights'] as const,
  activityLogs: ['activity-logs'] as const,
  activityLogList: (params: {
    start_date?: string;
    end_date?: string;
    actor_id?: string;
    action?: string;
    entity_type?: string;
    limit?: number;
    offset?: number;
  } = {}) =>
    [
      'activity-logs',
      params.start_date ?? '',
      params.end_date ?? '',
      params.actor_id ?? '',
      params.action ?? '',
      params.entity_type ?? '',
      params.limit ?? '',
      params.offset ?? 0,
    ] as const,
  activityHighlights: ['activity-highlights'] as const,
  activityHighlightList: (limit = 5) =>
    ['activity-highlights', 'list', limit] as const,
  aiStatus: ['ai-status'] as const,
  aiImageJobs: ['ai-image-jobs'] as const,
  searchIndexJobs: ['search-index-jobs'] as const,
  aiQualityMetrics: ['ai-quality-metrics'] as const,
  aiConversations: ['ai-conversations'] as const,
  aiMessages: (conversationId: string | null) => ['ai-messages', conversationId] as const,
  aiRunTrace: (runId: string | null) => ['ai-run-trace', runId] as const,
  aiRunTraceTree: (runId: string | null) => ['ai-run-trace-tree', runId] as const,
  aiRunLlmExchanges: (runId: string | null, includePayload = true) => ['ai-run-llm-exchanges', runId, includePayload] as const,
  aiRunLlmExchange: (runId: string | null, exchangeId: string | null) => ['ai-run-llm-exchange', runId, exchangeId] as const,
  aiPendingApprovals: (conversationId: string | null) => ['ai-pending-approvals', conversationId] as const,
};
