import { request } from './request';
import type {
  ModelUsageAlert,
  ModelUsageAlertReceipt,
  ModelUsageFamilyBreakdown,
  ModelUsageFamilyOverview,
  ModelUsageFamilyGroupBy,
  ModelUsageFamilyRequestFilters,
  ModelUsageFamilyRequestLogPage,
  ModelUsagePersonalGroupBy,
  ModelUsagePersonalBreakdown,
  ModelUsagePersonalOverview,
  ModelUsagePersonalRequestFilters,
  ModelUsagePersonalRequestLogPage,
  ModelUsagePolicy,
  UpdateModelUsagePolicyPayload,
} from './types';

function periodParams(period: string, groupBy?: ModelUsagePersonalGroupBy | ModelUsageFamilyGroupBy) {
  const params = new URLSearchParams({ period });
  if (groupBy) params.set('group_by', groupBy);
  return params.toString();
}

function requestLogParams(
  filters: object,
  allowedKeys: readonly string[],
): string {
  const params = new URLSearchParams({ limit: '20' });
  const values = filters as Record<string, string | number | undefined>;
  for (const key of allowedKeys) {
    const value = values[key];
    if (value !== '' && value !== undefined) params.set(key, String(value));
  }
  return params.toString();
}

export const modelUsageApi = {
  getMyModelUsageOverview: (period: string) =>
    request<ModelUsagePersonalOverview>(`/api/model-usage/me/overview?${periodParams(period)}`),
  getMyModelUsageBreakdown: (period: string, groupBy: ModelUsagePersonalGroupBy) =>
    request<ModelUsagePersonalBreakdown>(`/api/model-usage/me/breakdown?${periodParams(period, groupBy)}`),
  getFamilyModelUsageOverview: (period: string) =>
    request<ModelUsageFamilyOverview>(`/api/model-usage/family/overview?${periodParams(period)}`),
  getFamilyModelUsageBreakdown: (period: string, groupBy: ModelUsageFamilyGroupBy) =>
    request<ModelUsageFamilyBreakdown>(`/api/model-usage/family/breakdown?${periodParams(period, groupBy)}`),
  getMyModelUsageRequests: (filters: ModelUsagePersonalRequestFilters) =>
    request<ModelUsagePersonalRequestLogPage>(`/api/model-usage/me/requests?${requestLogParams(
      filters,
      ['date_from', 'date_to', 'capability', 'status', 'limit', 'offset'],
    )}`),
  getFamilyModelUsageRequests: (filters: ModelUsageFamilyRequestFilters) =>
    request<ModelUsageFamilyRequestLogPage>(`/api/model-usage/family/requests?${requestLogParams(
      filters,
      ['date_from', 'date_to', 'capability', 'provider', 'model', 'status', 'limit', 'offset'],
    )}`),
  getFamilyModelUsagePolicy: () => request<ModelUsagePolicy>('/api/model-usage/family/policy'),
  updateFamilyModelUsagePolicy: (payload: UpdateModelUsagePolicyPayload) =>
    request<ModelUsagePolicy>('/api/model-usage/family/policy', {
      method: 'PUT',
      body: JSON.stringify(payload),
    }),
  getModelUsageAlerts: () => request<ModelUsageAlert[]>('/api/model-usage/alerts'),
  markModelUsageAlertSeen: (alertId: string) =>
    request<ModelUsageAlertReceipt>(`/api/model-usage/alerts/${alertId}/seen`, { method: 'POST' }),
  dismissModelUsageAlert: (alertId: string) =>
    request<ModelUsageAlertReceipt>(`/api/model-usage/alerts/${alertId}/dismiss`, { method: 'POST' }),
};
