import { describe, expect, it } from 'vitest';
import { queryKeys } from './queryKeys';

describe('queryKeys', () => {
  it('normalizes search-oriented keys', () => {
    expect(queryKeys.ingredientSearch('  番茄  ')).toEqual(['ingredients', 'search', '番茄']);
    expect(queryKeys.foodPlan('2026-06-01', '2026-06-07', ' 晚餐 ')).toEqual([
      'food-plan',
      '2026-06-01',
      '2026-06-07',
      '晚餐',
    ]);
    expect(queryKeys.inventoryOverviewRoot).toEqual(['inventory', 'overview']);
    expect(queryKeys.inventoryStates).toEqual(['inventory', 'states']);
    expect(queryKeys.inventoryReconciliation('suggested')).toEqual(['inventory', 'reconciliation', 'suggested', '']);
    expect(queryKeys.inventoryReconciliation('refrigerated', '冷藏')).toEqual([
      'inventory',
      'reconciliation',
      'refrigerated',
      '冷藏',
    ]);
    expect(queryKeys.inventoryOperations).toEqual(['inventory', 'operations']);
    expect(queryKeys.inventoryOperationList(20)).toEqual(['inventory', 'operations', 'list', 20]);
    expect(queryKeys.inventoryOperationDetail('op-1')).toEqual(['inventory', 'operations', 'detail', 'op-1']);
    expect(queryKeys.inventoryOverview('food', ' 酸奶 ')).toEqual(['inventory', 'overview', 'food', '酸奶']);
    expect(queryKeys.activityLogList({ actor_id: 'user-1', limit: 50, offset: 0 })).toEqual([
      'activity-logs',
      '',
      '',
      'user-1',
      '',
      '',
      50,
      0,
    ]);
  });

  it('sorts global search scopes without mutating the input', () => {
    const scopes = ['recipe', 'ingredient', 'food'] as const;

    expect(queryKeys.search(' 番茄 ', scopes, 10, 5)).toEqual([
      'search',
      '番茄',
      'food,ingredient,recipe',
      10,
      5,
    ]);
    expect(scopes).toEqual(['recipe', 'ingredient', 'food']);
  });

  it('keeps highlight limits and audit logs in separate caches', () => {
    expect(queryKeys.activityHighlights).toEqual(['activity-highlights']);
    expect(queryKeys.activityHighlightList(5)).toEqual(['activity-highlights', 'list', 5]);
    expect(queryKeys.activityHighlightList(3)).not.toEqual(queryKeys.activityHighlightList(5));
    expect(queryKeys.activityHighlightList(5)).not.toEqual(queryKeys.activityLogs);
  });

  it('nests food plan detail under the FoodPlan root', () => {
    expect(queryKeys.foodPlanDetail('plan-1')).toEqual(['food-plan', 'detail', 'plan-1']);
    expect(queryKeys.foodPlanDetail('plan-1')[0]).toBe(queryKeys.foodPlanRoot[0]);
  });

  it('centralizes meal candidate, record-operation and insight keys', () => {
    expect(queryKeys.mealLogs).toEqual(['meal-logs']);
    expect(queryKeys.mealCandidatesRoot).toEqual(['meal-logs', 'candidates']);
    expect(queryKeys.mealCandidates('2026-07-15', 'dinner')).toEqual([
      'meal-logs',
      'candidates',
      '2026-07-15',
      'dinner',
    ]);
    expect(queryKeys.mealCandidates('2026-07-15', 'dinner')[0]).toBe(queryKeys.mealCandidatesRoot[0]);
    expect(queryKeys.mealCandidates('2026-07-15', 'dinner').slice(0, 2)).toEqual(
      queryKeys.mealCandidatesRoot,
    );
    expect(queryKeys.mealRecordOperations(true)).toEqual(['meal-logs', 'record-operations', true]);
    expect(queryKeys.mealRecordOperations(false)).toEqual(['meal-logs', 'record-operations', false]);
    expect(queryKeys.mealInsights).toEqual(['meal-logs', 'insights']);
  });
});
