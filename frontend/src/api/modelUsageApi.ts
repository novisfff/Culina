import { request } from './request';
import type {
  ModelUsageAlert,
  ModelUsageAlertReceipt,
  ModelUsageFamilyBreakdown,
  ModelUsageFamilyOverview,
  ModelUsageGroupBy,
  ModelUsagePersonalBreakdown,
  ModelUsagePersonalOverview,
  ModelUsageRequestLogPage,
  ModelUsagePolicy,
  UpdateModelUsagePolicyPayload,
} from './types';

function periodParams(period: string, groupBy?: ModelUsageGroupBy) {
  const params = new URLSearchParams({ period });
  if (groupBy) params.set('group_by', groupBy);
  return params.toString();
}

export const modelUsageApi = {
  getMyModelUsageOverview: (period: string) =>
    request<ModelUsagePersonalOverview>(`/api/model-usage/me/overview?${periodParams(period)}`),
  getMyModelUsageBreakdown: (period: string, groupBy: ModelUsageGroupBy) =>
    request<ModelUsagePersonalBreakdown>(`/api/model-usage/me/breakdown?${periodParams(period, groupBy)}`),
  getFamilyModelUsageOverview: (period: string) =>
    request<ModelUsageFamilyOverview>(`/api/model-usage/family/overview?${periodParams(period)}`),
  getFamilyModelUsageBreakdown: (period: string, groupBy: ModelUsageGroupBy) =>
    request<ModelUsageFamilyBreakdown>(`/api/model-usage/family/breakdown?${periodParams(period, groupBy)}`),
  getMyModelUsageRequests: (filters: Record<string, string | number>) =>
    request<ModelUsageRequestLogPage>(`/api/model-usage/me/requests?${new URLSearchParams({ limit: '20', ...Object.fromEntries(Object.entries(filters).filter(([, value]) => value !== '' && value !== undefined).map(([key, value]) => [key, String(value)])) })}`),
  getFamilyModelUsageRequests: (filters: Record<string, string | number>) =>
    request<ModelUsageRequestLogPage>(`/api/model-usage/family/requests?${new URLSearchParams({ limit: '20', ...Object.fromEntries(Object.entries(filters).filter(([, value]) => value !== '' && value !== undefined).map(([key, value]) => [key, String(value)])) })}`),
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
