import type { AiQualityMetrics, AiRateMetric } from '../../api/types';

export const AI_SKILL_LABELS: Record<string, string> = {
  inventory_analysis: '库存查看与处理',
  meal_plan: '餐食安排',
  shopping_list: '采购清单整理',
  meal_log: '用餐记录',
  food_profile: '食物信息整理',
  ingredient_profile: '食材信息整理',
  recipe_draft: '菜谱整理',
  recipe_cook: '按菜谱做菜',
};

export const AI_INTENT_LABELS: Record<string, string> = {
  meal_plan: '餐食计划',
  shopping_list: '采购清单',
  recipe_draft: '菜谱',
  inventory_analysis: '库存',
  multi_skill: '多步骤',
  planner_failed: '需求未识别',
};

/** User-facing names for diagnostic keys returned by the quality endpoint. */
export const AI_DIAGNOSTIC_LABELS: Record<string, string> = {
  'shopping_list:missing ingredient ids': '采购清单缺少食材信息',
  'recipe_draft:invalid recipe steps': '菜谱步骤信息不完整',
  'meal_plan:missing food ids': '餐食计划缺少食物信息',
};

export const AI_TRACE_ERROR_LABELS: Record<string, string> = {
  provider_stream_failed: '模型回复中断',
  provider_empty_response: '模型没有返回内容',
  provider_unavailable: '模型服务暂时不可用',
  tool_input_validation_failed: '自动处理信息不完整',
  skill_failed: '处理步骤失败',
  model_usage_settlement_failed: '用量记录暂时失败',
};

export const AI_CLARIFICATION_LABELS: Record<string, string> = {
  missing_date: '缺少日期',
  missing_meal_type: '缺少餐次',
  missing_food: '缺少食物',
  missing_ingredient: '缺少食材',
};

export const AI_STATUS_LABELS: Record<string, string> = {
  completed: '完成',
  failed: '失败',
  pending: '等待中',
  running: '处理中',
  waiting_approval: '待确认',
  cancelled: '已取消',
  approved: '已确认',
  rejected: '已拒绝',
};

export function formatAiMetricLabel(value: string, labels: Record<string, string> = {}) {
  return labels[value] ?? value.replace(/_/g, ' ');
}

export function topAiMetricEntry(values?: Record<string, number>) {
  const [key, count] = Object.entries(values ?? {}).sort((a, b) => b[1] - a[1])[0] ?? [];
  return key ? { key, count } : null;
}

export function sortedAiMetricEntries(values?: Record<string, number>, limit = 6) {
  return Object.entries(values ?? {})
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([key, count]) => ({ key, count }));
}

export function sumAiNestedStatus(values: AiQualityMetrics['approval_by_draft_type'] | undefined, status: string) {
  return Object.values(values ?? {}).reduce((total, counts) => total + (counts[status] ?? 0), 0);
}

export function aiRunSuccessRate(metrics: AiQualityMetrics) {
  const completed = metrics.status_counts.completed ?? 0;
  if (!metrics.run_count) return '0%';
  return `${Math.round((completed / metrics.run_count) * 100)}%`;
}

export function formatAiRate(metric?: AiRateMetric | null) {
  if (!metric || !metric.denominator || metric.rate == null) return '还没有数据';
  return `${Math.round(metric.rate * 100)}%（${metric.numerator}/${metric.denominator}）`;
}

export function formatAiDuration(ms?: number | null) {
  const value = Number(ms ?? 0);
  if (!Number.isFinite(value) || value <= 0) return '0 秒';
  if (value < 1000) return `${Math.round(value)} 毫秒`;
  return `${(value / 1000).toFixed(value < 10_000 ? 1 : 0)} 秒`;
}

export const AI_TOKEN_USAGE_WINDOWS = [
  { key: '24h', label: '24 小时' },
  { key: '7d', label: '7 天' },
  { key: '30d', label: '30 天' },
] as const;

export type AiTokenUsageWindowKey = (typeof AI_TOKEN_USAGE_WINDOWS)[number]['key'];

export function formatAiTokenCount(value?: number | null) {
  const amount = Number(value ?? 0);
  if (!Number.isFinite(amount) || amount <= 0) return '0';
  if (amount < 1000) return `${Math.round(amount)}`;
  if (amount < 1_000_000) {
    const thousands = amount / 1000;
    if (amount < 100_000 && !Number.isInteger(thousands)) {
      return `${thousands.toFixed(1)}K`;
    }
    return `${Math.round(thousands)}K`;
  }
  const millions = amount / 1_000_000;
  return `${millions.toFixed(amount < 10_000_000 && !Number.isInteger(millions) ? 1 : 0)}M`;
}

export function formatAiTokenCost(value?: number | null) {
  const amount = Number(value ?? 0);
  if (!Number.isFinite(amount) || amount <= 0) return '—';
  if (amount < 0.01) return `$${amount.toFixed(4)}`;
  return `$${amount.toFixed(2)}`;
}
