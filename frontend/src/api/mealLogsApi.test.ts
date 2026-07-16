import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockRequest = vi.fn();

vi.mock('./request', () => ({
  request: (...args: unknown[]) => mockRequest(...args),
}));

import { mealLogsApi } from './mealLogsApi';

describe('mealLogsApi transport', () => {
  beforeEach(() => {
    mockRequest.mockReset();
  });

  it('encodes authoritative candidate query parameters', async () => {
    mockRequest.mockResolvedValueOnce([]);
    await mealLogsApi.getMealCandidates('2026-07-15', 'dinner');
    expect(mockRequest).toHaveBeenCalledWith(
      '/api/meal-logs/candidates?date=2026-07-15&meal_type=dinner',
    );
  });

  it('records a meal against a new target', async () => {
    mockRequest.mockResolvedValueOnce({ outcome: 'created' });
    await mealLogsApi.recordMeal({
      client_request_id: 'req-1',
      date: '2026-07-15',
      meal_type: 'dinner',
      target: { kind: 'new' },
      new_foods: [{ client_food_id: 'tmp-1', name: '番茄炒蛋', type: 'selfMade' }],
      entries: [{ client_food_id: 'tmp-1', servings: 1 }],
    });
    expect(mockRequest).toHaveBeenCalledWith('/api/meal-logs/record', {
      method: 'POST',
      body: JSON.stringify({
        client_request_id: 'req-1',
        date: '2026-07-15',
        meal_type: 'dinner',
        target: { kind: 'new' },
        new_foods: [{ client_food_id: 'tmp-1', name: '番茄炒蛋', type: 'selfMade' }],
        entries: [{ client_food_id: 'tmp-1', servings: 1 }],
      }),
    });
  });

  it('records a meal against an existing target with row version', async () => {
    mockRequest.mockResolvedValueOnce({ outcome: 'appended' });
    await mealLogsApi.recordMeal({
      client_request_id: 'req-2',
      date: '2026-07-15',
      meal_type: 'lunch',
      target: { kind: 'existing', meal_log_id: 'meal-1', expected_row_version: 3 },
      entries: [{ food_id: 'food-1', servings: 1.5 }],
    });
    expect(mockRequest).toHaveBeenCalledWith('/api/meal-logs/record', {
      method: 'POST',
      body: JSON.stringify({
        client_request_id: 'req-2',
        date: '2026-07-15',
        meal_type: 'lunch',
        target: { kind: 'existing', meal_log_id: 'meal-1', expected_row_version: 3 },
        entries: [{ food_id: 'food-1', servings: 1.5 }],
      }),
    });
  });

  it('patches meal composition with expected row version', async () => {
    mockRequest.mockResolvedValueOnce({ id: 'meal-1' });
    await mealLogsApi.updateMealComposition('meal-1', {
      expected_row_version: 2,
      food_entries: [
        { id: 'entry-1', food_id: 'food-1', servings: 1, note: '' },
        { food_id: 'food-2', servings: 2, note: 'extra' },
      ],
    });
    expect(mockRequest).toHaveBeenCalledWith('/api/meal-logs/meal-1/composition', {
      method: 'PATCH',
      body: JSON.stringify({
        expected_row_version: 2,
        food_entries: [
          { id: 'entry-1', food_id: 'food-1', servings: 1, note: '' },
          { food_id: 'food-2', servings: 2, note: 'extra' },
        ],
      }),
    });
  });

  it('loads active meal record operations', async () => {
    mockRequest.mockResolvedValueOnce([]);
    await mealLogsApi.getActiveMealRecordOperations(true);
    expect(mockRequest).toHaveBeenCalledWith('/api/meal-logs/record-operations?active=true');
  });

  it('reverts a meal record operation by id', async () => {
    mockRequest.mockResolvedValueOnce({ status: 'reverted', replayed: false });
    await mealLogsApi.revertMealRecordOperation('op-1');
    expect(mockRequest).toHaveBeenCalledWith('/api/meal-logs/record-operations/op-1/revert', {
      method: 'POST',
    });
  });

  it('loads meal insights without query parameters', async () => {
    mockRequest.mockResolvedValueOnce([]);
    await mealLogsApi.getMealInsights();
    expect(mockRequest).toHaveBeenCalledWith('/api/meal-logs/insights');
  });

  it('completes a food plan item with optional meal target lock', async () => {
    mockRequest.mockResolvedValueOnce({ id: 'meal-1' });
    await mealLogsApi.completeFoodPlanItem('plan-1', {
      food_plan_item_base_updated_at: '2026-07-15T08:00:00.000Z',
      target_meal_log_id: 'meal-1',
      expected_meal_log_row_version: 4,
    });
    expect(mockRequest).toHaveBeenCalledWith('/api/food-plan/plan-1/complete', {
      method: 'POST',
      body: JSON.stringify({
        food_plan_item_base_updated_at: '2026-07-15T08:00:00.000Z',
        target_meal_log_id: 'meal-1',
        expected_meal_log_row_version: 4,
      }),
    });
  });

  it('keeps legacy meal log list and rating update transport', async () => {
    mockRequest.mockResolvedValueOnce([]);
    await mealLogsApi.getMealLogs();
    expect(mockRequest).toHaveBeenCalledWith('/api/meal-logs');

    mockRequest.mockResolvedValueOnce({ id: 'meal-1' });
    await mealLogsApi.updateMealLog('meal-1', {
      expected_row_version: 5,
      food_entry_ratings: [{ id: 'entry-1', rating: 4 }],
    });
    expect(mockRequest).toHaveBeenCalledWith('/api/meal-logs/meal-1', {
      method: 'PATCH',
      body: JSON.stringify({
        expected_row_version: 5,
        food_entry_ratings: [{ id: 'entry-1', rating: 4 }],
      }),
    });
  });
});
