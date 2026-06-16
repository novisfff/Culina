import type { AiQualityMetrics } from '../../api/types';

export const AI_SKILL_LABELS: Record<string, string> = {
  inventory_analysis: '库存分析',
  meal_plan: '餐食计划',
  shopping_list: '购物清单',
  meal_log: '餐食记录',
  food_profile: '食物资料',
  ingredient_profile: '食材档案',
  recipe_draft: '菜谱草稿',
  recipe_cook: '做菜记录',
};

export const AI_INTENT_LABELS: Record<string, string> = {
  meal_plan: '餐食计划',
  shopping_list: '购物清单',
  recipe_draft: '菜谱',
  inventory_analysis: '库存',
  multi_skill: '多步骤',
  planner_failed: '路由失败',
};

export const AI_STATUS_LABELS: Record<string, string> = {
  completed: '完成',
  failed: '失败',
  pending: '等待中',
  running: '运行中',
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

export function formatAiDuration(ms?: number | null) {
  const value = Number(ms ?? 0);
  if (!Number.isFinite(value) || value <= 0) return '0 秒';
  if (value < 1000) return `${Math.round(value)} 毫秒`;
  return `${(value / 1000).toFixed(value < 10_000 ? 1 : 0)} 秒`;
}
