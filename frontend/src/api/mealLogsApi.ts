import { request } from './request';
import type {
  CompleteFoodPlanItemPayload,
  MealInsight,
  MealLog,
  MealLogCandidate,
  MealLogRecordOperationSummary,
  MealType,
  RecordMealPayload,
  RecordMealResponse,
  RevertMealRecordResponse,
  UpdateMealCompositionPayload,
  UpdateMealLogPayload,
} from './types';

export const mealLogsApi = {
  getMealLogs: () => request<MealLog[]>('/api/meal-logs'),
  getMealCandidates: (date: string, mealType: MealType) => {
    const search = new URLSearchParams({
      date,
      meal_type: mealType,
    });
    return request<MealLogCandidate[]>(`/api/meal-logs/candidates?${search.toString()}`);
  },
  recordMeal: (payload: RecordMealPayload) =>
    request<RecordMealResponse>('/api/meal-logs/record', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),
  updateMealComposition: (mealLogId: string, payload: UpdateMealCompositionPayload) =>
    request<MealLog>(`/api/meal-logs/${mealLogId}/composition`, {
      method: 'PATCH',
      body: JSON.stringify(payload),
    }),
  getActiveMealRecordOperations: (active = true) =>
    request<MealLogRecordOperationSummary[]>(
      `/api/meal-logs/record-operations?active=${encodeURIComponent(String(active))}`,
    ),
  revertMealRecordOperation: (operationId: string) =>
    request<RevertMealRecordResponse>(`/api/meal-logs/record-operations/${operationId}/revert`, {
      method: 'POST',
    }),
  getMealInsights: () => request<MealInsight[]>('/api/meal-logs/insights'),
  completeFoodPlanItem: (itemId: string, payload: CompleteFoodPlanItemPayload) =>
    request<MealLog>(`/api/food-plan/${itemId}/complete`, {
      method: 'POST',
      body: JSON.stringify(payload),
    }),
  updateMealLog: (mealLogId: string, payload: UpdateMealLogPayload) =>
    request<MealLog>(`/api/meal-logs/${mealLogId}`, {
      method: 'PATCH',
      body: JSON.stringify(payload),
    }),
};
